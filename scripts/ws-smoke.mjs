// Smoke test of the real path: start listening, have macOS speak a customer question through
// the speakers, and watch for meeting audio levels, a transcript line and an answer card.
import WebSocket from "ws";
const ws = new WebSocket("ws://localhost:4317/ws");
let maxThem = 0;
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "level") { if (m.who === "them") maxThem = Math.max(maxThem, m.rms); return; }
  if (m.type === "hello") return console.log(at(), "hello: kb", m.kbSize, "listening", m.listening);
  if (m.type === "transcript") return console.log(at(), "TRANSCRIPT", m.utterance.who, JSON.stringify(m.utterance.text), "tone", m.utterance.tone, `(${m.latencyMs}ms)`);
  if (m.type === "card") return console.log(at(), "CARD", m.card.type, m.card.status, (m.card.answer || m.card.nudge || m.card.correction || "").slice(0, 160), m.card.latencyMs ? `(${m.card.latencyMs}ms)` : "");
  if (m.type === "board") return console.log(at(), "BOARD", m.op, m.item?.type, m.item?.title || "");
  if (m.type === "audio") return;
  console.log(at(), m.type, JSON.stringify(m).slice(0, 200));
});
ws.on("open", () => {
  ws.send(JSON.stringify({ type: "reset" }));
  ws.send(JSON.stringify({ type: "start" }));
  setTimeout(() => ws.send(JSON.stringify({ type: "simulate", text: "We're a health company. How do we keep patient messages out of the traces?" })), 1500);
  setTimeout(() => { console.log(at(), "max 'them' level:", maxThem.toFixed(4)); ws.send(JSON.stringify({ type: "stop" })); setTimeout(() => process.exit(0), 500); }, 22000);
});
