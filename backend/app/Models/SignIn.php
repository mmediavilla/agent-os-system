<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * One attempt to sign in, whatever came of it.
 *
 * Append-only: written by `GoogleSignIn` and never updated, so it carries a
 * `created_at` and no `updated_at`.
 */
class SignIn extends Model
{
    public const OK = 'ok';

    /** Google vouched for the account, and it is not the owner's. */
    public const REFUSED = 'refused';

    /** Nothing was learned about the account: an expired state, a bad code, Google down. */
    public const FAILED = 'failed';

    public const UPDATED_AT = null;

    protected $fillable = ['email', 'google_sub', 'outcome', 'reason', 'ip', 'user_agent'];
}
