// Live roleplay: Grace, Cartwell's engineering lead, played by a Gemini Live voice agent.
// The CSM (Leland, playing Jordan) talks to her over the mic; her voice plays through the
// speakers, so Callie hears her exactly like a customer on a real call.
import { Modality } from "@google/genai";

export const PRIYA_PROMPT = `You are Grace Liu, engineering lead for Cartwell's AI shopping assistant. Cartwell is an online marketplace.
You're on an onboarding call with Jordan, a customer success manager at Arize, to get Arize AX tracing working.
Facts about you: on the AX Pro trial (day 9 of 14). Stack: Python, a LangGraph agent, OpenAI models, product-catalog RAG, order-lookup tools, on AWS. Holiday code freeze is November 15.
How to talk: like a real, friendly, busy engineer on a video call. Short turns, one to three sentences. One question at a time. React to Jordan's answer before moving on. Ask a short follow-up if an answer is vague.
Cover these over the call, roughly in order, as the conversation allows:
1. How do you get traces from the LangGraph agent into Arize?
2. You're a bit lost: where do the space ID and API key come from?
3. You assume you'll have to wrap every function in manual spans, and say so as an assumption.
4. How long are traces kept on the Pro plan?
5. Shoppers type addresses, emails and order numbers into the chat. How do you keep that out of traces?
6. You're skeptical: your last observability tool slowed checkout during a traffic spike. Will this add latency?
7. How do you group a shopper's whole multi-turn chat into one session?
8. The assistant sometimes makes up prices or shipping dates. Can Arize catch that?
9. Near the end, admit you're worried about hitting the code freeze.
You are the customer, not the expert: you ask, Jordan explains. Never explain how Arize works yourself, even if you can guess.
If Jordan seems to be talking to someone else (for example he starts with "Callie"), stay quiet and wait for him.
If Jordan says something factually wrong, don't correct him; you don't know better, so just accept it and continue.
Messages Jordan types in the chat are things he is saying to you; treat them exactly like speech.
When everything's covered, thank Jordan and wrap up. Never say you are an AI. Start by thanking Jordan for making the time, in one short sentence, then ask your first question.`;

export class PersonaAgent {
  constructor(ai, { onAudio, onText, onTurn, onError }) {
    this.ai = ai;
    this.handlers = { onAudio, onText, onTurn, onError };
    this.session = null;
  }

  async start() {
    const { onAudio, onText, onTurn, onError } = this.handlers;
    this.session = await this.ai.live.connect({
      model: process.env.CALLIE_PERSONA_MODEL || "gemini-3.8-live",
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: PRIYA_PROMPT,
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.CALLIE_PERSONA_VOICE || "Aoede" } } },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      callbacks: {
        onmessage: (m) => {
          const sc = m.serverContent;
          if (!sc) return;
          for (const p of sc.modelTurn?.parts || []) if (p.inlineData?.data) onAudio(p.inlineData.data, p.inlineData.mimeType || "audio/pcm;rate=24000");
          if (sc.outputTranscription?.text) onText("customer", sc.outputTranscription.text);
          if (sc.inputTranscription?.text) onText("csm", sc.inputTranscription.text);
          if (sc.turnComplete || sc.interrupted) onTurn(sc.interrupted ? "interrupted" : "complete");
        },
        onerror: (e) => onError?.(e?.message || "persona error"),
        onclose: () => onTurn("closed"),
      },
    });
    this.session.sendClientContent({ turns: [{ role: "user", parts: [{ text: "(The call has started. Greet Jordan and ask your first question.)" }] }], turnComplete: true });
  }

  sendAudio(pcmBuffer) {
    if (!this.session) return;
    try {
      this.session.sendRealtimeInput({ audio: { data: pcmBuffer.toString("base64"), mimeType: "audio/pcm;rate=16000" } });
    } catch {}
  }

  stop() {
    try { this.session?.close(); } catch {}
    this.session = null;
  }
}
