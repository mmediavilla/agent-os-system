<?php

namespace Tests\Feature\Auth;

use App\Models\AgentRun;
use App\Models\Conversation;
use App\Models\PersonalAccessToken;
use App\Models\SignIn;
use App\Services\Auth\DeviceLabel;
use App\Services\Owner;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class SessionsTest extends TestCase
{
    use RefreshDatabase;

    protected bool $actsAsOwner = false;

    public function test_sessions_lists_every_browser_and_marks_this_one(): void
    {
        $mine = $this->token('Chrome on Windows');
        $this->token('Safari on iPhone');

        $sessions = $this->as($mine)->getJson('/api/auth/sessions')->assertOk()->json('data');

        $this->assertCount(2, $sessions);
        $current = collect($sessions)->firstWhere('current', true);
        $this->assertSame('Chrome on Windows', $current['name']);
        $this->assertNotNull($current['expires_at']);
        $this->assertArrayNotHasKey('token', $current);
    }

    public function test_revoking_another_browser_signs_it_out(): void
    {
        $mine = $this->token('mine');
        $theirs = $this->token('theirs');
        $theirsId = (int) explode('|', $theirs)[0];

        $this->as($mine)->deleteJson("/api/auth/sessions/{$theirsId}")->assertOk();

        $this->as($theirs)->getJson('/api/auth/me')->assertUnauthorized();
        $this->as($mine)->getJson('/api/auth/me')->assertOk();
    }

    public function test_an_unknown_session_is_a_404(): void
    {
        $this->as($this->token('mine'))->deleteJson('/api/auth/sessions/999')->assertNotFound();
    }

    public function test_signing_out_everywhere_else_keeps_this_browser(): void
    {
        $mine = $this->token('mine');
        $this->token('a');
        $this->token('b');

        $this->as($mine)->deleteJson('/api/auth/sessions?others=1')
            ->assertOk()
            ->assertJsonPath('revoked', 2);

        $this->assertSame(1, PersonalAccessToken::count());
        $this->as($mine)->getJson('/api/auth/me')->assertOk();
    }

    public function test_the_bulk_revoke_must_be_asked_for_by_name(): void
    {
        $mine = $this->token('mine');
        $this->token('a');

        $this->as($mine)->deleteJson('/api/auth/sessions')->assertUnprocessable();

        $this->assertSame(2, PersonalAccessToken::count());
    }

    public function test_logout_ends_this_session_only(): void
    {
        $mine = $this->token('mine');
        $other = $this->token('other');

        $this->as($mine)->postJson('/api/auth/logout')->assertOk();

        $this->as($mine)->getJson('/api/auth/me')->assertUnauthorized();
        $this->as($other)->getJson('/api/auth/me')->assertOk();
    }

    public function test_last_used_at_is_written_at_most_once_a_minute(): void
    {
        $mine = $this->token('mine');
        $row = PersonalAccessToken::sole();

        $this->as($mine)->getJson('/api/auth/me')->assertOk();
        $first = $row->fresh()->last_used_at;
        $this->assertNotNull($first);
        $this->assertSame('127.0.0.1', $row->fresh()->ip_address);

        $this->travel(30)->seconds();
        $this->as($mine)->getJson('/api/auth/me')->assertOk();
        $this->assertTrue($first->equalTo($row->fresh()->last_used_at), 'A poll inside the minute wrote again.');

        $this->travel(31)->seconds();
        $this->as($mine)->getJson('/api/auth/me')->assertOk();
        $this->assertTrue($row->fresh()->last_used_at->gt($first));
    }

    public function test_other_changes_to_a_token_are_never_throttled(): void
    {
        $this->token('mine');
        $row = PersonalAccessToken::sole();
        $row->forceFill(['last_used_at' => now()])->save();

        $row->forceFill(['name' => 'renamed'])->save();

        $this->assertSame('renamed', $row->fresh()->name);
    }

    public function test_sign_in_history_lists_the_latest_attempts_refusals_included(): void
    {
        foreach (range(1, 25) as $i) {
            SignIn::create(['outcome' => $i % 5 === 0 ? SignIn::REFUSED : SignIn::OK, 'email' => "e{$i}@example.com"]);
        }

        $rows = $this->as($this->token('mine'))->getJson('/api/auth/sign-ins')->assertOk()->json('data');

        $this->assertCount(20, $rows);
        $this->assertSame('e25@example.com', $rows[0]['email']);
        $this->assertSame(SignIn::REFUSED, $rows[0]['outcome']);
    }

    public function test_me_says_whether_an_mcp_token_is_set_but_never_what_it_is(): void
    {
        config(['agent.token' => 'the-mcp-secret']);

        $response = $this->as($this->token('mine'))->getJson('/api/auth/me')
            ->assertOk()
            ->assertJsonPath('mcp_token_configured', true)
            ->assertJsonPath('timezone', config('agent.timezone'));

        $this->assertStringNotContainsString('the-mcp-secret', $response->getContent());
        $this->assertArrayNotHasKey('google_sub', $response->json());
    }

    public function test_a_run_carries_a_signed_stream_url_that_works(): void
    {
        $conversation = Conversation::create([]);
        $run = AgentRun::create(['conversation_id' => $conversation->id, 'status' => 'completed', 'trigger' => 'message']);

        $url = $this->as($this->token('mine'))->getJson("/api/agent/runs/{$run->id}")
            ->assertOk()
            ->json('run.stream_url');

        $this->assertStringContainsString("/api/agent/runs/{$run->id}/stream?expires=", $url);

        // No header: this is what EventSource sends. `after` may be appended.
        $this->app['auth']->forgetGuards();
        $this->withoutToken()->get($url)->assertOk();
        $this->withoutToken()->get($url.'&after=3')->assertOk();
        $this->withoutToken()->get("/api/agent/runs/{$run->id}/stream")->assertForbidden();
    }

    public function test_the_cli_mints_a_token_for_the_owner(): void
    {
        $this->artisan('auth:token', ['name' => 'smoke'])->assertSuccessful();

        $token = PersonalAccessToken::sole();
        $this->assertSame('smoke', $token->name);
        $this->assertSame(Owner::id(), (int) $token->tokenable_id);
    }

    public function test_device_labels(): void
    {
        $this->assertSame('Edge on Windows', DeviceLabel::from('Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36 Edg/140.0'));
        $this->assertSame('Safari on iPhone', DeviceLabel::from('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1'));
        $this->assertSame('Firefox on macOS', DeviceLabel::from('Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:130.0) Gecko/20100101 Firefox/130.0'));
        $this->assertSame('Unknown device', DeviceLabel::from(null));
    }

    private function token(string $name): string
    {
        return Owner::user()->createToken($name)->plainTextToken;
    }

    /**
     * Send the next request on this token. The guard remembers the user it
     * resolved for the life of the application, which in a test is every
     * request, so it is told to forget first.
     */
    private function as(string $token): static
    {
        $this->app['auth']->forgetGuards();

        return $this->withToken($token);
    }
}
