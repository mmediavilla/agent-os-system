import { act } from "@testing-library/react-native";

/**
 * Drives the two file pickers in the app — the CSV import on Workouts, the
 * photo on Equipment.
 *
 * Neither has an element on screen to fire an event at: React Native has no
 * file picker, so both build a DOM `<input type="file">` on the fly, click it,
 * and read the choice from its own `onchange`. Until Phase 7.0 those paths were
 * behind a `Platform.OS !== "web"` guard and unreachable from a suite Jest
 * reported as iOS, so neither had ever been executed by a test. This is what
 * replaces the browser: it hands back the input the screen just created, so a
 * test can supply the file the user would have chosen.
 *
 * Lives outside `__tests__` for the reason page.ts does — Jest reads every file
 * under that directory as a suite.
 */

/** Captured before any spy, so repeated calls nest rather than recurse. */
const nativeCreateElement = document.createElement;

export function captureFilePicker() {
  const inputs: HTMLInputElement[] = [];

  jest.spyOn(document, "createElement").mockImplementation(((tag: string, options?: ElementCreationOptions) => {
    const el = nativeCreateElement.call(document, tag, options);

    if (tag === "input") inputs.push(el as HTMLInputElement);

    return el;
  }) as typeof document.createElement);

  return {
    /** The picker the screen opened most recently. */
    get input() {
      const input = inputs.at(-1);

      if (!input) throw new Error("No file input was created — was the picker opened?");

      return input;
    },

    /** Choose `file`, the way the browser reports a choice: files, then change. */
    async choose(file: File) {
      const input = this.input;

      Object.defineProperty(input, "files", { value: [file], configurable: true });

      await act(async () => {
        await input.onchange?.(new Event("change"));
      });
    },
  };
}

export function csvFile(name = "hevy.csv") {
  return new File(["title,start_time,exercise_title\n"], name, { type: "text/csv" });
}

export function imageFile(name = "rack.jpg") {
  return new File([new Uint8Array([0xff, 0xd8, 0xff])], name, { type: "image/jpeg" });
}
