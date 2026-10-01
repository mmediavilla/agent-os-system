/**
 * The camera's rules, with no camera in them.
 *
 * Same split as `agentSession.ts` and for the same reason: the parts worth being sure
 * about — how big a frame is allowed to be, what a browser's refusal actually
 * means, what a device with no label should be called — are decisions, and a
 * decision tangled up with a `MediaStream` can only be checked by opening one.
 * `useCamera` holds the handles; this holds the arithmetic and the sentences.
 *
 * **The preview costs nothing and the capture costs money**, and that asymmetry
 * is the whole shape of the feature. Frames from `getUserMedia` never leave the
 * page — they are painted by the browser into a `<video>` and nothing reads
 * them — so a camera left running all afternoon spends battery and no tokens.
 * Pressing Capture is the only thing that produces bytes, and the numbers below
 * are what decide how many.
 */

/**
 * The longest edge a captured frame is allowed to have.
 *
 * An image costs roughly `width × height / 750` input tokens, so a 1024px frame
 * is around eleven hundred of them — and it is re-sent on every later turn of
 * the loop, which is what makes the size worth choosing rather than inheriting
 * from whatever the webcam happens to produce. Going higher buys nothing
 * either: Anthropic downsamples anything over 1568px on its own, so a 4K frame
 * is paid for at 1568 and looks identical.
 */
export const MAX_EDGE = 1024;

/**
 * JPEG, not PNG.
 *
 * A camera frame is a photograph — continuous tone, sensor noise in every
 * pixel — which is the case PNG is worst at: the same shot lands around ten
 * times larger losslessly, for detail the model cannot use. 0.72 is the point
 * where the artefacts stop being visible at this size.
 */
export const MEDIA_TYPE = "image/jpeg";

export const QUALITY = 0.72;

/** One camera the browser is willing to name. */
export type CameraDevice = { id: string; label: string };

/** A frame, ready to be looked at locally and posted. */
export type CapturedFrame = {
  /** For the `<img>` on the composer. Never sent — the API takes bare base64. */
  dataUrl: string;
  mediaType: string;
  data: string;
  width: number;
  height: number;
};

/** Whether this browser has a camera API at all. */
export function isSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * The largest box with this aspect ratio that fits inside `maxEdge` square.
 *
 * Never enlarges. A 640×480 webcam is 640×480 — upscaling would cost tokens in
 * exact proportion to the pixels it invented.
 */
export function fitWithin(width: number, height: number, maxEdge = MAX_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height);

  if (!Number.isFinite(longest) || longest <= 0) return { width: 0, height: 0 };
  if (longest <= maxEdge) return { width: Math.round(width), height: Math.round(height) };

  const scale = maxEdge / longest;

  // Floored at 1: a very long, very thin frame would otherwise round its short
  // edge to zero, and a canvas of zero width draws nothing at all.
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * The two halves of a `data:` URL.
 *
 * A canvas hands back one string and the API takes the media type and the
 * payload as separate fields, so somebody has to split it. Doing it here rather
 * than on the server means the server never has to guess what a client meant by
 * a prefix — it is handed exactly the two values it validates.
 */
export function splitDataUrl(url: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);

  return match ? { mediaType: match[1], data: match[2] } : null;
}

/** Roughly how many bytes a base64 payload decodes to. */
export function approxBytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;

  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/**
 * What to ask the browser for.
 *
 * `ideal` rather than `exact` on the size: `exact` makes a webcam that cannot
 * do 1280×720 fail outright with an OverconstrainedError, which reads to the
 * user as "no camera" — and the frame is downscaled on capture anyway, so a
 * smaller sensor costs nothing but sharpness. `exact` *is* right for the device
 * id, because picking the wrong camera silently is worse than saying so.
 */
export function constraintsFor(deviceId: string | null): MediaStreamConstraints {
  return {
    audio: false,
    video: deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { width: { ideal: 1280 }, height: { ideal: 720 } },
  };
}

/**
 * What to call a camera.
 *
 * A browser reports every device with an empty label until the user has granted
 * permission at least once, so the first time the picker is drawn it is a list
 * of blanks. Numbering them is not a nicety: two blank entries are one entry as
 * far as anyone can tell.
 */
export function deviceLabel(label: string, index: number): string {
  const clean = label.trim();

  return clean !== "" ? clean : `Camera ${index + 1}`;
}

/**
 * A browser's refusal, as a sentence about what to do next.
 *
 * The `name` is the part worth branching on. The `message` behind it is written
 * by the browser vendor, differs between Chrome and Edge for the same fault,
 * and in the two cases that matter most — a denied permission and a camera
 * another application already has — says nothing about how to fix it.
 */
export function cameraError(error: unknown): string {
  const name = (error as { name?: string } | null)?.name ?? "";

  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera access was declined. Allow it for this site in the browser's settings, then start it again.";

    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No camera is attached to this machine.";

    case "OverconstrainedError":
      return "That camera is no longer available. Pick another one.";

    case "NotReadableError":
    case "TrackStartError":
      // The single most common failure on a machine that has a working camera,
      // and the one whose fix is somewhere else entirely.
      return "The camera is in use by another application. Close it and start again.";

    case "AbortError":
      return "The camera stopped before it could start.";

    default:
      return "The camera could not be opened.";
  }
}
