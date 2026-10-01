import { clearImmediate as nodeClearImmediate, setImmediate as nodeSetImmediate } from "timers";

/**
 * Runs before `jest.setup.ts`, and the order is the whole point.
 *
 * `setImmediate` is not a browser API, so Jest's jsdom environment does not
 * provide one — and RNTL binds its own copy the moment it is imported, falling
 * back to `setTimeout(fn, 0)` when the global is missing. That fallback is
 * captured once and then called after every single test, from the auto-cleanup
 * hook. Under `jest.useFakeTimers()` nothing advances it, so cleanup never
 * resolves and the test fails on the 30s hook timeout rather than on anything
 * it asserted.
 *
 * That is what the timer-driven suites did the moment `testEnvironment` became
 * `jsdom`: `runWatcher` went from six passes in 6s to six hook timeouts in
 * 184s, and the failure names the setup file rather than anything in the test.
 * Nothing in React Native's or Expo's Jest setup fills the gap; under the old
 * `react-native-env` environment there was no `window`, so RNTL read `global`
 * and found Node's own `setImmediate` sitting there.
 *
 * Defining it here means RNTL binds the real one and its cleanup stays on a
 * timer no test controls. Nothing in the app calls `setImmediate`; this exists
 * for the library, and the shipped web bundle never sees it.
 */
if (typeof (globalThis as { setImmediate?: unknown }).setImmediate === "undefined") {
  Object.assign(globalThis, { setImmediate: nodeSetImmediate, clearImmediate: nodeClearImmediate });
}
