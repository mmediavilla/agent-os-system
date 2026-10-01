import { configure } from "@testing-library/react-native";

/**
 * RNTL's `waitFor` and `findBy*` carry their own 1s ceiling, separate from
 * Jest's `testTimeout`. The search boxes on the catalog screens debounce for
 * 250ms before they call the API, so a test that types and then waits for the
 * request has four times the debounce to spare on an idle machine and nothing
 * to spare on a loaded one.
 *
 * Raising it costs nothing on a passing run, which stops polling the moment the
 * assertion holds. It only lengthens how long a genuinely failing `waitFor`
 * takes to report.
 */
configure({ asyncUtilTimeout: 5000 });

/**
 * `AssistantOrb` animates continuously — that is what an orb is for — and
 * React Native drives `Animated` from timers. So its frames land between a
 * test's `act()` blocks and React warns about each one, several times per
 * test, with a full stack. There is nothing to fix in the component: the
 * warning is about frames arriving, which is the feature.
 *
 * Silenced by message rather than wholesale, so an `act()` warning about
 * anything else — a state update a test really did forget to wrap — still gets
 * through and still gets read.
 */
const passThrough = console.error;

console.error = (...args: Parameters<typeof passThrough>) => {
  const first = args[0];

  if (typeof first === "string" && first.includes("inside a test was not wrapped in act")) return;

  passThrough(...args);
};
