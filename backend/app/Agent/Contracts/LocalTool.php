<?php

namespace App\Agent\Contracts;

use App\Agent\ToolRegistry;

/**
 * A tool whose effect reaches outside the database, onto the machine ProjectMC
 * runs on.
 *
 * A marker with no methods, the same shape as {@see MutatingTool} and for a
 * parallel reason: it lets a registry filter these out generically
 * ({@see ToolRegistry::withoutLocalTools()}) rather than by naming
 * `OpenOnThisMachine` wherever the exclusion matters. An automation (15.3) runs
 * unattended on the queue worker with nobody there to approve — or benefit
 * from — a window it cannot see opening on its own desktop, so it gets the
 * registry with every local tool left out rather than one it could only ever
 * propose and never usefully run.
 */
interface LocalTool extends Tool {}
