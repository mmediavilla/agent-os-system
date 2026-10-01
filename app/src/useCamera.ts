import { useCallback, useEffect, useRef, useState } from "react";
import {
  CameraDevice,
  CapturedFrame,
  MEDIA_TYPE,
  QUALITY,
  cameraError,
  constraintsFor,
  deviceLabel,
  fitWithin,
  isSupported,
  splitDataUrl,
} from "./camera";

/**
 * The camera — the handles only.
 *
 * Same split as `useAgentSession`: `camera.ts` holds the arithmetic and the sentences,
 * and what is left here is the part that owns something the browser will not
 * take back on its own. That is one `MediaStream` with a live track on the end
 * of it, and there is exactly one place it is released, because a track left
 * running keeps the indicator light on and there is nothing on screen that
 * would say so.
 *
 * ── The stream is a ref and the state is state ──────────────────────────────
 *
 * The `MediaStream` never goes into `useState`. Nothing renders from it — the
 * `<video>` reads it through `srcObject`, which is an assignment and not a prop
 * — and stopping it has to be able to happen synchronously, from a cleanup that
 * runs after the component has stopped caring about renders.
 *
 * ── Leaving the tab closes it, and coming back does not reopen it ───────────
 *
 * That is 7.3's rule, taken as written: *a microphone that reopened itself when
 * you came back is one nobody pressed anything to start.* A camera is the same
 * bargain with a more visible light on it. So `visibilitychange` and losing the
 * screen both stop the stream, the panel says which, and starting again is a
 * press. The alternative — quietly reopening a camera because a tab regained
 * focus — is a device turning itself on in a room nobody chose that for.
 *
 * ── Capture is the only thing that costs anything ──────────────────────────
 *
 * Preview frames never leave the page. `capture()` is where a frame becomes
 * bytes: it is drawn once into a canvas at no more than {@link MAX_EDGE}, and
 * handed back for someone else to decide whether to send. This hook never
 * posts anything.
 */
export type CameraController = {
  /** Whether this browser has a camera API at all. */
  supported: boolean;
  /** A track is live and the preview is painting. */
  live: boolean;
  /** Asked for, not granted yet — usually the permission prompt. */
  starting: boolean;
  /** A refusal, a missing camera, or one another application is holding. */
  error: string | null;
  /**
   * Why the camera is not on, when it was on a moment ago and nobody pressed
   * stop. Null in every other case, including the ordinary one where it has
   * simply never been started.
   */
  closedBecause: string | null;

  /** Every camera the browser will name. Empty until the first grant. */
  devices: CameraDevice[];
  deviceId: string | null;
  /** Switching while live reopens the stream on the other camera. */
  selectDevice: (id: string) => void;

  /** Where the preview paints. Handed straight to a raw `<video>`. */
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;

  start: () => void;
  stop: () => void;
  toggle: () => void;
  /** One frame, downscaled and encoded. Null when nothing is live yet. */
  capture: () => CapturedFrame | null;
};

export function useCamera({ active = true }: { active?: boolean } = {}): CameraController {
  const supported = isSupported();

  const [live, setLive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closedBecause, setClosedBecause] = useState<string | null>(null);
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  /**
   * Which `start()` is the current one.
   *
   * `getUserMedia` is a promise, and two presses — or a press followed
   * immediately by a device switch — leave two of them in flight. Without a
   * token the loser resolves last and installs its stream over the winner's,
   * which leaks the winner's tracks: still live, no longer referenced, and the
   * camera light stays on with nothing on screen to explain it.
   */
  const attempt = useRef(0);

  /** The one place a track is released. */
  const release = useCallback(() => {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;

    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const shutdown = useCallback(
    (reason: string | null) => {
      attempt.current += 1;
      release();
      setLive(false);
      setStarting(false);
      setClosedBecause(reason);
    },
    [release],
  );

  /**
   * The camera list, which is only useful once permission exists.
   *
   * Before the first grant every label is an empty string, so this is called
   * again after a successful start rather than only on mount — that second call
   * is what turns "Camera 1, Camera 2" into the names on the devices.
   */
  const readDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;

    try {
      const found = await navigator.mediaDevices.enumerateDevices();

      setDevices(
        found
          .filter((device) => device.kind === "videoinput")
          .map((device, index) => ({ id: device.deviceId, label: deviceLabel(device.label, index) })),
      );
    } catch {
      // A browser that will not enumerate still opens the default camera, and
      // a picker is the part of this panel that matters least.
    }
  }, []);

  const start = useCallback(
    async (id: string | null = deviceId) => {
      if (!isSupported()) return;

      const token = ++attempt.current;

      // Whatever is open is not what was asked for. Released before the request
      // rather than after it, because some browsers refuse a second stream on a
      // camera they are already holding.
      release();

      setError(null);
      setClosedBecause(null);
      setStarting(true);
      setLive(false);

      try {
        const opened = await navigator.mediaDevices.getUserMedia(constraintsFor(id));

        // A newer press won while the prompt was up. This stream is nobody's,
        // so it is stopped rather than installed.
        if (token !== attempt.current) {
          opened.getTracks().forEach((track) => track.stop());

          return;
        }

        stream.current = opened;
        setLive(true);
        setStarting(false);
        readDevices();
      } catch (e) {
        if (token !== attempt.current) return;

        setError(cameraError(e));
        setStarting(false);
        setLive(false);
      }
    },
    [deviceId, readDevices, release],
  );

  const stop = useCallback(() => shutdown(null), [shutdown]);

  const toggle = useCallback(() => {
    if (live || starting) {
      stop();

      return;
    }

    start();
  }, [live, starting, start, stop]);

  const selectDevice = useCallback(
    (id: string) => {
      setDeviceId(id);

      // Only reopens what was already open. Choosing a camera from a picker is
      // not the same gesture as turning one on.
      if (live || starting) start(id);
    },
    [live, starting, start],
  );

  /**
   * One frame, at the size the model is going to be charged for.
   *
   * Reads the *track's* dimensions rather than the element's, because the
   * element is the size of a panel in a rail and the picture is not.
   */
  const capture = useCallback((): CapturedFrame | null => {
    const video = videoRef.current;

    if (!video || !stream.current) return null;

    const width = video.videoWidth || 0;
    const height = video.videoHeight || 0;

    // Zero until the first frame has arrived, which is a real window of a few
    // hundred milliseconds after `live` goes true.
    if (width === 0 || height === 0) return null;

    const size = fitWithin(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;

    const context = canvas.getContext("2d");

    if (!context) return null;

    context.drawImage(video, 0, 0, size.width, size.height);

    const dataUrl = canvas.toDataURL(MEDIA_TYPE, QUALITY);
    const split = splitDataUrl(dataUrl);

    if (!split) return null;

    return { dataUrl, mediaType: split.mediaType, data: split.data, width: size.width, height: size.height };
  }, []);

  /**
   * Keep the `<video>` pointed at whatever stream there is.
   *
   * Done from an effect rather than at the moment the stream opens, because the
   * element does not exist yet at that moment: the preview only mounts on the
   * render `starting` causes, and `getUserMedia` can resolve either side of it.
   * Assigning the same stream twice is a no-op; not assigning it at all is a
   * black rectangle over a camera that is running perfectly.
   *
   * No dependency array on purpose — the thing being compared is a ref and a
   * DOM property, neither of which React can watch.
   */
  useEffect(() => {
    const video = videoRef.current;

    if (!video || video.srcObject === stream.current) return;

    video.srcObject = stream.current;

    // Autoplay survives only muted and inline; a preview that needs a press to
    // start playing looks exactly like a camera that failed to open.
    if (stream.current) video.play?.().catch(() => {});
  });

  // The camera is closed by anything that means nobody is looking at it: the
  // screen it lives on stopped being the one you are on, the tab went away, or
  // this unmounted. Only the middle one has anything to say about itself.
  useEffect(() => {
    if (!active) shutdown(null);
  }, [active, shutdown]);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        shutdown("The camera was closed when this tab went to the background.");
      }
    };

    document.addEventListener("visibilitychange", onVisibility);

    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [shutdown]);

  useEffect(() => release, [release]);

  // Names are blank until permission has been granted once, so this first pass
  // usually produces "Camera 1" and a count — which is still the difference
  // between offering a picker and not knowing there is anything to pick.
  useEffect(() => {
    if (supported) readDevices();
  }, [supported, readDevices]);

  return {
    supported,
    live,
    starting,
    error,
    closedBecause,
    devices,
    deviceId,
    selectDevice,
    videoRef,
    start: useCallback(() => void start(), [start]),
    stop,
    toggle,
    capture,
  };
}
