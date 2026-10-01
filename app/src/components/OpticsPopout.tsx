import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { PopoutButton, PopoutClose, popoutStyles } from "./Popout";
import { CapturedFrame } from "../camera";
import { CameraController } from "../useCamera";
import { GLASS_SCOPE, colors, radii, reachable, spacing, transition, type } from "../theme";

/**
 * Optics: a button under the core, just above its caption.
 *
 * The camera was the bottom panel of the left rail, under the machine's
 * telemetry. The owner then asked for it as a popout, on a button stacked over the
 * weather's. In Phase 11 it came to the core's column. The owner tried it top middle,
 * where a full card hid the sphere, and then as a lens inside the sphere. It
 * settled as **a button under the sphere and a card above it** (`OpticsCard`),
 * so nothing covers the core.
 *
 * The card is not attached to its button. They are at opposite ends of the
 * sphere, so this is not a `Popout`: the button and the card are two pieces
 * `Hud` places separately, and it holds whether the card is out.
 */
export default function OpticsButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <PopoutButton open={open} onPress={onToggle} label="Optics" testID="hud-optics">
      {(lit) => <CameraIcon color={lit ? colors.accentTxt : colors.textMuted} />}
    </PopoutButton>
  );
}

/**
 * The camera card, at the top of the core's column, above the sphere: a round
 * lens with the live picture, and the controls beside it.
 *
 * It is wide and short on purpose. The space above the sphere is about a
 * sixth of the column's height, so the lens and the controls sit side by side
 * rather than stacked.
 *
 * **The camera is on only while this card is out.** `Hud` hands `useCamera` an
 * `active` that is false whenever the card is shut, so putting it away (the
 * button, the ✕, Escape, another card's button, an overlay opening) releases
 * the track. A live camera nobody is looking at is a light on with nothing on
 * screen to explain it. Capture opens the full Assistant, so it closes the
 * camera too; the frame is already taken by then.
 *
 * **The preview is free and the capture is not.** Frames from `getUserMedia`
 * are painted by the browser and read by nobody, so a camera left on all
 * afternoon costs battery and no tokens. `Capture` is the only control that
 * produces bytes, and even then it only stages them on the composer. The card
 * says so in a line under the buttons.
 *
 * Mounted open and shut, like every card over the HUD, so it can fade; shut, it
 * is unreachable rather than merely invisible (`reachable`).
 */
export function OpticsCard({
  camera,
  open,
  onClose,
  onCapture,
  attached,
}: {
  camera: CameraController;
  open: boolean;
  onClose: () => void;
  /** Where a frame goes. This card never sends anything itself. */
  onCapture: (frame: CapturedFrame) => void;
  /** Whether the composer is already holding one, which changes the verb. */
  attached: boolean;
}) {
  const busy = camera.starting;
  const showing = camera.live || busy;

  const capture = () => {
    const frame = camera.capture();

    if (frame) onCapture(frame);
  };

  return (
    <View
      testID="hud-optics-card"
      {...GLASS_SCOPE}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
      aria-hidden={!open}
      style={[
        s.card,
        popoutStyles.glass,
        transition("opacity, transform, visibility"),
        { opacity: open ? 1 : 0, transform: [{ translateY: open ? 0 : -8 }] },
        reachable(open),
      ]}
    >
      <View style={s.body} testID="panel-camera">
        <View style={s.lens} testID="hud-camera-lens">
          {showing && open ? (
            <Preview videoRef={camera.videoRef} />
          ) : (
            <CameraIcon color={colors.textDim} size={28} />
          )}
        </View>

        <View style={s.side}>
          <View style={s.row}>
            <Text style={s.eyebrow}>OPTICS</Text>
            <Text style={[s.state, camera.live && s.stateLive]}>
              {camera.live ? "LIVE" : busy ? "OPENING" : "OFF"}
            </Text>
            <View style={s.spacer} />
            <PopoutClose label="Close optics" onPress={onClose} testID="hud-optics-close" />
          </View>

          {camera.supported && (
            <View style={s.row}>
              <Button
                label={showing ? "Stop" : "Start"}
                onPress={camera.toggle}
                tone={showing ? "plain" : "accent"}
                testID="camera-toggle"
              />
              <Button
                label={attached ? "Replace" : "Capture"}
                onPress={capture}
                // Not merely styled off: the first frame takes a moment to
                // arrive after the track goes live, and capturing before it
                // does returns nothing at all.
                disabled={!camera.live}
                tone="accent"
                testID="camera-capture"
              />
            </View>
          )}

          {camera.supported && camera.devices.length > 1 && (
            <View style={s.devices} testID="camera-devices">
              {camera.devices.map((device) => (
                <Pressable
                  key={device.id}
                  onPress={() => camera.selectDevice(device.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: camera.deviceId === device.id }}
                  style={({ hovered }: any) => [
                    s.device,
                    camera.deviceId === device.id && s.deviceOn,
                    hovered && s.deviceHovered,
                  ]}
                >
                  <Text
                    style={[s.deviceText, camera.deviceId === device.id && s.deviceTextOn]}
                    numberOfLines={1}
                  >
                    {device.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}

          {!camera.supported ? (
            // A control that cannot work is worse than a sentence saying why,
            // the same rule the microphone follows outside Chrome and Edge.
            <Text style={s.note}>This browser has no camera API.</Text>
          ) : camera.error ? (
            <Text style={s.error} testID="camera-error">
              {camera.error}
            </Text>
          ) : camera.closedBecause ? (
            // Only after it was on: a camera that has never been started has
            // nothing to explain about itself.
            <Text style={s.note} testID="camera-closed">
              {camera.closedBecause}
            </Text>
          ) : (
            <Text style={s.note}>
              {camera.live
                ? "This preview stays in the browser. Capture sends the whole frame to the assistant."
                : "Nothing is recorded. Capture sends one frame with your next message."}
            </Text>
          )}
        </View>
      </View>
    </View>
  );
}

/**
 * The preview surface.
 *
 * Plain `React.createElement` rather than JSX because `video` is a DOM tag and
 * TypeScript resolves lowercase JSX names against React Native's intrinsics,
 * where it does not exist. The style object is DOM CSS for the same reason:
 * this element never goes through RN-Web's style compiler.
 *
 * **The round lens shows the middle of the frame, and Capture sends all of
 * it.** A circle crops a 4:3 picture's sides, so the card's line says "the
 * whole frame", and the frame appears whole on the composer before anything is
 * sent. **It is not mirrored**: a mirrored preview and an unmirrored capture
 * would disagree about which way round the world is.
 */
function Preview({ videoRef }: { videoRef: CameraController["videoRef"] }) {
  return React.createElement("video", {
    ref: videoRef,
    // All three are required for a preview that starts by itself: a browser
    // will not autoplay an unmuted stream, and iOS Safari fullscreens a video
    // that is not `playsInline`.
    autoPlay: true,
    muted: true,
    playsInline: true,
    "data-testid": "camera-preview",
    style: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  });
}

function Button({
  label,
  onPress,
  disabled = false,
  tone = "plain",
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "plain" | "accent";
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ hovered }: any) => [
        s.btn,
        tone === "accent" && s.btnAccent,
        hovered && !disabled && s.btnHovered,
        disabled && s.btnDisabled,
      ]}
      testID={testID}
    >
      <Text style={[s.btnText, tone === "accent" && s.btnTextAccent]}>{label}</Text>
    </Pressable>
  );
}

/**
 * A camera body and its lens, stroked in `color`, which is a `var(--c-*)`, so it
 * re-themes inside `data-hud` like the HUD's other icons.
 */
function CameraIcon({ color, size = 18 }: { color: string; size?: number }) {
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
    >
      <path d="M3 8.5A2 2 0 0 1 5 6.5h2.4l1.6-2.5h6l1.6 2.5H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <circle cx={12} cy={13} r={3.6} />
    </svg>
  );
}

/** The lens's diameter. Big enough to see a face, small enough to fit above the sphere. */
const LENS = 112;

const s = StyleSheet.create({
  card: {
    width: 460,
    maxWidth: "100%",
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.sm,
  },
  body: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  side: { flex: 1, minWidth: 0, gap: spacing.xs },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  spacer: { flex: 1 },
  eyebrow: { ...type.label, color: colors.accentTxt, letterSpacing: 1.4 },
  state: { ...type.label, color: colors.textDim },
  stateLive: { color: colors.accent },

  lens: {
    width: LENS,
    height: LENS,
    borderRadius: LENS / 2,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.accentBd,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },

  btn: {
    paddingVertical: 4,
    paddingHorizontal: spacing.md,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
  },
  btnAccent: { borderColor: colors.accentBd, backgroundColor: colors.accentBg },
  btnHovered: { borderColor: colors.borderHi },
  btnDisabled: { opacity: 0.45 },
  btnText: { ...type.caption, fontWeight: "600", color: colors.textMuted },
  btnTextAccent: { color: colors.accentTxt },

  devices: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  device: {
    paddingVertical: 1,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  deviceOn: { borderColor: colors.accentBd, backgroundColor: colors.accentBg },
  deviceHovered: { borderColor: colors.borderHi },
  deviceText: { ...type.micro, color: colors.textDim, maxWidth: 96 },
  deviceTextOn: { color: colors.accentTxt },

  note: { ...type.caption, color: colors.textDim },
  error: { ...type.caption, color: colors.error },
});
