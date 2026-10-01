/**
 * The owner's sign-in, as this browser holds it.
 *
 * **A bearer token, not a cookie.** The API is `projectmc.test` and the app is
 * `projectmc-app.test` — two sites — so a session cookie would be a third-party
 * cookie, which browsers are in the business of refusing. The token is issued
 * per sign-in by the server and kept in `localStorage`; it is never part of the
 * bundle, which is what separates it from the `EXPO_PUBLIC_*` token CLAUDE.md
 * explains was never a secret.
 *
 * This module is storage and pure URL logic only. It must not import `api.ts`
 * (which imports it), so the network half of signing in lives in
 * `AuthProvider`.
 */

/** Where the token lives. */
export const TOKEN_KEY = "projectmc.auth";

/**
 * The `state` of the sign-in this tab started, kept until Google sends the
 * browser back with it. Session storage, because a sign-in is one tab's.
 */
export const STATE_KEY = "projectmc.auth.state";

/** The one path Google returns to, on either origin. */
export const CALLBACK_PATH = "/auth/callback";

/**
 * The app's own origin, where every sign-in finishes.
 *
 * Google refuses `.test` redirect URIs, so it sends the browser to
 * `http://localhost:8082/auth/callback` — the same Expo server under a name
 * Google accepts — and that page forwards here at once.
 */
export const APP_URL = (process.env.EXPO_PUBLIC_APP_URL ?? "https://projectmc-app.test").replace(/\/+$/, "");

/** The account the API answers `GET /auth/me` with. */
export type AuthUser = {
  id: number;
  name: string;
  email: string;
  avatar_url: string | null;
  linked_at: string | null;
  last_login_at: string | null;
  timezone: string;
  mcp_token_configured: boolean;
};

// Every storage access is guarded: a private window, blocked site data or a
// sandboxed preview can throw on the accessor itself, and a sign-in that cannot
// be remembered should still work for as long as the page is open.

let memoryToken: string | null = null;

export function getToken(): string | null {
  try {
    // Storage answers when it can; the copy in memory is only for when it throws.
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return memoryToken;
  }
}

export function setToken(token: string) {
  memoryToken = token;
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {}
}

export function clearToken() {
  memoryToken = null;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

export function rememberState(state: string) {
  try {
    window.sessionStorage.setItem(STATE_KEY, state);
  } catch {}
}

/** The state this tab is waiting for, forgotten as it is read — it works once. */
export function takeState(): string | null {
  try {
    const state = window.sessionStorage.getItem(STATE_KEY);
    window.sessionStorage.removeItem(STATE_KEY);
    return state;
  } catch {
    return null;
  }
}

/** The `state` Google will send back, read off the address the server built. */
export function stateOf(authorizeUrl: string): string | null {
  const query = authorizeUrl.split("?")[1] ?? "";
  return new URLSearchParams(query).get("state");
}

// ── 401 ──────────────────────────────────────────────────────────────────────

let unauthorized: (() => void) | null = null;

/**
 * Who to tell when the API says the token is no good — revoked from another
 * browser, expired, or deleted from the database. `AuthProvider` registers
 * itself, drops the token and shows Login.
 */
export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorized = handler;
}

export function notifyUnauthorized() {
  unauthorized?.();
}

// ── The callback ─────────────────────────────────────────────────────────────

/** What a page load at `/auth/callback` has to do. */
export type CallbackStep =
  /** Not a callback: an ordinary load. */
  | { kind: "none" }
  /** A callback on the localhost name: forward it to the app's own origin. */
  | { kind: "bounce"; to: string }
  /** Google said no, or the user cancelled. */
  | { kind: "error"; message: string }
  /** A code to redeem. `state` is checked against this tab's before anything is sent. */
  | { kind: "complete"; code: string; state: string };

/**
 * Read a location as a sign-in callback, if it is one.
 *
 * Pure, so every branch is tested without a browser; `AuthProvider` acts on it.
 */
export function callbackStep(location: { origin: string; pathname: string; search: string }): CallbackStep {
  if (location.pathname.replace(/\/+$/, "") !== CALLBACK_PATH) return { kind: "none" };

  if (location.origin !== APP_URL) {
    return { kind: "bounce", to: `${APP_URL}${CALLBACK_PATH}${location.search}` };
  }

  const query = new URLSearchParams(location.search);
  const code = query.get("code");
  const state = query.get("state");

  if (query.get("error") === "access_denied") {
    return { kind: "error", message: "Sign-in was cancelled." };
  }
  if (query.get("error") || !code || !state) {
    return { kind: "error", message: "Google did not finish the sign-in. Try again." };
  }

  return { kind: "complete", code, state };
}

/**
 * Forward a callback that landed on the localhost name, before anything renders.
 *
 * Returns true when the page is leaving, so `App` draws nothing — no provider,
 * no poll, no half a HUD flashing on an origin that is about to be replaced.
 */
export function bounceIfNeeded(): boolean {
  if (typeof window === "undefined" || !window.location) return false;

  const step = callbackStep(window.location);
  if (step.kind !== "bounce") return false;

  window.location.replace(step.to);
  return true;
}
