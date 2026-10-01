<?php

use Illuminate\Foundation\Application;
use Illuminate\Http\Request;

define('LARAVEL_START', microtime(true));

// Determine if the application is in maintenance mode...
if (file_exists($maintenance = __DIR__.'/../storage/framework/maintenance.php')) {
    require $maintenance;
}

// Register the Composer autoloader...
require __DIR__.'/../vendor/autoload.php';

// Force-load .env with createMutable so any ambient process-level environment
// variables (e.g. ANTHROPIC_API_KEY="") inherited from the parent shell don't
// shadow the values we actually set in .env.  Laravel's own createImmutable
// load runs immediately after and simply leaves these values in place.
(Dotenv\Dotenv::createMutable(__DIR__.'/../'))->safeLoad();

// Bootstrap Laravel and handle the request...
/** @var Application $app */
$app = require_once __DIR__.'/../bootstrap/app.php';

$app->handleRequest(Request::capture());
