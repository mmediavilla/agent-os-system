<?php

namespace App\Agent\Contracts;

/**
 * A tool that writes.
 *
 * A marker with no methods, so the confirmation gate is a property of the tool
 * rather than a list kept somewhere else: a new write tool that forgets to
 * implement this is the one failure mode worth designing against, and
 * `ToolRegistryTest` asserts that every tool whose name begins with a writing
 * verb declares it.
 *
 * The gate itself lives in the runner (Phase 3), not here — MCP hosts prompt the
 * user themselves, so the same tool is gated by Laravel on one path and by the
 * host on the other.
 */
interface MutatingTool extends Tool {}
