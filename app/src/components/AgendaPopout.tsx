import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import Panel from "./Panel";
import Popout, { PopoutButton, PopoutClose, popoutStyles } from "./Popout";
import { CalendarEvent, CalendarFeed, CalendarWindow } from "../api";
import * as cal from "../calendar";
import { calendarHex } from "../calendarColors";
import { Polled } from "../polling";
import { colors, radii, spacing, type } from "../theme";

/** How much of today the card lists before it says how many more there are. */
const AGENDA_TODAY = 6;

/** Where `↗` goes. Google Calendar opens on whichever view the user last left it in. */
export const GOOGLE_CALENDAR_URL = "https://calendar.google.com/calendar";

/**
 * The agenda: a button in the HUD's top-right corner, and today's card.
 *
 * It was the top panel of the right rail. When the core became the menu
 * (Phase 11), the owner moved it onto a button where the Settings gear had been, and
 * asked for **today** in the card. The week after today went: "Thu · Flight"
 * three days out is what Google Calendar is for, one `↗` away.
 *
 * **The window is still today and the week after it.** `NEXT` counts down to
 * the next thing that *starts*. Late in the evening that is tomorrow's holiday,
 * labelled "Tmrw", and a window that stopped at midnight could not see it. The
 * server serves every poll from its cache, so the wider window costs nothing.
 *
 * **One list in time order, not a section per calendar.** What this card
 * answers is "what is my day", and a work meeting at ten and a dentist at three
 * are one day. The colour dot says whose it is, and the legend says which colour
 * is which.
 *
 * **The legend is also the feeds' health.** A calendar that could not be read
 * turns amber there, and gets a line saying how old its events are. An
 * afternoon that looks free because a calendar could not be read is the one
 * thing this card must never draw silently.
 *
 * Today's finished events are dropped rather than struck through: a card that
 * spends rows on things already done stops being read by lunchtime.
 */
export default function AgendaPopout({
  calendar,
  now,
  open,
  onToggle,
  onClose,
}: {
  calendar: Polled<CalendarWindow>;
  /** From `useNow`: the countdown and "has this finished?" move on the minute, not the poll. */
  now: Date;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const today = calendar.data ? cal.agenda(calendar.data.events, now).today.length : null;

  return (
    <Popout
      open={open}
      opens="below-end"
      testID="hud-agenda"
      button={
        <PopoutButton
          open={open}
          onPress={onToggle}
          // The count goes into the name, which is not drawn, like the weather's
          // temperature: the button is an icon and nothing else.
          label={buttonLabel(calendar.data, today)}
          testID="hud-agenda"
        >
          {(lit) => <CalendarIcon color={lit ? colors.accentTxt : colors.textMuted} />}
        </PopoutButton>
      }
    >
      <AgendaCard calendar={calendar} now={now} onClose={onClose} />
    </Popout>
  );
}

function buttonLabel(data: CalendarWindow | null, today: number | null): string {
  if (!data || today === null) return "Agenda";
  if (!data.configured) return "Agenda — no calendars connected";
  if (today === 0) return "Agenda — nothing left today";

  return `Agenda — ${today} left today`;
}

function AgendaCard({
  calendar,
  now,
  onClose,
}: {
  calendar: Polled<CalendarWindow>;
  now: Date;
  onClose: () => void;
}) {
  const data = calendar.data;
  const events = data?.events ?? [];
  const feeds = data?.feeds ?? [];

  const { today } = cal.agenda(events, now);
  const next = cal.nextUp(events, now);
  // Above everything else and outside the row cap, so a busy day cannot push
  // the holiday it falls on off the card.
  const allDay = cal.allDayToday(events, now);
  const timed = today.filter((e) => !e.all_day);
  const empty = data ? agendaEmpty(data, today.length) : null;

  const dotOf = (event: CalendarEvent) =>
    calendarHex(feeds.find((f) => f.id === event.calendar_id)?.color);

  const warnings = feeds.map((f) => cal.feedWarning(f, now)).filter((w): w is string => !!w);

  return (
    <Panel
      eyebrow="AGENDA"
      title="Today"
      right={
        <View style={s.head}>
          {today.length > 0 && (
            <View style={s.pill}>
              <Text style={s.pillText}>{today.length}</Text>
            </View>
          )}
          <OpenGoogleCalendar />
          <PopoutClose label="Close the agenda" onPress={onClose} testID="hud-agenda-close" />
        </View>
      }
      corners
      style={popoutStyles.glass}
      testID="panel-agenda"
      footer={feeds.length > 0 ? <CalendarLegend feeds={feeds} /> : undefined}
    >
      {calendar.loading && data === null && <ActivityIndicator color={colors.accent} />}
      {calendar.error && data === null && <Text style={s.empty}>{calendar.error}</Text>}

      {empty && <Text style={s.empty}>{empty}</Text>}

      {allDay.map((event, i) => (
        <AgendaRow
          key={`all-day-${event.calendar_id}-${event.starts_at}-${i}`}
          when="All day"
          title={event.title}
          dot={dotOf(event)}
          highlight
        />
      ))}

      {next && (
        <Text style={s.next} numberOfLines={1} testID="agenda-next">
          NEXT · {cal.untilLabel(next, now)} · {next.title}
        </Text>
      )}

      {timed.slice(0, AGENDA_TODAY).map((event, i) => (
        <AgendaRow
          key={`${event.calendar_id}-${event.starts_at}-${i}`}
          when={cal.startLabel(event, now)}
          title={event.title}
          dot={dotOf(event)}
        />
      ))}

      {timed.length > AGENDA_TODAY && (
        <Text style={s.footNote}>+{timed.length - AGENDA_TODAY} more today</Text>
      )}

      {warnings.map((warning) => (
        <Text key={warning} style={s.footWarn}>
          {warning}
        </Text>
      ))}

      {calendar.error && data !== null && (
        <Text style={s.footWarn}>Couldn't refresh — showing the last reading.</Text>
      )}
    </Panel>
  );
}

/**
 * The one line an agenda with nothing in it says, or null when it has something.
 *
 * Three different empties, because each is fixed somewhere different: nothing
 * connected is fixed in Settings, everything switched off is fixed in Settings
 * *differently*, and an empty day is not a thing to fix at all.
 */
function agendaEmpty(data: CalendarWindow, today: number): string | null {
  if (!data.configured) return "No calendars connected. Add one in Settings.";
  if (data.feeds.length === 0) return "Every calendar is switched off in Settings.";

  return today > 0 ? null : "Nothing left today.";
}

function AgendaRow({
  when,
  title,
  dot,
  highlight = false,
}: {
  when: string;
  title: string;
  dot: string;
  /** Today's all-day events: a tinted band, so they read as the day's frame. */
  highlight?: boolean;
}) {
  return (
    <View style={[s.row, highlight && s.rowAllDay]} testID={highlight ? "agenda-all-day" : undefined}>
      <Text style={s.time}>{when}</Text>
      <View style={[s.dot, { backgroundColor: dot }]} testID="agenda-dot" />
      <Text style={[s.label, highlight && s.labelAllDay]} numberOfLines={1}>
        {title}
      </Text>
    </View>
  );
}

/** Which colour is which calendar and, in amber, which one could not be read. */
function CalendarLegend({ feeds }: { feeds: CalendarFeed[] }) {
  return (
    <View style={s.legend} testID="agenda-legend">
      {feeds.map((feed) => {
        const failed = feed.status === "failed";

        return (
          <View key={feed.id} style={s.legendItem}>
            <View style={[s.dot, { backgroundColor: calendarHex(feed.color) }]} />
            <Text
              style={[s.legendText, failed && s.legendFailed]}
              numberOfLines={1}
              accessibilityLabel={failed ? `${cal.feedName(feed)}, unreachable` : undefined}
            >
              {cal.feedName(feed)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/**
 * `↗`: Google Calendar in a new tab. A click is a user gesture, so the page can
 * open the tab itself, with no server tool and no voice exemption.
 */
function OpenGoogleCalendar() {
  return (
    <Pressable
      onPress={() => window.open?.(GOOGLE_CALENDAR_URL, "_blank", "noopener,noreferrer")}
      accessibilityRole="link"
      accessibilityLabel="Open Google Calendar"
      style={({ hovered }: any) => [s.pill, s.openLink, hovered && s.openLinkHovered]}
      testID="agenda-open-google"
    >
      <Text style={[s.pillText, s.openLinkText]}>↗</Text>
    </Pressable>
  );
}

/**
 * A page of a calendar with two binding rings, stroked in `color`, which is a
 * `var(--c-*)`, so it re-themes inside `data-hud` like the HUD's other icons.
 */
function CalendarIcon({ color }: { color: string }) {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x={3.5} y={5} width={17} height={15.5} rx={2} />
      <path d="M3.5 10h17M8 3v4M16 3v4M8 14h2M14 14h2M8 17h2" />
    </svg>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: spacing.xs },

  pill: {
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  pillText: { ...type.micro, letterSpacing: 1.2, color: colors.accent },
  openLink: { borderColor: colors.border },
  openLinkHovered: { borderColor: colors.accent },
  openLinkText: { color: colors.accentTxt },

  row: { flexDirection: "row", gap: spacing.sm, alignItems: "center" },
  // The accent's own tint, not the calendar's colour (see `dot`). The band
  // bleeds into the gutter by its own padding, so its time column stays in
  // line with the rows under it.
  rowAllDay: {
    backgroundColor: colors.accentBg,
    borderRadius: radii.sm,
    marginHorizontal: -spacing.xs,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
  },
  labelAllDay: { fontWeight: "600" },
  next: { ...type.micro, color: colors.accentTxt, letterSpacing: 1.1 },
  // A dot rather than a bar or a tinted row: it is the one place the colour
  // appears, and a filled row in Tomato would shout over everything around it.
  dot: { width: 7, height: 7, borderRadius: 4, flexShrink: 0 },
  time: { ...type.readout, color: colors.accentTxt, width: 56 },
  label: { ...type.small, color: colors.text, flex: 1 },

  legend: { flexDirection: "row", flexWrap: "wrap", columnGap: spacing.md, rowGap: 2 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5, maxWidth: "100%" },
  legendText: { ...type.caption, color: colors.textDim },
  legendFailed: { color: colors.amber },

  empty: { ...type.small, color: colors.textDim },
  footNote: { ...type.caption, color: colors.textDim },
  footWarn: { ...type.caption, color: colors.amber },
});
