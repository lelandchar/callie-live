// Callie's brain: every Gemini call the copilot makes, with the prompts that keep it grounded.
// listen  -> gemini-3.5-flash-lite hears one utterance and says what kind of moment it is
// answer  -> gemini-3.8-flash answers a customer question from the Arize docs + account notes
// check   -> gemini-3.8-flash fact-checks something the CSM just claimed
// speak   -> gemini-3.8-flash-lite-tts turns a whisper into audio only the CSM hears
import { GoogleGenAI } from "@google/genai";
import { BOARD_GUIDE, BOARD_SCHEMA } from "./board.js";

export const MODELS = {
  listen: process.env.CALLIE_LISTEN_MODEL || "gemini-3.5-flash-lite",
  think: process.env.CALLIE_THINK_MODEL || "gemini-3.8-flash",
  voice: process.env.CALLIE_VOICE_MODEL || "gemini-3.8-flash-lite-tts",
  embed: "gemini-embedding-001",
};

const DOMAIN_WORDS =
  "Arize, Arize AX, Phoenix, Alyx, OpenInference, OpenTelemetry, OTel, OTLP, LangChain, LangGraph, LlamaIndex, CrewAI, " +
  "OpenAI Agents SDK, Vercel AI SDK, Bedrock, spans, traces, sessions, evals, LLM-as-a-judge, datasets, experiments, " +
  "prompt playground, space ID, API key, arize-otel, register, BatchSpanProcessor, SSO, RBAC, SOC 2, HIPAA, PII";

const LISTEN_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    kind: { type: "string", enum: ["question", "claim", "ask_callie", "other"] },
    focus: { type: "string" },
    tone: { type: "string", enum: ["neutral", "confused", "frustrated", "skeptical", "excited", "hesitant"] },
  },
  required: ["text", "kind", "tone"],
};

const COACH_SCHEMA = {
  type: "object",
  properties: {
    nudge: { type: "string" },
    say: { type: "string" },
    show: { type: "string" },
  },
  required: ["nudge"],
};

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    detail: { type: "array", items: { type: "string" }, maxItems: 4 },
    sources: { type: "array", items: { type: "string" }, maxItems: 3 },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    private_note: { type: "string" },
    whisper: { type: "string" },
    send_label: { type: "string" },
    board: BOARD_SCHEMA,
  },
  required: ["answer", "confidence"],
};

const CHECK_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["supported", "contradicted", "unclear"] },
    correction: { type: "string" },
    say_instead: { type: "string" },
    whisper: { type: "string" },
    severity: { type: "string", enum: ["high", "medium", "low"] },
    sources: { type: "array", items: { type: "string" }, maxItems: 3 },
    board: BOARD_SCHEMA,
  },
  required: ["verdict", "severity"],
};

const EMAIL_SCHEMA = {
  type: "object",
  properties: { subject: { type: "string" }, body: { type: "string" } },
  required: ["subject", "body"],
};

const SHARE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    steps: { type: "array", items: { type: "string" }, maxItems: 6 },
    code: { type: "string" },
    language: { type: "string" },
    links: {
      type: "array",
      maxItems: 4,
      items: { type: "object", properties: { title: { type: "string" }, url: { type: "string" } }, required: ["title", "url"] },
    },
  },
  required: ["title", "summary"],
};

export class Brain {
  constructor({ apiKey, kb, account, facts }) {
    this.ai = new GoogleGenAI({ apiKey });
    this.kb = kb;
    this.account = account;
    this.facts = facts;
    this.embedCache = new Map();
  }

  get csm() {
    return this.account.csm.name;
  }

  get role() {
    return `${this.account.csm.name}, ${this.account.csm.title}`;
  }

  get vendor() {
    return this.account.vendor || "the product";
  }

  get kbLabel() {
    return (this.account.kbName || "docs").toUpperCase();
  }

  accountNotes() {
    const a = this.account;
    return [
      `Customer: ${a.company} (${a.industry}). Plan: ${a.plan}. Goal: ${a.goal}.`,
      `Stack: ${a.stack.join(", ")}.`,
      `On this call: ${a.attendees.map((p) => `${p.name} (${p.role})`).join(", ")}.`,
      `Last call: ${a.lastCall}`,
      `Open items: ${a.openItems.join("; ")}.`,
      `Internal only, never say aloud: ${a.internalOnly.join("; ")}.`,
    ].join("\n");
  }

  async json(model, contents, schema, thinkingLevel) {
    const config = { responseMimeType: "application/json", responseJsonSchema: schema };
    if (thinkingLevel) config.thinkingConfig = { thinkingLevel };
    const res = await this.ai.models.generateContent({ model, contents, config });
    return JSON.parse(res.text);
  }

  async embed(text) {
    const key = text.slice(0, 500);
    if (this.embedCache.has(key)) return this.embedCache.get(key);
    const r = await this.ai.models.embedContent({
      model: MODELS.embed,
      contents: text,
      config: { taskType: "RETRIEVAL_QUERY", outputDimensionality: 768 },
    });
    const v = r.embeddings[0].values;
    this.embedCache.set(key, v);
    return v;
  }

  async retrieve(query) {
    const hits = await this.kb.search(query, { embed: (q) => this.embed(q), k: 6 });
    const block = hits
      .map((c, i) => `[${i + 1}] ${c.title} — ${c.heading} (${c.url})\n${c.text.slice(0, 1500)}`)
      .join("\n\n");
    return { hits, block };
  }

  /** One utterance in, transcript + what kind of moment it is out. */
  /** One utterance in, what kind of moment it is out. `input` is WAV audio, or { text } when the CSM typed it. */
  async listen(input, speaker, recent) {
    const typed = typeof input?.text === "string";
    const prompt = `You are the ears of Callie, a private copilot for ${this.role}, during a live call with ${this.account.company}.
The ${typed ? "message below" : "audio"} is ONE utterance ${typed ? "typed into the call" : "spoken"} by ${speaker === "CSM" ? `the CSM (${this.csm})` : "the customer"}.${typed ? `\nUTTERANCE: ${input.text}` : ""}
Words you may hear: ${this.account.vocabulary || DOMAIN_WORDS}.
Recent conversation:
${recent || "(start of call)"}

Return JSON:
- text: ${typed ? "the utterance, unchanged" : `exact transcript of the audio ("" if there is no intelligible speech)`}
- kind:
  question = the customer asks something product docs or account notes can answer
  claim = the CSM states a fact about ${this.vendor} (plans, pricing, limits, retention, features, setup steps, security, compatibility, strategy, metrics)
  ask_callie = the CSM speaks to Callie directly ("Callie, ...")
  other = anything else (greetings, the CSM asking the customer something, small talk)
- focus: the question or claim rewritten to stand alone, resolving "it/that" from context ("" for other)
- tone: how the speaker sounds from their voice and words: neutral | confused | frustrated | skeptical | excited | hesitant`;
    const parts = typed ? [{ text: prompt }] : [{ inlineData: { mimeType: "audio/wav", data: input.toString("base64") } }, { text: prompt }];
    return this.json(MODELS.listen, [{ role: "user", parts }], LISTEN_SCHEMA, "minimal");
  }

  /** Answer a question the customer (or the CSM, privately) asked. */
  async answer(question, { asker, recent, notesShared = [] }) {
    const { hits, block } = await this.retrieve(question);
    const prompt = `You are Callie, a private copilot for ${this.role}, live on a call with ${this.account.company}. Only ${this.csm} sees your output.

ACCOUNT NOTES
${this.accountNotes()}

VERIFIED KEY FACTS
${this.facts}

${this.kbLabel} EXCERPTS
${block}

RECENT CONVERSATION
${recent || "(start of call)"}

QUESTION from ${asker}: ${question}

Answer ONLY from the key facts, docs excerpts and account notes. If they don't cover it, say what you'd check and set confidence low. Never put internal-only notes in the answer.
Return JSON:
- answer: what ${this.csm} can say out loud, max 30 words, plain spoken English, no markdown
- detail: up to 4 short bullets with specifics (packages, env vars, limits, steps)
- sources: urls of the excerpts you used, max 3
- confidence: high | medium | low
- private_note: almost always "". Only when an internal-only note directly bears on THIS question (plan limits, pricing, SSO, upgrades) give one sentence for ${this.csm}'s eyes only. Never repeat something already shared: ${notesShared.length ? notesShared.join(" | ") : "(nothing shared yet)"}
- whisper: the single key fact as a private audio cue, max 12 words ("Use using_session with a session ID per conversation.")
- send_label: what ${this.csm} could send the customer about this right now, as a 3-7 word action naming the asker by first name and the thing itself, e.g. "Email Grace the masking guide" or "Email Grace the setup snippet"
- board: visual aids, may be []
${BOARD_GUIDE}`;
    const out = await this.json(MODELS.think, [{ role: "user", parts: [{ text: prompt }] }], ANSWER_SCHEMA, "low");
    return { ...out, sources: this.resolveSources(out.sources, hits) };
  }

  /** Fact-check a claim the CSM just made out loud. */
  async check(claim, { recent, byCustomer = false }) {
    const { hits, block } = await this.retrieve(claim);
    const prompt = `You are Callie, a private copilot for ${this.role}, live on a call with ${this.account.company}.
${byCustomer ? `The CUSTOMER just said: "${claim}" (if it's a misconception, ${this.csm} should gently clarify; say_instead is what ${this.csm} can say to clarify)` : `${this.csm} just said: "${claim}"`}

VERIFIED KEY FACTS
${this.facts}

${this.kbLabel} EXCERPTS
${block}

RECENT CONVERSATION
${recent || "(start of call)"}

Check the claim against the key facts and excerpts. Be strict: "contradicted" only if they clearly say something different; "unclear" if they don't cover it.
Return JSON:
- verdict: supported | contradicted | unclear
- correction: the accurate statement, max 20 words ("" if supported)
- say_instead: one graceful sentence ${this.csm} can say to correct course ("" if supported)
- whisper: a private audio cue, max 9 words, e.g. "Pro retention is 30 days, not 90." ("" if supported)
- severity: high (plans, pricing, limits, retention, security, compliance, data handling) | medium (setup, compatibility) | low
- sources: urls used, max 3
- board: [] unless contradicted; then one note with tone "correction"`;
    const out = await this.json(MODELS.think, [{ role: "user", parts: [{ text: prompt }] }], CHECK_SCHEMA, "low");
    return { ...out, sources: this.resolveSources(out.sources, hits) };
  }

  /** Private coaching when the customer's tone shifts (confused, frustrated, skeptical, hesitant). */
  async coach({ tone, text, recent }) {
    const prompt = `You coach ${this.role}, privately during a live call with ${this.account.company}.
The customer just sounded ${tone}: "${text}"
Recent conversation:
${recent || "(start of call)"}
Account notes:
${this.accountNotes()}
Return JSON:
- nudge: what ${this.csm} should do next, max 14 words, imperative ("Slow down and show it on the board.")
- say: one sentence ${this.csm} could say right now, max 22 words, warm and specific
- show: optional thing to put on screen (a diagram, a snippet, a doc page), max 8 words, or ""`;
    return this.json(MODELS.listen, [{ role: "user", parts: [{ text: prompt }] }], COACH_SCHEMA, "minimal");
  }

  async draftEmail({ topic, answer, detail, sources }, { contactName } = {}) {
    const first = (n) => (n || "").split(" ")[0].toLowerCase();
    const contact =
      (contactName && this.account.attendees.find((p) => first(p.name) === first(contactName))) ||
      this.account.attendees.find((p) => p.email) ||
      this.account.attendees[0];
    // The email is a guide the customer can follow on their own after the call, so it gets the
    // same doc excerpts as an answer, not just the one-line answer.
    const { block } = await this.retrieve(`${topic} ${answer || ""}`);
    const prompt = `Write the follow-up email ${this.csm} (${this.account.csm.title}) sends ${contact.name} (${contact.role || "customer"}) at ${this.account.company} while they are still on a live call. It should let ${contact.name.split(" ")[0]} do the work on their own afterwards without needing another call.

WHAT THEY ASKED: ${topic}
WHAT WE SAID ON THE CALL: ${answer}
SPECIFICS WE MENTIONED: ${(detail || []).join(" | ") || "(none)"}
THEIR STACK: ${(this.account.stack || []).join(", ")}
THEIR GOAL: ${this.account.goal || ""}
VERIFIED KEY FACTS:
${this.facts}
${this.kbLabel} EXCERPTS:
${block}
DOC LINKS YOU MAY USE: ${(sources || []).map((s) => s.url).join(" , ") || "(only links that appear in the excerpts)"}

Write it like a senior customer success manager who wants them to succeed: warm, concrete, written for an engineer.
Structure, in plain text with real line breaks (no markdown symbols like ** or #):
1. Greeting line, blank line, then two or three sentences that recap what they asked and the short answer.
2. A line that says what they'll have working at the end.
3. Numbered steps, usually 4 to 7. Each step says what to do, gives the exact command, setting or code when there is one (code indented by four spaces on its own lines, copied from the excerpts, adapted to their stack), and one sentence on why it matters or what they should see.
4. "How to check it worked:" one or two lines describing what success looks like (for example where the traces appear).
5. "Things to watch for:" one to three short gotchas, only ones the excerpts support.
6. "Docs:" each link on its own line with a few words saying what it covers.
7. A closing line with a concrete next step or an offer (tie it to their timeline when it matters), a blank line, then sign off as ${this.csm.split(" ")[0]}.
Length: 250 to 450 words. Use only facts from the key facts and excerpts; never invent package names, environment variables, limits or links. Never mention internal-only notes.
Return JSON {subject, body}. The subject names the outcome, for example "Step-by-step: LangGraph traces into Arize AX".`;
    const out = await this.json(MODELS.think, [{ role: "user", parts: [{ text: prompt }] }], EMAIL_SCHEMA, "low");
    return { to: contact.email, toName: contact.name, ...out };
  }
  async sharePage({ topic, answer, detail, sources }) {
    const { block } = await this.retrieve(topic);
    const prompt = `Create a one-page guide that ${this.csm} (${this.account.csm.title}) can screen-share right now or send to ${this.account.company}.
Topic: ${topic}
What we said: ${answer}
Specifics: ${(detail || []).join(" | ")}
Their stack: ${this.account.stack.join(", ")}
Docs excerpts:
${block}
Rules: use only facts from the excerpts; steps are imperative and short; code (optional) is minimal and copied from the excerpts; links come from the excerpts.
Return JSON {title, summary, steps, code, language, links}.`;
    const out = await this.json(MODELS.think, [{ role: "user", parts: [{ text: prompt }] }], SHARE_SCHEMA, "low");
    const known = new Set((sources || []).map((s) => s.url));
    out.links = (out.links || []).filter((l) => known.has(l.url) || (this.account.linkDomains || []).some((d) => l.url?.startsWith(d)));
    return out;
  }

  /** A short private audio cue for the CSM's ears only. Returns base64 PCM16 at 24 kHz. */
  async speak(text) {
    const res = await this.ai.models.generateContent({
      model: MODELS.voice,
      contents: [{ role: "user", parts: [{ text: `Say quietly and quickly, like a colleague whispering a reminder: ${text}` }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.CALLIE_VOICE || "Kore" } } },
      },
    });
    const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part) throw new Error("no audio returned");
    return { data: part.inlineData.data, mimeType: part.inlineData.mimeType || "audio/L16;rate=24000" };
  }

  resolveSources(urls, hits) {
    const byUrl = new Map(hits.map((h) => [h.url, h]));
    const seen = new Set();
    const out = [];
    for (const u of urls || []) {
      const h = byUrl.get(u) || hits.find((x) => u && x.url.startsWith(u.replace(/\.md$/, "")));
      const url = h ? h.url : u;
      if (!url || seen.has(url) || !/^https?:\/\//.test(url)) continue;
      seen.add(url);
      out.push({ url, title: h ? h.title : url.replace(/^https?:\/\/[^/]+\//, "") });
    }
    return out;
  }
}
