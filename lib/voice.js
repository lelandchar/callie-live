// Callie's private voice: a short Gemini 3.8 Live turn per whisper. Audio streams back as
// 24 kHz PCM chunks within ~0.6 s, and the browser plays them as they arrive.
import { Modality } from "@google/genai";

const SYSTEM = "You are Callie, whispering short reminders to a colleague who is on a live customer call. When asked to say a line, say exactly that line, quietly and quickly, with nothing added before or after.";

export class LiveVoice {
  constructor(ai, { model = process.env.CALLIE_LIVE_MODEL || "gemini-3.8-live", voice = process.env.CALLIE_VOICE || "Kore" } = {}) {
    this.ai = ai;
    this.model = model;
    this.voice = voice;
  }

  /** Streams audio chunks for one line through onAudio(base64Pcm, mimeType). Resolves when done. */
  say(text, { onAudio }) {
    return new Promise((resolve, reject) => {
      let session = null;
      let finished = false;
      let gotAudio = false;
      const finish = (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { session?.close(); } catch {}
        if (err && !gotAudio) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => finish(gotAudio ? null : new Error("live voice timed out")), 15000);
      this.ai.live
        .connect({
          model: this.model,
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction: SYSTEM,
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
          },
          callbacks: {
            onmessage: (m) => {
              for (const p of m.serverContent?.modelTurn?.parts || []) {
                if (p.inlineData?.data) {
                  gotAudio = true;
                  onAudio(p.inlineData.data, p.inlineData.mimeType || "audio/pcm;rate=24000");
                }
              }
              if (m.serverContent?.turnComplete) finish();
            },
            onerror: (e) => finish(new Error(e?.message || "live voice error")),
            onclose: () => finish(gotAudio ? null : new Error("live voice closed")),
          },
        })
        .then((s) => {
          session = s;
          if (finished) { try { s.close(); } catch {} return; }
          s.sendClientContent({ turns: [{ role: "user", parts: [{ text: `Say: ${text}` }] }], turnComplete: true });
        })
        .catch((e) => finish(e));
    });
  }
}
