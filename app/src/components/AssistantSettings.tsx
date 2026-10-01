import React, { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { RadioGroup, settingsStyles as ss } from "./SettingsParts";
import { useServerSettings } from "./useServerSettings";
import { useAssistantPrefs } from "../AssistantPrefsProvider";
import {
  ASSISTANT_MODELS,
  AssistantHealth,
  AssistantServerSettings,
  AssistantSettingsPatch,
  EFFORTS,
  Health,
  MAX_ITERATIONS,
  SNAPSHOT_REPLAYS,
  THINKING_DISPLAYS,
  VoiceCredits,
  api,
  errorMessage,
} from "../api";
import { OPEN_ON, OPEN_ON_DESCRIPTIONS, OPEN_ON_LABELS } from "../assistantPrefs";
import { Polled } from "../polling";
import { colors, spacing } from "../theme";

/**
 * Assistant → Settings: whether the assistant may answer, with what, how far,
 * and how its chat opens.
 *
 * **The Anthropic switch moved here from the HUD's Settings** in 13.0 (the owner's
 * call), for the reason the units went to Fitness: it only changes what the
 * assistant does, so it sits beside the assistant. It is still a row on the
 * server — see `AnthropicSwitch`.
 *
 * **The chat preferences are this browser's** (`AssistantPrefsProvider`):
 * whether a reply nobody has seen is announced, and whether opening the
 * Assistant continues the last thread. Nothing without a browser reads them.
 *
 * **Models, reasoning and limits are rows on the server** (13.1,
 * `AssistantSettings`), read on arrival: the chat loop runs on the queue worker
 * and the nudge on the scheduler, so a browser preference would change nothing.
 * The voice card is read-only — what it reports lives in `backend/.env`.
 *
 * Laid out as Fitness → Settings is: two columns on a wide window, wrapping into
 * one when there is no room for two. What answers and how it thinks on the left;
 * how far it may go, voice and this browser's chat choices on the right.
 */
export default function AssistantSettings({ active, health }: { active: boolean; health: Polled<Health> }) {
  const { prefs, setPref } = useAssistantPrefs();
  const server = useServerSettings<AssistantServerSettings, AssistantSettingsPatch, Section>(
    active,
    api.getAssistantSettings,
    api.patchAssistantSettings,
  );

  return (
    <View style={ss.root} testID="assistant-settings">
      <ScrollView contentContainerStyle={[ss.body, s.columns]}>
        <View style={s.column} testID="assistant-settings-left">
          <View style={ss.section}>
            <Text style={ss.sectionLabel}>Anthropic API</Text>
            <AnthropicSwitch health={health} />
          </View>

          <Models server={server} />

          <Reasoning server={server} />
        </View>

        <View style={s.column} testID="assistant-settings-right">
          <Limits server={server} />

          <Voice server={server} active={active} />

          <View style={ss.section}>
            <Text style={ss.sectionLabel}>Chat</Text>

            <View style={ss.card}>
              <View style={ss.option}>
                <View style={ss.optionText}>
                  <Text style={ss.optionLabel}>Announce new replies</Text>
                  <Text style={ss.optionDesc}>
                    Marks the core menu's Assistant title and the line under the core
                    when the assistant answers and nobody has read it.
                  </Text>
                </View>
                <Switch
                  testID="assistant-unread-toggle"
                  accessibilityLabel="Announce new replies"
                  value={prefs.unreadSignal}
                  onValueChange={(on) => setPref("unreadSignal", on)}
                  trackColor={{ true: colors.accent, false: colors.borderHi }}
                />
              </View>
            </View>

            <View style={ss.group}>
              <Text style={ss.groupLabel}>Opening the Assistant shows</Text>
              <RadioGroup
                groupLabel="Opening the Assistant shows"
                options={OPEN_ON}
                selected={prefs.openOn}
                labelFor={(o) => OPEN_ON_LABELS[o]}
                descriptionFor={(o) => OPEN_ON_DESCRIPTIONS[o]}
                onSelect={(o) => setPref("openOn", o)}
              />
              <Text style={ss.footnote}>
                A call in progress, or a write waiting on your approval, keeps its
                thread open either way.
              </Text>
            </View>

            <Text style={ss.footnote}>
              Kept in this browser only. Everything else on this tab is kept on the
              machine.
            </Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

type Section = "models" | "reasoning" | "limits";

type ServerSettings = ReturnType<typeof useServerSettings<AssistantServerSettings, AssistantSettingsPatch, Section>>;

type Copy = { label: string; description: string };

const MODEL_COPY: Record<(typeof ASSISTANT_MODELS)[number], Copy> = {
  "claude-sonnet-5": { label: "Sonnet 5", description: "Quick, and cheaper per turn." },
  "claude-opus-5": { label: "Opus 5", description: "Deeper, slower, and several times the price per turn." },
};

const EFFORT_COPY: Record<(typeof EFFORTS)[number], Copy> = {
  low: { label: "Low", description: "Thinks least and answers fastest." },
  medium: { label: "Medium", description: "Thinks when a question needs it." },
  high: { label: "High", description: "Thinks hardest before answering." },
};

const DISPLAY_COPY: Record<(typeof THINKING_DISPLAYS)[number], Copy> = {
  summarized: {
    label: "Summarized",
    description: "A summary of the reasoning shows while it thinks, and is kept with the thread.",
  },
  omitted: {
    label: "Hidden",
    description: "Nothing shows until the answer starts. Cheaper to keep and re-send.",
  },
};

const ITERATION_COPY: Record<(typeof MAX_ITERATIONS)[number], Copy> = {
  6: { label: "6", description: "Stops early; a long question may end with what it found so far." },
  12: { label: "12", description: "Room for most questions that need several reads." },
  20: { label: "20", description: "For long, many-step requests. Each call is paid for." },
};

const REPLAY_COPY: Record<(typeof SNAPSHOT_REPLAYS)[number], Copy> = {
  1: { label: "1", description: "Only the latest picture is sent again." },
  3: { label: "3", description: "The last three pictures stay in view." },
  5: { label: "5", description: "The last five — each one costs input on every later turn." },
};

/**
 * A radio group over one server value, with its section's pending state.
 *
 * `RadioGroup` speaks strings, so a number set is passed as its digits and
 * turned back on the way out. A value from `.env` outside the set selects
 * nothing rather than pretending to be the nearest option.
 */
function ServerChoice<T extends string | number>({
  server,
  label,
  options,
  value,
  copy,
  onChoose,
}: {
  server: ServerSettings;
  label: string;
  options: readonly T[];
  value: T;
  copy: Record<T, Copy>;
  onChoose: (option: T) => void;
}) {
  const byKey = new Map(options.map((o) => [String(o), o]));

  return (
    <View style={ss.group}>
      <Text style={ss.groupLabel}>{label}</Text>
      <RadioGroup
        groupLabel={label}
        options={options.map(String)}
        selected={String(value)}
        labelFor={(o) => copy[byKey.get(o) as T].label}
        descriptionFor={(o) => copy[byKey.get(o) as T].description}
        onSelect={(o) => {
          const option = byKey.get(o) as T;
          // Not optimistic, and not twice: a tap while a write is out, or on
          // what is already stored, sends nothing.
          if (!server.saving && option !== value) onChoose(option);
        }}
      />
    </View>
  );
}

/** The spinner, the read error (said once, in the first section) and a section's own write error. */
function Pending({ server, section, first }: { server: ServerSettings; section: Section; first?: boolean }) {
  const error = server.errorFor(section);
  return (
    <>
      {!server.settings && !server.loadError && <ActivityIndicator color={colors.accent} />}
      {first && server.loadError && <Text style={s.errorNote}>{server.loadError}</Text>}
      {error && <Text style={s.errorNote}>{error}</Text>}
    </>
  );
}

function Models({ server }: { server: ServerSettings }) {
  const models = server.settings?.models ?? null;

  return (
    <View style={ss.section} testID="assistant-models">
      <Text style={ss.sectionLabel}>Models</Text>
      <Pending server={server} section="models" first />

      {models && (
        <>
          <ServerChoice
            server={server}
            label="Chat and voice"
            options={ASSISTANT_MODELS}
            value={models.chat as (typeof ASSISTANT_MODELS)[number]}
            copy={MODEL_COPY}
            onChoose={(chat) => server.save("models", { models: { chat } })}
          />
          <ServerChoice
            server={server}
            label="Weekly assessment and morning nudges"
            options={ASSISTANT_MODELS}
            value={models.insight as (typeof ASSISTANT_MODELS)[number]}
            copy={MODEL_COPY}
            onChoose={(insight) => server.save("models", { models: { insight } })}
          />
        </>
      )}

      <Text style={ss.footnote}>
        Switching in the middle of a conversation is fine. The next message pays
        full price for the cached instructions once, because the cache belongs to
        a model.
      </Text>
    </View>
  );
}

function Reasoning({ server }: { server: ServerSettings }) {
  const reasoning = server.settings?.reasoning ?? null;

  return (
    <View style={ss.section} testID="assistant-reasoning">
      <Text style={ss.sectionLabel}>Reasoning</Text>
      <Pending server={server} section="reasoning" />

      {reasoning && (
        <>
          <ServerChoice
            server={server}
            label="Effort"
            options={EFFORTS}
            value={reasoning.effort as (typeof EFFORTS)[number]}
            copy={EFFORT_COPY}
            onChoose={(effort) => server.save("reasoning", { reasoning: { effort } })}
          />
          <ServerChoice
            server={server}
            label="While it thinks"
            options={THINKING_DISPLAYS}
            value={reasoning.thinking_display as (typeof THINKING_DISPLAYS)[number]}
            copy={DISPLAY_COPY}
            onChoose={(thinking_display) => server.save("reasoning", { reasoning: { thinking_display } })}
          />
        </>
      )}

      <Text style={ss.footnote}>
        Effort applies to every model call, the weekly assessment included. What
        shows while it thinks is for the chat only.
      </Text>
    </View>
  );
}

function Limits({ server }: { server: ServerSettings }) {
  const limits = server.settings?.limits ?? null;

  return (
    <View style={ss.section} testID="assistant-limits">
      <Text style={ss.sectionLabel}>Limits</Text>
      <Pending server={server} section="limits" />

      {limits && (
        <>
          <ServerChoice
            server={server}
            label="Model calls per message"
            options={MAX_ITERATIONS}
            value={limits.max_iterations as (typeof MAX_ITERATIONS)[number]}
            copy={ITERATION_COPY}
            onChoose={(max_iterations) => server.save("limits", { limits: { max_iterations } })}
          />
          <ServerChoice
            server={server}
            label="Camera pictures re-sent"
            options={SNAPSHOT_REPLAYS}
            value={limits.snapshot_replay as (typeof SNAPSHOT_REPLAYS)[number]}
            copy={REPLAY_COPY}
            onChoose={(snapshot_replay) => server.save("limits", { limits: { snapshot_replay } })}
          />
        </>
      )}

      <Text style={ss.footnote}>
        Reaching the call limit is not an error: the assistant answers with what it
        has. Older pictures are replaced with a line saying one was there.
      </Text>
    </View>
  );
}

/**
 * What voice needs and does, read-only — every part of it is `backend/.env` or
 * the ElevenLabs dashboard — and what is left of the plan it bills against.
 */
function Voice({ server, active }: { server: ServerSettings; active: boolean }) {
  const voice = server.settings?.voice ?? null;
  const credits = useVoiceCredits(active);

  const rows = voice
    ? [
        { label: "ElevenLabs key", value: voice.configured ? "Set" : "Not set" },
        { label: "Life OS agent", value: voice.agent_configured ? "Set" : "Not set" },
        { label: "Opening things on this machine", value: voice.local_actions ? "On" : "Off" },
        ...creditRows(credits.data),
      ]
    : [];

  return (
    <View style={ss.section} testID="assistant-voice">
      <Text style={ss.sectionLabel}>Voice</Text>

      {voice && (
        <View style={ss.card}>
          {rows.map((row, i) => (
            <View key={row.label} style={[s.readoutRow, i > 0 && ss.optionDivided]}>
              <Text style={s.readoutLabel}>{row.label}</Text>
              <Text style={s.readoutValue}>{row.value}</Text>
            </View>
          ))}
          {credits.data?.message && (
            <View style={[s.readoutRow, ss.optionDivided]}>
              <Text style={s.statusText} testID="voice-credits-note">
                {credits.data.message}
              </Text>
            </View>
          )}
        </View>
      )}

      {credits.error && <Text style={s.errorNote}>{credits.error}</Text>}

      <Text style={ss.footnote}>
        Talk sends what you say to ElevenLabs, which turns it into a question for
        this assistant. Voice can read but never write — changes have to be typed.
        These are set in backend/.env, not here.
      </Text>
    </View>
  );
}

/**
 * The ElevenLabs plan, read each time the tab is shown and never polled —
 * Profile's rule. The server caches it for ten minutes, so opening the tab
 * twice costs ElevenLabs nothing. A failed read keeps the last one.
 */
function useVoiceCredits(active: boolean): { data: VoiceCredits | null; error: string | null } {
  const [data, setData] = useState<VoiceCredits | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let live = true;

    api.getVoiceCredits().then(
      (next) => {
        if (!live) return;
        setData(next);
        setError(null);
      },
      (e) => {
        if (live) setError(errorMessage(e));
      },
    );

    return () => {
      live = false;
    };
  }, [active]);

  return { data, error };
}

/**
 * The plan as two readout rows, or none.
 *
 * Nothing is drawn until a reading arrives, and a reading without numbers
 * (no key, a key without `user_read`, an outage) draws a dash — its sentence
 * goes under the rows, where there is room for it. A zero is a real reading.
 */
export function creditRows(credits: VoiceCredits | null): { label: string; value: string }[] {
  if (!credits) return [];

  if (credits.state !== "available" || credits.remaining === null || credits.limit === null) {
    return [{ label: "Credits left", value: "—" }];
  }

  const count = (n: number) => n.toLocaleString();
  const rows = [{ label: "Credits left", value: `${count(credits.remaining)} of ${count(credits.limit)}` }];

  if (credits.resets_at) {
    const reset = new Date(credits.resets_at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    rows.push({ label: "Resets", value: reset });
  }

  return rows;
}

/**
 * The switch that decides whether this app is allowed to call Anthropic.
 *
 * **Its state is read from `/api/health`, not from an endpoint of its own.**
 * The shell already polls health every fifteen seconds for the status pill, and
 * a settings endpoint would be a second reading of one truth — two pollers that
 * disagree for as long as their intervals are out of step. The write answers
 * with the new state, which is what lets this row update on the tap rather than
 * on the next poll; `local` holds that answer until the poll catches up and
 * agrees, and is then dropped so the panel is reading live data again.
 *
 * **It is off for the whole machine, not for this browser.** That is the reason
 * it is not stored beside the chat preferences: the proactive nudge fires at
 * 07:00 on a queue worker with no browser open anywhere, and a switch it cannot
 * see would let the app keep spending while this screen said it had stopped.
 */
export function AnthropicSwitch({ health }: { health: Polled<Health> }) {
  const [local, setLocal] = useState<AssistantHealth | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const server = health.data?.assistant ?? null;
  const state = local ?? server;

  // Once the poll agrees, stop holding the answer: from here the row is drawing
  // the same live reading as the chip in the bar and the HUD's services panel.
  useEffect(() => {
    if (local && server && server.enabled === local.enabled) setLocal(null);
  }, [local, server]);

  const toggle = async (next: boolean) => {
    setSaving(true);
    setError(null);
    try {
      setLocal(await api.setAnthropicEnabled(next));
      // So the chip in the chrome bar changes with the switch rather than up to
      // fifteen seconds later.
      health.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <View style={ss.card}>
        <View style={ss.option}>
          <View style={ss.optionText}>
            <Text style={ss.optionLabel}>Anthropic API</Text>
            <Text style={ss.optionDesc}>
              Lets the assistant answer, write the weekly fitness assessment, and
              send unprompted nudges. Everything else in the app works either way.
            </Text>
          </View>

          <Switch
            testID="anthropic-toggle"
            accessibilityLabel="Anthropic API"
            // Unknown is not "off": until a reading arrives there is nothing to
            // draw, and a switch defaulted to one end would show a state the
            // server never reported.
            value={state?.enabled ?? false}
            disabled={saving || state === null}
            onValueChange={toggle}
            trackColor={{ true: colors.accent, false: colors.borderHi }}
          />
        </View>

        <View style={[ss.option, ss.optionDivided]}>
          <Text style={s.statusText}>{statusLine(state, health)}</Text>
        </View>
      </View>

      {error && <Text style={s.errorNote}>{error}</Text>}

      <Text style={ss.footnote}>
        Off means off everywhere, not just in this browser — the 7am nudge runs on
        a queue worker with no browser open, and it checks the same switch.
      </Text>
    </>
  );
}

/**
 * One line saying what is actually true, in the order that matters.
 *
 * A missing key and a flipped switch are different problems with different
 * fixes, so they never share a sentence — and neither is guessed at while the
 * reading is missing, because "off" is exactly the wrong thing to tell someone
 * whose API is merely unreachable.
 */
export function statusLine(state: AssistantHealth | null, health: Polled<Health>): string {
  if (!state) return health.loading ? "Checking…" : "Can't reach the API, so this is unknown.";
  if (!state.enabled) return "Off — nothing in this app will call Anthropic.";
  if (!state.configured) return "On, but there's no ANTHROPIC_API_KEY in backend/.env.";
  // No balance to show: Anthropic has no API for one. What a refused call
  // proves is shown instead, and it clears on the next call that goes through.
  if (state.credit?.exhausted) {
    return "On, but Anthropic is refusing calls for lack of credit. Top up at console.anthropic.com/settings/billing — this clears on the next call that goes through.";
  }

  return `On — using ${state.model ?? "the configured model"}.`;
}

const s = StyleSheet.create({
  // The whole width of the overlay, as Fitness → Settings uses it.
  columns: {
    maxWidth: "100%",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    columnGap: spacing.xl,
  },
  // A column wraps below the other when it cannot have 440px.
  column: { flexGrow: 1, flexShrink: 1, flexBasis: 440, gap: spacing.xl },

  // The status line sits in its own row of the card, under a divider, because
  // it describes the switch above it rather than being a second control.
  statusText: { fontSize: 13, color: colors.textMuted },
  errorNote: { fontSize: 13, color: colors.error },

  readoutRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  readoutLabel: { fontSize: 13, color: colors.textMuted },
  readoutValue: { fontSize: 13, fontWeight: "500", color: colors.text },
});
