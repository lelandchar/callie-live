// End-to-end test of the live video call in a real (headless) Chromium.
// Chrome's fake devices stand in for the presenter: the camera is a test pattern and the mic
// plays a WAV of Jordan's lines. Grace (LiveKit agent + Spatius avatar) must join, talk, and
// Callie must turn the call into cards.
//
//   node scripts/call-e2e.mjs <fake-mic.wav> [seconds=150] [url=http://localhost:4317/?call] [outDir]
//
// Playwright isn't a dependency of this app; point CALLIE_PLAYWRIGHT at any installed copy.
import path from "node:path";
import fs from "node:fs";

const [wav, secondsArg, urlArg, outArg] = process.argv.slice(2);
if (!wav) { console.error("usage: node scripts/call-e2e.mjs <fake-mic.wav> [seconds] [url] [outDir]"); process.exit(1); }
const seconds = Number(secondsArg || 150);
const url = urlArg || "http://localhost:4317/?call";
const outDir = outArg || path.dirname(wav);
const pw = process.env.CALLIE_PLAYWRIGHT || `${process.env.HOME}/Desktop/SayMei-Web/node_modules/playwright/index.mjs`;
const { chromium } = await import(pw);

const browser = await chromium.launch({
  headless: process.env.HEADED ? false : true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${path.resolve(wav)}%noloop`,
    "--autoplay-policy=no-user-gesture-required",
    "--enable-unsafe-swiftshader",
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
page.on("console", (m) => { if (m.type() !== "debug") logs.push(`[${m.type()}] ${m.text()}`.slice(0, 300)); });
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
if (process.env.ACCESS_CODE) {
  await page.goto(new URL("/login", url).href);
  await page.fill("#code", process.env.ACCESS_CODE);
  await page.click("button[type=submit]");
}
await page.goto(url);
await page.waitForSelector("#joinBtn");
await page.waitForTimeout(1500);
const t0 = Date.now();
await page.click("#joinBtn", { force: true, timeout: 10000 }).catch(() => page.evaluate(() => document.getElementById("joinBtn").click()));
console.log("joined at", new Date().toISOString());

let shot = 0;
const snap = async (label) => {
  const file = path.join(outDir, `call-${String(++shot).padStart(2, "0")}-${label}.png`);
  await page.screenshot({ path: file });
  return file;
};
const state = () => page.evaluate(() => {
  const d = window.callieDebug;
  const cards = [...(d?.ui.cards.values() || [])].map((c) => ({ type: c.type, status: c.status, text: (c.short || c.correction || c.nudge || c.question || c.answer || "").slice(0, 90), ms: c.latencyMs }));
  return {
    inCall: d?.ui.inCall,
    connecting: document.getElementById("connecting").hidden ? "" : document.getElementById("connectingText").textContent,
    timer: document.getElementById("callTimer").textContent,
    caption: document.getElementById("captions").hidden ? "" : document.getElementById("captions").innerText.slice(0, 120),
    transcript: (d?.ui.transcript || []).map((u) => `${u.who}: ${u.text}`.slice(0, 110)),
    cards,
    board: document.querySelectorAll("#boardItems .bitem").length,
    canvas: !!document.querySelector("#avatarStage canvas"),
    noAvatar: document.getElementById("stage").classList.contains("no-avatar"),
    error: document.getElementById("joinError").hidden ? "" : document.getElementById("joinError").textContent,
  };
});

let last = "";
const seen = new Set();
while (Date.now() - t0 < seconds * 1000) {
  await page.waitForTimeout(5000);
  const s = await state();
  const line = `t+${Math.round((Date.now() - t0) / 1000)}s timer=${s.timer} cards=${s.cards.length} board=${s.board}${s.connecting ? ` [${s.connecting}]` : ""}${s.error ? ` ERROR: ${s.error}` : ""}`;
  if (line !== last) console.log(line);
  last = line;
  for (const u of s.transcript) if (!seen.has(u)) { seen.add(u); console.log("   heard", u); }
  for (const c of s.cards) { const k = `${c.type}:${c.status}:${c.text}`; if (!seen.has(k) && c.status !== "thinking") { seen.add(k); console.log(`   card ${c.type}${c.ms ? ` (${(c.ms / 1000).toFixed(1)}s)` : ""}: ${c.text}`); } }
  if (s.caption && !seen.has(`cap:${s.caption}`)) { seen.add(`cap:${s.caption}`); console.log("   caption", s.caption.replace(/\n/g, " ")); }
  if ([20, 60, 120].some((t) => Math.abs((Date.now() - t0) / 1000 - t) < 2.6)) console.log("   screenshot", await snap(`t${Math.round((Date.now() - t0) / 1000)}`));
  if (s.error) break;
}
console.log("final screenshot", await snap("final"));
const s = await state();
fs.writeFileSync(path.join(outDir, "call-e2e.json"), JSON.stringify({ state: s, logs }, null, 2));
console.log(`\nsummary: avatar=${s.canvas && !s.noAvatar} heard=${s.transcript.length} lines (${s.transcript.filter((t) => t.startsWith("them")).length} from Grace) cards=${s.cards.length} [${[...new Set(s.cards.map((c) => c.type))].join(", ")}] board=${s.board}`);
console.log("console errors:", logs.filter((l) => /error/i.test(l)).slice(0, 8));
await page.click("#endBtn").catch(() => {});
await page.waitForTimeout(1500);
await browser.close();
