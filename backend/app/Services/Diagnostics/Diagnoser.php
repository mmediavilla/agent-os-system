<?php

namespace App\Services\Diagnostics;

use App\Services\Diagnostics\Checks\AgentStateChecks;
use App\Services\Diagnostics\Checks\AssistantChecks;
use App\Services\Diagnostics\Checks\CalendarChecks;
use App\Services\Diagnostics\Checks\Check;
use App\Services\Diagnostics\Checks\ConfigChecks;
use App\Services\Diagnostics\Checks\DatabaseChecks;
use App\Services\Diagnostics\Checks\FrontendChecks;
use App\Services\Diagnostics\Checks\MachineChecks;
use App\Services\Diagnostics\Checks\QueueChecks;
use App\Services\Diagnostics\Checks\SchedulerChecks;
use App\Services\Diagnostics\Checks\SignInChecks;
use App\Services\Diagnostics\Checks\StorageChecks;
use Carbon\CarbonImmutable;
use Illuminate\Contracts\Container\Container;
use Throwable;

/**
 * Runs every check, in order, and hands back a `Report`.
 *
 * **Deterministic, and free.** No check calls a model: a diagnosis has to work
 * when the key is missing or the switch is off, which is exactly when someone
 * is diagnosing — the `ProactiveTriggers` argument, where code decides and a
 * model would only ever write prose.
 *
 * **A group that throws becomes a problem of its own**, so a broken reading —
 * the database gone, Task Scheduler refusing — costs its own lines and never
 * the rest of the report.
 */
final class Diagnoser
{
    /** The order the page and the `.md` list them in. */
    public const CHECKS = [
        DatabaseChecks::class,
        QueueChecks::class,
        SchedulerChecks::class,
        MachineChecks::class,
        AssistantChecks::class,
        SignInChecks::class,
        CalendarChecks::class,
        AgentStateChecks::class,
        ConfigChecks::class,
        StorageChecks::class,
        FrontendChecks::class,
    ];

    public function __construct(private readonly Container $container) {}

    public function run(string $source, string $kind = Report::KIND_DIAGNOSE): Report
    {
        $findings = [];

        foreach (self::CHECKS as $class) {
            try {
                /** @var Check $check */
                $check = $this->container->make($class);

                array_push($findings, ...$check->run());
            } catch (Throwable $e) {
                report($e);

                $findings[] = new Finding(
                    key: $class::group().'.unavailable',
                    group: $class::group(),
                    title: $class::title().' checks',
                    severity: Severity::Problem,
                    detail: 'These checks could not run, so this part of the machine is unknown.',
                    evidence: [get_class($e).': '.$e->getMessage()],
                    manual: 'Read the newest error in backend/storage/logs/laravel.log.',
                );
            }
        }

        return new Report($kind, $source, CarbonImmutable::now(), $findings);
    }

    /**
     * Every group's key and what it is called, in check order — read off the
     * checks themselves so the page and the `.md` keep no second copy.
     *
     * @return array<string, string>
     */
    public static function groups(): array
    {
        $groups = [];

        foreach (self::CHECKS as $class) {
            /** @var class-string<Check> $class */
            $groups[$class::group()] = $class::title();
        }

        return $groups;
    }
}
