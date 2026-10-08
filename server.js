// Callie Live — server.
// Each browser tab is a session with its own call, cards and whiteboard. Callie hears two
// channels per session:
//   you:  the CSM's mic, streamed from the browser.
//   them: the customer. In the video call that's Grace's voice, tapped in the browser from the
//         LiveKit room. In local "real meeting" mode it's the Mac's system audio (Core Audio taps
//         via AudioTee), so it works next to Zoom, Meet or Teams without joining the call.
// Each utterance -> listen (transcript, kind, tone) -> answer / fact-check / coach -> cards,
// whiteboard items and, when it matters, a private whisper in the CSM's ear.
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { execFile, execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { AccessToken, RoomAgentDispatch, RoomConfiguration, RoomServiceClient } from "livekit-server-sdk";
import { Segmenter } from "./lib/vad.js";
import { pcm16ToWav } from "./lib/wav.js";
import { KnowledgeBase } from "./lib/kb.js";
import { Brain } from "./lib/brain.js";
import { LiveVoice } from "./lib/voice.js";
import { toBoardItem } from "./lib/board.js";
import { PersonaAgent, PRIYA_PROMPT } from "./lib/persona.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const HOSTED = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.CALLIE_HOSTED);
const PORT = Number(process.env.PORT || 4317);
const HOST = process.env.HOST || (HOSTED ? "0.0.0.0" : "127.0.0.1");
const ACCESS_CODE = process.env.ACCESS_CODE || "";
// A public Spatius avatar this app may animate (checked with the Spatius SDK); set SPATIUS_AVATAR_ID to use your own.
const AVATAR_ID = process.env.SPATIUS_AVATAR_ID || "d8d8401c-8bbf-42f3-a582-9aa514c36728";
const AGENT_NAME = process.env.CALLIE_AGENT_NAME || "callie-customer";
if (!process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is missing. Put it in callie-live/.env");
  process.exit(1);
}

// What this machine can do. System-audio capture and Gmail sending only exist on the
// presenter's Mac; the hosted copy uses the video call and offers email drafts instead.
let AudioTee = null;
if (process.platform === "darwin" && !HOSTED) {
  try { ({ AudioTee } = await import("audiotee")); } catch {}
}
const hasGws = (() => { if (HOSTED) return false; try { execFileSync("which", ["gws"], { stdio: "ignore" }); return true; } catch { return false; } })();
const liveCallReady = Boolean(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET && process.env.SPATIUS_APP_ID);
const caps = { hosted: HOSTED, capture: Boolean(AudioTee), email: hasGws, liveCall: liveCallReady, simulate: process.platform === "darwin" && !HOSTED };

// ------------------------------------------------------------------ fact bases
// "arize": the Cartwell onboarding call. "panel": Part 2, where Callie answers the interview
// panel's questions about Callie Live, grounded in the pre-read.
function chunkMarkdown(md, url) {
  const out = [];
  let heading = "Overview";
  let buf = [];
  const flush = () => { const text = buf.join("\n").trim(); if (text.length > 60) out.push({ id: `${url}#${out.length}`, title: "Callie Live pre-read", heading, url, text }); buf = []; };
  for (const line of md.split("\n")) {
    if (/^#{1,3}\s/.test(line)) { flush(); heading = line.replace(/^#+\s+/, ""); continue; }
    buf.push(line);
  }
  flush();
  return out;
}
function demoInbox(account) {
  // Every attendee's email becomes a plus-alias of your own inbox, so "Send now" really sends
  // during the demo but only ever lands with you.
  if (!process.env.CALLIE_DEMO_INBOX) return account;
  const [user, domain] = process.env.CALLIE_DEMO_INBOX.split("@");
  for (const p of account.attendees) p.email = `${user}+${p.name.split(" ")[0].toLowerCase()}@${domain}`;
  return account;
}
// Scenarios for the live call (kb/scenarios/*.json): Grace in a different role, with her own
// persona, account context and verified key facts, over the same Arize docs.
const arizeKb = new KnowledgeBase(path.join(ROOT, "kb", "chunks.json"));
const SCENARIOS = Object.fromEntries(
  fs.readdirSync(path.join(ROOT, "kb", "scenarios")).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, "kb", "scenarios", f), "utf8"))).map((s) => [s.id, s]),
);
function loadProfile(name) {
  let account, facts, kb;
  const scenario = SCENARIOS[name];
  if (scenario) {
    account = { ...JSON.parse(fs.readFileSync(path.join(ROOT, "kb", "account.json"), "utf8")), ...scenario.account };
    account.attendees = [...scenario.account.attendees, ...JSON.parse(fs.readFileSync(path.join(ROOT, "kb", "account.json"), "utf8")).attendees.slice(1)];
    facts = `${scenario.facts}\n${fs.readFileSync(path.join(ROOT, "kb", "facts.md"), "utf8")}`;
    demoInbox(account);
    return { name, account, facts, kb: arizeKb, persona: scenario.persona, brain: new Brain({ apiKey: process.env.GEMINI_API_KEY, kb: arizeKb, account, facts }) };
  }
  if (name === "panel") {
    const live = path.join(ROOT, "..", "pre-read.md");
    const preRead = fs.readFileSync(fs.existsSync(live) ? live : path.join(ROOT, "kb", "profiles", "panel", "pre-read.md"), "utf8");
    account = JSON.parse(fs.readFileSync(path.join(ROOT, "kb", "profiles", "panel", "account.json"), "utf8"));
    facts = preRead;
    kb = new KnowledgeBase(chunkMarkdown(preRead, "pre-read.md"));
  } else {
    account = JSON.parse(fs.readFileSync(path.join(ROOT, "kb", "account.json"), "utf8"));
    if (process.env.CALLIE_CLIENT_EMAIL) account.attendees[0].email = process.env.CALLIE_CLIENT_EMAIL;
    facts = fs.readFileSync(path.join(ROOT, "kb", "facts.md"), "utf8");
    kb = arizeKb;
  }
  demoInbox(account);
  return { name, account, facts, kb, brain: new Brain({ apiKey: process.env.GEMINI_API_KEY, kb, account, facts }) };
}
const profiles = { arize: loadProfile("arize"), panel: loadProfile("panel"), ...Object.fromEntries(Object.keys(SCENARIOS).map((id) => [id, loadProfile(id)])) };
const SCENARIO_LIST = [
  { id: "arize", title: "Technical onboarding", blurb: "Grace is the engineering lead getting LangGraph traces, masking and sessions working.", role: "Engineering Lead" },
  ...["traces-skills", "evals-review", "prompt-monitor"].filter((id) => SCENARIOS[id]).map((id) => SCENARIOS[id]).map(({ id, title, blurb, role }) => ({ id, title, blurb, role })),
];
const voice = new LiveVoice(profiles.arize.brain.ai);
const shares = new Map(); // share pages are addressed by unguessable ids, across sessions

let seq = 0;
const nextId = (p) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
function normalizeKey(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").filter((w) => w.length > 3).sort().join(" ");
}
function cardTopic(card) {
  if (card.type === "check") return { topic: card.claim, answer: card.correction, detail: [card.sayInstead].filter(Boolean), sources: card.sources };
  return { topic: card.question, answer: card.answer, detail: card.detail, sources: card.sources };
}
function pcmFromBuffer(b) {
  const pcm = new Int16Array(b.length >> 1);
  for (let i = 0; i < pcm.length; i++) pcm[i] = b.readInt16LE(i * 2);
  return pcm;
}
function downsample24to16(b64) {
  const src = pcmFromBuffer(Buffer.from(b64, "base64"));
  const out = new Int16Array(Math.floor((src.length * 2) / 3));
  for (let i = 0; i < out.length; i++) {
    const x = i * 1.5;
    const j = Math.floor(x);
    const f = x - j;
    out[i] = Math.round(src[j] * (1 - f) + (src[Math.min(j + 1, src.length - 1)] || 0) * f);
  }
  return out;
}
function sendEmailViaGws(draft, asDraft) {
  return new Promise((resolve, reject) => {
    const args = ["gmail", "+send", "--to", draft.to, "--subject", draft.subject, "--body", draft.body];
    if (asDraft) args.push("--draft");
    execFile("gws", args, { timeout: 30000 }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).slice(0, 200))) : resolve(stdout)));
  });
}

// System audio is one device: only one session at a time can listen to it.
let tee = null;
let teeOwner = null;

// ------------------------------------------------------------------ a session (one browser tab)
class Session {
  constructor(id) {
    this.id = id;
    this.clients = new Set();
    this.profile = profiles.arize;
    this.state = Session.freshState();
    this.settings = { whisper: "corrections", coach: true };
    this.mode = null; // null | "call" | "capture" | "demo" | "roleplay"
    this.demo = { mode: "inject", line: null };
    this.persona = null;
    this.call = null;
    this.ptt = false;
    this.speakingUntil = 0;
    this.themHeardAt = 0;
    this.themEverHeard = false;
    this.lastSeen = Date.now();
    this.segments = {
      you: new Segmenter({
        minThreshold: 0.015,
        onLevel: (rms) => this.emit({ type: "level", who: "you", rms }),
        onUtterance: (pcm) => this.handleUtterance("you", pcm, { forceAsk: this.ptt }),
      }),
      them: new Segmenter({
        minThreshold: 0.008,
        onLevel: (rms) => {
          this.emit({ type: "level", who: "them", rms });
          if (rms > 0.0005) { this.themHeardAt = Date.now(); this.themEverHeard = true; }
        },
        onUtterance: (pcm) => {
          const line = this.mode === "demo" ? this.demo.line : null;
          if (line) return this.handleUtterance(line.who === "csm" ? "you" : "them", pcm, { forceAsk: !!line.private, speaker: line.speaker });
          return this.handleUtterance("them", pcm);
        },
      }),
    };
  }

  static freshState() {
    return {
      transcript: [], // {id, who: 'you'|'them', speaker, text, tone, at}
      cards: new Map(),
      board: [], // newest first
      recentQuestions: [],
      recentChecks: [], // so Callie doesn't flag the same issue twice in a row
      notesShared: [],
      talk: { you: 0, them: 0, since: Date.now() },
      lastCoachAt: 0,
    };
  }

  get brain() { return this.profile.brain; }
  get account() { return this.profile.account; }
  get listening() { return this.mode !== null; }

  emit(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) if (ws.readyState === 1) ws.send(data);
  }
  hint(text, tone = "info") { this.emit({ type: "hint", text, tone }); }
  hello(ws) {
    const msg = {
      type: "hello",
      session: this.id,
      account: this.account,
      settings: this.settings,
      listening: this.listening,
      mode: this.mode,
      cards: [...this.state.cards.values()],
      board: this.state.board,
      transcript: this.state.transcript.slice(-40),
      kbSize: this.profile.kb.chunks.length,
      profile: this.profile.name,
      caps,
    };
    (ws ? [ws] : this.clients).forEach((c) => c.readyState === 1 && c.send(JSON.stringify(msg)));
  }

  recentText(n = 8) {
    return this.state.transcript
      .slice(-n)
      .map((u) => `${u.who === "you" ? `CSM (${this.account.csm.name})` : "Customer"}: ${u.text}`)
      .join("\n");
  }
  upsertCard(card) {
    this.state.cards.set(card.id, card);
    this.emit({ type: "card", card });
  }
  addBoardItems(actions, origin) {
    for (const a of actions || []) {
      const item = toBoardItem(a, nextId("b"));
      if (!item) continue;
      item.origin = origin;
      item.at = Date.now();
      this.state.board.unshift(item);
      this.emit({ type: "board", op: "add", item });
    }
  }
  reset() {
    this.state = Session.freshState();
    this.emit({ type: "reset" });
  }

  // -------------------------------------------------------------- whispers (private voice)
  gate(on) {
    this.segments.you.setGate(on);
    this.segments.them.setGate(on);
  }
  async whisper(text, reason) {
    if (!text) return;
    const id = nextId("w");
    // Callie's own voice comes out of the same speakers we may be listening to, so listening
    // pauses while it plays and resumes when the audio we sent has finished.
    this.gate(true);
    let firstAt = 0;
    let audioSeconds = 0;
    this.emit({ type: "whisper", phase: "start", id, text, reason });
    const onAudio = (data, mimeType) => {
      if (!firstAt) firstAt = Date.now();
      const rate = Number((/rate=(\d+)/.exec(mimeType) || [])[1] || 24000);
      const bytes = (data.length * 3) / 4;
      audioSeconds += /wav/.test(mimeType) ? (bytes - 44) / 2 / rate : bytes / 2 / rate;
      this.emit({ type: "audio", id, data, mimeType });
    };
    try {
      await voice.say(text, { onAudio });
    } catch {
      try {
        const a = await this.brain.speak(text);
        onAudio(a.data, a.mimeType);
      } catch (e2) {
        this.hint(`Couldn't play the whisper: ${e2.message}`, "warning");
      }
    }
    this.emit({ type: "whisper", phase: "sent", id });
    const playedUntil = (firstAt || Date.now()) + audioSeconds * 1000 + 450;
    this.speakingUntil = Math.max(this.speakingUntil, playedUntil);
    setTimeout(() => { if (Date.now() >= this.speakingUntil - 50) this.gate(false); }, Math.max(0, playedUntil - Date.now()));
  }

  // -------------------------------------------------------------- the brain loop
  isRepeat(focus) {
    const key = normalizeKey(focus);
    const now = Date.now();
    const s = this.state;
    s.recentQuestions = s.recentQuestions.filter((q) => now - q.at < 120000);
    const words = new Set(key.split(" "));
    for (const q of s.recentQuestions) {
      const other = new Set(q.key.split(" "));
      const overlap = [...words].filter((w) => other.has(w)).length / Math.max(1, Math.min(words.size, other.size));
      if (overlap > 0.8) return true;
    }
    s.recentQuestions.push({ key, at: now });
    return false;
  }

  async handleUtterance(who, pcm, { forceAsk = false, wav = null, text: typed = null, seconds: givenSeconds = null, speaker = "" } = {}) {
    const endedAt = Date.now();
    const seconds = givenSeconds ?? (typed ? typed.split(/\s+/).length / 2.5 : pcm.length / 16000);
    this.state.talk[who] += seconds;
    if (process.env.CALLIE_DEBUG) console.log(new Date().toISOString(), this.id.slice(0, 6), who, `utterance ${seconds.toFixed(1)}s`);
    let heard;
    try {
      heard = await this.brain.listen(typed ? { text: typed } : wav || pcm16ToWav(pcm), who === "you" ? "CSM" : "Customer", this.recentText());
    } catch (e) {
      this.hint(`Listening hiccup: ${e.message?.slice(0, 120)}`, "warning");
      return;
    }
    const text = (heard.text || "").trim();
    if (!text) return;
    const speakerName = speaker || (who === "you" ? this.account.csm.name : this.account.attendees[0].name);
    const utt = { id: nextId("u"), who, speaker: speakerName, text, tone: heard.tone || "neutral", at: endedAt, kind: heard.kind };
    this.state.transcript.push(utt);
    this.emit({ type: "transcript", utterance: utt, latencyMs: Date.now() - endedAt });

    let kind = heard.kind;
    if (who === "you" && (forceAsk || /^\s*(hey\s+|ok\s+|okay\s+)?(callie|cali|kali|calley|kelly)\b[,.!]?/i.test(text))) kind = "ask_callie";
    if (who === "them" && kind === "claim") kind = "clarify";
    if (who === "them" && kind === "ask_callie") kind = "question";
    if (who === "you" && kind === "question") kind = "other";
    const focus = (heard.focus || text).trim();

    const jobs = [];
    if (kind === "question" || kind === "ask_callie") jobs.push(this.answerJob(kind, focus, who, endedAt, speakerName));
    if (kind === "claim") jobs.push(this.checkJob(focus, endedAt));
    if (kind === "clarify") jobs.push(this.checkJob(focus, endedAt, { byCustomer: true, speaker: speakerName }));
    if (who === "them") jobs.push(this.coachJob(utt));
    jobs.push(this.talkTimeCoach());
    await Promise.allSettled(jobs);
  }

  async answerJob(kind, focus, who, endedAt, speakerName = "") {
    if (kind === "question" && this.isRepeat(focus)) return;
    const account = this.account;
    const id = nextId("c");
    const customer = speakerName && who === "them" ? speakerName : account.attendees[0].name;
    const asker = kind === "ask_callie" ? `${account.csm.name} (privately, to Callie)` : `${customer} (customer)`;
    const base = { id, type: kind === "ask_callie" ? "callie" : "answer", question: focus, asker: kind === "ask_callie" ? "You asked Callie" : `${customer.split(" ")[0]} asked`, askerName: kind === "ask_callie" ? account.attendees[0].name : customer, at: Date.now() };
    this.upsertCard({ ...base, status: "thinking" });
    try {
      const r = await this.brain.answer(focus.replace(/^\s*(hey\s+)?callie[,.!]?\s*/i, ""), { asker, recent: this.recentText(), notesShared: this.state.notesShared });
      if (r.private_note) this.state.notesShared.push(r.private_note);
      this.upsertCard({ ...base, status: "ready", answer: r.answer, detail: r.detail || [], sources: r.sources || [], confidence: r.confidence, privateNote: r.private_note || "", short: r.whisper || "", sendLabel: r.send_label || "", latencyMs: Date.now() - endedAt });
      this.addBoardItems(r.board, id);
      const cue = r.whisper || r.answer.split(/(?<=[.!?])\s/)[0];
      if (kind === "ask_callie" && this.settings.whisper !== "off") this.whisper(cue, "you asked");
      else if (this.settings.whisper === "all" && r.confidence !== "low") this.whisper(cue, "answer");
    } catch (e) {
      this.upsertCard({ ...base, status: "error", answer: `Couldn't answer: ${e.message?.slice(0, 120)}` });
    }
  }

  async checkJob(claim, endedAt, { byCustomer = false, speaker = "" } = {}) {
    try {
      const r = await this.brain.check(claim, { recent: this.recentText(), byCustomer });
      if (r.verdict !== "contradicted") return;
      const key = new Set(normalizeKey(r.correction || "").split(" "));
      const now = Date.now();
      const s = this.state;
      s.recentChecks = s.recentChecks.filter((c) => now - c.at < 120000);
      const repeat = s.recentChecks.some((c) => [...key].filter((w) => c.key.has(w)).length / Math.max(1, Math.min(key.size, c.key.size)) > 0.6);
      if (repeat) return;
      s.recentChecks.push({ key, at: now });
      const card = {
        id: nextId("c"),
        type: "check",
        status: "ready",
        clarify: byCustomer,
        speaker,
        claim,
        correction: r.correction,
        sayInstead: r.say_instead,
        whisper: r.whisper,
        severity: r.severity,
        sources: r.sources || [],
        at: Date.now(),
        latencyMs: Date.now() - endedAt,
      };
      this.upsertCard(card);
      this.addBoardItems(r.board, card.id);
      const loud = this.settings.whisper === "all" || (this.settings.whisper === "corrections" && r.severity !== "low" && (!byCustomer || r.severity === "high"));
      if (loud) this.whisper(r.whisper || r.correction, "correction");
    } catch (e) {
      this.hint(`Fact-check hiccup: ${e.message?.slice(0, 120)}`, "warning");
    }
  }

  async coachJob(utt) {
    if (!this.settings.coach) return;
    const strong = ["confused", "frustrated", "skeptical"].includes(utt.tone);
    if (!strong && utt.tone !== "hesitant") return;
    const since = Date.now() - this.state.lastCoachAt;
    if (since < (strong ? 25000 : 90000)) return;
    this.state.lastCoachAt = Date.now();
    try {
      const r = await this.brain.coach({ tone: utt.tone, text: utt.text, recent: this.recentText() });
      this.upsertCard({ id: nextId("c"), type: "coach", status: "ready", tone: utt.tone, speaker: utt.speaker, quote: utt.text, nudge: r.nudge, say: r.say, show: r.show, at: Date.now() });
    } catch (e) {
      this.hint(`Coach hiccup: ${e.message?.slice(0, 120)}`, "warning");
    }
  }

  async talkTimeCoach() {
    if (!this.settings.coach) return;
    const { you, them, since } = this.state.talk;
    const total = you + them;
    if (Date.now() - since < 120000 || total < 60) return;
    const share = you / total;
    if (share > 0.72 && Date.now() - this.state.lastCoachAt > 90000) {
      this.state.lastCoachAt = Date.now();
      this.upsertCard({
        id: nextId("c"),
        type: "coach",
        status: "ready",
        tone: "talk-time",
        quote: `You've talked ${Math.round(share * 100)}% of the last few minutes.`,
        nudge: "Pause and hand it back to them.",
        say: `${this.account.attendees[0].name.split(" ")[0]}, what's the part you're most unsure about so far?`,
        at: Date.now(),
      });
      this.state.talk = { you: 0, them: 0, since: Date.now() };
    }
  }

  // -------------------------------------------------------------- listening modes
  async listen(mode) {
    await this.stopListening({ quiet: true });
    this.mode = mode;
    this.state.talk = { you: 0, them: 0, since: Date.now() };
    if (mode === "capture") await this.startCapture();
    this.emit({ type: "status", listening: true, mode });
  }
  async stopListening({ quiet = false } = {}) {
    if (!this.mode) return;
    this.segments.you.flush();
    this.segments.them.flush();
    this.persona?.stop();
    this.persona = null;
    if (teeOwner === this) await stopCapture();
    this.mode = null;
    if (!quiet) this.emit({ type: "status", listening: false, mode: null });
  }
  async startCapture() {
    if (!AudioTee) return this.hint("System audio capture only works in the Mac app. In this copy, use the video call.", "warning");
    if (teeOwner && teeOwner !== this) await teeOwner.stopListening();
    try {
      tee = new AudioTee({ sampleRate: 16000, chunkDurationMs: 100 });
      teeOwner = this;
      tee.on("data", (chunk) => teeOwner?.segments.them.push(pcmFromBuffer(chunk.data)));
      tee.on("error", (e) => this.hint(`Meeting audio error: ${e.message}`, "warning"));
      await tee.start();
      this.themHeardAt = Date.now();
      // Permission check: warn once, only if no meeting audio has ever arrived. Ordinary silence
      // (a pause, a muted customer) is normal and never triggers it.
      clearInterval(this.silenceTimer);
      this.silenceTimer = setInterval(() => {
        if (this.mode !== "capture" || this.themEverHeard) return clearInterval(this.silenceTimer);
        if (Date.now() - this.themHeardAt > 20000) {
          this.hint("Callie hasn't heard any meeting audio yet. If a call is already playing, allow System Audio Recording for the app running Callie (System Settings → Privacy & Security → Screen & System Audio Recording → System Audio Recording Only).", "warning");
          clearInterval(this.silenceTimer);
        }
      }, 5000);
    } catch (e) {
      teeOwner = null;
      this.hint(`Couldn't tap meeting audio: ${e.message}`, "warning");
    }
  }

  // -------------------------------------------------------------- video call (LiveKit + Spatius)
  async callToken() {
    const roomName = `cartwell-${this.id.slice(0, 6)}-${Date.now().toString(36)}`;
    const identity = `jordan-${crypto.randomBytes(3).toString("hex")}`;
    const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { identity, name: this.account.csm.name, ttl: "1h" });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
    // Grace's agent joins on its own: the token asks LiveKit to dispatch it to this room, with
    // her persona and face in the job metadata.
    const metadata = JSON.stringify({ prompt: this.profile.persona || PRIYA_PROMPT, avatarId: AVATAR_ID, voice: process.env.CALLIE_PERSONA_VOICE || "Aoede", model: process.env.CALLIE_PERSONA_MODEL || "gemini-3.8-live" });
    at.roomConfig = new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName: AGENT_NAME, metadata })] });
    this.call = { roomName, identity, startedAt: Date.now() };
    return { url: process.env.LIVEKIT_URL, token: await at.toJwt(), roomName, identity, avatarId: AVATAR_ID, appId: process.env.SPATIUS_APP_ID };
  }

  // Hang up for everyone: deleting the room ends Grace's job right away instead of after
  // LiveKit's empty-room timeout, so no voice or avatar minutes run on.
  endRoom() {
    const roomName = this.call?.roomName;
    this.call = null;
    if (!roomName || !liveCallReady) return;
    const host = process.env.LIVEKIT_URL.replace(/^wss?:\/\//, "https://");
    new RoomServiceClient(host, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET).deleteRoom(roomName).catch(() => {});
  }

  // -------------------------------------------------------------- audio frames from the browser
  onAudioFrame(b) {
    // Byte 0 says which side of the call the frame is: 0 = the CSM's mic, 1 = the customer.
    const channel = b[0];
    const pcm = pcmFromBuffer(b.subarray(1));
    if (channel === 1) {
      if (this.mode === "call") this.segments.them.push(pcm);
      return;
    }
    if (this.mode === "call" || this.mode === "capture") this.segments.you.push(pcm);
    if (this.mode === "roleplay") {
      this.segments.you.push(pcm);
      this.persona?.sendAudio(Buffer.from(b.subarray(1)));
    }
  }

  // -------------------------------------------------------------- messages from the browser
  async onMessage(msg) {
    const s = this.state;
    switch (msg.type) {
      case "start": return this.listen(msg.mode === "capture" ? "capture" : "call");
      case "stop": return this.stopListening();
      case "call_start":
        this.reset();
        return this.listen("call");
      case "call_resume":
        // The page reconnected mid-call (a network blip): keep listening, keep the cards.
        if (!this.mode && this.call) return this.listen("call");
        return;
      case "call_end":
        this.endRoom();
        return this.stopListening();
      case "settings":
        Object.assign(this.settings, msg.settings || {});
        return this.emit({ type: "settings", settings: this.settings });
      case "ptt":
        this.ptt = !!msg.on;
        if (!this.ptt) setTimeout(() => this.segments.you.flush(), 250);
        return this.emit({ type: "ptt", on: this.ptt });
      case "speaking":
        if (msg.on) { this.gate(true); this.speakingUntil = Math.max(this.speakingUntil, Date.now() + 1500); }
        else { this.speakingUntil = Date.now() + 350; setTimeout(() => { if (Date.now() >= this.speakingUntil - 50) this.gate(false); }, 400); }
        return;
      case "typed":
        // Text mode: the CSM typed this into the call (the customer agent hears it as text), so
        // Callie checks it exactly like a spoken line.
        if (msg.text?.trim() && this.mode === "call") return this.handleUtterance("you", null, { text: String(msg.text).trim().slice(0, 600) });
        return;
      case "ask":
        if (msg.text?.trim()) {
          s.transcript.push({ id: nextId("u"), who: "you", text: `(typed to Callie) ${msg.text.trim()}`, tone: "neutral", at: Date.now() });
          return this.answerJob("ask_callie", msg.text.trim(), "you", Date.now());
        }
        return;
      case "whisper":
        return this.whisper(String(msg.text || "").slice(0, 300), "on request");
      case "email_draft": {
        const card = s.cards.get(msg.cardId);
        if (!card) return;
        this.emit({ type: "email", phase: "drafting", cardId: card.id });
        const draft = await this.brain.draftEmail(cardTopic(card), { contactName: card.askerName });
        return this.emit({ type: "email", phase: "draft", cardId: card.id, draft });
      }
      case "email_send": {
        const d = msg.draft || {};
        if (!d.to || !d.subject || !d.body) return this.hint("Email needs a recipient, subject and body.", "warning");
        if (!hasGws) return this.emit({ type: "email", phase: "failed", cardId: msg.cardId, error: "Sending is only set up in the Mac app" });
        try {
          await sendEmailViaGws(d, !!msg.asDraft);
          return this.emit({ type: "email", phase: msg.asDraft ? "saved" : "sent", cardId: msg.cardId, to: d.to });
        } catch (e) {
          return this.emit({ type: "email", phase: "failed", cardId: msg.cardId, error: e.message });
        }
      }
      case "share": {
        const card = s.cards.get(msg.cardId);
        if (!card) return;
        this.emit({ type: "share", phase: "building", cardId: card.id });
        const page = await this.brain.sharePage(cardTopic(card));
        const id = crypto.randomBytes(6).toString("hex");
        shares.set(id, { ...page, company: this.account.company, at: Date.now() });
        return this.emit({ type: "share", phase: "ready", cardId: card.id, url: `/share/${id}`, title: page.title });
      }
      case "board_user": {
        if (msg.op === "clear") s.board = [];
        if (msg.op === "erase") s.board = s.board.filter((b) => b.id !== msg.id);
        if (msg.op === "add" && msg.item) {
          const item = toBoardItem(msg.item, nextId("b"));
          if (item) { item.origin = "you"; item.at = Date.now(); s.board.unshift(item); this.emit({ type: "board", op: "add", item }); }
        }
        if (msg.op === "clear" || msg.op === "erase") this.emit({ type: "board", op: msg.op, id: msg.id });
        return;
      }
      case "board_from_card": {
        const card = s.cards.get(msg.cardId);
        if (!card) return;
        const text = card.type === "check" ? card.correction : card.answer;
        return this.addBoardItems([{ type: "note", title: card.type === "check" ? "Correction" : card.question?.slice(0, 60), text, tone: card.type === "check" ? "correction" : "info" }], card.id);
      }
      case "simulate":
        // Local helper: macOS speaks a customer line through the speakers, so it travels the
        // real system-audio path exactly like a voice on Zoom or Meet would.
        if (caps.simulate && msg.text) spawn("say", ["-v", msg.voice || "Samantha", String(msg.text).slice(0, 400)], { stdio: "ignore" });
        return;
      case "profile":
        this.profile = profiles[msg.name] || profiles.arize;
        this.state = Session.freshState();
        return this.hello();
      case "reset":
        return this.reset();
      case "demo_start":
        this.demo = { mode: msg.mode === "capture" && AudioTee ? "capture" : "inject", line: null };
        this.segments.them.endSilenceFrames = Math.round(1600 / 20); // let the player end each line
        if (this.demo.mode === "capture") await this.listen("capture");
        else await this.stopListening({ quiet: true });
        this.mode = "demo";
        return this.emit({ type: "demo", phase: "started", mode: this.demo.mode });
      case "demo_line": {
        if (this.mode !== "demo" && !(this.mode === "capture" && this.demo.mode === "capture")) return;
        const line = { id: String(msg.id || ""), who: msg.who === "csm" ? "csm" : "customer", private: !!msg.private, speaker: String(msg.speaker || "").slice(0, 60) };
        if (this.demo.mode === "capture") {
          if (msg.phase === "start") { this.segments.them.flush(); this.demo.line = line; }
          if (msg.phase === "end") setTimeout(() => { if (this.demo.line?.id === line.id) this.segments.them.flush(); }, 250);
          return;
        }
        if (msg.phase !== "end" || !/^[a-z0-9]+$/i.test(line.id)) return;
        const file = path.join(PUBLIC, "demo", "audio", `${line.id}.wav`);
        if (!fs.existsSync(file)) return;
        const wav = fs.readFileSync(file);
        return this.handleUtterance(line.who === "csm" ? "you" : "them", null, { wav, seconds: (wav.length - 44) / 48000, forceAsk: line.private, speaker: line.speaker });
      }
      case "demo_action": {
        const cards = [...s.cards.values()].filter((c) => (c.type === "answer" || c.type === "callie") && c.status === "ready");
        if (msg.action === "email_latest") {
          const card = [...cards].reverse().find((c) => c.type === "answer") || cards[cards.length - 1];
          if (!card) return;
          this.emit({ type: "email", phase: "drafting", cardId: card.id, auto: true });
          const draft = await this.brain.draftEmail(cardTopic(card), { contactName: msg.to || card.askerName });
          return this.emit({ type: "email", phase: "draft", cardId: card.id, draft, auto: true });
        }
        if (msg.action === "share_latest" || msg.action === "share_session") {
          if (!cards.length) return;
          const anchor = cards[cards.length - 1];
          this.emit({ type: "share", phase: "building", cardId: anchor.id, auto: true });
          const combined = {
            topic: `Everything we covered with ${this.account.company}: ${cards.map((c) => c.question).join("; ")}`,
            answer: cards.map((c) => c.answer).join(" "),
            detail: cards.flatMap((c) => c.detail || []).slice(0, 10),
            sources: cards.flatMap((c) => c.sources || []),
          };
          const page = await this.brain.sharePage(combined);
          const id = crypto.randomBytes(6).toString("hex");
          shares.set(id, { ...page, company: this.account.company, at: Date.now() });
          return this.emit({ type: "share", phase: "ready", cardId: anchor.id, url: `/share/${id}`, title: page.title, auto: true });
        }
        return;
      }
      case "demo_stop":
        this.segments.them.flush();
        this.demo.line = null;
        this.segments.them.endSilenceFrames = Math.round(750 / 20);
        await this.stopListening({ quiet: true });
        return this.emit({ type: "demo", phase: "stopped" });
      case "roleplay_start": {
        // Audio-only fallback for browsers that can't show the avatar: Grace is a Gemini Live
        // session on this server, and Callie hears her voice directly.
        this.reset();
        await this.listen("roleplay");
        this.persona = new PersonaAgent(this.brain.ai, {
          onAudio: (data, mimeType) => {
            this.emit({ type: "persona_audio", data, mimeType });
            this.segments.them.push(downsample24to16(data));
          },
          onText: (role, text) => this.emit({ type: "persona_text", role, text }),
          onTurn: (phase) => {
            if (phase === "complete" || phase === "interrupted") this.segments.them.flush();
            this.emit({ type: "persona_turn", phase });
          },
          onError: (m2) => this.hint(`Roleplay hiccup: ${m2}`, "warning"),
        });
        await this.persona.start();
        return this.emit({ type: "roleplay", phase: "started" });
      }
      case "roleplay_stop":
        await this.stopListening();
        return this.emit({ type: "roleplay", phase: "stopped" });
    }
  }

  async close() {
    this.endRoom();
    await this.stopListening({ quiet: true });
    sessions.delete(this.id);
  }
}

const sessions = new Map();
function sessionFor(id) {
  const sid = /^[a-zA-Z0-9_-]{8,64}$/.test(id || "") ? id : crypto.randomBytes(9).toString("base64url");
  if (!sessions.has(sid)) sessions.set(sid, new Session(sid));
  return sessions.get(sid);
}
// Sessions nobody has looked at for 20 minutes end, along with any call they left running.
setInterval(() => {
  for (const s of sessions.values()) if (!s.clients.size && Date.now() - s.lastSeen > 20 * 60 * 1000) s.close();
}, 60 * 1000);

// ------------------------------------------------------------------ access gate (hosted copy)
const passCookie = ACCESS_CODE ? crypto.createHmac("sha256", ACCESS_CODE).update("callie-live").digest("hex") : "";
function authorized(req) {
  if (!ACCESS_CODE) return true;
  const cookies = Object.fromEntries((req.headers.cookie || "").split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf("="); return [c.slice(0, i), c.slice(i + 1)]; }));
  const got = Buffer.from(cookies.callie_pass || "");
  const want = Buffer.from(passCookie);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const attempts = new Map(); // ip -> {n, since}
function loginPage(error = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Callie Live · Calendly Labs concept</title>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#fcfbf8;--ink:#071a31;--ink2:#566476;--line:#e4e6e9;--lime:#dbee9f;--red:#c9353b}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.5 Geist,system-ui,sans-serif;padding:24px 16px}
.card{width:100%;max-width:400px;background:#fff;border-radius:24px;padding:32px 28px;box-shadow:0 4px 5px rgba(95,109,119,.04),0 8px 15px rgba(95,109,119,.03),0 30px 50px rgba(95,109,119,.08)}
.mark{width:40px;height:40px;border-radius:12px;background:var(--lime);display:grid;place-items:center;margin-bottom:18px}
h1{font-size:24px;font-weight:600;letter-spacing:-.02em;margin:0 0 6px}p{margin:0 0 20px;color:var(--ink2)}
label{display:block;font-size:13px;font-weight:500;margin-bottom:6px}
input{width:100%;font:inherit;padding:12px 14px;border:1.5px solid var(--line);border-radius:12px;background:#fff;color:var(--ink)}
input:focus{outline:2px solid var(--ink);outline-offset:1px}
button{margin-top:14px;width:100%;font:500 15px/1 Geist,system-ui,sans-serif;padding:14px 16px;border:0;border-radius:16px;background:var(--ink);color:var(--bg);cursor:pointer}
.err{color:var(--red);font-size:13px;margin-top:10px}.foot{margin-top:18px;font-size:12px;color:var(--ink2)}
</style></head><body><form class="card" method="post" action="/login">
<div class="mark"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3b5410" stroke-width="2" stroke-linecap="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/></svg></div>
<h1>Callie Live</h1><p>A Calendly Labs concept prototype by Leland Char. Enter the access code you were given.</p>
<label for="code">Access code</label><input id="code" name="code" type="password" autocomplete="current-password" autofocus required>
${error ? `<div class="err">${error}</div>` : ""}
<button type="submit">Continue</button>
<div class="foot">Interview case prototype. Not a Calendly product and not affiliated with Calendly or Arize.</div>
</form></body></html>`;
}

// ------------------------------------------------------------------ http
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".wav": "audio/wav", ".mp4": "video/mp4", ".vtt": "text/vtt; charset=utf-8", ".ico": "image/x-icon" };
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".svg", ".json", ".wasm"]);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const BASE_HEADERS = { "x-robots-tag": "noindex, nofollow", "x-content-type-options": "nosniff", "referrer-policy": "same-origin" };
const gzCache = new Map(); // file -> {mtime, gz}

function renderShare(page) {
  const steps = (page.steps || []).map((s) => `<li>${esc(s)}</li>`).join("");
  const links = (page.links || []).map((l) => `<a class="link" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}<span>↗</span></a>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(page.title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono&display=swap" rel="stylesheet">
<style>
:root{--ink:#071a31;--ink2:#566476;--line:#e4e6e9;--bg:#fcfbf8;--blue:#0f5bd6}
*{box-sizing:border-box}body{margin:0;background:var(--bg);font:16px/1.6 Geist,system-ui,sans-serif;color:var(--ink)}
main{max-width:760px;margin:48px auto;padding:0 20px}
.eyebrow{font-size:12px;color:var(--ink2);letter-spacing:.08em;text-transform:uppercase}
h1{font-size:36px;line-height:1.15;margin:10px 0 12px;font-weight:600;letter-spacing:-.02em}
.summary{font-size:18px;color:var(--ink2);margin:0 0 28px}
.card{background:#fff;border-radius:24px;padding:24px 26px;margin:0 0 16px;box-shadow:0 4px 5px rgba(95,109,119,.04),0 8px 15px rgba(95,109,119,.03),0 30px 50px rgba(95,109,119,.08)}
h2{font-size:15px;margin:0 0 12px;font-weight:600}
ol{margin:0;padding-left:22px}
pre{margin:0;background:#0b1a2e;color:#e6edf7;border-radius:14px;padding:16px 18px;overflow:auto;font:14px/1.6 "Geist Mono",ui-monospace,monospace}
.links{display:grid;gap:8px}.link{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border:1px solid var(--line);border-radius:12px;text-decoration:none;color:var(--blue);font-weight:500}
footer{font-size:12px;color:var(--ink2);margin-top:28px}
</style></head><body><main>
<div class="eyebrow">Prepared live for ${esc(page.company || "you")} · ${new Date(page.at).toLocaleDateString()}</div>
<h1>${esc(page.title)}</h1>
<p class="summary">${esc(page.summary)}</p>
${steps ? `<section class="card"><h2>Steps</h2><ol>${steps}</ol></section>` : ""}
${page.code ? `<section class="card"><h2>${esc(page.language || "Code")}</h2><pre>${esc(page.code)}</pre></section>` : ""}
${links ? `<section class="card"><h2>Docs</h2><div class="links">${links}</div></section>` : ""}
<footer>Generated by Callie (concept prototype) from public documentation.</footer>
</main></body></html>`;
}

async function readBody(req, limit = 8192) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error("too large");
  }
  return body;
}
function sendJson(res, status, obj) {
  res.writeHead(status, { ...BASE_HEADERS, "content-type": MIME[".json"], "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}
function serveFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, BASE_HEADERS); return res.end("Not found"); }
    const ext = path.extname(file);
    // Video and audio support byte ranges, so the player can seek (Safari won't play without them).
    if (ext === ".mp4" || ext === ".wav") {
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
      const base = { ...BASE_HEADERS, "content-type": MIME[ext], "accept-ranges": "bytes", "cache-control": "public, max-age=3600" };
      if (!range) { res.writeHead(200, { ...base, "content-length": st.size }); return fs.createReadStream(file).pipe(res); }
      const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start >= st.size || start > end) { res.writeHead(416, { ...base, "content-range": `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...base, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    const immutable = file.includes(`${path.sep}call${path.sep}assets${path.sep}`);
    const headers = { ...BASE_HEADERS, "content-type": MIME[ext] || "application/octet-stream", "cache-control": immutable ? "public, max-age=31536000, immutable" : ext === ".wav" || ext === ".jpg" ? "public, max-age=3600" : "no-cache" };
    if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers["accept-encoding"] || "") && st.size > 1024) {
      const hit = gzCache.get(file);
      const send = (gz) => { res.writeHead(200, { ...headers, "content-encoding": "gzip", vary: "accept-encoding" }); res.end(gz); };
      if (hit && hit.mtime === st.mtimeMs) return send(hit.gz);
      return fs.readFile(file, (e2, data) => {
        if (e2) { res.writeHead(404, BASE_HEADERS); return res.end(); }
        zlib.gzip(data, { level: 6 }, (e3, gz) => {
          if (e3) { res.writeHead(200, headers); return res.end(data); }
          gzCache.set(file, { mtime: st.mtimeMs, gz });
          send(gz);
        });
      });
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/health") return sendJson(res, 200, { ok: true });
    if (url.pathname === "/robots.txt") { res.writeHead(200, { ...BASE_HEADERS, "content-type": "text/plain" }); return res.end("User-agent: *\nDisallow: /\n"); }
    if (url.pathname === "/login") {
      if (req.method === "POST") {
        const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
        const a = attempts.get(ip) || { n: 0, since: Date.now() };
        if (Date.now() - a.since > 10 * 60 * 1000) { a.n = 0; a.since = Date.now(); }
        a.n++;
        attempts.set(ip, a);
        const code = new URLSearchParams(await readBody(req)).get("code") || "";
        const ok = ACCESS_CODE && a.n <= 10 && code.length === ACCESS_CODE.length && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(ACCESS_CODE));
        if (!ok) { res.writeHead(401, { ...BASE_HEADERS, "content-type": MIME[".html"] }); return res.end(loginPage(a.n > 10 ? "Too many tries. Wait a few minutes, then try again." : "That code didn't work. Check it and try again.")); }
        attempts.delete(ip);
        res.writeHead(303, { ...BASE_HEADERS, location: "/", "set-cookie": `callie_pass=${passCookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${HOSTED ? "; Secure" : ""}` });
        return res.end();
      }
      res.writeHead(200, { ...BASE_HEADERS, "content-type": MIME[".html"] });
      return res.end(loginPage());
    }
    if (!authorized(req)) {
      if (url.pathname.startsWith("/api/")) return sendJson(res, 401, { error: "Enter the access code first." });
      res.writeHead(303, { ...BASE_HEADERS, location: "/login" });
      return res.end();
    }

    if (url.pathname === "/api/config") {
      return sendJson(res, 200, { ...caps, spatiusAppId: process.env.SPATIUS_APP_ID || "", avatarId: AVATAR_ID, scenarios: SCENARIO_LIST });
    }
    if (url.pathname === "/api/call" && req.method === "POST") {
      if (!liveCallReady) return sendJson(res, 503, { error: "The video call isn't configured on this server (LiveKit or Spatius keys are missing)." });
      const { sid } = JSON.parse((await readBody(req)) || "{}");
      const session = sessions.get(sid);
      if (!session) return sendJson(res, 404, { error: "Your session expired. Reload the page." });
      return sendJson(res, 200, await session.callToken());
    }
    if (url.pathname === "/api/spatius-token" && req.method === "POST") {
      // Recorded call: the browser drives Grace's avatar directly, with a short-lived token.
      if (!process.env.SPATIUS_API_KEY) return sendJson(res, 503, { error: "Spatius isn't configured on this server." });
      const r = await fetch("https://console.us-west.spatius.ai/v1/console/session-tokens", {
        method: "POST",
        headers: { "X-API-Key": process.env.SPATIUS_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ expireAt: Math.floor(Date.now() / 1000) + 3600 }),
      });
      if (!r.ok) return sendJson(res, 502, { error: `Spatius returned ${r.status}` });
      const { sessionToken } = await r.json();
      return sendJson(res, 200, { sessionToken, appId: process.env.SPATIUS_APP_ID, avatarId: AVATAR_ID });
    }
    if (url.pathname.startsWith("/share/")) {
      const page = shares.get(url.pathname.split("/")[2]);
      if (!page) { res.writeHead(404, BASE_HEADERS); return res.end("Not found"); }
      res.writeHead(200, { ...BASE_HEADERS, "content-type": MIME[".html"] });
      return res.end(renderShare(page));
    }
    const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403, BASE_HEADERS); return res.end(); }
    return serveFile(req, res, file);
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message?.slice(0, 200) || "Server error" });
  }
});

const wss = new WebSocketServer({ server, path: "/ws", verifyClient: ({ req }) => authorized(req), maxPayload: 1 << 20 });
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const session = sessionFor(url.searchParams.get("sid"));
  const viewer = url.searchParams.get("view") === "board"; // the customer-safe whiteboard window
  ws._viewer = viewer;
  session.clients.add(ws);
  session.lastSeen = Date.now();
  session.hello(ws);
  ws.on("close", () => {
    session.clients.delete(ws);
    session.lastSeen = Date.now();
    // The presenter closed the tab: stop listening, unless the page reconnects within a few
    // seconds (a network blip or a reload).
    setTimeout(() => {
      if (![...session.clients].some((c) => !c._viewer)) session.stopListening({ quiet: true });
    }, 5000);
  });
  ws.on("message", async (raw, isBinary) => {
    session.lastSeen = Date.now();
    if (viewer) return;
    if (isBinary) return session.onAudioFrame(Buffer.from(raw));
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try {
      await session.onMessage(msg);
    } catch (e) {
      session.hint(`Something went wrong: ${e.message?.slice(0, 160)}`, "warning");
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Callie Live is running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}  (knowledge base: ${profiles.arize.kb.chunks.length} doc passages; video call ${liveCallReady ? "ready" : "not configured"}; ${ACCESS_CODE ? "access code on" : "open access"})`);
  // Warm the models so the first real question isn't slowed by a cold start.
  const ai = profiles.arize.brain.ai;
  profiles.arize.brain.embed("warm up").catch(() => {});
  ai.models.generateContent({ model: "gemini-3.5-flash-lite", contents: "ok", config: { thinkingConfig: { thinkingLevel: "minimal" } } }).catch(() => {});
  ai.models.generateContent({ model: "gemini-3.8-flash", contents: "ok", config: { thinkingConfig: { thinkingLevel: "low" } } }).catch(() => {});
});

const shutdown = async () => { for (const s of sessions.values()) await s.stopListening({ quiet: true }); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function stopCapture() {
  try { await tee?.stop(); } catch {}
  tee = null;
  teeOwner = null;
}
