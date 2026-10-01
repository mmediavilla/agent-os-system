import React, { useCallback, useEffect, useState } from "react";
import { StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { AgentInput, AgentPatch, AssistantAgent, CapabilityGroup, api, errorMessage } from "../api";
import { colors, radii, spacing, type } from "../theme";
import ConfirmDialog from "./ConfirmDialog";
import { SmallButton } from "./RecordsParts";
import { Card, Group, Line, Note, StatPage, statStyles } from "./StatParts";

/**
 * Assistant → Agents: the kinds of work the assistant may do, each a row with a
 * switch.
 *
 * **Off means not offered.** A switched-off agent's tools leave the registry the
 * model is handed on the next turn, and the prompt says which agent took them —
 * so each card says, from the server's own reading (`withholds`), what being off
 * takes away *now*. A group another agent still holds is not taken away, and the
 * card says that too rather than implying the switch did something.
 *
 * **The groups come from the server** beside the rows, labelled and with the
 * tools each holds on this machine, so this screen never keeps a second copy of
 * the registry. `core` is never among them: the weather and the assistant's
 * memory are not something an agent can own, or switch off.
 *
 * **A built-in agent's groups and existence are fixed** — they are what keep
 * every guarded kind of work owned — and its name, purpose, guardrail and switch
 * are the owner's.
 *
 * **Every guardrail is a field, and blank is the default** (the owner's call): the
 * rules of the groups the agent owns, which the server sends as
 * `default_guardrail` and, per group, beside the rows. Clearing the field puts
 * the default back rather than leaving the agent with no rule, and Reset does
 * the same in one press. The add card shows the default for what is ticked as
 * its placeholder — composed here only because that agent does not exist yet.
 *
 * `AutomationsView`'s rules otherwise: nothing optimistic, one write out at a
 * time, text fields as drafts committed on blur and resynced from the row's
 * values **and** a write counter, and only Delete asks first. Read on arrival,
 * never polled — a row changes when someone changes it.
 */
export default function AgentsView({ active }: { active: boolean }) {
  const [rows, setRows] = useState<AssistantAgent[] | null>(null);
  const [groups, setGroups] = useState<CapabilityGroup[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  // Which write is out: a row's id, or "new" for the add card.
  const [busy, setBusy] = useState<number | "new" | null>(null);
  const [writeError, setWriteError] = useState<{ at: number | "new"; text: string } | null>(null);
  const [deleting, setDeleting] = useState<AssistantAgent | null>(null);
  // Bumped by every write, and by nothing else — what a draft resyncs on.
  const [written, setWritten] = useState(0);

  const reload = useCallback(async () => {
    try {
      const list = await api.listAgents();
      setRows(list.data);
      setGroups(list.groups);
      setReadError(null);
    } catch (e) {
      setReadError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    if (active) reload();
  }, [active, reload]);

  /** Run one write, then re-read — one agent's switch can change what another's card says. */
  const write = async (which: number | "new", fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(which);
    setWriteError(null);
    let ok = true;
    try {
      await fn();
    } catch (e) {
      ok = false;
      setWriteError({ at: which, text: errorMessage(e) });
    }
    await reload();
    setWritten((v) => v + 1);
    setBusy(null);
    return ok;
  };

  const remove = async () => {
    if (!deleting) return;
    const row = deleting;
    await write(row.id, () => api.deleteAgent(row.id));
    setDeleting(null);
  };

  return (
    <StatPage testID="agents-view">
      {rows === null && !readError && (
        <Card testID="agents-loading" title="Agents">
          <Line label="Rows" value="reading…" dim />
        </Card>
      )}

      {readError && (
        <Card testID="agents-error" title="Agents" footnote={{ text: readError, warn: true }}>
          <Line label="Rows" value="—" dim />
        </Card>
      )}

      {(rows ?? []).map((agent) => (
        <AgentCard
          key={agent.id}
          agent={agent}
          groups={groups}
          written={written}
          busy={busy}
          error={writeError?.at === agent.id ? writeError.text : null}
          onPatch={(changes) => write(agent.id, () => api.updateAgent(agent.id, changes))}
          onDelete={() => setDeleting(agent)}
        />
      ))}

      {rows !== null && (
        <AddCard
          groups={groups}
          busy={busy}
          error={writeError?.at === "new" ? writeError.text : null}
          onAdd={(input) => write("new", () => api.createAgent(input))}
        />
      )}

      <ConfirmDialog
        visible={deleting !== null}
        title={`Delete ${deleting?.name ?? "this agent"}?`}
        message={deleting ? deleteMessage(deleting, rows ?? [], groups) : ""}
        confirmLabel="Delete"
        destructive
        loading={deleting !== null && busy === deleting.id}
        onConfirm={remove}
        onCancel={() => setDeleting(null)}
      />
    </StatPage>
  );
}

function AgentCard({
  agent,
  groups,
  written,
  busy,
  error,
  onPatch,
  onDelete,
}: {
  agent: AssistantAgent;
  groups: CapabilityGroup[];
  /** How many writes this page has made. A draft resyncs on each one. */
  written: number;
  busy: number | "new" | null;
  error: string | null;
  onPatch: (changes: AgentPatch) => Promise<boolean>;
  onDelete: () => void;
}) {
  const { id, name, purpose } = agent;
  const guardrail = agent.guardrail ?? "";
  const [nameDraft, setNameDraft] = useState(name);
  const [purposeDraft, setPurposeDraft] = useState(purpose);
  const [guardrailDraft, setGuardrailDraft] = useState(guardrail);

  // The values and the write counter, never the row object — AutomationsView's pair.
  useEffect(() => setNameDraft(name), [name, written]);
  useEffect(() => setPurposeDraft(purpose), [purpose, written]);
  useEffect(() => setGuardrailDraft(guardrail), [guardrail, written]);

  const locked = busy !== null;
  const reworded = agent.guardrail !== agent.default_guardrail;

  const commitGuardrail = () => {
    const next = guardrailDraft.trim();
    if (next === guardrail) return;
    // Blank is the default. Already on it, there is nothing to write.
    if (next === "" && !reworded) {
      setGuardrailDraft(guardrail);
      return;
    }
    onPatch({ guardrail: next });
  };

  const commitText = (key: "name" | "purpose", draft: string, stored: string, reset: (t: string) => void) => {
    const next = draft.trim();
    // Empty is a 422; putting the stored value back says so without a sentence.
    if (next === "") {
      reset(stored);
      return;
    }
    if (next !== stored) onPatch({ [key]: next } as AgentPatch);
  };

  const footnote: Note | undefined = error ? { text: error, warn: true } : undefined;

  return (
    <Card
      testID={`agent-${id}`}
      title={name}
      right={agent.seeded ? (agent.enabled ? "built in" : "built in · off") : agent.enabled ? undefined : "switched off"}
      footnote={footnote}
    >
      <View style={s.head}>
        <View style={s.headText}>
          <Text style={s.label}>{agent.enabled ? "Switched on" : "Switched off"}</Text>
          <Text style={s.desc} testID={`agent-${id}-effect`}>
            {effect(agent, groups)}
          </Text>
        </View>
        <Switch
          value={agent.enabled}
          disabled={locked}
          onValueChange={(enabled) => void onPatch({ enabled })}
          accessibilityLabel={`${name} switched on`}
          trackColor={{ true: colors.accent, false: colors.borderHi }}
          testID={`agent-${id}-enabled`}
        />
      </View>

      <TextInput
        value={nameDraft}
        onChangeText={setNameDraft}
        onBlur={() => commitText("name", nameDraft, name, setNameDraft)}
        onSubmitEditing={() => commitText("name", nameDraft, name, setNameDraft)}
        editable={!locked}
        accessibilityLabel={`${name} name`}
        style={s.input}
        testID={`agent-${id}-name`}
      />

      <TextInput
        value={purposeDraft}
        onChangeText={setPurposeDraft}
        onBlur={() => commitText("purpose", purposeDraft, purpose, setPurposeDraft)}
        multiline
        numberOfLines={3}
        editable={!locked}
        placeholder="What it is for, in your own words."
        placeholderTextColor={colors.textDim}
        accessibilityLabel={`${name} purpose`}
        style={[s.input, s.purposeInput]}
        testID={`agent-${id}-purpose`}
      />

      {agent.seeded ? (
        <Group label="Owns" testID={`agent-${id}-groups`}>
          {groups
            .filter((g) => agent.capabilities.includes(g.value))
            .map((g) => (
              <Line key={g.value} label={capitalise(g.label)} value={toolCount(g)} dim testID={`agent-${id}-group-${g.value}`} />
            ))}
        </Group>
      ) : (
        <GroupToggles
          testPrefix={`agent-${id}`}
          label="Owns"
          groups={groups}
          chosen={agent.capabilities}
          disabled={locked}
          onChange={(capabilities) => onPatch({ capabilities })}
        />
      )}

      <Group label="Guardrail" testID={`agent-${id}-guardrail`}>
        <TextInput
          value={guardrailDraft}
          onChangeText={setGuardrailDraft}
          onBlur={commitGuardrail}
          multiline
          numberOfLines={3}
          editable={!locked}
          placeholder="Nothing it owns has a rule of its own. Write one to hold it to something."
          placeholderTextColor={colors.textDim}
          accessibilityLabel={`${name} guardrail`}
          style={[s.input, s.guardrailInput]}
          testID={`agent-${id}-guardrail-input`}
        />
        <Text style={s.desc} testID={`agent-${id}-guardrail-note`}>
          {reworded
            ? "Reworded by you. Clear it, or reset, to go back to the default for what it owns."
            : "The default for what it owns. Reword it here; clearing it keeps the default."}
        </Text>
        {reworded && (
          <View style={s.actions}>
            <SmallButton
              label="Reset to default"
              onPress={() => void onPatch({ guardrail: null })}
              disabled={locked}
              testID={`agent-${id}-guardrail-reset`}
              accessibilityLabel={`Reset ${name} guardrail to default`}
            />
          </View>
        )}
      </Group>

      {!agent.seeded && (
        <View style={s.actions}>
          <SmallButton
            label="Delete"
            tone={colors.error}
            onPress={onDelete}
            disabled={locked}
            testID={`agent-${id}-delete`}
            accessibilityLabel={`Delete ${name}`}
          />
        </View>
      )}
    </Card>
  );
}

function AddCard({
  groups,
  busy,
  error,
  onAdd,
}: {
  groups: CapabilityGroup[];
  busy: number | "new" | null;
  error: string | null;
  onAdd: (input: AgentInput) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [guardrail, setGuardrail] = useState("");

  const adding = busy === "new";
  const ready = name.trim() !== "" && purpose.trim() !== "" && capabilities.length > 0;
  const fallback = defaultGuardrail(groups, capabilities);

  const add = async () => {
    if (!ready || busy !== null) return;
    // Added switched on, the reverse of an automation: an agent off withholds
    // whatever it alone claims, so one that arrived off could take a tool away
    // the moment it was saved.
    const input: AgentInput = { name: name.trim(), purpose: purpose.trim(), capabilities, enabled: true };
    if (guardrail.trim() !== "") input.guardrail = guardrail.trim();
    if (await onAdd(input)) {
      setName("");
      setPurpose("");
      setCapabilities([]);
      setGuardrail("");
    }
  };

  return (
    <Card
      testID="agent-new"
      title="New agent"
      right="added switched on"
      footnote={error ? { text: error, warn: true } : undefined}
    >
      <TextInput
        value={name}
        onChangeText={setName}
        editable={!adding}
        placeholder="Accountant"
        placeholderTextColor={colors.textDim}
        accessibilityLabel="New agent name"
        style={s.input}
        testID="agent-new-name"
      />

      <TextInput
        value={purpose}
        onChangeText={setPurpose}
        multiline
        numberOfLines={3}
        editable={!adding}
        placeholder="What it is for, in your own words."
        placeholderTextColor={colors.textDim}
        accessibilityLabel="New agent purpose"
        style={[s.input, s.purposeInput]}
        testID="agent-new-purpose"
      />

      <GroupToggles
        testPrefix="agent-new"
        label="It owns"
        groups={groups}
        chosen={capabilities}
        disabled={adding}
        onChange={setCapabilities}
        allowEmpty
      />

      <Group label="Guardrail" testID="agent-new-guardrail">
        <TextInput
          value={guardrail}
          onChangeText={setGuardrail}
          multiline
          numberOfLines={3}
          editable={!adding}
          placeholder={fallback ?? "Choose what it owns to see its default, or write your own."}
          placeholderTextColor={colors.textDim}
          accessibilityLabel="New agent guardrail"
          style={[s.input, s.guardrailInput]}
          testID="agent-new-guardrail-input"
        />
        <Text style={s.desc}>Left blank, it is held to the default for what it owns.</Text>
      </Group>

      <SmallButton
        label={adding ? "Adding…" : "Add agent"}
        onPress={add}
        disabled={!ready || busy !== null}
        testID="agent-new-submit"
        accessibilityLabel="Add agent"
      />
    </Card>
  );
}

/**
 * One switch per group an agent may own. **The last one chosen cannot be
 * switched off** on a saved row — an agent that owns nothing is a 422, and a
 * switch that always springs back is a control that lies — so it is disabled
 * instead, with the reason in its line. The add card may start empty.
 */
function GroupToggles({
  testPrefix,
  label,
  groups,
  chosen,
  disabled,
  onChange,
  allowEmpty = false,
}: {
  testPrefix: string;
  label: string;
  groups: CapabilityGroup[];
  chosen: string[];
  disabled: boolean;
  onChange: (capabilities: string[]) => void;
  allowEmpty?: boolean;
}) {
  const toggle = (value: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(value);
    else next.delete(value);
    // Rebuilt in the server's own order.
    onChange(groups.map((g) => g.value).filter((v) => next.has(v)));
  };

  return (
    <Group label={label} testID={`${testPrefix}-groups`}>
      {groups.map((g) => {
        const on = chosen.includes(g.value);
        const last = on && chosen.length === 1 && !allowEmpty;
        return (
          <View key={g.value} style={s.groupRow}>
            <View style={s.headText}>
              <Text style={s.label}>{capitalise(g.label)}</Text>
              <Text style={s.desc}>{last ? "An agent owns at least one kind of work." : toolList(g)}</Text>
            </View>
            <Switch
              value={on}
              disabled={disabled || last}
              onValueChange={(next) => toggle(g.value, next)}
              accessibilityLabel={capitalise(g.label)}
              trackColor={{ true: colors.accent, false: colors.borderHi }}
              testID={`${testPrefix}-group-${g.value}`}
            />
          </View>
        );
      })}
    </Group>
  );
}

/**
 * What the switch does right now, from the server's `withholds` — never worked
 * out here, because who else holds a group is the scope's question.
 */
export function effect(agent: AssistantAgent, groups: CapabilityGroup[]): string {
  const labels = (values: string[]) => list(values.map((v) => groups.find((g) => g.value === v)?.label ?? v));

  if (agent.enabled) return `The assistant is offered ${labels(agent.capabilities)}.`;
  if (agent.withholds.length === 0) return "Changes nothing right now — another agent that is on holds what this one owns.";
  return `The assistant is not offered ${labels(agent.withholds)}, and says so when asked.`;
}

/**
 * What deleting `agent` does, named before it is done — it cannot be undone.
 *
 * A group with a rule that no other agent owns is **taken away** from the
 * assistant (`AgentScope` withholds a guarded group nobody owns), so the dialog
 * says so rather than promising it goes back to being offered. Worked out here
 * from the rows on screen, because the answer is about the page after the
 * delete, which the server has not been asked about. The news keeps what the
 * owner put in it — interests and pins are not the agent's, and live on 08 News.
 */
export function deleteMessage(agent: AssistantAgent, rows: AssistantAgent[], groups: CapabilityGroup[]): string {
  const others = rows.filter((r) => r.id !== agent.id);
  const lost = groups.filter(
    (g) => agent.capabilities.includes(g.value) && g.guardrail !== null && !others.some((r) => r.capabilities.includes(g.value)),
  );

  const parts = [
    `It cannot be undone: its name, purpose and guardrail go with it.`,
    lost.length > 0
      ? `No other agent owns ${list(lost.map((g) => g.label))}, so the assistant stops being offered ${lost.length === 1 ? "it" : "them"} until you make one that does.`
      : "The assistant keeps everything it owns, through another agent or because it has no rule to follow.",
  ];
  if (agent.capabilities.includes("news")) {
    parts.push("Your news interests and pinned articles are kept on 08 News.");
  }
  parts.push("Nothing it helped write is touched.");

  return parts.join(" ");
}

/**
 * The default an agent that owns `chosen` would be held to — the server's
 * `Agent::defaultGuardrail()`, joined in the groups' own order. Only the add
 * card asks, because its agent does not exist to be asked about.
 */
export function defaultGuardrail(groups: CapabilityGroup[], chosen: string[]): string | null {
  const rules = groups.filter((g) => chosen.includes(g.value) && g.guardrail !== null).map((g) => g.guardrail);
  return rules.length === 0 ? null : rules.join(" ");
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function toolCount(g: CapabilityGroup): string {
  if (g.tools.length === 0) return "nothing registered";
  return g.tools.length === 1 ? "1 tool" : `${g.tools.length} tools`;
}

/** The tools behind a group, so a switch says what it moves. `machine` is empty while local actions are off. */
function toolList(g: CapabilityGroup): string {
  return g.tools.length === 0 ? "Nothing registered on this machine." : g.tools.join(", ");
}

const s = {
  ...statStyles,
  ...StyleSheet.create({
    head: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
    headText: { flex: 1, minWidth: 0, gap: 2 },
    label: { ...type.small, color: colors.text, fontWeight: "500" },
    desc: { ...type.caption, color: colors.textDim },

    groupRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },

    input: {
      fontSize: 13,
      color: colors.text,
      backgroundColor: colors.bg,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: radii.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    purposeInput: { minHeight: 64, textAlignVertical: "top" },
    // A group's rule is two sentences, and the Secretary holds three groups' worth.
    guardrailInput: { minHeight: 184, textAlignVertical: "top" },

    actions: { flexDirection: "row", gap: spacing.xs },
  }),
};
