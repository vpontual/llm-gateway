// Pure routing selection logic -- picks the best server based on model availability and VRAM.
// Extracted from router.ts to enable unit testing without database dependencies.

import type { OllamaRunningModel, OllamaAvailableModel } from "../lib/types";

export interface ServerSnapshot {
  id: number;
  name: string;
  host: string;
  totalRamGb: number;
  isOnline: boolean;
  loadedModels: OllamaRunningModel[];
  availableModels: OllamaAvailableModel[];
  totalVramUsed: number;
  backendType: "ollama" | "vllm" | "generic";
  maxConcurrent: number;
  isDisabled: boolean;
}

/** Calculate free VRAM in bytes */
export function freeVram(s: ServerSnapshot): number {
  return s.totalRamGb * 1024 * 1024 * 1024 - s.totalVramUsed;
}

/**
 * Pick server by priority: prefer servers with fewer in-flight requests,
 * then highest RAM tier, then round-robin among ties.
 */
export function pickByPriority(
  candidates: ServerSnapshot[],
  roundRobinCounter: number,
  inFlightCounts?: Map<number, number>
): { server: ServerSnapshot; nextCounter: number } {
  const sorted = [...candidates].sort((a, b) => {
    // Primary: fewer in-flight requests (less busy)
    if (inFlightCounts) {
      const aInFlight = inFlightCounts.get(a.id) ?? 0;
      const bInFlight = inFlightCounts.get(b.id) ?? 0;
      if (aInFlight !== bInFlight) return aInFlight - bInFlight;
    }
    // Secondary: more total RAM (bigger server)
    return b.totalRamGb - a.totalRamGb;
  });
  const topRam = sorted[0].totalRamGb;
  const topInFlight = inFlightCounts?.get(sorted[0].id) ?? 0;
  // Tie among servers with same in-flight count and RAM
  const tied = sorted.filter((s) => {
    const sInFlight = inFlightCounts?.get(s.id) ?? 0;
    return sInFlight === topInFlight && s.totalRamGb === topRam;
  });
  const server = tied[roundRobinCounter % tied.length];
  return { server, nextCounter: roundRobinCounter + 1 };
}

export interface SelectRouteParams {
  onlineServers: ServerSnapshot[];
  modelName: string;
  optimisticServerId: number | null;
  lastRoutedServerId: number | null;
  roundRobinCounter: number;
  /** Server IDs currently at max concurrency. */
  busyServerIds?: number[];
  /** Server IDs with high recent error rates. */
  degradedServerIds?: number[];
  /** Current in-flight request count per server. */
  inFlightCounts?: Map<number, number>;
  /** Request endpoint path (e.g. "/api/chat", "/v1/chat/completions"). */
  endpointPath?: string | null;
}

export interface SelectRouteResult {
  server: ServerSnapshot;
  reason: string;
  roundRobinCounter: number;
}

/**
 * Pure routing decision: given server states and context, pick the best server.
 *
 * Priority:
 * 1. Server with model loaded in memory (poller data or optimistic tracking)
 * 2. Server with model downloaded (available), preferring anti-churn rotation
 * 3. Fallback: server with most free VRAM
 *
 * Within each tier:
 * - Degraded servers (high error rate) are deprioritized
 * - Servers with fewer in-flight requests are preferred
 */
/**
 * Largest on-disk size observed for this model across servers that report
 * having it available. Returns null if no server advertises it. We take max
 * (not min) to be conservative: if different servers report slightly
 * different sizes, route as if the larger one is truth.
 */
function deriveModelSize(onlineServers: ServerSnapshot[], modelName: string): number | null {
  let maxSize: number | null = null;
  for (const s of onlineServers) {
    const available = s.availableModels.find((m) => m.name === modelName);
    if (available && typeof available.size === "number" && available.size > 0) {
      if (maxSize === null || available.size > maxSize) maxSize = available.size;
    }
    const loaded = s.loadedModels.find((m) => m.name === modelName);
    if (loaded && typeof loaded.size === "number" && loaded.size > 0) {
      if (maxSize === null || loaded.size > maxSize) maxSize = loaded.size;
    }
  }
  return maxSize;
}

/**
 * RAM fit threshold — a model needs at most this fraction of the server's
 * total RAM to be considered routable. Matches the threshold used by the
 * dashboard's oversized-model recommendations.
 */
const MODEL_FIT_THRESHOLD = 0.80;

/**
 * Endpoints that mutate Ollama server state (model management). These never
 * route to vLLM regardless of what model the request targets.
 */
const MANAGEMENT_ENDPOINTS = new Set([
  "/api/pull",
  "/api/delete",
  "/api/copy",
  "/api/create",
  "/api/push",
]);

export function selectRoute(params: SelectRouteParams): SelectRouteResult | null {
  const {
    modelName, optimisticServerId, lastRoutedServerId,
    busyServerIds = [], degradedServerIds = [], inFlightCounts,
    endpointPath,
  } = params;
  let counter = params.roundRobinCounter;

  // Filter servers by endpoint compatibility:
  // - Management endpoints (/api/pull, /api/delete, /api/copy, /api/create,
  //   /api/push) are Ollama-only — vLLM does not support dynamic model
  //   management and `generic` backends advertise no model catalog.
  // - All other paths (/api/generate, /api/chat, /api/embed, /v1/*) are
  //   backend-neutral. The vLLM adapter in server.ts handles translation.
  // - `generic` backends never serve traffic — they are pure health checks.
  let onlineServers = params.onlineServers.filter((s) => s.backendType !== "generic");
  if (endpointPath && MANAGEMENT_ENDPOINTS.has(endpointPath)) {
    onlineServers = onlineServers.filter((s) => s.backendType === "ollama");
  }

  // Size-based filter applies only to Ollama backends. vLLM cannot dynamically
  // load models, so "fits if loaded" is meaningless — advertisement IS the
  // routability check for vLLM (§3.3/§3.5). Partition first, filter Ollama
  // servers by size, then recombine.
  const vllmServers = onlineServers.filter((s) => s.backendType === "vllm");
  const ollamaServers = onlineServers.filter((s) => s.backendType === "ollama");
  const modelSize = deriveModelSize(ollamaServers, modelName);
  // HuggingFace-style model names (containing "/") are vLLM-only by convention
  // — Ollama can't pull "Qwen/Qwen3.6-35B-A3B-FP8" from anywhere. Excluding
  // them from the Ollama candidate set prevents the catch-all fallback from
  // routing a 35B vLLM model to e.g. an 8GB Jetson, which then 404s during
  // warmup and surfaces to the user as "model not found on any available server."
  const isVllmOnlyName = modelName.includes("/");
  let filteredOllama = ollamaServers;
  if (isVllmOnlyName) {
    filteredOllama = ollamaServers.filter((s) =>
      s.loadedModels.some((m) => m.name === modelName)
    );
  } else if (modelSize !== null) {
    filteredOllama = ollamaServers.filter((s) => {
      const ramBytes = s.totalRamGb * 1024 ** 3;
      const fits = ramBytes * MODEL_FIT_THRESHOLD >= modelSize;
      const alreadyLoaded = s.loadedModels.some((m) => m.name === modelName);
      return fits || alreadyLoaded;
    });
  }
  // For vLLM, only keep entries that currently advertise the requested model.
  // vLLM can't dynamic-load, so a non-advertising vLLM is not a candidate.
  const filteredVllm = vllmServers.filter((s) =>
    s.loadedModels.some((m) => m.name === modelName) ||
    s.availableModels.some((m) => m.name === modelName),
  );
  onlineServers = [...filteredOllama, ...filteredVllm];

  if (onlineServers.length === 0) return null;

  const busySet = new Set(busyServerIds);
  const degradedSet = new Set(degradedServerIds);

  /**
   * From a candidate list, prefer non-degraded servers. Only fall back to
   * degraded ones if they're the only option.
   */
  function preferHealthy(candidates: ServerSnapshot[]): ServerSnapshot[] {
    const healthy = candidates.filter((s) => !degradedSet.has(s.id));
    return healthy.length > 0 ? healthy : candidates;
  }

  // Servers with model loaded in memory (poller data OR optimistic)
  const withModelLoaded = onlineServers.filter(
    (s) =>
      s.loadedModels.some((m) => m.name === modelName) ||
      s.id === optimisticServerId
  );

  // 1. Non-busy server with model loaded — best case
  if (withModelLoaded.length > 0) {
    const loadedAndFree = withModelLoaded.filter((s) => !busySet.has(s.id));
    if (loadedAndFree.length > 0) {
      const healthyLoaded = preferHealthy(loadedAndFree);

      // Sticky affinity: if lastRouted server is in the loaded+free+healthy set, prefer it
      if (lastRoutedServerId != null) {
        const sticky = healthyLoaded.find((s) => s.id === lastRoutedServerId);
        if (sticky) {
          return { server: sticky, reason: "model_loaded_sticky", roundRobinCounter: counter };
        }
      }

      const { server, nextCounter } = pickByPriority(healthyLoaded, counter, inFlightCounts);
      return { server, reason: "model_loaded", roundRobinCounter: nextCounter };
    }

    // All loaded servers are busy — queue on the loaded server rather than
    // redirecting to a server that needs a model load
    const healthyLoaded = preferHealthy(withModelLoaded);
    const { server, nextCounter } = pickByPriority(healthyLoaded, counter, inFlightCounts);
    return { server, reason: "model_loaded_busy", roundRobinCounter: nextCounter };
  }

  // 2. Server with model downloaded (available) — no server has it loaded
  const withModelAvailable = onlineServers.filter((s) =>
    s.availableModels.some((m) => m.name === modelName)
  );

  if (withModelAvailable.length > 0) {
    let candidates = preferHealthy(withModelAvailable);
    let reason = "model_available";

    // Anti-churn: if multiple servers have the model, avoid the one that last
    // handled it (it unloaded -> VRAM pressure -> try a different server)
    if (lastRoutedServerId != null && candidates.length > 1) {
      const others = candidates.filter((s) => s.id !== lastRoutedServerId);
      if (others.length > 0) {
        candidates = others;
        reason = "model_available_anti_churn";
      }
    }

    const { server, nextCounter } = pickByPriority(candidates, counter, inFlightCounts);
    return { server, reason, roundRobinCounter: nextCounter };
  }

  // 3. Fall back to server with most free VRAM
  const healthyFallback = preferHealthy(onlineServers);
  const { server, nextCounter } = pickByPriority(healthyFallback, counter, inFlightCounts);
  return { server, reason: "fallback_most_vram", roundRobinCounter: nextCounter };
}
