<?php

namespace Tests\Unit\Agent;

use App\Agent\Support\ResultEncoder;
use PHPUnit\Framework\TestCase;

class ResultEncoderTest extends TestCase
{
    public function test_small_results_pass_through_unchanged(): void
    {
        $encoded = ResultEncoder::encode(['workouts' => [['id' => 1]], 'total_matching' => 1]);

        $this->assertSame('{"workouts":[{"id":1}],"total_matching":1}', $encoded);
        $this->assertArrayNotHasKey('truncated', json_decode($encoded, true));
    }

    public function test_multibyte_and_slashes_are_left_alone(): void
    {
        // "×" as one character rather than ×, and a date as 2026-09-04
        // rather than an escaped path — both are cheaper for the model to read.
        $this->assertSame('{"sets":"100kg×8 a/b"}', ResultEncoder::encode(['sets' => '100kg×8 a/b']));
    }

    public function test_oversized_lists_are_trimmed_and_say_so(): void
    {
        $rows = array_fill(0, 400, ['id' => 1, 'title' => str_repeat('x', 100)]);

        $decoded = json_decode(ResultEncoder::encode(['workouts' => $rows, 'total_matching' => 400]), true);

        $this->assertLessThan(400, count($decoded['workouts']));
        $this->assertSame('workouts', $decoded['truncated']['field']);
        $this->assertGreaterThan(0, $decoded['truncated']['omitted']);
        // The count the rows were drawn from survives, so the model can tell the
        // list is short rather than believing 400 sessions became 60.
        $this->assertSame(400, $decoded['total_matching']);
    }

    public function test_trimming_keeps_the_head_of_the_list(): void
    {
        $rows = [];
        foreach (range(0, 399) as $i) {
            $rows[] = ['id' => $i, 'pad' => str_repeat('x', 100)];
        }

        $decoded = json_decode(ResultEncoder::encode(['rows' => $rows]), true);

        $this->assertSame(0, $decoded['rows'][0]['id']);
        $this->assertSame(count($decoded['rows']) - 1, end($decoded['rows'])['id']);
    }

    public function test_the_result_is_under_the_cap_after_trimming(): void
    {
        $rows = array_fill(0, 400, ['title' => str_repeat('x', 200)]);

        $this->assertLessThanOrEqual(
            ResultEncoder::MAX_BYTES,
            strlen(ResultEncoder::encode(['rows' => $rows])),
        );
    }

    public function test_an_oversized_object_with_no_list_reports_an_error(): void
    {
        $decoded = json_decode(ResultEncoder::encode(['blob' => str_repeat('x', 30000)]), true);

        $this->assertArrayHasKey('error', $decoded);
        $this->assertStringContainsString('Narrow the request', $decoded['error']);
    }
}
