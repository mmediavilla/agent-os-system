<?php

namespace Tests\Feature\Automations;

use App\Models\Automation;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/** The migration's own row one — off until the owner turns it on. */
class AutomationSeedTest extends TestCase
{
    use RefreshDatabase;

    public function test_the_migration_seeds_a_disabled_morning_greeting(): void
    {
        $automation = Automation::sole();

        $this->assertSame('Morning greeting', $automation->name);
        $this->assertSame('06:30', $automation->time);
        $this->assertSame(['agenda', 'weather', 'training'], $automation->context);
        $this->assertFalse($automation->enabled);
        $this->assertNull($automation->last_run_on);
    }
}
