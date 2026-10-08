// Hybrid retrieval over the ingested Arize docs: BM25 for exact terms (OTLP, ARIZE_SPACE_ID)
// plus Gemini embeddings for paraphrased questions ("hide patient data" -> masking).
import fs from "node:fs";

const STOP = new Set("a an and are as at be by can do does for from how i if in is it its me my of on or our so that the their them then there these this to us we what when where which who why will with you your".split(" "));

export class KnowledgeBase {
  constructor(fileOrChunks) {
    this.chunks = Array.isArray(fileOrChunks) ? fileOrChunks : fs.existsSync(fileOrChunks) ? JSON.parse(fs.readFileSync(fileOrChunks, "utf8")) : [];
    this.k1 = 1.4;
    this.b = 0.75;
    this.index();
  }

  tokenize(s) {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9_.\-]+/g, " ")
      .split(" ")
      .map((t) => t.replace(/^[.\-]+|[.\-]+$/g, ""))
      .filter((t) => t.length > 1 && !STOP.has(t));
  }

  index() {
    this.df = new Map();
    this.docs = this.chunks.map((c) => {
      const toks = this.tokenize(`${c.title} ${c.heading} ${c.heading} ${c.text}`);
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
      return { len: toks.length, tf };
    });
    this.avgdl = this.docs.reduce((n, d) => n + d.len, 0) / Math.max(1, this.docs.length);
    this.norms = this.chunks.map((c) => (c.embedding ? Math.hypot(...c.embedding) : 0));
  }

  bm25(query) {
    const q = [...new Set(this.tokenize(query))];
    const N = this.docs.length;
    return this.docs.map((d) => {
      let s = 0;
      for (const t of q) {
        const f = d.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t);
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        s += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / this.avgdl));
      }
      return s;
    });
  }

  async search(query, { embed, k = 6 } = {}) {
    if (!this.chunks.length) return [];
    const bm = this.bm25(query);
    const bmMax = Math.max(...bm, 1e-9);
    let cos = null;
    if (embed) {
      try {
        const v = await embed(query);
        const vn = Math.hypot(...v);
        cos = this.chunks.map((c, i) => {
          if (!c.embedding || !this.norms[i]) return 0;
          let dot = 0;
          for (let j = 0; j < v.length; j++) dot += v[j] * c.embedding[j];
          return dot / (vn * this.norms[i]);
        });
      } catch {
        cos = null;
      }
    }
    const cosMin = cos ? Math.min(...cos) : 0;
    const cosMax = cos ? Math.max(...cos) : 1;
    const scored = this.chunks.map((c, i) => {
      const b = bm[i] / bmMax;
      const e = cos ? (cos[i] - cosMin) / Math.max(1e-9, cosMax - cosMin) : 0;
      return { c, score: cos ? 0.4 * b + 0.6 * e : b };
    });
    scored.sort((a, b) => b.score - a.score);
    const perUrl = new Map();
    const out = [];
    for (const s of scored) {
      const n = perUrl.get(s.c.url) || 0;
      if (n >= 2) continue;
      perUrl.set(s.c.url, n + 1);
      out.push(s.c);
      if (out.length >= k) break;
    }
    return out;
  }
}
