// Downloads a curated set of public Arize AX docs pages (agent-readable .md versions),
// splits them into heading-sized chunks, and embeds each chunk for retrieval.
// Run: npm run ingest   (needs GEMINI_API_KEY in .env for embeddings; chunks work without it)
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RAW = path.join(ROOT, "kb", "raw");
const BASE = "https://arize.com/docs/ax/";

const PAGES = [
  "../ax.md",
  "get-started/get-started-tracing.md",
  "get-started/get-started-evaluations.md",
  "get-started/get-started-improve-your-agent.md",
  "set-up-with-ai-assistants.md",
  "skills/overview.md",
  "alyx.md",
  "evaluate/human-review.md",
  "evaluate/align-evals-to-human-feedback.md",
  "evaluate/create-evaluators.md",
  "observe/dashboards.md",
  "observe/production-monitoring/alerting-integrations/slack.md",
  "instrument/what-are-traces.md",
  "instrument/set-up-tracing.md",
  "instrument/manual-instrumentation.md",
  "instrument/customize-your-traces.md",
  "instrument/track-costs.md",
  "instrument/set-up-sessions.md",
  "instrument/combining-auto-and-manual.md",
  "instrument/configure-your-tracer.md",
  "instrument/graduate-from-phoenix.md",
  "instrument/mask-and-redact-data.md",
  "instrument/advanced-patterns.md",
  "observe/production-monitoring.md",
  "observe/tracing/view-and-manage-traces.md",
  "evaluate/what-are-evals.md",
  "evaluate/evaluators/llm-as-a-judge.md",
  "evaluate/run-evals-on-traces.md",
  "evaluate/trace-and-session-evals.md",
  "evaluate/results-and-costs.md",
  "improve/build-a-dataset.md",
  "improve/code-experiments.md",
  "improve/prompt-playground.md",
  "improve/ci-cd-for-automated-experiments.md",
  "security-and-settings/api-keys.md",
  "security-and-settings/pricing-and-usage.md",
  "security-and-settings/space-rate-limiting.md",
  "security-and-settings/sso-and-rbac.md",
  "security-and-settings/arize-private-connect.md",
  "security-and-settings/compliance.md",
  "security-and-settings/compliance/delete-traces-with-sensitive-data.md",
  "security-and-settings/whitelisting.md",
  "security-and-settings/data-fabric.md",
  "integrations/opentelemetry/overview.md",
  "integrations/opentelemetry/opentelemetry-arize-otel.md",
  "integrations/llm-providers/openai/openai-tracing.md",
  "integrations/llm-providers/anthropic/anthropic-tracing.md",
  "integrations/llm-providers/google-gen-ai/google-genai-tracing.md",
  "integrations/llm-providers/amazon-bedrock/amazon-bedrock-tracing.md",
  "integrations/llm-providers/litellm/litellm-tracing.md",
  "integrations/python-agent-frameworks/langchain/langchain-tracing.md",
  "integrations/python-agent-frameworks/langgraph/langgraph-tracing.md",
  "integrations/python-agent-frameworks/llamaindex/llamaindex-tracing.md",
  "integrations/python-agent-frameworks/openai-agents/openai-agents-sdk-tracing.md",
  "integrations/python-agent-frameworks/crewai/crewai-tracing.md",
  "integrations/python-agent-frameworks/livekit/livekit-agents-tracing.md",
  "integrations/python-agent-frameworks/model-context-protocol/mcp-tracing.md",
  "integrations/python-agent-frameworks/temporal/temporal-tracing.md",
  "integrations/ts-js-agent-frameworks/langchain/langchain-js.md",
  "integrations/ts-js-agent-frameworks/openai-agents/openai-agents-js.md",
  "integrations/ts-js-agent-frameworks/vercel/vercel-ai-sdk-v6-tracing.md",
  "integrations/ts-js-agent-frameworks/mastra/mastra-tracing.md",
  "integrations/java/langchain4j/langchain4j-tracing.md",
  "cookbooks/instrument/openinference-best-practice.md",
  "graphql-reference/overview/resource-limitations.md",
];

const slug = (p) => p.replace(/^\.\.\//, "").replace(/\.md$/, "").replace(/[^a-z0-9]+/gi, "_");
const pageUrl = (p) => new URL(p, BASE).href.replace(/\.md$/, "");

async function download() {
  await fs.mkdir(RAW, { recursive: true });
  let ok = 0;
  for (const p of PAGES) {
    const url = new URL(p, BASE).href;
    try {
      const res = await fetch(url, { headers: { "user-agent": "callie-live-prototype/0.1" } });
      if (!res.ok) { console.log(`  skip ${res.status} ${p}`); continue; }
      const text = await res.text();
      await fs.writeFile(path.join(RAW, slug(p) + ".md"), `<!-- source: ${pageUrl(p)} -->\n` + text);
      ok++;
    } catch (e) {
      console.log(`  fail ${p}: ${e.message}`);
    }
  }
  console.log(`downloaded ${ok}/${PAGES.length} pages`);
}

function chunkPage(source, text) {
  const lines = text.split("\n");
  const title = (lines.find((l) => /^#\s/.test(l)) || "# " + source).replace(/^#\s+/, "").trim();
  const chunks = [];
  let heading = title;
  let buf = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    if (body.length > 80) {
      // Long sections are split on paragraph boundaries to stay retrieval-sized.
      const paras = body.split(/\n{2,}/);
      let cur = "";
      for (const para of paras) {
        if ((cur + "\n\n" + para).length > 1800 && cur) { chunks.push({ heading, text: cur.trim() }); cur = para; }
        else cur = cur ? cur + "\n\n" + para : para;
      }
      if (cur.trim().length > 80) chunks.push({ heading, text: cur.trim() });
    }
    buf = [];
  };
  let inCode = false;
  for (const line of lines) {
    if (line.startsWith("<!-- source:")) continue;
    if (/^```/.test(line)) inCode = !inCode;
    if (!inCode && /^#{2,3}\s/.test(line)) { flush(); heading = line.replace(/^#+\s+/, "").trim(); continue; }
    buf.push(line);
  }
  flush();
  return chunks.map((c, i) => ({ id: `${slugify(title)}-${i}`, title, heading: c.heading, url: source, text: c.text }));
}
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 48);

async function build() {
  const files = (await fs.readdir(RAW)).filter((f) => f.endsWith(".md"));
  const all = [];
  for (const f of files) {
    const text = await fs.readFile(path.join(RAW, f), "utf8");
    const source = (text.match(/<!-- source: (.+?) -->/) || [])[1] || f;
    all.push(...chunkPage(source, text));
  }
  console.log(`chunked into ${all.length} chunks`);
  const key = process.env.GEMINI_API_KEY;
  if (key) {
    const ai = new GoogleGenAI({ apiKey: key });
    let done = 0;
    const queue = [...all];
    const worker = async () => {
      while (queue.length) {
        const c = queue.shift();
        try {
          const r = await ai.models.embedContent({
            model: "gemini-embedding-001",
            contents: `${c.title} — ${c.heading}\n\n${c.text}`.slice(0, 7000),
            config: { taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: 768 },
          });
          c.embedding = r.embeddings[0].values.map((v) => Math.round(v * 1e5) / 1e5);
        } catch (e) {
          console.log(`  embed fail ${c.id}: ${e.message?.slice(0, 120)}`);
        }
        if (++done % 50 === 0) console.log(`  embedded ${done}/${all.length}`);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
  } else {
    console.log("GEMINI_API_KEY not set: skipping embeddings (keyword search only)");
  }
  await fs.writeFile(path.join(ROOT, "kb", "chunks.json"), JSON.stringify(all));
  console.log(`wrote kb/chunks.json (${all.filter((c) => c.embedding).length} with embeddings)`);
}

if (!process.argv.includes("--no-download")) await download();
await build();
