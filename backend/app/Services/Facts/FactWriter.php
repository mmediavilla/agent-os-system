<?php

namespace App\Services\Facts;

use App\Models\Fact;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Validator;

/**
 * The one place a fact is written, as `WorkoutWriter` is for workouts.
 *
 * The command, the Facts screen, the `save_facts` tool and (15.2) the
 * extraction job all come through here, because the rule that matters — one
 * active claim per key, the old one kept as `superseded` — is two writes that
 * must land together. A caller that did its own insert would either trip the
 * partial unique index or, worse, go around it by writing the row as something
 * other than active.
 *
 * **Category and key are lower-cased and trimmed.** They are what the index
 * compares, and "Food / Coffee" and "food / coffee" are one subject; the value
 * is the owner's words and is left as written.
 */
class FactWriter
{
    public const MAX_VALUE = 300;

    /**
     * Save a claim as the live answer for its key.
     *
     * Re-saving the value already active is a no-op that returns the existing
     * row — a restated preference is not news, and superseding a fact with
     * itself would bury its real date under a fresh one.
     *
     * @param  'stated'|'inferred'  $confidence
     * @param  'chat'|'voice'|'manual'|'extracted'  $source
     */
    public function remember(
        string $category,
        string $key,
        string $value,
        string $confidence = Fact::STATED,
        string $source = 'manual',
        ?int $conversationId = null,
    ): Fact {
        $data = $this->validate(compact('category', 'key', 'value', 'confidence', 'source'));

        return DB::transaction(function () use ($data, $conversationId) {
            $current = Fact::active()
                ->where('category', $data['category'])
                ->where('key', $data['key'])
                ->first();

            if ($current && mb_strtolower($current->value) === mb_strtolower($data['value'])) {
                return $current;
            }

            $current?->update(['status' => Fact::SUPERSEDED, 'decided_at' => now()]);

            return Fact::create($data + [
                'status' => Fact::ACTIVE,
                'conversation_id' => $conversationId,
                'learned_at' => now(),
                'decided_at' => now(),
            ]);
        });
    }

    /**
     * Put a claim up for review rather than on file. It reaches the prompt only
     * once {@see self::keep()} says so.
     *
     * A proposal that repeats the active value, or one already waiting, is
     * dropped: null rather than a row is how a caller learns there was nothing
     * new to ask about.
     *
     * @param  'stated'|'inferred'  $confidence
     * @param  'chat'|'voice'|'manual'|'extracted'  $source
     */
    public function propose(
        string $category,
        string $key,
        string $value,
        string $confidence = Fact::INFERRED,
        string $source = 'extracted',
        ?int $conversationId = null,
    ): ?Fact {
        $data = $this->validate(compact('category', 'key', 'value', 'confidence', 'source'));

        return DB::transaction(function () use ($data, $conversationId) {
            $repeated = Fact::query()
                ->whereIn('status', [Fact::ACTIVE, Fact::PROPOSED])
                ->where('category', $data['category'])
                ->where('key', $data['key'])
                ->pluck('value')
                ->contains(fn (string $value) => mb_strtolower($value) === mb_strtolower($data['value']));

            if ($repeated) {
                return null;
            }

            return Fact::create($data + [
                'status' => Fact::PROPOSED,
                'conversation_id' => $conversationId,
                'learned_at' => now(),
            ]);
        });
    }

    /**
     * A proposal becomes the live claim for its key, superseding whatever was
     * there — the same two writes as {@see self::remember()}, in one
     * transaction. It keeps its `learned_at`: the date in the prompt is when it
     * came up, not when it was reviewed.
     *
     * Keeping a proposal whose value has since become the active one is not an
     * error: the proposal is spent, and the active row is returned.
     *
     * @throws FactNotPending when it was already decided — in another tab, say
     */
    public function keep(Fact $proposal): Fact
    {
        return DB::transaction(function () use ($proposal) {
            // Re-read inside the transaction. Transactions begin IMMEDIATE, so
            // this read holds the write lock and two tabs cannot both keep it.
            $proposal = $this->pending($proposal);

            $current = Fact::active()
                ->where('category', $proposal->category)
                ->where('key', $proposal->key)
                ->first();

            if ($current && mb_strtolower($current->value) === mb_strtolower($proposal->value)) {
                $proposal->delete();

                return $current;
            }

            $current?->update(['status' => Fact::SUPERSEDED, 'decided_at' => now()]);
            $proposal->update(['status' => Fact::ACTIVE, 'decided_at' => now()]);

            return $proposal;
        });
    }

    /**
     * Refuse a proposal. The row stays, as a tombstone, so the extractor can be
     * told not to propose it again.
     *
     * @throws FactNotPending
     */
    public function reject(Fact $proposal): Fact
    {
        return DB::transaction(function () use ($proposal) {
            $proposal = $this->pending($proposal);
            $proposal->update(['status' => Fact::REJECTED, 'decided_at' => now()]);

            return $proposal;
        });
    }

    /**
     * Forget an active fact, and the superseded history of its key with it.
     *
     * **A hard delete, unlike a rejection.** The owner asked for it gone; a
     * tombstone would be the app keeping it anyway. Rejected proposals for the
     * key stay — they are refusals, which is what stops the extractor putting
     * one straight back.
     *
     * @return int how many rows went
     *
     * @throws FactNotPending when the fact is not active
     */
    public function forget(Fact $fact): int
    {
        return DB::transaction(function () use ($fact) {
            $fresh = Fact::query()->whereKey($fact->getKey())->first();

            if ($fresh?->status !== Fact::ACTIVE) {
                throw new FactNotPending('That fact is no longer on file.');
            }

            return Fact::query()
                ->whereIn('status', [Fact::ACTIVE, Fact::SUPERSEDED])
                ->where('category', $fresh->category)
                ->where('key', $fresh->key)
                ->delete();
        });
    }

    /** The proposal as it stands now, or a refusal if it has been decided. */
    private function pending(Fact $proposal): Fact
    {
        $fresh = Fact::query()->whereKey($proposal->getKey())->first();

        if ($fresh?->status !== Fact::PROPOSED) {
            throw new FactNotPending('That fact has already been decided.');
        }

        return $fresh;
    }

    /**
     * @param  array<string, string>  $data
     * @return array<string, string>
     */
    private function validate(array $data): array
    {
        $data['category'] = mb_strtolower(trim($data['category']));
        $data['key'] = mb_strtolower(trim($data['key']));
        // One line each in the prompt, so a pasted paragraph break cannot
        // start what reads as a second fact.
        $data['value'] = trim((string) preg_replace('/\s+/u', ' ', $data['value']));

        return Validator::make($data, [
            'category' => ['required', 'string', 'max:60'],
            'key' => ['required', 'string', 'max:120'],
            'value' => ['required', 'string', 'max:'.self::MAX_VALUE],
            'confidence' => ['required', 'in:'.implode(',', Fact::CONFIDENCES)],
            'source' => ['required', 'in:'.implode(',', Fact::SOURCES)],
        ])->validate();
    }
}
