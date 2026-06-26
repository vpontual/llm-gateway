// Concurrency stress harness for the LLM Gateway proxy.
//
// Fires N parallel workers at the proxy for a bounded duration, recording
// latency + routing decisions per request. Use this to validate that
// routing, warmup, health degradation, and the slot handle API behave
// correctly under real concurrent load.
//
// Safety: low defaults (concurrency=3, duration=30s). Stays polite to the
// live fleet. Override via env vars.

import { setTimeout as delay } from "node:timers/promises";

const PROXY_URL   = (process.env.PROXY_URL   || "http://localhost:11434").replace(/\/$/, "");
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "3", 10);
const DURATION_S  = parseInt(process.env.DURATION_S  || "30", 10);
const MAX_REQUESTS = parseInt(process.env.MAX_REQUESTS || "100", 10);
const KEEP_ALIVE  = process.env.KEEP_ALIVE || "30s";
const TIMEOUT_MS  = parseInt(process.env.TIMEOUT_MS || "180000", 10);
const MODELS      = (process.env.MODELS || "qwen3.5:35b,gemma3:4b,llama3.2:3b")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ENDPOINT    = process.env.ENDPOINT || "/api/generate";
const PROMPT_PREFIX = process.env.PROMPT_PREFIX || "stress-test";
const HEADER_TAG  = `stress-${Date.now().toString(36)}`;

if (MODELS.length === 0) {
  console.error("MODELS env var empty");
  process.exit(1);
}

console.log(`[stress] proxy=${PROXY_URL} endpoint=${ENDPOINT}`);
console.log(`[stress] concurrency=${CONCURRENCY} duration=${DURATION_S}s max=${MAX_REQUESTS} tag=${HEADER_TAG}`);
console.log(`[stress] models=${MODELS.join(",")} keep_alive=${KEEP_ALIVE}`);

const results = [];
const stopAt = Date.now() + DURATION_S * 1000;
let started = 0;

function pickModel(workerId, i) {
  // Deterministic spread: worker i cycles through models offset by i.
  return MODELS[(workerId + i) % MODELS.length];
}

async function fireOne(model) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const reqId = Math.random().toString(36).slice(2, 10);
  try {
    const res = await fetch(`${PROXY_URL}${ENDPOINT}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-stress-tag": HEADER_TAG,
        "x-stress-req": reqId,
      },
      body: JSON.stringify({
        model,
        prompt: `${PROMPT_PREFIX} ${reqId}: reply with one short sentence.`,
        stream: false,
        keep_alive: KEEP_ALIVE,
      }),
      signal: controller.signal,
    });
    const bytes = (await res.arrayBuffer()).byteLength;
    return {
      model, reqId, status: res.status, bytes,
      latencyMs: Date.now() - start, ok: res.ok, error: null,
    };
  } catch (err) {
    return {
      model, reqId, status: 0, bytes: 0,
      latencyMs: Date.now() - start, ok: false,
      error: err.name === "AbortError" ? "timeout" : String(err.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function worker(id) {
  let localIdx = 0;
  while (Date.now() < stopAt && started < MAX_REQUESTS) {
    started++;
    const model = pickModel(id, localIdx++);
    const r = await fireOne(model);
    results.push(r);
    process.stdout.write(r.ok ? "." : r.error === "timeout" ? "T" : "x");
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function summarize(rows) {
  const n = rows.length;
  if (n === 0) return { n: 0 };
  const ok = rows.filter((r) => r.ok);
  const lat = [...ok.map((r) => r.latencyMs)].sort((a, b) => a - b);
  return {
    n,
    success: ok.length,
    successPct: ((ok.length / n) * 100).toFixed(1),
    p50: percentile(lat, 0.5),
    p95: percentile(lat, 0.95),
    p99: percentile(lat, 0.99),
    min: lat[0] ?? 0,
    max: lat[lat.length - 1] ?? 0,
  };
}

async function main() {
  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  const wallMs = Date.now() - t0;

  console.log(`\n\n[stress] done in ${(wallMs / 1000).toFixed(1)}s, ${results.length} requests\n`);

  // Overall
  const overall = summarize(results);
  console.log("=== overall ===");
  console.log(
    `n=${overall.n}  ok=${overall.success}/${overall.n} (${overall.successPct}%)  ` +
    `rps=${(overall.n / (wallMs / 1000)).toFixed(2)}  ` +
    `p50=${overall.p50}ms  p95=${overall.p95}ms  p99=${overall.p99}ms`
  );

  // Per-model
  console.log("\n=== per model ===");
  console.log("model                     n   ok     p50    p95    p99   errors");
  for (const model of MODELS) {
    const rows = results.filter((r) => r.model === model);
    const s = summarize(rows);
    const errors = rows.filter((r) => !r.ok).map((r) => r.error || `http${r.status}`);
    const errTxt = errors.length === 0 ? "-" : [...new Set(errors)].join(",");
    console.log(
      `${model.padEnd(25)} ${String(s.n).padStart(3)} ` +
      `${String(s.success ?? 0).padStart(4)}  ` +
      `${String(s.p50 ?? "-").padStart(6)} ${String(s.p95 ?? "-").padStart(6)} ${String(s.p99 ?? "-").padStart(6)}  ${errTxt}`
    );
  }

  // Error summary
  const errs = results.filter((r) => !r.ok);
  if (errs.length > 0) {
    console.log("\n=== errors ===");
    const byKind = {};
    for (const e of errs) {
      const k = e.error || `http${e.status}`;
      byKind[k] = (byKind[k] ?? 0) + 1;
    }
    for (const [k, n] of Object.entries(byKind)) {
      console.log(`  ${k}: ${n}`);
    }
  }

  console.log(`\n[stress] tag=${HEADER_TAG} (use this to grep proxy logs)`);
}

main().catch((err) => {
  console.error("[stress] fatal:", err);
  process.exit(2);
});
