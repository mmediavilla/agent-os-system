<?php

namespace App\Services\Diagnostics\Checks;

use App\Services\Diagnostics\Finding;
use App\Services\Diagnostics\SoftFix;
use Carbon\CarbonImmutable;
use Illuminate\Database\Migrations\Migrator;

/**
 * The two ways the code on disk and the app that is running can disagree.
 *
 * **A cached config hides `.env`.** With `bootstrap/cache/config.php` present,
 * every `env()` read is skipped — it once pointed a `migrate` meant for a test
 * database at the live one. **A pending migration** is code expecting a column
 * the database does not have yet. The first has a soft fix; the second is only
 * ever reported, because running a migration is a change to the database's
 * shape and belongs to the owner.
 */
class ConfigChecks extends Check
{
    public function __construct(private readonly Migrator $migrator) {}

    public static function group(): string
    {
        return 'config';
    }

    public static function title(): string
    {
        return 'Configuration';
    }

    public function run(): array
    {
        return [
            $this->cache(),
            $this->migrations(),
        ];
    }

    private function cache(): Finding
    {
        $cached = $this->cachedConfigPath();
        $env = $this->envPath();
        $title = 'Cached configuration';

        if (! is_file($cached)) {
            return $this->ok('cache', $title, 'Nothing is cached, so .env is read on every request.', ['config cache: none']);
        }

        $cachedAt = CarbonImmutable::createFromTimestamp((int) filemtime($cached));
        $evidence = ['config cache: '.$cachedAt->toIso8601String()];

        if (is_file($env)) {
            $envAt = CarbonImmutable::createFromTimestamp((int) filemtime($env));
            $evidence[] = '.env: '.$envAt->toIso8601String();

            if ($envAt->gt($cachedAt)) {
                return $this->problem(
                    'cache',
                    $title,
                    '.env has changed since the configuration was cached, so the app is still running on the old values.',
                    $evidence,
                    fix: SoftFix::ClearConfigCache,
                );
            }
        }

        return $this->warn(
            'cache',
            $title,
            'The configuration is cached, so the next edit to .env will be ignored until the cache is cleared.',
            $evidence,
            fix: SoftFix::ClearConfigCache,
        );
    }

    /** Overridable so a test never writes the real cache, which Herd would load. */
    protected function cachedConfigPath(): string
    {
        return app()->getCachedConfigPath();
    }

    protected function envPath(): string
    {
        return app()->environmentFilePath();
    }

    private function migrations(): Finding
    {
        $title = 'Migrations';

        if (! $this->migrator->repositoryExists()) {
            return $this->problem('migrations', $title, 'The database has never been migrated.', ['migrations table: missing'], manual: 'From backend/, run: php artisan migrate');
        }

        $files = $this->migrator->getMigrationFiles(array_merge([database_path('migrations')], $this->migrator->paths()));
        $ran = $this->migrator->getRepository()->getRan();
        $pending = array_values(array_diff(array_keys($files), $ran));

        if ($pending === []) {
            return $this->ok('migrations', $title, 'Every migration has run.', ['ran: '.count($ran)]);
        }

        return $this->problem(
            'migrations',
            $title,
            count($pending) === 1 ? 'One migration has not run, so code that needs it will fail.' : count($pending).' migrations have not run, so code that needs them will fail.',
            array_map(fn (string $name) => "pending: {$name}", $pending),
            manual: 'From backend/, run: php artisan migrate',
        );
    }
}
