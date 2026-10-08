// Headless roleplay check: Grace (Gemini Live) greets, hears a synthesized Jordan reply, answers.
import WebSocket from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-"));
execFileSync("say", ["-v", "Daniel", "-o", path.join(dir, "j.aiff"), "Hi Grace, great to meet you. You install arize otel and the LangChain instrumentor, then call register with your space ID and API key."]);
execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", path.join(dir, "j.aiff"), path.join(dir, "j.wav")]);
const wav = fs.readFileSync(path.join(dir, "j.wav"));
const pcm = wav.subarray(wav.indexOf("data") + 8);
const ws = new WebSocket("ws://localhost:4317/ws");
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const text = { customer: "", csm: "" };
let audioChunks = 0;
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "persona_text") text[m.role] += m.text;
  if (m.type === "persona_audio") audioChunks++;
  if (m.type === "persona_turn" && m.phase === "complete" && text.customer.trim()) { console.log(at(), "PRIYA:", text.customer.trim()); text.customer = ""; }
  if (m.type === "hint") console.log(at(), "HINT", m.text);
});
ws.on("open", async () => {
  ws.send(JSON.stringify({ type: "roleplay_start" }));
  await new Promise((r) => setTimeout(r, 9000));
  for (let i = 0; i < pcm.length; i += 3200) { ws.send(pcm.subarray(i, i + 3200)); await new Promise((r) => setTimeout(r, 100)); }
  const silence = Buffer.alloc(3200);
  for (let i = 0; i < 25; i++) { ws.send(silence); await new Promise((r) => setTimeout(r, 100)); }
  await new Promise((r) => setTimeout(r, 9000));
  console.log(at(), "JORDAN (as Grace heard it):", text.csm.trim() || "(no input transcription)");
  console.log(at(), "audio chunks from Grace:", audioChunks);
  ws.send(JSON.stringify({ type: "roleplay_stop" }));
  setTimeout(() => process.exit(0), 800);
});
