import {
  APP_URL,
  STATE_KEY,
  TOKEN_KEY,
  callbackStep,
  clearToken,
  getToken,
  rememberState,
  setToken,
  stateOf,
  takeState,
} from "../auth";

const at = (origin: string, pathname: string, search = "") => ({ origin, pathname, search });

describe("callbackStep", () => {
  it("leaves every other page alone", () => {
    expect(callbackStep(at(APP_URL, "/"))).toEqual({ kind: "none" });
    expect(callbackStep(at("http://localhost:8082", "/", "?code=x&state=y"))).toEqual({ kind: "none" });
  });

  it("forwards a callback on the localhost name to the app's origin, query intact", () => {
    expect(callbackStep(at("http://localhost:8082", "/auth/callback", "?code=abc&state=xyz"))).toEqual({
      kind: "bounce",
      to: `${APP_URL}/auth/callback?code=abc&state=xyz`,
    });
  });

  it("finishes a callback on the app's own origin", () => {
    expect(callbackStep(at(APP_URL, "/auth/callback/", "?code=abc&state=xyz"))).toEqual({
      kind: "complete",
      code: "abc",
      state: "xyz",
    });
  });

  it("reads a cancelled consent screen as a cancellation, not a failure", () => {
    expect(callbackStep(at(APP_URL, "/auth/callback", "?error=access_denied&state=xyz"))).toEqual({
      kind: "error",
      message: "Sign-in was cancelled.",
    });
  });

  it("refuses a callback missing its code or state", () => {
    expect(callbackStep(at(APP_URL, "/auth/callback", "?code=abc")).kind).toBe("error");
    expect(callbackStep(at(APP_URL, "/auth/callback", "?state=xyz")).kind).toBe("error");
  });
});

describe("storage", () => {
  it("keeps the token under its key, and forgets it", () => {
    setToken("3|abc");
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe("3|abc");
    expect(getToken()).toBe("3|abc");

    clearToken();
    expect(getToken()).toBeNull();
  });

  it("keeps working for the page's life when storage throws", () => {
    const spy = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    setToken("3|abc");
    expect(getToken()).toBe("3|abc");

    spy.mockRestore();
    jest.restoreAllMocks();
    clearToken();
  });

  it("hands the state back once", () => {
    rememberState("xyz");
    expect(window.sessionStorage.getItem(STATE_KEY)).toBe("xyz");

    expect(takeState()).toBe("xyz");
    expect(takeState()).toBeNull();
  });

  it("reads the state off the address the server built", () => {
    expect(stateOf("https://accounts.google.com/o/oauth2/v2/auth?client_id=c&state=s%2B1&nonce=n")).toBe("s+1");
    expect(stateOf("https://accounts.google.com/")).toBeNull();
  });
});
