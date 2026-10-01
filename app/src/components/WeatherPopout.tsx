import React from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import Panel from "./Panel";
import Popout, { PopoutButton, PopoutClose, popoutStyles } from "./Popout";
import { Weather, WeatherDay, WeatherHour } from "../api";
import * as fmt from "../hudFormat";
import { Polled } from "../polling";
import { colors, spacing, type } from "../theme";
import { WeatherKind, clock, dayName, strip, weatherKind, week } from "../weather";

/**
 * The weather: a button in the bottom-left corner, and the card it pops out.
 *
 * It was the left rail's second panel, between the machine's gauges and its
 * backing services — the one thing in a rail about *this computer* that was
 * about the world outside it. The owner asked for it as a button instead, bottom left
 * — the mirror of the assistant's two buttons on the right.
 *
 * **The button is the icon and nothing else**, at the owner's call. It carried the
 * temperature beside the glyph until then; now it matches the HUD's other
 * icon-only buttons, and the glyph alone still says the conditions — sun,
 * cloud, rain, storm, and a moon at night. The temperature is one press away,
 * at the top of the card, and in the button's accessibility label.
 *
 * **The card is more than the panel was.** The panel showed the conditions
 * right now; the card adds the next hours and the week, because both times the
 * assistant was asked about the weather, the question was about tomorrow. It is
 * the same forecast `get_weather` reads, from the same cache.
 *
 * **It has the bottom-left corner to itself** since Optics moved under the core
 * (Phase 11), and pops out of the same glass frame as the agenda.
 * See `Popout`.
 */
export default function WeatherPopout({
  weather,
  open,
  onToggle,
  onClose,
}: {
  weather: Polled<Weather>;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  return (
    <Popout
      open={open}
      testID="hud-weather"
      button={<WeatherButton weather={weather.data} open={open} onPress={onToggle} />}
    >
      <WeatherCard weather={weather} onClose={onClose} />
    </Popout>
  );
}

function WeatherButton({
  weather,
  open,
  onPress,
}: {
  weather: Weather | null;
  open: boolean;
  onPress: () => void;
}) {
  const live = weather?.available === true;

  return (
    <PopoutButton
      open={open}
      onPress={onPress}
      // The reading goes into the name, which is not drawn: a screen reader
      // hears the temperature the icon no longer shows — and the tests find the
      // button by it.
      label={buttonLabel(weather)}
      testID="hud-weather"
    >
      {(lit) => (
        <WeatherIcon
          kind={weatherKind(weather?.weather_code)}
          night={weather?.is_day === false}
          color={lit || live ? colors.accentTxt : colors.textMuted}
        />
      )}
    </PopoutButton>
  );
}

function buttonLabel(weather: Weather | null): string {
  if (!weather) return "Weather";
  if (!weather.configured) return "Weather — no location set";
  if (!weather.available) return "Weather — unavailable";

  return `Weather — ${weather.condition ?? "outside"}, ${fmt.degrees(weather.temperature_c)}`;
}

function WeatherCard({ weather, onClose }: { weather: Polled<Weather>; onClose: () => void }) {
  const data = weather.data;
  const live = data?.available === true;
  const today = live ? week(data!.daily ?? [])[0] : undefined;

  return (
    <Panel
      eyebrow="ENVIRONMENT"
      title={live ? (data!.condition ?? "Outside") : "Outside"}
      right={
        <View style={s.head}>
          {live && <Text style={s.bigReadout}>{fmt.degrees(data!.temperature_c)}</Text>}
          <PopoutClose label="Close the weather" onPress={onClose} testID="hud-weather-close" />
        </View>
      }
      corners
      style={popoutStyles.glass}
      testID="panel-environment"
      footer={live ? <Footer label={data!.label ?? null} today={today} /> : undefined}
    >
      {weather.loading && data === null && <ActivityIndicator color={colors.accent} />}
      {weather.error && data === null && <Text style={s.empty}>{weather.error}</Text>}

      {data && !data.configured && (
        // Not configured is not the same card as not available, and the
        // difference is what the reader has to do about it.
        <Text style={s.empty}>
          No location set. Add WEATHER_LATITUDE and WEATHER_LONGITUDE to the API's .env to fill
          this in.
        </Text>
      )}

      {data && data.configured && !data.available && (
        <Text style={s.empty}>The forecast could not be fetched. Retrying shortly.</Text>
      )}

      {live && (
        <>
          <Readout label="Feels like" value={fmt.degrees(data!.apparent_c)} />
          <Readout label="Humidity" value={fmt.percent(data!.humidity)} />
          <Readout
            label="Wind"
            value={
              data!.wind_kph === null || data!.wind_kph === undefined
                ? "—"
                : `${Math.round(data!.wind_kph)} km/h ${data!.wind_from ?? ""}`.trim()
            }
          />
          <Readout label="Rain" value={fmt.percent(data!.precipitation_chance)} />

          <Hours hours={strip(data!.hourly ?? [])} />
          <Days days={week(data!.daily ?? [])} />
        </>
      )}

      {weather.error && data !== null && (
        <Text style={s.footWarn}>Couldn't refresh — showing the last reading.</Text>
      )}
    </Panel>
  );
}

/**
 * The next hours, every third one — six columns is what 300px holds at a size
 * that can still be read across a room.
 */
function Hours({ hours }: { hours: WeatherHour[] }) {
  if (hours.length === 0) return null;

  return (
    <View testID="weather-hours">
      <Text style={s.section}>NEXT HOURS</Text>
      <View style={s.hours}>
        {hours.map((h, i) => (
          <View key={h.time} style={s.hour}>
            <Text style={s.hourTime}>{i === 0 ? "Now" : clock(h.time)}</Text>
            <WeatherIcon
              kind={weatherKind(h.weather_code)}
              night={h.is_day === false}
              color={colors.accentTxt}
              size={16}
            />
            <Text style={s.hourTemp}>{fmt.degrees(h.temperature_c)}</Text>
            <Rain chance={h.precipitation_chance} />
          </View>
        ))}
      </View>
    </View>
  );
}

function Days({ days }: { days: WeatherDay[] }) {
  if (days.length === 0) return null;

  return (
    <View testID="weather-days">
      <Text style={s.section}>THIS WEEK</Text>
      {days.map((d) => (
        <View key={d.date} style={s.day}>
          <Text style={s.dayName}>{dayName(d.date)}</Text>
          <WeatherIcon kind={weatherKind(d.weather_code)} color={colors.accentTxt} size={16} />
          <Text style={s.dayCondition} numberOfLines={1}>
            {d.condition ?? "—"}
          </Text>
          <Rain chance={d.precipitation_chance} />
          <Text style={s.dayRange}>
            {fmt.degrees(d.low_c)} / {fmt.degrees(d.high_c)}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * A chance of rain, shown only once it is worth reading. Under 20% a number in
 * every cell is noise that makes the one wet afternoon harder to spot.
 */
function Rain({ chance }: { chance: number | null }) {
  const worth = chance !== null && chance >= 20;

  return (
    <Text style={[s.rain, !worth && s.rainQuiet]}>{worth ? fmt.percent(chance) : "·"}</Text>
  );
}

function Footer({ label, today }: { label: string | null; today: WeatherDay | undefined }) {
  const sun =
    today && (today.sunrise || today.sunset)
      ? `Sunrise ${clock(today.sunrise)} · Sunset ${clock(today.sunset)}`
      : null;
  const text = [label, sun].filter(Boolean).join(" · ");

  return text ? <Text style={s.footNote}>{text}</Text> : null;
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.readoutRow}>
      <Text style={s.readoutLabel}>{label}</Text>
      <Text style={s.readoutValue}>{value}</Text>
    </View>
  );
}

/**
 * Seven drawings on a 24 box, stroked in `color` — which is a `var(--c-*)`, so
 * they re-theme inside `data-hud` like the other icons here. Night swaps the
 * sun for a moon; a cloud with rain under it is a cloud with rain whatever the
 * hour.
 */
export function WeatherIcon({
  kind,
  color,
  night = false,
  size = 18,
}: {
  kind: WeatherKind;
  color: string;
  night?: boolean;
  size?: number;
}) {
  const cloud = "M7 18h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.1 9.5 4.25 4.25 0 0 0 7 18z";
  const sun = (
    <>
      <circle cx={12} cy={12} r={4} />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </>
  );
  const moon = <path d="M20 13.5A8 8 0 1 1 10.5 4a6.2 6.2 0 0 0 9.5 9.5z" />;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-kind={kind}
    >
      {kind === "clear" && (night ? moon : sun)}
      {/* The sun behind the cloud is only the arc the cloud leaves showing,
          because the strokes are unfilled and a whole circle would show
          through it. At night it is just the cloud. */}
      {kind === "partly" && !night && (
        <>
          <path d="M9 2.5V4M2.5 9H4M4.4 4.4l1.1 1.1M13.6 4.4l-1.1 1.1M5.7 10.2A3.5 3.5 0 0 1 12 7.2" />
          <path d="M9 20h8a3.5 3.5 0 0 0 .5-6.96A4.8 4.8 0 0 0 8.4 12.6 3.7 3.7 0 0 0 9 20z" />
        </>
      )}
      {(kind === "cloud" || (kind === "partly" && night)) && <path d={cloud} />}
      {kind === "fog" && <path d="M4 9h16M6 13h12M4 17h16" />}
      {kind === "rain" && (
        <>
          <path d="M7 15h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.1 6.5 4.25 4.25 0 0 0 7 15z" />
          <path d="M9 18l-1 2.5M13 18l-1 2.5M17 18l-1 2.5" />
        </>
      )}
      {kind === "snow" && (
        <>
          <path d="M7 15h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.1 6.5 4.25 4.25 0 0 0 7 15z" />
          <path d="M8.5 19h.01M12 20.5h.01M15.5 19h.01" />
        </>
      )}
      {kind === "storm" && (
        <>
          <path d="M7 15h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.1 6.5 4.25 4.25 0 0 0 7 15z" />
          <path d="M12.5 15l-2 3.5h3l-2 3.5" />
        </>
      )}
    </svg>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  bigReadout: { ...type.readout, fontSize: 20, lineHeight: 24, color: colors.accentTxt },

  readoutRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  readoutLabel: { ...type.caption, color: colors.textMuted },
  readoutValue: { ...type.readout, color: colors.text },

  section: {
    ...type.micro,
    color: colors.textDim,
    letterSpacing: 1.1,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },

  hours: { flexDirection: "row", justifyContent: "space-between" },
  hour: { alignItems: "center", gap: 3, minWidth: 36 },
  hourTime: { ...type.micro, color: colors.textMuted },
  hourTemp: { ...type.readout, fontSize: 12, color: colors.text },

  day: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: 3 },
  dayName: { ...type.caption, color: colors.text, width: 40 },
  dayCondition: { ...type.caption, color: colors.textMuted, flex: 1 },
  dayRange: { ...type.readout, fontSize: 12, color: colors.text, minWidth: 64, textAlign: "right" },

  rain: { ...type.micro, color: colors.accentTxt, minWidth: 28, textAlign: "center" },
  rainQuiet: { color: colors.textDim },

  empty: { ...type.small, color: colors.textDim },
  footNote: { ...type.caption, color: colors.textDim },
  footWarn: { ...type.caption, color: colors.amber },
});
