<?php

namespace App\Services\Facts;

use RuntimeException;

/**
 * A decision about a fact that is no longer in the state the decision needs —
 * kept or rejected in another tab, or forgotten already. The message is a
 * sentence the screen can show as it is.
 */
class FactNotPending extends RuntimeException {}
