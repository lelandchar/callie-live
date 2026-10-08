import WebSocket from "ws";
const ws = new WebSocket("ws://localhost:4317/ws");
const lv = [];
ws.on("message", (raw) => { const m = JSON.parse(raw.toString()); if (m.type === "level" && m.who === "them") lv.push(m.rms); });
ws.on("open", () => {
  ws.send(JSON.stringify({ type: "start" }));
  setTimeout(() => {
    ws.send(JSON.stringify({ type: "stop" }));
    const s = [...lv].sort((a, b) => a - b);
    const q = (p) => s[Math.floor(p * (s.length - 1))]?.toFixed(5);
    console.log("samples", s.length, "min", q(0), "p25", q(0.25), "median", q(0.5), "p75", q(0.75), "p95", q(0.95), "max", q(1));
    process.exit(0);
  }, 6000);
});
