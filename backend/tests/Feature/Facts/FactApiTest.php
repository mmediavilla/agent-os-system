<?php

namespace Tests\Feature\Facts;

use App\Models\Fact;
use App\Services\Facts\FactWriter;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * The Facts overlay's four routes. The rules themselves are FactWriter's and
 * tested there; what is asserted here is the shape, the status codes, and that
 * a decision racing another tab is a 409 sentence rather than a second write.
 */
class FactApiTest extends TestCase
{
    use RefreshDatabase;

    private function writer(): FactWriter
    {
        return app(FactWriter::class);
    }

    public function test_the_list_is_active_facts_by_subject_and_proposals_newest_first(): void
    {
        $this->writer()->remember('work', 'employer', 'Acme');
        $coffee = $this->writer()->remember('food', 'coffee', 'Black');
        $this->writer()->remember('food', 'coffee', 'With milk');   // supersedes, stays out
        $this->writer()->reject($this->writer()->propose('food', 'pork', 'Eats it'));
        $first = $this->writer()->propose('hobby', 'basketball', 'Plays on weekends');
        $this->travel(1)->minute();
        $second = $this->writer()->propose('food', 'coffee', 'Decaf after noon');

        $response = $this->getJson('/api/facts')->assertOk();

        $this->assertSame(['food/coffee', 'work/employer'], collect($response->json('active'))
            ->map(fn ($f) => "{$f['category']}/{$f['key']}")->all());
        $this->assertSame('With milk', $response->json('active.0.value'));
        $this->assertNotSame($coffee->id, $response->json('active.0.id'));

        $this->assertSame([$second->id, $first->id], array_column($response->json('proposed'), 'id'));
        // A replacement names what it would replace; a new subject names nothing.
        $this->assertSame('With milk', $response->json('proposed.0.replaces'));
        $this->assertNull($response->json('proposed.1.replaces'));
        $this->assertSame('inferred', $response->json('proposed.1.confidence'));
    }

    public function test_an_empty_store_is_two_empty_lists(): void
    {
        $this->getJson('/api/facts')->assertOk()->assertExactJson(['active' => [], 'proposed' => []]);
    }

    public function test_telling_it_something_puts_it_on_file_as_stated_and_manual(): void
    {
        $this->postJson('/api/facts', ['category' => 'Food', 'key' => 'Pork', 'value' => "Doesn't eat it."])
            ->assertCreated()
            ->assertJson([
                'category' => 'food', 'key' => 'pork', 'value' => "Doesn't eat it.",
                'confidence' => 'stated', 'source' => 'manual', 'status' => 'active',
            ]);

        // Saying it again is not news.
        $this->postJson('/api/facts', ['category' => 'food', 'key' => 'pork', 'value' => "doesn't eat it."])
            ->assertOk();
        $this->assertSame(1, Fact::count());
    }

    public function test_a_bad_fact_is_a_422(): void
    {
        $this->postJson('/api/facts', ['category' => 'food', 'key' => 'coffee'])->assertUnprocessable();
        $this->postJson('/api/facts', ['category' => 'food', 'key' => 'coffee', 'value' => str_repeat('x', FactWriter::MAX_VALUE + 1)])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('value');

        $this->assertSame(0, Fact::count());
    }

    public function test_a_proposal_is_kept_or_rejected(): void
    {
        $keep = $this->writer()->propose('food', 'pork', 'Does not eat it.');
        $reject = $this->writer()->propose('food', 'tea', 'Green');

        $this->patchJson("/api/facts/{$keep->id}", ['decision' => 'keep'])
            ->assertOk()
            ->assertJson(['id' => $keep->id, 'status' => 'active']);
        $this->patchJson("/api/facts/{$reject->id}", ['decision' => 'reject'])
            ->assertOk()
            ->assertJson(['id' => $reject->id, 'status' => 'rejected']);

        $this->patchJson("/api/facts/{$reject->id}", ['decision' => 'forget'])->assertUnprocessable();
    }

    public function test_deciding_twice_is_a_409_sentence(): void
    {
        $proposal = $this->writer()->propose('food', 'pork', 'Does not eat it.');
        $this->patchJson("/api/facts/{$proposal->id}", ['decision' => 'keep'])->assertOk();

        $this->patchJson("/api/facts/{$proposal->id}", ['decision' => 'reject'])
            ->assertStatus(409)
            ->assertJson(['message' => 'That fact has already been decided.']);

        $this->assertSame(Fact::ACTIVE, $proposal->fresh()->status);
    }

    public function test_forgetting_is_a_hard_delete_of_the_key(): void
    {
        $this->writer()->remember('food', 'coffee', 'With milk');
        $active = $this->writer()->remember('food', 'coffee', 'Black');

        $this->deleteJson("/api/facts/{$active->id}")->assertOk()->assertExactJson(['forgotten' => 2]);
        $this->assertSame(0, Fact::count());

        $this->deleteJson("/api/facts/{$active->id}")->assertNotFound();
    }

    public function test_a_proposal_is_rejected_not_forgotten(): void
    {
        $proposal = $this->writer()->propose('food', 'pork', 'Does not eat it.');

        $this->deleteJson("/api/facts/{$proposal->id}")->assertStatus(409);
        $this->assertNotNull($proposal->fresh());
    }
}
