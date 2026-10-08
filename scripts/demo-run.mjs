// Plays the recorded demo call against the running server exactly like the browser player
// does (same messages, same timing, minus the audio output), and logs what Callie produced
// in each chapter. Usage: node scripts/demo-run.mjs [inject|capture] [fromLineIndex]
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = JSON.parse(fs.readFileSync(path.join(ROOT, "public/demo/script.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "public/demo/manifest.json"), "utf8"));
const mode = process.argv[2] || "inject";
const from = Number(process.argv[3] || 0);
const ws = new WebSocket("ws://localhost:4317/ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const at = () => `${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s`;
let chapter = "";
let speaking = false;
const events = [];
const log = (kind, text) => { events.push({ chapter, kind, text }); console.log(at(), `[${chapter}]`, kind.padEnd(10), text); };

ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "card" && m.card.status === "ready") {
    const c = m.card;
    if (c.type === "answer" || c.type === "callie") log(c.type.toUpperCase(), `${(c.latencyMs / 1000).toFixed(1)}s · ${c.answer.slice(0, 110)}${c.privateNote ? ` · PRIVATE: ${c.privateNote.slice(0, 60)}` : ""}`);
    if (c.type === "check") log(c.clarify ? "CLARIFY" : "CORRECTION", `${c.severity} · ${c.correction.slice(0, 100)}`);
    if (c.type === "coach") log("COACH", `${c.tone} · ${c.nudge}`);
  }
  if (m.type === "board" && m.op === "add") log("BOARD", `${m.item.type} · ${m.item.title || (m.item.text || "").slice(0, 50)}`);
  if (m.type === "whisper" && m.phase === "start") { speaking = true; log("WHISPER", m.text); setTimeout(() => (speaking = false), 3500); }
  if (m.type === "email" && m.phase === "draft") log("EMAIL", `to ${m.draft.to} · ${m.draft.subject}`);
  if (m.type === "share" && m.phase === "ready") log("SHARE", `${m.title} · ${m.url}`);
  if (m.type === "transcript" && process.env.SHOW_TRANSCRIPT) log("heard", `${m.utterance.speaker}: ${m.utterance.text.slice(0, 80)} (${m.utterance.tone})`);
  if (m.type === "hint") log("HINT", m.text.slice(0, 120));
});

ws.on("open", async () => {
  ws.send(JSON.stringify({ type: "reset" }));
  ws.send(JSON.stringify({ type: "demo_start", mode }));
  await sleep(mode === "capture" ? 1800 : 300);
  const lines = script.scripts.after.lines;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    if (line.chapter) chapter = line.chapter;
    while (speaking) await sleep(150);
    const role = line.who === "csm" ? "csm" : "customer";
    const meta = { id: line.id, who: role, private: !!line.private, speaker: script.cast[line.who].name };
    ws.send(JSON.stringify({ type: "demo_line", phase: "start", ...meta }));
    await sleep((manifest[line.id]?.seconds || 3) * 1000);
    ws.send(JSON.stringify({ type: "demo_line", phase: "end", ...meta }));
    if (line.action) ws.send(JSON.stringify({ type: "demo_action", action: line.action, to: line.actionTo }));
    await sleep(line.pauseAfter ?? 500);
  }
  await sleep(8000);
  ws.send(JSON.stringify({ type: "demo_stop" }));
  console.log(`\nTotal ${at()} · events: ${events.length}`);
  const byChapter = {};
  for (const e of events) (byChapter[e.chapter] ||= []).push(e.kind);
  // Test cases: what each chapter of the call must produce for the demo to land.
  const EXPECT = {
    "2 · Setup": ["ANSWER", "BOARD"],
    "3 · Finding the keys": ["ANSWER"],
    "4 · A misconception": ["CLARIFY"],
    "5 · Retention": ["CORRECTION", "WHISPER"],
    "6 · Shopper PII": ["ANSWER"],
    "7 · Latency": ["ANSWER", "COACH"],
    "8 · Sessions": ["CALLIE", "WHISPER"],
    "9 · Evals": ["ANSWER", "BOARD"],
    "10 · Security joins": ["ANSWER", "CORRECTION"],
    "11 · Holiday scale": ["ANSWER"],
    "12 · Under pressure": ["CALLIE", "BOARD"],
    "13 · Wrap-up": ["SHARE"],
  };
  let pass = 0, total = 0;
  const row = (name, ok, got) => { total++; if (ok) pass++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(26)} ${got}`); };
  console.log("\nTest cases");
  for (const [c, need] of Object.entries(EXPECT)) {
    const got = byChapter[c] || [];
    row(c, need.every((k) => got.includes(k)), `need ${need.join("+")} · got ${got.join(", ") || "nothing"}`);
  }
  const count = (k) => events.filter((e) => e.kind === k).length;
  row("Emails drafted (Grace, Marcus)", count("EMAIL") >= 2, `${count("EMAIL")} drafted`);
  row("Coaching moments", count("COACH") >= 2, `${count("COACH")} coaching cards`);
  const notes = events.filter((e) => e.text.includes("PRIVATE:")).length;
  row("Private notes stay rare", notes <= 4, `${notes} answers carried a private note`);
  console.log(`\n${pass}/${total} passed`);
  setTimeout(() => process.exit(pass === total ? 0 : 1), 500);
});
