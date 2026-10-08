// End-to-end test of text mode (presenting over Zoom): join with text chat, type Jordan's
// lines, and check that the customer agent answers out loud and Callie checks the typed lines.
//   node scripts/text-e2e.mjs [url=http://localhost:4317/?call] [outDir=.]
import path from "node:path";
const [urlArg, outArg] = process.argv.slice(2);
const url = urlArg || "http://localhost:4317/?call";
const outDir = outArg || ".";
const pw = process.env.CALLIE_PLAYWRIGHT || `${process.env.HOME}/Desktop/SayMei-Web/node_modules/playwright/index.mjs`;
const { chromium } = await import(pw);
const browser = await chromium.launch({ channel: "chromium", headless: !process.env.HEADED, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--use-angle=metal", "--enable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
if (process.env.ACCESS_CODE) {
  await page.goto(new URL("/login", url).href);
  await page.fill("#code", process.env.ACCESS_CODE);
  await page.click("button[type=submit]");
}
await page.goto(url);
await page.waitForSelector("#joinTextBtn");
await page.waitForTimeout(1500);
const SCENARIO = process.env.SCENARIO || "arize";
await page.selectOption("#scenarioSel", SCENARIO);
await page.waitForTimeout(800);
await page.evaluate(() => document.getElementById("joinTextBtn").click());
const t0 = Date.now();
const LINES = {
  arize: [
    [25, "Hi Grace, thanks for making the time. Happy to help you get set up today."],
    [55, "You install arize-otel and the OpenInference LangChain instrumentor, then call register with your space ID and API key."],
    [85, "On Pro you get ninety days of retention, so you're covered for the pilot."],
    [115, "Good question. Let me find that for you."],
  ],
  "traces-skills": [
    [25, "Hi Grace, thanks for making the time. Happy to walk you through getting started."],
    [55, "A trace is one request end to end, and spans are its steps, like each LLM call or tool call."],
    [85, "Alyx is an Enterprise feature, so we'd look at that later."],
    [115, "Good question. Let me check that for you."],
  ],
};
LINES["relay"] = [
  [22, "Julian, can you walk Grace through testing a new prompt without shipping it?"],
];
LINES["claim"] = [
  [28, "And alerts only go to people with Arize logins, so we'd add your VP as a user."],
];
LINES["prompt-monitor"] = [
  [22, "Hi Grace, thanks for making the time. I brought Julian, one of our solutions engineers."],
  [45, "Julian, can you walk Grace through testing a new prompt without shipping it?"],
  [95, "And alerts only go to people with Arize logins, so we'd add your VP as a user."],
  [125, "Julian, what would you put on a dashboard for Grace's VP?"],
];
const lines = LINES[process.env.LINESET || SCENARIO] || LINES.arize;
const seen = new Set();
const dump = async () => {
  const s = await page.evaluate(() => ({
    chat: [...document.querySelectorAll("#chatLog .chat-msg")].map((m) => `${m.classList.contains("you") ? "you" : m.classList.contains("julian") ? "julian" : "grace"}: ${m.querySelector("span").textContent}`),
    cards: [...window.callieDebug.ui.cards.values()].filter((c) => c.status !== "thinking").map((c) => `${c.type}: ${(c.short || c.correction || c.nudge || c.answer || "").slice(0, 100)}`),
    timer: document.getElementById("callTimer").textContent,
    dock: !document.getElementById("chatDock").hidden,
    hints: [...document.querySelectorAll("#hints .hint span")].map((h) => h.textContent),
    heard: window.callieDebug.ui.transcript.map((u) => `${u.who}: ${u.text}`),
  }));
  for (const h of s.hints) if (!seen.has(`hint:${h}`)) { seen.add(`hint:${h}`); console.log("   hint", h.slice(0, 160)); }
  for (const h of s.heard) if (!seen.has(`heard:${h}`)) { seen.add(`heard:${h}`); console.log("   callie heard", h.slice(0, 140)); }
  for (const c of s.chat) if (!seen.has(c)) { seen.add(c); console.log("   chat", c.slice(0, 160)); }
  for (const c of s.cards) if (!seen.has(c)) { seen.add(c); console.log("   card", c); }
  return s;
};
for (const [at, text] of lines) {
  while (Date.now() - t0 < at * 1000) { await page.waitForTimeout(2500); await dump(); }
  await page.fill("#demoReplyInput", text);
  await page.press("#demoReplyInput", "Enter");
  console.log(`t+${Math.round((Date.now() - t0) / 1000)}s typed: ${text}`);
}
while (Date.now() - t0 < (Number(process.env.SECONDS) || 140) * 1000) { await page.waitForTimeout(2500); await dump(); }
const s = await dump();
await page.screenshot({ path: path.join(outDir, "text-mode.png") });
console.log("\nfinal chat:\n" + s.chat.map((c) => "  " + c.slice(0, 150)).join("\n"));
console.log(`\nsummary: dock=${s.dock} timer=${s.timer} grace lines=${s.chat.filter((c) => c.startsWith("grace")).length} cards=${s.cards.length} [${[...new Set(s.cards.map((c) => c.split(":")[0]))].join(", ")}]`);
await page.evaluate(() => document.getElementById("endBtn").click());
await page.waitForTimeout(1500);
await browser.close();
