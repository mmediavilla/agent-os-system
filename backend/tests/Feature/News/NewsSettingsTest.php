<?php

namespace Tests\Feature\News;

use App\Models\Setting;
use App\Services\NewsSettings;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * The owner's news interests (19.1): a row the worker can read, cleaned on the
 * way in and again on the way out, refused rather than cut when too long.
 */
class NewsSettingsTest extends TestCase
{
    use RefreshDatabase;

    public function test_nothing_saved_is_an_empty_list(): void
    {
        $this->getJson('/api/settings/news')
            ->assertOk()
            ->assertExactJson(['interests' => [], 'max' => 10, 'max_chars' => NewsSettings::MAX_CHARS]);
    }

    public function test_a_list_is_saved_trimmed_without_blanks_or_repeats(): void
    {
        $this->patchJson('/api/settings/news', ['interests' => ['  Formula 1 ', '', 'formula 1', 'Home   espresso']])
            ->assertOk()
            ->assertJsonPath('interests', ['Formula 1', 'Home espresso']);

        $this->assertSame(['Formula 1', 'Home espresso'], NewsSettings::interests());
    }

    public function test_an_empty_list_is_an_answer(): void
    {
        NewsSettings::setInterests(['Formula 1']);

        $this->patchJson('/api/settings/news', ['interests' => []])->assertOk()->assertJsonPath('interests', []);
    }

    public function test_bad_input_is_a_422_and_writes_nothing(): void
    {
        NewsSettings::setInterests(['Formula 1']);

        $cases = [
            'interests' => [[], ['interests' => 'Formula 1'], ['interests' => array_map(fn ($i) => "Topic {$i}", range(1, 11))]],
            'interests.0' => [['interests' => [str_repeat('x', NewsSettings::MAX_CHARS + 1)]], ['interests' => [42]]],
        ];

        foreach ($cases as $field => $bodies) {
            foreach ($bodies as $body) {
                $this->patchJson('/api/settings/news', $body)->assertUnprocessable()->assertJsonValidationErrors($field);
            }
        }

        $this->assertSame(['Formula 1'], NewsSettings::interests());
    }

    public function test_a_hand_edited_row_costs_its_bad_entries_not_a_turn(): void
    {
        Setting::put(NewsSettings::INTERESTS, ['Formula 1', 7, str_repeat('x', 200), null, 'Espresso']);

        $this->assertSame(['Formula 1', 'Espresso'], NewsSettings::interests());

        Setting::put(NewsSettings::INTERESTS, 'not a list');
        $this->assertSame([], NewsSettings::interests());
    }
}
