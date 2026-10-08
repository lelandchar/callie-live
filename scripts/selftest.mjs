// End-to-end check of Callie's Gemini calls without a meeting: macOS `say` plays the customer,
// then listen -> answer, a wrong CSM claim -> check, and a whisper -> speak.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { KnowledgeBase } from "../lib/kb.js";
import { Brain } from "../lib/brain.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const kb = new KnowledgeBase(path.join(root, "kb", "chunks.json"));
const account = JSON.parse(fs.readFileSync(path.join(root, "kb", "account.json"), "utf8"));
const facts = fs.readFileSync(path.join(root, "kb", "facts.md"), "utf8");
const brain = new Brain({ apiKey: process.env.GEMINI_API_KEY, kb, account, facts });

function sayToWav(text, voice = "Samantha") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "callie-"));
  const aiff = path.join(dir, "u.aiff");
  const wav = path.join(dir, "u.wav");
  execFileSync("say", ["-v", voice, "-o", aiff, text]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  return fs.readFileSync(wav);
}

const t = () => performance.now();
const ms = (s) => `${Math.round(performance.now() - s)}ms`;

let s = t();
const wav = sayToWav("Quick question. How do we actually get traces from our LangChain app into Arize? And can we keep patient messages out of the traces?");
const heard = await brain.listen(wav, "Customer", "");
console.log("LISTEN", ms(s), JSON.stringify(heard));

s = t();
const ans = await brain.answer(heard.focus || heard.text, { asker: "Grace Liu (customer)", recent: `Customer: ${heard.text}` });
console.log("ANSWER", ms(s), JSON.stringify(ans, null, 1).slice(0, 1800));

s = t();
const chk = await brain.check("On the Pro plan you get ninety days of retention, and SSO is included.", { recent: "" });
console.log("CHECK", ms(s), JSON.stringify(chk, null, 1).slice(0, 1200));

s = t();
const audio = await brain.speak(chk.whisper || "Pro retention is 30 days, not 90.");
console.log("SPEAK", ms(s), audio.mimeType, `${Math.round((audio.data.length * 3) / 4 / 1024)} KB`);
