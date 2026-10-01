<#
.SYNOPSIS
    Registers the two background processes Laravel Herd does not run.

.DESCRIPTION
    Herd serves HTTP and nothing else: there is no cron tick and no queue
    worker. Without both of these the proactive layer is dead code — the
    schedule never fires, and if it did the queued job would sit in the `jobs`
    table forever.

    Two tasks are registered under the current user:

      ProjectMC scheduler      `artisan schedule:run` every minute, forever.
                               Laravel's own scheduler decides from there whether
                               anything is actually due, so a minute tick costs
                               one short PHP process and no queries beyond the
                               schedule table.

      ProjectMC queue worker   `artisan queue:work`, a worker that exits after an
                               hour and is started again by a repeating trigger.
                               The repetition is what makes it self-healing: if
                               the worker dies at 3am the next tick restarts it,
                               and if it is already running the new instance is
                               ignored. The hourly exit is what makes it pick up
                               code changes without being restarted by hand.

    The names carry no colon on purpose. Task Scheduler rejects \ / : * ? " < >
    and | in a task name, and the rejection is the least helpful error in
    Windows: "The parameter is incorrect" (0x80070057), naming neither the
    parameter nor the character. `ProjectMC schedule:run` reads better and does
    not register.

    LOGON TYPE — the one thing to decide:

      default      S4U. No console window, and the tasks run whether or not you
                   are logged on. Registering an S4U task needs an ELEVATED
                   PowerShell; the script refuses up front rather than failing
                   halfway, because Register-ScheduledTask answers
                   "Access is denied" (0x80070005) and keeps going.

      -Interactive Works from an ordinary shell, but the tasks only run while
                   you are logged on and `schedule:run` flashes a console window
                   once a minute. Fine for a day, wearing after that.

.EXAMPLE
    # From an elevated PowerShell — the silent, always-on setup.
    powershell -ExecutionPolicy Bypass -File backend\scripts\register-runtime-tasks.ps1

.EXAMPLE
    # No elevation available. Flashes a window every minute.
    powershell -ExecutionPolicy Bypass -File backend\scripts\register-runtime-tasks.ps1 -Interactive

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File backend\scripts\register-runtime-tasks.ps1 -Remove
#>

[CmdletBinding()]
param(
    # Unregister both tasks instead of creating them.
    [switch]$Remove,

    # Run only while logged on, showing a console window. The fallback when the
    # shell is not elevated.
    [switch]$Interactive
)

$ErrorActionPreference = 'Stop'

$Backend = Split-Path -Parent $PSScriptRoot
$SchedulerTask = 'ProjectMC scheduler'
$WorkerTask = 'ProjectMC queue worker'

if ($Remove) {
    foreach ($name in @($SchedulerTask, $WorkerTask)) {
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false
            Write-Host "Removed '$name'."
        } else {
            Write-Host "'$name' was not registered."
        }
    }
    return
}

# --- Who it runs as, checked first -------------------------------------------
#
# Before anything else, because the answer decides whether this script can do
# its job at all. Register-ScheduledTask answers an unelevated S4U registration
# with "Access is denied" and nothing else, which is a poor place to find out.

$elevated = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $Interactive -and -not $elevated) {
    throw @"
Registering the tasks under S4U (no console window, runs while logged off) needs
an elevated PowerShell. Either:

  - re-run this from an administrator shell, or
  - re-run with -Interactive, which works unelevated but only runs while you are
    logged on and flashes a console window once a minute.
"@
}

$principal = if ($Interactive) {
    New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
} else {
    New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
}

# --- What we are going to run ------------------------------------------------

# `php` on PATH is Herd's shim (bin\php.bat), a one-line batch file pointing at
# the real binary. Task Scheduler will happily run a .bat, but doing so wraps
# every tick in a cmd.exe that exists only to be closed again — so follow the
# shim and register the exe it names.
$php = (Get-Command php -ErrorAction SilentlyContinue).Source
if (-not $php) {
    throw "php is not on PATH. Open a shell where 'php -v' works (Herd adds it) and re-run."
}
if ([IO.Path]::GetExtension($php) -in '.bat', '.cmd') {
    $target = Select-String -Path $php -Pattern '([A-Za-z]:\\[^"]*?php\.exe)' |
        Select-Object -First 1 -ExpandProperty Matches |
        ForEach-Object { $_.Groups[1].Value }

    if ($target -and (Test-Path $target)) {
        Write-Host "Resolved shim $php -> $target"
        $php = $target
    } else {
        Write-Warning "Could not resolve $php to a php.exe; registering the shim as-is."
    }
}

if (-not (Test-Path (Join-Path $Backend 'artisan'))) {
    throw "No artisan found in $Backend. Run this script from the checkout it lives in."
}

Write-Host "php:     $php"
Write-Host "backend: $Backend"
Write-Host "logon:   $(if ($Interactive) { 'Interactive (visible, needs you logged on)' } else { 'S4U (silent, runs logged off)' })"
Write-Host ''

function Register-ProjectMcTask {
    param(
        [string]$Name,
        [string]$Arguments,
        [timespan]$Every,
        [string]$Description
    )

    $action = New-ScheduledTaskAction -Execute $php -Argument $Arguments -WorkingDirectory $Backend

    # Repetition needs a start time in the past so the first tick is immediate
    # rather than a day away. The duration is ten years rather than
    # [TimeSpan]::MaxValue, which serialises to P99999999DT23H59M59S and is
    # rejected outright: "the task XML contains a value ... out of range".
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(-1) `
        -RepetitionInterval $Every -RepetitionDuration ([timespan]::FromDays(3650))

    # IgnoreNew is the whole trick for the worker: the trigger keeps firing, and
    # a firing that finds the previous run still alive is dropped.
    $settings = New-ScheduledTaskSettingsSet `
        -MultipleInstances IgnoreNew `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -ExecutionTimeLimit ([timespan]::Zero)

    if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    }

    # -ErrorAction Stop explicitly: this is a CIM cmdlet and its failures do not
    # reliably honour $ErrorActionPreference. Without it an "Access is denied"
    # prints to the console and the script carries on to announce success, which
    # is how the first version of this file claimed to have registered two tasks
    # that did not exist.
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Description $Description `
        -ErrorAction Stop | Out-Null

    # And then check, because "no exception" is not the same as "it is there".
    if (-not (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue)) {
        throw "Register-ScheduledTask reported no error but '$Name' does not exist."
    }

    Write-Host "Registered '$Name' (every $Every)."
}

Register-ProjectMcTask -Name $SchedulerTask `
    -Arguments 'artisan schedule:run' `
    -Every ([timespan]::FromMinutes(1)) `
    -Description 'Laravel scheduler tick for ProjectMC. Herd runs no cron.'

# `--sleep` is how long an idle worker waits before looking for work again, and it
# is the floor on how long a chat message sits doing nothing before the assistant
# starts. Five seconds was invisible when the only queued thing was a nightly
# nudge; it is a fifth of the wait now that a person is watching a run start.
Register-ProjectMcTask -Name $WorkerTask `
    -Arguments 'artisan queue:work --tries=1 --sleep=1 --max-time=3600' `
    -Every ([timespan]::FromMinutes(5)) `
    -Description 'Laravel queue worker for ProjectMC. Exits hourly to pick up code changes; the trigger restarts it.'

Write-Host ''
Write-Host 'Verify with:'
Write-Host '  Get-ScheduledTask -TaskName "ProjectMC*" | Select-Object TaskName, State'
Write-Host '  php artisan schedule:list'
Write-Host '  php artisan proactive:check'
