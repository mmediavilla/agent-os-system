import {
  MAX_EDGE,
  approxBytes,
  cameraError,
  constraintsFor,
  deviceLabel,
  fitWithin,
  splitDataUrl,
} from "../camera";

/**
 * The camera's arithmetic and its sentences.
 *
 * `useCamera` owns a `MediaStream` and cannot be reasoned about without one;
 * everything with a decision in it lives here instead, which is the same split
 * `agentSession.ts` makes and for the same reason.
 */

describe("fitWithin", () => {
  it("leaves a frame smaller than the ceiling alone", () => {
    // Upscaling costs tokens in exact proportion to the pixels it invents.
    expect(fitWithin(640, 480)).toEqual({ width: 640, height: 480 });
  });

  it("scales the longest edge down to the ceiling and keeps the ratio", () => {
    expect(fitWithin(1920, 1080)).toEqual({ width: MAX_EDGE, height: 576 });
  });

  it("measures the longest edge, not the width", () => {
    expect(fitWithin(1080, 1920)).toEqual({ width: 576, height: MAX_EDGE });
  });

  it("never rounds the short edge away", () => {
    // A very long, very thin frame would otherwise land on a zero-width canvas,
    // which draws nothing at all rather than drawing something wrong.
    expect(fitWithin(4000, 3)).toEqual({ width: MAX_EDGE, height: 1 });
  });

  it("gives back nothing for a frame that has no size yet", () => {
    expect(fitWithin(0, 0)).toEqual({ width: 0, height: 0 });
  });
});

describe("splitDataUrl", () => {
  it("separates the media type from the payload", () => {
    expect(splitDataUrl("data:image/jpeg;base64,QUJD")).toEqual({
      mediaType: "image/jpeg",
      data: "QUJD",
    });
  });

  it("refuses anything that is not a base64 data url", () => {
    expect(splitDataUrl("https://example.test/photo.jpg")).toBeNull();
    expect(splitDataUrl("data:image/jpeg,QUJD")).toBeNull();
  });
});

describe("approxBytes", () => {
  it("reports what a payload decodes to, padding included", () => {
    expect(approxBytes("QUJD")).toBe(3);
    expect(approxBytes("QUJDRA==")).toBe(4);
  });
});

describe("constraintsFor", () => {
  it("asks for a size rather than insisting on one", () => {
    // `exact` makes a webcam that cannot do 720p fail outright, which reads as
    // "no camera" — and the frame is downscaled on capture anyway.
    const video = constraintsFor(null).video as MediaTrackConstraints;

    expect(video.width).toEqual({ ideal: 1280 });
    expect(video).not.toHaveProperty("deviceId");
  });

  it("does insist on the camera that was chosen", () => {
    const video = constraintsFor("cam-2").video as MediaTrackConstraints;

    expect(video.deviceId).toEqual({ exact: "cam-2" });
  });

  it("never asks for audio", () => {
    expect(constraintsFor(null).audio).toBe(false);
  });
});

describe("deviceLabel", () => {
  it("uses the browser's name when there is one", () => {
    expect(deviceLabel("Logitech C920", 0)).toBe("Logitech C920");
  });

  it("numbers the blanks a browser reports before permission is granted", () => {
    // Two empty labels are one entry as far as anyone reading the picker can
    // tell.
    expect(deviceLabel("", 0)).toBe("Camera 1");
    expect(deviceLabel("   ", 1)).toBe("Camera 2");
  });
});

describe("cameraError", () => {
  it("says how to undo a refusal", () => {
    expect(cameraError({ name: "NotAllowedError" })).toContain("browser's settings");
  });

  it("names the case where the fix is in another application", () => {
    // The most common failure on a machine whose camera works perfectly.
    expect(cameraError({ name: "NotReadableError" })).toContain("another application");
  });

  it("distinguishes no camera from a camera that has gone", () => {
    expect(cameraError({ name: "NotFoundError" })).toContain("No camera");
    expect(cameraError({ name: "OverconstrainedError" })).toContain("Pick another");
  });

  it("falls back rather than showing a browser's own wording", () => {
    expect(cameraError({ name: "SomethingNew" })).toBe("The camera could not be opened.");
    expect(cameraError(null)).toBe("The camera could not be opened.");
  });
});
