// Re-embed the fact base with the current embedding model, without re-crawling the docs.
//   node scripts/reembed.mjs [model]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
process.loadEnvFile(path.join(ROOT, ".env"));
const model = process.argv[2] || "gemini-embedding-2";
const file = path.join(ROOT, "kb/chunks.json");
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const chunks = Array.isArray(data) ? data : data.chunks;
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const queue = [...chunks];
let done = 0, failed = 0;
const worker = async () => {
  while (queue.length) {
    const c = queue.shift();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await ai.models.embedContent({ model, contents: `${c.title} — ${c.heading}\n\n${c.text}`.slice(0, 7000), config: { taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: 768 } });
        c.embedding = r.embeddings[0].values.map((v) => Math.round(v * 1e5) / 1e5);
        break;
      } catch (e) {
        if (attempt === 2) { failed++; console.log(`  embed fail ${c.id}: ${e.message?.slice(0, 100)}`); }
        else await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    if (++done % 100 === 0) console.log(`  embedded ${done}/${chunks.length}`);
  }
};
await Promise.all(Array.from({ length: 8 }, worker));
if (failed) { console.log(`${failed} failed; kb/chunks.json left unchanged`); process.exit(1); }
if (!Array.isArray(data)) data.embedModel = model;
fs.writeFileSync(file, JSON.stringify(data));
console.log(`re-embedded ${chunks.length} passages with ${model}`);
