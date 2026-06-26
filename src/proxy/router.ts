// Smart model router -- picks the best server for each request.
//
// Priority: model loaded in memory > model on disk (anti-churn) > most free VRAM.
// Within each tier: fewest in-flight requests first, then highest-RAM, round-robin among ties.
// Degraded servers (high error rate) are deprioritized within each tier.
// Optimistic tracking bridges the gap between routing and poller confirmation.

import { db } from "../lib/db";
import { servers, serverSnapshots } from "../lib/schema";
import { eq, desc } from "drizzle-orm";
import { selectRoute, freeVram, type ServerSnapshot } from "./route-logic";
import { selectPullTarget } from "../lib/pull-target";
import { BusyRequestTracker, type SlotHandle } from "./busy-tracker";
import { getDegradedServerIds, recordSuccess, recordError, getErrorRate } from "./health-tracker";
import { unloadModel } from "../lib/ollama";
import { sendTelegramMessage } from "../lib/telegram";
import { StuckEvictionTracker } from "./stuck-eviction-tracker";


export async function waitForServerSlot(serverId: number, timeoutMs: number = 300000): Promise<void> {
  const limits = new Map<number, number>();
  for (const s of cachedStates) {
    limits.set(s.id, s.maxConcurrent);
  }
  const limit = limits.get(serverId) ?? 1;
  return busyTracker.waitForSlot(serverId, limit, timeoutMs);
}

export function getQueueLength(serverId: number): number {
  return busyTracker.getQueueLength(serverId);
}

// Re-export health tracker functions for server.ts
export { recordSuccess, recordError, getErrorRate };


// In-memory cache of server states, refreshed periodically from poller DB data
let cachedStates: ServerSnapshot[] = [];
let lastRefresh = 0;
const CACHE_TTL_MS = 3000; // 3 seconds

// Round-robin counter for tiebreaking among equal-priority servers (e.g. Nanos)
let roundRobinCounter = 0;

// Track which server last handled each model (for anti-churn routing)
const lastRoutedServer = new Map<string, number>();

// Optimistic load tracking: after routing a model to a server, treat it as
// "loaded" there until the poller confirms otherwise. This bridges the gap
// between routing a request and the poller detecting the model is loaded
// (~10s polling interval), preventing anti-churn from incorrectly kicking in
// on back-to-back requests for the same model.
const optimisticLoads = new Map<string, { serverId: number; timestamp: number }>();
const OPTIMISTIC_TTL_MS = 30000; // 30s, enough for load + poller to catch up

const busyTracker = new BusyRequestTracker();

export function markRequestStart(serverId: number): SlotHandle {
  return busyTracker.markStart(serverId);
}

export function markRequestEnd(handle: SlotHandle): void {
  busyTracker.markEnd(handle);
}

export function getAutoReleasedCount(): number {
  return busyTracker.getAutoReleasedCount();
}

export function getQueueLengths(): Map<number, number> {
  const lens = new Map<number, number>();
  for (const s of cachedStates) {
    const n = busyTracker.getQueueLength(s.id);
    if (n > 0) lens.set(s.id, n);
  }
  return lens;
}

export function getInFlightCounts(): Map<number, number> {
  const counts = new Map<number, number>();
  for (const s of cachedStates) {
    const count = busyTracker.getInFlightCount(s.id);
    if (count > 0) counts.set(s.id, count);
  }
  return counts;
}


function getBusyServerIds(): number[] {
  // Build per-server concurrency limits from cached state
  const limits = new Map<number, number>();
  for (const s of cachedStates) {
    limits.set(s.id, s.maxConcurrent);
  }
  return busyTracker.getFullServerIds(limits);
}

export async function refreshServerStates(): Promise<ServerSnapshot[]> {
  const now = Date.now();
  if (now - lastRefresh < CACHE_TTL_MS && cachedStates.length > 0) {
    return cachedStates;
  }

  const allServers = await db.select().from(servers);

  // Parallel snapshot queries (was sequential N+1)
  const states: ServerSnapshot[] = await Promise.all(
    allServers.map(async (server) => {
      const [latest] = await db
        .select()
        .from(serverSnapshots)
        .where(eq(serverSnapshots.serverId, server.id))
        .orderBy(desc(serverSnapshots.polledAt))
        .limit(1);

      return {
        id: server.id,
        name: server.name,
        host: server.host,
        totalRamGb: server.totalRamGb,
        isOnline: latest?.isOnline ?? false,
        loadedModels: latest?.loadedModels ?? [],
        availableModels: latest?.availableModels ?? [],
        totalVramUsed: latest?.totalVramUsed ?? 0,
        backendType: server.backendType ?? "ollama",
        maxConcurrent: server.maxConcurrent ?? 1,
        isDisabled: server.isDisabled ?? false,
      };
    })
  );

  // Clear optimistic entries for models that the poller now confirms are loaded.
  // This keeps the optimistic map small and lets poller data take over.
  for (const [modelName, entry] of optimisticLoads) {
    const server = states.find((s) => s.id === entry.serverId);
    if (server && server.loadedModels.some((m) => m.name === modelName)) {
      optimisticLoads.delete(modelName);
    }
    // Also expire stale entries
    if (now - entry.timestamp > OPTIMISTIC_TTL_MS) {
      optimisticLoads.delete(modelName);
    }
  }

  cachedStates = states;
  lastRefresh = now;
  return states;
}


export interface RouteDecision {
  host: string;
  serverId: number;
  serverName: string;
  reason: string;
  backendType: "ollama" | "vllm" | "generic";
}

/**
 * Pick the best server for a model request.
 *
 * Priority:
 * 1. Server that has the model loaded in memory (from poller data or optimistic
 *    tracking after a recent routing decision)
 * 2. Server that has the model downloaded (available):
 *    - If multiple servers have it, avoid the one that last ran it (it unloaded,
 *      so it has VRAM pressure, so try a different server to reduce churn)
 *    - If only one server has it, route there regardless
 * 3. Fallback: server with the most free VRAM (will need to pull the model)
 *
 * Within each tier: prefer non-degraded servers with fewer in-flight requests.
 *
 * @param excludeServerIds - Server IDs to skip (used by retry logic when a
 *   server returned model-not-found or was unreachable)
 */

/**
 * Active Model Eviction: when a server needs to load a model but has idle
 * models hogging VRAM, force-unload them. A model is "idle" if it is loaded
 * on the server but has zero in-flight requests (per busy-tracker).
 *
 * Only evicts on Ollama backends (vLLM/generic don't support dynamic unloading).
 * Runs asynchronously -- fires unload requests without blocking the proxy.
 */
async function evictIdleModelsIfNeeded(
  targetServer: ServerSnapshot,
  requestedModel: string
): Promise<void> {
  // Only evict on Ollama backends
  if (targetServer.backendType !== "ollama") return;

  // If model is already loaded on this server, no eviction needed
  if (targetServer.loadedModels.some((m) => m.name === requestedModel)) return;

  // No loaded models to evict
  if (targetServer.loadedModels.length === 0) return;

  // Only evict if the server has no in-flight requests (all models are idle)
  if (busyTracker.getInFlightCount(targetServer.id) > 0) return;

  // Evict all idle models to make room, largest first
  const idleModels = targetServer.loadedModels
    .filter((m) => m.name !== requestedModel)
    .sort((a, b) => (b.size_vram ?? b.size ?? 0) - (a.size_vram ?? a.size ?? 0));

  for (const model of idleModels) {
    const sizeGb = Math.round(((model.size_vram || model.size || 0) / 1024 / 1024 / 1024) * 10) / 10;
    console.log(
      `[evict] Unloading idle model ${model.name} from ${targetServer.name} ` +
      `(${sizeGb}GB) to make room for ${requestedModel}`
    );
    void attemptEviction(targetServer, model.name);
  }
}

// Per-(server,model) consecutive eviction failure tracking. After 5 failures
// in a row, a Telegram alert escalates once per hour while the condition
// persists. State resets on success or when the poller confirms the model
// is no longer loaded.
const stuckEviction = new StuckEvictionTracker(5, 60 * 60 * 1000);

export function resetStuckEvictionIfUnloaded(serverId: number, loadedModelNames: Set<string>): void {
  stuckEviction.resetIfNotLoaded(serverId, loadedModelNames);
}

async function attemptEviction(targetServer: ServerSnapshot, modelName: string): Promise<void> {
  let result;
  try {
    result = await unloadModel(targetServer.host, modelName);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (result.ok) {
    stuckEviction.recordSuccess(targetServer.id, modelName);
    return;
  }

  const { count, shouldAlert } = stuckEviction.recordFailure(targetServer.id, modelName);
  const statusPart = result.status !== undefined ? `status=${result.status}` : "status=network";
  const errPart = result.error ? ` error=${result.error}` : "";
  console.warn(
    `[evict] unload ${modelName} on ${targetServer.name} failed ` +
    `(attempt=${count}, ${statusPart})${errPart}`
  );

  if (shouldAlert) {
    console.error(`[evict] ESCALATION: ${modelName} stuck on ${targetServer.name} (${count} failures)`);
    const msg =
      `*\ud83d\udea8 Model Stuck on Server*\n\n` +
      `*${targetServer.name}*\n` +
      `Model: \`${modelName}\`\n` +
      `${count} consecutive eviction failures. Manual intervention needed:\n` +
      `\`ollama stop ${modelName}\` or restart Ollama on the host.`;
    sendTelegramMessage(msg).catch((err) =>
      console.error("[evict] telegram alert failed:", err instanceof Error ? err.message : err)
    );
  }
}

export async function routeModel(
  modelName: string,
  excludeServerIds: number[] = [],
  endpointPath?: string | null
): Promise<RouteDecision | null> {
  const states = await refreshServerStates();
  const onlineServers = states.filter(
    (s) => s.isOnline && !s.isDisabled && !excludeServerIds.includes(s.id)
  );

  if (onlineServers.length === 0) return null;

  const optimistic = optimisticLoads.get(modelName);
  const optimisticServerId =
    optimistic && Date.now() - optimistic.timestamp <= OPTIMISTIC_TTL_MS
      ? optimistic.serverId
      : null;

  const result = selectRoute({
    onlineServers,
    modelName,
    optimisticServerId,
    lastRoutedServerId: lastRoutedServer.get(modelName) ?? null,
    roundRobinCounter,
    busyServerIds: getBusyServerIds(),
    degradedServerIds: getDegradedServerIds(),
    inFlightCounts: getInFlightCounts(),
    endpointPath,
  });

  if (!result) return null;

  // Active eviction: if the model needs to be loaded (not already in memory),
  // proactively unload idle models on the target server to free VRAM.
  const needsLoad = !result.reason.startsWith("model_loaded");
  if (needsLoad) {
    evictIdleModelsIfNeeded(result.server, modelName).catch(err => console.error("[evict-error]", err));
  }

  roundRobinCounter = result.roundRobinCounter;
  lastRoutedServer.set(modelName, result.server.id);
  optimisticLoads.set(modelName, {
    serverId: result.server.id,
    timestamp: Date.now(),
  });

  return {
    host: result.server.host,
    serverId: result.server.id,
    serverName: result.server.name,
    reason: result.reason,
    backendType: result.server.backendType,
  };
}

/**
 * Clear optimistic load and last-routed tracking for a model on a specific
 * server. Called by the proxy retry logic when a server returns model-not-found
 * or is unreachable, so the next routing attempt isn't biased toward it.
 */
export function clearOptimisticLoad(modelName: string, serverId: number): void {
  const entry = optimisticLoads.get(modelName);
  if (entry && entry.serverId === serverId) {
    optimisticLoads.delete(modelName);
  }
  if (lastRoutedServer.get(modelName) === serverId) {
    lastRoutedServer.delete(modelName);
  }
}

/**
 * Recommend the best server to pull a model to, based on free VRAM.
 * Returns server details with reasoning, or null if no servers are online.
 * Uses cached state (synchronous) so it can be called from error handlers.
 */
export interface PullRecommendation {
  serverName: string;
  serverHost: string;
  totalRamGb: number;
  freeVramGb: number;
  loadedModels: string[];
  reason: string;
}

export function getRecommendedPullServer(): PullRecommendation | null {
  const candidates = cachedStates
    .filter((s) => s.isOnline)
    .map((s) => ({ snap: s, freeVramBytes: freeVram(s) }));
  const best = selectPullTarget(candidates);
  if (!best) return null;

  const s = best.snap;
  const freeGb = Math.round((best.freeVramBytes / (1024 * 1024 * 1024)) * 10) / 10;

  return {
    serverName: s.name,
    serverHost: s.host,
    totalRamGb: s.totalRamGb,
    freeVramGb: freeGb,
    loadedModels: s.loadedModels.map((m) => m.name),
    reason: `Most free VRAM (${freeGb} GB of ${s.totalRamGb} GB)`,
  };
}

/**
 * Pick any online server for model-less endpoints. Excludes `generic` backends
 * (health-check-only) and prefers Ollama over vLLM — generic-native paths like
 * /api/version are Ollama-specific and will 4xx on a vLLM backend.
 */
export async function pickAnyServer(): Promise<RouteDecision | null> {
  const states = await refreshServerStates();
  const online = states.filter(
    (s) => s.isOnline && !s.isDisabled && s.backendType !== "generic",
  );
  if (online.length === 0) return null;
  const preferred =
    online.find((s) => s.backendType === "ollama") ?? online[0];
  return {
    host: preferred.host,
    serverId: preferred.id,
    serverName: preferred.name,
    reason: "any_online",
    backendType: preferred.backendType,
  };
}

/**
 * Get all online servers (for aggregation endpoints)
 */
export async function getAllOnlineServers(): Promise<ServerSnapshot[]> {
  const states = await refreshServerStates();
  return states.filter((s) => s.isOnline && !s.isDisabled);
}

/**
 * Resolve a server by name (case-insensitive). Returns a RouteDecision if the
 * server is online, null otherwise. Used by the proxy to honor
 * X-Ollama-Pin-Server headers from services that know which server they want.
 */
export async function resolveServerByName(
  serverName: string
): Promise<RouteDecision | null> {
  const states = await refreshServerStates();
  const lower = serverName.toLowerCase();
  const server = states.find(
    (s) => s.isOnline && !s.isDisabled && s.name.toLowerCase() === lower
  );
  if (!server) return null;
  return {
    host: server.host,
    serverId: server.id,
    serverName: server.name,
    reason: "pinned_by_header",
    backendType: server.backendType,
  };
}
