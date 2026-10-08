// Voices the demo call with ElevenLabs v4 (one WAV per line), then has Gemini transcribe each
// line back as a QA pass so mangled jargon is caught before the demo.
// Run: node scripts/make-demo-audio.mjs [--force]
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { pcm16ToWav } from "../lib/wav.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEMO = path.join(ROOT, "public", "demo");
const script = JSON.parse(fs.readFileSync(path.join(DEMO, "script.json"), "utf8"));
const force = process.argv.includes("--force");
const KEY = process.env.ELEVENLABS_API_KEY;
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function tts(text, voiceId) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_24000`, {
    method: "POST",
    headers: { "xi-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL || "eleven_v4" }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
  return pcm16ToWav(pcm, 24000);
}

const words = (s) => s.toLowerCase().replace(/\[[^\]]+\]/g, "").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
function similarity(a, b) {
  const A = words(a), B = new Set(words(b));
  return A.filter((w) => B.has(w)).length / Math.max(1, A.length);
}

const jobs = [];
for (const [name, s] of Object.entries(script.scripts)) for (const line of s.lines) jobs.push({ name, line });
const manifest = {};
let i = 0;
async function worker() {
  while (i < jobs.length) {
    const { name, line } = jobs[i++];
    const file = path.join(DEMO, "audio", `${line.id}.wav`);
    const voiceId = script.cast[line.who].voiceId;
    if (force || !fs.existsSync(file)) fs.writeFileSync(file, await tts(line.text, voiceId));
    const wav = fs.readFileSync(file);
    const seconds = (wav.length - 44) / 2 / 24000;
    let heard = "";
    try {
      const r = await ai.models.generateContent({
        model: "gemini-3.5-flash-lite",
        contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/wav", data: wav.toString("base64") } }, { text: "Transcribe exactly. Output only the transcript." }] }],
        config: { thinkingConfig: { thinkingLevel: "minimal" } },
      });
      heard = r.text.trim();
    } catch (e) { heard = `(transcribe failed: ${e.message.slice(0, 60)})`; }
    manifest[line.id] = { seconds: Math.round(seconds * 100) / 100 };
    const sim = similarity(line.text, heard);
    console.log(`${line.id} ${seconds.toFixed(1)}s match ${(sim * 100).toFixed(0)}%${sim < 0.85 ? `  <-- heard: "${heard}"` : ""}`);
  }
}
await Promise.all([worker(), worker(), worker()]);
fs.writeFileSync(path.join(DEMO, "manifest.json"), JSON.stringify(manifest, null, 1));
console.log(`wrote ${Object.keys(manifest).length} lines + manifest.json`);
