<?php

namespace App\Console\Commands;

use App\Services\Owner;
use Illuminate\Console\Command;

/**
 * A bearer token for the owner, minted without a browser.
 *
 * Every route but sign-in, `/api/health` and `/api/mcp` is behind the gate now,
 * so the smoke tests in CLAUDE.md need a token to send. It is an ordinary
 * session: it shows up in Profile beside the browsers, expires with them, and
 * is revoked the same way.
 */
class IssueAuthToken extends Command
{
    protected $signature = 'auth:token {name=CLI : What Profile lists the session as}';

    protected $description = 'Issue a bearer token for the owner (for smoke tests and scripts)';

    public function handle(): int
    {
        $token = Owner::user()->createToken((string) $this->argument('name'));

        $this->line($token->plainTextToken);

        return self::SUCCESS;
    }
}
