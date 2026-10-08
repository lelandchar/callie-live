import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GoogleGenAI, Modality } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "callie-"));
execFileSync("say", ["-v", "Samantha", "-o", path.join(dir, "u.aiff"), "Can we group a user's back and forth with the bot into one session?"]);
execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", path.join(dir, "u.aiff"), path.join(dir, "u.wav")]);
const wav = fs.readFileSync(path.join(dir, "u.wav")).toString("base64");
const audioPart = { inlineData: { mimeType: "audio/wav", data: wav } };

async function timeit(label, fn) {
  const s = performance.now();
  try { const r = await fn(); console.log(label, Math.round(performance.now() - s) + "ms", String(r).slice(0, 140)); }
  catch (e) { console.log(label, "ERROR", e.message?.slice(0, 200)); }
}

for (let i = 0; i < 2; i++) {
  await timeit(`transcribe#${i}`, async () => (await ai.models.generateContent({ model: "gemini-3.5-transcribe", contents: [{ role: "user", parts: [audioPart] }] })).text);
  await timeit(`flashlite-plain#${i}`, async () => (await ai.models.generateContent({ model: "gemini-3.5-flash-lite", contents: [{ role: "user", parts: [audioPart, { text: "Transcribe exactly. Output only the transcript." }] }], config: { thinkingConfig: { thinkingLevel: "minimal" } } })).text);
}
await timeit("classify-text", async () => (await ai.models.generateContent({ model: "gemini-3.5-flash-lite", contents: [{ role: "user", parts: [{ text: 'Classify this customer utterance as question/claim/other and restate it standalone. JSON {"kind":"","focus":""}. Utterance: "Can we group a user\'s back and forth with the bot into one session?"' }] }], config: { responseMimeType: "application/json", thinkingConfig: { thinkingLevel: "minimal" } } })).text);

// Live API: text in -> audio out, measuring time to first audio chunk.
await new Promise(async (resolve) => {
  const s = performance.now();
  let first = 0, bytes = 0;
  const session = await ai.live.connect({
    model: "gemini-3.8-live",
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: "You are Callie, whispering short reminders to a colleague. When asked to say a line, say exactly that line, quietly and quickly, with nothing added.",
    },
    callbacks: {
      onopen: () => console.log("live open", Math.round(performance.now() - s) + "ms"),
      onmessage: (m) => {
        for (const p of m.serverContent?.modelTurn?.parts || []) {
          if (p.inlineData?.data) { if (!first) { first = performance.now(); console.log("live first-audio", Math.round(first - t0) + "ms", p.inlineData.mimeType); } bytes += p.inlineData.data.length * 0.75; }
        }
        if (m.serverContent?.turnComplete) { console.log("live turn complete", Math.round(performance.now() - t0) + "ms", Math.round(bytes / 1024) + "KB"); session.close(); resolve(); }
      },
      onerror: (e) => { console.log("live error", e.message); resolve(); },
      onclose: (e) => { if (!first) { console.log("live closed", e?.reason || ""); resolve(); } },
    },
  });
  var t0 = performance.now();
  session.sendClientContent({ turns: [{ role: "user", parts: [{ text: "Say: Pro retention is thirty days, not ninety." }] }], turnComplete: true });
  setTimeout(() => { console.log("live timeout"); try { session.close(); } catch {} resolve(); }, 15000);
});
