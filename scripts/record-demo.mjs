// Film the recorded demo: the real app playing the Cartwell call with Callie, screen and sound.
// Frames come from Chrome's screencast (headless, on the GPU) and go straight into ffmpeg; the
// app logs when every sound starts (?rec), and the soundtrack is rebuilt from those times.
//
//   node scripts/record-demo.mjs [--from=<line index>] [--seconds=<stop after>] [--out=public/media] [--name=callie-live-demo]
//
// Needs Playwright (CALLIE_PLAYWRIGHT) and an ffmpeg with libx264 + aac (FFMPEG).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || "").split("=")[1] || d;
const BASE = arg("url", "http://localhost:4317");
const FROM = Number(arg("from", "0"));
const SECONDS = Number(arg("seconds", "0"));
const OUT = path.resolve(ROOT, arg("out", "public/media"));
const NAME = arg("name", "callie-live-demo");
const FFMPEG = process.env.FFMPEG || path.join(ROOT, "agent/.venv/lib/python3.12/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1");
const { chromium } = await import(process.env.CALLIE_PLAYWRIGHT || `${process.env.HOME}/Desktop/SayMei-Web/node_modules/playwright/index.mjs`);
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(OUT, ".rec-"));
const videoOnly = path.join(tmp, "video.mp4");
const run = (args) => new Promise((resolve, reject) => {
  const p = spawn(FFMPEG, ["-y", "-loglevel", "error", ...args], { stdio: ["ignore", "inherit", "inherit"] });
  p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}`))));
});

const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
if (process.env.ACCESS_CODE) {
  await page.goto(`${BASE}/login`);
  await page.fill("#code", process.env.ACCESS_CODE);
  await page.click("button[type=submit]");
}
await page.goto(`${BASE}/?recorded&rec`);
await page.waitForSelector("#playAfterBtn");
await page.waitForFunction(() => document.getElementById("avatarProgress").classList.contains("done"), null, { timeout: 90000 });
await page.waitForTimeout(2000);

// Screen → ffmpeg. Timestamps are the frames' arrival times, so pauses and bursts stay real.
const ff = spawn(FFMPEG, ["-y", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-use_wallclock_as_timestamps", "1", "-i", "-",
  "-vf", "fps=30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", videoOnly], { stdio: ["pipe", "inherit", "inherit"] });
const cdp = await page.context().newCDPSession(page);
let t0 = 0;
let frames = 0;
cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
  if (!t0) t0 = Date.now();
  ff.stdin.write(Buffer.from(data, "base64"));
  frames++;
  cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });
await page.waitForTimeout(2500); // a beat on the start card

if (FROM) await page.selectOption("#chapterSel", String(FROM));
await page.click("#playAfterBtn");
const startedAt = Date.now();
console.log("recording…", new Date().toISOString());
await page.waitForFunction(() => window.callieDebug?.rec.running, null, { timeout: 60000 });
const deadline = SECONDS ? startedAt + SECONDS * 1000 : startedAt + 20 * 60 * 1000;
while (Date.now() < deadline) {
  await page.waitForTimeout(1000);
  if (!(await page.evaluate(() => window.callieDebug.rec.running))) break;
}
if (SECONDS && (await page.evaluate(() => window.callieDebug.rec.running))) await page.click("#endBtn");
await page.waitForTimeout(4000); // let the summary settle on screen
await cdp.send("Page.stopScreencast");
const tEnd = Date.now();
ff.stdin.end();
await new Promise((r) => ff.on("exit", r));
const events = await page.evaluate(() => window.__recEvents || []);
await browser.close();
console.log(`frames=${frames} duration=${((tEnd - t0) / 1000).toFixed(1)}s events=${events.length}`);

// Soundtrack: every recorded line and every whisper, placed where it started.
const RATE = 24000;
const total = Math.ceil(((tEnd - t0) / 1000 + 1) * RATE);
const mix = new Float32Array(total);
const place = (pcm, rate, atMs) => {
  const start = Math.round(((atMs - t0) / 1000) * RATE);
  const step = rate / RATE;
  for (let i = 0; start + i < total; i++) {
    const j = Math.floor(i * step);
    if (j >= pcm.length) break;
    if (start + i >= 0) mix[start + i] += pcm[j] / 32768;
  }
};
const pcmOf = (buf) => {
  const b = buf.subarray(44);
  const out = new Int16Array(b.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(i * 2);
  return out;
};
for (const e of events) {
  if (e.type === "line") place(pcmOf(fs.readFileSync(path.join(ROOT, "public/demo/audio", `${e.id}.wav`))), RATE, e.at);
  if (e.type === "pcm") {
    const raw = Buffer.from(e.data, "base64");
    const pcm = e.wav ? pcmOf(raw) : new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + (raw.length & ~1)));
    place(pcm, e.rate || RATE, e.at);
  }
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
const chapters = events.filter((e) => e.type === "chapter").map((e) => ({ title: e.title, t: Math.max(0, (e.at - t0) / 1000) }));
const posterAt = chapters.find((c) => /Retention/.test(c.title))?.t ?? 60;
await run(["-ss", String(Math.max(1, posterAt + 9)), "-i", mp4, "-frames:v", "1", "-q:v", "3", path.join(OUT, `${NAME}-poster.jpg`)]);
fs.writeFileSync(path.join(OUT, `${NAME}.json`), JSON.stringify({ recordedAt: new Date(startedAt).toISOString(), seconds: Math.round((tEnd - t0) / 1000), chapters }, null, 2));
fs.rmSync(tmp, { recursive: true, force: true });
console.log("wrote", mp4, `${(fs.statSync(mp4).size / 1e6).toFixed(1)} MB`);
