<?php

namespace App\Services\Calendar;

use RuntimeException;

/**
 * A fetch stopped by {@see FeedAddress} rather than by the network.
 *
 * Its message is a sentence of our own, written to be shown on the panel — the
 * one exception the calendar lets through to the user, because it is the only
 * one that cannot contain the address.
 */
final class AddressRefused extends RuntimeException {}
