<?php

namespace App\Providers;

use App\Agent\AgentRunner;
use App\Agent\Mcp\McpServer;
use App\Agent\Support\Instructions;
use App\Agent\ToolRegistry;
use App\Agent\Tools\CreateExercise;
use App\Agent\Tools\GetFitnessStats;
use App\Agent\Tools\GetNews;
use App\Agent\Tools\GetWeather;
use App\Agent\Tools\GetWorkout;
use App\Agent\Tools\ListDeadlines;
use App\Agent\Tools\ListEquipment;
use App\Agent\Tools\ListEvents;
use App\Agent\Tools\ListPinnedArticles;
use App\Agent\Tools\ListWorkouts;
use App\Agent\Tools\LogWorkout;
use App\Agent\Tools\OpenOnThisMachine;
use App\Agent\Tools\PinArticles;
use App\Agent\Tools\SaveFacts;
use App\Agent\Tools\SaveInsight;
use App\Agent\Tools\SearchDocuments;
use App\Agent\Tools\SearchExercises;
use App\Agent\Tools\ShowGoogleCalendar;
use App\Agent\Tools\UpdateWorkout;
use App\Http\Controllers\VoiceTurnController;
use App\Services\Agents\AgentScope;
use App\Services\AssistantInstructions;
use App\Services\ClaudeService;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

/**
 * Wires the assistant's tool layer.
 *
 * Separate from AppServiceProvider so the whole agent surface can be read, and
 * later disabled, in one place.
 */
class AgentServiceProvider extends ServiceProvider
{
    /**
     * The tools every installation has, in the order they are advertised to the
     * model.
     *
     * **Append-only.** These definitions sit at the front of every request and
     * are the bulk of what the prompt cache holds, so reordering them changes
     * the cached prefix and re-charges full input price on every turn of every
     * conversation. Reads before writes is the current order; a new tool goes at
     * the end regardless of which group it belongs to.
     *
     * `create_event` stood last until the calendar became Google's. Removing it
     * changed the cached prefix once, for every conversation — the price of not
     * advertising a write into a table that no longer shows anybody anything.
     *
     * `get_weather` is last because it is newest. Being a read, it is in the
     * voice registry too, with no wiring of its own.
     *
     * `save_facts` (15.1) follows it, a write after a read, by the same rule.
     *
     * `search_documents` (16.0) goes after that — a read after a write, which
     * is the append-only rule doing exactly what it is for. Being a read, it
     * joins the voice registry with no wiring of its own.
     *
     * `list_deadlines` (16.2) follows it, for the same two reasons.
     *
     * `get_news` (19.1) after that: newest, and a read, so voice has it too.
     *
     * `pin_articles` and `list_pinned_articles` (19.2) follow it, write before
     * read: the order they arrived in, not the order they read best in.
     */
    private const TOOLS = [
        GetFitnessStats::class,
        ListWorkouts::class,
        GetWorkout::class,
        SearchExercises::class,
        ListEquipment::class,
        LogWorkout::class,
        UpdateWorkout::class,
        CreateExercise::class,
        SaveInsight::class,
        ListEvents::class,
        GetWeather::class,
        SaveFacts::class,
        SearchDocuments::class,
        ListDeadlines::class,
        GetNews::class,
        PinArticles::class,
        ListPinnedArticles::class,
    ];

    public function register(): void
    {
        // Singleton because the registry is built once from a static list and
        // then read repeatedly — once per turn for the schemas, once per call to
        // dispatch. Tools themselves are resolved through the container, so they
        // get their service dependencies injected.
        $this->app->singleton(ToolRegistry::class, function ($app) {
            return new ToolRegistry(array_map(fn (string $tool) => $app->make($tool), $this->tools()));
        });

        // The spoken assistant is the same assistant with a smaller surface: the
        // same loop, the same conversation and the same audit log, over the
        // reads alone. It is wired here rather than built in the controller so
        // that "voice cannot write" is a fact about the wiring — the controller
        // has no registry to choose from and could not offer a write tool if it
        // tried.
        //
        // Contextual and one level deep, deliberately: `when()->needs()` binds
        // the *immediate* dependency, so this replaces the runner itself rather
        // than trying to reach past it into the registry the default runner
        // would resolve.
        //
        // The agents (17.1) cut it further, and last — after the voice-only
        // opener is appended, so switching the Secretary off takes
        // `show_google_calendar` with `list_events`. Resolved per request, so a
        // toggle lands on the next spoken question.
        $this->app->when(VoiceTurnController::class)
            ->needs(AgentRunner::class)
            ->give(function ($app) {
                $scope = AgentScope::load();

                return new AgentRunner(
                    $app->make(ClaudeService::class),
                    $scope->registry(self::voiceTools($app)),
                    AssistantInstructions::get(AssistantInstructions::SPOKEN),
                    $scope->instructions(),
                );
            });

        // MCP gets the scoped set too: a switched-off agent that Claude Code
        // could still drive would make the switch a lie. Contextual rather than
        // a rebinding of the singleton, which `AutomationRunner` needs whole.
        // `listChanged: false` stays honest — a host is handed a new server per
        // request, so a toggle lands on its next `tools/list`, never mid-call.
        // A host is sent `Instructions::TOOLS` alone, so it gets no off-sentence;
        // a withheld tool it calls anyway answers "Unknown tool".
        $this->app->when(McpServer::class)
            ->needs(ToolRegistry::class)
            ->give(fn ($app) => AgentScope::load()->registry($app->make(ToolRegistry::class)));
    }

    /**
     * The reads, plus the one thing only a spoken turn may do.
     *
     * `show_google_calendar` opens a browser tab without an approval card, and this
     * is the only place it is registered: not in {@see self::TOOLS}, so the
     * typed loop and `tools/list` over MCP never see it. That is a fact about
     * where each caller runs rather than a preference about voice — a spoken
     * turn is answered inside Herd's request, on the interactive desktop, while
     * a typed one runs on the S4U queue worker, which has no desktop to open a
     * browser on. See the tool for the rest.
     *
     * Appended after the reads, so the voice prefix is the read-only one up to
     * the point where the two genuinely differ — the rule
     * `open_on_this_machine` follows in the main list.
     *
     * Public so `agents:probe` prints this registry rather than a copy of how
     * it is built. Unscoped: the agents are applied by the caller.
     */
    public static function voiceTools(Application $app): ToolRegistry
    {
        $registry = $app->make(ToolRegistry::class)->readOnly();

        if (ShowGoogleCalendar::available()) {
            $registry->register($app->make(ShowGoogleCalendar::class));
        }

        return $registry;
    }

    /**
     * The fixed list, plus whatever this installation has opted into.
     *
     * `open_on_this_machine` is the one conditional tool, and what it is
     * conditional on is having anywhere to go: with no allowed targets its
     * `enum` would be empty, so it would sit in every request's prompt while
     * being impossible to call correctly. Leaving it out is also the honest
     * thing — nothing should advertise a reach into a machine that has not
     * granted one, and `tools/list` over MCP is the same list.
     *
     * That it goes last is the append-only rule rather than a special case, but
     * it has a second benefit here: the cached prefix is byte-identical between
     * an installation that has configured targets and one that has not, right
     * up to the point where they genuinely differ.
     *
     * @return list<class-string>
     */
    private function tools(): array
    {
        return OpenOnThisMachine::targets() === []
            ? self::TOOLS
            : [...self::TOOLS, OpenOnThisMachine::class];
    }

    public function boot(): void
    {
        // The ceiling on the agent surface. A tool-calling endpoint is not a
        // normal read: every call a client makes is one the model paid to decide
        // on, so a client stuck retrying spends money rather than just CPU. The
        // limit is well above what a person driving a conversation reaches and
        // well below what a loop does in a second.
        //
        // Keyed by IP because there is no user to key by — the token gate
        // authenticates a machine, not a person, deliberately.
        RateLimiter::for('agent', fn (Request $request) => Limit::perMinute(config('agent.rate_limit'))->by($request->ip()));

        // The spoken conversation, on a limiter of its own rather than the one
        // above. It spends what `agent` spends — a voice turn is the whole
        // tool loop — so it needs a ceiling of that kind; but sharing `agent`
        // would let a spoken question cost a typed one its slot, and the two
        // are used at once, in the same thread, by the same person.
        //
        // Sized for a conversation rather than for a stuck client: a spoken
        // exchange is one request every several seconds, and anything faster
        // than this is something other than a person talking.
        RateLimiter::for('voice', fn (Request $request) => Limit::perMinute(config('agent.voice.rate_limit', 20))->by($request->ip()));
    }
}
