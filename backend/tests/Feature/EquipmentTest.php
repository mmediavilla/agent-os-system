<?php

namespace Tests\Feature;

use App\Models\Equipment;
use App\Models\Exercise;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Facades\URL;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

class EquipmentTest extends TestCase
{
    use RefreshDatabase;

    // ── Helpers ───────────────────────────────────────────────────────────────

    private function makeEquipment(array $attrs = []): Equipment
    {
        return Equipment::create(array_merge([
            'name' => 'Barbell',
            'equipment_type' => 'Free Weight',
            'status' => 'active',
        ], $attrs));
    }

    private function makeExercise(array $attrs = []): Exercise
    {
        return Exercise::create(array_merge([
            'name' => 'Bench Press',
            'primary_muscle' => 'Chest',
            'equipment' => 'Barbell',
            'exercise_type' => 'weight_reps',
        ], $attrs));
    }

    private function validPayload(array $overrides = []): array
    {
        return array_merge([
            'name' => 'Adjustable Bench',
            'equipment_type' => 'Accessory',
            'status' => 'active',
        ], $overrides);
    }

    /**
     * Post a photo the way the app does. The Accept header matters: without it
     * Laravel answers a validation failure with a 302 back to the form instead
     * of the 422 an API client expects.
     */
    private function uploadImage(Equipment $equipment, UploadedFile $file): TestResponse
    {
        return $this->post(
            "/api/equipment/{$equipment->id}/image",
            ['image' => $file],
            ['Accept' => 'application/json'],
        );
    }

    // ── GET /api/equipment ────────────────────────────────────────────────────

    public function test_index_returns_equipment_ordered_by_type_then_name(): void
    {
        $this->makeEquipment(['name' => 'Treadmill',  'equipment_type' => 'Cardio']);
        $this->makeEquipment(['name' => 'Dumbbells',  'equipment_type' => 'Free Weight']);
        $this->makeEquipment(['name' => 'Barbell',    'equipment_type' => 'Free Weight']);

        $this->getJson('/api/equipment')
            ->assertOk()
            ->assertJsonCount(3, 'data')
            ->assertJsonPath('data.0.name', 'Treadmill')  // Cardio sorts first
            ->assertJsonPath('data.1.name', 'Barbell')    // then Free Weight, A-Z
            ->assertJsonPath('data.2.name', 'Dumbbells');
    }

    public function test_index_filters_by_search_term(): void
    {
        $this->makeEquipment(['name' => 'Kettlebell 24kg']);
        $this->makeEquipment(['name' => 'Treadmill']);

        $this->getJson('/api/equipment?search=kettle')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.name', 'Kettlebell 24kg');
    }

    public function test_search_treats_like_wildcards_as_literals(): void
    {
        $this->makeEquipment(['name' => 'Band 50% resistance']);
        $this->makeEquipment(['name' => 'Treadmill']);

        // Unescaped, "%" would be a wildcard and this search would return both
        // rows. The escaping in the controller is what keeps it a literal.
        $this->getJson('/api/equipment?search='.urlencode('50%'))
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.name', 'Band 50% resistance');
    }

    public function test_index_filters_by_status(): void
    {
        $this->makeEquipment(['name' => 'Barbell', 'status' => 'active']);
        $this->makeEquipment(['name' => 'Rower',   'status' => 'wishlist']);

        $this->getJson('/api/equipment?status=wishlist')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.name', 'Rower');
    }

    public function test_index_filters_by_type(): void
    {
        $this->makeEquipment(['name' => 'Barbell', 'equipment_type' => 'Free Weight']);
        $this->makeEquipment(['name' => 'Rower', 'equipment_type' => 'Cardio']);

        $this->getJson('/api/equipment?equipment_type=Cardio')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.name', 'Rower');
    }

    public function test_index_combines_type_and_status_filters(): void
    {
        $this->makeEquipment(['name' => 'Barbell', 'equipment_type' => 'Free Weight', 'status' => 'active']);
        $this->makeEquipment(['name' => 'Dumbbells', 'equipment_type' => 'Free Weight', 'status' => 'wishlist']);
        $this->makeEquipment(['name' => 'Rower', 'equipment_type' => 'Cardio', 'status' => 'wishlist']);

        $this->getJson('/api/equipment?equipment_type=Free+Weight&status=wishlist')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.name', 'Dumbbells');
    }

    public function test_index_ignores_a_blank_filter(): void
    {
        $this->makeEquipment(['name' => 'Barbell']);
        $this->makeEquipment(['name' => 'Rower', 'equipment_type' => 'Cardio']);

        // An unset picker sends nothing; the empty string must not be read as
        // asking for items with no type.
        $this->getJson('/api/equipment?equipment_type=')
            ->assertOk()
            ->assertJsonCount(2, 'data');
    }

    // ── GET /api/equipment — pagination ───────────────────────────────────────

    /** Creates $count items named "Kit 01", "Kit 02", … so page order is readable. */
    private function makeEquipmentRun(int $count): void
    {
        for ($i = 1; $i <= $count; $i++) {
            $this->makeEquipment(['name' => sprintf('Kit %02d', $i)]);
        }
    }

    public function test_index_returns_every_row_when_no_page_size_is_asked_for(): void
    {
        $this->makeEquipmentRun(7);

        // The exercise form fills its Equipment picker from this endpoint and
        // needs the whole catalog, so the default must stay unpaginated.
        $this->getJson('/api/equipment')
            ->assertOk()
            ->assertJsonCount(7, 'data')
            ->assertJsonPath('meta.total', 7)
            ->assertJsonPath('meta.per_page', null)
            ->assertJsonPath('meta.last_page', 1);
    }

    public function test_index_returns_the_requested_page(): void
    {
        $this->makeEquipmentRun(7);

        $this->getJson('/api/equipment?per_page=3&page=2')
            ->assertOk()
            ->assertJsonCount(3, 'data')
            ->assertJsonPath('data.0.name', 'Kit 04')
            ->assertJsonPath('meta.page', 2)
            ->assertJsonPath('meta.last_page', 3)
            ->assertJsonPath('meta.from', 4)
            ->assertJsonPath('meta.to', 6);
    }

    public function test_index_clamps_a_page_beyond_the_last_one(): void
    {
        $this->makeEquipmentRun(7);

        $this->getJson('/api/equipment?per_page=3&page=99')
            ->assertOk()
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('meta.page', 3);
    }

    public function test_index_counts_the_filtered_set_not_the_table(): void
    {
        $this->makeEquipment(['name' => 'Barbell', 'status' => 'active']);
        $this->makeEquipment(['name' => 'Bench', 'status' => 'active']);
        $this->makeEquipment(['name' => 'Rower', 'status' => 'wishlist']);

        $this->getJson('/api/equipment?status=active&per_page=1')
            ->assertOk()
            ->assertJsonPath('meta.total', 2)
            ->assertJsonPath('meta.last_page', 2);
    }

    public function test_index_exposes_a_null_image_url_when_there_is_no_photo(): void
    {
        $this->makeEquipment();

        $this->getJson('/api/equipment')
            ->assertOk()
            ->assertJsonPath('data.0.image_url', null)
            // The disk path is an internal detail and must not leak.
            ->assertJsonMissingPath('data.0.image_path');
    }

    // ── POST /api/equipment ───────────────────────────────────────────────────

    public function test_store_creates_equipment(): void
    {
        $this->postJson('/api/equipment', $this->validPayload(['notes' => 'Bought 2024']))
            ->assertCreated()
            ->assertJsonPath('name', 'Adjustable Bench')
            ->assertJsonPath('equipment_type', 'Accessory')
            ->assertJsonPath('status', 'active')
            ->assertJsonPath('notes', 'Bought 2024');

        $this->assertDatabaseHas('equipment', ['name' => 'Adjustable Bench']);
    }

    public function test_store_rejects_a_duplicate_name(): void
    {
        $this->makeEquipment(['name' => 'Barbell']);

        $this->postJson('/api/equipment', $this->validPayload(['name' => 'Barbell']))
            ->assertStatus(422)
            ->assertJsonValidationErrors('name');
    }

    public function test_store_requires_a_name_and_a_type(): void
    {
        $this->postJson('/api/equipment', ['status' => 'active'])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['name', 'equipment_type']);
    }

    public function test_store_rejects_an_unknown_status(): void
    {
        $this->postJson('/api/equipment', $this->validPayload(['status' => 'retired']))
            ->assertStatus(422)
            ->assertJsonValidationErrors('status');
    }

    public function test_store_keeps_the_chosen_thumbnail(): void
    {
        $this->postJson('/api/equipment', $this->validPayload(['thumbnail' => 'bench']))
            ->assertCreated()
            ->assertJsonPath('thumbnail', 'bench')
            // A thumbnail is a drawing, not a file: choosing one must not make
            // the item look like it has a photo.
            ->assertJsonPath('image_url', null);
    }

    public function test_store_defaults_the_thumbnail_to_nothing(): void
    {
        // Null is what makes the drawing follow the name and category, so an
        // item created without a choice must not be pinned to one.
        $this->postJson('/api/equipment', $this->validPayload())
            ->assertCreated()
            ->assertJsonPath('thumbnail', null);
    }

    public function test_store_rejects_a_thumbnail_with_no_drawing_behind_it(): void
    {
        // Closed set, unlike equipment_type: a key the app cannot draw would
        // render as an empty box the client could not tell from a failed load.
        $this->postJson('/api/equipment', $this->validPayload(['thumbnail' => 'hovercraft']))
            ->assertStatus(422)
            ->assertJsonValidationErrors('thumbnail');
    }

    // ── PUT /api/equipment/{id} ───────────────────────────────────────────────

    public function test_update_changes_fields(): void
    {
        $equipment = $this->makeEquipment();

        $this->putJson("/api/equipment/{$equipment->id}", $this->validPayload([
            'name' => 'Olympic Barbell',
            'equipment_type' => 'Free Weight',
            'status' => 'broken',
        ]))
            ->assertOk()
            ->assertJsonPath('name', 'Olympic Barbell')
            ->assertJsonPath('status', 'broken');

        $this->assertDatabaseHas('equipment', [
            'id' => $equipment->id,
            'name' => 'Olympic Barbell',
            'status' => 'broken',
        ]);
    }

    public function test_update_clears_the_thumbnail_when_sent_null(): void
    {
        $equipment = $this->makeEquipment(['thumbnail' => 'bench']);

        // Handing the pick back to the name has to be expressible, which is why
        // the rule is nullable rather than merely optional.
        $this->putJson("/api/equipment/{$equipment->id}", $this->validPayload([
            'name' => 'Barbell',
            'thumbnail' => null,
        ]))
            ->assertOk()
            ->assertJsonPath('thumbnail', null);

        $this->assertNull($equipment->fresh()->thumbnail);
    }

    public function test_update_leaves_the_photo_alone_when_the_thumbnail_changes(): void
    {
        Storage::fake();
        $equipment = $this->makeEquipment();
        $this->uploadImage($equipment, UploadedFile::fake()->image('rack.jpg'))->assertOk();
        $path = $equipment->fresh()->image_path;

        $this->putJson("/api/equipment/{$equipment->id}", $this->validPayload([
            'name' => 'Barbell',
            'thumbnail' => 'rack',
        ]))->assertOk();

        // The two are independent: the thumbnail is what shows once the photo
        // is gone, not a replacement for it.
        $this->assertSame($path, $equipment->fresh()->image_path);
        Storage::assertExists($path);
    }

    public function test_update_lets_an_item_keep_its_own_name(): void
    {
        $equipment = $this->makeEquipment(['name' => 'Barbell']);

        $this->putJson("/api/equipment/{$equipment->id}", $this->validPayload([
            'name' => 'Barbell',
            'status' => 'broken',
        ]))->assertOk();
    }

    public function test_renaming_equipment_repoints_the_exercises_that_reference_it(): void
    {
        $equipment = $this->makeEquipment(['name' => 'Barbell']);
        $matching = $this->makeExercise(['name' => 'Bench Press', 'equipment' => 'Barbell']);
        $other = $this->makeExercise(['name' => 'Curl', 'equipment' => 'Dumbbell']);

        $this->putJson("/api/equipment/{$equipment->id}", $this->validPayload([
            'name' => 'Olympic Barbell',
            'equipment_type' => 'Free Weight',
        ]))->assertOk();

        // Exercises reference equipment by name, so a rename has to propagate or
        // they silently drop out of the picker.
        $this->assertSame('Olympic Barbell', $matching->fresh()->equipment);
        $this->assertSame('Dumbbell', $other->fresh()->equipment);
    }

    // ── DELETE /api/equipment/{id} ────────────────────────────────────────────

    public function test_destroy_removes_the_row_and_leaves_exercises_alone(): void
    {
        $equipment = $this->makeEquipment(['name' => 'Barbell']);
        $exercise = $this->makeExercise(['equipment' => 'Barbell']);

        $this->deleteJson("/api/equipment/{$equipment->id}")->assertNoContent();

        $this->assertDatabaseMissing('equipment', ['id' => $equipment->id]);
        // Same contract as deleting an exercise: history is not rewritten.
        $this->assertSame('Barbell', $exercise->fresh()->equipment);
    }

    public function test_destroy_deletes_the_stored_photo(): void
    {
        Storage::fake();
        $equipment = $this->makeEquipment();

        $this->uploadImage($equipment, UploadedFile::fake()->image('barbell.jpg'))->assertOk();

        $path = $equipment->fresh()->image_path;
        Storage::assertExists($path);

        $this->deleteJson("/api/equipment/{$equipment->id}")->assertNoContent();

        Storage::assertMissing($path);
    }

    // ── Photos ────────────────────────────────────────────────────────────────

    public function test_upload_stores_the_photo_and_returns_a_usable_url(): void
    {
        Storage::fake();
        $equipment = $this->makeEquipment();

        $res = $this->uploadImage($equipment, UploadedFile::fake()->image('barbell.jpg'))->assertOk();

        $path = $equipment->fresh()->image_path;
        $this->assertNotNull($path);
        Storage::assertExists($path);

        $this->assertStringContainsString(
            "/api/equipment/{$equipment->id}/image",
            $res->json('image_url'),
        );
    }

    public function test_upload_replaces_the_previous_photo(): void
    {
        Storage::fake();
        $equipment = $this->makeEquipment();

        $this->uploadImage($equipment, UploadedFile::fake()->image('old.jpg'))->assertOk();
        $oldPath = $equipment->fresh()->image_path;

        $this->uploadImage($equipment, UploadedFile::fake()->image('new.jpg'))->assertOk();
        $newPath = $equipment->fresh()->image_path;

        $this->assertNotSame($oldPath, $newPath);
        Storage::assertMissing($oldPath);
        Storage::assertExists($newPath);
    }

    public function test_upload_rejects_a_non_image(): void
    {
        Storage::fake();
        $equipment = $this->makeEquipment();

        $this->uploadImage($equipment, UploadedFile::fake()->create('notes.pdf', 16, 'application/pdf'))
            ->assertStatus(422)
            ->assertJsonValidationErrors('image');
    }

    public function test_delete_image_clears_the_photo(): void
    {
        Storage::fake();
        $equipment = $this->makeEquipment();

        $this->uploadImage($equipment, UploadedFile::fake()->image('barbell.jpg'))->assertOk();
        $path = $equipment->fresh()->image_path;

        $this->deleteJson("/api/equipment/{$equipment->id}/image")
            ->assertOk()
            ->assertJsonPath('image_url', null);

        Storage::assertMissing($path);
        $this->assertNull($equipment->fresh()->image_path);
    }

    public function test_image_route_streams_the_photo(): void
    {
        Storage::fake();
        $equipment = $this->makeEquipment();

        $url = $this->uploadImage($equipment, UploadedFile::fake()->image('barbell.jpg'))
            ->assertOk()
            ->json('image_url');

        $this->get($url)->assertOk();
    }

    public function test_image_route_404s_when_there_is_no_photo(): void
    {
        Storage::fake();
        $equipment = $this->makeEquipment();

        $this->getJson(URL::signedRoute('equipment.image', ['equipment' => $equipment->id]))->assertNotFound();
    }
}
