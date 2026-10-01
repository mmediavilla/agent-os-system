import React, { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import AssistantOrb, { OrbState } from "../components/AssistantOrb";
import AgendaPopout from "../components/AgendaPopout";
import CoreMenu, { MenuPanel } from "../components/CoreMenu";
import AssistantView, { AssistantTab } from "../components/AssistantView";
import FitnessView, { FitnessTab } from "../components/FitnessView";
import GlassOverlay, { GlassStatus } from "../components/GlassOverlay";
import HolographicCore, { coreTint } from "../components/HolographicCore";
import OpticsButton, { OpticsCard } from "../components/OpticsPopout";
import { PopoutTrack } from "../components/Popout";
import SettingsView from "../components/SettingsView";
import StatsView from "../components/StatsView";
import AutomationsView from "../components/AutomationsView";
import FactsView from "../components/FactsView";
import NewsView from "../components/NewsView";
import ProfileView, { initials } from "../components/ProfileView";
import RecordsView, { RecordsTab } from "../components/RecordsView";
import WeatherPopout from "../components/WeatherPopout";
import { Health, SystemStats, api } from "../api";
import { AuthUser } from "../auth";
import { talkLabel } from "../agentSession";
import * as cal from "../calendar";
import { lastSaidKey, lastSaidText } from "../chat";
import {
  GLASS_SCOPE,
  HUD_SCOPE,
  colors,
  hud,
  radii,
  spacing,
  transition,
  type,
} from "../theme";
import * as fmt from "../hudFormat";
import { useAssistantPrefs } from "../AssistantPrefsProvider";
import { Polled, useNow, usePolled } from "../polling";
import { useCamera } from "../useCamera";
import { useDueAutomations } from "../useDueAutomations";
import { AgentSessionController } from "../useAgentSession";
import { ConversationController, useConversation } from "../useConversation";

/**
 * The HUD.
 *
 * The core, and nothing permanent around it. There used to be a rail either
 * side — this machine on the left, the day on the right — and they cost the
 * core its width all day to show numbers nobody was reading most of it. Since
 * Phase 11 **the core is the menu**: click it and nine numbered panels slide in,
 * four down the left and five down the right (`CoreMenu`), click it again and
 * they go.
 *
 * **Nothing on it is invented.** Every number comes from an endpoint, and where
 * one has nothing to say the panel says so rather than showing a plausible
 * figure: a machine sample that has not landed, a forecast for a location
 * nobody has set. Each of those is a real state of a real system, and a HUD
 * that could not draw them would only be honest on a good day.
 *
 * **The corners hold what is worth one press.** Top right, the agenda: today,
 * from the user's own calendars (`AgendaPopout`). Bottom left, the weather
 * (`WeatherPopout`). The camera and the microphone are two buttons side by
 * side under the core (`OpticsPopout`, `TalkButton`); the camera's card sits
 * above the sphere. Bottom right is empty since 13.0, when the chat button went:
 * the typed conversation is the core menu's Assistant title, or ⌘K.
 *
 * The agenda is the one read here whose window is computed **on this side**.
 * Every other endpoint decides its own range; `/api/calendar` deliberately does
 * not, because event times are wall clock and this server runs eight hours
 * behind the person reading the screen — so the browser says which day is
 * today and asks for the week after it.
 *
 * **There is one conversation behind the microphone and the Assistant overlay.**
 * `useConversation` owns the transcript and the voice session together, so a
 * question asked out loud lands in the thread the overlay opens on.
 *
 * **At most one thing floats over the HUD**: an overlay (the Assistant, Stats,
 * Settings, Fitness, Facts, Automations, Records, News or Profile), the core menu, or one corner card. Opening any of them puts the
 * others away, and Escape takes them away in that order.
 *
 * The palette is the app's own, on `:root`. `HUD_SCOPE` still puts `data-hud`
 * on the root element, but all it carries now is motion: the subtree that
 * `prefers-reduced-motion` stops, and where the voice ring's level is pinned.
 */
export default function Hud({
  active = true,
  health,
  onOrbState,
  account,
}: {
  active?: boolean;
  /**
   * Polled by `App`, not here, because the chrome bar's pill reads the same
   * answer. Two pollers against one endpoint would be two rows of the same
   * truth disagreeing for fifteen seconds at a time.
   */
  health: Polled<Health>;
  /** Lets the bar's small orb show a run that started on this screen. */
  onOrbState?: (state: OrbState) => void;
  /**
   * Who is signed in, and how to stop being. `AuthProvider`'s, handed down by
   * `App` rather than read here, so the HUD's suite needs no sign-in to mount
   * it. Without one there is no Profile panel.
   */
  account?: { user: AuthUser; signOut: () => void };
}) {
  /**
   * Which glass overlay is over the HUD, if any.
   *
   * One value rather than a flag each, because no two can be up at once: each
   * covers the whole screen, the other's button included, so a second one
   * opened underneath would be a layer nobody can see and Escape would have to
   * guess which to take away.
   */
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const full = overlay === "assistant";

  /**
   * Which Assistant tab the overlay shows — Chat, Activity, Agents or Settings. Kept while it is
   * shut, like `fitnessTab`, so the core menu's title reopens where you were.
   */
  const [assistantTab, setAssistantTab] = useState<AssistantTab>("chat");

  /**
   * Which Fitness screen the overlay shows. Kept while it is shut, so reopening
   * it from ✕, Escape or the core menu's Fitness title lands where you left.
   */
  const [fitnessTab, setFitnessTab] = useState<FitnessTab>("home");

  /** Which Records tab the overlay shows. Kept while it is shut, like `fitnessTab`. */
  const [recordsTab, setRecordsTab] = useState<RecordsTab>("documents");

  /** Which beat the News overlay shows; null is the server's first. Kept while it is shut, like `recordsTab`. */
  const [newsBeat, setNewsBeat] = useState<string | null>(null);

  /**
   * Which corner card is popped out, if any.
   *
   * One value rather than a flag each, at the owner's call: pressing Optics while the
   * weather is out puts the weather away and brings the camera out, so no two
   * cards over the HUD are ever up at once.
   *
   * Not an `Overlay`: a popout is a card beside its button rather than a frame
   * over the whole screen. It is put away when either overlay opens — a card
   * left standing under the glass would be back, unasked for, the moment the
   * glass went — and when this stops being the screen you are on.
   */
  const [popout, setPopout] = useState<Popout | null>(null);

  /**
   * Whether the core menu is out.
   *
   * Its own flag rather than a third kind of `Popout`, because it is not a card
   * beside a button, but it keeps the same rule: bringing out a card puts the
   * menu away, and opening the menu puts the card away. That includes the
   * camera's, which sits where the menu's banner does, so **opening the menu
   * turns the camera off**, as putting its card away always has.
   */
  const [menuOpen, setMenuOpen] = useState(false);

  const flipPopout = (which: Popout) => {
    setMenuOpen(false);
    setPopout((was) => (was === which ? null : which));
  };
  const flipMenu = () => {
    setPopout(null);
    setMenuOpen((was) => !was);
  };

  useEffect(() => {
    if (overlay || !active) {
      setPopout(null);
      setMenuOpen(false);
    }
  }, [overlay, active]);

  // Only on a reading we have: a dropped health poll must not close the
  // composer, or the microphone, on a conversation that would have worked.
  const assistantOff = health.data?.assistant.enabled === false;
  // Why the switch is on and the assistant cannot answer anyway, if it cannot.
  // What turns the resting core red, and what the caption under it says.
  const unavailable = assistantOff ? null : whyUnavailable(health);

  const chat = useConversation({ active, off: assistantOff, unavailable: unavailable !== null });

  // On only while its card is out. Putting the card away, leaving this screen
  // and hiding the tab all mean nobody is looking at it, and a live camera
  // nobody is looking at is a light on for no reason. Same rule the microphone
  // follows, and it is why coming back needs a press.
  const camera = useCamera({ active: active && popout === "optics" });

  // Each interval is the rate the thing behind it actually changes at, not a
  // single "refresh rate". The machine sample is read only while the menu is
  // out or the Stats overlay is open — the menu's panel warns when the sample
  // is stale, and Stats draws it — because a sample nobody is looking at is a
  // PowerShell start on the worker every ten seconds. **Both halves matter**:
  // opening Stats from the menu closes the menu in the same commit, so a gate
  // on the menu alone would freeze the gauges on the one screen that shows them.
  const system = usePolled(api.getSystemStats, {
    intervalMs: 5_000,
    active: active && (menuOpen || overlay === "stats"),
  });
  const weather = usePolled(api.getWeather, { intervalMs: 600_000, active });
  // How many proposals wait on the Facts panel's head. Read only while the menu
  // is out, the one place the count is drawn: proposals arrive at most once a
  // conversation has sat quiet for twenty minutes, so a minute is plenty, and
  // opening the menu reads at once. The Facts overlay reads its own list on
  // open, so a decision there shows here the next time the menu comes out.
  const facts = usePolled(api.listFacts, { intervalMs: 60_000, active: active && menuOpen });
  // Unread pins on the News panel's head, on the same terms: pins change when
  // the owner pins or reads something, and the menu is the one place counted.
  const pins = usePolled(api.listPins, { intervalMs: 60_000, active: active && menuOpen });
  // The window is built inside the callback rather than above it, so a tab left
  // open overnight asks for the new day on its next poll instead of holding
  // yesterday's bound until something remounts. Two minutes is cheap: the
  // server asks a provider only once a feed's own five minutes are up, and serves
  // every poll in between from what it read last.
  const calendar = usePolled(
    () => {
      const today = cal.localDate();
      return api.getCalendar({ from: today, to: cal.shiftDate(today, 7) });
    },
    { intervalMs: 120_000, active },
  );

  // The countdown under the agenda's title, and the rule that drops what has
  // finished, move on the minute rather than on the poll.
  const now = useNow();

  useEffect(() => onOrbState?.(chat.orb), [chat.orb, onOrbState]);

  const narrow = useWindowDimensions().width < MENU_BREAKPOINT;

  // The line is open or opening — the permission prompt counts, since the
  // press has already been made.
  const onCall = chat.session.status !== "disconnected";

  // Closed while a write is parked, a run is going, or Anthropic is switched
  // off — a spoken question runs the same loop and gets the same refusal, and
  // finding that out by talking to a machine for ten seconds is worse than
  // finding it out from a closed button.
  const talkClosed = chat.busy || assistantOff;

  const { prefs: assistantPrefs } = useAssistantPrefs();

  /**
   * The thread an automation opened that nobody has looked at yet.
   *
   * A scheduled conversation is delivered on the first load past its hour
   * (`useDueAutomations`), and it arrives as a **different thread** from the
   * one on screen — so the unread signal below, which watches the thread you
   * are in, cannot see it on its own. This is the other half: it lights "new
   * reply" the same way, and it is what opening the Assistant lands on.
   *
   * **The thread is switched here when nothing would be lost** — no run going,
   * no write parked, no call, nothing staged or typed on the composer, and the
   * Assistant not already open. Then the greeting is written in front of you:
   * the core turns as the run streams and the ordinary unread path takes over,
   * because it is now the thread you are in. When any of that is true the
   * switch is declined and the mark waits instead, since the answer to whatever
   * you are in the middle of would land in a thread you had just been moved
   * out of.
   *
   * **Looking at it is what clears it**, not the switch: the Assistant open on
   * Chat, on that thread. Until then the chip stays up.
   */
  const [greeting, setGreeting] = useState<Delivered | null>(null);

  useDueAutomations({
    active,
    onDelivered: (conversationId, name) => {
      setGreeting({ id: conversationId, name });
      // A thread that did not exist a moment ago: without this it is missing
      // from the Assistant's own list until something else re-reads it.
      chat.refreshThreads();
    },
  });

  /** Something on the composer that switching threads would take away. */
  const staged = chat.snapshot !== null || chat.draft.trim() !== "";

  useEffect(() => {
    if (greeting === null || chat.activeId === greeting.id) return;
    if (full || chat.busy || onCall || staged) return;
    chat.openThread(greeting.id);
    // `chat` itself is left out on purpose: it is a new object every render,
    // and what this reacts to is the five facts named here — the same rule the
    // unread effect below follows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [greeting, chat.activeId, chat.busy, full, onCall, staged]);

  useEffect(() => {
    if (greeting !== null && full && assistantTab === "chat" && chat.activeId === greeting.id) setGreeting(null);
  }, [greeting, full, assistantTab, chat.activeId]);

  /**
   * The delivered greeting's own words, ready to be read out loud.
   *
   * Three conditions, and each one is a different way of not having them. It has
   * to be **the thread on screen** — the switch above is what puts it there, and
   * its own gate is "nothing would be lost", so a greeting that arrived while you
   * were mid-run is not offered out loud either; the chip waits instead. The run
   * has to be **finished** (`busy`), or what would be spoken is half a streamed
   * sentence. And the turn has to have **said something**: a greeting whose run
   * failed leaves a thread with no assistant text in it, and the outcome for that
   * is on the row in the Automations overlay.
   *
   * Read out of the transcript rather than fetched, because the transcript is
   * already here and already right. A second read of the same conversation would
   * be a second answer to "what does it say", which is the rule the HUD's polls
   * follow too.
   */
  const greetingText =
    greeting !== null && chat.activeId === greeting.id && !chat.busy ? lastSaidText(chat.items) : null;

  /**
   * Whether the greeting can be *heard*, as against read.
   *
   * The microphone has to be able to open a line at all (`supported`, and the
   * switch on — a spoken greeting goes through `/api/voice/token` like every
   * other session), and there must not be one open already: the button is the way
   * to end a call while one is up, and a press that hung up on somebody in order
   * to read them a greeting would be absurd.
   */
  const offer: Delivered & { text: string } | null =
    greeting !== null &&
    greetingText !== null &&
    greetingText.trim() !== "" &&
    chat.session.supported &&
    !onCall &&
    !talkClosed
      ? { ...greeting, text: greetingText }
      : null;

  /**
   * Opens the Assistant overlay, on `tab` if one is named and on the tab last
   * shown otherwise. ⌘K and a capture name Chat, because both are about typing.
   *
   * **"Opening the Assistant shows a new chat"** (Assistant → Settings) starts
   * an empty thread here, on the way in — unless doing so would take something
   * away: a call in progress or a run going (their answers land in the thread
   * being left), a write parked on an approval card, a frame staged on the
   * composer, or words typed into it. `keepThread` is the capture's way of
   * saying the frame it just staged is the reason for opening.
   *
   * **A greeting an automation delivered outranks both**: opening the Assistant
   * is how a scheduled conversation is read, so it lands on that thread rather
   * than on a new one.
   */
  const openAssistant = (tab?: AssistantTab, keepThread = false) => {
    if (tab) setAssistantTab(tab);
    if (greeting !== null) {
      chat.openThread(greeting.id);
    } else if (
      !full &&
      !keepThread &&
      assistantPrefs.openOn === "new" &&
      chat.activeId !== null &&
      !chat.busy &&
      !onCall &&
      chat.snapshot === null &&
      chat.draft.trim() === ""
    ) {
      chat.startNewThread();
    }
    setOverlay("assistant");
  };

  /**
   * The assistant has said something and nobody has seen it: "new reply" on the
   * core menu's Assistant title, and a line under the core. It was a dot on the
   * chat button until 13.0, when the button went.
   *
   * The signal is the **key of the last thing it said**, not a message count.
   * A count moves on a thread switch, on a tool chip landing, and on an
   * optimistic turn being swapped for the server's copy — three things that
   * are not the assistant answering you. `lastSaidKey` skips the user's own
   * turns for the same reason.
   *
   * **A spoken answer is not unread — it was heard.** A voice turn is written
   * into this same thread, so without the second half of `adopt` every answer
   * given out loud would light a dot advertising something the user has just
   * listened to. While a session is open, what lands in the thread is adopted
   * exactly as if the transcript were on screen.
   *
   * **What is already in a thread is adopted, not announced.** A conversation
   * you have only just opened — including the one the hook loads on boot — has
   * not said anything *since* anything, so a dot on every reload would be a
   * dot that stops meaning anything. That is why `loading` is remembered
   * beside the key rather than `chat.loadingThread` being read on its own:
   * the flag goes false in the *same commit* that carries the loaded
   * transcript, so the render the whole thread lands on is the one **after**
   * loading was last true. Adopting only while the flag is up would announce
   * every thread the moment it arrived.
   *
   * **Reading it is looking at the Chat tab**, not merely having the overlay
   * up: a reply that lands while Assistant → Settings is showing has not been
   * seen. And with "Announce new replies" off, everything is adopted, so turning
   * it back on does not announce a reply from an hour ago.
   *
   * A ref rather than state, because seeing something is not a reason to draw
   * the screen again; the signal itself is the only part worth a render.
   */
  const [unread, setUnread] = useState(false);
  const seen = useRef<{ thread: number | null; key: string | null; loading: boolean }>({
    thread: null,
    key: null,
    loading: false,
  });

  useEffect(() => {
    const key = lastSaidKey(chat.items);
    // Looking at it is reading it, and hearing it is too.
    const adopt =
      seen.current.thread !== chat.activeId ||
      chat.loadingThread ||
      seen.current.loading ||
      (full && assistantTab === "chat") ||
      onCall ||
      !assistantPrefs.unreadSignal;

    if (adopt) setUnread(false);
    else if (key !== null && key !== seen.current.key) setUnread(true);

    seen.current = {
      thread: chat.activeId,
      // Held rather than advanced while the dot is up: what clears it is
      // opening the conversation, not the next thing the assistant says.
      key: adopt ? key : seen.current.key,
      loading: chat.loadingThread,
    };
  }, [chat.items, chat.activeId, chat.loadingThread, full, assistantTab, onCall, assistantPrefs.unreadSignal]);

  /** Either kind: the thread you are in has answered, or one of them is waiting. */
  const somethingToRead = unread || greeting !== null;

  /**
   * The keys the HUD answers to.
   *
   * **⌘K is the keyboard's way to the typed conversation**: it opens the
   * Assistant on Chat and closes it again. Over the Assistant's Settings tab it
   * goes to Chat rather than closing, since Chat is what it names. Not the microphone — a key pressed on a keyboard is a
   * person about to type, and opening a line to a third party on a shortcut
   * nobody can see being pressed is the one thing the microphone must never do.
   *
   * **Bound only while the HUD is active.** It is the only screen, but `active`
   * also goes false with the tab, and a shortcut acting on a page nobody is
   * looking at is one nothing on screen reports.
   *
   * **Escape takes away the top thing, one per press**: an overlay, else the
   * core menu, else a corner card. One listener rather than one per layer,
   * because two listeners that both acted on every press would take two things
   * away for one keystroke. ⌘K over Settings swaps it for the conversation
   * (or Fitness) rather than opening one behind the other — see `overlay`.
   *
   * `preventDefault` on ⌘K because Chrome and Firefox both spend it on the
   * address bar, and a shortcut the browser eats is a shortcut that does not
   * exist.
   *
   * **It listens in the capture phase, and that is not a detail.** RN-Web's
   * `TextInput` calls `e.stopPropagation()` on *every* keydown — unconditionally,
   * to keep key events from bubbling — so a listener bound the ordinary way
   * never hears a key pressed while the composer has focus. Which is to say:
   * Escape worked everywhere except inside the conversation it is meant to
   * close, and ⌘K stopped working the moment you clicked into the box. Capture
   * runs from the window down, before the target, so nothing downstream can
   * swallow it. Found in a browser; the native preset renders through
   * `react-test-renderer` and has no DOM propagation to swallow anything, so
   * the suite could only ever have agreed with the bug.
   */
  useEffect(() => {
    if (!active) return;

    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (full && assistantTab === "chat") setOverlay(null);
        else openAssistant("chat");

        return;
      }

      if (e.key !== "Escape") return;

      if (overlay) setOverlay(null);
      else if (menuOpen) setMenuOpen(false);
      else if (popout) setPopout(null);
    };

    window.addEventListener?.("keydown", onKey, true);

    return () => window.removeEventListener?.("keydown", onKey, true);
  });

  const panels = menuPanels({
    // A row that acts puts the menu away first: what it opens is the thing
    // being looked at now, and the menu would be in front of it.
    act: (fn) => () => {
      setMenuOpen(false);
      fn();
    },
    openFitness: () => setOverlay("fitness"),
    openAssistant: () => openAssistant(),
    openSettings: () => setOverlay("settings"),
    openStats: () => setOverlay("stats"),
    openFacts: () => setOverlay("facts"),
    openAutomations: () => setOverlay("automations"),
    openProfile: () => setOverlay("profile"),
    openRecords: () => setOverlay("records"),
    openNews: () => setOverlay("news"),
    account,
    unread: somethingToRead,
    toReview: facts.data?.proposed.length ?? 0,
    unreadPins: pins.data?.unread ?? 0,
    system,
  });

  return (
    <View {...HUD_SCOPE} style={s.root} testID="hud">
      <Graticule />

      <View style={s.columns}>
        <View style={s.centre} testID="hud-centre">
          <AssistantStage
            state={chat.orb}
            note={chat.session.note}
            unavailable={unavailable}
            menuOpen={menuOpen}
            unread={somethingToRead}
            onCore={flipMenu}
            card={offer && <GreetingCard name={offer.name} text={offer.text} />}
            buttons={
              <>
                <OpticsButton open={popout === "optics"} onToggle={() => flipPopout("optics")} />
                <TalkButton
                  session={chat.session}
                  talkClosed={talkClosed}
                  // The one press that opens the line is also the press that
                  // reads the greeting out — see `TalkButton`.
                  greeting={offer?.text ?? null}
                  onSpoke={() => setGreeting(null)}
                />
              </>
            }
          />

          {/* The camera card, at the top of the core's column, above the
              sphere (the owner's call): its button is under the sphere, so nothing
              covers the core. */}
          <View style={s.opticsTrack} testID="hud-optics-track">
            <OpticsCard
              camera={camera}
              open={popout === "optics"}
              onClose={() => setPopout(null)}
              attached={chat.snapshot !== null}
              onCapture={(frame) => {
                chat.attachSnapshot(frame);
                // The frame lands on the composer, and the composer is inside
                // the full Assistant — so a capture that left it shut would put
                // the picture somewhere the user cannot see it and cannot type
                // alongside it. On Chat, and never a new thread: the frame is
                // staged on this one.
                openAssistant("chat", true);
              }}
            />
          </View>
        </View>

        {/* Over the core's column and under the corner buttons, which stay
            pressable while it is out. */}
        <CoreMenu
          open={menuOpen}
          narrow={narrow}
          panels={panels}
          onClose={() => setMenuOpen(false)}
        />

        {/* Top right, where the Settings gear was: the agenda. Settings moved
            into the core menu. */}
        <PopoutTrack corner="top-right" testID="hud-popouts-top-right">
          <AgendaPopout
            calendar={calendar}
            now={now}
            open={popout === "agenda"}
            onToggle={() => flipPopout("agenda")}
            onClose={() => setPopout(null)}
          />
        </PopoutTrack>

        {/* Bottom left, the weather. */}
        <PopoutTrack corner="bottom-left" testID="hud-popouts">
          <WeatherPopout
            weather={weather}
            open={popout === "weather"}
            onToggle={() => flipPopout("weather")}
            onClose={() => setPopout(null)}
          />
        </PopoutTrack>
      </View>

      {/* Outside the columns, over all of them — the microphone included,
          because this is the typed conversation and the microphone is not a
          part of it. It stops at the chrome bar, because the bar is how you go
          somewhere else entirely and an overlay you could only leave the way
          you came is a worse place to be than a screen. */}
      <AssistantOverlay
        chat={chat}
        open={full}
        onClose={() => setOverlay(null)}
        tab={assistantTab}
        onTab={setAssistantTab}
        assistantOff={assistantOff}
        unavailable={unavailable}
        health={health}
      />

      <GlassOverlay
        testID="hud-settings"
        spine="SETTINGS"
        open={overlay === "settings"}
        onClose={() => setOverlay(null)}
        closeLabel="Close Settings"
        head={
          <GlassStatus>
            Your calendars and how the app looks
          </GlassStatus>
        }
      >
        <SettingsView
          active={active && overlay === "settings"}
          // A calendar added, recoloured or switched off shows on the agenda
          // when Settings closes, not two minutes later.
          onCalendarsChanged={calendar.refresh}
        />
      </GlassOverlay>

      <GlassOverlay
        testID="hud-fitness"
        spine="FITNESS"
        open={overlay === "fitness"}
        onClose={() => setOverlay(null)}
        closeLabel="Close Fitness"
        head={<GlassStatus>Training, the catalog, the weekly assessment and their settings</GlassStatus>}
      >
        <FitnessView
          active={active && overlay === "fitness"}
          tab={fitnessTab}
          onTab={setFitnessTab}
        />
      </GlassOverlay>

      <GlassOverlay
        testID="hud-stats"
        spine="STATS"
        open={overlay === "stats"}
        onClose={() => setOverlay(null)}
        closeLabel="Close Stats"
        head={<GlassStatus>This machine, and a diagnosis of everything that runs on it</GlassStatus>}
      >
        {/* The HUD's `system`, not a poller of its own: the menu's stale note
            reads it too, and two polls of one endpoint are two answers that
            disagree for a poll at a time. */}
        <StatsView active={active && overlay === "stats"} system={system} />
      </GlassOverlay>

      {account && (
        <GlassOverlay
          testID="hud-profile"
          spine="PROFILE"
          open={overlay === "profile"}
          onClose={() => setOverlay(null)}
          closeLabel="Close Profile"
          head={<GlassStatus>Your account, the browsers signed in to it, and who has tried</GlassStatus>}
        >
          <ProfileView active={active && overlay === "profile"} user={account.user} onSignOut={account.signOut} />
        </GlassOverlay>
      )}

      <GlassOverlay
        testID="hud-facts"
        spine="FACTS"
        open={overlay === "facts"}
        onClose={() => setOverlay(null)}
        closeLabel="Close Facts"
        head={<GlassStatus>What the assistant knows about you, and what it would like to</GlassStatus>}
      >
        <FactsView active={active && overlay === "facts"} />
      </GlassOverlay>

      <GlassOverlay
        testID="hud-automations"
        spine="AUTOMATIONS"
        open={overlay === "automations"}
        onClose={() => setOverlay(null)}
        closeLabel="Close Automations"
        head={<GlassStatus>The conversations the assistant opens on its own, and how the last one went</GlassStatus>}
      >
        <AutomationsView active={active && overlay === "automations"} />
      </GlassOverlay>

      <GlassOverlay
        testID="hud-records"
        spine="RECORDS"
        open={overlay === "records"}
        onClose={() => setOverlay(null)}
        closeLabel="Close Records"
        head={<GlassStatus>The documents on file, and the dates somebody must act on</GlassStatus>}
      >
        <RecordsView active={active && overlay === "records"} tab={recordsTab} onTab={setRecordsTab} />
      </GlassOverlay>

      <GlassOverlay
        testID="hud-news"
        spine="NEWS"
        open={overlay === "news"}
        onClose={() => setOverlay(null)}
        closeLabel="Close News"
        head={<GlassStatus>Local first, then each beat and your interests, and a pin for later</GlassStatus>}
      >
        <NewsView active={active && overlay === "news"} beat={newsBeat} onBeat={setNewsBeat} />
      </GlassOverlay>
    </View>
  );
}

type Overlay = "assistant" | "settings" | "fitness" | "stats" | "facts" | "automations" | "profile" | "records" | "news";

type Popout = "optics" | "weather" | "agenda";

/**
 * Below this width two columns of panels either side of the core stop fitting,
 * and the menu becomes one column over a scrim. The width the rails used to
 * start floating at, for the same reason.
 */
export const MENU_BREAKPOINT = 1100;

// ── The core menu's panels ───────────────────────────────────────────────────

/**
 * What the nine panels hold, built fresh on every render from the state they
 * read.
 *
 * The order is the owner's: Fitness, Assistant, System stats and Core down the left;
 * Facts, Automations, Records, News and Profile down the right. A row that acts goes through `act`,
 * which puts the menu away before doing the thing.
 *
 * **System stats opens Stats.** It was the old left rail, both halves of it —
 * the machine's gauges and the backing services — until the numbers got an
 * overlay of their own (`StatsView`). What is left on the panel is the host and
 * a warning when the sample has gone stale.
 *
 * **Facts opens the Facts overlay** (15.1), and says how many proposals wait
 * (15.2). **Automations opens the Automations overlay** (15.4), where the
 * scheduled conversations are.
 *
 * **Records is the seventh** (16.1), which makes the menu even at the owner's call:
 * eight panels, four a side, so each left panel sits level with one on the
 * right. The split is `CoreMenu`'s `floor(n/2)`, so Core is the fourth down
 * the left now.
 *
 * **News is the eighth** (19.3), which undoes that evenness: nine panels split
 * four and five, the fifth on the right. It follows from News being a panel
 * rather than a corner card, and Core stays fourth on the left.
 *
 * **Profile is always last** (the owner's call): a new panel goes above it. Its head
 * is the owner's photo and name and opens the Profile overlay; its rows are the
 * Google address and Sign out, which is one press here because leaving is what
 * people most often come to a profile for.
 */
function menuPanels(p: {
  act: (fn: () => void) => () => void;
  openFitness: () => void;
  openAssistant: () => void;
  openSettings: () => void;
  openStats: () => void;
  openFacts: () => void;
  openAutomations: () => void;
  openProfile: () => void;
  openRecords: () => void;
  openNews: () => void;
  account?: { user: AuthUser; signOut: () => void };
  unread: boolean;
  /** Proposed facts waiting on a decision. */
  toReview: number;
  /** Pinned stories not yet marked read. */
  unreadPins: number;
  system: Polled<SystemStats>;
}): MenuPanel[] {
  const { act, system } = p;

  // The title is the panel's one action (the owner's call): a row per tab was a second
  // copy of the tab bar the overlay already has. It opens on the tab last shown.
  const fitness: MenuPanel = {
    key: "fitness",
    title: "Fitness",
    rows: [],
    onPress: act(p.openFitness),
    accessibilityLabel: "Open Fitness",
  };

  // The same, since 13.0: Chat, Activity and Settings are the overlay's own tabs, the
  // microphone and the camera are buttons under the core, and the state is the
  // caption under it. What is left beside the title is a reply nobody has read.
  const assistant: MenuPanel = {
    key: "assistant",
    title: "Assistant",
    right: p.unread ? "new reply" : undefined,
    rows: [],
    onPress: act(p.openAssistant),
    accessibilityLabel: p.unread ? "Open the Assistant — a new reply" : "Open the Assistant",
  };

  // A destination since Stats got its own overlay (the owner's call), like Fitness and
  // Assistant: the gauges and the service rows had a menu panel's width and
  // were only up while the menu was held open. The host stays beside the title,
  // and the note stays too, but only when something is wrong — see `staleNote`.
  const systemPanel: MenuPanel = {
    key: "system",
    title: "System stats",
    right: system.data?.host ?? undefined,
    rows: [],
    onPress: act(p.openStats),
    accessibilityLabel: "Open Stats",
    note: staleNote(system),
  };

  // A destination like the rest (the owner's call): its Calendars and Appearance rows
  // both opened Settings at the top, so they were two ways to say one thing.
  // Units went to Fitness → Settings in 12.0 and the Anthropic switch to
  // Assistant → Settings in 13.0: each only changes the thing it sits beside.
  const core: MenuPanel = {
    key: "core",
    title: "Core",
    rows: [],
    onPress: act(p.openSettings),
    accessibilityLabel: "Open Settings",
  };

  // What the assistant has on file about the owner, and what it would like to
  // add (15.1). What the extractor proposed and nobody has decided (15.2) is
  // counted beside the title, the way Assistant says "new reply".
  const facts: MenuPanel = {
    key: "facts",
    title: "Facts",
    right: p.toReview > 0 ? `${p.toReview} to review` : undefined,
    rows: [],
    onPress: act(p.openFacts),
    accessibilityLabel: p.toReview > 0 ? `Open Facts — ${p.toReview} to review` : "Open Facts",
  };

  // The conversations the assistant opens on its own (15.4). No rows: a
  // scheduled conversation is a card's worth of settings, and the overlay is
  // where it is read and changed.
  const automations: MenuPanel = {
    key: "automations",
    title: "Automations",
    rows: [],
    onPress: act(p.openAutomations),
    accessibilityLabel: "Open Automations",
  };

  // What the secretary keeps (16.1): documents now, deadlines in 16.3. No rows,
  // like Automations — the overlay is where a document is read and changed.
  const records: MenuPanel = {
    key: "records",
    title: "Records",
    rows: [],
    onPress: act(p.openRecords),
    accessibilityLabel: "Open Records",
  };

  // The news (19.3): a beat's latest and the owner's interests, and the pins.
  // No rows, like Records. Always here, whether or not an agent that owns the
  // news exists or is on — agents decide what the model is offered, not what
  // the owner may read. Unread pins are counted beside the title, as Facts counts.
  const news: MenuPanel = {
    key: "news",
    title: "News",
    right: p.unreadPins > 0 ? `${p.unreadPins} unread pinned` : undefined,
    rows: [],
    onPress: act(p.openNews),
    accessibilityLabel: p.unreadPins > 0 ? `Open News — ${p.unreadPins} unread pinned` : "Open News",
  };

  const panels = [fitness, assistant, systemPanel, core, facts, automations, records, news];

  // Always last (the owner's call): the account is where the menu ends, whatever is
  // added above it.
  if (p.account) {
    const { user, signOut } = p.account;
    panels.push({
      key: "profile",
      title: user.name,
      avatar: { uri: user.avatar_url, initials: initials(user.name) },
      rows: [
        { kind: "readout", key: "email", label: user.email },
        { kind: "action", key: "sign-out", label: "Sign out", onPress: act(signOut) },
      ],
      onPress: act(p.openProfile),
      accessibilityLabel: "Open Profile",
    });
  }

  return panels;
}

/**
 * The System stats panel's note: said only when something is wrong.
 *
 * With no rows under it, an age is a caption for a reading nobody can see — so
 * a fresh sample says nothing, the reason there is no `AI ON` chip. It is kept
 * for the other case, because a climbing age is the second, independent sign
 * that the queue worker is dead, and the menu is where you are before you open
 * anything.
 *
 * **The null guard is load-bearing.** `isStale(null)` is true, and
 * `age_seconds` is null both before the first sample and on the beat after the
 * menu opens (the poll starts with it) — so a bare `isStale` would flash
 * "Sample stale — never" on every open.
 */
function staleNote(system: Polled<SystemStats>): MenuPanel["note"] {
  const stats = system.data;
  if (!stats) return undefined;
  if (system.error) return { text: "Couldn't refresh — showing the last reading.", warn: true };
  if (stats.age_seconds !== null && fmt.isStale(stats.age_seconds)) {
    return { text: `Sample stale — ${fmt.age(stats.age_seconds)}`, warn: true };
  }
  return undefined;
}

/**
 * The graticule behind everything — the faint grid that makes a dark screen
 * read as an instrument rather than as an empty page. An SVG `<pattern>`, so it
 * is two elements at any size instead of a hundred hairline views, and it is
 * `--h-grid`, which only has a value inside the HUD.
 */
function Graticule() {
  return (
    <View style={s.graticule} testID="hud-graticule">
      <svg width="100%" height="100%" aria-hidden="true" focusable="false">
        <defs>
          <pattern id="hud-grid" width="48" height="48" patternUnits="userSpaceOnUse">
            <path d="M 48 0 L 0 0 0 48" fill="none" stroke={hud.grid} strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#hud-grid)" />
      </svg>
    </View>
  );
}

// ── The centre column ────────────────────────────────────────────────────────

/**
 * What the core is doing, in words, under the core.
 *
 * Copy rather than fixtures, which is why these outlived `hudSample.ts`:
 * `satisfies` rather than a cast, because `as Record<OrbState, string>`
 * type-checks a table that is missing half its keys, and the failure is
 * `undefined` printed under the sphere.
 */
const CAPTION = {
  idle: "Standing by",
  listening: "Listening",
  speaking: "Speaking",
  working: "Working",
  responding: "Answering",
  awaiting: "Waiting on you",
  failed: "That run failed",
  off: "Switched off",
} satisfies Record<OrbState, string>;

const HINT = {
  // The buttons under the core are icons and nothing else, and `title` is not
  // a prop React Native forwards, so this is where they are explained — and the
  // only place ⌘K is written down. It is read by someone looking at a HUD with nothing
  // running on it, which is exactly who is about to press one.
  //
  // **Where the audio goes is not optional.** It was the line under the
  // composer while Talk lived there; the microphone opens a line to a third
  // party, and a button that does not say so is not asking for consent, it is
  // assuming it. So it is said before the press and during the call.
  idle: "Nothing running. Press the microphone to talk — audio goes to ElevenLabs — or ⌘K to type.",
  listening: "Listening — everything said here goes to ElevenLabs until you stop.",
  speaking: "Answering out loud. Talk over it to interrupt.",
  // Not "your training history" any more: the same loop reads the calendar and
  // the weather, and answers plenty from what it already knows.
  working: "Looking it up.",
  responding: "Writing the answer now.",
  awaiting: "A write is parked until you approve it.",
  failed: "The last turn didn't come back. Try again.",
  off: "The Anthropic API is switched off. Turn it back on under Assistant → Settings — click the core, then Assistant.",
} satisfies Record<OrbState, string>;

/** Under an idle core, when the assistant has said something nobody has read. */
export const UNREAD_HINT = "A new reply — ⌘K, or click the core and then Assistant.";

/**
 * Why the assistant cannot answer although the switch is on, or null if
 * nothing stands in the way.
 *
 * Read off the same health poll as the System stats panel, and only the failures
 * that stop a question outright: the API out of reach, the database down, no
 * key, an account Anthropic last refused for lack of credit (it clears on the
 * next call that goes through, so it never stops anyone asking), or a queue
 * worker that has stopped — a typed message then sits at
 * `queued` forever, which is the silent failure the heartbeat exists to catch.
 * A worker that has **never** beaten is `unknown`, not `down`, and stays out,
 * for the reason the System stats panel keeps them apart.
 *
 * **Nothing is claimed without a reading.** Still loading is not a failure, and
 * a poll that fails after a good one keeps the last reading (the pill says
 * `STALE`) — one dropped request must not turn the core red for fifteen seconds.
 */
export function whyUnavailable({ data, loading }: Polled<Health>): string | null {
  if (!data) return loading ? null : "Can't reach the API.";
  if (data.database.state === "down") return "The database isn't answering.";
  if (data.assistant.state === "down") return "There's no ANTHROPIC_API_KEY in backend/.env.";
  if (data.assistant.credit?.exhausted) return "Anthropic is out of credit — top up at console.anthropic.com.";
  if (data.queue.state === "down") return "The queue worker is down, so typed messages won't run.";

  return null;
}

/**
 * The middle of the screen is the core, and nothing else.
 *
 * It used to be an orb at 132px with the transcript stacked under it, which
 * made the assistant's state a caption on a chat window. That is backwards for
 * a screen you leave open: the thing you glance at from across the room is
 * whether it is turning, and the conversation is what you come over to read.
 *
 * So it takes the column, and does so **without anyone measuring the column**.
 * `fill` puts the SVG at 100% of a square box and the `viewBox` does the scaling
 * — no `onLayout` round trip, no painted frame at the wrong size, and it re-fits
 * on a window resize for free.
 *
 * **There is no preview row any more.** A row of buttons under the core walked
 * every state, for reviewing the ones nothing could reach on demand. The owner removed
 * it in Phase 11. The core now shows only what is actually happening, so its
 * voice ring is always driven by real audio (`voiceDriven`).
 *
 * **`note` is the voice's line, and it only speaks over an idle core.** A line
 * still opening, a session that failed, a browser that cannot hold one — none
 * of those is an orb state, and the failure in particular would otherwise
 * vanish with the session it tore down. Once anything is actually running, what
 * it is doing is the more useful sentence.
 *
 * **A reply nobody has read is the third**, over an idle core only — anything
 * happening is still the more useful sentence.
 *
 * **`unavailable` is the other line that replaces the table's**: a red core
 * because the assistant cannot be reached is not "that run failed", and the
 * caption says which of the two it is and why.
 */
function AssistantStage({
  state,
  note,
  unavailable,
  menuOpen = false,
  unread = false,
  onCore,
  card,
  buttons,
}: {
  state: OrbState;
  note: string | null;
  unavailable: string | null;
  /** While the core menu is out, the caption says how to put it away. */
  menuOpen?: boolean;
  /** Whether the assistant has said something nobody has read. */
  unread?: boolean;
  /**
   * A delivered greeting waiting to be heard, if there is one — the only thing
   * that ever sits between the core and its buttons.
   */
  card?: React.ReactNode;
  /** Clicking the core opens and closes the core menu. */
  onCore?: () => void;
  /**
   * The camera's and the microphone's buttons, side by side between the core
   * and its caption (the owner's calls). The camera's card is at the top of the
   * column, above the sphere. In the stage's own flow, so they stay centred on
   * the core.
   */
  buttons?: React.ReactNode;
}) {
  const blocked = state === "failed" ? unavailable : null;
  const idleLine = state === "idle" ? (note ?? (unread ? UNREAD_HINT : null)) : null;
  const hint = menuOpen
    ? "Pick a module. Click the core again to close it."
    : blocked ?? idleLine ?? HINT[state];
  const caption = menuOpen ? "Core menu" : blocked ? "Unavailable" : CAPTION[state];

  // Hover and press are held here rather than read off RN-Web's Pressable
  // state, so the ring and the lift are plain props a test can see.
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  // True for the moment after the pointer leaves, while the ring unwinds.
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!leaving) return;
    const done = setTimeout(() => setLeaving(false), RING_OUT_MS);

    return () => clearTimeout(done);
  }, [leaving]);
  // One per click. It keys the ping ring, so every click remounts it and its
  // one-shot animation plays again; zero means nothing has been clicked yet.
  const [clicks, setClicks] = useState(0);

  const tint = coreTint(state);
  const ring = coreRing({ menuOpen, hovered, pressed, leaving });

  return (
    <View style={s.stage}>
      {/* The core is the menu's button. Its state is still the sphere's own
          label, inside; this names what a click does. */}
      <Pressable
        onPress={() => {
          setClicks((n) => n + 1);
          onCore?.();
        }}
        onHoverIn={() => {
          setLeaving(false);
          setHovered(true);
        }}
        onHoverOut={() => {
          setHovered(false);
          setPressed(false);
          setLeaving(true);
        }}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        accessibilityRole="button"
        accessibilityLabel="Core menu"
        accessibilityState={{ expanded: menuOpen }}
        aria-expanded={menuOpen}
        style={s.orbBox}
        testID="hud-core"
      >
        {/* The sphere leans in on hover and gives under the press. Scaled on
            a wrapper, so the Pressable's hit box never moves under the
            pointer (a box that shrank away from the cursor would flicker
            hover on and off at its edge). */}
        <View
          style={[
            s.coreLift,
            transition("transform", pressed ? 90 : 260),
            { transform: [{ scale: pressed ? 0.97 : hovered ? 1.03 : 1 }] },
          ]}
          testID="hud-core-lift"
        >
          <HolographicCore state={state} voiceDriven />
        </View>

        {/* The ring that says the core is a button, in the core's own
            colour. See `coreRing`. An SVG circle rather than a bordered
            View, because drawing it round needs a stroke to dash. Its
            animations are inline: RN-Web's StyleSheet.create drops them. */}
        <View
          key={ring.mode}
          style={[
            s.coreRing,
            transition("opacity, transform", pressed ? 90 : 260),
            ring.style as never,
          ]}
          testID="hud-core-ring"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <svg width="100%" height="100%" viewBox="0 0 100 100" aria-hidden="true" focusable="false" style={{ overflow: "visible" }}>
            <circle
              cx={50}
              cy={50}
              r={49.5}
              fill="none"
              stroke={tint}
              strokeWidth={ring.width}
              vectorEffect="non-scaling-stroke"
              pathLength={100}
              strokeDasharray="100 100"
              // From twelve o'clock, going clockwise.
              transform="rotate(-90 50 50)"
              style={{ strokeDashoffset: 0, ...ring.stroke }}
              data-testid="hud-core-ring-circle"
            />
          </svg>
        </View>

        {/* After a click, one ring races out from the sphere and fades. Keyed
            by the click, so the next click plays it again. */}
        {clicks > 0 && (
          <View
            key={clicks}
            // The animation is inline: RN-Web's StyleSheet.create drops
            // `animation`, as the panels' blink found out.
            style={[s.coreRing, s.corePing, { borderColor: tint, animation: CORE_PING } as never]}
            testID="hud-core-ping"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
        )}
      </Pressable>

      {/* Between the sphere and the button it points at, in the stage's own
          flow. The camera's card is absolute and paints *over* the core where a
          short window makes them meet; this one takes its room instead, so the
          sphere gives up a little height while a greeting waits. The two differ
          because of what they would cover: nothing is lost behind a picture of
          the core, and a card over the caption would be words over words. */}
      {card}

      <View style={s.buttons} testID="hud-optics-slot">
        {buttons}
      </View>

      <Text style={s.stageState}>{caption}</Text>
      <Text style={s.stageHint} testID="hud-stage-hint">
        {hint}
      </Text>
    </View>
  );
}

/** The ring that races out after a click. Plays once per mount. */
const CORE_PING = "hud-core-ping 700ms cubic-bezier(.16,.84,.24,1) 1";

/**
 * The microphone's ring while a greeting waits to be heard.
 *
 * The core's beckon, slower: that one says "this can be clicked" to somebody
 * already looking at it, and this one has to be noticed by somebody who has just
 * sat down. Nothing else on an idle HUD moves on a two-and-a-half second period.
 */
const MIC_WAIT = "hud-core-beckon 2400ms cubic-bezier(.2,.6,.3,1) infinite";

/** How long the ring takes to unwind after the pointer leaves. */
const RING_OUT_MS = 360;

const EASE_IN_RING = "cubic-bezier(.16,.84,.24,1)";

type RingMode = "beckon" | "in" | "press" | "out" | "open";

/**
 * How the ring round the core looks, which is how the core says it can be
 * clicked. It is always the core's own colour (`coreTint`): cyan, amber while
 * switched off or waiting, red when it failed.
 *
 * - **At rest, shut:** a faint ring breathes outwards from the sphere every few
 *   seconds (`hud-core-beckon`). A sphere that is also a button looks exactly
 *   like a sphere, so something has to invite the click. Slow and faint, because
 *   the HUD is left open all day and a fast pulse would nag.
 * - **Hover (`in`):** the ring closes in from further out while it draws itself
 *   round the sphere from twelve o'clock (`hud-core-ring-in` and
 *   `hud-core-ring-draw`). It used to just appear, which read as a glitch.
 * - **Pressed:** the ring pulls in tight and bright under the press.
 * - **Pointer gone (`out`):** the reverse, briefly: it unwinds and drifts
 *   out, then the beckon comes back. Skipped while the menu is open, where the
 *   ring stays.
 * - **Open:** a steady dim ring, because the core is now the way to close the
 *   menu and still a button.
 *
 * Each mode keys the ring element, so entering a mode restarts its animation.
 * Every animated mode also carries its end values as plain styles, so pressing
 * after the ring has drawn transitions from where the ring actually is.
 *
 * The click itself is the ping in `AssistantStage`. Motion is all CSS, so the
 * reduced-motion rule in `themeStylesheet` stops it.
 */
export function coreRing({
  menuOpen,
  hovered,
  pressed,
  leaving = false,
}: {
  menuOpen: boolean;
  hovered: boolean;
  pressed: boolean;
  leaving?: boolean;
}): { mode: RingMode; width: number; style: object; stroke: object } {
  if (pressed) {
    return { mode: "press", width: 2, style: { opacity: 1, transform: [{ scale: 0.96 }] }, stroke: {} };
  }

  if (hovered) {
    return {
      mode: "in",
      width: 1.5,
      style: {
        opacity: 0.9,
        transform: [{ scale: 1.06 }],
        animation: `hud-core-ring-in 520ms ${EASE_IN_RING} both`,
      },
      stroke: { animation: `hud-core-ring-draw 620ms ${EASE_IN_RING} both` },
    };
  }

  if (menuOpen) {
    return { mode: "open", width: 1, style: { opacity: 0.4, transform: [{ scale: 1.02 }] }, stroke: {} };
  }

  if (leaving) {
    return {
      mode: "out",
      width: 1.5,
      style: {
        opacity: 0,
        transform: [{ scale: 1.18 }],
        animation: `hud-core-ring-out ${RING_OUT_MS}ms ease-in both`,
      },
      stroke: { animation: `hud-core-ring-undraw ${RING_OUT_MS}ms ease-in both` },
    };
  }

  return {
    mode: "beckon",
    width: 1,
    style: { opacity: 0, animation: "hud-core-beckon 3600ms cubic-bezier(.2,.6,.3,1) infinite" },
    stroke: {},
  };
}

/**
 * The microphone: under the core, beside the camera's button, at its size.
 *
 * It was the 56px button in the bottom-right corner, with a chat button stacked
 * over it, until 13.0 (the owner's call). The chat button went — the typed conversation
 * is the core menu's Assistant title, or ⌘K — and the microphone came to the
 * core, whose state is what it changes.
 *
 * **The microphone does one thing.** It opens a spoken conversation and ends
 * it. **Accent-edged even at rest**, unlike the camera beside it, because it is
 * the control on a screen whose premise is that you talk to it across the room.
 *
 * **An icon and nothing else.** Its name is its accessibility label (what a
 * screen reader announces and what the tests find it by), and the caption under
 * the core says what it does and where its audio goes — see `HINT.idle`.
 *
 * **It is never closed while the line is open**: it is the way to end the call
 * then, and a control whose job is to end something must not be disabled by
 * the state it would end. It turns into a stop square on the press rather than
 * on the connect, for the same reason `talkLabel` does.
 *
 * There is no Mute: ending the call is how the room stops going anywhere, and
 * the agent's own silence timeout hangs up an idle line anyway.
 */
function TalkButton({
  session,
  talkClosed,
  greeting = null,
  onSpoke,
}: {
  session: AgentSessionController;
  /** Nothing may be *started* — a parked write, a run going, the switch off. */
  talkClosed: boolean;
  /**
   * A delivered greeting for the agent to open with, if one is waiting.
   *
   * **A press is the floor, and it is doing two jobs.** A browser will not let a
   * page make a sound until somebody has interacted with it, so a greeting that
   * read itself out the moment the HUD loaded is not something a browser can be
   * asked for. That constraint turns out to be the right behaviour anyway: an
   * open session bills by the minute, and a press is the one cheap way of
   * knowing somebody is actually in the room to hear it.
   */
  greeting?: string | null;
  /** The greeting has been handed to a session, so it is no longer waiting. */
  onSpoke?: () => void;
}) {
  // "Not idle" — the line is open, or is being opened.
  const open = session.status !== "disconnected";
  const closed = talkClosed && !open;
  const live = session.status === "connected";
  // A greeting can only be spoken by a line that is not open yet.
  const waiting = greeting !== null && !open && !closed;

  // Absent rather than disabled where the browser cannot hold a session: a
  // button that can never work is not a control. The caption under the core
  // says why — see `sessionNote`.
  if (!session.supported) return null;

  return (
    <Pressable
      // One press, one meaning, both ways round: this is a conversation rather
      // than a dictation, so there is no hold-to-talk gesture to distinguish.
      // ElevenLabs decides when a turn has ended.
      onPress={() => {
        // Not `onPress={session.toggle}` any more: RN-Web hands a press handler
        // its gesture event, and `toggle` now takes the words to open with.
        session.toggle(waiting ? greeting : undefined);

        // Marked spoken on the press rather than on the connect, and that is a
        // deliberate trade. A session that fails to open — no credits, a refused
        // microphone — has then consumed the greeting, so the card goes and the
        // chip with it. What makes that acceptable is that the greeting is *not*
        // lost: it is the thread already on screen (the card only appears once
        // it is), and the reason the line did not open is the caption under the
        // core a moment later. The alternative is a card that survives its own
        // press, which reads as a button that did nothing.
        if (waiting) onSpoke?.();
      }}
      disabled={closed}
      accessibilityRole="button"
      accessibilityLabel={waiting ? GREETING_LABEL : talkLabel(session.status)}
      accessibilityState={{ selected: open }}
      aria-pressed={open}
      style={({ hovered }: any) => [
        s.micBtn,
        (open || waiting || (!closed && hovered)) && s.micOpen,
        live && s.micLive,
        closed && s.micClosed,
      ]}
      testID="hud-talk"
    >
      {/* A ring that closes in and fades, over and over, until it is pressed —
          the core's own beckon (`coreRing`), reused at 40px rather than given a
          second set of keyframes. Motion is the only thing that reaches someone
          across the room, which is the whole situation a spoken greeting is for.
          Inline, because `StyleSheet.create` drops `animation` (RN-Web traps). */}
      {waiting && (
        <View
          style={[s.micWait, { animation: MIC_WAIT } as never]}
          pointerEvents="none"
          testID="hud-talk-waiting"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      )}

      {/* Decorative — the button is named above, and its state is announced
          through accessibilityState. */}
      {open ? (
        // Breathing while the line is opening, still once it is open: the wait
        // for a permission prompt and a peer connection is the one stretch
        // where nothing else on screen is moving yet.
        <StopIcon color={colors.accentTxt} pulse={!live} />
      ) : (
        <MicIcon color={colors.accentTxt} />
      )}
    </Pressable>
  );
}

/** A conversation an automation delivered, and the automation that delivered it. */
export type Delivered = { id: number; name: string };

/** What the microphone is called while it is holding a greeting. */
export const GREETING_LABEL = "Hear the greeting";

export const GREETING_HINT = "Press the microphone to hear it, or ⌘K to read it.";

/**
 * A greeting that has arrived and not been heard, between the core and the
 * microphone.
 *
 * **It is a preview, not the greeting.** Two lines of the opening and the name
 * of the automation that sent it — enough to know what is waiting and whether it
 * is worth two minutes of listening. The whole thing is in the thread, which is
 * one keystroke away and is where it stays: a card that grew to fit a morning
 * briefing would be a chat window in the middle of the HUD, which is the shape
 * Phase 11 spent its time removing.
 *
 * **It names the automation rather than saying "greeting"**, because an
 * automation is any scheduled conversation — the row is called *Morning
 * greeting* today and could as easily be an evening wrap-up, and a card that
 * called that a greeting would be describing the feature instead of the thing
 * that arrived.
 */
function GreetingCard({ name, text }: { name: string; text: string }) {
  return (
    <View {...GLASS_SCOPE} style={s.greetCard} testID="hud-greeting">
      <Text style={s.greetName}>{name.toUpperCase()}</Text>

      <Text style={s.greetText} numberOfLines={2}>
        {text}
      </Text>

      <Text style={s.greetHint}>{GREETING_HINT}</Text>
    </View>
  );
}

// Plain SVG, like the orb and the graticule: `stroke={colors.*}` puts a
// `var(--c-*)` into a presentation attribute, which Chromium resolves — so the
// icons re-theme inside `data-hud` with everything else.

function MicIcon({ color }: { color: string }) {
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
      <rect x={9} y={3} width={6} height={11} rx={3} />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
      <path d="M12 17.5V21" />
    </svg>
  );
}

function StopIcon({ color, pulse }: { color: string; pulse: boolean }) {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect
        x={7}
        y={7}
        width={10}
        height={10}
        rx={2}
        fill={color}
        style={pulse ? { animation: "hud-breathe 1200ms ease-in-out infinite" } : {}}
      />
    </svg>
  );
}

/**
 * The Assistant, given the whole window: the typed conversation, and its
 * settings beside it (`AssistantView`).
 *
 * The Assistant used to be a tab. Taking it out of the menu orphaned a screen
 * that is genuinely wanted — a long transcript needs room, and the thread list
 * has nowhere else to live — so it came back as an overlay rather than as a
 * destination. That is the argument 7.3b made of the calendar, applied to the
 * one screen the HUD was competing with: **a screen replaces the HUD, which is
 * the thing this whole design exists to leave open.** Over it, the machine and
 * the day are still there when it goes.
 *
 * It is the only place to type now. The popover that used to be a smaller copy
 * of it is gone, and so is the Talk button its composer carried: the
 * microphone is on the HUD, and this sits over it.
 *
 * It is reached from the core menu's Assistant title, ⌘K or a camera capture,
 * and closing it puts you back where you were.
 *
 * **The chrome is the design's console layout** — glass over a visibly live
 * HUD, an accent border, corner brackets, and ASSISTANT reading up the left
 * edge. The spine is why `VERTICAL_SCOPE` exists: `writing-mode` is not a
 * React Native style property, exactly as `backdrop-filter` is not, so it
 * rides a data attribute and a rule.
 *
 * There is no title beside the orb. The spine is the title, and a second one
 * 26px away from it would be the same word twice.
 *
 * Mounted at both ends like everything else here that animates, and therefore
 * inert rather than merely invisible while shut. The frame itself is
 * `GlassOverlay`, which Settings and Fitness share.
 *
 * **Escape closes it, and the listener is not here.** `Hud` holds the one
 * keyboard listener, beside ⌘K, which opens and closes this same overlay.
 */
function AssistantOverlay({
  chat,
  open,
  onClose,
  tab,
  onTab,
  assistantOff,
  unavailable,
  health,
}: {
  chat: ConversationController;
  open: boolean;
  onClose: () => void;
  tab: AssistantTab;
  onTab: (tab: AssistantTab) => void;
  assistantOff: boolean;
  unavailable: string | null;
  health: Polled<Health>;
}) {
  return (
    <GlassOverlay
      testID="hud-full"
      spine="ASSISTANT"
      open={open}
      onClose={onClose}
      closeLabel="Close full Assistant"
      head={
        <>
          <AssistantOrb state={chat.orb} />
          <GlassStatus>{(chat.orb === "failed" && unavailable) || STATUS[chat.orb]}</GlassStatus>
        </>
      }
    >
      <AssistantView
        active={open}
        tab={tab}
        onTab={onTab}
        chat={chat}
        assistantOff={assistantOff}
        health={health}
      />
    </GlassOverlay>
  );
}

/**
 * The overlay's status line, beside its orb.
 *
 * Its own table rather than `HINT`: they answer the same question from
 * different places — `HINT` is read under the core by someone who may not have
 * opened anything, and half of it tells you which button to press, which is a
 * strange thing to read inside what the button opened.
 */
const STATUS = {
  idle: "Ready when you are",
  listening: "Listening — the microphone is open",
  speaking: "Speaking — interrupt any time",
  working: "Working — looking it up",
  responding: "Writing the answer",
  awaiting: "Waiting on your decision",
  failed: "The last run didn't come back",
  off: "Switched off — see Settings",
} satisfies Record<OrbState, string>;

// ── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  graticule: { ...StyleSheet.absoluteFillObject, pointerEvents: "none" },

  columns: { flex: 1, flexDirection: "row" },

  // `overflow: hidden` so the shut drawer is clipped at the bottom edge rather
  // than hanging out over whatever is below the column.
  centre: { flex: 1, minWidth: 0, overflow: "hidden" },

  stage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    padding: spacing.lg,
  },
  // Square, taking whatever height the column has left over. `aspectRatio`
  // turns that into the width, and `maxWidth` stops it from doing so on a
  // column narrower than it is tall.
  orbBox: { flex: 1, aspectRatio: 1, maxWidth: "100%", maxHeight: 720, cursor: "pointer" },
  coreLift: { ...StyleSheet.absoluteFillObject },
  // A circle just outside the sphere: the core's radius is 285 of a 1000 box,
  // centred, and this is 1.1 times that (62.7% across, 18.65% in). Percentages,
  // so it follows the box at any size without measuring it.
  coreRing: {
    position: "absolute",
    left: "18.65%",
    top: "18.65%",
    width: "62.7%",
    height: "62.7%",
    pointerEvents: "none",
  },
  corePing: {
    borderRadius: 9999,
    borderWidth: 2,
    opacity: 0,
  },
  // The camera's and the microphone's buttons, side by side between the core
  // and the caption.
  buttons: { marginTop: spacing.sm, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  // The camera card's place: across the top of the core's column, centring
  // the card. `box-none` in StyleSheet.create, where RN-Web polyfills it (see
  // RN-Web traps), so the strip either side of the card takes no clicks. Above
  // the stage in the column's own stacking, so the card paints over the core
  // where a short window makes them meet.
  opticsTrack: {
    position: "absolute",
    top: spacing.md,
    left: spacing.md,
    right: spacing.md,
    alignItems: "center",
    pointerEvents: "box-none",
    zIndex: 1,
  },
  stageState: { ...type.title, color: colors.text, marginTop: spacing.sm },
  stageHint: { ...type.small, color: colors.textMuted, textAlign: "center" },

  // ── the microphone ──────────────────────────────────────────────────────────

  // The camera button's size and shape (`PopoutButton`), edged in the accent.
  micBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.accentBd,
    backgroundColor: colors.surface,
  },
  micOpen: { borderColor: colors.accent, backgroundColor: colors.accentBg },
  // The glow, once the line is actually open. Same props ConfirmDialog and
  // Dropdown raise themselves with, tinted rather than black because this one
  // is lit rather than raised.
  micLive: {
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.45,
    shadowRadius: 16,
    elevation: 6,
  },
  micClosed: { opacity: 0.45 },
  // The beckoning ring, the size of the button and free to grow past it (nothing
  // here sets `overflow`). `corePing`'s shape at 40px.
  micWait: {
    position: "absolute",
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: colors.accent,
    opacity: 0,
  },

  // ── the delivered greeting ──────────────────────────────────────────────────

  // Glass and an accent edge, like the popout cards and the overlays: it floats
  // over the HUD in the same way, so it reads as the same kind of thing. The
  // radius is the blur's too — see `Popout`.
  greetCard: {
    maxWidth: 420,
    marginTop: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderRadius: radii.lg,
    backgroundColor: colors.glass,
    borderColor: colors.accentBd,
    alignItems: "center",
    gap: 2,
  },
  greetName: { ...type.label, color: colors.accentTxt },
  greetText: { ...type.body, color: colors.text, textAlign: "center" },
  greetHint: { ...type.caption, color: colors.textMuted, textAlign: "center" },
});
