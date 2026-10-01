import { CalendarEvent, CalendarFeed } from "../api";
import * as cal from "../calendar";

/**
 * The calendar's pure layer.
 *
 * The wall-clock rule is what most of this file is about, and it is worth
 * asserting rather than reading: the failure it guards against renders
 * perfectly, reports nothing, and is simply eight hours out. The rest is the
 * shape Google feeds actually have — spans that began last week, all-day
 * events whose end is the next day's midnight — which the app's own table,
 * with its one-line reminders, never produced.
 */

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    calendar_id: 1,
    title: "Dentist",
    starts_at: "2026-09-10T15:00:00",
    ends_at: null,
    all_day: false,
    location: null,
    ...overrides,
  };
}

/** One all-day event per date, as Google writes them: the end is the next midnight. */
function allDay(from: string, toExclusive: string, title = "Leave"): CalendarEvent {
  return event({ title, all_day: true, starts_at: `${from}T00:00:00`, ends_at: `${toExclusive}T00:00:00` });
}

function feed(overrides: Partial<CalendarFeed> = {}): CalendarFeed {
  return {
    id: 1,
    name: "Work",
    color: "peacock",
    enabled: true,
    status: "ok",
    message: null,
    fetched_at: "2026-09-10T03:00:00+00:00",
    skipped: 0,
    ...overrides,
  };
}

describe("parse", () => {
  it("reads the hour that was written", () => {
    const at = cal.parse("2026-09-10T15:00:00");

    expect(at?.getFullYear()).toBe(2026);
    expect(at?.getMonth()).toBe(8);
    expect(at?.getDate()).toBe(10);
    expect(at?.getHours()).toBe(15);
  });

  it("ignores a zone the string has no business carrying", () => {
    // The one failure this whole layer exists to prevent. `new Date()` would
    // read this as UTC and hand back 23:00 in Manila; the digits are the truth.
    expect(cal.parse("2026-09-10T15:00:00Z")?.getHours()).toBe(15);
  });

  it("accepts a bare date and a space separator", () => {
    expect(cal.parse("2026-09-10")?.getHours()).toBe(0);
    expect(cal.parse("2026-09-10 15:00:00")?.getHours()).toBe(15);
  });

  it("is null for anything it cannot read", () => {
    expect(cal.parse(null)).toBeNull();
    expect(cal.parse("")).toBeNull();
    expect(cal.parse("next Tuesday")).toBeNull();
  });
});

describe("localDate and shiftDate", () => {
  it("uses the local calendar rather than UTC's", () => {
    // 00:30 on the 10th is still the 10th, whatever UTC thinks of it.
    expect(cal.localDate(new Date(2026, 8, 10, 0, 30))).toBe("2026-09-10");
  });

  it("crosses a month boundary in both directions", () => {
    expect(cal.shiftDate("2026-08-31", 1)).toBe("2026-09-01");
    expect(cal.shiftDate("2026-09-01", -1)).toBe("2026-08-31");
  });

  it("crosses a year boundary", () => {
    expect(cal.shiftDate("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("lastDate and onDay", () => {
  it("reads an all-day end as exclusive, the way iCalendar writes it", () => {
    // A one-day event on the 12th ends at midnight starting the 13th. Reading
    // that date naively would put it on two days.
    expect(cal.lastDate(allDay("2026-09-12", "2026-09-13"))).toBe("2026-09-12");
    expect(cal.lastDate(allDay("2026-09-07", "2026-09-12"))).toBe("2026-09-11");
  });

  it("treats a timed event ending on the stroke of midnight the same way", () => {
    const party = event({ starts_at: "2026-09-10T20:00:00", ends_at: "2026-09-11T00:00:00" });

    expect(cal.lastDate(party)).toBe("2026-09-10");
  });

  it("puts an event ending after midnight on the day it ends", () => {
    const redEye = event({ starts_at: "2026-09-10T22:00:00", ends_at: "2026-09-11T01:30:00" });

    expect(cal.lastDate(redEye)).toBe("2026-09-11");
    expect(cal.onDay(redEye, "2026-09-11")).toBe(true);
  });

  it("is the start date for a moment with no end", () => {
    expect(cal.lastDate(event())).toBe("2026-09-10");
  });

  it("finds a span on every day it covers, and on none outside it", () => {
    const trip = allDay("2026-09-07", "2026-09-12");

    expect(cal.onDay(trip, "2026-09-06")).toBe(false);
    expect(cal.onDay(trip, "2026-09-07")).toBe(true);
    expect(cal.onDay(trip, "2026-09-10")).toBe(true);
    expect(cal.onDay(trip, "2026-09-11")).toBe(true);
    expect(cal.onDay(trip, "2026-09-12")).toBe(false);
  });
});

describe("labels", () => {
  const now = new Date(2026, 8, 10, 12, 0);

  it("keeps the short label inside a rail column", () => {
    expect(cal.shortDayLabel("2026-09-10", now)).toBe("Today");
    expect(cal.shortDayLabel("2026-09-11", now)).toBe("Tmrw");
    expect(cal.shortDayLabel("2026-09-09", now)).toBe("Yest.");
    expect(cal.shortDayLabel("2026-09-15", now).length).toBeLessThanOrEqual(7);
  });

  it("says All day instead of the midnight an all-day event is stored at", () => {
    // The time is an artefact of the row, not something anybody chose.
    expect(cal.startLabel(allDay("2026-09-10", "2026-09-11"), now)).toBe("All day");
  });

  it("gives a timed event its start", () => {
    expect(cal.startLabel(event(), now)).toBe("15:00");
  });

  it("shows when a carried-over event lets go, not the hour it began yesterday", () => {
    // "22:00" beside something you are in the middle of reads as tonight.
    const overnight = event({ starts_at: "2026-09-09T22:00:00", ends_at: "2026-09-10T13:30:00" });

    expect(cal.startLabel(overnight, now)).toBe("→13:30");
  });

  it("calls a timed span that outlasts today all day, which it is", () => {
    const conference = event({ starts_at: "2026-09-09T09:00:00", ends_at: "2026-09-11T17:00:00" });

    expect(cal.startLabel(conference, now)).toBe("All day");
  });
});

describe("isOver", () => {
  it("counts an event as running until its end, not from its start", () => {
    const now = new Date(2026, 8, 10, 15, 30);

    // You are sitting in this meeting. It must not drop off halfway through.
    expect(cal.isOver(event({ ends_at: "2026-09-10T16:00:00" }), now)).toBe(false);
    expect(cal.isOver(event({ ends_at: "2026-09-10T15:15:00" }), now)).toBe(true);
  });

  it("treats an event with no end as over the moment it starts", () => {
    expect(cal.isOver(event(), new Date(2026, 8, 10, 15, 1))).toBe(true);
  });

  it("gives an all-day event its whole day, and not the one its end is dated", () => {
    const day = allDay("2026-09-10", "2026-09-11");

    expect(cal.isOver(day, new Date(2026, 8, 10, 23, 59))).toBe(false);
    expect(cal.isOver(day, new Date(2026, 8, 11, 0, 1))).toBe(true);
  });

  it("keeps a multi-day all-day event until its last day is done", () => {
    const trip = allDay("2026-09-07", "2026-09-12");

    expect(cal.isOver(trip, new Date(2026, 8, 11, 20, 0))).toBe(false);
    expect(cal.isOver(trip, new Date(2026, 8, 12, 8, 0))).toBe(true);
  });
});

describe("agenda", () => {
  const now = new Date(2026, 8, 10, 12, 0);

  it("splits today's remainder from what is coming", () => {
    const { today, upcoming } = cal.agenda(
      [
        event({ starts_at: "2026-09-10T09:00:00", title: "Done" }),
        event({ starts_at: "2026-09-10T15:00:00", title: "Dentist" }),
        event({ starts_at: "2026-09-12T09:00:00", title: "Flight" }),
      ],
      now,
    );

    expect(today.map((e) => e.title)).toEqual(["Dentist"]);
    expect(upcoming.map((e) => e.title)).toEqual(["Flight"]);
  });

  it("counts something that began last week as today's, because it is", () => {
    // The window includes a span that overlaps it. Keyed on the start date it
    // would be on no list at all.
    const { today, upcoming } = cal.agenda([allDay("2026-09-07", "2026-09-12", "Leave")], now);

    expect(today.map((e) => e.title)).toEqual(["Leave"]);
    expect(upcoming).toEqual([]);
  });

  it("puts the day's all-day events above the things that happen in it", () => {
    const { today } = cal.agenda(
      [
        // Soonest first, as the API sends them — the overnight flight began
        // yesterday, so it sorts ahead of everything.
        event({ starts_at: "2026-09-09T22:00:00", ends_at: "2026-09-10T13:00:00", title: "Flight" }),
        allDay("2026-09-10", "2026-09-11", "Birthday"),
        event({ starts_at: "2026-09-10T15:00:00", title: "Dentist" }),
      ],
      now,
    );

    expect(today.map((e) => e.title)).toEqual(["Birthday", "Flight", "Dentist"]);
  });

  it("never counts a past day as upcoming", () => {
    const { today, upcoming } = cal.agenda([event({ starts_at: "2026-09-01T09:00:00" })], now);

    expect(today).toEqual([]);
    expect(upcoming).toEqual([]);
  });
});

describe("allDayToday", () => {
  const now = new Date(2026, 8, 10, 12, 0);

  it("is today's all-day events, including one that began days ago", () => {
    const events = [
      allDay("2026-09-07", "2026-09-12", "Leave"),
      allDay("2026-09-10", "2026-09-11", "Birthday"),
      allDay("2026-09-11", "2026-09-12", "Tomorrow's holiday"),
      allDay("2026-09-09", "2026-09-10", "Yesterday's holiday"),
      // A timed span that outlasts today is not all-day: it stays in the list.
      event({ starts_at: "2026-09-09T22:00:00", ends_at: "2026-09-11T08:00:00", title: "Conference" }),
    ];

    expect(cal.allDayToday(events, now).map((e) => e.title)).toEqual(["Leave", "Birthday"]);
  });
});

describe("nextUp and untilLabel", () => {
  const now = new Date(2026, 8, 10, 12, 0);

  it("is the first timed event that has not started yet", () => {
    const next = cal.nextUp(
      [
        allDay("2026-09-10", "2026-09-11", "Birthday"),
        event({ starts_at: "2026-09-10T11:00:00", ends_at: "2026-09-10T13:00:00", title: "Running" }),
        event({ starts_at: "2026-09-10T12:40:00", title: "Call" }),
        event({ starts_at: "2026-09-10T15:00:00", title: "Dentist" }),
      ],
      now,
    );

    // Not the birthday (no moment to count to) and not the meeting you are in.
    expect(next?.title).toBe("Call");
  });

  it("makes tomorrow's all-day event next once nothing timed comes first", () => {
    const holiday = allDay("2026-09-11", "2026-09-12", "Rosh Hashanah");

    // Nothing left today: the holiday at tomorrow's midnight is the next thing.
    expect(cal.nextUp([holiday, event({ starts_at: "2026-09-11T09:00:00", title: "Standup" })], now)?.title).toBe(
      "Rosh Hashanah",
    );

    // Something still to come today wins, because it comes first.
    expect(cal.nextUp([event({ starts_at: "2026-09-10T15:00:00", title: "Dentist" }), holiday], now)?.title).toBe(
      "Dentist",
    );
  });

  it("gives an all-day event its day rather than a countdown to midnight", () => {
    expect(cal.untilLabel(allDay("2026-09-11", "2026-09-12"), now)).toBe("Tmrw");
  });

  it("is null when nothing is left to start", () => {
    expect(cal.nextUp([event({ starts_at: "2026-09-10T09:00:00" })], now)).toBeNull();
  });

  it("counts down in minutes, then hours and minutes", () => {
    expect(cal.untilLabel(event({ starts_at: "2026-09-10T12:40:00" }), now)).toBe("in 40m");
    expect(cal.untilLabel(event({ starts_at: "2026-09-10T12:00:20" }), now)).toBe("in 1m");
    expect(cal.untilLabel(event({ starts_at: "2026-09-10T15:00:00" }), now)).toBe("in 3h");
    expect(cal.untilLabel(event({ starts_at: "2026-09-10T15:25:00" }), now)).toBe("in 3h 25m");
  });

  it("names the day and hour once a countdown stops being the useful figure", () => {
    expect(cal.untilLabel(event({ starts_at: "2026-09-11T14:00:00" }), now)).toBe("Tmrw 14:00");
  });
});

describe("feeds", () => {
  const now = new Date("2026-09-10T05:00:00+00:00");

  it("names a calendar that did not name itself", () => {
    expect(cal.feedName({ name: null })).toBe("Untitled calendar");
    expect(cal.feedName({ name: "  " })).toBe("Untitled calendar");
    expect(cal.feedName({ name: "Work" })).toBe("Work");
  });

  it("says nothing about a calendar that is fine", () => {
    expect(cal.feedWarning(feed(), now)).toBeNull();
    expect(cal.feedWarning(feed({ status: "pending", fetched_at: null }), now)).toBeNull();
  });

  it("says how old an unreachable calendar's events are", () => {
    // They are still in the list — the server keeps the last reading — so the
    // line is about trusting them, not about their absence.
    expect(cal.feedWarning(feed({ status: "failed" }), now)).toBe(
      "Work is unreachable — showing what it said 2h ago.",
    );
  });

  it("says so plainly when an unreachable calendar has nothing to show", () => {
    // The case that matters: an empty afternoon beside this is not a free one.
    expect(cal.feedWarning(feed({ status: "failed", fetched_at: null }), now)).toBe(
      "Work is unreachable and has never been read.",
    );
  });

  it("never quotes the server's message, which is Settings' to show", () => {
    const warning = cal.feedWarning(feed({ status: "failed", message: "Google answered 500." }), now);

    expect(warning).not.toContain("500");
  });
});
