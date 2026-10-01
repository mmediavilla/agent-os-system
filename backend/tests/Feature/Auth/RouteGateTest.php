<?php

namespace Tests\Feature\Auth;

use App\Models\Equipment;
use App\Models\User;
use App\Services\Owner;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Route;
use Illuminate\Support\Facades\Route as Router;
use Illuminate\Support\Facades\URL;
use Illuminate\Support\Str;
use Tests\TestCase;

/**
 * The gate, and the short list of routes allowed around it.
 *
 * The first test is the one that matters most: it reads the route table and
 * fails on any `api/*` route that is neither behind `auth:sanctum` + `owner` nor
 * named here. A new route written outside the group cannot slip past — the same
 * argument that makes `MutatingTool` a marker rather than a list kept elsewhere.
 */
class RouteGateTest extends TestCase
{
    use RefreshDatabase;

    protected bool $actsAsOwner = false;

    /** Every route outside the gate, and what stands in for it. */
    public const PUBLIC = [
        'POST api/auth/google/start' => 'throttle:10,1',
        'POST api/auth/google/callback' => 'throttle:10,1',
        'GET api/health' => null,
        'POST api/mcp' => 'api.token',
        'GET api/equipment/{equipment}/image' => 'signed',
        'GET api/documents/{document}/file' => 'signed',
        'GET api/diagnostics/{report}/file' => 'signed',
        'GET api/agent/runs/{run}/stream' => 'signed:after',
        'GET api/agent/snapshots/{snapshot}' => 'signed',
    ];

    public function test_every_api_route_is_gated_or_on_the_public_list(): void
    {
        $seen = [];

        foreach (Router::getRoutes() as $route) {
            /** @var Route $route */
            if (! Str::startsWith($route->uri(), 'api/')) {
                continue;
            }

            foreach (array_diff($route->methods(), ['HEAD']) as $method) {
                $key = "{$method} {$route->uri()}";
                $middleware = $route->gatherMiddleware();

                if (array_key_exists($key, self::PUBLIC)) {
                    $seen[] = $key;
                    $this->assertNotContains('auth:sanctum', $middleware, "{$key} is on the public list but gated.");

                    if (self::PUBLIC[$key] !== null) {
                        $this->assertContains(self::PUBLIC[$key], $middleware, "{$key} lost ".self::PUBLIC[$key].'.');
                    }

                    continue;
                }

                $this->assertContains('auth:sanctum', $middleware, "{$key} is outside the gate. Put it in the group, or on RouteGateTest::PUBLIC with a reason.");
                $this->assertContains('owner', $middleware, "{$key} checks a token but not whose.");
            }
        }

        // A stale entry would let a route be deleted and a new one reuse its
        // name unexamined.
        $this->assertEqualsCanonicalizing(array_keys(self::PUBLIC), $seen);
    }

    public function test_an_anonymous_request_is_a_401_sentence(): void
    {
        $this->getJson('/api/workouts')->assertUnauthorized()->assertJsonPath('message', 'Sign in first.');

        // Not a redirect to a login route that does not exist, which is a 500.
        $this->get('/api/workouts')->assertUnauthorized();
    }

    public function test_the_gate_runs_before_the_model_is_looked_up(): void
    {
        $equipment = Equipment::create(['name' => 'Barbell', 'equipment_type' => 'Free Weight']);

        // The same answer whether or not the row exists: no existence oracle.
        $this->getJson("/api/equipment/{$equipment->id}")->assertUnauthorized();
        $this->getJson('/api/equipment/999999')->assertUnauthorized();
    }

    public function test_a_forged_picture_url_says_nothing_about_which_ids_exist(): void
    {
        $equipment = Equipment::create(['name' => 'Barbell', 'equipment_type' => 'Free Weight']);

        $this->get("/api/equipment/{$equipment->id}/image")->assertForbidden();
        $this->get('/api/equipment/999999/image')->assertForbidden();
    }

    public function test_a_bogus_token_is_refused(): void
    {
        $this->withToken('1|not-a-real-token')->getJson('/api/workouts')->assertUnauthorized();
    }

    public function test_the_owners_token_is_let_in(): void
    {
        $token = Owner::user()->createToken('test')->plainTextToken;

        $this->withToken($token)->getJson('/api/workouts')->assertOk();
    }

    public function test_an_expired_token_is_refused(): void
    {
        $token = Owner::user()->createToken('test')->plainTextToken;

        $this->travel((int) config('sanctum.expiration') + 1)->minutes();

        $this->withToken($token)->getJson('/api/workouts')->assertUnauthorized();
    }

    public function test_a_token_belonging_to_anyone_else_is_refused(): void
    {
        Owner::user();
        $other = User::create(['name' => 'Other', 'email' => 'other@example.com', 'password' => Str::random(40)]);

        $this->withToken($other->createToken('test')->plainTextToken)
            ->getJson('/api/workouts')
            ->assertForbidden();
    }

    public function test_health_stays_public(): void
    {
        $this->getJson('/api/health')->assertOk();
    }

    public function test_mcp_keeps_its_own_token_and_ignores_the_owners(): void
    {
        config(['agent.token' => str_repeat('a', 64)]);

        $body = ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'ping'];

        $this->withToken(str_repeat('a', 64))->postJson('/api/mcp', $body)->assertOk();

        $this->app['auth']->forgetGuards();
        $owner = Owner::user()->createToken('test')->plainTextToken;
        $this->withToken($owner)->postJson('/api/mcp', $body)->assertUnauthorized();
    }

    public function test_a_signed_picture_url_expires(): void
    {
        $equipment = Equipment::create(['name' => 'Barbell', 'equipment_type' => 'Free Weight']);
        $url = URL::temporarySignedRoute('equipment.image', now()->addMinute(), ['equipment' => $equipment->id]);

        // Valid signature, no photo: past the gate and into the controller.
        $this->get($url)->assertNotFound();

        $this->travel(2)->minutes();
        $this->get($url)->assertForbidden();
    }

    public function test_a_tampered_signed_url_is_refused(): void
    {
        $url = URL::signedRoute('equipment.image', ['equipment' => 1, 'v' => 1]);

        $this->get(str_replace('v=1', 'v=2', $url))->assertForbidden();
    }
}
