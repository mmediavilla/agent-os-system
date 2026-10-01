import { CalendarEvent, CalendarFeed } from "./api";
import * as fmt from "./hudFormat";

/**
 * The calendar's dates and strings, as pure functions.
 *
 * They are in their own file for the reason `hudFormat` is: every one of these
 * has a boundary that only bites on a real day at an awkward moment — midnight,
 * an all-day event whose end is the next day's midnight, a trip that started
 * last week. None of those is worth finding out about by looking at the agenda.
 *
 * **Everything here is wall clock.** The API returns `"2026-09-10T15:00:00"`
 * with no offset and no `Z`, because the server runs on UTC and the person
 * reading the screen does not (see `CalendarEvent`). `parse` below therefore
 * reads the digits rather than handing the string to `new Date()`: a stray `Z`
 * from a future refactor would move every appointment eight hours, silently,
 * and the point of this whole layer is that it cannot.
 *
 * The week grid and the month picker that used to live here went with the
 * calendar drawer in 10.2. What is left serves one panel.
 */

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;

/**
 * An API timestamp as a local `Date`, or null if it is not one.
 *
 * Built component by component, so the result carries the hour that was
 * written no matter what the string claims about its zone.
 */
export function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;

  const m = WALL_CLOCK.exec(iso);
  if (!m) return null;

  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0),
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A `Date` as the API's date, on the *local* calendar rather than UTC's. */
export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A `Date` as the API's time-of-day. */
export function localTime(d: Date = new Date()): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `n` days from a `YYYY-MM-DD`, which is how the agenda asks for "the next week". */
export function shiftDate(date: string, days: number): string {
  const at = parse(date);
  if (!at) return date;

  at.setDate(at.getDate() + days);

  return localDate(at);
}

/** The date half of an event's start. */
export function dateOf(event: CalendarEvent): string {
  return event.starts_at.slice(0, 10);
}

/**
 * The last day an event occupies.
 *
 * **The end is exclusive**, as iCalendar has it, and that is the whole reason
 * this function exists: an all-day event on the 12th ends at midnight starting
 * the 13th, and so does a party that runs until the stroke of twelve. Reading
 * the end's date naively puts both on a day they never touch. Anything ending
 * later than midnight does occupy the day it ends on — a flight landing at
 * 01:30 is on that day.
 */
export function lastDate(event: CalendarEvent): string {
  const start = dateOf(event);
  const end = parse(event.ends_at);
  if (!end) return start;

  const midnight = end.getHours() === 0 && end.getMinutes() === 0 && end.getSeconds() === 0;
  const last = midnight ? shiftDate(localDate(end), -1) : localDate(end);

  return last < start ? start : last;
}

/** Whether an event is on a given day at all — started then, ends then, or spans it. */
export function onDay(event: CalendarEvent, date: string): boolean {
  return dateOf(event) <= date && date <= lastDate(event);
}

/**
 * The same day in the width an agenda row's date column has — six characters of monospace.
 *
 * A label shares a row with the thing it dates, and a name that wraps says less
 * than a date that does not.
 */
export function shortDayLabel(date: string, now: Date = new Date()): string {
  const at = parse(date);
  if (!at) return "—";

  const today = localDate(now);
  if (date === today) return "Today";
  if (date === shiftDate(today, 1)) return "Tmrw";
  if (date === shiftDate(today, -1)) return "Yest.";

  return at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The time column of a row on today's list.
 *
 * All day says so instead of showing the midnight it is stored at. An event
 * that began on an earlier day does not show its start either — that hour was
 * yesterday's, and "22:00" beside something you are in the middle of reads as
 * tonight. It shows when it lets go (`→10:30`), or, if it outlasts today, that
 * it takes the whole of it.
 */
export function startLabel(event: CalendarEvent, now: Date = new Date()): string {
  const start = parse(event.starts_at);
  if (event.all_day || !start) return "All day";

  const today = localDate(now);
  if (dateOf(event) >= today) return localTime(start);

  const end = parse(event.ends_at);

  return end && lastDate(event) === today ? `→${localTime(end)}` : "All day";
}

/**
 * Whether an event has already finished.
 *
 * Measured against its *end* where it has one, so the meeting you are sitting
 * in does not drop off the panel halfway through. An all-day event lasts until
 * the end of its last day.
 */
export function isOver(event: CalendarEvent, now: Date = new Date()): boolean {
  const start = parse(event.starts_at);
  if (!start) return false;

  if (event.all_day) return lastDate(event) < localDate(now);

  const end = parse(event.ends_at) ?? start;

  return end.getTime() < now.getTime();
}

/**
 * The agenda's split: what is left of today, and what is coming after it.
 *
 * **Today is everything *on* today, not everything that starts today.** A Google
 * calendar is full of spans — a trip, a conference, someone's leave — and the
 * window the panel asks for includes one that began last week because it
 * overlaps this one. Keying on the start date would drop it from today and
 * never list it anywhere.
 *
 * All-day first, then by start, which is how Google lays out a day: the things
 * that frame it above the things that happen in it.
 *
 * Today's finished events are dropped rather than struck through. A panel four
 * rows tall that spends two of them on things you have already done is a panel
 * that stops being read by lunchtime — Google Calendar is where the whole day
 * lives, one click away.
 */
export function agenda(
  events: CalendarEvent[],
  now: Date = new Date(),
): { today: CalendarEvent[]; upcoming: CalendarEvent[] } {
  const today = localDate(now);

  const todays = events
    .filter((e) => onDay(e, today) && !isOver(e, now))
    .sort((a, b) => Number(b.all_day) - Number(a.all_day) || a.starts_at.localeCompare(b.starts_at));

  return { today: todays, upcoming: events.filter((e) => dateOf(e) > today) };
}

/**
 * Today's all-day events: the holiday, the birthday, the day of the trip.
 *
 * Pulled up to the top of the panel rather than left as rows among the day's
 * meetings, at the owner's request. They frame the day, and a row that says "All day"
 * in the time column reads as the least urgent thing on the list when it is
 * often the thing the day is about. Spans that merely *outlast* today are not
 * in here: those are timed events, and they stay in the list with `→10:30`.
 */
export function allDayToday(events: CalendarEvent[], now: Date = new Date()): CalendarEvent[] {
  const today = localDate(now);

  return events.filter((e) => e.all_day && onDay(e, today) && !isOver(e, now));
}

/**
 * The next thing that *starts*.
 *
 * An all-day event counts from the midnight it begins, so today's never
 * qualifies (it has begun, and it is at the top of the panel anyway) while
 * tomorrow's does, once nothing timed is left before it. Late in the evening
 * that makes tomorrow's holiday the next thing, which it is. The list arrives
 * soonest-first, so the first event still in the future is the answer.
 */
export function nextUp(events: CalendarEvent[], now: Date = new Date()): CalendarEvent | null {
  return (
    events.find((e) => {
      const start = parse(e.starts_at);
      return start !== null && start.getTime() > now.getTime();
    }) ?? null
  );
}

/**
 * How far away an event's start is, in the fewest characters that are true.
 *
 * Minutes, then hours and minutes, then — past a day, where a countdown stops
 * being the useful figure — the day and the hour. An all-day event gets the
 * day alone: "in 2h" for a birthday is a countdown to midnight.
 */
export function untilLabel(event: CalendarEvent, now: Date = new Date()): string {
  const start = parse(event.starts_at);
  if (!start) return "—";

  if (event.all_day) return shortDayLabel(dateOf(event), now);

  const minutes = Math.ceil((start.getTime() - now.getTime()) / 60_000);

  if (minutes < 60) return `in ${Math.max(1, minutes)}m`;

  if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `in ${h}h ${m}m` : `in ${h}h`;
  }

  return `${shortDayLabel(dateOf(event), now)} ${localTime(start)}`;
}

// ── Feeds ────────────────────────────────────────────────────────────────────

/** What to call a calendar whose feed did not name itself. */
export function feedName(feed: Pick<CalendarFeed, "name">): string {
  return feed.name?.trim() || "Untitled calendar";
}

/**
 * The line a calendar that could not be read gets on the panel.
 *
 * **An unreachable calendar is not a free day**, and this is where that is
 * said. The server keeps a failed feed's last reading, so its events are still
 * in the list — but a feed that has *never* been read contributes nothing, and
 * an empty afternoon beside it would be a lie by omission.
 *
 * The provider's own error is never quoted: it names the address, which is the
 * secret. The server writes its own sentence, and Settings is where it is shown.
 */
export function feedWarning(feed: CalendarFeed, now: Date = new Date()): string | null {
  if (feed.status !== "failed") return null;

  const read = feed.fetched_at ? Date.parse(feed.fetched_at) : NaN;

  if (Number.isNaN(read)) return `${feedName(feed)} is unreachable and has never been read.`;

  return `${feedName(feed)} is unreachable — showing what it said ${fmt.age((now.getTime() - read) / 1000)}.`;
}
