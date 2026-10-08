// Callie Live Assistant: the home page and the call screen.
//   /            home page; "Start experience" joins the live video call in the same click
//   /?call       straight to the call screen
//   /?recorded   the recorded call (backup), with Grace's avatar speaking the recorded lines
// The call bundle (/call/call.js: LiveKit + Spatius AvatarKit) loads in the background.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const rich = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const icon = (id, extra = "") => `<svg viewBox="0 0 24 24"><use href="#i-${id}" width="24" height="24" />${extra}</svg>`;

const params = new URLSearchParams(location.search);
const RECORDED = params.has("recorded") || params.has("demo");
const OPEN_CALL = RECORDED || params.has("call");
// ?rec: used when filming the demo video. Logs when every sound starts (wall-clock ms) so the
// soundtrack can be rebuilt in sync with the screen recording.
const REC = params.has("rec");
const recLog = (e) => { if (REC) (window.__recEvents ??= []).push({ at: Date.now(), ...e }); };

const ui = {
  account: null,
  caps: {},
  cards: new Map(),
  order: [],
  primaryId: null,
  primaryAt: 0,
  actionLog: [],
  transcript: [],
  tool: "select",
  selected: null,
  strokes: [],
  speaking: false,
  whisperText: new Map(),
  inCall: false, // live video call
  roleplay: false, // audio-only call
  capture: false, // real meeting via system audio
  muted: false,
  camOn: true,
  captions: true,
  textMode: false, // type to the customer instead of talking (e.g. while presenting over Zoom)
};

// ------------------------------------------------------------------ config + session
const config = await fetch("/api/config").then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
ui.caps = config;
let sid = "";
try { sid = sessionStorage.getItem("callie-sid") || ""; } catch {}
if (!/^[a-zA-Z0-9_-]{8,64}$/.test(sid)) {
  sid = crypto.getRandomValues(new Uint8Array(9)).reduce((s, b) => s + b.toString(36).padStart(2, "0"), "");
  try { sessionStorage.setItem("callie-sid", sid); } catch {}
}

// ------------------------------------------------------------------ websocket
let ws;
let wsReady;
function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?sid=${sid}`);
  ws.binaryType = "arraybuffer";
  wsReady = new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => setTimeout(connect, 1000);
}
const send = (msg) => ws?.readyState === 1 && ws.send(JSON.stringify(msg));
connect();

function onMessage(m) {
  switch (m.type) {
    case "hello":
      ui.account = m.account;
      ui.caps = { ...ui.caps, ...m.caps };
      // The chosen scenario lives in this browser; the server follows it (the recorded call is
      // always the technical one).
      if (!RECORDED && ui.scenario && m.profile !== ui.scenario.id && m.profile !== "panel") send({ type: "profile", name: ui.scenario.id });
      $("#profileSel").value = m.profile;
      $("#whisperMode").value = m.settings.whisper;
      $("#coachToggle").checked = m.settings.coach;
      applyCaps();
      resetPanel();
      m.cards.forEach((c) => upsertCard(c));
      [...m.board].reverse().forEach((b) => addBoardItem(b, false));
      ui.transcript = m.transcript || [];
      if (ui.inCall) send({ type: "call_resume" }); // also tells the server this call is still alive
      break;
    case "status": break;
    case "level": break;
    case "transcript":
      ui.transcript.push(m.utterance);
      refreshTranscript();
      // Spoken lines: if Jordan addressed the teammate by name, pass it on.
      if (ui.inCall && !ui.textMode && m.utterance.who === "you" && !/^\(typed/.test(m.utterance.text)) {
        remember("you", m.utterance.text);
        if (addressesMate(m.utterance.text)) askMate(m.utterance.text);
      }
      break;
    case "card": upsertCard(m.card); break;
    case "board":
      if (m.op === "add") addBoardItem(m.item, true);
      if (m.op === "erase") $(`[data-bid="${m.id}"]`)?.remove();
      if (m.op === "clear") clearBoard();
      boardChanged();
      break;
    case "hint": addHint(m.text, m.tone); break;
    case "whisper":
      if (m.phase === "start") ui.whisperText.set(m.id, m.text);
      if (m.phase === "sent") maybeStopSpeaking();
      break;
    case "audio": playWhisper(m.id, m.data, m.mimeType); break;
    case "email": onEmail(m); break;
    case "share": onShare(m); break;
    case "ptt": $("#pttBtn").classList.toggle("down", m.on); break;
    case "reset": resetPanel(); break;
    case "persona_audio": playPersona(m.data, m.mimeType); break;
    case "persona_text": showCaption(m.role === "csm" ? "You" : "Grace", m.text, true); break;
    case "persona_turn": if (m.phase === "closed" && ui.roleplay) addHint("Grace left the call."); break;
  }
}
function applyCaps() {
  $("#captureBtn").hidden = !ui.caps.capture;
  $("#simWrap").hidden = !ui.caps.simulate;
}

// ------------------------------------------------------------------ screens
const html = document.documentElement;
function showCall() {
  $("#demoVideo")?.pause();
  $("#home").hidden = true;
  $("#app").hidden = false;
  html.classList.add("in-call");
  if (!OPEN_CALL) history.replaceState(null, "", "/?call");
  window.scrollTo(0, 0);
  mountAvatar();
  if (ui.scenario?.teammate && !RECORDED) mountMate(ui.scenario.teammate.avatarId);
}
$$("[data-home]").forEach((a) => (a.onclick = (e) => {
  if (ui.inCall || ui.roleplay || rec.running) {
    e.preventDefault();
    addHint("Leave the call first, then head back to the overview.");
  }
}));

// ------------------------------------------------------------------ the avatar
let callMod = null;
let view = null;
let voiceDirect = null; // recorded mode: drives the avatar from recorded audio
const AVATAR_MODE = RECORDED ? "direct" : "rtc";
const loadCallModule = () => (callMod ??= import("/call/call.js"));
// Framing: head and shoulders filling the tile, like a webcam.
const FRAME = { x: 0, y: -0.3, scale: 1.45 };

function setProgress(p) {
  const bar = $("#avatarProgress");
  $("i", bar).style.width = `${Math.round(p * 100)}%`;
  bar.classList.toggle("done", p >= 1);
}
async function prefetch() {
  if (!config.spatiusAppId) return null;
  const mod = await loadCallModule();
  return mod.prefetchAvatar({ appId: config.spatiusAppId, avatarId: config.avatarId, mode: AVATAR_MODE, onProgress: setProgress });
}
let mounting = null;
function mountAvatar() {
  mounting ??= (async () => {
    try {
      if (!config.spatiusAppId) throw new Error("no avatar configured");
      const mod = await loadCallModule();
      if (AVATAR_MODE === "rtc" && !mod.supportsLiveAvatar()) throw new Error("This browser can't show the live avatar; Grace joins by voice.");
      view = await mod.loadAvatar($("#avatarStage"), { appId: config.spatiusAppId, avatarId: config.avatarId, mode: AVATAR_MODE, onProgress: setProgress });
      view.avatarTransform = FRAME;
      setProgress(1);
      return view;
    } catch (e) {
      console.warn("avatar:", e);
      $("#stage").classList.add("no-avatar");
      setProgress(1);
      return null;
    }
  })();
  return mounting;
}

// ------------------------------------------------------------------ audio graph
let audioCtx = null;
let workletReady = null;
function ctx() {
  // When filming, the recorder supplies the audio context so every voice can be mixed into one track.
  if (!audioCtx) audioCtx = window.__recCtx || new AudioContext();
  if (REC && !window.__mixDest) window.__mixDest = audioCtx.createMediaStreamDestination();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}
const toMix = (node) => { if (REC && window.__mixDest) node.connect(window.__mixDest); };
function worklet() {
  return (workletReady ??= ctx().audioWorklet.addModule("/mic-worklet.js"));
}
// Every 100 ms frame goes to the server with one leading byte: 0 = the CSM, 1 = the customer.
function sendFrame(channel, buf) {
  if (ws?.readyState !== 1) return;
  const out = new Uint8Array(buf.byteLength + 1);
  out[0] = channel;
  out.set(new Uint8Array(buf), 1);
  ws.send(out);
}
async function tapStream(stream, channel, onFrame) {
  await worklet();
  const c = ctx();
  const src = c.createMediaStreamSource(stream);
  if (channel !== 0) toMix(src);
  const node = new AudioWorkletNode(c, "mic-capture");
  node.port.onmessage = (e) => onFrame(e.data, channel);
  const mute = c.createGain();
  mute.gain.value = 0;
  src.connect(node).connect(mute).connect(c.destination);
  return () => { try { src.disconnect(); node.disconnect(); } catch {} };
}

// The mic feeds two places: Callie (always, unless muted) and the call (a clone, so holding
// "ask Callie" can take you off the call without Callie going deaf).
const media = { stream: null, mic: null, pub: null, cam: null, untapMic: null, untapThem: [] };
async function openDevices({ video = true, audio: wantAudio = true } = {}) {
  if (media.mic || (media.stream && !wantAudio)) return;
  const audio = wantAudio ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } : false;
  const cam = video ? { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" } : false;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio, video: cam });
  } catch (e) {
    if (!video || !wantAudio) {
      if (wantAudio) throw e;
      stream = new MediaStream(); // text mode without a camera is fine too
    } else stream = await navigator.mediaDevices.getUserMedia({ audio }); // no camera is fine
  }
  media.stream = stream;
  media.mic = stream.getAudioTracks()[0] || null;
  media.pub = media.mic ? media.mic.clone() : null;
  media.cam = stream.getVideoTracks()[0] || null;
  if (media.cam) {
    $("#selfVideo").srcObject = new MediaStream([media.cam]);
    $("#selfView").classList.add("has-video");
  }
  ui.camOn = !!media.cam;
  renderControls();
  if (!media.mic) return;
  media.untapMic = await tapStream(new MediaStream([media.mic]), 0, (buf) => {
    meter(buf);
    if ((ui.inCall || ui.roleplay || ui.capture) && !ui.muted && !ui.textMode) sendFrame(0, buf);
  });
}
function closeDevices() {
  media.untapMic?.();
  media.untapThem.forEach((f) => f());
  media.stream?.getTracks().forEach((t) => t.stop());
  media.pub?.stop();
  Object.assign(media, { stream: null, mic: null, pub: null, cam: null, untapMic: null, untapThem: [] });
  $("#selfVideo").srcObject = null;
  $("#selfView").classList.remove("has-video");
}
function meter(buf) {
  const pcm = new Int16Array(buf);
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 4) sum += (pcm[i] / 32768) ** 2;
  const rms = Math.sqrt(sum / (pcm.length / 4));
  const level = ui.muted ? 0 : Math.min(1, rms * 9);
  $$("#micBars i").forEach((b, i) => (b.style.height = `${3 + Math.max(0, level * 9 - i * 2)}px`));
  $("#selfView").classList.toggle("speaking", level > 0.25 && (ui.inCall || ui.roleplay));
}

// ------------------------------------------------------------------ live video call
let call = null;
let mateCall = null; // the Arize teammate's room, when the scenario has one
let mateView = null;
let mateMounting = null;
let timer = null;
function startTimer() {
  const t0 = Date.now();
  clearInterval(timer);
  $("#timerChip").classList.add("live");
  timer = setInterval(() => {
    if (rec.paused) return;
    const s = Math.floor((Date.now() - t0) / 1000);
    $("#callTimer").textContent = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, "0")).join(":");
  }, 500);
}
function stopTimer() { clearInterval(timer); $("#timerChip").classList.remove("live"); }
function setLive(on) {
  $("#liveDot").classList.toggle("on", on);
  $("#nowEmpty").classList.toggle("live", on);
  $("#nowEmptyText").textContent = on ? "Listening" : "Ready";
  $("#endBtn").disabled = !on;
}
function showJoinError(text) {
  const el = $("#joinError");
  el.textContent = text;
  el.hidden = !text;
}
function overlay(on) { $("#overlay").hidden = !on; }
function connecting(text) {
  $("#connecting").hidden = !text;
  if (text) $("#connectingText").textContent = text;
}

async function joinCall({ text = ui.textMode, retry = false } = {}) {
  if (ui.inCall) return;
  if (!retry) ui.joinAttempt = 0;
  const attempt = ++ui.joinAttempt;
  ctx();
  showJoinError("");
  const btn = $(text ? "#joinTextBtn" : "#joinBtn");
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "Joining…"; }
  setTextMode(text);
  try {
    try {
      await openDevices({ video: true, audio: !text });
    } catch (e) {
      throw new Error("Callie Live Assistant needs your microphone. Click the camera icon in the address bar and allow the microphone, or join with text chat instead.");
    }
    await wsReady;
    const v = await mountAvatar(); // null when this browser can't render it: Grace joins by voice
    const res = await fetch("/api/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sid }) });
    const conn = await res.json();
    if (!res.ok) throw new Error(conn.error || "Couldn't start the call.");
    send({ type: "call_start" });
    ui.inCall = true;
    overlay(false);
    connecting("Calling Grace…");
    setLive(true);
    renderControls();
    let joined = false;
    let heard = false; // Grace has said something (her greeting comes within a few seconds)
    // Grace's voice service can fail as a call starts (it did once in 17 calls on Oct 7). If she's
    // silent or drops out, call her again once; after that, point to the recording.
    const graceGone = async (why) => {
      if (!ui.inCall || ui.redialing) return;
      if (attempt < 2) {
        ui.redialing = true;
        addHint(why === "left" ? "Grace dropped off. Calling her again…" : "Grace didn't pick up. Calling her again…");
        await leaveCall({ quiet: true });
        await sleep(800);
        ui.redialing = false;
        return joinCall({ text, retry: true });
      }
      addHint("Grace can't connect right now. End the call and play the recording on the overview instead.", "warning");
    };
    const mod = await loadCallModule();
    call = await mod[v ? "joinCall" : "joinCallVoiceOnly"](...(v ? [v] : []), conn, {
      micTrack: media.pub,
      onRemoteAudio: async (track) => {
        connecting("");
        if (!joined) { joined = true; startTimer(); }
        media.untapThem.push(await tapStream(new MediaStream([track]), 1, (buf) => {
          if (!ui.inCall) return;
          sendFrame(1, buf);
          if (!v) speakingFromLevel(buf);
        }));
      },
      onTranscript: (t) => {
        if (!t.local) heard = true;
        chatLine(t.local ? "you" : "grace", t.text, t.id, !t.final);
        showCaption(t.local ? "You" : "Grace", t.text, !t.final);
        if (t.final && !t.local) {
          remember("grace", t.text);
          if (addressesMate(t.text)) askMate(`Grace asks you: ${t.text}`);
        }
      },
      onState: (s, detail) => {
        if (s === "joined" && !joined) connecting("Grace is joining…");
        if (s === "left" && ui.inCall) graceGone("left");
        if (s === "reconnecting") connecting("Reconnecting…");
        if (s === "connected" && joined) connecting("");
        if (s === "failed" || s === "error") addHint(`Call problem: ${detail || s}`, "warning");
      },
    });
    if (conn.teammate) joinMate(mod, conn.teammate).catch((e) => addHint(`${conn.teammate.name.split(" ")[0]} couldn't join: ${e.message}`, "warning"));
    const thisCall = call;
    setTimeout(() => { if (ui.inCall && call === thisCall && !heard) connecting("Grace is taking a moment to join…"); }, 9000);
    setTimeout(() => { if (ui.inCall && call === thisCall && !heard) graceGone("silent"); }, 16000);
  } catch (e) {
    ui.inCall = false;
    closeDevices();
    setLive(false);
    connecting("");
    overlay(true);
    showJoinError(e.message);
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

// ------------------------------------------------------------------ the Arize teammate
// Julian has his own room and avatar. He hears only what's addressed to him (with recent context),
// and Grace hears his answers as text, so the two never talk over each other.
const MATE_FRAME = { x: 0, y: -0.3, scale: 1.45 };
function mountMate(avatarId) {
  mateMounting ??= (async () => {
    try {
      const mod = await loadCallModule();
      if (!RECORDED && !mod.supportsLiveAvatar()) throw new Error("no live avatar here");
      const v = await mod.loadAvatar($("#mateStage"), { appId: config.spatiusAppId, avatarId, mode: RECORDED ? "direct" : "rtc" });
      v.avatarTransform = MATE_FRAME;
      return v;
    } catch (e) {
      console.warn("teammate avatar:", e);
      $("#mateTile").classList.add("no-avatar");
      return null;
    }
  })();
  return mateMounting;
}
async function joinMate(mod, conn) {
  mateView = await mountMate(conn.avatarId);
  mateCall = await mod[mateView ? "joinCall" : "joinCallVoiceOnly"](...(mateView ? [mateView] : []), conn, {
    micTrack: null,
    onRemoteAudio: async (track) => {
      media.untapThem.push(await tapStream(new MediaStream([track]), 2, (buf) => {
        if (!ui.inCall) return;
        sendFrame(2, buf);
        mateLevel(buf);
      }));
    },
    onTranscript: (t) => {
      if (t.local) return;
      chatLine("julian", t.text, `m-${t.id}`, !t.final);
      showCaption("Julian", t.text, !t.final);
      if (t.final) {
        remember("julian", t.text);
        // Grace hears what Julian said once he's finished talking, so she can react to it.
        whenMateQuiet(() => call?.sendText(`(Julian, the Arize solutions engineer, just said:) ${t.text}`).catch(() => {}));
      }
    },
    onState: (s, detail) => { if (s === "failed" || s === "error") addHint(`Julian's connection: ${detail || s}`, "warning"); },
  });
}
function whenMateQuiet(fn, started = Date.now()) {
  const loud = $("#mateTile").classList.contains("speaking");
  if (!loud && Date.now() - started > 500) return fn();
  if (Date.now() - started > 10000) return fn();
  setTimeout(() => whenMateQuiet(fn, started), 200);
}
function mateLevel(buf) {
  const pcm = new Int16Array(buf);
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 8) sum += (pcm[i] / 32768) ** 2;
  if (Math.sqrt(sum / (pcm.length / 8)) > 0.02) {
    const tile = $("#mateTile");
    tile.classList.add("speaking");
    clearTimeout(tile._t);
    tile._t = setTimeout(() => tile.classList.remove("speaking"), 450);
  }
}
const NAMES = { you: "Jordan", grace: "Grace", julian: "Julian" };
function remember(who, text) {
  if (!text?.trim()) return;
  if (REC) (window.__convo ??= []).push({ who, text: text.trim(), at: Date.now() });
  (ui.convo ??= []).push({ who, text: text.trim() });
  if (ui.convo.length > 14) ui.convo.shift();
}
// "Julian, can you…", "@Julian …" or a line that starts with his name.
const addressesMate = (text) => !!mateCall && (/^\s*@?julian\b/i.test(text) || /\bjulian,\s*(can|could|would|will|what|where|when|how|why|do|does|is|are|please|walk|tell|show|explain|take)\b/i.test(text));
let lastMateAsk = {};
async function askMate(request) {
  if (!mateCall) return;
  // The same line can arrive twice (typed or exact, then transcribed): skip a near-copy within 8 s.
  const words = new Set(request.toLowerCase().match(/[a-z0-9']+/g) || []);
  const same = [...(lastMateAsk.words || [])].filter((w) => words.has(w)).length / Math.max(1, Math.min(words.size, lastMateAsk.words?.size || 0));
  if (Date.now() - (lastMateAsk.at || 0) < 8000 && same > 0.6) return;
  lastMateAsk = { at: Date.now(), words };
  const context = (ui.convo || []).slice(-6).map((c) => `${NAMES[c.who]}: ${c.text}`).join("\n");
  try {
    await mateCall.sendText(`(Recent conversation on the call)\n${context}\n\n(Now, to you:) ${request}`);
  } catch {
    addHint("Couldn't reach Julian. Check the connection.", "warning");
  }
}
$("#askMateBtn").onclick = () => {
  if (!mateCall) return addHint("Julian joins once the call starts.");
  const line = "Julian, can you walk Grace through that?";
  remember("you", line);
  chatLine("you", line);
  askMate(line);
};

// Without the avatar, Grace's tile is a still photo that glows while she talks.
function speakingFromLevel(buf) {
  const pcm = new Int16Array(buf);
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 8) sum += (pcm[i] / 32768) ** 2;
  const loud = Math.sqrt(sum / (pcm.length / 8)) > 0.02;
  const still = $("#customerStill");
  if (loud) { still.classList.add("speaking"); clearTimeout(still._t); still._t = setTimeout(() => still.classList.remove("speaking"), 400); }
}

// ------------------------------------------------------------------ text mode
// For presenting over Zoom (where the mic belongs to the meeting): type your lines; the customer
// agent hears them as text and answers out loud, and both sides show as a chat on the video.
function setTextMode(on) {
  ui.textMode = on;
  $("#textModeToggle").checked = on;
  $("#chatDock").hidden = !on;
  if (on) clearCaptions();
  if (media.pub) media.pub.enabled = !on && !ui.muted;
  $("#ctlLabel").textContent = on ? "Text chat" : "";
  renderControls();
  if (on && ui.inCall) setTimeout(() => $("#chatInput").focus(), 60);
}
const chatSegs = new Map();
function chatLine(who, text, id, live = false) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return;
  const log = $("#chatLog");
  let el = id ? chatSegs.get(id) : null;
  if (!el) {
    el = document.createElement("div");
    el.className = `chat-msg ${who}`;
    el.innerHTML = `<b>${who === "you" ? "You (Jordan)" : who === "julian" ? "Julian · Arize" : "Grace"}</b><span></span>`;
    log.append(el);
    if (id) chatSegs.set(id, el);
    while (log.children.length > 30) log.firstElementChild.remove();
  }
  $("span", el).textContent = t;
  el.classList.toggle("live", live);
  window.__lastChatAt = Date.now();
  log.scrollTop = log.scrollHeight;
}
$("#chatForm").onsubmit = async (e) => {
  e.preventDefault();
  const input = $("#chatInput");
  const text = input.value.trim();
  if (!text) return;
  if (!call) return addHint("Join the call first, then type to Grace.");
  input.value = "";
  chatLine("you", text);
  remember("you", text);
  if (addressesMate(text)) askMate(text);
  else {
    try { await call.sendText(text); } catch { addHint("Couldn't reach Grace. Check your connection.", "warning"); }
  }
  send({ type: "typed", text });
};
$("#textModeToggle").onchange = async (e) => {
  const on = e.target.checked;
  if (!on && ui.inCall && !media.mic) {
    // Switching to the mic mid-call: open it now and put it on the call.
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      media.mic = s.getAudioTracks()[0];
      media.pub = media.mic.clone();
      media.untapMic = await tapStream(new MediaStream([media.mic]), 0, (buf) => { meter(buf); if (ui.inCall && !ui.muted && !ui.textMode) sendFrame(0, buf); });
      await call?.publishMic(media.pub);
    } catch {
      e.target.checked = true;
      return addHint("The microphone is blocked, so text chat stays on.", "warning");
    }
  }
  setTextMode(on);
};

async function leaveCall({ quiet = false } = {}) {
  if (ui.roleplay) return endAudioOnly();
  if (ui.capture) return stopCapture();
  if (rec.running) return stopRecorded();
  if (!ui.inCall) return;
  ui.inCall = false;
  const duration = $("#callTimer").textContent;
  await call?.leave();
  call = null;
  await mateCall?.leave();
  mateCall = null;
  $("#mateTile").classList.remove("speaking");
  send({ type: "call_end" });
  closeDevices();
  stopTimer();
  connecting("");
  setLive(false);
  clearCaptions();
  renderControls();
  $("#ctlLabel").textContent = "";
  if (quiet) return;
  $("#chatDock").hidden = true;
  showSummary(duration);
}
function showSummary(duration) {
  const cards = [...ui.cards.values()].filter((c) => c.status === "ready");
  const n = (t) => cards.filter((c) => c.type === t).length;
  const sent = ui.actionLog.length;
  $("#joinEyebrow").textContent = `Call ended · ${duration}`;
  $("#joinTitle").textContent = "Nice work. Here’s what Callie did.";
  $("#joinText").textContent = "Everything stays in the panel: open any earlier moment to see it again.";
  const plural = (k, one, many) => `<div><b>${k}</b><span>${k === 1 ? one : many}</span></div>`;
  $("#joinActions").innerHTML = `<div class="stats">${plural(n("answer") + n("callie"), "answer", "answers")}${plural(n("check"), "correction", "corrections")}${plural(n("coach") + sent, "nudge or send", "nudges and sends")}</div>
    <button class="cds-btn lg" id="joinBtn">Start a new call</button>
    <div class="join-row"><a class="cds-btn outline" href="/">Back to the overview</a></div>`;
  $("#joinBtn").onclick = () => { resetJoinCard(); joinCall(); };
  overlay(true);
  chatSegs.clear();
  $("#chatLog").innerHTML = "";
}
function resetJoinCard() {
  $("#joinEyebrow").textContent = "Onboarding working session";
  $("#joinTitle").textContent = "Ready to join your call with Grace?";
  $("#joinText").textContent = "Grace is an AI customer: a Gemini Live voice with a Spatius avatar, on a LiveKit call. Callie listens to both of you and helps only you.";
  $("#joinActions").innerHTML = `<button class="cds-btn lg" id="joinBtn">Join call</button><div class="join-row"><button class="cds-btn outline" id="joinTextBtn">Join with text chat (no mic)</button></div>`;
  $("#joinBtn").onclick = () => joinCall({ text: false });
  $("#joinTextBtn").onclick = () => joinCall({ text: true });
}

// ------------------------------------------------------------------ audio-only call (fallback)
const lanes = { whisper: 0, persona: 0 };
async function startAudioOnly() {
  if (ui.inCall || ui.roleplay) return;
  ctx();
  try { await openDevices({ video: true }); } catch { return showJoinError("Callie Live Assistant needs your microphone. Allow it in the address bar, then try again."); }
  await wsReady;
  ui.roleplay = true;
  $("#stage").classList.add("no-avatar");
  overlay(false);
  connecting("Calling Grace…");
  setLive(true);
  renderControls();
  send({ type: "roleplay_start" });
  startTimer();
}
function endAudioOnly() {
  ui.roleplay = false;
  send({ type: "roleplay_stop" });
  const duration = $("#callTimer").textContent;
  closeDevices();
  stopTimer();
  setLive(false);
  connecting("");
  clearCaptions();
  renderControls();
  showSummary(duration);
}
function playPersona(b64, mime) {
  connecting("");
  const c = ctx();
  scheduleOn("persona", pcmBuffer(c, b64, mime));
  const still = $("#customerStill");
  still.classList.add("speaking");
  clearTimeout(still._t);
  still._t = setTimeout(() => still.classList.remove("speaking"), Math.max(300, (lanes.persona - c.currentTime) * 1000));
}

// ------------------------------------------------------------------ real meeting (Mac only)
async function startCapture() {
  ctx();
  try { await openDevices({ video: false }); } catch { addHint("Microphone blocked. Callie can still hear the customer.", "warning"); }
  ui.capture = true;
  send({ type: "start", mode: "capture" });
  overlay(true);
  $("#joinEyebrow").textContent = "Real meeting";
  $("#joinTitle").textContent = "Callie is listening to your meeting.";
  $("#joinText").textContent = "Keep Zoom, Meet or Teams in its own window. Callie hears the customer through your Mac’s audio and you through the mic, and helps on the right.";
  $("#joinActions").innerHTML = `<button class="cds-btn lg" id="stopCaptureBtn">Stop listening</button>`;
  $("#stopCaptureBtn").onclick = stopCapture;
  setLive(true);
  renderControls();
}
function stopCapture() {
  ui.capture = false;
  send({ type: "stop" });
  closeDevices();
  setLive(false);
  resetJoinCard();
  renderControls();
}

// ------------------------------------------------------------------ captions
let captionTimer;
function showCaption(who, text, live) {
  if (!ui.captions || ui.textMode || !text?.trim()) return;
  const el = $("#captions");
  const t = text.replace(/\s+/g, " ").trim();
  const words = t.split(" ");
  el.innerHTML = `<p><b class="${who === "Julian" ? "julian" : ""}">${esc(who)}</b>${esc(words.length > 28 ? `… ${words.slice(-28).join(" ")}` : t)}</p>`;
  el.hidden = false;
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => (el.hidden = true), live ? 6000 : 4000);
}
function clearCaptions() { $("#captions").hidden = true; }
$("#captionsToggle").onchange = (e) => { ui.captions = e.target.checked; if (!ui.captions) clearCaptions(); };

// ------------------------------------------------------------------ controls
function renderControls() {
  const live = ui.inCall || ui.roleplay;
  const mic = $("#micBtn");
  if (RECORDED) {
    mic.innerHTML = icon(rec.paused || !rec.running ? "play" : "pause");
    mic.title = mic.ariaLabel = rec.running ? (rec.paused ? "Resume" : "Pause") : "Play";
    mic.disabled = false;
    $("#camBtn").hidden = true;
    $("#endBtn").disabled = !rec.running;
    return;
  }
  mic.innerHTML = icon("mic", ui.muted ? `<path d="M3 3l18 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />` : "");
  mic.classList.toggle("off", ui.muted);
  mic.title = mic.ariaLabel = ui.muted ? "Unmute" : "Mute";
  mic.disabled = !live || !media.mic || ui.textMode;
  const cam = $("#camBtn");
  cam.innerHTML = icon("video", !ui.camOn ? `<path d="M3 3l18 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />` : "");
  cam.classList.toggle("off", !ui.camOn);
  cam.disabled = !media.cam;
  $("#selfView").classList.toggle("muted", ui.muted);
  $("#pttBtn").disabled = !(live || ui.capture) || !media.mic || ui.textMode;
}
$("#micBtn").onclick = () => {
  if (RECORDED) return rec.running ? togglePause() : playRecorded("after");
  ui.muted = !ui.muted;
  if (media.mic) media.mic.enabled = !ui.muted;
  if (media.pub) media.pub.enabled = !ui.muted;
  renderControls();
};
$("#camBtn").onclick = () => {
  if (!media.cam) return;
  ui.camOn = !ui.camOn;
  media.cam.enabled = ui.camOn;
  $("#selfView").classList.toggle("has-video", ui.camOn);
  renderControls();
};
$("#shareBtn").onclick = () => presentBoard();
$("#endBtn").onclick = () => leaveCall();
$("#moreBtn").onclick = (e) => { e.stopPropagation(); $("#menu").hidden = !$("#menu").hidden; };
document.addEventListener("click", (e) => {
  if (!e.target.closest("#menu, #moreBtn")) $("#menu").hidden = true;
  if (!e.target.closest("#toolMenu, #toolBtn")) $("#toolMenu").hidden = true;
});
$("#whisperMode").onchange = (e) => send({ type: "settings", settings: { whisper: e.target.value } });
$("#coachToggle").onchange = (e) => send({ type: "settings", settings: { coach: e.target.checked } });
$("#profileSel").onchange = (e) => {
  if (ui.inCall) { e.target.value = ui.scenario?.id || e.target.value; return addHint("Leave the call first, then switch scenarios."); }
  applyScenario(e.target.value);
};

// ------------------------------------------------------------------ scenarios
const SCENARIOS = config.scenarios || [];
function applyScenario(id) {
  const s = SCENARIOS.find((x) => x.id === id) || SCENARIOS[0];
  if (!s) return;
  ui.scenario = s;
  $("#scenarioSel").value = s.id;
  $("#scenarioBlurb").textContent = s.blurb;
  $("#nameRole").textContent = s.role;
  $("#whoRole").textContent = `Cartwell · ${s.role} · booked via Calendly`;
  $("#mateTile").hidden = !s.teammate;
  if (s.teammate) {
    $("#mateLabel").textContent = `${s.teammate.name} · Arize`;
    $("#askMateBtn").textContent = `Ask ${s.teammate.name.split(" ")[0]}`;
    loadCallModule().then((mod) => mod.prefetchAvatar({ appId: config.spatiusAppId, avatarId: s.teammate.avatarId })).catch(() => {});
    if (!$("#app").hidden) mountMate(s.teammate.avatarId);
  }
  try { localStorage.setItem("callie-scenario-v2", s.id); } catch {}
  wsReady.then(() => send({ type: "profile", name: s.id }));
}
$("#scenarioSel").innerHTML = SCENARIOS.map((s) => `<option value="${s.id}">${esc(s.title)}</option>`).join("");
$("#profileSel").innerHTML = SCENARIOS.map((s) => `<option value="${s.id}">${esc(s.title)}</option>`).join("");
$("#scenarioSel").onchange = (e) => applyScenario(e.target.value);
if (RECORDED || !SCENARIOS.length) {
  $("#scenarioPick").hidden = true;
  $("#scenarioBlurb").hidden = true;
} else {
  let saved = "";
  try { saved = localStorage.getItem("callie-scenario-v2") || ""; } catch {}
  applyScenario(SCENARIOS.some((s) => s.id === saved) ? saved : SCENARIOS[0].id);
}
$("#resetBtn").onclick = () => { send({ type: "reset" }); $("#menu").hidden = true; };
$("#openBoardBtn").onclick = () => { ui.boardOpen = true; boardChanged(); $("#menu").hidden = true; };
$("#recordedBtn").onclick = () => { location.href = "/?recorded"; };
$("#audioOnlyBtn").onclick = () => { $("#menu").hidden = true; if (RECORDED) location.href = "/?call"; else startAudioOnly(); };
$("#captureBtn").onclick = () => { $("#menu").hidden = true; startCapture(); };
$("#transcriptBtn").onclick = () => { $("#menu").hidden = true; openTranscript(); };

const SIM = [
  ["Setup", "How do we actually get traces from our LangGraph agent into Arize?"],
  ["Privacy", "Our shoppers type addresses and order numbers into the chat. How do we keep that out of the traces?"],
  ["Confused", "Sorry, I'm a little lost. Where do the space ID and the API key even come from?"],
  ["Skeptical", "Honestly, our last observability tool slowed down checkout. Why would this be any different?"],
  ["EU", "Some of our marketplaces are in Europe. Can the trace data stay in the EU?"],
];
$("#simMenu").innerHTML = SIM.map(([tag, text], i) => `<button class="item" type="button" data-i="${i}"><b>${tag}</b><span class="sub">${esc(text.slice(0, 48))}…</span></button>`).join("");
$("#simMenu").onclick = (e) => {
  const b = e.target.closest("button");
  if (b) send({ type: "simulate", text: SIM[Number(b.dataset.i)][1] });
};

// ------------------------------------------------------------------ Callie's whispers
function pcmBuffer(c, b64, mime) {
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  const rate = Number((mime.match(/rate=(\d+)/) || [])[1] || 24000);
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  const buf = c.createBuffer(1, pcm.length, rate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
  return buf;
}
function scheduleOn(lane, buf, onStart) {
  const c = ctx();
  const src = c.createBufferSource();
  src.buffer = buf;
  src.connect(c.destination);
  toMix(src);
  const at = Math.max(c.currentTime + 0.03, lanes[lane]);
  src.start(at);
  lanes[lane] = at + buf.duration;
  onStart?.();
  src.startedAt = Date.now() + (at - c.currentTime) * 1000;
  return src;
}
function playWhisper(id, b64, mime) {
  const c = ctx();
  const go = (buf) => {
    const src = scheduleOn("whisper", buf, () => { if (!ui.speaking) startSpeaking(ui.whisperText.get(id)); });
    src.onended = maybeStopSpeaking;
    if (REC) recLog({ type: "pcm", at: src.startedAt, rate: buf.sampleRate, data: b64, wav: /wav/.test(mime) });
  };
  if (/wav/.test(mime)) {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    c.decodeAudioData(bytes.buffer.slice(0)).then(go).catch(() => {});
  } else go(pcmBuffer(c, b64, mime));
}
function startSpeaking(text) {
  ui.speaking = true;
  send({ type: "speaking", on: true });
  let toast = $(".whisper-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "whisper-toast";
    document.body.append(toast);
  }
  toast.innerHTML = `<span class="dot"></span><span>Callie, in your ear: ${esc(text || "")}</span>`;
}
function maybeStopSpeaking() {
  if (!ui.speaking || !audioCtx) return;
  if (audioCtx.currentTime + 0.05 < lanes.whisper) return;
  ui.speaking = false;
  send({ type: "speaking", on: false });
  $(".whisper-toast")?.remove();
}
setInterval(maybeStopSpeaking, 300);

// ------------------------------------------------------------------ Now + Earlier
// One moment at a time. The main card is the latest answer or correction, unless the current
// one matters more and only just arrived. The latest coaching sits under it as a chip, and the
// most recent thing worth sending sits under that. Everything else drops into Earlier.
const PRIORITY = { check: 3, callie: 3, answer: 2, coach: 1 };
const firstName = (full) => (full || ui.account?.attendees?.[0]?.name || "the customer").split(" ")[0];
const timeOf = (at) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const firstSentence = (t) => (t || "").split(/(?<=[.!?])\s/)[0];
const shortOf = (c) => (c.type === "check" ? c.correction : c.type === "coach" ? c.nudge : c.short || firstSentence(c.answer));

function summaryOf(c) {
  if (c.type === "check") return `${c.clarify ? "Clarified" : "Corrected"}: ${c.correction}`;
  if (c.type === "coach") return `Coached: ${c.nudge}`;
  if (c.type === "callie") return `You asked Callie: ${c.question}`;
  if (c.type === "missed") return `Missed: ${c.text}`;
  return `${firstName(c.askerName)} asked: ${c.question}`;
}
function sourceLine(c) {
  const s = c.sources?.[0];
  return s ? `<div class="src">Source: <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>${c.sources.length > 1 ? ` +${c.sources.length - 1}` : ""}</div>` : "";
}
function momentHtml(c) {
  const lat = c.latencyMs ? `${(c.latencyMs / 1000).toFixed(1)}s · ` : "";
  const meta = `<span class="meta">${lat}${timeOf(c.at)}</span>`;
  if (c.status === "thinking") {
    return `<div class="moment thinking"><div class="kicker"><span class="ic" style="background:var(--c-ink-3)">${icon("book")}</span>Looking it up ${meta}</div><div class="q">${esc(c.question)}</div><div class="shimmer"></div><div class="shimmer short"></div></div>`;
  }
  if (c.status === "error") return `<div class="moment error"><div class="kicker">Couldn’t answer ${meta}</div><div class="q">${esc(c.answer)}</div></div>`;
  if (c.type === "answer" || c.type === "callie") {
    const kicker = c.type === "callie" ? "For you" : `${esc(firstName(c.askerName))} asked`;
    return `<div class="moment ${c.type}" data-cid="${c.id}">
      <div class="kicker"><span class="ic">${icon(c.type === "callie" ? "spark" : "book")}</span>${kicker} ${meta}</div>
      <div class="main">${rich(shortOf(c))}</div>
      <div class="q">${esc(c.question)}</div>
      <div class="acts">${c.type === "answer" ? `<button class="mini go" data-a="email" title="${esc(c.sendLabel || `Email ${firstName(c.askerName)} this answer`)}">Send</button>` : ""}<button class="mini" data-a="board">Show on board</button><button class="mini" data-a="more">More</button></div>
      <div class="more">${rich(c.answer)}
        ${c.detail?.length ? `<ul>${c.detail.map((d) => `<li>${rich(d)}</li>`).join("")}</ul>` : ""}
        ${c.privateNote ? `<div class="private-note"><b>For your eyes only</b>${rich(c.privateNote)}</div>` : ""}
        ${sourceLine(c)}
        <button class="mini" data-a="share">Make a one-page guide</button>
      </div></div>`;
  }
  if (c.type === "check") {
    const kicker = c.clarify ? `Clarify · ${esc(firstName(c.speaker))} has it wrong` : c.teammate ? `Correction · ${esc(firstName(c.speaker))} misspoke` : "Correction";
    return `<div class="moment ${c.clarify ? "clarify" : "check"}" data-cid="${c.id}">
      <div class="kicker"><span class="ic">${icon("alert")}</span>${kicker} ${meta}</div>
      <div class="main">${rich(c.correction)}</div>
      <div class="said">“${esc(c.claim)}”</div>
      ${c.sayInstead ? `<div class="say"><b>Say:</b>${rich(c.sayInstead)}</div>` : ""}
      <div class="acts"><button class="mini" data-a="email">Email the right info</button><button class="mini" data-a="more">Source</button></div>
      <div class="more">${sourceLine(c) || "No source attached."}</div></div>`;
  }
  if (c.type === "coach") {
    const tone = c.tone === "talk-time" ? "Talk time" : `${firstName(c.speaker)} sounds ${c.tone}`;
    return `<div class="moment coach" data-cid="${c.id}"><div class="kicker"><span class="ic">${icon("chat")}</span>${esc(tone)} ${meta}</div><div class="main">${rich(c.nudge)}</div>${c.say ? `<div class="say"><b>Try:</b>${rich(c.say)}</div>` : ""}</div>`;
  }
  if (c.type === "missed") return `<div class="moment thinking"><div class="kicker">Missed moment ${meta}</div><div class="q">${esc(c.text)}</div></div>`;
  return "";
}
function wire(el, c) {
  el.querySelectorAll("[data-a]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const a = b.dataset.a;
      if (a === "more") b.closest(".moment").classList.toggle("open");
      if (a === "email") requestEmail(c.id);
      if (a === "share") requestShare(c.id);
      if (a === "board") send({ type: "board_from_card", cardId: c.id });
    };
  });
}
function sendable() {
  return [...ui.order].reverse().map((id) => ui.cards.get(id)).find((c) => c && c.type === "answer" && c.status === "ready");
}
function latestCoach() {
  const c = [...ui.order].reverse().map((id) => ui.cards.get(id)).find((x) => x?.type === "coach");
  return c && Date.now() - c.at < 150000 ? c : null;
}
function renderNow() {
  const stack = $("#now");
  const primary = ui.cards.get(ui.primaryId);
  $$(".moment, .coach-chip, .action-row", stack).forEach((x) => x.remove());
  $("#nowEmpty").hidden = !!primary;
  // The board dims while the moment in focus is about something else.
  $("#boardCard").classList.toggle("dim", !!primary && (ui.primaryAt || 0) - (ui.lastBoardAt || 0) > 2500);
  if (primary) {
    stack.insertAdjacentHTML("beforeend", momentHtml(primary));
    const el = stack.lastElementChild;
    wire(el, primary);
    if (primary.type === "check" && !primary.clarify && primary.severity !== "low" && !primary._blinked) {
      primary._blinked = true;
      el.classList.add("blink");
      const flash = document.createElement("div");
      flash.className = "edge-flash";
      document.body.append(flash);
      setTimeout(() => flash.remove(), 2300);
    }
  }
}
function shownNow() {
  return new Set([ui.primaryId].filter(Boolean));
}
const TL_ICON = { answer: "book", ask: "spark", callie: "spark", check: "alert", clarify: "alert", coach: "chat", missed: "clock", action: "mail" };
function renderTimeline() {
  const list = $("#timeline");
  const open = new Set($$(".tl.open", list).map((x) => x.dataset.cid));
  const shown = shownNow();
  const rows = [];
  for (const id of [...ui.order].reverse()) {
    const c = ui.cards.get(id);
    if (!c || shown.has(id) || c.status === "thinking") continue;
    const kind = c.type === "check" && c.clarify ? "clarify" : c.type === "callie" ? "ask" : c.type;
    rows.push({ at: c.at, html: `<div class="tl ${kind}${open.has(id) ? " open" : ""}" data-cid="${id}"><span class="ic">${icon(TL_ICON[kind] || "book")}</span><span class="t">${esc(summaryOf(c))}</span><svg class="chev"><use href="#i-down" /></svg>${open.has(id) ? `<div class="detail">${momentHtml(c)}</div>` : ""}</div>` });
  }
  for (const a of ui.actionLog) rows.push({ at: a.at, html: `<div class="tl action"><span class="ic">${icon("mail")}</span><span class="t">${esc(a.text)}</span></div>` });
  rows.sort((x, y) => y.at - x.at);
  list.innerHTML = rows.map((r) => r.html).join("");
  $$(".tl[data-cid]", list).forEach((row) => {
    row.onclick = (e) => {
      if (e.target.closest("button, a")) return;
      row.classList.toggle("open");
      renderTimeline();
    };
    const card = $(".moment", row);
    if (card) wire(card, ui.cards.get(row.dataset.cid));
  });
  const extra = Math.max(0, rows.length - 3);
  const expanded = $("#earlier").classList.contains("expanded");
  $("#tlToggle").hidden = !extra;
  $("#tlCount").textContent = expanded ? "Show less" : `+${extra} earlier`;
}
$("#tlToggle").onclick = () => { $("#earlier").classList.toggle("expanded"); renderTimeline(); };
function upsertCard(card) {
  const isNew = !ui.cards.has(card.id);
  const prev = ui.cards.get(card.id);
  if (prev?._blinked) card._blinked = true;
  ui.cards.set(card.id, card);
  if (isNew) ui.order.push(card.id);
  if (card.type !== "missed") {
    const current = ui.cards.get(ui.primaryId);
    // Coaching never bumps an answer that's still loading; it waits its turn behind the moment in focus.
    const takeOver = card.type === "coach"
      ? !current || (current.status !== "thinking" && Date.now() - ui.primaryAt > 6000)
      : !current || card.id === ui.primaryId || current.status === "thinking" || (PRIORITY[card.type] || 1) >= (PRIORITY[current.type] || 1) || Date.now() - ui.primaryAt > 4000;
    if (takeOver && (isNew || card.id === ui.primaryId || current?.status === "thinking")) {
      if (card.id !== ui.primaryId) { ui.primaryId = card.id; ui.primaryAt = Date.now(); }
    }
  }
  renderNow();
  renderTimeline();
}
function resetPanel() {
  ui.cards.clear();
  ui.order.length = 0;
  ui.primaryId = null;
  ui.actionLog = [];
  ui.transcript = [];
  renderNow();
  renderTimeline();
  $("#drawer").hidden = true;
  clearBoard();
}
setInterval(() => { if (ui.order.length) renderNow(); }, 15000); // let stale coaching fall into Earlier

// ------------------------------------------------------------------ drafts drawer
function drawer(htmlStr) {
  const d = $("#drawer");
  d.innerHTML = htmlStr;
  d.hidden = false;
  if (REC) { clearTimeout(d._t); d._t = setTimeout(() => { if (!$(".shimmer", d)) d.hidden = true; }, 9000); }
  $("[data-close]", d)?.addEventListener("click", () => (d.hidden = true));
  return d;
}
const closeBtn = `<button class="mini" data-close type="button">Close</button>`;
function requestEmail(cardId) {
  send({ type: "email_draft", cardId });
  const c = ui.cards.get(cardId);
  drawer(`<div class="drawer-head"><b>Drafting an email to ${esc(firstName(c?.askerName))}…</b>${closeBtn}</div><div class="shimmer"></div><div class="shimmer short"></div>`);
}
function requestShare(cardId) {
  send({ type: "share", cardId });
  drawer(`<div class="drawer-head"><b>Building a page you can screen-share…</b>${closeBtn}</div><div class="shimmer"></div>`);
}
function onEmail(m) {
  if (m.phase === "drafting" && m.auto) drawer(`<div class="drawer-head"><b>Drafting the email you mentioned…</b>${closeBtn}</div><div class="shimmer"></div>`);
  if (m.phase === "draft") {
    const d = m.draft;
    const canSend = !!ui.caps.email;
    const el = drawer(`<div class="drawer-head"><b>Email to ${esc(d.toName || d.to)}</b>${closeBtn}</div>
      <form>
        <label>To<input name="to" value="${esc(d.to)}" /></label>
        <label>Subject<input name="subject" value="${esc(d.subject)}" /></label>
        <label>Message<textarea name="body">${esc(d.body)}</textarea></label>
        <div class="row">
          ${canSend ? `<button class="mini" data-send="draft" type="button">Save to Gmail drafts</button><button class="cds-btn sm" data-send="now" type="button">Send now</button>` : `<a class="mini" data-mailto>Open in your mail app</a><button class="cds-btn sm" data-copy type="button">Copy email</button>`}
        </div>
        <div class="note">${canSend ? "Nothing is sent until you click Send now." : "Sending straight from Callie works in the presenter’s Mac app. Here, copy the email or open it in your mail app."}</div></form>`);
    const f = $("form", el);
    const draft = () => ({ to: f.to.value.trim(), subject: f.subject.value.trim(), body: f.body.value });
    if (canSend) {
      $('[data-send="now"]', f).onclick = () => { send({ type: "email_send", cardId: m.cardId, draft: draft() }); $(".note", f).textContent = "Sending…"; };
      $('[data-send="draft"]', f).onclick = () => { send({ type: "email_send", cardId: m.cardId, draft: draft(), asDraft: true }); $(".note", f).textContent = "Saving to Gmail drafts…"; };
    } else {
      $("[data-mailto]", f).onclick = (e) => { const d2 = draft(); e.currentTarget.href = `mailto:${encodeURIComponent(d2.to)}?subject=${encodeURIComponent(d2.subject)}&body=${encodeURIComponent(d2.body)}`; };
      $("[data-copy]", f).onclick = async () => {
        const d2 = draft();
        try { await navigator.clipboard.writeText(`To: ${d2.to}\nSubject: ${d2.subject}\n\n${d2.body}`); $(".note", f).textContent = "Copied. Paste it into your email."; } catch { $(".note", f).textContent = "Couldn't copy. Select the message and copy it."; }
      };
    }
  }
  if (m.phase === "sent" || m.phase === "saved") {
    $("#drawer").hidden = true;
    ui.actionLog.push({ text: m.phase === "sent" ? `Emailed ${m.to}` : "Saved an email to Gmail drafts", at: Date.now() });
    addHint(m.phase === "sent" ? `Sent to ${m.to} while you’re still on the call.` : "Saved to your Gmail drafts.");
    renderTimeline();
  }
  if (m.phase === "failed") {
    const note = $("#drawer .note");
    if (note) note.textContent = `Couldn’t send: ${m.error}.`;
  }
}
function onShare(m) {
  if (m.phase === "building" && m.auto) drawer(`<div class="drawer-head"><b>Building the one-page guide…</b>${closeBtn}</div><div class="shimmer"></div>`);
  if (m.phase !== "ready") return;
  const url = `${location.origin}${m.url}`;
  const el = drawer(`<div class="drawer-head"><b>${esc(m.title)}</b>${closeBtn}</div>
    <div class="row" style="display:flex;gap:8px;flex-wrap:wrap"><a class="cds-btn sm" href="${esc(url)}" target="_blank" rel="noopener">Open to screen-share</a><button class="mini" data-copy type="button">Copy link</button></div>`);
  $("[data-copy]", el).onclick = () => navigator.clipboard.writeText(url).catch(() => {});
  ui.actionLog.push({ text: `Made a page: ${m.title}`, at: Date.now() });
  renderTimeline();
}
function refreshTranscript() {
  const box = $("#drawer .transcript");
  if (box) box.innerHTML = transcriptHtml();
}
function transcriptHtml() {
  if (!ui.transcript.length) return `<div class="note">Nothing yet. Lines appear here as Callie hears them.</div>`;
  return ui.transcript.map((u) => `<div><span class="who">${esc(u.speaker || (u.who === "you" ? "You" : firstName()))}</span>${esc(u.text)}${u.tone && u.tone !== "neutral" ? `<span class="tone">${esc(u.tone)}</span>` : ""}</div>`).join("");
}
function openTranscript() {
  drawer(`<div class="drawer-head"><b>Transcript</b>${closeBtn}</div><div class="transcript">${transcriptHtml()}</div>`);
}

// ------------------------------------------------------------------ hints
function addHint(text, tone = "info") {
  const el = document.createElement("div");
  el.className = `hint ${tone}`;
  el.innerHTML = `<span>${esc(text)}</span><button aria-label="Dismiss">✕</button>`;
  $("button", el).onclick = () => el.remove();
  $("#hints").prepend(el);
  setTimeout(() => el.remove(), 12000);
}

// ------------------------------------------------------------------ whiteboard
function boardItemHtml(b) {
  const who = `<span class="b-who">${b.origin === "you" ? "You" : "Callie"}</span>`;
  const title = b.title ? `<span class="b-title">${esc(b.title)}</span>` : "<span></span>";
  if (b.type === "note" || b.type === "text") return `<div class="b-head">${title}${who}</div><div class="b-text">${rich(b.text)}</div>`;
  if (b.type === "code") return `<div class="b-head">${title}<span style="display:flex;gap:8px;align-items:center"><span class="lang">${esc(b.language)}</span><button class="copy" data-copy type="button">Copy</button></span></div><pre>${esc(b.code)}</pre>`;
  if (b.type === "flow") {
    const nodes = b.steps.map((s, i) => {
      const [label, cap] = s.split(/\s+\|\s+/);
      const node = `<span class="node" style="animation-delay:${i * 0.12}s"><b>${esc(label)}</b>${cap ? `<span>${esc(cap)}</span>` : ""}</span>`;
      return `<span class="fstep">${i ? `<span class="arrow"><svg viewBox="0 0 30 18"><use href="#i-flow-arrow" width="30" height="18" /></svg></span>` : ""}${node}</span>`;
    }).join("");
    return `${b.title ? `<div class="b-head">${title}${who}</div>` : ""}<div class="flow">${nodes}</div>`;
  }
  if (b.type === "checklist") return `<div class="b-head">${title}${who}</div><ul>${b.items.map((s) => `<li><input type="checkbox" /><span>${rich(s)}</span></li>`).join("")}</ul>`;
  return "";
}
function addBoardItem(b, animate) {
  const el = document.createElement("div");
  el.className = `bitem ${b.type}${b.type === "note" ? ` ${b.tone || "info"}` : ""}`;
  el.dataset.bid = b.id;
  el.innerHTML = boardItemHtml(b);
  $("[data-copy]", el)?.addEventListener("click", () => navigator.clipboard.writeText(b.code).catch(() => {}));
  el.addEventListener("click", (e) => onItemClick(e, el));
  $$(".bitem", $("#boardItems")).forEach((x) => x.classList.add("older"));
  $("#boardItems").prepend(el);
  if (b.origin !== "you") { ui.lastBoardAt = Date.now(); $("#boardCard").classList.remove("dim"); }
  boardChanged();
  if (animate && b.origin !== "you") {
    $("#board").scrollTo({ top: 0, behavior: "smooth" });
    moveCursorTo(el);
  }
}
let cursorTimer;
function moveCursorTo(el) {
  const cur = $("#boardCursor");
  cur.classList.add("show");
  requestAnimationFrame(() => (cur.style.transform = `translate(${el.offsetLeft + Math.min(el.offsetWidth - 60, 90)}px, ${el.offsetTop + 16}px)`));
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => cur.classList.remove("show"), 2600);
}
function boardChanged() {
  const n = $$(".bitem", $("#boardItems")).length;
  $("#boardEmpty").hidden = n > 0 || ui.strokes.length > 0;
  $("#boardCard").hidden = !(n > 0 || ui.strokes.length > 0 || ui.boardOpen);
  $("#ink").style.height = `${$("#board").scrollHeight}px`;
}
function clearBoard() {
  $$(".bitem", $("#boardItems")).forEach((x) => x.remove());
  $("#ink").innerHTML = "";
  ui.strokes = [];
  boardChanged();
}
function presentBoard() {
  window.open(`/board.html?sid=${encodeURIComponent(sid)}`, "callie-board", "width=1100,height=760");
}
function setTool(t) {
  $("#toolMenu").hidden = true;
  if (t === "present") return presentBoard();
  if (t === "clear") {
    if (($$(".bitem", $("#boardItems")).length || ui.strokes.length) && confirm("Clear the whiteboard?")) {
      send({ type: "board_user", op: "clear" });
      clearBoard();
    }
    return;
  }
  ui.tool = t;
  $$("#toolMenu [data-tool]").forEach((b) => b.classList.toggle("is-active", b.dataset.tool === t));
  ["pen", "eraser", "sticky"].forEach((x) => $("#board").classList.toggle(x, x === t));
  $("#toolBtn").classList.toggle("on", t !== "select");
  $("#toolBtn").title = t === "select" ? "Draw together" : `${t[0].toUpperCase()}${t.slice(1)}`;
  if (t === "sticky") addSticky();
}
$("#toolBtn").onclick = (e) => { e.stopPropagation(); $("#toolMenu").hidden = !$("#toolMenu").hidden; };
$$("#toolMenu [data-tool]").forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
function onItemClick(e, el) {
  if (e.target.closest("input, button, a")) return;
  if (ui.tool === "eraser") {
    send({ type: "board_user", op: "erase", id: el.dataset.bid });
    el.remove();
    boardChanged();
    return;
  }
  if (ui.tool === "select") {
    ui.selected?.classList.remove("selected");
    ui.selected = ui.selected === el ? null : el;
    ui.selected?.classList.add("selected");
  }
}
function addSticky() {
  const ed = document.createElement("div");
  ed.className = "sticky-editor";
  ed.innerHTML = `<textarea placeholder="Type a note, then press Enter"></textarea>`;
  $("#boardItems").prepend(ed);
  const ta = $("textarea", ed);
  ta.focus();
  ta.addEventListener("keydown", (k) => {
    if (k.key === "Escape") { ed.remove(); setTool("select"); }
    if (k.key === "Enter" && !k.shiftKey) {
      k.preventDefault();
      const text = ta.value.trim();
      ed.remove();
      if (text) send({ type: "board_user", op: "add", item: { type: "note", title: "Note", text, tone: "info" } });
      setTool("select");
    }
  });
}
let drawing = null;
const ink = $("#ink");
ink.addEventListener("pointerdown", (e) => {
  if (ui.tool !== "pen") return;
  ink.setPointerCapture(e.pointerId);
  const r = ink.getBoundingClientRect();
  drawing = { points: [[e.clientX - r.left, e.clientY - r.top]], el: document.createElementNS("http://www.w3.org/2000/svg", "path") };
  ink.append(drawing.el);
});
ink.addEventListener("pointermove", (e) => {
  if (!drawing) return;
  const r = ink.getBoundingClientRect();
  drawing.points.push([e.clientX - r.left, e.clientY - r.top]);
  drawing.el.setAttribute("d", smooth(drawing.points));
});
ink.addEventListener("pointerup", () => {
  if (!drawing) return;
  const path = drawing.el;
  path.addEventListener("click", () => { if (ui.tool === "eraser") path.remove(); });
  ui.strokes.push(path);
  drawing = null;
  boardChanged();
});
function smooth(pts) {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) d += ` Q${pts[i][0]},${pts[i][1]} ${(pts[i][0] + pts[i + 1][0]) / 2},${(pts[i][1] + pts[i + 1][1]) / 2}`;
  const last = pts[pts.length - 1];
  return `${d} L${last[0]},${last[1]}`;
}
window.addEventListener("resize", boardChanged);

// ------------------------------------------------------------------ keyboard
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !$("#app").hidden) {
    e.preventDefault();
    $("#askInput").focus();
    return;
  }
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || $("#app").hidden) return;
  const map = { v: "select", p: "pen", s: "sticky", e: "eraser" };
  if (map[e.key] && !e.metaKey && !e.ctrlKey && $("#board").matches(":hover")) setTool(map[e.key]);
  if ((e.key === "Delete" || e.key === "Backspace") && ui.selected) {
    send({ type: "board_user", op: "erase", id: ui.selected.dataset.bid });
    ui.selected.remove();
    ui.selected = null;
    boardChanged();
  }
});

// ------------------------------------------------------------------ ask Callie
$("#askInput").addEventListener("input", () => $("#askSend").classList.toggle("go", !!$("#askInput").value.trim()));
$("#askForm").onsubmit = (e) => {
  e.preventDefault();
  const text = $("#askInput").value.trim();
  if (!text) return;
  send({ type: "ask", text });
  $("#askInput").value = "";
  $("#askSend").classList.remove("go");
};
const ptt = $("#pttBtn");
const pttOn = (on) => {
  send({ type: "ptt", on });
  ptt.classList.toggle("down", on);
  // While you ask Callie out loud, the customer doesn't hear you.
  if (media.pub) media.pub.enabled = !on && !ui.muted;
  $("#selfView").classList.toggle("muted", on || ui.muted);
  $("#ctlLabel").textContent = on ? "Asking Callie privately" : "";
};
ptt.addEventListener("pointerdown", (e) => { if (ptt.disabled) return; e.preventDefault(); ctx(); pttOn(true); });
["pointerup", "pointerleave", "pointercancel"].forEach((ev) => ptt.addEventListener(ev, () => ptt.classList.contains("down") && pttOn(false)));

// ------------------------------------------------------------------ recorded call (backup)
// The recorded call: Grace (Cartwell) and Julian (Arize) each speak their lines through their own
// avatar in Spatius direct mode, so the lips follow the exact audio. Callie hears every line the
// way it hears a live call and helps Julian.
const rec = { script: null, manifest: null, running: false, paused: false, stop: false, audio: null, cancel: null };
async function loadScript() {
  rec.script ??= await (await fetch("/demo/call/script.json", { cache: "no-store" })).json();
  rec.manifest ??= await (await fetch("/demo/call/manifest.json", { cache: "no-store" })).json();
  return rec.script;
}
async function setupRecorded() {
  const script = await loadScript();
  $("#joinEyebrow").textContent = "Recorded call · about 4 minutes";
  $("#joinTitle").textContent = script.title || "Cartwell × Arize onboarding, with Callie";
  $("#joinText").textContent = "Grace (Cartwell) and Julian (Arize) are voiced with Gemini 3.8 Flash TTS and speak through their avatars. Callie listens and helps Julian live, exactly as in a real call.";
  const chapters = linesOf("after").map((l, i) => (l.chapter ? `<option value="${i}">${esc(l.chapter)}</option>` : "")).join("");
  $("#joinActions").innerHTML = `<button class="cds-btn lg" id="playAfterBtn">${icon("play").replace("<svg", '<svg width="16" height="16"')} Play with Callie</button>
    ${script.scripts?.before ? `<div class="join-row"><button class="cds-btn outline" id="playBeforeBtn">Play the version without Callie</button></div>` : ""}
    <label class="chapter-pick">Start at <select id="chapterSel"><option value="0">The beginning</option>${chapters}</select></label>`;
  $("#joinAlt").textContent = "Take the live call instead";
  $("#joinAlt").href = "/?call";
  $("#joinAlt").removeAttribute("data-recorded");
  $("#playAfterBtn").onclick = () => playRecorded("after", Number($("#chapterSel").value || 0));
  if ($("#playBeforeBtn")) $("#playBeforeBtn").onclick = () => playRecorded("before");
  $("#audioOnlyBtn").textContent = "Take the live call instead";
  $("#recordedBtn").hidden = true;
  $("#selfView").classList.remove("has-video");
  // Two people on this call: Grace on the stage and Julian in the corner.
  if (script.cast.csm?.avatarId) {
    $("#mateTile").hidden = false;
    $("#mateLabel").textContent = `${script.cast.csm.name} · ${script.cast.csm.org}`;
    $("#askMateBtn").hidden = true;
    $("#whoRole").textContent = `${script.cast.customer.org} · ${script.cast.customer.role} · booked via Calendly`;
    $("#nameRole").textContent = script.cast.customer.role;
    mountMate(script.cast.csm.avatarId); // Julian's avatar is ready (idle) before the call starts
  }
}
const linesOf = (name) => rec.script.scripts?.[name]?.lines || rec.script.lines;

async function prepareDirectVoice() {
  if (voiceDirect) return voiceDirect;
  try {
    const v = await mountAvatar();
    if (!v) return null;
    const r = await fetch("/api/spatius-token", { method: "POST" });
    const { sessionToken, error } = await r.json();
    if (!r.ok) throw new Error(error);
    voiceDirect = (await loadCallModule()).directVoice(v, { sessionToken });
    await voiceDirect.prepare();
    await prepareMateVoice();
    return voiceDirect;
  } catch (e) {
    console.warn("recorded avatar voice:", e);
    voiceDirect = null;
    return null;
  }
}
let mateVoice = null;
async function prepareMateVoice() {
  const id = rec.script?.cast?.csm?.avatarId;
  if (!id || mateVoice) return mateVoice;
  try {
    const v = await mountMate(id);
    if (!v) return null;
    const r = await fetch("/api/spatius-token", { method: "POST" });
    const { sessionToken, error } = await r.json();
    if (!r.ok) throw new Error(error);
    mateVoice = (await loadCallModule()).directVoice(v, { sessionToken });
    await mateVoice.prepare();
  } catch (e) {
    console.warn("recorded teammate voice:", e);
    mateVoice = null;
  }
  return mateVoice;
}
function wordsFor(line) { return line.text.replace(/\[[^\]]+\]\s*/g, "").trim(); }
function speakerTile(who, on) {
  $("#selfView").classList.toggle("speaking", on && who === "csm" && !rec.script?.cast?.csm?.avatarId);
  $("#mateTile").classList.toggle("speaking", on && who === "csm" && !!rec.script?.cast?.csm?.avatarId);
  $("#guestTile").classList.toggle("speaking", on && who === "security");
  if (who === "security" && on) $("#guestTile").hidden = false;
  $("#customerStill").classList.toggle("speaking", on && who === "customer");
}
function captionLine(line, startedAt, seconds) {
  const name = rec.script.cast[line.who].name.split(" ")[0];
  const words = wordsFor(line).split(/\s+/);
  let raf;
  const tick = () => {
    if (!rec.paused) {
      const n = Math.max(1, Math.ceil(((performance.now() - startedAt) / 1000 / seconds) * words.length * 1.08));
      showCaption(name, words.slice(0, n).join(" "), true);
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
async function playLine(line) {
  const seconds = rec.manifest[line.id]?.seconds || 3;
  const url = `/demo/audio/${line.id}.wav`;
  speakerTile(line.who, true);
  const started = performance.now();
  const stopCaption = captionLine(line, started, seconds);
  try {
    const avatarVoice = line.who === "customer" ? voiceDirect : line.who === "csm" ? mateVoice : null;
    if (avatarVoice) {
      // The speaker's avatar plays the recorded audio itself, so the lips follow it exactly.
      const wav = await (await fetch(url)).arrayBuffer();
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        let logged = false;
        avatarVoice.onState((s) => {
          if (s === "playing" && !logged) { logged = true; recLog({ type: "line", id: line.id }); }
          if (s === "idle" && performance.now() - started > 600) finish();
        });
        avatarVoice.speak(wav.slice(44), true);
        rec.cancel = () => { avatarVoice.interrupt(); finish(); };
        const guard = () => { if (done) return; if (performance.now() - started > (seconds + 4) * 1000 && !rec.paused) finish(); else setTimeout(guard, 250); };
        setTimeout(guard, 250);
      });
    } else {
      await new Promise((resolve) => {
        const audio = new Audio(url);
        rec.audio = audio;
        audio.onplaying = () => { if (!audio._logged) { audio._logged = true; recLog({ type: "line", id: line.id }); } };
        audio.onended = resolve;
        audio.onerror = resolve;
        rec.cancel = () => { audio.pause(); resolve(); };
        audio.play().catch(resolve);
      });
    }
  } finally {
    stopCaption();
    speakerTile(line.who, false);
    rec.audio = null;
  }
}
async function waitWhilePaused() { while (rec.paused && !rec.stop) await sleep(150); }
async function waitForWhisperDone(maxMs = 9000) {
  const t = Date.now();
  await sleep(250);
  while (ui.speaking && Date.now() - t < maxMs) await sleep(150);
}
async function playRecorded(name, fromIndex = 0) {
  if (rec.running) return;
  ctx();
  const withCallie = name === "after";
  await loadScript();
  overlay(false);
  connecting("Getting the recording ready…");
  await prepareDirectVoice();
  connecting("");
  Object.assign(rec, { running: true, paused: false, stop: false });
  renderControls();
  resetPanel();
  setLive(true, withCallie ? "Listening to the recorded call" : "Off for this run: watch what gets missed");
  if (withCallie) {
    send({ type: "profile", name: rec.script.profile || "recorded-call" });
    send({ type: "settings", settings: { whisper: "off" } });
    send({ type: "reset" });
    send({ type: "demo_start", mode: params.has("capture") ? "capture" : "inject" });
    await sleep(300);
  }
  startTimer();
  const cast = rec.script.cast;
  const lines = linesOf(name);
  const misses = [];
  for (let i = fromIndex; i < lines.length; i++) {
    const line = lines[i];
    if (rec.stop) break;
    await waitWhilePaused();
    if (withCallie) await waitForWhisperDone();
    if (line.chapter) recLog({ type: "chapter", title: line.chapter });
    const meta = { id: line.id, who: line.who === "csm" ? "csm" : "customer", private: !!line.private, speaker: cast[line.who].name };
    if (withCallie) send({ type: "demo_line", phase: "start", ...meta });
    await playLine(line);
    if (withCallie) send({ type: "demo_line", phase: "end", ...meta });
    if (!withCallie && line.miss) {
      misses.push(line.miss);
      upsertCard({ id: `miss-${line.id}`, type: "missed", status: "ready", text: line.miss, at: Date.now() });
    }
    if (withCallie && line.action) {
      send({ type: "demo_action", action: line.action, to: line.actionTo });
      // Wait for the draft to show before anyone reacts to it (up to 20 s).
      if (line.action === "email_latest") for (let t = 0; t < 20000 && !rec.stop && !/Subject/.test($("#drawer").hidden ? "" : $("#drawer").textContent); t += 250) await sleep(250);
    }
    let wait = line.pauseAfter ?? 500;
    while (wait > 0 && !rec.stop) { await waitWhilePaused(); await sleep(Math.min(wait, 150)); wait -= 150; }
  }
  if (withCallie) { await sleep(1200); send({ type: "demo_stop" }); }
  const stopped = rec.stop;
  rec.running = false;
  stopTimer();
  clearCaptions();
  setLive(false);
  $("#ctlLabel").textContent = "";
  renderControls();
  if (!withCallie && !stopped) {
    $("#joinEyebrow").textContent = "Without Callie";
    $("#joinTitle").textContent = `${misses.length} missed moments in under a minute.`;
    $("#joinText").textContent = "Each one turns into a follow-up email, a correction later, or lost trust. Now play the same call with Callie.";
    $("#joinActions").innerHTML = `<button class="cds-btn lg" id="playAfterBtn2">Play with Callie</button>`;
    $("#playAfterBtn2").onclick = () => playRecorded("after");
    overlay(true);
  } else if (withCallie && !stopped) {
    showSummary($("#callTimer").textContent);
    $("#joinBtn").textContent = "Play it again";
    $("#joinBtn").onclick = () => { setupRecorded(); };
  } else {
    setupRecorded();
    overlay(true);
  }
}
function togglePause() {
  rec.paused = !rec.paused;
  if (rec.audio) rec.paused ? rec.audio.pause() : rec.audio.play();
  if (voiceDirect) { try { rec.paused ? voiceDirect.pause?.() : voiceDirect.resume?.(); } catch {} }
  renderControls();
}
function stopRecorded() {
  rec.stop = true;
  rec.paused = false;
  rec.cancel?.();
  send({ type: "demo_stop" });
}

// ------------------------------------------------------------------ home page
// The Read me tab holds the presenter's notes. They stay blank until the password is entered.
async function openReadme() {
  const box = $("#readme");
  const r = await fetch("/api/readme", { cache: "no-store" }).catch(() => null);
  if (r?.status === 200) { box.innerHTML = await r.text(); return; }
  box.innerHTML = `<form class="readme-lock" id="readmeLock" autocomplete="on"><span class="lock-ic"><svg><use href="#i-lock" /></svg></span><input type="password" id="readmePw" placeholder="Password" aria-label="Password" autocomplete="current-password" required /><button class="cds-btn" type="submit">Unlock</button><p class="readme-err" id="readmeErr" hidden></p></form>`;
  $("#readmeLock").onsubmit = async (e) => {
    e.preventDefault();
    const res = await fetch("/api/readme", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: $("#readmePw").value }) }).catch(() => null);
    if (res?.ok) { box.innerHTML = await res.text(); return; }
    $("#readmeErr").textContent = (await res?.json().catch(() => null))?.error || "That password didn’t work.";
    $("#readmeErr").hidden = false;
    $("#readmePw").select();
  };
  $("#readmePw").focus();
}

// The recorded demo: when it was filmed, and chapters to jump to.
const video = $("#demoVideo");
const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
// The newest recording is the live three-way call; the scripted technical call is the fallback.
(async () => {
  for (const name of ["callie-live-call", "callie-live-demo"]) {
    const r = await fetch(`/media/${name}.json`, { cache: "no-cache" }).catch(() => null);
    if (r?.ok) return { name, meta: await r.json() };
  }
  return null;
})().then((found) => {
  if (!found) return;
  const { name, meta } = found;
  const v = Date.parse(meta.recordedAt) || 0; // a new recording gets a new URL, so no stale cached video
  video.poster = `/media/${name}-poster.jpg?v=${v}`;
  video.src = `/media/${name}.mp4?v=${v}`;
  const when = new Date(meta.recordedAt).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  $("#recMeta").textContent = meta.kind === "scripted"
    ? `Recorded ${when} · ${fmt(meta.seconds)} · the real app, unedited · scripted voices by Gemini 3.8 Flash TTS`
    : `${name === "callie-live-call" ? "A real call, recorded" : "Recorded"} ${when} · ${fmt(meta.seconds)} · unedited screen and sound`;
  // The breakdown: each step says what happened on the call and what Callie did. Click to jump there.
  const KIND = { answer: "Answer", show: "Whiteboard", send: "Send", check: "Correction", clarify: "Clarify", coach: "Coaching" };
  $("#chapterList").innerHTML = meta.chapters.map((c, i) => `<li><button type="button" class="step" data-i="${i}"><span class="st-time">${fmt(c.t)}</span><b>${esc(c.title)}</b>${c.what ? `<span class="st-what">${esc(c.what)}</span>` : ""}${c.callie ? `<span class="st-callie ${esc(c.kind || "answer")}"><i>${esc(KIND[c.kind] || "Callie")}</i>${esc(c.callie)}</span>` : ""}</button></li>`).join("");
  $$("#chapterList .step").forEach((b) => (b.onclick = () => { video.currentTime = meta.chapters[Number(b.dataset.i)].t; video.play().catch(() => {}); video.scrollIntoView({ behavior: "smooth", block: "center" }); }));
  video.addEventListener("loadedmetadata", () => { if (video.duration) $("#recMeta").textContent = $("#recMeta").textContent.replace(fmt(meta.seconds), fmt(video.duration)); });
  video.addEventListener("timeupdate", () => {
    const i = meta.chapters.reduce((k, c, j) => (video.currentTime >= c.t ? j : k), -1);
    $$("#chapterList .step").forEach((b, j) => b.classList.toggle("on", j === i && !video.paused));
  });
}).catch(() => {});
const playRecording = (e) => {
  e?.preventDefault();
  $$(".h-tab").find((t) => t.dataset.tab === "overview")?.click();
  video.scrollIntoView({ behavior: "smooth", block: "center" });
  video.play().catch(() => {});
};
$$("[data-play]").forEach((b) => (b.onclick = playRecording));
$$("[data-watch]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); $$(".h-tab").find((t) => t.dataset.tab === "overview")?.click(); video.scrollIntoView({ behavior: "smooth", block: "center" }); }));

// Scroll motion, the way calendly.com moves: sections rise in, siblings in a stagger. Content is
// only hidden once this script runs, and reduced-motion users get it all at rest.
const motionOk = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if (motionOk && "IntersectionObserver" in window) {
  html.classList.add("anim");
  const groups = [
    [".h-hero-copy > *", ""], [".video-mesh", "zoom"],
    [".h-sec-head > *", ""], [".h-grid > *", ""], [".pains .pain-row:not(.head)", ""],
    [".icp-top > div", "from-left"], [".icp-facts li", ""], [".int-top > div", "from-left"],
    [".cap-copy", ""], [".cap-ui", "zoom"], [".wide-out", ""],
    [".ladders > *", ""], [".ladder li", "from-left"], [".steps li", ""], [".pipe span", "from-left"],
    [".table-wrap", ""], [".timeline li", ""], [".roadmap li", ""], [".roadmap", ""], [".ns-card", ""], [".gates", ""], [".lc-stage", ""], [".lc-why > *", ""], [".stages > *", ""], [".notetaker", ""],
    [".h-final-card", "zoom"], [".stack-hero > *", ""], [".lane", ""], [".flow5 li", "from-left"], [".half", ""],
  ];
  const seen = new Set();
  for (const [sel, kind] of groups) {
    for (const el of $$(sel)) {
      if (seen.has(el)) continue;
      seen.add(el);
      const sibs = [...el.parentElement.children].filter((c) => c.matches(sel));
      el.classList.add("reveal");
      if (kind) el.classList.add(kind);
      el.style.setProperty("--i", String(Math.min(sibs.indexOf(el), 8)));
    }
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
  $$(".reveal, .timeline").forEach((el) => io.observe(el));
  // A slow drift on the illustrations as they pass.
  const par = $$("[data-parallax]");
  let ticking = false;
  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      for (const el of par) {
        const r = el.getBoundingClientRect();
        const k = (r.top + r.height / 2 - innerHeight / 2) / innerHeight;
        el.style.transform = `translateY(${(k * -28).toFixed(1)}px)`;
      }
      ticking = false;
    });
  }, { passive: true });
} else {
  $$(".timeline").forEach((t) => t.classList.add("static"));
}

$$(".h-tab").forEach((t) => (t.onclick = async () => {
  $$(".h-tab").forEach((x) => x.classList.toggle("is-active", x === t));
  $$(".h-view").forEach((v) => (v.hidden = v.dataset.view !== t.dataset.tab));
  if (t.dataset.tab === "readme" && !$("#readme .l-readme")) await openReadme();
  window.scrollTo(0, 0);
}));
// "Start experience" opens the call and joins it in the same click, so the browser treats the
// mic prompt and Grace's voice as something the user started.
$$("[data-start]").forEach((b) => (b.onclick = () => { ctx(); showCall(); }));
$("#joinBtn").onclick = () => joinCall({ text: false });
$("#joinTextBtn").onclick = () => joinCall({ text: true });

// ------------------------------------------------------------------ boot
window.callieDebug = { get view() { return view; }, get call() { return call; }, get media() { return media; }, ui, rec, sendLatest: () => { const c = sendable(); if (c) requestEmail(c.id); return !!c; }, askMate: (text) => { remember("you", text); return askMate(text); }, upsertCard, addBoardItem };
renderControls();
if (OPEN_CALL) {
  showCall();
  if (RECORDED) setupRecorded();
} else {
  // Download the call bundle and Grace's avatar while the overview is being read.
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1200));
  idle(() => prefetch().catch((e) => console.warn("prefetch:", e)));
}
