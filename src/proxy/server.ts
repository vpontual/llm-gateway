// Ollama-compatible HTTP proxy -- routes requests to the fleet,
// aggregates multi-server responses, and logs all traffic.

import http from "node:http";
import type { SlotHandle } from "./busy-tracker";
import {
  routeModel,
  pickAnyServer,
  getAllOnlineServers,
  resolveServerByName,
  clearOptimisticLoad,
  getRecommendedPullServer,
  markRequestStart,
  markRequestEnd,
  getAutoReleasedCount,
  getInFlightCounts,
  getQueueLengths,
  waitForServerSlot,
  getQueueLength,
  recordSuccess,
  recordError,
  getErrorRate,
} from "./router";
import { db } from "../lib/db";
import { requestLogs, users } from "../lib/schema";
import { readJsonEnv } from "../lib/env";
import { extractModelFromParsed, injectProxyDefaults } from "./parse";
import { hashApiKey } from "../lib/api-key-hash";
import { sendTelegramMessage } from "../lib/telegram";
import { detectNativeConversion, convertRequestToNative, convertResponseToV1, createV1StreamTransform } from "./v1-compat";
import { adaptRequestOllamaToVllm, adaptResponseVllmToOllama, createVllmToOllamaStreamTransform } from "./vllm-adapter";

const PROXY_PORT = parseInt(process.env.PROXY_PORT || "11434", 10);

// Maximum number of servers to try before giving up on model-not-found retries
const MAX_ROUTE_RETRIES = 3;

// Debounce Telegram notifications per model (5 minutes)
const modelNotFoundNotified = new Map<string, number>();
const NOTIFY_DEBOUNCE_MS = 300000;

// Periodically evict stale entries from the notification debounce map
setInterval(() => {
  const now = Date.now();
  for (const [model, ts] of modelNotFoundNotified) {
    if (now - ts > NOTIFY_DEBOUNCE_MS * 2) modelNotFoundNotified.delete(model);
  }
}, 600000); // every 10 minutes

// --- Endpoint classification ---

// Endpoints where we extract a model field from the request body
// Write operations that require API key when PROXY_PROTECT_WRITES is enabled
const WRITE_ENDPOINTS = new Set(["/api/pull", "/api/delete", "/api/copy", "/api/create"]);
const MAX_BODY_SIZE = 32 * 1024 * 1024; // 32MB body size limit (ample for chat/embeddings; bodies are fully buffered for routing/retry on small ARM nodes)
// Secure by default: destructive write endpoints (/api/pull,delete,copy,create)
// require a valid API key. Opt out explicitly with PROXY_PROTECT_WRITES=false.
// Note: the dashboard and telegram bot pull/delete by hitting backend hosts
// directly (not through this proxy), so they are unaffected.
const PROTECT_WRITES = process.env.PROXY_PROTECT_WRITES !== "false" && process.env.PROXY_PROTECT_WRITES !== "0";

const MODEL_ENDPOINTS = new Set([
  "/api/generate",
  "/api/chat",
  "/api/embed",
  "/api/embeddings",
  "/api/show",
  "/api/pull",
  "/api/delete",
  "/api/copy",
  "/api/create",
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/embeddings",
]);

// Aggregate endpoints
const AGGREGATE_ENDPOINTS = new Set(["/api/tags", "/api/ps", "/v1/models"]);

// Generation endpoints: slow operations where in-flight tracking matters.
const GENERATION_ENDPOINTS = new Set([
  "/api/generate",
  "/api/chat",
  "/v1/chat/completions",
  "/v1/completions",
]);

// Endpoints where retry-on-model-not-found makes sense (read operations).
const RETRY_ENDPOINTS = new Set([
  "/api/generate",
  "/api/chat",
  "/api/embed",
  "/api/embeddings",
  "/api/show",
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/embeddings",
]);

// Endpoints where keep_alive and num_ctx injection applies
const INJECTION_ENDPOINTS = new Set([
  "/api/generate",
  "/api/chat",
  "/api/embed",
  "/api/embeddings",
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/embeddings",
]);

// --- API Key cache for user identification ---
let apiKeyCache = new Map<string, { userId: number; username: string }>();
let lastKeyRefresh = 0;
const KEY_CACHE_TTL_MS = 30000; // 30 seconds

async function refreshApiKeyCache() {
  const now = Date.now();
  if (now - lastKeyRefresh < KEY_CACHE_TTL_MS) return;

  try {
    const allUsers = await db
      .select({ id: users.id, username: users.username, apiKey: users.apiKey })
      .from(users);

    const newCache = new Map<string, { userId: number; username: string }>();
    for (const u of allUsers) {
      newCache.set(u.apiKey, { userId: u.id, username: u.username });
    }
    apiKeyCache = newCache;
    lastKeyRefresh = now;
  } catch {
    // On error, keep old cache
  }
}

/**
 * Parse SOURCE_NAMES env var: JSON object mapping IP -> friendly name.
 */
function loadSourceNames(): Map<string, string> {
  try {
    const parsed = readJsonEnv<Record<string, string>>("SOURCE_NAMES");
    if (!parsed) return new Map();
    return new Map(Object.entries(parsed));
  } catch {
    console.warn("Failed to parse SOURCE_NAMES env var, ignoring");
    return new Map();
  }
}

const sourceNames = loadSourceNames();

// Only trust X-Forwarded-For when the immediate peer is a known proxy (e.g. the
// Traefik service IP). Otherwise any LAN client hitting :11434 directly could
// spoof its source IP in the logs. Configure via TRUSTED_PROXY_IPS (comma-sep).
// Default: trust nobody -> attribute by the real socket peer.
const trustedProxies = new Set(
  (process.env.TRUSTED_PROXY_IPS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function getClientIp(req: http.IncomingMessage): string {
  const socketIp = normalizeIp(req.socket.remoteAddress ?? "unknown");
  if (trustedProxies.has(socketIp)) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.trim()) {
      return normalizeIp(fwd.split(",")[0].trim());
    }
  }
  return socketIp;
}

/**
 * Resolve a human-friendly source identifier from the incoming request.
 */
function getSourceIdentifier(req: http.IncomingMessage): { source: string; userId: number | null } {
  // 1. API key header for user identification
  const apiKeyHeader = req.headers["x-ollama-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader.trim()) {
    const user = apiKeyCache.get(hashApiKey(apiKeyHeader.trim()));
    if (user) {
      return { source: user.username, userId: user.userId };
    }
  }

  // 2. Explicit header: internal services self-identify. This is a trusted-hint
  //    label only (a caller can set any value); it never grants privilege.
  const sourceHeader = req.headers["x-ollama-source"];
  if (typeof sourceHeader === "string" && sourceHeader.trim()) {
    return { source: sourceHeader.trim(), userId: null };
  }

  const ip = getClientIp(req);

  // 3. Check name mapping
  const name = sourceNames.get(ip);
  if (name) return { source: name, userId: null };

  // 4. Fall back to cleaned IP
  return { source: ip, userId: null };
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalSize = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    totalSize += buf.length;
    if (totalSize > MAX_BODY_SIZE) {
      throw new Error("Request body too large");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}


// Request logs are buffered and flushed in batches. On a small ARM Postgres
// with a 10-connection pool, a per-request INSERT competes with routing reads
// and the poller's writes; batching turns ~N inserts/sec into ~1.
const logBuffer: (typeof requestLogs.$inferInsert)[] = [];

function logRequest(
  sourceIp: string,
  userId: number | null,
  model: string | null,
  endpoint: string,
  method: string,
  targetServerId: number | null,
  targetHost: string | null,
  statusCode: number | null,
  durationMs: number,
  routingReason: string | null = null
): void {
  logBuffer.push({
    sourceIp,
    userId,
    model,
    endpoint,
    method,
    targetServerId,
    targetHost,
    statusCode,
    durationMs,
    routingReason,
  });
}

async function flushRequestLogs(): Promise<void> {
  if (logBuffer.length === 0) return;
  const batch = logBuffer.splice(0, logBuffer.length);
  try {
    await db.insert(requestLogs).values(batch);
  } catch (err) {
    console.error(`Failed to flush ${batch.length} request log(s):`, err);
  }
}

const logFlushTimer = setInterval(() => {
  void flushRequestLogs();
}, 1000);
logFlushTimer.unref();

interface ProxyResult {
  statusCode: number;
  retryable: boolean;
}

function resolveProxyError(
  error: unknown,
  res: http.ServerResponse,
  allowRetry: boolean,
  resolve: (result: ProxyResult) => void
): void {
  if (allowRetry) {
    resolve({ statusCode: 502, retryable: true });
    return;
  }

  const message = error instanceof Error ? error.message : "unknown proxy error";
  if (!res.headersSent) {
    res.writeHead(502);
    res.end(JSON.stringify({ error: `proxy error: ${message}` }));
  }
  resolve({ statusCode: 502, retryable: false });
}

/**
 * Proxy a request to a target Ollama server, streaming the response back.
 */
function proxyRequest(
  targetHost: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Buffer,
  allowRetry: boolean = false,
  pathOverride?: string,
  responseTransform?: { type: "stream"; transform: import("node:stream").Transform; contentType: string } | { type: "buffer"; transform: (buf: Buffer) => Buffer; contentType?: string },
): Promise<ProxyResult> {
  return new Promise((resolve) => {
    const [host, port] = targetHost.split(":");
    const options: http.RequestOptions = {
      hostname: host,
      port: parseInt(port || "11434", 10),
      path: pathOverride ?? req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: targetHost,
        "content-length": Buffer.byteLength(body).toString(),
      },
      timeout: 600000, // 10 min timeout for long generations
    };

    // First-byte timeout: if no response headers arrive within 90s, the backend
    // is likely loading a model. Abort early to release the busy slot faster.
    let firstByteTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      firstByteTimer = null;
      proxyReq.destroy(new Error("first-byte timeout: no response in 90s"));
    }, 90000);

    const proxyReq = http.request(options, (proxyRes) => {
      if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; }
      const statusCode = proxyRes.statusCode ?? 500;

      // In retry mode, intercept error responses to check for retryable patterns
      if (allowRetry && (statusCode === 404 || statusCode === 500)) {
        const chunks: Buffer[] = [];
        proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        proxyRes.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString();
          // Ollama: "model 'X' not found"; vLLM: "model `X` does not exist".
          const looksLikeModelMissing =
            responseBody.includes("not found") || responseBody.includes("does not exist");
          if (statusCode === 404 && looksLikeModelMissing) {
            resolve({ statusCode, retryable: true });
          } else if (statusCode === 500) {
            console.log(`[proxy] Backend returned 500: ${responseBody.slice(0, 200)}`);
            resolve({ statusCode, retryable: true });
          } else {
            res.writeHead(statusCode, proxyRes.headers);
            res.end(Buffer.concat(chunks));
            resolve({ statusCode, retryable: false });
          }
        });
        proxyRes.on("error", (err) => resolveProxyError(err, res, allowRetry, resolve));
        return;
      }

      // Normal path: stream directly, or through transform if converting.
      // Error bodies (non-2xx) are always passed through raw — response
      // transforms expect success-shaped payloads and would produce garbage
      // Ollama frames from an OpenAI error JSON.
      const is2xx = statusCode >= 200 && statusCode < 300;
      if (responseTransform?.type === "stream" && is2xx) {
        const headers = { ...proxyRes.headers };
        headers["content-type"] = responseTransform.contentType;
        delete headers["content-length"];
        res.writeHead(statusCode, headers);
        proxyRes.pipe(responseTransform.transform).pipe(res);
        responseTransform.transform.on("end", () => resolve({ statusCode, retryable: false }));
        responseTransform.transform.on("error", (err) => resolveProxyError(err, res, false, resolve));
      } else if (responseTransform?.type === "buffer" && is2xx) {
        const chunks: Buffer[] = [];
        proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        proxyRes.on("end", () => {
          const transformed = responseTransform.transform(Buffer.concat(chunks));
          const headers = { ...proxyRes.headers };
          headers["content-type"] = responseTransform.contentType ?? "application/json";
          headers["content-length"] = Buffer.byteLength(transformed).toString();
          res.writeHead(statusCode, headers);
          res.end(transformed);
          resolve({ statusCode, retryable: false });
        });
        proxyRes.on("error", (err) => resolveProxyError(err, res, false, resolve));
      } else {
        res.writeHead(statusCode, proxyRes.headers);
        proxyRes.pipe(res);
        proxyRes.on("end", () => resolve({ statusCode, retryable: false }));
        proxyRes.on("error", (err) => resolveProxyError(err, res, allowRetry, resolve));
      }
    });

    proxyReq.on("error", (err) => {
      if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; }
      resolveProxyError(err, res, allowRetry, resolve);
    });

    proxyReq.on("timeout", () => {
      if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; }
      proxyReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504);
        res.end(JSON.stringify({ error: "upstream timeout" }));
      }
      resolve({ statusCode: 504, retryable: false });
    });

    proxyReq.write(body);
    proxyReq.end();
  });
}

/**
 * Aggregate /api/tags from all servers (deduplicated by model name).
 *
 * Ollama servers: live /api/tags fetch (freshest model catalog).
 * vLLM servers: use the poller's cached snapshot (synthesized from /v1/models
 * with null size metadata — vLLM doesn't expose on-disk sizes).
 */
async function handleAggregateTags(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const onlineServers = await getAllOnlineServers();
  const allModels = new Map<string, unknown>();

  await Promise.all(
    onlineServers.map(async (server) => {
      if (server.backendType === "ollama") {
        try {
          const resp = await fetch(`http://${server.host}/api/tags`, { signal: AbortSignal.timeout(10000) });
          const data = await resp.json();
          for (const model of data.models ?? []) {
            if (!allModels.has(model.name)) allModels.set(model.name, model);
          }
        } catch {
          // Server unreachable, skip
        }
        return;
      }
      if (server.backendType === "vllm") {
        for (const model of server.availableModels) {
          if (!allModels.has(model.name)) allModels.set(model.name, model);
        }
      }
      // generic: no model catalog
    })
  );

  const result = { models: [...allModels.values()] };
  const body = JSON.stringify(result);
  res.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body).toString(),
  });
  res.end(body);
}

/**
 * Aggregate /api/ps from all servers.
 *
 * vLLM servers always expose their served model as "loaded" (no lazy loading),
 * so we synthesize a running-model entry from the poller snapshot.
 */
async function handleAggregatePs(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const onlineServers = await getAllOnlineServers();
  const allModels: unknown[] = [];

  await Promise.all(
    onlineServers.map(async (server) => {
      if (server.backendType === "ollama") {
        try {
          const resp = await fetch(`http://${server.host}/api/ps`, { signal: AbortSignal.timeout(10000) });
          const data = await resp.json();
          for (const model of data.models ?? []) {
            allModels.push({ ...model, _server: server.name, _host: server.host });
          }
        } catch {
          // Server unreachable, skip
        }
        return;
      }
      if (server.backendType === "vllm") {
        for (const model of server.loadedModels) {
          allModels.push({ ...model, _server: server.name, _host: server.host });
        }
      }
    })
  );

  const result = { models: allModels };
  const body = JSON.stringify(result);
  res.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body).toString(),
  });
  res.end(body);
}

/**
 * Aggregate /v1/models from all servers (OpenAI compat).
 */
async function handleAggregateModels(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const onlineServers = await getAllOnlineServers();
  const seen = new Set<string>();
  const allModels: unknown[] = [];

  await Promise.all(
    onlineServers.map(async (server) => {
      try {
        const resp = await fetch(`http://${server.host}/v1/models`, { signal: AbortSignal.timeout(10000) });
        const data = await resp.json();
        for (const model of data.data ?? []) {
          if (!seen.has(model.id)) {
            seen.add(model.id);
            allModels.push(model);
          }
        }
      } catch {
        // Skip
      }
    })
  );

  const result = { object: "list", data: allModels };
  const body = JSON.stringify(result);
  res.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body).toString(),
  });
  res.end(body);
}


/**
 * Transparent model warmup: if the model isn't loaded on the target server,
 * send a tiny generation request to trigger the load.
 */
async function ensureModelLoaded(
  host: string,
  model: string,
  serverName: string,
  source: string
): Promise<boolean> {
  const body = JSON.stringify({
    model,
    prompt: "hi",
    stream: false,
    options: { num_predict: 1 },
  });

  console.log(`[proxy] Warming up ${model} on ${serverName} for ${source}...`);

  return new Promise<boolean>((resolve) => {
    const [hostname, port] = host.split(":");
    const req = http.request(
      {
        hostname,
        port: parseInt(port || "11434", 10),
        path: "/api/generate",
        method: "POST",
        // Hard cap on warmup: loose enough for big models (qwen3.5:35b
        // takes ~30s on DGX) but tight enough that a stuck backend fails
        // fast and releases the slot, instead of blocking until the
        // 5-minute safety timer fires.
        timeout: WARMUP_TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body).toString(),
        },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => {
          if (res.statusCode === 200) {
            console.log(`[proxy] ${model} ready on ${serverName}`);
            resolve(true);
          } else {
            console.warn(`[proxy] Warmup failed for ${model} on ${serverName}: ${res.statusCode}`);
            resolve(false);
          }
        });
      }
    );
    req.on("error", (err) => {
      console.warn(`[proxy] Warmup error for ${model} on ${serverName}: ${err.message}`);
      resolve(false);
    });
    req.on("timeout", () => {
      console.warn(`[proxy] Warmup timeout (${WARMUP_TIMEOUT_MS / 1000}s) for ${model} on ${serverName}`);
      req.destroy(new Error("warmup timeout"));
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

// --- Main request handler ---

const WARMUP_TIMEOUT_MS = 180000; // 3 min: loose for large model loads, tight enough to release slots quickly

// Paths that originate from Ollama-native clients and need translation when
// the chosen backend is vLLM.
const OLLAMA_NATIVE_PATHS = new Set([
  "/api/generate",
  "/api/chat",
  "/api/embed",
  "/api/embeddings",
]);

// Endpoints the vLLM adapter can translate into /v1/*.
const VLLM_TRANSLATABLE_PATHS = OLLAMA_NATIVE_PATHS;

type ResponseTransform =
  | { type: "stream"; transform: import("node:stream").Transform; contentType: string }
  | { type: "buffer"; transform: (buf: Buffer) => Buffer; contentType?: string };

interface BackendRequest {
  effectivePath: string;
  effectiveBody: Buffer;
  responseTransform?: ResponseTransform;
  injectedDefaults: string[];
  /** True when the backend holds the model permanently (no load trigger needed). */
  skipWarmup: boolean;
  /** If set, short-circuit the whole loop with this error response. */
  error?: { statusCode: number; message: string };
}

/** Track servers for which we've already logged the keep_alive drop once. */
const vllmKeepAliveNoticeLogged = new Set<number>();

/**
 * Detect whether an Ollama-native request expects a streamed response.
 * `/api/generate` and `/api/chat` default to stream=true in Ollama.
 * Embedding endpoints never stream.
 */
function isOllamaStreaming(
  path: string,
  body: Buffer,
  parsed?: Record<string, unknown> | null,
): boolean {
  if (path === "/api/embed" || path === "/api/embeddings") return false;
  if (body.length === 0) return true;
  let obj: Record<string, unknown> | null;
  if (parsed !== undefined) {
    obj = parsed;
  } else {
    try {
      obj = JSON.parse(body.toString()) as Record<string, unknown>;
    } catch {
      return true;
    }
  }
  if (!obj) return true; // non-JSON body: keep default (stream)
  return (obj as { stream?: boolean }).stream !== false;
}

const OWUI_REASONING_MODELS = ["qwen3.6", "qwen3", "qwen/qwen3", "deepseek-r1", "deepseek_r1"];

/**
 * OWUI reasoning gate. Open WebUI hits /api/chat from the swarm subnet without
 * an x-ollama-source tag (backend services tag themselves). For reasoning
 * models, and only when thinking is not explicitly disabled, ask the adapter to
 * prepend the missing <think> opener so OWUI renders a balanced reasoning pair.
 * Every tagged backend, every /v1 client, and non-reasoning models are excluded.
 */
function shouldWrapOwuiReasoning(
  req: http.IncomingMessage,
  path: string,
  parsed: Record<string, unknown> | null,
  model: string | null,
): boolean {
  if (path !== "/api/chat") return false;
  const sourceHeader = req.headers["x-ollama-source"];
  const source = (Array.isArray(sourceHeader) ? sourceHeader[0] : (sourceHeader ?? "")).toLowerCase();
  const hasSource = !!sourceHeader;
  const hasKey = !!req.headers["x-ollama-api-key"];
  const m = (model ?? "").toLowerCase();
  const isReasoning = OWUI_REASONING_MODELS.some((k) => m.includes(k));
  const thinkFalse = parsed?.think === false;
  // vcode tags itself (x-ollama-source: vcode) and consumes the Ollama `thinking`
  // field to collapse reasoning into a dropdown. Trust its self-tag — no subnet
  // gate — and wrap whenever it's a reasoning model with thinking enabled.
  if (source === "vcode") {
    return isReasoning && !thinkFalse && !hasKey;
  }
  // OWUI hits /api/chat from the swarm subnet without a source tag. Same intent.
  // Note: this gate keeps its own lenient XFF read on purpose — it only decides
  // reasoning-wrap (no privilege), and OWUI may arrive via a hop that sets XFF.
  const fwd = req.headers["x-forwarded-for"];
  let ip = typeof fwd === "string" ? fwd.split(",")[0].trim() : (req.socket.remoteAddress ?? "");
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  const subnet = ip.startsWith("10.0.154.");
  return !hasSource && !hasKey && isReasoning && subnet && !thinkFalse;
}

/**
 * Build the backend-specific request: effective path, effective body, response
 * translator, and dispatch flags (warmup, injected-defaults log tags). Called
 * once per route attempt after the route decision is made.
 */
function prepareBackendRequest(
  route: { serverId: number; serverName: string; backendType: "ollama" | "vllm" | "generic" },
  clientPath: string,
  clientBody: Buffer,
  parsedBody: Record<string, unknown> | null,
  model: string | null,
  startedAt: number,
  wrapReasoning: boolean,
): BackendRequest {
  // Generic backends never serve traffic (they're health-check only).
  if (route.backendType === "generic") {
    return {
      effectivePath: clientPath,
      effectiveBody: clientBody,
      injectedDefaults: [],
      skipWarmup: true,
      error: { statusCode: 503, message: `server ${route.serverName} is generic-only and cannot serve requests` },
    };
  }

  if (route.backendType === "vllm") {
    // vLLM skips Ollama-only defaults (keep_alive is meaningless; num_ctx is
    // fixed at launch). Log once per server so the drop is visible in history.
    if (!vllmKeepAliveNoticeLogged.has(route.serverId)) {
      vllmKeepAliveNoticeLogged.add(route.serverId);
      console.log(
        `[proxy] vLLM backend ${route.serverName}: dropping Ollama-only fields (keep_alive, num_ctx) from requests routed here`,
      );
    }

    // /v1/* paths are native to vLLM: passthrough.
    if (clientPath.startsWith("/v1/")) {
      return {
        effectivePath: clientPath,
        effectiveBody: clientBody,
        injectedDefaults: [],
        skipWarmup: true,
      };
    }

    // /api/* paths: translate to /v1/*.
    if (VLLM_TRANSLATABLE_PATHS.has(clientPath)) {
      const adapted = adaptRequestOllamaToVllm(clientPath, clientBody, parsedBody);
      if (!adapted) {
        return {
          effectivePath: clientPath,
          effectiveBody: clientBody,
          injectedDefaults: [],
          skipWarmup: true,
          error: { statusCode: 400, message: "invalid JSON body for backend translation" },
        };
      }
      const isStreaming = isOllamaStreaming(clientPath, clientBody, parsedBody);
      const ctx = {
        clientPath,
        model: model ?? "",
        isStreaming,
        startedAt,
        wrapReasoning,
      };
      return {
        effectivePath: adapted.path,
        effectiveBody: adapted.body,
        responseTransform: isStreaming
          ? {
              type: "stream",
              transform: createVllmToOllamaStreamTransform(ctx),
              contentType: "application/x-ndjson",
            }
          : {
              type: "buffer",
              transform: (buf) => adaptResponseVllmToOllama(buf, ctx),
              contentType: "application/json",
            },
        injectedDefaults: [],
        skipWarmup: true,
      };
    }

    // Unsupported path on vLLM (e.g. /api/pull). Router should have filtered
    // these out; treat a leaked one as a 400 with an explicit message.
    return {
      effectivePath: clientPath,
      effectiveBody: clientBody,
      injectedDefaults: [],
      skipWarmup: true,
      error: {
        statusCode: 400,
        message: `endpoint ${clientPath} is not supported on vLLM backend ${route.serverName}`,
      },
    };
  }

  // --- Ollama backend path ---
  let effectiveBody = clientBody;
  let effectivePath = clientPath;
  let injectedDefaults: string[] = [];
  let responseTransform: ResponseTransform | undefined;

  // Inject proxy defaults (keep_alive, num_ctx) for Ollama generation/embedding.
  if (INJECTION_ENDPOINTS.has(clientPath) && effectiveBody.length > 0) {
    const result = injectProxyDefaults(effectiveBody);
    effectiveBody = result.body;
    injectedDefaults = result.injected;
  }

  // /v1/chat/completions → /api/chat conversion so Ollama-specific fields
  // (think, num_ctx, etc.) survive and thinking-model responses are parsed.
  // Response is converted back to OpenAI shape.
  if (clientPath === "/v1/chat/completions" && effectiveBody.length > 0) {
    const conversion = detectNativeConversion(effectiveBody);
    if (conversion) {
      effectiveBody = convertRequestToNative(conversion.parsed);
      effectivePath = "/api/chat";
      responseTransform = conversion.ctx.isStreaming
        ? {
            type: "stream",
            transform: createV1StreamTransform(conversion.ctx.model),
            contentType: "text/event-stream",
          }
        : {
            type: "buffer",
            transform: (buf: Buffer) => convertResponseToV1(buf, conversion.ctx.model),
            contentType: "application/json",
          };
    }
  }

  return {
    effectivePath,
    effectiveBody,
    responseTransform,
    injectedDefaults,
    skipWarmup: false,
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  const startTime = Date.now();

  const { source, userId } = getSourceIdentifier(req);
  const path = (req.url ?? "/").split("?")[0];
  const method = req.method ?? "GET";

  // Health check: respond directly
  if (path === "/" && method === "GET") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("Ollama is running");
    return;
  }

  // Aggregate endpoints
  if (AGGREGATE_ENDPOINTS.has(path) && method === "GET") {
    try {
      if (path === "/api/tags") {
        await handleAggregateTags(req, res);
      } else if (path === "/api/ps") {
        await handleAggregatePs(req, res);
      } else if (path === "/v1/models") {
        await handleAggregateModels(req, res);
      }
      logRequest(source, userId, null, path, method, null, null, 200, Date.now() - startTime);
    } catch (err) {
      console.error(`Aggregate error for ${path}:`, err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: "internal proxy error" }));
      logRequest(source, userId, null, path, method, null, null, 500, Date.now() - startTime);
    }
    return;
  }

  // Read request body for POST/PUT/PATCH/DELETE
  const body: Buffer =
    method !== "GET" && method !== "HEAD" ? await readBody(req) : Buffer.alloc(0);

  // Parse the body ONCE here and reuse it across model extraction, the OWUI
  // reasoning gate, streaming detection, and the vLLM adapter — instead of each
  // helper re-parsing the (potentially large) body. null = empty or non-JSON.
  let parsedBody: Record<string, unknown> | null = null;
  if (body.length > 0) {
    try {
      parsedBody = JSON.parse(body.toString()) as Record<string, unknown>;
    } catch {
      parsedBody = null;
    }
  }

  // Extract model from request body. Done before any backend-specific
  // translation so routing and logging see the client's intent directly.
  const model = MODEL_ENDPOINTS.has(path) ? extractModelFromParsed(parsedBody) : null;

  // Write-protection: require valid API key for destructive operations
  if (PROTECT_WRITES && WRITE_ENDPOINTS.has(path)) {
    const apiKeyHeader = req.headers["x-ollama-api-key"];
    const validKey = typeof apiKeyHeader === "string" && apiKeyCache.get(hashApiKey(apiKeyHeader.trim()));
    if (!validKey) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "API key required for write operations. Set X-Ollama-Api-Key header." }));
      logRequest(source, userId, model, path, method, null, null, 401, Date.now() - startTime);
      return;
    }
  }

  // Route the request. Honor X-Ollama-Pin-Server header if present
  const pinHeader = req.headers["x-ollama-pin-server"];
  const pinServerName = typeof pinHeader === "string" ? pinHeader.trim() : null;

  const wrapReasoning = shouldWrapOwuiReasoning(req, path, parsedBody, model);
  const canRetry = model != null && !pinServerName && RETRY_ENDPOINTS.has(path);
  const excludeServerIds: number[] = [];

  for (let attempt = 0; attempt <= MAX_ROUTE_RETRIES; attempt++) {
    let route;
    if (pinServerName) {
      route = await resolveServerByName(pinServerName, model);
    }
    if (!route && model) {
      route = await routeModel(model, excludeServerIds, path);
    }
    if (!route && excludeServerIds.length > 0) {
      break;
    }
    if (!route) {
      route = await pickAnyServer();
    }

    if (!route) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "no online servers available" }));
      logRequest(source, userId, model, path, method, null, null, 503, Date.now() - startTime);
      return;
    }

    // Prepare the backend-specific request (injection, translation, transform).
    const prep = prepareBackendRequest(route, path, body, parsedBody, model, startTime, wrapReasoning);
    if (prep.error) {
      if (!res.headersSent) {
        res.writeHead(prep.error.statusCode, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: prep.error.message }));
      }
      logRequest(source, userId, model, path, method, route.serverId, route.host, prep.error.statusCode, Date.now() - startTime, route.reason);
      return;
    }

    // Log routing decision with injected defaults, backend, and health info
    const errorRate = getErrorRate(route.serverId);
    const healthTag = errorRate > 0 ? ` | health=${Math.round((1 - errorRate) * 100)}%` : "";
    const injectTag = prep.injectedDefaults.length > 0 ? ` | injected=[${prep.injectedDefaults.join(",")}]` : "";
    const backendTag = route.backendType !== "ollama" ? ` | backend=${route.backendType}` : "";

    console.log(
      `[proxy] ${source} → ${route.serverName} (${route.host})${backendTag} | ${method} ${path}${model ? ` | model=${model}` : ""} | reason=${route.reason}${healthTag}${injectTag}${attempt > 0 ? ` | retry=${attempt}` : ""}`
    );

    const allowRetry = canRetry && attempt < MAX_ROUTE_RETRIES;
    const trackBusy = GENERATION_ENDPOINTS.has(path);

    // Queue: if this is a generation request, wait for a slot on the target server
    if (trackBusy) {
      const queueLen = getQueueLength(route.serverId);
      if (queueLen > 0) {
        console.log(`[proxy] ${source} queued for ${route.serverName} (${queueLen} ahead)`);
      }
      try {
        await waitForServerSlot(route.serverId, 300000);
      } catch (err) {
        console.log(`[proxy] Queue timeout for ${route.serverName}, returning 503`);
        recordError(route.serverId);
        if (!res.headersSent) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: `server ${route.serverName} busy, queue timeout` }));
        }
        logRequest(source, userId, model, path, method, route.serverId, route.host, 503, Date.now() - startTime, "queue_timeout");
        return;
      }
    }
    const slotHandle: SlotHandle | null = trackBusy ? markRequestStart(route.serverId) : null;

    // Transparent warmup: Ollama-only. vLLM holds its model permanently.
    if (trackBusy && model && !route.reason.startsWith("model_loaded") && !prep.skipWarmup) {
      const warmedUp = await ensureModelLoaded(route.host, model, route.serverName, source);
      if (!warmedUp && allowRetry) {
        if (slotHandle) markRequestEnd(slotHandle);
        recordError(route.serverId);
        excludeServerIds.push(route.serverId);
        clearOptimisticLoad(model, route.serverId);
        console.log(`[proxy] Warmup failed on ${route.serverName}, trying next server...`);
        continue;
      }
    }

    let result: ProxyResult;
    try {
      const pathOverride = prep.effectivePath !== path ? prep.effectivePath : undefined;
      result = await proxyRequest(
        route.host, req, res, prep.effectiveBody, allowRetry,
        pathOverride,
        prep.responseTransform,
      );
    } catch (err) {
      console.error(
        `[proxy] unexpected proxy error for ${route.serverName} (${route.host})`,
        err
      );
      if (!res.headersSent) {
        res.writeHead(502);
        res.end(JSON.stringify({ error: "proxy upstream error" }));
      }
      result = { statusCode: 502, retryable: false };
    } finally {
      if (slotHandle) markRequestEnd(slotHandle);
    }

    // Record health outcome
    if (result.statusCode >= 200 && result.statusCode < 400) {
      recordSuccess(route.serverId);
    } else if (result.statusCode >= 500 || result.statusCode === 0) {
      recordError(route.serverId);
    }

    if (result.retryable) {
      const retryReason =
        result.statusCode === 404 ? "Model not found" :
        result.statusCode === 500 ? "Server error" :
        "Server unreachable";
      console.log(
        `[proxy] ${retryReason} on ${route.serverName} (${route.host}), trying next server...`
      );
      recordError(route.serverId);
      excludeServerIds.push(route.serverId);
      if (model) clearOptimisticLoad(model, route.serverId);
      continue;
    }

    // Success or non-retryable error, done
    const duration = Date.now() - startTime;
    logRequest(source, userId, model, path, method, route.serverId, route.host, result.statusCode, duration, route.reason);
    return;
  }

  // All candidate servers exhausted
  if (!res.headersSent) {
    const recommendation = model ? getRecommendedPullServer() : null;
    const responseBody: Record<string, unknown> = {
      error: model
        ? `model '${model}' not found on any available server`
        : "no online servers available",
    };

    if (model && recommendation) {
      responseBody.pull_recommendation = recommendation;
      responseBody.hint = `To download this model, POST /api/pull with {"model": "${model}"}`;

      const lastNotified = modelNotFoundNotified.get(model) ?? 0;
      if (process.env.MUTE_MODEL_NOT_FOUND_ALERTS !== "true" && Date.now() - lastNotified > NOTIFY_DEBOUNCE_MS) {
        modelNotFoundNotified.set(model, Date.now());
        const loaded = recommendation.loadedModels.length > 0
          ? recommendation.loadedModels.join(", ")
          : "none";
        sendTelegramMessage(
          `⚠️ *Model not found*\n\n` +
          `Model: \`${model}\`\n` +
          `Requested by: ${source}\n` +
          `Best server: *${recommendation.serverName}* ` +
          `(${recommendation.freeVramGb} GB free of ${recommendation.totalRamGb} GB)\n` +
          `Currently loaded: ${loaded}\n\n` +
          `Reply /pull_missing to download it.`
        );
      }
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify(responseBody));
  }
  logRequest(source, userId, model, path, method, null, null, 404, Date.now() - startTime);
}

// --- Process hardening: log but don't crash on stray rejections ---
process.on("unhandledRejection", (err) => {
  console.error("[proxy] Unhandled rejection (non-fatal):", err);
});

process.on("uncaughtException", (err) => {
  console.error("[proxy] Uncaught exception (non-fatal):", err);
});

// --- Server startup ---

async function main() {
  // Migrations are applied once by entrypoint.sh (node migrate.js) before this
  // process starts — no in-process migrate() here (avoids the dual-migrate race
  // with the Next.js process).

  // Log proxy defaults on startup
  const keepAlive = process.env.PROXY_DEFAULT_KEEP_ALIVE ?? "30m";
  const minCtx = process.env.PROXY_MIN_NUM_CTX ?? "8192";
  console.log(`Proxy defaults: keep_alive=${keepAlive}, min_num_ctx=${minCtx}`);

  if (sourceNames.size > 0) {
    console.log(`Source name mappings: ${[...sourceNames.entries()].map(([ip, name]) => `${ip}\u2192${name}`).join(", ")}`);
  }

  const server = http.createServer(handleRequest);

  // Background refresh of API key cache (every 30s, non-blocking)
  refreshApiKeyCache().catch(() => {});
  setInterval(() => refreshApiKeyCache().catch(() => {}), 30000);

  // Periodic health summary: dump routing-tracker state so incidents have a trail.
  // Cadence: 5 minutes. Only logs when there is something to report.
  setInterval(() => {
    const inFlight = getInFlightCounts();
    const queues = getQueueLengths();
    const autoReleased = getAutoReleasedCount();
    const parts: string[] = [];
    if (inFlight.size > 0) {
      parts.push("in-flight=" + [...inFlight].map(([id, n]) => id + ":" + n).join(","));
    }
    if (queues.size > 0) {
      parts.push("queues=" + [...queues].map(([id, n]) => id + ":" + n).join(","));
    }
    if (autoReleased > 0) {
      parts.push("auto-released-total=" + autoReleased);
    }
    if (parts.length > 0) {
      console.log("[health-summary] " + parts.join(" "));
    }
  }, 5 * 60 * 1000).unref();

  server.listen(PROXY_PORT, () => {
    console.log(`LLM gateway proxy listening on port ${PROXY_PORT}`);
    console.log("Routing requests to Ollama fleet servers");
  });

  // Graceful shutdown: stop accepting connections, then flush buffered logs.
  const shutdown = () => {
    console.log("Shutting down proxy...");
    server.close(() => {
      void flushRequestLogs().finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Proxy failed to start:", err);
  process.exit(1);
});
