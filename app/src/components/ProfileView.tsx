import React, { useCallback, useEffect, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { AuthSession, SignInAttempt, api, errorMessage } from "../api";
import { AuthUser } from "../auth";
import { colors, radii, spacing, type } from "../theme";
import { Card, Line, StatPage, since, statStyles, when } from "./StatParts";

/**
 * Profile: the account the app is signed in to, the browsers holding it, and
 * who has tried to sign in.
 *
 * The core menu's Profile panel opens it. One page of cards, no tabs, like
 * Stats — there is nothing here long enough to hide behind a tab.
 *
 * **Read on arrival, never polled.** Nothing here changes on its own at a rate
 * worth a timer: a new session is a sign-in somewhere else, which is rare and
 * shows the next time this opens.
 *
 * **Revoking is not optimistic**, for `useServerSettings`' reason: the button
 * waits for the answer and the list is read again, so a session that looked
 * gone and was not cannot be left on screen. A 404 — already gone — redraws the
 * same way.
 *
 * **This browser's own session has no Revoke.** Revoking it is signing out, and
 * that is the Sign out button, which also clears the token here; a Revoke on
 * its own row would leave the page holding a token the server had just thrown
 * away, to be found out by the next request's 401.
 *
 * **The account is `AuthProvider`'s**, handed down rather than read again: it
 * was fetched when this browser signed in or loaded, and nothing on it changes
 * without a new sign-in, which reloads the page.
 */
export default function ProfileView({
  active,
  user,
  onSignOut,
}: {
  active: boolean;
  user: AuthUser;
  onSignOut: () => void;
}) {
  const sessions = useRead(active, () => api.listSessions().then((r) => r.data));
  const signIns = useRead(active, () => api.listSignIns().then((r) => r.data));

  // Which revoke is out: a session's id, or every other one.
  const [revoking, setRevoking] = useState<number | "others" | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const revoke = async (which: number | "others") => {
    setRevoking(which);
    setRevokeError(null);
    try {
      await (which === "others" ? api.revokeOtherSessions() : api.revokeSession(which));
    } catch (e) {
      // Still re-read: a session another tab already revoked 404s here, and
      // the list should stop offering it either way.
      setRevokeError(errorMessage(e));
    }
    await sessions.reload();
    setRevoking(null);
  };

  const others = (sessions.data ?? []).filter((session) => !session.current);

  return (
    <StatPage testID="profile-view">
      <AccountCard user={user} onSignOut={onSignOut} />

      <Card
        testID="profile-sessions"
        title="Sessions & devices"
        right={sessions.data ? `${sessions.data.length} signed in` : undefined}
        footnote={
          revokeError
            ? { text: revokeError, warn: true }
            : sessions.error
              ? { text: sessions.error, warn: true }
              : undefined
        }
      >
        {sessions.data === null && !sessions.error && <Line label="Sessions" value="reading…" dim />}

        {sessions.data?.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            busy={revoking !== null}
            onRevoke={() => revoke(session.id)}
          />
        ))}

        {sessions.data && (
          <Button
            label={revoking === "others" ? "Signing out…" : "Sign out everywhere else"}
            onPress={() => revoke("others")}
            disabled={revoking !== null || others.length === 0}
            testID="profile-revoke-others"
          />
        )}
      </Card>

      <HistoryCard signIns={signIns} />
    </StatPage>
  );
}

function AccountCard({ user, onSignOut }: { user: AuthUser; onSignOut: () => void }) {
  const [failed, setFailed] = useState(false);

  return (
    <Card testID="profile-account" title="Account" right="Google">
      <View style={s.who}>
        <View style={s.avatar} testID="profile-avatar">
          {user.avatar_url && !failed ? (
            <Image source={{ uri: user.avatar_url }} style={s.avatarImage} onError={() => setFailed(true)} />
          ) : (
            <Text style={s.avatarText}>{initials(user.name)}</Text>
          )}
        </View>
        <View style={s.whoText}>
          <Text style={s.name} numberOfLines={1}>
            {user.name}
          </Text>
          <Text style={s.email} numberOfLines={1}>
            {user.email}
          </Text>
        </View>
      </View>

      <Line testID="profile-linked" label="Linked since" value={when(user.linked_at)} />
      <Line testID="profile-last-login" label="Last sign-in" value={when(user.last_login_at)} />
      <Line testID="profile-timezone" label="Timezone" value={user.timezone} />
      {/* Whether, never what: the value is the MCP host's credential. */}
      <Line
        testID="profile-mcp"
        label="MCP token"
        tone={user.mcp_token_configured ? colors.emerald : colors.textDim}
        value={user.mcp_token_configured ? "set" : "not set"}
      />

      <Button label="Sign out" onPress={onSignOut} testID="profile-sign-out" />
    </Card>
  );
}

function SessionRow({ session, busy, onRevoke }: { session: AuthSession; busy: boolean; onRevoke: () => void }) {
  return (
    <View style={s.item} testID={`profile-session-${session.id}`}>
      <View style={s.itemHead}>
        <Text style={s.itemTitle} numberOfLines={1}>
          {session.name}
        </Text>
        {session.current ? (
          <Text style={s.tag} testID={`profile-session-${session.id}-current`}>
            this browser
          </Text>
        ) : (
          <Pressable
            onPress={onRevoke}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={`Revoke ${session.name}`}
            accessibilityState={{ disabled: busy }}
            style={({ hovered }: any) => [s.revoke, hovered && !busy && s.revokeHovered, busy && s.disabled]}
            testID={`profile-session-${session.id}-revoke`}
          >
            <Text style={s.revokeText}>Revoke</Text>
          </Pressable>
        )}
      </View>
      <Text style={s.itemDetail} numberOfLines={1}>
        {[session.ip_address ?? "no address", `signed in ${when(session.created_at)}`, `used ${since(session.last_used_at)}`].join(
          " · ",
        )}
      </Text>
    </View>
  );
}

/** The refusal codes `GoogleSignIn` records, in words. An unknown one is shown as it is. */
const REASONS: Record<string, string> = {
  not_owner: "not the owner's address",
  sub_mismatch: "a different Google account on the owner's address",
  unverified: "email not verified",
  state: "expired or reused link",
  exchange: "Google refused the code",
  id_token: "unreadable answer from Google",
  unreachable: "Google unreachable",
  unconfigured: "sign-in not set up",
};

const OUTCOME_TONE = {
  ok: colors.emerald,
  refused: colors.amber,
  failed: colors.error,
} satisfies Record<SignInAttempt["outcome"], string>;

function HistoryCard({ signIns }: { signIns: Read<SignInAttempt[]> }) {
  const rows = signIns.data;
  const refused = rows?.filter((row) => row.outcome === "refused").length ?? 0;

  return (
    <Card
      testID="profile-history"
      title="Sign-in history"
      right={rows ? (refused === 0 ? "none refused" : `${refused} refused`) : undefined}
      footnote={signIns.error ? { text: signIns.error, warn: true } : undefined}
    >
      {rows === null && !signIns.error && <Line label="Sign-ins" value="reading…" dim />}
      {rows?.length === 0 && <Line label="No sign-ins yet" value="—" dim />}

      {rows?.map((row) => (
        <View key={row.id} style={s.item} testID={`profile-sign-in-${row.id}`}>
          <View style={s.itemHead}>
            <View style={[statStyles.marker, { backgroundColor: OUTCOME_TONE[row.outcome] }]} />
            <Text style={s.itemTitle} numberOfLines={1}>
              {row.email ?? "unknown address"}
            </Text>
            <Text style={[s.outcome, { color: OUTCOME_TONE[row.outcome] }]}>{row.outcome}</Text>
          </View>
          <Text style={s.itemDetail} numberOfLines={1}>
            {[when(row.created_at), row.ip ?? "no address"].join(" · ")}
          </Text>
          {row.outcome !== "ok" && row.reason && (
            <Text style={[s.itemDetail, { color: OUTCOME_TONE[row.outcome] }]} testID={`profile-sign-in-${row.id}-reason`}>
              {REASONS[row.reason] ?? row.reason}
            </Text>
          )}
        </View>
      ))}
    </Card>
  );
}

function Button({
  label,
  onPress,
  disabled = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ hovered }: any) => [s.button, hovered && !disabled && s.buttonHovered, disabled && s.disabled]}
      testID={testID}
    >
      <Text style={s.buttonText}>{label}</Text>
    </Pressable>
  );
}

type Read<T> = { data: T | null; error: string | null; reload: () => Promise<void> };

/** One read, taken each time the overlay opens, kept while it is shut. */
function useRead<T>(active: boolean, read: () => Promise<T>): Read<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await read());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
    // Kept from the first render: `read` only calls the api, so a later copy
    // of it would do the same thing.
  }, []);

  useEffect(() => {
    if (active) reload();
  }, [active, reload]);

  return { data, error, reload };
}

/** One or two letters for a name, for where a photo is missing. */
export function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join("");
  return (letters.length > 2 ? letters[0] + letters[letters.length - 1] : letters).toUpperCase() || "?";
}

const s = {
  ...statStyles,
  ...StyleSheet.create({
    who: { flexDirection: "row", alignItems: "center", gap: spacing.md },
    whoText: { flex: 1, minWidth: 0, gap: 2 },
    avatar: {
      width: 48,
      height: 48,
      borderRadius: 24,
      overflow: "hidden",
      borderWidth: 1,
      borderColor: colors.accentBd,
      backgroundColor: colors.accentBg,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarImage: { width: "100%", height: "100%" },
    avatarText: { ...type.title, color: colors.accentTxt },
    name: { ...type.title, color: colors.text },
    email: { ...type.small, color: colors.textMuted },

    item: { gap: 2 },
    itemHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    itemTitle: { ...type.small, color: colors.text, flex: 1, minWidth: 0 },
    itemDetail: { ...type.caption, color: colors.textDim },
    outcome: { ...type.caption, fontWeight: "600" },
    tag: {
      ...type.micro,
      color: colors.accentTxt,
      borderWidth: 1,
      borderColor: colors.accentBd,
      borderRadius: radii.sm,
      paddingHorizontal: spacing.xs,
      paddingVertical: 1,
    },

    revoke: { paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radii.sm },
    revokeHovered: { backgroundColor: colors.bg },
    revokeText: { fontSize: 12, color: colors.error },

    button: {
      alignSelf: "flex-start",
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radii.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    buttonHovered: { borderColor: colors.accent, backgroundColor: colors.accentBg },
    buttonText: { fontSize: 13, fontWeight: "600", color: colors.text },
    disabled: { opacity: 0.45 },
  }),
};
