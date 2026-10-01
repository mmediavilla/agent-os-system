import { WeatherDay, WeatherHour } from "../api";
import { clock, dayName, strip, weatherKind, week } from "../weather";

/** 15:20 on Friday 11 September, local. */
const NOW = new Date(2026, 8, 11, 15, 20);

function hour(time: string, extra: Partial<WeatherHour> = {}): WeatherHour {
  return {
    time,
    condition: "Clear",
    weather_code: 0,
    is_day: true,
    temperature_c: 28,
    precipitation_chance: 0,
    ...extra,
  };
}

function day(date: string): WeatherDay {
  return {
    date,
    condition: "Clear",
    weather_code: 0,
    high_c: 31,
    low_c: 25,
    precipitation_chance: 0,
    precipitation_mm: 0,
    wind_max_kph: 10,
    uv_index: 9,
    sunrise: `${date}T05:43:00`,
    sunset: `${date}T18:01:00`,
  };
}

describe("weatherKind", () => {
  it("groups the WMO codes the way the server groups the words", () => {
    expect(weatherKind(0)).toBe("clear");
    expect(weatherKind(1)).toBe("clear");
    expect(weatherKind(2)).toBe("partly");
    expect(weatherKind(3)).toBe("cloud");
    expect(weatherKind(48)).toBe("fog");
    expect(weatherKind(56)).toBe("rain");
    expect(weatherKind(81)).toBe("rain");
    expect(weatherKind(75)).toBe("snow");
    expect(weatherKind(86)).toBe("snow");
    expect(weatherKind(99)).toBe("storm");
  });

  it("draws a cloud for no code, never a sun it cannot vouch for", () => {
    expect(weatherKind(null)).toBe("cloud");
    expect(weatherKind(undefined)).toBe("cloud");
    expect(weatherKind(4)).toBe("cloud");
  });
});

describe("strip", () => {
  const hours = Array.from({ length: 30 }, (_, i) => {
    const at = new Date(2026, 8, 11, 12 + i);
    const pad = (n: number) => String(n).padStart(2, "0");

    return hour(`${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:00:00`);
  });

  it("starts at the hour in progress, not the first the server sent", () => {
    // The server's list is as old as its cache; at 15:20 a strip that opened
    // on 12:00 would be three hours of the past.
    expect(strip(hours, NOW)[0].time).toBe("2026-09-11T15:00:00");
  });

  it("takes every third hour, six of them", () => {
    expect(strip(hours, NOW).map((h) => h.time.slice(11, 16))).toEqual([
      "15:00",
      "18:00",
      "21:00",
      "00:00",
      "03:00",
      "06:00",
    ]);
  });

  it("reads the wall clock rather than trusting a zone", () => {
    // Not a Date parse: a `Z` on the end would otherwise move every hour.
    expect(strip([hour("2026-09-11T15:00:00Z")], NOW)).toHaveLength(1);
  });
});

describe("clock", () => {
  it("is the digits that were written", () => {
    expect(clock("2026-09-11T05:43:00")).toBe("05:43");
    expect(clock(null)).toBe("—");
  });
});

describe("dayName", () => {
  it("names today and tomorrow, and gives the rest a weekday", () => {
    expect(dayName("2026-09-11", NOW)).toBe("Today");
    expect(dayName("2026-09-12", NOW)).toBe("Tmrw");
    expect(dayName("2026-09-13", NOW)).toBe(
      new Date(2026, 8, 13).toLocaleDateString(undefined, { weekday: "short" }),
    );
  });
});

describe("week", () => {
  it("drops a day the cache still holds from yesterday", () => {
    // Read at 23:55 and shown at 00:05, the first row would be yesterday.
    expect(week([day("2026-09-10"), day("2026-09-11"), day("2026-09-12")], NOW).map((d) => d.date)).toEqual([
      "2026-09-11",
      "2026-09-12",
    ]);
  });
});
