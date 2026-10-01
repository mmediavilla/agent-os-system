import "react-native";

/**
 * `dataSet` is real, and React Native's own types have never heard of it.
 *
 * It is react-native-web's escape hatch: whatever object you hand it is written
 * out as `data-*` attributes on the DOM element, which is how a React Native
 * tree gets to participate in CSS that was written by hand — the `[data-hud]`
 * block in `theme.ts` being the reason this file exists. RN's `ViewProps` is
 * the cross-platform contract and correctly omits it, so without this
 * augmentation every scope container needs an `as any`, and an `as any` on a
 * container is a hole large enough to lose a real prop through.
 *
 * Declared for `ViewProps` alone rather than for `Text` and the rest: one
 * caller needs it today, and a prop that exists everywhere invites use in the
 * places where it turns into an attribute nobody styles.
 */
declare module "react-native" {
  interface ViewProps {
    dataSet?: Record<string, string | number | boolean>;
  }
}
