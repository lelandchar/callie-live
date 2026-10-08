// Jordan's lines for filming a live call (scenario 3), voiced with ElevenLabs v4.
// Writes public/demo/live/<id>.wav (24 kHz mono) and lines.json. Existing files are kept.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public/demo/live");
const VOICE = "iP95p4xoKVk53GoZ742B"; // the same "Jordan" voice as the recorded call
export const LINES = [
  { id: "intro", match: "", text: "Hi Grace, great to see you. I brought Julian, one of our solutions engineers, so we can make this hands-on. Julian, can you walk Grace through testing a new prompt without shipping it?" },
  { id: "staging", match: "staging|deploy every|deploy each", text: "Right, and no staging needed. The playground runs your new prompt against a dataset, so production never sees it." },
  { id: "examples", match: "examples|test data|where do|come from|which conversations", text: "Good question. Julian, where should Grace pull the test examples from?" },
  { id: "models", match: "cheaper|model|cost", text: "Yes. Compare Models runs the same prompt across models side by side, so you see quality and cost together." },
  { id: "nervous", match: "nervous|break|checkout|worried|scared|risk", text: "Totally fair, especially before the holidays. You run it as an experiment first and only ship the winner. Julian, what would Grace watch after launch?" },
  { id: "mistake", match: "", text: "And one thing on alerts: they only go to people with Arize logins, so we'd add your VP as a user." },
  { id: "dashboard", match: "vp|one page|dashboard|leadership", text: "And since your VP wants one page to look at: Julian, what would you put on that dashboard?" },
  { id: "send", match: "send|plan|recap|summary|email", text: "I'll send you the plan right now, while we're still on the call." },
  { id: "bye", match: "", text: "Thanks so much, Grace. Talk soon." },
  { id: "pass", match: "", text: "Good question. Julian, can you take that one?" },
];
if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const l of LINES) {
    const file = path.join(OUT, `${l.id}.wav`);
    if (fs.existsSync(file) && !process.argv.includes("--force")) continue;
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=pcm_24000`, {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ text: l.text, model_id: process.env.ELEVENLABS_MODEL || "eleven_v4" }),
    });
    if (!res.ok) { console.log("failed", l.id, res.status, (await res.text()).slice(0, 160)); continue; }
    const pcm = Buffer.from(await res.arrayBuffer());
    const wav = Buffer.alloc(44);
    wav.write("RIFF", 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write("WAVE", 8); wav.write("fmt ", 12);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(pcm.length, 40);
    fs.writeFileSync(file, Buffer.concat([wav, pcm]));
    console.log("wrote", l.id, (pcm.length / 48000).toFixed(1) + "s");
  }
  fs.writeFileSync(path.join(OUT, "lines.json"), JSON.stringify(LINES, null, 2));
}
