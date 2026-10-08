// The whiteboard's rules live here (same idea as SayMei's toBoardCommand): the model sends
// meaning only — a note, a code snippet, the steps of a flow — and the browser does layout.
// Anything malformed is dropped instead of breaking the meeting.
const MAX = { title: 60, text: 260, step: 64, item: 96, code: 1100, lang: 20 };
const TONES = new Set(["info", "warning", "correction", "success"]);

function clean(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanCode(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/\r/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

const list = (v) => (Array.isArray(v) ? v : []);

export function toBoardItem(a, id) {
  if (!a || typeof a !== "object") return null;
  const title = clean(a.title, MAX.title);
  switch (a.type) {
    case "text": {
      const text = clean(a.text, MAX.text);
      return text ? { id, type: "text", title, text } : null;
    }
    case "note": {
      const text = clean(a.text, MAX.text);
      if (!text) return null;
      return { id, type: "note", title, text, tone: TONES.has(a.tone) ? a.tone : "info" };
    }
    case "code": {
      const code = cleanCode(a.code, MAX.code);
      if (!code) return null;
      return { id, type: "code", title, code, language: clean(a.language, MAX.lang) || "text" };
    }
    case "flow": {
      const steps = list(a.steps).map((s) => clean(s, MAX.step)).filter(Boolean).slice(0, 6);
      return steps.length >= 2 ? { id, type: "flow", title, steps } : null;
    }
    case "checklist": {
      const items = list(a.items).map((s) => clean(s, MAX.item)).filter(Boolean).slice(0, 8);
      return items.length ? { id, type: "checklist", title, items } : null;
    }
    default:
      return null;
  }
}

/** JSON schema for the board actions the model may return alongside an answer. */
export const BOARD_SCHEMA = {
  type: "array",
  maxItems: 3,
  items: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["text", "note", "code", "flow", "checklist"] },
      title: { type: "string" },
      text: { type: "string" },
      tone: { type: "string", enum: ["info", "warning", "correction", "success"] },
      language: { type: "string" },
      code: { type: "string" },
      steps: { type: "array", items: { type: "string" } },
      items: { type: "array", items: { type: "string" } },
    },
    required: ["type"],
  },
};

export const BOARD_GUIDE = `WHITEBOARD (only the CSM sees it): add 0-2 visual aids when a picture helps the CSM explain, never for chit-chat.
- flow: 3-4 steps of a pipeline or setup sequence. Each step is a short label, optionally followed by " | " and a 2-4 word caption, e.g. ["Your app | instrument your service","arize-otel | sends OpenTelemetry spans","Arize AX | traces, evals, insights"].
- code: a minimal, correct snippet (max ~12 lines) copied from the docs excerpts, with language.
- checklist: setup steps or next steps, max 6 items.
- note: one sentence; tone "correction" for a fix, "warning" for a gotcha, "info" otherwise.
- text: a short definition or comparison.
Send meaning only; the app does layout. Never invent package names, env vars or limits that are not in the excerpts.`;
