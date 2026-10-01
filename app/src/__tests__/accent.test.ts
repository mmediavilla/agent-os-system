import {
  ACCENTS,
  ACCENT_STORAGE_KEY,
  isAccent,
  readStoredAccent,
  writeStoredAccent,
} from "../accent";

const store = (value: string | null) => ({ getItem: jest.fn(() => value) });

it("starts on classic, so choosing nothing changes nothing", () => {
  expect(readStoredAccent(store(null))).toBe("classic");
  expect(readStoredAccent(null)).toBe("classic");
});

it("reads a stored choice back", () => {
  expect(readStoredAccent(store("violet"))).toBe("violet");
});

it("refuses anything it does not recognise rather than trusting it", () => {
  // A stale key from an older build, or the orange the design offers and this
  // app deliberately does not.
  expect(readStoredAccent(store("orange"))).toBe("classic");
  expect(isAccent("orange")).toBe(false);
});

it("survives storage that throws", () => {
  const throwing = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };

  expect(readStoredAccent(throwing)).toBe("classic");
  expect(() => writeStoredAccent(throwing, "mint")).not.toThrow();
});

it("writes under its own namespaced key", () => {
  const setItem = jest.fn();
  writeStoredAccent({ setItem }, "azure");

  expect(setItem).toHaveBeenCalledWith(ACCENT_STORAGE_KEY, "azure");
  expect(ACCENT_STORAGE_KEY).toMatch(/^projectmc\./);
});

it("offers classic first", () => {
  expect(ACCENTS[0]).toBe("classic");
});
