// Voice the two-person recorded call (public/demo/call/script.json) with Gemini 3.8 Flash TTS.
// Writes public/demo/audio/<id>.wav (24 kHz mono, which the server injects into Callie) and
// public/demo/call/manifest.json (seconds per line). Existing files are kept; --force redoes them.
//   node scripts/make-call-voices.mjs [--force] [--only=c15,c16]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
process.loadEnvFile(path.join(ROOT, ".env"));
const MODEL = process.env.CALLIE_TTS_MODEL || "gemini-3.8-flash-tts";
const script = JSON.parse(fs.readFileSync(path.join(ROOT, "public/demo/call/script.json"), "utf8"));
const only = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const force = process.argv.includes("--force");
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const audioDir = path.join(ROOT, "public/demo/audio");
const manifestFile = path.join(ROOT, "public/demo/call/manifest.json");
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : {};

const wavOf = (pcm, rate) => {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
};
// Trim leading and trailing near-silence so the avatar's lips start with the first word.
const trim = (pcm) => {
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1);
  const loud = (i) => Math.abs(s[i]) > 400;
  let a = 0, b = s.length - 1;
  while (a < s.length && !loud(a)) a++;
  while (b > a && !loud(b)) b--;
  a = Math.max(0, a - 1200); b = Math.min(s.length - 1, b + 2400); // keep 50 ms before, 100 ms after
  return Buffer.from(s.slice(a, b + 1).buffer);
};

const todo = script.lines.filter((l) => (!only.length || only.includes(l.id)) && (force || only.length || !fs.existsSync(path.join(audioDir, `${l.id}.wav`))));
const queue = [...todo];
const worker = async () => {
  while (queue.length) {
    const l = queue.shift();
    const who = script.cast[l.who];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await ai.models.generateContent({
          model: MODEL,
          // The structured prompt keeps the direction out of the audio: only the transcript is spoken.
          contents: [{ role: "user", parts: [{ text: `# AUDIO PROFILE: ${who.name}\n## THE SCENE: An onboarding video call between Cartwell and Arize. ${who.name} is ${who.style}.\n### DIRECTOR'S NOTES\nStyle: natural, conversational, like a real person talking on a video call.\nPacing: natural.\n#### TRANSCRIPT\n${l.text}` }] }],
          config: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: who.voice } } } },
        });
        const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
        if (!part) throw new Error("no audio");
        let raw = Buffer.from(part.inlineData.data, "base64");
        let rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType || "")?.[1] || 24000);
        if (raw.toString("ascii", 0, 4) === "RIFF") {
          // The model returns a WAV file: read its format and keep only the samples.
          let p = 12, channels = 1;
          while (p + 8 <= raw.length) {
            const id = raw.toString("ascii", p, p + 4), size = raw.readUInt32LE(p + 4);
            if (id === "fmt ") { channels = raw.readUInt16LE(p + 10); rate = raw.readUInt32LE(p + 12); }
            if (id === "data") { raw = raw.subarray(p + 8, p + 8 + size); break; }
            p += 8 + size + (size % 2);
          }
          if (channels !== 1) throw new Error(`unexpected channels ${channels}`);
        }
        if (rate !== 24000) throw new Error(`unexpected rate ${rate}`);
        const pcm = trim(raw);
        fs.writeFileSync(path.join(audioDir, `${l.id}.wav`), wavOf(pcm, rate));
        manifest[l.id] = { seconds: Math.round((pcm.length / 2 / rate) * 100) / 100 };
        console.log(`  ${l.id} ${who.name.split(" ")[0].padEnd(6)} ${manifest[l.id].seconds}s`);
        break;
      } catch (e) {
        if (attempt === 2) console.log(`  ${l.id} failed: ${e.message?.slice(0, 140)}`);
        else await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  }
};
await Promise.all(Array.from({ length: 4 }, worker));
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
const total = script.lines.reduce((s, l) => s + (manifest[l.id]?.seconds || 0) + (l.pauseAfter || 500) / 1000, 0);
console.log(`voiced ${todo.length} lines with ${MODEL}; the call runs about ${Math.round(total)} s plus Callie's pauses`);
