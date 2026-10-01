import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import ProfileView, { initials } from "../ProfileView";
import { ApiError, AuthSession, SignInAttempt, api } from "../../api";
import { AuthUser } from "../../auth";

/**
 * Profile: the account, the browsers holding it, and who has tried to sign in.
 *
 * What matters is what a click cannot do by mistake — revoke this browser from
 * its own row, or show a session as gone before the server has said so — and
 * that a refused attempt is visible rather than folded into the rest.
 */

jest.mock("../../api", () => ({
  ...jest.requireActual("../../api"),
  api: {
    listSessions: jest.fn(),
    listSignIns: jest.fn(),
    revokeSession: jest.fn(),
    revokeOtherSessions: jest.fn(),
  },
}));

const mockApi = api as jest.Mocked<typeof api>;

const USER: AuthUser = {
  id: 1,
  name: "Alex Rivera",
  email: "owner@example.com",
  avatar_url: null,
  linked_at: "2026-09-18T02:00:00+00:00",
  last_login_at: "2026-09-19T01:00:00+00:00",
  timezone: "Asia/Manila",
  mcp_token_configured: true,
};

const session = (id: number, extra: Partial<AuthSession> = {}): AuthSession => ({
  id,
  name: `Chrome on Windows ${id}`,
  ip_address: "127.0.0.1",
  user_agent: "Mozilla/5.0",
  created_at: "2026-09-18T02:00:00+00:00",
  last_used_at: "2026-09-19T01:00:00+00:00",
  expires_at: null,
  current: false,
  ...extra,
});

const attempt = (id: number, extra: Partial<SignInAttempt> = {}): SignInAttempt => ({
  id,
  email: "owner@example.com",
  outcome: "ok",
  reason: null,
  ip: "127.0.0.1",
  user_agent: "Mozilla/5.0",
  created_at: "2026-09-18T02:00:00+00:00",
  ...extra,
});

function show(props: Partial<React.ComponentProps<typeof ProfileView>> = {}) {
  const onSignOut = jest.fn();
  const view = render(<ProfileView active user={USER} onSignOut={onSignOut} {...props} />);
  return { ...view, onSignOut };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.listSessions.mockResolvedValue({ data: [session(1, { current: true }), session(2)] });
  mockApi.listSignIns.mockResolvedValue({ data: [attempt(1)] });
  mockApi.revokeSession.mockResolvedValue({ revoked: 1 });
  mockApi.revokeOtherSessions.mockResolvedValue({ revoked: 1 });
});

it("draws the account it was handed, and says whether the MCP token is set, never what it is", async () => {
  show();

  const account = within(screen.getByTestId("profile-account"));
  expect(account.getByText("Alex Rivera")).toBeTruthy();
  expect(account.getByText("owner@example.com")).toBeTruthy();
  expect(account.getByText("Asia/Manila")).toBeTruthy();
  expect(within(screen.getByTestId("profile-mcp")).getByText("set")).toBeTruthy();
  // Initials stand in for a missing photo.
  expect(within(screen.getByTestId("profile-avatar")).getByText("AR")).toBeTruthy();

  await screen.findByTestId("profile-session-1");
});

it("reads on arrival and not before, and never polls", async () => {
  jest.useFakeTimers();
  try {
    const view = show({ active: false });
    expect(mockApi.listSessions).not.toHaveBeenCalled();

    view.rerender(<ProfileView active user={USER} onSignOut={jest.fn()} />);
    await act(async () => {});
    expect(mockApi.listSessions).toHaveBeenCalledTimes(1);
    expect(mockApi.listSignIns).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(10 * 60_000);
    });
    expect(mockApi.listSessions).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

it("marks this browser and gives it no Revoke — signing out is the Sign out button", async () => {
  const { onSignOut } = show();

  await screen.findByTestId("profile-session-1-current");
  expect(screen.queryByTestId("profile-session-1-revoke")).toBeNull();
  expect(screen.getByTestId("profile-session-2-revoke")).toBeTruthy();

  fireEvent.press(screen.getByTestId("profile-sign-out"));
  expect(onSignOut).toHaveBeenCalledTimes(1);
  expect(mockApi.revokeSession).not.toHaveBeenCalled();
});

it("revokes another browser, and redraws from the server's answer rather than guessing", async () => {
  show();
  await screen.findByTestId("profile-session-2");

  let finish!: (v: { revoked: number }) => void;
  mockApi.revokeSession.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  mockApi.listSessions.mockResolvedValue({ data: [session(1, { current: true })] });

  fireEvent.press(screen.getByTestId("profile-session-2-revoke"));

  // Still there, and nothing else can be pressed, while the server decides.
  expect(mockApi.revokeSession).toHaveBeenCalledWith(2);
  expect(screen.getByTestId("profile-session-2")).toBeTruthy();
  expect(screen.getByTestId("profile-revoke-others").props.accessibilityState.disabled).toBe(true);

  await act(async () => finish({ revoked: 1 }));

  await waitFor(() => expect(screen.queryByTestId("profile-session-2")).toBeNull());
  expect(mockApi.listSessions).toHaveBeenCalledTimes(2);
});

it("re-reads after a revoke that failed too, and says why", async () => {
  show();
  await screen.findByTestId("profile-session-2");

  mockApi.revokeSession.mockRejectedValue(Object.assign(new Error("Not found."), { status: 404 }) as ApiError);
  mockApi.listSessions.mockResolvedValue({ data: [session(1, { current: true })] });

  fireEvent.press(screen.getByTestId("profile-session-2-revoke"));

  await waitFor(() => expect(screen.queryByTestId("profile-session-2")).toBeNull());
  expect(within(screen.getByTestId("profile-sessions")).getByText("Not found.")).toBeTruthy();
});

it("signs out every other browser, and cannot when there are none", async () => {
  show();
  await screen.findByTestId("profile-session-2");

  mockApi.listSessions.mockResolvedValue({ data: [session(1, { current: true })] });
  fireEvent.press(screen.getByTestId("profile-revoke-others"));

  await waitFor(() => expect(screen.queryByTestId("profile-session-2")).toBeNull());
  expect(mockApi.revokeOtherSessions).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("profile-revoke-others").props.accessibilityState.disabled).toBe(true);
});

it("shows refused attempts in amber with the reason, in words", async () => {
  mockApi.listSignIns.mockResolvedValue({
    data: [
      attempt(3, { email: "stranger@example.com", outcome: "refused", reason: "not_owner" }),
      attempt(2, { outcome: "failed", reason: "brand_new_code" }),
      attempt(1),
    ],
  });
  show();

  const history = within(await screen.findByTestId("profile-history"));
  await history.findByText("stranger@example.com");
  expect(history.getByText("1 refused")).toBeTruthy();
  expect(screen.getByTestId("profile-sign-in-3-reason").props.children).toBe("not the owner's address");
  // A code this screen has no words for is shown as it came.
  expect(screen.getByTestId("profile-sign-in-2-reason").props.children).toBe("brand_new_code");
  // A success has no reason line.
  expect(screen.queryByTestId("profile-sign-in-1-reason")).toBeNull();
});

it("says so when nothing has been refused", async () => {
  show();
  expect(await within(screen.getByTestId("profile-history")).findByText("none refused")).toBeTruthy();
});

it("keeps a failed read to its own card", async () => {
  mockApi.listSignIns.mockRejectedValue(new Error("The server could not be reached."));
  show();

  expect(await within(screen.getByTestId("profile-history")).findByText("The server could not be reached.")).toBeTruthy();
  expect(await screen.findByTestId("profile-session-2")).toBeTruthy();
});

it("makes initials from one or two words", () => {
  expect(initials("Alex Rivera")).toBe("AR");
  expect(initials("Cher")).toBe("C");
  expect(initials("Mary Ann Smith")).toBe("MS");
  expect(initials("  ")).toBe("?");
});
