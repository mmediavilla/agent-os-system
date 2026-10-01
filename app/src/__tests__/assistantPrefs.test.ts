import {
  ASSISTANT_PREFS_STORAGE_KEY,
  DEFAULT_ASSISTANT_PREFS,
  readStoredAssistantPrefs,
  writeStoredAssistantPrefs,
} from "../assistantPrefs";

const storage = (value: string | null) => ({ getItem: jest.fn(() => value) });

describe("readStoredAssistantPrefs", () => {
  it("falls back to the defaults with no storage or nothing stored", () => {
    expect(readStoredAssistantPrefs(null)).toEqual(DEFAULT_ASSISTANT_PREFS);
    expect(readStoredAssistantPrefs(storage(null))).toEqual(DEFAULT_ASSISTANT_PREFS);
    // A reply announces itself, and the chat continues where it was.
    expect(DEFAULT_ASSISTANT_PREFS).toEqual({ unreadSignal: true, openOn: "last" });
  });

  it("reads valid choices", () => {
    expect(readStoredAssistantPrefs(storage('{"unreadSignal":false,"openOn":"new"}'))).toEqual({
      unreadSignal: false,
      openOn: "new",
    });
  });

  it("falls back per field, and on junk", () => {
    expect(readStoredAssistantPrefs(storage('{"unreadSignal":"no","openOn":"new"}'))).toEqual({
      unreadSignal: true,
      openOn: "new",
    });
    expect(readStoredAssistantPrefs(storage('{"unreadSignal":false,"openOn":"first"}'))).toEqual({
      unreadSignal: false,
      openOn: "last",
    });
    expect(readStoredAssistantPrefs(storage("not json"))).toEqual(DEFAULT_ASSISTANT_PREFS);
    expect(readStoredAssistantPrefs(storage("42"))).toEqual(DEFAULT_ASSISTANT_PREFS);
  });

  it("survives storage that throws on access", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    expect(readStoredAssistantPrefs(throwing)).toEqual(DEFAULT_ASSISTANT_PREFS);
  });
});

describe("writeStoredAssistantPrefs", () => {
  it("writes under its own key", () => {
    const setItem = jest.fn();
    writeStoredAssistantPrefs({ setItem }, { unreadSignal: false, openOn: "new" });
    expect(setItem).toHaveBeenCalledWith(ASSISTANT_PREFS_STORAGE_KEY, '{"unreadSignal":false,"openOn":"new"}');
  });

  it("swallows a failing write", () => {
    const setItem = () => {
      throw new Error("quota");
    };
    expect(() => writeStoredAssistantPrefs({ setItem }, DEFAULT_ASSISTANT_PREFS)).not.toThrow();
  });
});
