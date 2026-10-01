<?php

namespace App\Http\Controllers;

use App\Models\Snapshot;
use Illuminate\Support\Facades\Storage;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * The picture behind a snapshot block.
 *
 * Same shape as `GET /api/equipment/{id}/image`, and for the same two reasons:
 * the file is on the private disk, so there is no `storage:link` to get wrong
 * on a fresh checkout, and a route is the natural place to put an ownership
 * check when auth finally lands.
 *
 * It is `immutable` with no version in the URL, which the equipment route
 * cannot be. A snapshot has no replace path — it is written once with the turn
 * that carries it and deleted with the thread — so this copy never needs
 * revalidating and the HUD, which re-reads its transcript at the end of every
 * run, fetches each picture exactly once.
 */
class AgentSnapshotController extends Controller
{
    public function __invoke(Snapshot $snapshot): StreamedResponse
    {
        // A row whose file has gone is a 404 rather than a 500: the transcript
        // is the record and the picture is a convenience, so a thread with one
        // missing still opens.
        abort_if(! $snapshot->path || ! Storage::exists($snapshot->path), 404);

        return Storage::response($snapshot->path, null, [
            'Content-Type' => $snapshot->media_type,
            'Cache-Control' => 'private, max-age=31536000, immutable',
        ]);
    }
}
