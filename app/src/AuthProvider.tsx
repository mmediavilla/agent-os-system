import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { ApiError, api, errorMessage } from "./api";
import {
  AuthUser,
  callbackStep,
  clearToken,
  getToken,
  rememberState,
  setToken,
  setUnauthorizedHandler,
  stateOf,
  takeState,
} from "./auth";

/**
 * Where this browser stands.
 *
 * `offline` is its own state rather than `signedOut`: a token the API could not
 * be asked about is not a token the API refused, and throwing it away because
 * Herd was restarting would make the owner sign in again for nothing.
 */
export type AuthState =
  | { status: "checking" }
  | { status: "signedOut"; message?: string }
  | { status: "offline"; message: string }
  | { status: "signedIn"; user: AuthUser };

export type AuthController = {
  state: AuthState;
  /** Off to Google. Resolves only if it could not go. */
  signIn: () => Promise<void>;
  /** Ends this browser's session on the server, then here — here whatever the server said. */
  signOut: () => Promise<void>;
  /** Ask the API about the stored token again, after `offline`. */
  retry: () => void;
};

const AuthContext = createContext<AuthController | null>(null);

export function useAuth(): AuthController {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth needs an AuthProvider above it.");
  return ctx;
}

/** Said when a token that worked stops working. */
export const SESSION_ENDED = "Your session ended. Sign in again.";

/**
 * The owner's sign-in, for everything under it.
 *
 * On a load it does one of three things: finishes a sign-in Google has just
 * sent back, checks a stored token with `GET /auth/me`, or shows Login. A 401
 * from any request later — through `apiFetch` — drops the token and shows Login
 * again, which is how a session revoked from another browser ends here.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "checking" });
  const [attempt, setAttempt] = useState(0);

  // The 401 handler reads this rather than the state, so it is registered once.
  const signedIn = useRef(false);
  signedIn.current = state.status === "signedIn";

  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearToken();
      // A 401 while signed out is the sign-in check's own answer, handled there.
      if (signedIn.current) setState({ status: "signedOut", message: SESSION_ENDED });
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const settle = (next: AuthState) => {
      if (!cancelled) setState(next);
    };

    const check = async () => {
      const step = typeof window !== "undefined" && window.location ? callbackStep(window.location) : { kind: "none" as const };

      if (step.kind === "error" || step.kind === "complete") {
        // Off the callback address whatever happens, so a reload never tries to
        // redeem the same code twice and the address bar reads as the app.
        try {
          window.history.replaceState(null, "", "/");
        } catch {}
      }

      if (step.kind === "error") {
        takeState();
        return settle({ status: "signedOut", message: step.message });
      }

      if (step.kind === "complete") {
        // A callback this tab did not start is one somebody else started — a
        // link sent to the owner — and redeeming it would sign this browser into
        // whatever account began it.
        if (takeState() !== step.state) {
          return settle({ status: "signedOut", message: "That sign-in was not started here. Start again." });
        }

        try {
          const { token, user } = await api.completeGoogleSignIn(step.code, step.state);
          setToken(token);
          return settle({ status: "signedIn", user });
        } catch (e) {
          return settle({ status: "signedOut", message: errorMessage(e) });
        }
      }

      if (!getToken()) return settle({ status: "signedOut" });

      try {
        settle({ status: "signedIn", user: await api.me() });
      } catch (e) {
        if ((e as ApiError).status === 401) {
          clearToken();
          settle({ status: "signedOut", message: SESSION_ENDED });
        } else {
          settle({ status: "offline", message: "Could not reach the server to check your sign-in." });
        }
      }
    };

    check();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const signIn = useCallback(async () => {
    try {
      const { url } = await api.startGoogleSignIn();
      const state = stateOf(url);
      if (state) rememberState(state);
      window.location.assign(url);
    } catch (e) {
      setState({ status: "signedOut", message: errorMessage(e) });
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // Signed out here regardless: a server that could not be told still ends
      // up with a token nobody holds, which expires on its own.
    }
    clearToken();
    setState({ status: "signedOut" });
  }, []);

  const retry = useCallback(() => {
    setState({ status: "checking" });
    setAttempt((n) => n + 1);
  }, []);

  return <AuthContext.Provider value={{ state, signIn, signOut, retry }}>{children}</AuthContext.Provider>;
}
