import { startWanMonitor, isWanUp } from "./wan-health";
import { isTelegramConfigured, sendTelegramMessage } from "./telegram";
import { formatUptime } from "./format";
// Fleet poller -- polls all Ollama servers, records snapshots, detects changes

import { db } from "./db";
import { servers, serverSnapshots, modelEvents, systemMetrics, serverEvents, requestLogs, modelDiscoveries } from "./schema";
import { pollServer, pollVllmServer, pollGenericServer } from "./ollama";
import { fetchSystemMetrics } from "./metrics";
import { getAgentPlugins } from "./plugins";
import { eq, sql } from "drizzle-orm";
import type { ServerConfig, OllamaRunningModel, OllamaAvailableModel } from "./types";
import { checkServerAlerts } from "./alerts";
import { notifySubscribedUsers } from "./user-notifications";
import { readJsonEnv, readPositiveIntEnv } from "./env";
import { computeSnapshotSignature } from "./snapshot-dedup";
import { fetchModelInfo, getInfoFetchStatus } from "./model-info";
import { resetStuckEvictionIfUnloaded } from "../proxy/router";

// --- In-memory state for diffing between polls --- loaded models between polls
const previousModels = new Map<number, Set<string>>();

// Last-known running-model objects per server. Used to carry forward the loaded
// set when a poll can't determine it (e.g. /api/ps blip while the host is up),
// so a transient failure doesn't record a false "all models unloaded".
const previousFullModels = new Map<number, OllamaRunningModel[]>();

// In-memory state for detecting server lifecycle transitions
const previousOnline = new Map<number, boolean>();

// Dedup cache: last snapshot signature + row id per server, to skip redundant inserts
const previousSnapshot = new Map<number, { signature: string; id: number }>();
const previousBootSet = new Map<number, Set<string>>();

// Consecutive failure counter: only declare offline after N consecutive failed polls
const failureCount = new Map<number, number>();

// Fleet-wide model discovery: tracks all models ever seen across all servers
const knownFleetModels = new Set<string>();
let knownFleetModelsSeeded = false;

// Config lookup by host for per-server settings (e.g. metricsPort)
const serverConfigMap = new Map<string, ServerConfig>();

// --- Server configuration ---

function getServerConfigs(): ServerConfig[] {
  const parsed = readJsonEnv<unknown>("OLLAMA_SERVERS");
  if (!parsed) {
    console.error("OLLAMA_SERVERS env var not set");
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.error("OLLAMA_SERVERS env var must be a JSON array");
    return [];
  }

  const valid: ServerConfig[] = [];
  for (const [i, entry] of parsed.entries()) {
    if (!entry || typeof entry !== "object") {
      console.error(`OLLAMA_SERVERS[${i}] must be an object, skipping`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== "string" || !e.name.trim()) {
      console.error(`OLLAMA_SERVERS[${i}] missing or invalid "name", skipping`);
      continue;
    }
    if (typeof e.host !== "string" || !e.host.trim()) {
      console.error(`OLLAMA_SERVERS[${i}] (${(e.name as string)}) missing or invalid "host", skipping`);
      continue;
    }
    if (typeof e.ramGb !== "number" || !Number.isFinite(e.ramGb) || e.ramGb <= 0) {
      console.error(`OLLAMA_SERVERS[${i}] (${(e.name as string)}) missing or invalid "ramGb", skipping`);
      continue;
    }
    valid.push(entry as ServerConfig);
  }
  return valid;
}

async function ensureServersSeeded(configs: ServerConfig[]) {
  for (const config of configs) {
    const existing = await db
      .select()
      .from(servers)
      .where(eq(servers.host, config.host))
      .limit(1);

    if (existing.length === 0) {
      const backendType = config.backendType ?? "ollama";
      const maxConcurrent = config.maxConcurrent ?? (backendType === "vllm" ? 10 : 1);
      await db.insert(servers).values({
        name: config.name,
        host: config.host,
        totalRamGb: config.ramGb,
        backendType,
        maxConcurrent,
      });
      console.log(`Seeded server: ${config.name} (${config.host}) [${backendType}]`);
    }
  }
}

/** Resolve the metrics agent host:port for a server, or null to skip. */
function getMetricsHost(serverHost: string): string | null {
  const config = serverConfigMap.get(serverHost);

  // Explicitly disabled: metricsPort is 0 or null
  if (config?.metricsPort === 0 || config?.metricsPort === null) {
    return null;
  }

  const ip = serverHost.split(":")[0];

  // Use per-server override if set
  if (config?.metricsPort) {
    return `${ip}:${config.metricsPort}`;
  }

  // Fall back to fleet-metrics plugin defaultPort
  const metricsPlugin = getAgentPlugins().find((p) => p.configKey === "metricsPort");
  const defaultPort = metricsPlugin?.defaultPort ?? 9100;
  return `${ip}:${defaultPort}`;
}

// --- Model discovery ---

async function seedKnownFleetModels() {
  if (knownFleetModelsSeeded) return;
  const existing = await db
    .select({ modelName: modelDiscoveries.modelName })
    .from(modelDiscoveries);
  for (const row of existing) {
    knownFleetModels.add(row.modelName);
  }
  knownFleetModelsSeeded = true;
}

async function checkForNewModels(
  availableModels: OllamaAvailableModel[],
  serverName: string
) {
  for (const model of availableModels) {
    const name = model.name;
    if (knownFleetModels.has(name)) continue;

    // Mark as known immediately to prevent parallel polls racing
    knownFleetModels.add(name);

    // Insert discovery row with local metadata from the model
    await db
      .insert(modelDiscoveries)
      .values({
        modelName: name,
        modelFamily: model.details?.family ?? null,
        families: model.details?.families ?? [],
        parameterSize: model.details?.parameter_size ?? null,
        quantization: model.details?.quantization_level ?? null,
        modelSize: model.size ?? 0,
        firstSeenServerName: serverName,
        infoFetchStatus: "pending",
      })
      .onConflictDoNothing();

    console.log(`[Discovery] New model detected: ${name} on ${serverName}`);

    // Fire-and-forget enrichment
    enrichDiscovery(name).catch((err) =>
      console.error(`[Discovery] Enrichment failed for ${name}:`, err)
    );
  }
}

async function enrichDiscovery(modelName: string) {
  const info = await fetchModelInfo(modelName);
  const status = getInfoFetchStatus(info);

  const updates: Record<string, unknown> = {
    infoFetchStatus: status,
    infoFetchedAt: new Date(),
    registryExists: info.registryExists,
  };

  if (info.ollamaCom) {
    if (info.ollamaCom.description) updates.description = info.ollamaCom.description;
    if (info.ollamaCom.capabilities.length > 0) updates.capabilities = info.ollamaCom.capabilities;
    if (info.ollamaCom.pullCount) updates.pullCount = info.ollamaCom.pullCount;
  }

  if (info.registry) {
    if (info.registry.modelFamily) updates.modelFamily = info.registry.modelFamily;
    if (info.registry.families.length > 0) updates.families = info.registry.families;
  }

  await db
    .update(modelDiscoveries)
    .set(updates)
    .where(eq(modelDiscoveries.modelName, modelName));

  console.log(`[Discovery] Enriched ${modelName} (status: ${status})`);
}

// --- Main poll loop ---

async function pollAllServers() {
  const allServers = await db.select().from(servers);

  await Promise.all(
    allServers.map(async (server) => {
      try {
        // Resolve metrics host (null = skip metrics for this server)
        const metricsHost = getMetricsHost(server.host);

        // Dispatch to the right poller based on backend type
        const backendType = server.backendType ?? "ollama";
        const pollFn =
          backendType === "vllm" ? pollVllmServer :
          backendType === "generic" ? pollGenericServer :
          pollServer;

        // Fetch backend data and system metrics in parallel
        const [result, sysMetrics] = await Promise.all([
          pollFn(server.host),
          metricsHost ? fetchSystemMetrics(metricsHost) : Promise.resolve(null),
        ]);

        // Resolve running models. null = this poll couldn't determine the loaded
        // set (e.g. /api/ps blipped while the host stayed up); carry forward the
        // last-known list rather than recording a false "all unloaded".
        const runningKnown = result.runningModels !== null;
        const resolvedRunning = result.runningModels ?? previousFullModels.get(server.id) ?? [];

        // Record snapshot
        const totalVramUsed = resolvedRunning.reduce(
          (sum, m) => sum + (m.size_vram ?? 0),
          0
        );

        const snapshotSignature = computeSnapshotSignature({
          isOnline: result.isOnline,
          ollamaVersion: result.version,
          loadedModels: resolvedRunning,
          availableModels: result.availableModels,
        });
        const cachedSnapshot = previousSnapshot.get(server.id);
        if (cachedSnapshot && cachedSnapshot.signature === snapshotSignature) {
          const updated = await db
            .update(serverSnapshots)
            .set({ polledAt: new Date() })
            .where(eq(serverSnapshots.id, cachedSnapshot.id))
            .returning({ id: serverSnapshots.id });
          // Row may have been pruned by retention; fall back to INSERT if so
          if (updated.length === 0) {
            const [inserted] = await db
              .insert(serverSnapshots)
              .values({
                serverId: server.id,
                isOnline: result.isOnline,
                ollamaVersion: result.version,
                loadedModels: resolvedRunning,
                availableModels: result.availableModels,
                totalVramUsed: totalVramUsed,
              })
              .returning({ id: serverSnapshots.id });
            previousSnapshot.set(server.id, { signature: snapshotSignature, id: inserted.id });
          }
        } else {
          const [inserted] = await db
            .insert(serverSnapshots)
            .values({
              serverId: server.id,
              isOnline: result.isOnline,
              ollamaVersion: result.version,
              loadedModels: resolvedRunning,
              availableModels: result.availableModels,
              totalVramUsed: totalVramUsed,
            })
            .returning({ id: serverSnapshots.id });
          previousSnapshot.set(server.id, { signature: snapshotSignature, id: inserted.id });
        }

        // Check for new models across the fleet
        await checkForNewModels(
          result.availableModels as OllamaAvailableModel[],
          server.name
        );

        // Store system metrics if available
        if (sysMetrics) {
          await db.insert(systemMetrics).values({
            serverId: server.id,
            cpuTempC: sysMetrics.temperatures.cpu != null ? Math.round(sysMetrics.temperatures.cpu) : null,
            gpuTempC: sysMetrics.temperatures.gpu != null ? Math.round(sysMetrics.temperatures.gpu) : null,
            cpuPercent: sysMetrics.cpu_percent != null ? Math.round(sysMetrics.cpu_percent) : null,
            gpuPercent: sysMetrics.gpu_percent != null ? Math.round(sysMetrics.gpu_percent) : null,
            memTotalMb: sysMetrics.memory.total_mb,
            memUsedMb: sysMetrics.memory.used_mb,
            memAvailableMb: sysMetrics.memory.available_mb,
            swapTotalMb: sysMetrics.memory.swap_total_mb,
            swapUsedMb: sysMetrics.memory.swap_used_mb,
            loadAvg1: Math.round(sysMetrics.load_avg[0] * 100),
            loadAvg5: Math.round(sysMetrics.load_avg[1] * 100),
            loadAvg15: Math.round(sysMetrics.load_avg[2] * 100),
            uptimeSeconds: sysMetrics.uptime_seconds,
            diskTotalGb: sysMetrics.disk.total_gb,
            diskUsedGb: sysMetrics.disk.used_gb,
            recentBoots: sysMetrics.recent_boots,
          });
        }

        // Skip alerts and notifications for disabled (maintenance) servers
        const isDisabled = server.isDisabled ?? false;

        // --- Consecutive failure gating ---
        // Only declare a server offline after OFFLINE_THRESHOLD consecutive failed polls
        // to filter out transient network blips and brief hiccups.
        const offlineThreshold = readPositiveIntEnv("OFFLINE_THRESHOLD", 3);
        let effectiveOnline = result.isOnline;

        if (!result.isOnline) {
          const count = (failureCount.get(server.id) ?? 0) + 1;
          failureCount.set(server.id, count);
          if (count < offlineThreshold) {
            // Not enough consecutive failures yet — treat as still online
            effectiveOnline = true;
          }
        } else {
          failureCount.set(server.id, 0);
        }

        // Check for alert conditions (skip if in maintenance)
        if (!isDisabled) {
          await checkServerAlerts(server.name, effectiveOnline, sysMetrics);
        }

        // --- Detect server lifecycle transitions ---
        const wasOnline = previousOnline.get(server.id);

        // Online/Offline transitions (skip first poll to avoid false positives)
        if (wasOnline !== undefined) {
          if (wasOnline && !effectiveOnline) {
            await db.insert(serverEvents).values({
              serverId: server.id,
              eventType: "offline",
              detail: isDisabled ? "maintenance" : null,
            });
            console.log(`[${server.name}] Server went offline${isDisabled ? " (maintenance)" : ""}`);
            if (!isDisabled) {
              await notifySubscribedUsers({
                serverId: server.id,
                serverName: server.name,
                eventType: "offline",
                detail: null,
              });
            }
          } else if (!wasOnline && effectiveOnline) {
            await db.insert(serverEvents).values({
              serverId: server.id,
              eventType: "online",
              detail: null,
            });
            console.log(`[${server.name}] Server came online`);
            if (!isDisabled) {
              await notifySubscribedUsers({
                serverId: server.id,
                serverName: server.name,
                eventType: "online",
                detail: null,
              });
            }
          }
        }
        previousOnline.set(server.id, effectiveOnline);

        // Reboot detection via boot list diffing
        if (sysMetrics?.recent_boots && sysMetrics.recent_boots.length > 0) {
          const currentBoots = new Set(sysMetrics.recent_boots);
          const prevBoots = previousBootSet.get(server.id);

          if (prevBoots) {
            for (const boot of currentBoots) {
              if (!prevBoots.has(boot)) {
                // New boot detected, look up cause from metrics
                const cause = sysMetrics.reboot_causes?.[boot];
                let detail: string | null = null;
                if (cause) {
                  if (cause.cause === "user_command") {
                    detail = cause.user
                      ? `${cause.detail} (${cause.user})`
                      : cause.detail;
                  } else if (cause.cause === "power_button") {
                    detail = cause.detail;
                  }
                  // For "unknown", leave detail null
                }

                await db.insert(serverEvents).values({
                  serverId: server.id,
                  eventType: "reboot",
                  detail,
                  occurredAt: new Date(boot),
                });
                console.log(`[${server.name}] Reboot detected: ${detail ?? "unknown cause"}${isDisabled ? " (maintenance)" : ""}`);
                if (!isDisabled) {
                  // Global env-chat alert (per-user alerts go via notifySubscribedUsers,
                  // which skips the env chat to avoid a duplicate).
                  if (isTelegramConfigured() && isWanUp()) {
                    await sendTelegramMessage(
                      `*🔄 Server Rebooted*\n\n*${server.name}*\nBoot detected at: ${boot}\nUptime: ${formatUptime(sysMetrics.uptime_seconds)}`
                    );
                  }
                  await notifySubscribedUsers({
                    serverId: server.id,
                    serverName: server.name,
                    eventType: "reboot",
                    detail,
                  });
                }
                break; // One event per poll cycle is enough
              }
            }
          }

          previousBootSet.set(server.id, currentBoots);
        }

        // --- Detect model changes ---
        // Only diff when this poll authoritatively knew the loaded set. A null
        // result (ps blip while host up) must not emit spurious unloaded events
        // or clobber previousModels — skip and let the next good poll diff.
        if (runningKnown) {
          const currentModelNames = new Set(
            resolvedRunning.map((m) => m.name)
          );
          const previousModelNames = previousModels.get(server.id) ?? new Set();

          // Build a lookup for model details
          const modelLookup = new Map<string, OllamaRunningModel>();
          for (const m of resolvedRunning) {
            modelLookup.set(m.name, m);
          }

          // New models (loaded)
          for (const name of currentModelNames) {
            if (!previousModelNames.has(name)) {
              const model = modelLookup.get(name);
              await db.insert(modelEvents).values({
                serverId: server.id,
                modelName: name,
                eventType: "loaded",
                modelSize: model?.size ?? 0,
                vramSize: model?.size_vram ?? 0,
                parameterSize: model?.details?.parameter_size ?? null,
                quantization: model?.details?.quantization_level ?? null,
              });
              console.log(`[${server.name}] Model loaded: ${name}`);
            }
          }

          // Removed models (unloaded)
          for (const name of previousModelNames) {
            if (!currentModelNames.has(name)) {
              await db.insert(modelEvents).values({
                serverId: server.id,
                modelName: name,
                eventType: "unloaded",
                modelSize: 0,
                vramSize: 0,
              });
              console.log(`[${server.name}] Model unloaded: ${name}`);
            }
          }

          // Update in-memory state
          previousModels.set(server.id, currentModelNames);
          previousFullModels.set(server.id, resolvedRunning);
          resetStuckEvictionIfUnloaded(server.id, currentModelNames);
        }
      } catch (err) {
        console.error(`Error polling ${server.name}:`, err);
      }
    })
  );
}

// --- Data retention cleanup ---

async function cleanOldData() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  await Promise.all([
    db.delete(serverSnapshots).where(sql`${serverSnapshots.polledAt} < ${sevenDaysAgo}`),
    db.delete(systemMetrics).where(sql`${systemMetrics.polledAt} < ${sevenDaysAgo}`),
    db.delete(serverEvents).where(sql`${serverEvents.occurredAt} < ${sevenDaysAgo}`),
    db.delete(requestLogs).where(sql`${requestLogs.createdAt} < ${sevenDaysAgo}`),
    db.delete(modelEvents).where(sql`${modelEvents.occurredAt} < ${thirtyDaysAgo}`),
    db.delete(modelDiscoveries).where(sql`${modelDiscoveries.discoveredAt} < ${ninetyDaysAgo}`),
  ]);
}

let pollInterval: ReturnType<typeof setInterval> | null = null;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

// --- Poller lifecycle ---

export async function startPoller() {
  // Retention cleanup runs independently of fleet config. request_logs is written
  // by the proxy process, so the time-series tables must be pruned even if this
  // process has no servers configured — otherwise they grow unbounded.
  cleanOldData().catch((err) => console.error("[Poller] Cleanup error:", err));
  cleanupInterval = setInterval(() => {
    cleanOldData().catch((err) => console.error("[Poller] Cleanup error:", err));
  }, 60 * 60 * 1000);

  const configs = getServerConfigs();
  if (configs.length === 0) {
    console.error("No servers configured, poller not starting");
    return;
  }

  // Build config lookup for per-server settings (e.g. metricsPort)
  for (const config of configs) {
    serverConfigMap.set(config.host, config);
  }

  console.log(`Starting poller for ${configs.length} servers...`);
  await ensureServersSeeded(configs);

  // Seed known models from existing discoveries
  await seedKnownFleetModels();

  // Initial poll
  await pollAllServers();

  // Poll on interval
  let intervalSec = 10;
  try {
    intervalSec = readPositiveIntEnv("POLL_INTERVAL", 10);
  } catch (err) {
    console.error(err instanceof Error ? err.message : "Invalid POLL_INTERVAL");
  }
  pollInterval = setInterval(() => {
    pollAllServers().catch((err) => console.error('[Poller] Poll cycle error:', err));
  }, intervalSec * 1000);
  console.log(`Polling every ${intervalSec}s`);

  // (Retention cleanup started above, before the no-servers early return.)

  // Start WAN health monitor (own interval, independent of fleet polling)
  startWanMonitor();
}

export { pollAllServers };
