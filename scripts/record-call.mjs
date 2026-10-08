// Film the recorded two-person call (public/demo/call/script.json): the real app in recorded mode,
// with Grace's and Julian's avatars each speaking their own audio in Spatius direct mode, and Callie
// listening live. Frames are stamped with the browser's own frame times, and every line's audio is
// placed where its avatar started speaking (plus the SDK's 200 ms start transition), so lips and
// voice line up.
//
//   node scripts/record-call.mjs [--url=http://localhost:4318] [--out=public/media] [--name=callie-live-call]
//
// Run it against a server started with an empty CALLIE_DEMO_INBOX, so email drafts show the
// customer's (fictional) address: PORT=4318 CALLIE_DEMO_INBOX= node server.js
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || "").split("=").slice(1).join("=") || d;
const BASE = arg("url", "http://localhost:4318");
const OUT = path.resolve(ROOT, arg("out", "public/media"));
const NAME = arg("name", "callie-live-call");
// The SDK eases into speech for about 200 ms after "playing"; measured on take 1, 150 ms puts the
// lips within a frame of the voice (200 ms had the lips 34 to 67 ms early).
const START_TRANSITION_MS = 150;
const FFMPEG = process.env.FFMPEG || path.join(ROOT, "agent/.venv/lib/python3.12/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1");
const { chromium } = await import(process.env.CALLIE_PLAYWRIGHT || `${process.env.HOME}/Desktop/SayMei-Web/node_modules/playwright/index.mjs`);
const script = JSON.parse(fs.readFileSync(path.join(ROOT, "public/demo/call/script.json"), "utf8"));
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(OUT, ".rec-"));
const framesDir = path.join(tmp, "frames");
fs.mkdirSync(framesDir);
const run = (args) => new Promise((resolve, reject) => {
  const p = spawn(FFMPEG, ["-y", "-loglevel", "error", ...args], { stdio: ["ignore", "inherit", "inherit"] });
  p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}`))));
});

const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("console", (m) => { if (m.type() !== "log" && /avatar|voice|teammate/i.test(m.text())) console.log("console:", m.text().slice(0, 200)); });
await page.goto(`${BASE}/?recorded&rec`);
await page.waitForSelector("#playAfterBtn");
await page.waitForFunction(() => document.getElementById("avatarProgress").classList.contains("done") && document.querySelector("#mateStage canvas"), null, { timeout: 120000 });
await page.waitForTimeout(2500);

// Screen → JPEG frames stamped with the browser's frame times (not their arrival times).
const cdp = await page.context().newCDPSession(page);
const frames = [];
let writing = Promise.resolve();
cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
  const file = path.join(framesDir, `${String(frames.length).padStart(6, "0")}.jpg`);
  frames.push({ file, ts: metadata.timestamp * 1000, arrived: Date.now() });
  writing = writing.then(() => fs.promises.writeFile(file, Buffer.from(data, "base64")));
  cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });
await page.waitForTimeout(2500); // a beat on the start card
await page.click("#playAfterBtn");
const startedAt = Date.now();
console.log("recording…", new Date(startedAt).toISOString());
await page.waitForFunction(() => window.callieDebug?.rec.running, null, { timeout: 90000 });
const deadline = startedAt + 12 * 60 * 1000;
while (Date.now() < deadline) {
  await page.waitForTimeout(1000);
  if (!(await page.evaluate(() => window.callieDebug.rec.running))) break;
}
await page.waitForTimeout(3500); // the last card settles on screen
await cdp.send("Page.stopScreencast");
await writing;
const events = await page.evaluate(() => ({
  log: window.__recEvents || [],
  cards: [...window.callieDebug.ui.cards.values()].map(({ detail, sources, ...c }) => ({ ...c, text: (c.correction || c.short || c.nudge || c.answer || "").slice(0, 200) })),
}));
await browser.close();
if (frames.length < 10) throw new Error("no frames captured");

// Video: each frame lasts until the next one was drawn.
const t0 = frames[0].ts;
const tEnd = frames[frames.length - 1].ts + 1000 / 30;
const list = frames.map((f, i) => `file '${f.file}'\nduration ${(((frames[i + 1]?.ts ?? tEnd) - f.ts) / 1000).toFixed(4)}`).join("\n") + `\nfile '${frames[frames.length - 1].file}'\n`;
fs.writeFileSync(path.join(tmp, "frames.txt"), list);
const videoOnly = path.join(tmp, "video.mp4");
await run(["-f", "concat", "-safe", "0", "-i", path.join(tmp, "frames.txt"), "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", videoOnly]);
const lag = frames.map((f) => f.arrived - f.ts).sort((a, b) => a - b)[frames.length >> 1];
console.log(`frames=${frames.length} duration=${((tEnd - t0) / 1000).toFixed(1)}s median frame delivery lag=${lag} ms lines=${events.log.filter((e) => e.type === "line").length}`);

// Soundtrack: every line where its avatar started speaking.
const RATE = 24000;
const total = Math.ceil(((tEnd - t0) / 1000 + 1) * RATE);
const mix = new Float32Array(total);
const pcmOf = (buf) => { const b = buf.subarray(44); const out = new Int16Array(b.length >> 1); for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(i * 2); return out; };
for (const e of events.log.filter((x) => x.type === "line")) {
  const pcm = pcmOf(fs.readFileSync(path.join(ROOT, "public/demo/audio", `${e.id}.wav`)));
  const start = Math.round(((e.at + START_TRANSITION_MS - t0) / 1000) * RATE);
  for (let i = 0; i < pcm.length && start + i < total; i++) if (start + i >= 0) mix[start + i] += pcm[i] / 32768;
}
const wav = Buffer.alloc(44 + total * 2);
wav.write("RIFF", 0); wav.writeUInt32LE(36 + total * 2, 4); wav.write("WAVE", 8); wav.write("fmt ", 12);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(RATE, 24); wav.writeUInt32LE(RATE * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(total * 2, 40);
for (let i = 0; i < total; i++) wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mix[i] * 32767))), 44 + i * 2);
const audio = path.join(tmp, "audio.wav");
fs.writeFileSync(audio, wav);

const mp4 = path.join(OUT, `${NAME}.mp4`);
await run(["-i", videoOnly, "-i", audio, "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", mp4]);
const chapters = events.log.filter((e) => e.type === "chapter").map((e) => ({ title: e.title.replace(/^Chapter /, ""), t: Math.max(0, (e.at - t0) / 1000) }));
const fix = events.cards.find((c) => c.type === "check" && !c.clarify);
const posterAt = fix ? (fix.at - t0) / 1000 + 3 : 120;
await run(["-ss", String(Math.max(1, posterAt)), "-i", mp4, "-frames:v", "1", "-q:v", "3", path.join(OUT, `${NAME}-poster.jpg`)]);
fs.writeFileSync(path.join(OUT, `${NAME}.json`), JSON.stringify({ title: script.title, recordedAt: new Date(startedAt).toISOString(), seconds: Math.round((tEnd - t0) / 1000), chapters }, null, 2));
fs.writeFileSync(path.join(OUT, `${NAME}.events.json`), JSON.stringify({ t0, log: events.log.map((e) => ({ ...e, t: (e.at - t0) / 1000 })), cards: events.cards.map((c) => ({ ...c, t: (c.at - t0) / 1000 })) }, null, 2));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${mp4} ${(fs.statSync(mp4).size / 1e6).toFixed(1)} MB`);
console.log("cards:\n" + events.cards.filter((c) => c.status !== "thinking").map((c) => `  ${((c.at - t0) / 1000).toFixed(1)}s ${c.type}${c.clarify ? "/clarify" : ""}: ${c.text.slice(0, 110)}`).join("\n"));
