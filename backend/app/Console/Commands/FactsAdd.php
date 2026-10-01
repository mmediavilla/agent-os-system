<?php

namespace App\Console\Commands;

use App\Models\Fact;
use App\Services\Facts\FactWriter;
use Illuminate\Console\Command;
use Illuminate\Validation\ValidationException;

/**
 * Put a fact on file by hand.
 *
 * Until the Facts screen exists (15.1) this is how the store is seeded for the
 * premise test: twenty-odd facts typed in, then `facts:probe` to see whether
 * the answers change. It goes through `FactWriter`, so a second value for a key
 * supersedes the first exactly as it will from the screen.
 */
class FactsAdd extends Command
{
    protected $signature = 'facts:add
        {category : What kind of thing, e.g. food, hobby, work}
        {key : What the fact is about, e.g. coffee}
        {value : The claim, one short sentence}
        {--inferred : A guess rather than something the owner said}';

    protected $description = 'Save a fact about the owner (active at once, source: manual)';

    public function handle(FactWriter $writer): int
    {
        $previous = Fact::active()
            ->where('category', mb_strtolower(trim($this->argument('category'))))
            ->where('key', mb_strtolower(trim($this->argument('key'))))
            ->first();

        try {
            $fact = $writer->remember(
                $this->argument('category'),
                $this->argument('key'),
                $this->argument('value'),
                $this->option('inferred') ? Fact::INFERRED : Fact::STATED,
            );
        } catch (ValidationException $e) {
            foreach ($e->errors() as $messages) {
                $this->error($messages[0]);
            }

            return self::FAILURE;
        }

        if ($previous?->is($fact)) {
            $this->line("Already on file: {$fact->category} / {$fact->key}: {$fact->value}");

            return self::SUCCESS;
        }

        $this->info("Saved: {$fact->category} / {$fact->key}: {$fact->value} ({$fact->confidence})");

        if ($previous) {
            $this->line("Replaces: {$previous->value}");
        }

        return self::SUCCESS;
    }
}
