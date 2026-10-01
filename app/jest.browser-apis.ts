/**
 * Fake hardware.
 *
 * The HUD reaches for the camera (7.4), a WebRTC line for the spoken
 * conversation (9.1), and the browser's idea of where it is (7.2). None of
 * those exist under jsdom, and each is the kind of API a test would otherwise
 * stub inline — three suites, three shapes, three different ideas of what a
 * `MediaStream` is.
 *
 * So they are laid down once, here, before any of them has a caller. Every stub
 * is a `jest.fn()` a test can re-point at whatever it needs to prove: a denied
 * permission, a moving position. The `beforeEach` at the bottom puts them back
 * between tests.
 *
 * These are deliberately *permissive* defaults — the camera opens, the position
 * resolves — because that is the path with something to assert. A test about a
 * refusal says so itself.
 */

/** One track per kind, so code that closes a device on deactivate has something to stop. */
function fakeTrack(kind: "video" | "audio") {
  return { kind, enabled: true, stop: jest.fn(), addEventListener: jest.fn() };
}

function fakeStream() {
  const video = [fakeTrack("video")];
  const audio = [fakeTrack("audio")];
  const tracks = [...video, ...audio];

  return {
    active: true,
    getTracks: () => tracks,
    getVideoTracks: () => video,
    getAudioTracks: () => audio,
  };
}

const FAKE_POSITION = {
  coords: {
    latitude: 14.5995,
    longitude: 120.9842,
    accuracy: 25,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
  },
  timestamp: 0,
};

/**
 * The cameras `enumerateDevices` reports.
 *
 * Two by default, because one is the case with nothing to assert: the picker
 * only appears when there is something to pick. Labels are populated, which is
 * the state *after* a permission grant — a test about the blank-label case sets
 * them empty itself.
 */
export const videoInputs = [
  { kind: "videoinput", deviceId: "cam-1", label: "FaceTime HD Camera" },
  { kind: "videoinput", deviceId: "cam-2", label: "Logitech C920" },
];

/**
 * What a canvas hands back from `toDataURL`.
 *
 * jsdom ships no 2D context at all — `getContext("2d")` returns null unless the
 * native `canvas` package is installed, which is a compiler toolchain for one
 * function. So the context is faked below and the encoded frame is a constant a
 * test can read back: one transparent PNG pixel, which is a real image and
 * decodes on the server side of the same round trip.
 */
export const canvasFrame = {
  dataUrl:
    'data:image/jpeg;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
};

export const browserApis = {
  getUserMedia: jest.fn(async () => fakeStream()),
  enumerateDevices: jest.fn(async () => videoInputs),
  drawImage: jest.fn(),
  toDataURL: jest.fn(() => canvasFrame.dataUrl),
  getCurrentPosition: jest.fn((onSuccess: (p: typeof FAKE_POSITION) => void) =>
    onSuccess(FAKE_POSITION),
  ),
  watchPosition: jest.fn((onSuccess: (p: typeof FAKE_POSITION) => void) => {
    onSuccess(FAKE_POSITION);

    return 1;
  }),
  clearWatch: jest.fn(),

  /**
   * jsdom implements neither, and the Equipment photo picker calls
   * `createObjectURL` on the file it is handed — so without this the first
   * test ever to reach that path dies on `not a function` rather than on
   * anything the screen got wrong.
   */
  createObjectURL: jest.fn((blob: Blob | File) => `blob:test/${(blob as File).name ?? "file"}`),
  revokeObjectURL: jest.fn(),
};

function define(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
}

define(navigator, "mediaDevices", {
  getUserMedia: browserApis.getUserMedia,
  enumerateDevices: browserApis.enumerateDevices,
});
define(HTMLCanvasElement.prototype, "getContext", () => ({ drawImage: browserApis.drawImage }));
define(HTMLCanvasElement.prototype, "toDataURL", browserApis.toDataURL);
define(navigator, "geolocation", {
  getCurrentPosition: browserApis.getCurrentPosition,
  watchPosition: browserApis.watchPosition,
  clearWatch: browserApis.clearWatch,
});
define(URL, "createObjectURL", browserApis.createObjectURL);
define(URL, "revokeObjectURL", browserApis.revokeObjectURL);
/**
 * jsdom has no WebRTC at all, and the spoken conversation is carried over it.
 *
 * Nothing here is driven — the session itself is mocked at the module boundary
 * in the tests that open one, because a real peer connection wants a network.
 * What this is for is `sessionSupported`, which checks for the constructor
 * before it offers a Talk button: without it every test renders a composer with
 * no voice control on it and asserts happily about a feature that is simply
 * switched off.
 */
define(window, "RTCPeerConnection", class FakeRTCPeerConnection {});

beforeEach(() => {
  Object.values(browserApis).forEach((fn) => fn.mockClear());

  browserApis.getUserMedia.mockImplementation(async () => fakeStream());
  browserApis.enumerateDevices.mockImplementation(async () => videoInputs);
  browserApis.toDataURL.mockImplementation(() => canvasFrame.dataUrl);
  browserApis.getCurrentPosition.mockImplementation((onSuccess) => onSuccess(FAKE_POSITION));
  browserApis.createObjectURL.mockImplementation(
    (blob) => `blob:test/${(blob as File).name ?? "file"}`,
  );

  /**
   * jsdom keeps one `localStorage` for the whole file, so a screen that stores
   * a preference — the theme, the units — hands it to the next test. That is
   * how "tells the user what System currently resolves to" started failing the
   * moment there was a real DOM: an earlier test had chosen dark, and the
   * footnote it asserts on only appears while the mode is still System.
   */
  window.localStorage.clear();
});
