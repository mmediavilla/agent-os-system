<?php

namespace App\Services\Diagnostics\Checks;

use App\Services\Diagnostics\Finding;
use Illuminate\Support\Facades\Http;
use Throwable;

/**
 * The web app answers.
 *
 * From the HUD this is proof of nothing — the page asking is the evidence. It
 * earns its place on `php artisan diagnose`, the path taken when the HUD will
 * not load: Herd answers 502 for `projectmc-app.test` whenever the Expo dev
 * server is not running, and starting it is always the owner's job.
 *
 * TLS is not verified: Herd's certificate is its own, PHP's curl does not
 * trust it, and this reads a status code from this machine and nothing else.
 */
class FrontendChecks extends Check
{
    public static function group(): string
    {
        return 'frontend';
    }

    public static function title(): string
    {
        return 'Web app';
    }

    public function run(): array
    {
        return [$this->web()];
    }

    private function web(): Finding
    {
        $url = (string) config('diagnostics.frontend.url');
        $title = 'Web app answers';

        try {
            $status = Http::timeout((int) config('diagnostics.frontend.timeout'))
                ->withoutVerifying()
                ->withoutRedirecting()
                ->get($url)
                ->status();
        } catch (Throwable) {
            return $this->problem('web', $title, 'Nothing answered at the web app\'s address.', ["url: {$url}", 'status: no answer'], manual: $this->start());
        }

        $evidence = ["url: {$url}", "status: {$status}"];

        return match (true) {
            $status < 400 => $this->ok('web', $title, 'The web app answered.', $evidence),
            $status === 502 => $this->problem('web', $title, 'Herd answered 502, which means the Expo dev server is not running.', $evidence, manual: $this->start()),
            default => $this->warn('web', $title, "The web app answered {$status}.", $evidence, manual: 'Check the Expo terminal for an error.'),
        };
    }

    /** CLAUDE.md's command, with this checkout's `app/` folder in it. */
    private function start(): string
    {
        $app = dirname(base_path()).DIRECTORY_SEPARATOR.'app';

        return 'In PowerShell, run: Start-Process cmd.exe -ArgumentList "/c","npx expo start --web --port 8082" -WorkingDirectory "'.$app.'"';
    }
}
