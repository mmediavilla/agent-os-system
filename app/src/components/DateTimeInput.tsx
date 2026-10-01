import React, { useLayoutEffect, useRef } from "react";
import { TextInput, TextInputProps } from "react-native";
import { pickerScope } from "../theme";

/**
 * A date or a time field that opens the browser's own picker.
 *
 * Web is the only target, so a date and a time are two of the few things the
 * platform already draws better than anything worth building here: a calendar
 * panel, a spinner, arrow keys, the locale's own reading of 06:30, and a value
 * that is either well-formed or empty. What the app keeps is the wire format —
 * `YYYY-MM-DD` and 24-hour `HH:MM` — which is exactly what `input.value` holds
 * whatever the control shows, so nothing downstream changes.
 *
 * **The type has to be written on the node, and written again after every
 * render.** RN-Web's `TextInput` derives the DOM `type` from `inputMode`,
 * `keyboardType` and `secureTextEntry` and then assigns it unconditionally —
 * `supportedProps.type = multiline ? undefined : type` — so a `type="time"`
 * passed in as a prop is overwritten with `undefined` and the field renders as
 * a plain text box, which is the whole reason this component exists. Setting it
 * on the host node instead is not enough on its own either: React's own
 * `updateInput` runs on **every** commit to an input and, for a null type,
 * calls `removeAttribute("type")` — so a field set once at mount silently falls
 * back to text the first time anything above it re-renders. That is not
 * theoretical; it is what the Automations card, which re-renders on a timer,
 * did in Chrome while jsdom showed the mount and called it fine.
 *
 * So the assignment has no dependency array. A layout effect runs after each
 * commit and before the paint that commit causes, which is what keeps the
 * control from ever being seen as a text box, and the value survives the switch
 * because it was already in the format the control parses.
 *
 * Everything else stays a `TextInput`: the styles, `testID`, the accessibility
 * label and `onChangeText` are the ones the callers already pass, so the field
 * a test drives and the field on screen are still the same element.
 *
 * Two props the callers used to pass are dropped rather than forwarded:
 * `placeholder`, which neither control shows, and `maxLength`, which does not
 * apply to them.
 */
export default function DateTimeInput({
  kind,
  ...rest
}: Omit<TextInputProps, "multiline" | "keyboardType" | "inputMode" | "secureTextEntry"> & {
  kind: "date" | "time";
}) {
  const ref = useRef<TextInput | null>(null);

  useLayoutEffect(() => {
    // Null under `react-test-renderer`, which supplies no host node, and the
    // guard is also what keeps this honest anywhere that is not a DOM.
    const node = ref.current as unknown as HTMLInputElement | null;

    if (node && "type" in node && node.type !== kind) node.type = kind;
  });

  return <TextInput ref={ref} {...pickerScope(kind)} {...rest} />;
}
