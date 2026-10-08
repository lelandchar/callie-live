# Callie Live Assistant

A working prototype of a private, real-time assistant for customer calls, built as a product case for Calendly Labs. While a customer success manager (CSM) talks, Callie listens on their side of the call and helps only them:

- **Answers**: the line to say in plain English, a checklist or diagram, the sources, and a step-by-step email sent with one click.
- **Fact-checks**: catches a wrong claim (yours, a teammate's or the customer's) and gives you a graceful line to correct it.
- **Coaching**: notices when the customer sounds confused, skeptical or nervous, and suggests the next move.

**Live demo:** https://callie-live-production.up.railway.app (up until October 15, 2026). Watch the four-minute recorded call, or click **Start live call → Join with text chat** to talk to Grace, an AI customer.

> Concept prototype for an interview case. Not a Calendly or Arize product and not affiliated with either. Cartwell and its people are fictional; answers come from Arize's public documentation.

## How it works

| Piece | What it does |
|---|---|
| The simulated meeting | A LiveKit Cloud room. Grace (the customer) and Julian (an Arize solutions engineer) are AI: Gemini 3.8 Live voices with Spatius avatars, run by a Python LiveKit Agents worker (`agent/`). |
| Hearing the call | The browser taps the call's audio (standing in for a desktop app that would hear your computer's sound), split into utterances by voice activity detection. |
| Understanding | Gemini 3.8 Flash transcribes each utterance and labels it: a question, a claim worth checking, a request to Callie, or conversation, plus the customer's tone. |
| Finding the right page | Hybrid search over 892 passages from Arize's docs: BM25 keyword search blended 40/60 with Gemini Embedding 2, top six passages (at most two per page), plus admin-verified key facts. |
| Answers, checks, coaching | Gemini 3.8 Flash with structured output, two requests racing so a slow one never holds a card back. |
| The panel | A message thread: what was said on the left, Callie's reply on the right, opening with the meeting brief from the Calendly booking. |
| The recorded call | A scripted two-person call voiced with Gemini 3.8 Flash TTS; each avatar speaks its own audio in Spatius direct mode, and every card in it is Callie's live output. |

## Run it locally

```bash
npm install
npm run build:call          # the browser bundle for the video call (web/ → public/call/)
npm run ingest              # crawl Arize docs and build kb/chunks.json (needs GEMINI_API_KEY)
node server.js              # http://localhost:4317
```

The AI customer runs as a LiveKit agent: `cd agent && uv sync && uv run agent.py dev` (or `agent/run-local.sh`).

Environment (`.env`): `GEMINI_API_KEY`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `SPATIUS_APP_ID`, `SPATIUS_API_KEY`. Optional: `CALLIE_DEMO_INBOX` (emails go only to plus-aliases of this inbox), `RESEND_API_KEY` and `RESEND_FROM` (sending from the hosted copy), `README_PASSWORD`.

## Code map

- `server.js`: HTTP and WebSocket server, the listen → answer / check / coach loop, LiveKit tokens and agent dispatch.
- `lib/brain.js`: every Gemini prompt. `lib/kb.js`: hybrid retrieval. `lib/vad.js`: utterance splitting.
- `kb/scenarios/*.json`: the call scenarios (persona, account context, verified key facts).
- `public/`: the overview page and the call screen. `web/src/call.js`: the LiveKit and Spatius browser bundle.
- `agent/agent.py`: the AI customer and teammate (Gemini Live + Spatius).
- `scripts/`: end-to-end tests (`text-e2e.mjs`, `call-e2e.mjs`), the call recorder (`record-call.mjs`) and voice generation (`make-call-voices.mjs`).

Built by Leland Char with Claude Code.
