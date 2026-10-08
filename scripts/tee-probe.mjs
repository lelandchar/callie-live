// Logs per-100ms RMS of system audio while macOS speaks a sentence, to see what the tail looks like.
import { AudioTee } from "audiotee";
import { spawn } from "node:child_process";
const tee = new AudioTee({ sampleRate: 16000, chunkDurationMs: 100 });
const t0 = Date.now();
const rows = [];
tee.on("data", (c) => {
  const b = c.data; let s = 0; const n = b.length >> 1;
  for (let i = 0; i < n; i++) { const v = b.readInt16LE(i * 2) / 32768; s += v * v; }
  rows.push([(Date.now() - t0) / 1000, Math.sqrt(s / n)]);
});
await tee.start();
setTimeout(() => { const p = spawn("say", ["-v", "Samantha", "How do we keep patient messages out of the traces?"]); p.on("exit", () => console.log("say exited at", ((Date.now() - t0) / 1000).toFixed(1), "s")); }, 800);
setTimeout(async () => {
  await tee.stop();
  let line = "";
  for (const [t, r] of rows) line += `${t.toFixed(1)}:${r < 0.0005 ? "0" : r.toFixed(3)} `;
  console.log(line);
  process.exit(0);
}, 9000);
