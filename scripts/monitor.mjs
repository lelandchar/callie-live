// Passive monitor: logs what Callie produces while someone drives the browser demo player.
// Usage: node scripts/monitor.mjs <seconds>
import WebSocket from "ws";
const secs = Number(process.argv[2] || 120);
const ws = new WebSocket("ws://localhost:4317/ws");
const t0 = Date.now();
const at = () => `${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s`;
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "demo") console.log(at(), "DEMO", m.phase, m.mode || "");
  if (m.type === "status") console.log(at(), "LISTENING", m.listening);
  if (m.type === "transcript") console.log(at(), "HEARD", `${m.utterance.speaker} (${m.utterance.who}): ${m.utterance.text.slice(0, 70)}`);
  if (m.type === "card" && m.card.status === "ready") console.log(at(), m.card.type.toUpperCase(), (m.card.short || m.card.correction || m.card.nudge || m.card.answer || "").slice(0, 90));
  if (m.type === "board" && m.op === "add") console.log(at(), "BOARD", m.item.type, m.item.title || "");
  if (m.type === "whisper" && m.phase === "start") console.log(at(), "WHISPER", m.text);
  if (m.type === "email" && m.phase === "draft") console.log(at(), "EMAIL", m.draft.to);
  if (m.type === "hint") console.log(at(), "HINT", m.text.slice(0, 100));
});
setTimeout(() => process.exit(0), secs * 1000);
