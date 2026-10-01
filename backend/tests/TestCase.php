<?php

namespace Tests;

use App\Http\Middleware\EnsureOwner;
use App\Models\Workout;
use App\Services\Calendar\FeedAddress;
use App\Services\Owner;
use Illuminate\Auth\Middleware\Authenticate;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Foundation\Testing\TestCase as BaseTestCase;
use Laravel\Sanctum\Sanctum;

abstract class TestCase extends BaseTestCase
{
    /**
     * Whether every request is made as the signed-in owner.
     *
     * On by default, so the suites written before the gate test what they always
     * tested rather than a 401. The sign-in and gate tests turn it off and send
     * real tokens.
     */
    protected bool $actsAsOwner = true;

    /**
     * `Owner::id()` memoises, which is right in a request and wrong here: one PHP
     * process runs the whole suite while `RefreshDatabase` rebuilds the database
     * underneath it, so an id cached against a previous database would be a stale
     * answer — or a foreign key pointing at a `users` row that no longer exists.
     */
    protected function setUp(): void
    {
        parent::setUp();

        Owner::forget();

        $this->fakeDns();

        if (! $this->actsAsOwner) {
            return;
        }

        // A suite with no database has no owner row to sign in as, so the gate
        // is lifted instead. What the gate itself does is RouteGateTest's job.
        if (in_array(RefreshDatabase::class, class_uses_recursive($this), true)) {
            Sanctum::actingAs(Owner::user());
        } else {
            $this->withoutMiddleware([Authenticate::class, EnsureOwner::class]);
        }
    }

    /**
     * Answer the calendar's host lookups from a table rather than the network.
     *
     * On for every test, because `FeedAddress` resolves a host before each
     * fetch, and a suite that did real DNS would pass or fail on whether CI's
     * resolver was having a good day. Every host not named is a public address.
     *
     * @param  array<string, list<string>>  $hosts
     */
    protected function fakeDns(array $hosts = []): void
    {
        $this->app->instance(FeedAddress::class, new FeedAddress(
            fn (string $host) => $hosts[$host] ?? ['93.184.215.14'],
        ));
    }

    protected function makeWorkout(array $attrs = []): Workout
    {
        return Workout::create(array_merge([
            'title' => 'Test Session',
            'started_at' => now()->toDateTimeString(),
        ], $attrs));
    }
}
