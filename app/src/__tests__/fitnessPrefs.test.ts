import {
  DEFAULT_FITNESS_PREFS,
  FITNESS_PREFS_STORAGE_KEY,
  readStoredFitnessPrefs,
  writeStoredFitnessPrefs,
} from "../fitnessPrefs";

const storage = (value: string | null) => ({ getItem: jest.fn(() => value) });

describe("readStoredFitnessPrefs", () => {
  it("falls back to the defaults with no storage or nothing stored", () => {
    expect(readStoredFitnessPrefs(null)).toEqual(DEFAULT_FITNESS_PREFS);
    expect(readStoredFitnessPrefs(storage(null))).toEqual(DEFAULT_FITNESS_PREFS);
  });

  it("reads a valid range", () => {
    expect(readStoredFitnessPrefs(storage('{"defaultRange":"1y"}'))).toEqual({ defaultRange: "1y" });
  });

  it("ignores a range it does not know, and junk", () => {
    // Anything can end up in localStorage.
    expect(readStoredFitnessPrefs(storage('{"defaultRange":"6w"}'))).toEqual(DEFAULT_FITNESS_PREFS);
    expect(readStoredFitnessPrefs(storage("not json"))).toEqual(DEFAULT_FITNESS_PREFS);
    expect(readStoredFitnessPrefs(storage("42"))).toEqual(DEFAULT_FITNESS_PREFS);
  });

  it("survives storage that throws on access", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    expect(readStoredFitnessPrefs(throwing)).toEqual(DEFAULT_FITNESS_PREFS);
  });
});

describe("writeStoredFitnessPrefs", () => {
  it("writes under its own key", () => {
    const setItem = jest.fn();
    writeStoredFitnessPrefs({ setItem }, { defaultRange: "all" });
    expect(setItem).toHaveBeenCalledWith(FITNESS_PREFS_STORAGE_KEY, '{"defaultRange":"all"}');
  });

  it("swallows a failing write", () => {
    const setItem = () => {
      throw new Error("quota");
    };
    expect(() => writeStoredFitnessPrefs({ setItem }, DEFAULT_FITNESS_PREFS)).not.toThrow();
  });
});
