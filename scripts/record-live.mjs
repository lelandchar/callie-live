// Film a real live call (scenario 3: prompt changes, experiments and monitors).
// Grace (customer) and Julian (Arize solutions engineer) are the live AI agents with their Spatius
// avatars. Jordan's lines are prerecorded (scripts/make-live-lines.mjs) and fed in as the
// microphone; the driver picks each one from what Grace actually just asked and waits for the
// others to finish. The page mixes every voice and Callie's whispers into one track, so the video
// has the call's real sound.
//
//   node scripts/record-live.mjs [--url=http://localhost:4317] [--out=public/media] [--name=callie-live-call]
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LINES } from "./make-live-lines.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || "").split("=").slice(1).join("=") || d;
const BASE = arg("url", "http://localhost:4317");
const OUT = path.resolve(ROOT, arg("out", "public/media"));
const NAME = arg("name", "callie-live-call");
const MAX_MS = Number(arg("minutes", "9")) * 60 * 1000;
const FFMPEG = process.env.FFMPEG || path.join(ROOT, "agent/.venv/lib/python3.12/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1");
const { chromium } = await import(process.env.CALLIE_PLAYWRIGHT || `${process.env.HOME}/Desktop/SayMei-Web/node_modules/playwright/index.mjs`);
const line = (id) => LINES.find((l) => l.id === id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(OUT, ".rec-"));
const run = (args) => new Promise((resolve, reject) => {
  const p = spawn(FFMPEG, ["-y", "-loglevel", "error", ...args], { stdio: ["ignore", "inherit", "inherit"] });
  p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}`))));
});

const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("console", (m) => { if (m.type() !== "log" && /avatar|teammate|julian/i.test(m.text())) console.log("console:", m.text().slice(0, 200)); });
await page.addInitScript(() => {
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const ctx = new AudioContext({ sampleRate: 48000 });
  window.__recCtx = ctx;
  window.__mixDest = ctx.createMediaStreamDestination();
  const mic = ctx.createMediaStreamDestination();
  // Jordan's "microphone": prerecorded lines played into a stream the app treats as the mic.
  window.__jordanSay = async (url) => {
    await ctx.resume();
    const buf = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(mic);
    src.connect(window.__mixDest);
    window.__jordanTalking = true;
    await new Promise((r) => { src.onended = r; src.start(); });
    window.__jordanTalking = false;
    return buf.duration;
  };
  navigator.mediaDevices.getUserMedia = async (c) => {
    if (c?.audio) return new MediaStream([mic.stream.getAudioTracks()[0]]); // no camera: the JR tile
    return real(c);
  };
  window.__startMix = () => {
    const rec = new MediaRecorder(window.__mixDest.stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 128000 });
    window.__mixChunks = [];
    rec.ondataavailable = (e) => e.data.size && window.__mixChunks.push(e.data);
    rec.start(1000);
    window.__mixRec = rec;
    window.__mixStart = Date.now();
    return window.__mixStart;
  };
  window.__stopMix = () => new Promise((resolve) => {
    window.__mixRec.onstop = async () => {
      const buf = new Uint8Array(await new Blob(window.__mixChunks, { type: "audio/webm" }).arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 32768) bin += String.fromCharCode(...buf.subarray(i, i + 32768));
      resolve({ b64: btoa(bin), start: window.__mixStart });
    };
    window.__mixRec.stop();
  });
});

await page.goto(`${BASE}/?call&rec`);
await page.waitForSelector("#joinBtn");
await page.selectOption("#scenarioSel", "prompt-monitor");
await page.waitForFunction(() => document.getElementById("avatarProgress").classList.contains("done") && document.querySelector("#mateStage canvas"), null, { timeout: 120000 });
await sleep(2500);

// Screen → ffmpeg, as in record-demo.mjs.
const videoOnly = path.join(tmp, "video.mp4");
const ff = spawn(FFMPEG, ["-y", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-use_wallclock_as_timestamps", "1", "-i", "-",
  "-vf", "fps=30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", videoOnly], { stdio: ["pipe", "inherit", "inherit"] });
const cdp = await page.context().newCDPSession(page);
let t0 = 0;
cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
  if (!t0) t0 = Date.now();
  ff.stdin.write(Buffer.from(data, "base64"));
  cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });
await page.evaluate(() => window.__startMix());
await sleep(2500);
const started = Date.now();
await page.click("#joinBtn");
console.log("filming…", new Date().toISOString());

const convo = () => page.evaluate(() => window.__convo || []);
const quietFor = (ms) => page.evaluate((ms) => !window.__jordanTalking && Date.now() - (window.__lastChatAt || 0) > ms && !document.getElementById("mateTile").classList.contains("speaking"), ms);
async function settle({ minEntries = 1, timeout = 30000, quiet = 2600 } = {}) {
  const before = (await convo()).length;
  const t = Date.now();
  while (Date.now() - t < timeout) {
    await sleep(400);
    const n = (await convo()).length;
    if (n - before >= minEntries && (await quietFor(quiet))) return true;
  }
  return false;
}
const chapters = [];
async function say(id, label) {
  const l = line(id);
  chapters.push({ title: label, t: Math.max(0, (Date.now() - t0) / 1000) });
  console.log(`  Jordan [${id}]: ${l.text.slice(0, 80)}`);
  // A line that ends by asking Julian something: Grace's room doesn't hear that part, so she
  // waits for Julian instead of jumping in (Callie still hears it and passes it to Julian).
  const toJulian = /julian,/i.test(l.text) && id !== "intro";
  if (toJulian) await page.evaluate(() => { const p = window.callieDebug.media.pub; if (p) p.enabled = false; });
  await page.evaluate((url) => window.__jordanSay(url), `/demo/live/${id}.wav`);
  // Hand Julian Jordan's exact words, so a misheard transcript can't leave him out (the app ignores
  // the transcribed copy that follows).
  if (toJulian) await page.evaluate((text) => window.callieDebug.askMate(text.slice(text.search(/julian,/i))), l.text);
  if (toJulian) await page.evaluate(() => { const p = window.callieDebug.media.pub; if (p) p.enabled = true; });
}
// Wait until Grace's latest line reads as finished (she sometimes pauses mid-sentence).
async function graceFinished(maxMs = 7000) {
  const t = Date.now();
  while (Date.now() - t < maxMs) {
    const g = [...(await convo())].reverse().find((x) => x.who === "grace")?.text || "";
    if (/[.?!]["”)]?\s*$/.test(g) && (await quietFor(2500))) return;
    await sleep(400);
  }
}

// Grace opens the call.
await page.waitForFunction(() => (window.__convo || []).some((c) => c.who === "grace"), null, { timeout: 60000 });
await settle({ minEntries: 0, quiet: 1800, timeout: 15000 });
const LABELS = { intro: "Julian joins: the Prompt Playground", staging: "No staging needed", examples: "Where test examples come from", models: "Trying a cheaper model", nervous: "Before the holidays", mistake: "Alerts: Callie corrects Jordan", dashboard: "A dashboard for the VP", send: "Sending the plan", bye: "Wrap-up", pass: "Julian takes a question" };
await say("intro", LABELS.intro);
await settle({ minEntries: 2, timeout: 45000 }); // Julian explains, Grace reacts
// Grace's beats come in order; Jordan's next line is the earliest beat her last words match
// (looking at most two ahead). The planted mistake always follows Julian's monitoring answer.
const ORDER = ["staging", "examples", "models", "nervous", "mistake", "dashboard", "send"];
const PATTERNS = {
  staging: /\bstaging\b|\bdeploy (every|each)\b/,
  examples: /\bexamples?\b|\btest data\b|\bcome from\b/,
  models: /\bcheaper\b|\bsmaller model\b|\banother model\b|\bdifferent model\b|\bmodels?\b.*\bcost\b/,
  nervous: /\bnervous\b|\bbreak(ing)?\b|\bcheckout\b|\bworried\b|\brisky?\b/,
  dashboard: /\bvp\b|\bone page\b|\bdashboard\b/,
  send: /\bsend\b|\bemail me\b|\bshare (the|that) plan\b/,
};
let idx = 0;
let passes = 0;
for (let turn = 0; turn < 14 && Date.now() - started < MAX_MS && idx < ORDER.length; turn++) {
  await graceFinished();
  const last = [...(await convo())].reverse().find((x) => x.who === "grace")?.text.toLowerCase() || "";
  let id = null;
  // The planted mistake and the VP dashboard are Jordan's own beats: he raises them, so they always happen.
  if (ORDER[idx] === "mistake" || ORDER[idx] === "dashboard") { id = ORDER[idx]; idx++; }
  for (let k = idx; !id && k < Math.min(ORDER.length, idx + 3); k++) {
    if (ORDER[k] === "mistake" || !PATTERNS[ORDER[k]].test(last)) continue;
    if (ORDER[k] === "send" && k < ORDER.indexOf("dashboard")) continue;
    id = ORDER[k];
    idx = k + 1;
  }
  if (!id) {
    // Grace asked something off script: let Julian take it once. If she hasn't said anything new
    // since Jordan's last line (or didn't ask anything), Jordan just moves the call along.
    const c = await convo();
    const lastYou = [...c].reverse().find((x) => x.who === "you")?.at || 0;
    const g = [...c].reverse().find((x) => x.who === "grace");
    const asked = g && g.at > lastYou && /\?["”)]?\s*$/.test(g.text);
    if (asked && passes++ < 1) id = "pass";
    else { id = ORDER[idx++]; passes = 0; }
  } else passes = 0;
  await say(id, LABELS[id]);
  if (id === "send") {
    await sleep(1500);
    // Click Send on the answer in focus, or send the latest answer if something else is in focus.
    await page.evaluate(() => { const b = document.querySelector("#now .mini.go"); if (b) b.click(); else window.callieDebug.sendLatest(); });
    await settle({ minEntries: 0, quiet: 3000, timeout: 15000 });
    await say("bye", LABELS.bye);
    await sleep(6000);
    break;
  }
  const addressesJulian = /julian,/i.test(line(id).text);
  await settle({ minEntries: addressesJulian ? 2 : 1, timeout: addressesJulian ? 45000 : 30000 });
}
await page.click("#endBtn").catch(() => {});
await sleep(4500);
await cdp.send("Page.stopScreencast");
const tEnd = Date.now();
ff.stdin.end();
await new Promise((r) => ff.on("exit", r));
const mix = await page.evaluate(() => window.__stopMix());
const events = await page.evaluate(() => ({ cards: [...window.callieDebug.ui.cards.values()].map(({ detail, sources, ...c }) => ({ ...c, text: (c.correction || c.short || c.nudge || c.answer || "").slice(0, 160), sources: (sources || []).map((x) => x.title || x.url || x).slice(0, 3) })), convo: window.__convo || [] }));
await browser.close();

const audio = path.join(tmp, "audio.webm");
fs.writeFileSync(audio, Buffer.from(mix.b64, "base64"));
const offset = Math.max(0, (mix.start - t0) / 1000);
const mp4 = path.join(OUT, `${NAME}.mp4`);
await run(["-i", videoOnly, "-itsoffset", offset.toFixed(3), "-i", audio, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", mp4]);
const fix = events.cards.find((c) => c.type === "check");
const posterAt = fix ? (fix.at - t0) / 1000 + 3 : 60;
await run(["-ss", String(Math.max(1, posterAt)), "-i", mp4, "-frames:v", "1", "-q:v", "3", path.join(OUT, `${NAME}-poster.jpg`)]);
fs.writeFileSync(path.join(OUT, `${NAME}.json`), JSON.stringify({ title: "Live call: prompt changes, experiments and monitors", recordedAt: new Date(started).toISOString(), seconds: Math.round((tEnd - t0) / 1000), chapters }, null, 2));
fs.writeFileSync(path.join(OUT, `${NAME}.events.json`), JSON.stringify({ t0, chapters, cards: events.cards.map((c) => ({ ...c, t: (c.at - t0) / 1000 })), convo: events.convo.map((c) => ({ ...c, t: (c.at - t0) / 1000 })) }, null, 2));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${mp4} ${(fs.statSync(mp4).size / 1e6).toFixed(1)} MB, ${Math.round((tEnd - t0) / 1000)}s`);
console.log("cards:", events.cards.map((c) => `${c.type}: ${c.text}`).join("\n       "));
console.log("conversation:\n" + events.convo.map((c) => `  ${c.who}: ${c.text.slice(0, 120)}`).join("\n"));
