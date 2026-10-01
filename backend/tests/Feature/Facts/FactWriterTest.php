<?php

namespace Tests\Feature\Facts;

use App\Models\Fact;
use App\Services\Facts\FactNotPending;
use App\Services\Facts\FactWriter;
use App\Services\Owner;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Validation\ValidationException;
use Tests\TestCase;

/**
 * One live claim per key, and the history kept — the rule the whole store
 * rests on, held by the writer and, underneath it, by a partial index.
 */
class FactWriterTest extends TestCase
{
    use RefreshDatabase;

    private function writer(): FactWriter
    {
        return app(FactWriter::class);
    }

    public function test_a_fact_is_saved_active_and_owned(): void
    {
        $fact = $this->writer()->remember('Food ', ' Coffee', "  black,\n no sugar ");

        $this->assertSame(Fact::ACTIVE, $fact->status);
        $this->assertSame(Owner::id(), $fact->user_id);
        $this->assertSame(Fact::STATED, $fact->confidence);
        $this->assertSame('manual', $fact->source);
        $this->assertNotNull($fact->learned_at);

        // The subject is what the index compares, so it is normalised; the
        // claim is the owner's words, with only its whitespace collapsed so it
        // stays one line in the prompt.
        $this->assertSame('food', $fact->category);
        $this->assertSame('coffee', $fact->key);
        $this->assertSame('black, no sugar', $fact->value);
    }

    public function test_a_new_value_supersedes_the_old_one_and_keeps_it(): void
    {
        $old = $this->writer()->remember('food', 'coffee', 'with milk');
        $new = $this->writer()->remember('FOOD', 'coffee', 'black, no sugar');

        $this->assertSame(Fact::SUPERSEDED, $old->fresh()->status);
        $this->assertNotNull($old->fresh()->decided_at);
        $this->assertSame(Fact::ACTIVE, $new->status);
        $this->assertSame(1, Fact::active()->count());
        $this->assertSame(2, Fact::count());
    }

    public function test_restating_the_active_value_changes_nothing(): void
    {
        $first = $this->writer()->remember('food', 'coffee', 'Black');
        $again = $this->writer()->remember('food', 'coffee', 'black');

        // Superseding a fact with itself would bury its real date under today's.
        $this->assertTrue($first->is($again));
        $this->assertSame(1, Fact::count());
    }

    public function test_the_database_refuses_two_active_claims_for_one_key(): void
    {
        // The partial index, not just the writer: a caller that goes around
        // FactWriter still cannot leave the prompt with two answers for coffee.
        $this->writer()->remember('food', 'coffee', 'black');

        $this->expectException(QueryException::class);
        Fact::create([
            'category' => 'food', 'key' => 'coffee', 'value' => 'with milk',
            'confidence' => Fact::STATED, 'source' => 'manual',
            'status' => Fact::ACTIVE, 'learned_at' => now(),
        ]);
    }

    public function test_the_index_is_partial_so_history_and_proposals_coexist(): void
    {
        // A plain unique(user_id, category, key) would refuse all of these.
        foreach ([Fact::SUPERSEDED, Fact::SUPERSEDED, Fact::PROPOSED, Fact::REJECTED, Fact::ACTIVE] as $status) {
            Fact::create([
                'category' => 'food', 'key' => 'coffee', 'value' => $status,
                'confidence' => Fact::STATED, 'source' => 'manual',
                'status' => $status, 'learned_at' => now(),
            ]);
        }

        $this->assertSame(5, Fact::count());
    }

    // ── Proposals and decisions (15.1) ────────────────────────────────────────

    public function test_a_proposal_is_not_on_file_until_kept(): void
    {
        $proposal = $this->writer()->propose('food', 'pork', 'Does not eat it.');

        $this->assertSame(Fact::PROPOSED, $proposal->status);
        $this->assertSame(Fact::INFERRED, $proposal->confidence);
        $this->assertSame('extracted', $proposal->source);
        $this->assertNull($proposal->decided_at);
        $this->assertSame(0, Fact::active()->count());
    }

    public function test_a_proposal_repeating_what_is_on_file_or_waiting_is_dropped(): void
    {
        $this->writer()->remember('food', 'coffee', 'Black');
        $this->writer()->propose('food', 'pork', 'Does not eat it.');

        $this->assertNull($this->writer()->propose('food', 'coffee', 'black'));
        $this->assertNull($this->writer()->propose('Food', 'Pork', 'does not eat it.'));
        // A different value is news: a replacement, put up beside the old one.
        $this->assertNotNull($this->writer()->propose('food', 'coffee', 'With oat milk'));
        $this->assertSame(3, Fact::count());
    }

    public function test_keeping_a_proposal_supersedes_the_active_claim_and_keeps_its_date(): void
    {
        $old = $this->writer()->remember('food', 'coffee', 'Black');
        $this->travel(3)->days();
        $proposal = $this->writer()->propose('food', 'coffee', 'With oat milk');
        $learned = $proposal->learned_at->toIso8601String();
        $this->travel(1)->days();

        $kept = $this->writer()->keep($proposal);

        $this->assertTrue($kept->is($proposal));
        $this->assertSame(Fact::ACTIVE, $kept->status);
        $this->assertNotNull($kept->decided_at);
        $this->assertSame($learned, $kept->learned_at->toIso8601String());
        $this->assertSame(Fact::SUPERSEDED, $old->fresh()->status);
        $this->assertSame(1, Fact::active()->count());
    }

    public function test_keeping_a_proposal_that_is_already_the_active_value_spends_it(): void
    {
        $proposal = $this->writer()->propose('food', 'coffee', 'Black');
        $active = $this->writer()->remember('food', 'coffee', 'black');

        $this->assertTrue($this->writer()->keep($proposal)->is($active));
        $this->assertNull($proposal->fresh());
        $this->assertSame(1, Fact::count());
    }

    public function test_rejecting_leaves_a_tombstone(): void
    {
        $proposal = $this->writer()->propose('food', 'pork', 'Does not eat it.');

        $rejected = $this->writer()->reject($proposal);

        $this->assertSame(Fact::REJECTED, $rejected->status);
        $this->assertNotNull($rejected->decided_at);
        $this->assertSame(1, Fact::count());
        $this->assertSame(0, Fact::active()->count());
    }

    public function test_a_decided_proposal_cannot_be_decided_again(): void
    {
        $proposal = $this->writer()->propose('food', 'pork', 'Does not eat it.');
        $this->writer()->reject($proposal);

        // The stale copy still says `proposed` — another tab's view of it.
        foreach (['keep', 'reject'] as $decision) {
            try {
                $this->writer()->{$decision}($proposal);
                $this->fail("{$decision} went through twice");
            } catch (FactNotPending) {
                // expected
            }
        }

        $this->assertSame(Fact::REJECTED, $proposal->fresh()->status);
    }

    public function test_an_active_fact_cannot_be_kept_or_rejected(): void
    {
        $this->expectException(FactNotPending::class);
        $this->writer()->reject($this->writer()->remember('food', 'coffee', 'Black'));
    }

    public function test_forgetting_deletes_the_key_and_its_history_but_not_its_refusals(): void
    {
        $this->writer()->remember('food', 'coffee', 'With milk');
        $active = $this->writer()->remember('food', 'coffee', 'Black');
        $this->writer()->reject($this->writer()->propose('food', 'coffee', 'Decaf'));
        $this->writer()->remember('food', 'tea', 'Green');

        $this->assertSame(2, $this->writer()->forget($active));

        $this->assertSame(0, Fact::where('key', 'coffee')->whereIn('status', [Fact::ACTIVE, Fact::SUPERSEDED])->count());
        $this->assertSame(1, Fact::where('key', 'coffee')->where('status', Fact::REJECTED)->count());
        $this->assertSame(1, Fact::active()->count());
    }

    public function test_only_an_active_fact_can_be_forgotten(): void
    {
        $proposal = $this->writer()->propose('food', 'pork', 'Does not eat it.');

        $this->expectException(FactNotPending::class);
        $this->writer()->forget($proposal);
    }

    public function test_input_is_validated(): void
    {
        foreach ([
            ['', 'coffee', 'black', Fact::STATED, 'manual'],
            ['food', '  ', 'black', Fact::STATED, 'manual'],
            ['food', 'coffee', '', Fact::STATED, 'manual'],
            ['food', 'coffee', str_repeat('x', FactWriter::MAX_VALUE + 1), Fact::STATED, 'manual'],
            ['food', 'coffee', 'black', 'certain', 'manual'],
            ['food', 'coffee', 'black', Fact::STATED, 'rumour'],
        ] as $args) {
            try {
                $this->writer()->remember(...$args);
                $this->fail('Accepted '.json_encode($args));
            } catch (ValidationException) {
                // expected
            }
        }

        $this->assertSame(0, Fact::count());
    }
}
