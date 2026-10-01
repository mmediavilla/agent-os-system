import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { AuthProvider, SESSION_ENDED, useAuth } from "../AuthProvider";
import Login from "../screens/Login";
import { api } from "../api";
import { APP_URL, STATE_KEY, TOKEN_KEY, notifyUnauthorized } from "../auth";
import { Text } from "react-native";

jest.mock("../api", () => ({
  ...jest.requireActual("../api"),
  api: {
    me: jest.fn(),
    startGoogleSignIn: jest.fn(),
    completeGoogleSignIn: jest.fn(),
    logout: jest.fn(),
  },
}));

const mockApi = api as jest.Mocked<typeof api>;

const OWNER = {
  id: 1,
  name: "Alex",
  email: "owner@example.com",
  avatar_url: null,
  linked_at: null,
  last_login_at: null,
  timezone: "Asia/Manila",
  mcp_token_configured: false,
};

/** Login while signed out, a line naming the owner once in — what `App`'s gate does. */
function Screen() {
  const { state, signOut } = useAuth();
  if (state.status !== "signedIn") return <Login />;
  return (
    <Text onPress={signOut} testID="in">
      {state.user.name}
    </Text>
  );
}

const draw = () =>
  render(
    <AuthProvider>
      <Screen />
    </AuthProvider>,
  );

/**
 * jsdom's `location` cannot be navigated, so each test stubs the three members
 * the provider touches, and `history.replaceState` is spied on rather than run.
 */
const realLocation = window.location;
let assign: jest.Mock;

function visit(path: string, search = "") {
  assign = jest.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { origin: APP_URL, pathname: path, search, assign, replace: jest.fn() },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  window.sessionStorage.clear();
  jest.spyOn(window.history, "replaceState").mockImplementation(() => {});
  visit("/");
});

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
  jest.restoreAllMocks();
});

it("shows Login with no stored token, without asking the API", async () => {
  const q = draw();

  expect(await q.findByLabelText("Sign in with Google")).toBeTruthy();
  expect(mockApi.me).not.toHaveBeenCalled();
});

it("signs straight in with a token the API accepts", async () => {
  window.localStorage.setItem(TOKEN_KEY, "1|ok");
  mockApi.me.mockResolvedValue(OWNER);

  const q = draw();

  expect(await q.findByText("Alex")).toBeTruthy();
});

it("keeps the token when the API cannot be reached, and offers to try again", async () => {
  window.localStorage.setItem(TOKEN_KEY, "1|ok");
  mockApi.me.mockRejectedValueOnce(new TypeError("Failed to fetch"));

  const q = draw();

  expect(await q.findByText("Could not reach the server to check your sign-in.")).toBeTruthy();
  expect(window.localStorage.getItem(TOKEN_KEY)).toBe("1|ok");

  mockApi.me.mockResolvedValue(OWNER);
  fireEvent.press(q.getByLabelText("Try again"));

  expect(await q.findByText("Alex")).toBeTruthy();
});

it("sends the browser to Google and remembers the state it will come back with", async () => {
  mockApi.startGoogleSignIn.mockResolvedValue({
    url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=c&state=st4te",
  });

  const q = draw();
  fireEvent.press(await q.findByLabelText("Sign in with Google"));
  await act(async () => {});

  expect(window.sessionStorage.getItem(STATE_KEY)).toBe("st4te");
  expect(assign).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?client_id=c&state=st4te");
});

it("says why when sign-in cannot start", async () => {
  mockApi.startGoogleSignIn.mockRejectedValue(new Error("Google sign-in is not set up on this server."));

  const q = draw();
  fireEvent.press(await q.findByLabelText("Sign in with Google"));

  expect(await q.findByText("Google sign-in is not set up on this server.")).toBeTruthy();
});

it("finishes a callback this tab started, stores the token and leaves the callback address", async () => {
  window.sessionStorage.setItem(STATE_KEY, "st4te");
  visit("/auth/callback", "?code=c0de&state=st4te");
  mockApi.completeGoogleSignIn.mockResolvedValue({ token: "9|fresh", user: OWNER });

  const q = draw();

  expect(await q.findByText("Alex")).toBeTruthy();
  expect(mockApi.completeGoogleSignIn).toHaveBeenCalledWith("c0de", "st4te");
  expect(window.localStorage.getItem(TOKEN_KEY)).toBe("9|fresh");
  expect(window.history.replaceState).toHaveBeenCalledWith(null, "", "/");
});

it("refuses a callback this tab did not start, without sending the code anywhere", async () => {
  window.sessionStorage.setItem(STATE_KEY, "mine");
  visit("/auth/callback", "?code=c0de&state=theirs");

  const q = draw();

  expect(await q.findByText("That sign-in was not started here. Start again.")).toBeTruthy();
  expect(mockApi.completeGoogleSignIn).not.toHaveBeenCalled();
});

it("shows the server's refusal — another Google account — as it came", async () => {
  window.sessionStorage.setItem(STATE_KEY, "st4te");
  visit("/auth/callback", "?code=c0de&state=st4te");
  mockApi.completeGoogleSignIn.mockRejectedValue(
    Object.assign(new Error("That Google account cannot sign in here."), { status: 403 }),
  );

  const q = draw();

  expect(await q.findByTestId("login-message")).toHaveTextContent("That Google account cannot sign in here.");
  expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
});

it("drops back to Login when a request later comes back 401", async () => {
  window.localStorage.setItem(TOKEN_KEY, "1|ok");
  mockApi.me.mockResolvedValue(OWNER);

  const q = draw();
  await q.findByText("Alex");

  // What `apiFetch` does on any 401 — a session revoked from another browser.
  act(() => notifyUnauthorized());

  expect(await q.findByText(SESSION_ENDED)).toBeTruthy();
  expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
});

it("signs out here even when the server cannot be told", async () => {
  window.localStorage.setItem(TOKEN_KEY, "1|ok");
  mockApi.me.mockResolvedValue(OWNER);
  mockApi.logout.mockRejectedValue(new TypeError("Failed to fetch"));

  const q = draw();
  fireEvent.press(await q.findByTestId("in"));

  expect(await q.findByLabelText("Sign in with Google")).toBeTruthy();
  expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
});
