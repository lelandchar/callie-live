// Print what happened in each chapter of a filmed call (who said what, which cards Callie showed),
// so the homepage breakdown can be written from the real events.
//   node scripts/breakdown.mjs [public/media/callie-live-call]
import fs from "node:fs";

const base = process.argv[2] || "public/media/callie-live-call";
const meta = JSON.parse(fs.readFileSync(`${base}.json`, "utf8"));
const ev = JSON.parse(fs.readFileSync(`${base}.events.json`, "utf8"));
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const chapters = meta.chapters;
const cards = ev.cards.filter((c) => c.status !== "thinking").sort((a, b) => a.t - b.t);
const lines = ev.convo.sort((a, b) => a.t - b.t);

for (const [i, c] of chapters.entries()) {
  const end = chapters[i + 1]?.t ?? Infinity;
  console.log(`\n=== ${i + 1}. ${fmt(c.t)} ${c.title}`);
  for (const l of lines.filter((x) => x.t >= c.t - 1 && x.t < end - 1)) console.log(`   ${fmt(l.t)} ${l.who}: ${l.text.slice(0, 150)}`);
  for (const k of cards.filter((x) => x.t >= c.t - 1 && x.t < end - 1)) {
    const kind = k.type === "check" ? (k.clarify ? "clarify" : "check") : k.type;
    console.log(`   ${fmt(k.t)} [${kind}${k.latencyMs ? ` ${(k.latencyMs / 1000).toFixed(1)}s` : ""}] ${k.text}${k.sendLabel ? `  (send: ${k.sendLabel})` : ""}${k.sayInstead ? `  (say: ${k.sayInstead})` : ""}`);
  }
}
