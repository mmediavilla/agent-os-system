/**
 * One function, whose whole job is *when* the ElevenLabs SDK is loaded.
 *
 * `@elevenlabs/client` is a pure ES module carrying a WebRTC stack, and it is
 * needed by exactly one control on one screen — a button that most sessions
 * never press. A static import would put it in the bundle, and in the module
 * graph of every screen test, for a feature that may never be used in a given
 * visit. So it is fetched at the moment somebody has already decided to wait
 * for a microphone, which costs one round trip nobody notices.
 *
 * **It is a module of its own rather than an `import()` inline in
 * `useAgentSession`**, and that is a testing constraint stated plainly rather
 * than worked around. Jest runs this suite in a CommonJS VM, where a real
 * dynamic import throws `A dynamic import callback was invoked without
 * --experimental-vm-modules` — and the usual fix, a Babel plugin rewriting
 * `import()` to `require()`, does not reach this project: `jest-expo` pins its
 * transform at `expo/internal/babel-preset` through an explicit `configFile`,
 * which wins over the root `babel.config.js` the `web` project added. So the
 * seam is here, one named function, and the tests replace it.
 */

/** The part of the SDK the session needs, without importing it to say so. */
export type ConversationSdk = {
  Conversation: {
    startSession: (options: Record<string, unknown>) => Promise<unknown>;
  };
};

export function loadConversationSdk(): Promise<ConversationSdk> {
  return import("@elevenlabs/client") as unknown as Promise<ConversationSdk>;
}
