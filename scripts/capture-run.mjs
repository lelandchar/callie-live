// Real-path test: plays demo lines out loud with afplay (system audio) while telling the server
// who is speaking, so Callie hears them through Core Audio capture like a real call.
// Usage: node scripts/capture-run.mjs <fromIndex> <toIndex>
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = JSON.parse(fs.readFileSync(path.join(ROOT, "public/demo/script.json"), "utf8"));
const [from, to] = [Number(process.argv[2] || 0), Number(process.argv[3] || 999)];
const ws = new WebSocket("ws://localhost:4317/ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const at = () => `${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s`;
let speaking = false;
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "transcript") console.log(at(), "HEARD  ", `${m.utterance.speaker} (${m.utterance.who}, ${m.utterance.tone}): ${m.utterance.text.slice(0, 90)}`);
  if (m.type === "card" && m.card.status === "ready") console.log(at(), m.card.type.toUpperCase().padEnd(7), (m.card.answer || m.card.correction || m.card.nudge || "").slice(0, 100));
  if (m.type === "board" && m.op === "add") console.log(at(), "BOARD  ", m.item.type, m.item.title || "");
  if (m.type === "whisper" && m.phase === "start") { speaking = true; console.log(at(), "WHISPER", m.text); setTimeout(() => (speaking = false), 3500); }
  if (m.type === "email" && m.phase === "draft") console.log(at(), "EMAIL  ", m.draft.to);
  if (m.type === "hint") console.log(at(), "HINT   ", m.text.slice(0, 120));
});
ws.on("open", async () => {
  ws.send(JSON.stringify({ type: "reset" }));
  ws.send(JSON.stringify({ type: "demo_start", mode: "capture" }));
  await sleep(1800);
  const lines = script.scripts.after.lines.slice(from, to + 1);
  for (const line of lines) {
    while (speaking) await sleep(150);
    const meta = { id: line.id, who: line.who === "csm" ? "csm" : "customer", private: !!line.private, speaker: script.cast[line.who].name };
    ws.send(JSON.stringify({ type: "demo_line", phase: "start", ...meta }));
    await new Promise((r) => spawn("afplay", [path.join(ROOT, "public/demo/audio", `${line.id}.wav`)]).on("exit", r));
    ws.send(JSON.stringify({ type: "demo_line", phase: "end", ...meta }));
    if (line.action) ws.send(JSON.stringify({ type: "demo_action", action: line.action, to: line.actionTo }));
    await sleep(line.pauseAfter ?? 500);
  }
  await sleep(6000);
  ws.send(JSON.stringify({ type: "demo_stop" }));
  setTimeout(() => process.exit(0), 500);
});
