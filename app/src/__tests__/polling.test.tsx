import React from "react";
import { Text, View } from "react-native";
import { act, render, screen } from "@testing-library/react-native";
import { Polled, usePolled } from "../polling";

/**
 * The first thing in this app that keeps asking.
 *
 * Every other screen fetches on arrival and on re-entry, which needs no timer
 * at all. A HUD claims its numbers are true *now* and is meant to be left open,
 * so the two properties worth holding onto are the two ways that turns into a
 * request loop nobody asked for: a screen that is mounted but not on, and a tab
 * that is open but not looked at.
 */

jest.useFakeTimers();

function Probe({ fetcher, active }: { fetcher: () => Promise<string>; active?: boolean }) {
  const polled: Polled<string> = usePolled(fetcher, { intervalMs: 1_000, active });

  return (
    <View>
      <Text testID="data">{polled.data ?? "—"}</Text>
      <Text testID="error">{polled.error ?? "—"}</Text>
      <Text testID="loading">{String(polled.loading)}</Text>
    </View>
  );
}

/** Lets the pending fetch resolve inside `act`. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

function hide(hidden: boolean) {
  Object.defineProperty(document, "visibilityState", {
    value: hidden ? "hidden" : "visible",
    configurable: true,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => hide(false));

it("reads once immediately rather than waiting out the first interval", async () => {
  const fetcher = jest.fn().mockResolvedValue("first");
  render(<Probe fetcher={fetcher} />);
  await settle();

  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("data").props.children).toBe("first");
  expect(screen.getByTestId("loading").props.children).toBe("false");
});

it("keeps reading on the interval", async () => {
  const fetcher = jest.fn().mockResolvedValue("x");
  render(<Probe fetcher={fetcher} />);
  await settle();

  await act(async () => {
    jest.advanceTimersByTime(3_000);
  });

  expect(fetcher).toHaveBeenCalledTimes(4);
});

it("does nothing at all while the screen is not the active one", async () => {
  // Screens are hidden rather than unmounted here, so a poller keyed off
  // mounting would keep running against a screen nobody has looked at since
  // breakfast.
  const fetcher = jest.fn().mockResolvedValue("x");
  render(<Probe fetcher={fetcher} active={false} />);
  await settle();

  await act(async () => {
    jest.advanceTimersByTime(5_000);
  });

  expect(fetcher).not.toHaveBeenCalled();
});

it("stops while the tab is hidden and reads again the moment it is not", async () => {
  // Browsers throttle background timers rather than stopping them, so without
  // this the app quietly issues requests from every tab it was ever opened in.
  const fetcher = jest.fn().mockResolvedValue("x");
  hide(true);
  render(<Probe fetcher={fetcher} />);
  await settle();

  expect(fetcher).not.toHaveBeenCalled();

  await act(async () => {
    jest.advanceTimersByTime(5_000);
  });
  expect(fetcher).not.toHaveBeenCalled();

  // Not "resume the schedule" — read now. The first thing a returning eye lands
  // on is the thing that is stale.
  await act(async () => {
    hide(false);
  });
  await settle();

  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("keeps the last reading when a refresh fails", async () => {
  const fetcher = jest
    .fn()
    .mockResolvedValueOnce("good")
    .mockRejectedValue(new Error("network"));

  render(<Probe fetcher={fetcher} />);
  await settle();

  await act(async () => {
    jest.advanceTimersByTime(1_000);
  });
  await settle();

  // A panel that blanks on one dropped request flickers its way through a wifi
  // hiccup; one that keeps the number and says it could not refresh does not.
  expect(screen.getByTestId("data").props.children).toBe("good");
  expect(screen.getByTestId("error").props.children).not.toBe("—");
});

it("clears the error once a read succeeds again", async () => {
  const fetcher = jest
    .fn()
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValue("back");

  render(<Probe fetcher={fetcher} />);
  await settle();
  expect(screen.getByTestId("error").props.children).not.toBe("—");

  await act(async () => {
    jest.advanceTimersByTime(1_000);
  });
  await settle();

  expect(screen.getByTestId("data").props.children).toBe("back");
  expect(screen.getByTestId("error").props.children).toBe("—");
});

it("does not restart the timer when the caller passes a fresh arrow every render", async () => {
  // The fetcher is almost always written inline in the caller's render, so it
  // is a new function every time. Holding it in a ref is what keeps that from
  // restarting the interval sixty times a second.
  const fetcher = jest.fn().mockResolvedValue("x");
  const { rerender } = render(<Probe fetcher={() => fetcher()} />);
  await settle();

  for (let i = 0; i < 5; i++) rerender(<Probe fetcher={() => fetcher()} />);

  await act(async () => {
    jest.advanceTimersByTime(1_000);
  });

  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("writes nothing after it is unmounted", async () => {
  let resolve: (value: string) => void = () => {};
  const fetcher = jest.fn(() => new Promise<string>((r) => (resolve = r)));

  const { unmount } = render(<Probe fetcher={fetcher} />);
  unmount();

  await act(async () => {
    resolve("late");
    await Promise.resolve();
  });

  // Nothing to assert on screen — the assertion is that React did not warn
  // about a state update on an unmounted component, which fails the test.
  expect(fetcher).toHaveBeenCalledTimes(1);
});
