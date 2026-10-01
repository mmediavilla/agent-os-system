import {
  DEFAULT_UNITS,
  UNITS_STORAGE_KEY,
  UnitPrefs,
  displayValue,
  fmtUnitValue,
  fromCanonical,
  isUnitFor,
  readStoredUnits,
  storedValue,
  toCanonical,
  writeStoredUnits,
} from "../units";

describe("toCanonical / fromCanonical", () => {
  it("leaves the canonical units alone", () => {
    expect(toCanonical(102.5, "kg")).toBe(102.5);
    expect(fromCanonical(102.5, "kg")).toBe(102.5);
    expect(toCanonical(5, "km")).toBe(5);
    expect(fromCanonical(91, "cm")).toBe(91);
  });

  it("converts each imperial unit", () => {
    expect(toCanonical(225, "lb")).toBeCloseTo(102.058, 3);
    expect(fromCanonical(100, "lb")).toBeCloseTo(220.462, 3);
    expect(toCanonical(1, "mi")).toBeCloseTo(1.609344, 6);
    expect(fromCanonical(5, "mi")).toBeCloseTo(3.10686, 5);
    expect(toCanonical(36, "in")).toBeCloseTo(91.44, 2);
    expect(fromCanonical(91.44, "in")).toBeCloseTo(36, 6);
  });

  it("round-trips within display precision", () => {
    // The known cost of editing in a non-canonical unit: one decimal of
    // pounds is ~0.02kg, well under what anyone logs to.
    const back = toCanonical(Number(fromCanonical(100, "lb").toFixed(1)), "lb");
    expect(back).toBeCloseTo(100, 1);
  });
});

describe("fmtUnitValue", () => {
  it("drops a trailing zero so unconverted values look untouched", () => {
    expect(fmtUnitValue(100)).toBe("100");
    expect(fmtUnitValue(102.5)).toBe("102.5");
  });

  it("rounds to one decimal", () => {
    expect(fmtUnitValue(220.46226)).toBe("220.5");
  });
});

describe("displayValue", () => {
  it("returns an empty string for a missing value", () => {
    expect(displayValue(null, "kg")).toBe("");
    expect(displayValue(undefined, "lb")).toBe("");
  });

  it("keeps a zero, which is a value and not a blank", () => {
    expect(displayValue(0, "lb")).toBe("0");
  });

  it("converts into the display unit", () => {
    expect(displayValue(100, "kg")).toBe("100");
    expect(displayValue(100, "lb")).toBe("220.5");
    expect(displayValue(5, "mi")).toBe("3.1");
  });
});

describe("storedValue", () => {
  it("passes undefined straight through, so a blank input stays blank", () => {
    expect(storedValue(undefined, "lb")).toBeUndefined();
  });

  it("converts back to the canonical unit", () => {
    expect(storedValue(225, "lb")).toBe(102.058);
    expect(storedValue(100, "kg")).toBe(100);
  });

  it("trims the conversion tail rather than storing it", () => {
    // 225lb is 102.05828325kg exactly; nobody typed those digits.
    expect(String(storedValue(225, "lb"))).toHaveLength(7);
  });
});

describe("isUnitFor", () => {
  it("accepts only the units of its own dimension", () => {
    expect(isUnitFor("weight", "lb")).toBe(true);
    expect(isUnitFor("weight", "mi")).toBe(false);
    expect(isUnitFor("distance", "km")).toBe(true);
    expect(isUnitFor("measurement", "in")).toBe(true);
    expect(isUnitFor("measurement", 42)).toBe(false);
  });
});

describe("readStoredUnits", () => {
  const storageOf = (value: string | null) => ({ getItem: () => value });

  it("defaults to the canonical units with no storage at all", () => {
    expect(readStoredUnits(null)).toEqual(DEFAULT_UNITS);
    expect(readStoredUnits(storageOf(null))).toEqual(DEFAULT_UNITS);
  });

  it("reads back what was written", () => {
    const units: UnitPrefs = { weight: "lb", distance: "mi", measurement: "in" };
    expect(readStoredUnits(storageOf(JSON.stringify(units)))).toEqual(units);
  });

  it("keeps the dimensions it recognises and defaults the rest", () => {
    // A value written by a build that only knew about weight shouldn't cost
    // the user their weight choice.
    expect(readStoredUnits(storageOf(JSON.stringify({ weight: "lb" })))).toEqual({
      weight: "lb",
      distance: "km",
      measurement: "cm",
    });
  });

  it("rejects a unit from the wrong dimension", () => {
    expect(readStoredUnits(storageOf(JSON.stringify({ weight: "mi" }))).weight).toBe("kg");
  });

  it("falls back on unparseable or non-object JSON", () => {
    expect(readStoredUnits(storageOf("not json"))).toEqual(DEFAULT_UNITS);
    expect(readStoredUnits(storageOf('"lb"'))).toEqual(DEFAULT_UNITS);
    expect(readStoredUnits(storageOf("null"))).toEqual(DEFAULT_UNITS);
  });

  it("falls back when storage throws", () => {
    // Safari private mode. Not worth failing to boot over.
    const hostile = {
      getItem() {
        throw new Error("denied");
      },
    };
    expect(readStoredUnits(hostile)).toEqual(DEFAULT_UNITS);
  });
});

describe("writeStoredUnits", () => {
  it("writes all three under one key", () => {
    const written: Record<string, string> = {};
    writeStoredUnits({ setItem: (k, v) => { written[k] = v; } }, {
      weight: "lb",
      distance: "km",
      measurement: "in",
    });

    expect(JSON.parse(written[UNITS_STORAGE_KEY])).toEqual({
      weight: "lb",
      distance: "km",
      measurement: "in",
    });
  });

  it("swallows storage failures instead of breaking the setting", () => {
    const hostile = {
      setItem() {
        throw new Error("quota");
      },
    };
    expect(() => writeStoredUnits(hostile, DEFAULT_UNITS)).not.toThrow();
    expect(() => writeStoredUnits(null, DEFAULT_UNITS)).not.toThrow();
  });
});
