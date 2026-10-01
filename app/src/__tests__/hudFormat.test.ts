import * as fmt from "../hudFormat";

/**
 * The strings the HUD's panels and cards have room for.
 *
 * Every one of these has a boundary that only shows up on a real machine at an
 * awkward moment — a two-terabyte disk, a sample that has never been taken, a
 * nudge written at four in the morning. Discovering them by looking at the
 * screen is discovering them once the screen matters.
 */

describe("sizes", () => {
  it("picks the unit once per gauge, from the total", () => {
    // "19.8 / 32 GB" is one measurement; "19.8 GB / 32 GB" is two numbers that
    // happen to be next to each other.
    expect(
      fmt.gauge({ used_bytes: 21_260_000_000, total_bytes: 34_000_000_000, percent: 62.5 }),
    ).toBe("19.8 / 31.7 GB");
  });

  it("keeps a nearly-full small partition in the total's unit", () => {
    // Not "972 MB / 1 GB": the used side is scaled by the total, always.
    expect(
      fmt.gauge({ used_bytes: 1_020_000_000, total_bytes: 1_073_741_824, percent: 95 }),
    ).toBe("0.9 / 1 GB");
  });

  it("drops the decimal past a hundred", () => {
    // "1023 MB" is easier to place at a glance than "1023.4 MB", and the extra
    // digit is never the thing being read.
    expect(fmt.bytes(1_072_693_248)).toBe("1023 MB");
    expect(fmt.bytes(18_874_368)).toBe("18 MB");
  });

  it("has an answer for nothing at all", () => {
    expect(fmt.bytes(null)).toBe("—");
    expect(fmt.bytes(0)).toBe("0 B");
    expect(fmt.gauge(null)).toBe("—");
  });
});

describe("ages", () => {
  it("counts in the largest unit that is still true", () => {
    expect(fmt.age(4)).toBe("4s ago");
    expect(fmt.age(90)).toBe("2m ago");
    expect(fmt.age(7_200)).toBe("2h ago");
    expect(fmt.age(200_000)).toBe("2d ago");
  });

  it("says never rather than now when nothing has been sampled", () => {
    // The machine sample is taken on a queue worker, so before the first one
    // lands there is genuinely nothing to age — and "0s ago" is the one wrong
    // answer available.
    expect(fmt.age(null)).toBe("never");
    expect(fmt.age(undefined)).toBe("never");
  });

  it("calls a sample stale once nothing could plausibly be servicing the queue", () => {
    // The endpoint asks for a new one every ten seconds.
    expect(fmt.isStale(4)).toBe(false);
    expect(fmt.isStale(59)).toBe(false);
    expect(fmt.isStale(300)).toBe(true);
    expect(fmt.isStale(null)).toBe(true);
  });
});

describe("small readouts", () => {
  it("rounds, because a HUD has no room for 28.6°", () => {
    expect(fmt.degrees(28.6)).toBe("29°");
    expect(fmt.percent(62.5)).toBe("63%");
  });

  it("says nothing rather than zero when there is no reading", () => {
    expect(fmt.degrees(null)).toBe("—");
    expect(fmt.percent(undefined)).toBe("—");
  });
});

describe("counts", () => {
  it("groups thousands, and draws nothing as a dash rather than a zero", () => {
    expect(fmt.count(1_204_551)).toBe("1,204,551");
    expect(fmt.count(0)).toBe("0");
    expect(fmt.count(null)).toBe("—");
  });

  it("formats dollars to the cent, and never calls a real spend $0.00", () => {
    expect(fmt.usd(1234.5)).toBe("$1,234.50");
    expect(fmt.usd(0)).toBe("$0.00");
    expect(fmt.usd(0.004)).toBe("<$0.01");
    expect(fmt.usd(0.005)).toBe("$0.01");
    expect(fmt.usd(null)).toBe("—");
  });
});
