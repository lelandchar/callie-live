import WebSocket from "ws";
const ws = new WebSocket("ws://localhost:4317/ws");
const qs = ["How will you measure the north star before launch?", "What exactly is out of scope for the MVP?", "What would you do in your first two weeks?"];
let n = 0;
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "hello" && m.profile === "panel" && n === 0) { n = 1; for (const q of qs) ws.send(JSON.stringify({ type: "ask", text: q })); }
  if (m.type === "card" && m.card.status === "ready") { console.log("\nQ:", m.card.question, `(${(m.card.latencyMs/1000).toFixed(1)}s)\nA:`, m.card.answer); if (++n > qs.length) { ws.send(JSON.stringify({ type: "profile", name: "arize" })); setTimeout(() => process.exit(0), 800); } }
  if (m.type === "board" && m.op === "add") console.log("   board:", m.item.type, m.item.title || "");
});
ws.on("open", () => ws.send(JSON.stringify({ type: "profile", name: "panel" })));
setTimeout(() => process.exit(1), 60000);
