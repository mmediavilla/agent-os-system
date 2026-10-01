<?php

return [

    /*
    |--------------------------------------------------------------------------
    | How big a filed document may be
    |--------------------------------------------------------------------------
    |
    | A scanned passport is a couple of megabytes and a photographed contract
    | can be ten, so this is generous where the camera snapshot's limit is
    | mean: there is no client-side downscale in front of it, and a document is
    | uploaded once and never re-sent to a model.
    |
    | Over it is a 413 rather than a resize, for the snapshot's reason — the
    | owner chose this file and should be told it was refused, not handed a
    | quietly degraded copy of it.
    |
    | **It has to stay under PHP's own `upload_max_filesize` and
    | `post_max_size`.** A file over those never reaches Laravel at all: the
    | request arrives with no file in it, so the answer is a validation error
    | about a missing field rather than the honest 413 below.
    |
    */

    'max_kb' => (int) env('DOCUMENTS_MAX_KB', 20480),

];
