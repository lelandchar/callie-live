// The video call. Grace's face is a Spatius avatar rendered in this browser (AvatarKit, WASM)
// from motion data that arrives over LiveKit with her voice. Built by Vite into
// ../public/call/call.js and imported by public/app.js.
//
// Two ways to drive the avatar, fixed for the life of the page:
//   rtc    — the live call: a LiveKit room with Grace's agent (Gemini Live + Spatius plugin).
//   direct — the recorded call: this page sends each recorded line's audio to Spatius and the
//            avatar speaks it with matching lip movement.
import { AvatarManager, AvatarSDK, AvatarView, DrivingServiceMode, LogLevel } from "@spatius/avatarkit";
import { AvatarPlayer, LiveKitProvider } from "@spatius/avatarkit-rtc";
import { Room, RoomEvent, Track } from "livekit-client";

let sdkMode = null;

async function ensureSdk(appId, mode) {
  if (sdkMode === mode) return;
  if (sdkMode) throw new Error(`The avatar is already set up for the ${sdkMode === DrivingServiceMode.rtc ? "live" : "recorded"} call. Reload the page to switch.`);
  await AvatarSDK.initialize(appId, { drivingServiceMode: mode, logLevel: LogLevel.warning });
  sdkMode = mode;
}

export const supportsLiveAvatar = () => typeof globalThis.RTCRtpScriptTransform !== "undefined";

const loads = new Map();
/** Set up the SDK and download the avatar's assets without drawing anything (cached). */
export function prefetchAvatar({ appId, avatarId, mode = "rtc", onProgress } = {}) {
  if (!loads.has(avatarId)) {
    loads.set(avatarId, (async () => {
      await ensureSdk(appId, mode === "direct" ? DrivingServiceMode.direct : DrivingServiceMode.rtc);
      return AvatarManager.shared.load(avatarId, (p) => {
        if (p.type === "downloading") onProgress?.(p.progress ?? 0);
        if (p.type === "completed") onProgress?.(1);
      });
    })().catch((e) => { loads.delete(avatarId); throw e; }));
  }
  return loads.get(avatarId);
}

/** Download the avatar and render it (idle) into `stage`. Resolves once the first frame is drawn. */
export async function loadAvatar(stage, { appId, avatarId, mode = "rtc", onProgress } = {}) {
  const avatar = await prefetchAvatar({ appId, avatarId, mode, onProgress });
  const view = new AvatarView(avatar, stage, mode === "direct" ? { audioFormat: { channelCount: 1, sampleRate: 24000 } } : undefined);
  // A browser without WebGL2 never draws a first frame; give up instead of waiting forever.
  await Promise.race([
    new Promise((resolve) => { view.onFirstRendering = resolve; }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("The avatar couldn't render in this browser.")), 12000)),
  ]).catch((e) => { try { view.dispose(); } catch {} throw e; });
  return view;
}

/**
 * Join the LiveKit room. Grace's agent is dispatched by the room token, so she joins on her own.
 * - micTrack: the CSM's microphone (a MediaStreamTrack the app owns and also feeds to Callie).
 * - onRemoteAudio(track, identity): Grace's voice, so Callie can listen to the call.
 * - onTranscript({ identity, local, text, final, id }): live captions from the agent.
 * - onState(state, detail): connecting | connected | reconnecting | disconnected | failed | joined | left | error
 */
export async function joinCall(view, connection, { micTrack, onRemoteAudio, onTranscript, onState } = {}) {
  const provider = new LiveKitProvider();
  const player = new AvatarPlayer(provider, view, { logLevel: "warning" });
  player.on("connection-state-changed", (s) => onState?.(s));
  player.on("error", (e) => onState?.("error", e?.message || String(e)));
  // The motion stream stalled and the avatar went idle: try to pick it back up.
  player.on("stalled", () => { player.reconnect().catch(() => {}); });

  onState?.("connecting");
  await player.connect({ url: connection.url, token: connection.token, roomName: connection.roomName });
  const room = provider.getNativeClient();
  wireRoom(room, { onRemoteAudio, onTranscript, onState });
  if (micTrack) await player.publishAudio(micTrack);

  return {
    room,
    /** Text mode: the customer agent receives this as the CSM's turn (LiveKit's chat topic). */
    async sendText(text) {
      await room.localParticipant.sendText(text, { topic: "lk.chat" });
    },
    async publishMic(track) {
      if (track) await player.publishAudio(track);
    },
    async leave() {
      try { await player.unpublishAudio(); } catch {}
      try { await player.disconnect(); } catch {}
    },
  };
}

/**
 * The same call without the avatar, for browsers that can't render it: a plain LiveKit room
 * where the customer's voice plays from an audio element and her tile shows a still photo.
 */
export async function joinCallVoiceOnly(connection, { micTrack, onRemoteAudio, onTranscript, onState } = {}) {
  const room = new Room();
  const players = [];
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== Track.Kind.Audio) return;
    const el = track.attach();
    el.style.display = "none";
    document.body.append(el);
    players.push(el);
  });
  wireRoom(room, { onRemoteAudio, onTranscript, onState });
  onState?.("connecting");
  await room.connect(connection.url, connection.token);
  onState?.("connected");
  try { await room.startAudio(); } catch {}
  if (micTrack) await room.localParticipant.publishTrack(micTrack, { source: Track.Source.Microphone });
  return {
    room,
    async sendText(text) {
      await room.localParticipant.sendText(text, { topic: "lk.chat" });
    },
    async publishMic(track) {
      if (track) await room.localParticipant.publishTrack(track, { source: Track.Source.Microphone });
    },
    async leave() {
      try { await room.disconnect(); } catch {}
      players.forEach((el) => el.remove());
    },
  };
}

function wireRoom(room, { onRemoteAudio, onTranscript, onState }) {
  const tapped = new Set();
  const tap = (track, participant) => {
    if (track?.kind !== "audio" || tapped.has(track.sid)) return;
    tapped.add(track.sid);
    onRemoteAudio?.(track.mediaStreamTrack, participant.identity);
  };
  room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => tap(track, participant));
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.trackPublications.values()) if (pub.track) tap(pub.track, p);
  }

  const isCustomer = (p) => p && p.identity !== room.localParticipant.identity;
  room.on(RoomEvent.ParticipantConnected, (p) => { if (isCustomer(p)) onState?.("joined", p.identity); });
  room.on(RoomEvent.ParticipantDisconnected, (p) => { if (isCustomer(p)) onState?.("left", p.identity); });
  if ([...room.remoteParticipants.values()].some(isCustomer)) onState?.("joined");

  // Agents publish what each side said as text streams on this topic.
  try {
    room.registerTextStreamHandler("lk.transcription", async (reader, from) => {
      const attrs = reader.info?.attributes || {};
      const id = attrs["lk.segment_id"] || reader.info?.id;
      const local = from?.identity === room.localParticipant.identity;
      let text = "";
      for await (const chunk of reader) {
        text += chunk;
        onTranscript?.({ identity: from?.identity, local, text, final: false, id });
      }
      // The stream closes when the segment is done (in sync with the speech). Agents don't
      // always send a separate final segment, so the close is what counts.
      onTranscript?.({ identity: from?.identity, local, text, final: true, id });
    });
  } catch {}

}

/**
 * Recorded call: speak prerecorded PCM through the avatar. Call `prepare()` from a click, since
 * browsers only start audio from a user gesture.
 */
export function directVoice(view, { sessionToken }) {
  const controller = view.controller;
  let started = false;
  return {
    async prepare() {
      AvatarSDK.setSessionToken(sessionToken);
      await controller.initializeAudioContext();
      if (!started) { await controller.start(); started = true; }
    },
    /** pcm: 24 kHz mono PCM16 (ArrayBuffer). Feed in chunks; end=true on the last one. */
    speak(pcm, end) { return controller.send(pcm, end); },
    onState(fn) { controller.onConversationState = fn; },
    pause() { try { controller.pause(); } catch {} },
    resume() { return controller.resume().catch(() => {}); },
    interrupt() { try { controller.interrupt(); } catch {} },
    close() { try { controller.close(); } catch {} started = false; },
  };
}
