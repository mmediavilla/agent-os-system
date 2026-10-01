import {
  barPct,
  baselineRange,
  fmtKg,
  fmtWeight,
  fromDayNum,
  heatLevel,
  HEATMAP_STEPS,
  longDate,
  monthTicks,
  scaledPct,
  shortDate,
  toDayNum,
} from "../chartMath";

describe("day numbers", () => {
  it("round-trips an ISO date", () => {
    expect(fromDayNum(toDayNum("2026-01-02")).iso).toBe("2026-01-02");
    expect(fromDayNum(toDayNum("2025-12-31")).iso).toBe("2025-12-31");
  });

  it("counts consecutive days across a year boundary", () => {
    expect(toDayNum("2026-01-01") - toDayNum("2025-12-31")).toBe(1);
    expect(fromDayNum(toDayNum("2025-12-31") + 1).iso).toBe("2026-01-01");
  });

  it("counts consecutive days across a leap day", () => {
    expect(toDayNum("2028-03-01") - toDayNum("2028-02-29")).toBe(1);
    expect(fromDayNum(toDayNum("2028-02-28") + 1).iso).toBe("2028-02-29");
  });

  it("counts a DST transition as exactly one day", () => {
    // Northern-hemisphere spring forward. Local-time arithmetic would make this
    // 23 hours and drop a heatmap column; UTC day numbers cannot.
    expect(toDayNum("2026-03-30") - toDayNum("2026-03-29")).toBe(1);
    expect(toDayNum("2026-11-02") - toDayNum("2026-11-01")).toBe(1);
  });

  it("reports the weekday", () => {
    expect(fromDayNum(toDayNum("2026-01-01")).dow).toBe(4); // Thursday
    expect(fromDayNum(toDayNum("2026-01-05")).dow).toBe(1); // Monday
  });

  it("spans a whole non-leap year", () => {
    expect(toDayNum("2027-01-01") - toDayNum("2026-01-01")).toBe(365);
  });
});

describe("date formatting", () => {
  it("labels a date without touching Intl or the local timezone", () => {
    expect(longDate("2026-01-02")).toBe("Fri 2 January 2026");
    expect(shortDate("2026-04-27")).toBe("27 Apr");
  });
});

describe("monthTicks", () => {
  const jan5 = toDayNum("2026-01-05"); // a Monday

  it("emits one tick per month", () => {
    expect(monthTicks(jan5, 14, 0).map((t) => t.label)).toEqual(["Jan", "Feb", "Mar", "Apr"]);
  });

  it("drops labels that would collide with the previous one", () => {
    const spaced = monthTicks(jan5, 14, 3);
    for (let i = 1; i < spaced.length; i++) {
      expect(spaced[i].col - spaced[i - 1].col).toBeGreaterThanOrEqual(3);
    }
  });

  it("defers a cramped month rather than dropping it from the axis", () => {
    // A grid starting late in August puts September only two columns in, which
    // is too close to label. It should still appear, just a column later.
    const aug18 = toDayNum("2025-08-18");
    const labels = monthTicks(aug18, 12, 3).map((t) => t.label);

    expect(labels).toContain("Sep");
    expect(labels.slice(0, 3)).toEqual(["Aug", "Sep", "Oct"]);
  });

  it("returns nothing for an empty grid", () => {
    expect(monthTicks(jan5, 0)).toEqual([]);
  });
});

describe("heatLevel", () => {
  it("is zero only for a day with no hard sets", () => {
    expect(heatLevel(0)).toBe(0);
    expect(heatLevel(1)).toBe(1);
  });

  it("steps at each threshold boundary", () => {
    const [a, b, c, d] = HEATMAP_STEPS;
    expect(heatLevel(a - 1)).toBe(0);
    expect(heatLevel(a)).toBe(1);
    expect(heatLevel(b - 1)).toBe(1);
    expect(heatLevel(b)).toBe(2);
    expect(heatLevel(c - 1)).toBe(2);
    expect(heatLevel(c)).toBe(3);
    expect(heatLevel(d - 1)).toBe(3);
    expect(heatLevel(d)).toBe(4);
  });

  it("saturates rather than overflowing the ramp", () => {
    expect(heatLevel(9999)).toBe(4);
  });
});

describe("barPct", () => {
  it("scales against the maximum", () => {
    expect(barPct(50, 100)).toBe(50);
    expect(barPct(100, 100)).toBe(100);
  });

  it("keeps a tiny nonzero value visible", () => {
    expect(barPct(0.1, 100)).toBe(2);
  });

  it("renders a genuine zero as nothing, so gaps stay visible", () => {
    expect(barPct(0, 100)).toBe(0);
  });

  it("does not divide by an empty maximum", () => {
    expect(barPct(0, 0)).toBe(0);
    expect(barPct(5, 0)).toBe(0);
    expect(Number.isNaN(barPct(5, 0))).toBe(false);
  });
});

describe("suppressed-zero scaling", () => {
  it("pads the bounds around the data", () => {
    const { lo, hi } = baselineRange([100, 200]);
    expect(lo).toBeCloseTo(92);
    expect(hi).toBeCloseTo(204);
  });

  it("spreads points across the track", () => {
    expect(scaledPct(150, 100, 200)).toBe(50);
    expect(scaledPct(200, 100, 200)).toBe(100);
  });

  it("keeps the lowest point visible as a stub", () => {
    expect(scaledPct(100, 100, 200)).toBe(6);
  });

  it("centres a lift whose estimate never changed", () => {
    expect(scaledPct(120, 120, 120)).toBe(50);
    expect(Number.isNaN(scaledPct(120, 120, 120))).toBe(false);
  });

  it("handles an empty series", () => {
    expect(baselineRange([])).toEqual({ lo: 0, hi: 1 });
  });
});

describe("fmtKg", () => {
  it("switches to tonnes once the numbers get long", () => {
    expect(fmtKg(692064.5)).toBe("692.1t");
    expect(fmtKg(10000)).toBe("10.0t");
  });

  it("keeps smaller loads in kilograms", () => {
    expect(fmtKg(9999)).toBe("9,999kg");
    expect(fmtKg(500)).toBe("500kg");
    expect(fmtKg(0)).toBe("0kg");
  });
});

describe("fmtWeight", () => {
  it("defaults to kilograms, matching fmtKg exactly", () => {
    expect(fmtWeight(9999)).toBe(fmtKg(9999));
    expect(fmtWeight(692064.5)).toBe(fmtKg(692064.5));
  });

  it("converts to pounds when that is the unit", () => {
    expect(fmtWeight(500, "lb")).toBe("1,102lb");
    expect(fmtWeight(100, "lb")).toBe("220lb");
    expect(fmtWeight(0, "lb")).toBe("0lb");
  });

  it("compacts long pound figures with an SI prefix rather than switching unit", () => {
    // There is no customary unit between the pound and the ton worth using,
    // so tonnage stays in pounds and only the digits shorten.
    expect(fmtWeight(5000, "lb")).toBe("11.0klb");
    expect(fmtWeight(692064.5, "lb")).toBe("1.5Mlb");
  });
});
