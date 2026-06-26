// Telegram bot -- responds to /status, /last_reboot, /pull_missing commands

import { db } from "./db";
import { servers, serverSnapshots, systemMetrics, serverEvents, userTelegramConfigs, requestLogs, users } from "./schema";
import { eq, desc, and, isNotNull } from "drizzle-orm";
import { getTelegramConfig, isTelegramConfigured } from "./telegram";
import { selectPullTarget } from "./pull-target";
import { formatUptime, timeAgo } from "./format";

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
  };
}



async function sendReply(botToken: string, chatId: number, text: string): Promise<void> {
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.error(`[TelegramBot] Reply failed: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.error("[TelegramBot] Reply error:", err);
  }
}

// --- Bot commands ---

async function handleStatus(botToken: string, chatId: number): Promise<void> {
  const allServers = await db.select().from(servers);
  const lines: string[] = ["*Fleet Status*\n"];

  for (const server of allServers) {
    const [snap] = await db
      .select()
      .from(serverSnapshots)
      .where(eq(serverSnapshots.serverId, server.id))
      .orderBy(desc(serverSnapshots.polledAt))
      .limit(1);

    const [metrics] = await db
      .select()
      .from(systemMetrics)
      .where(eq(systemMetrics.serverId, server.id))
      .orderBy(desc(systemMetrics.polledAt))
      .limit(1);

    if (!snap) {
      lines.push(`\u2753 *${server.name}* - no data`);
      continue;
    }

    const icon = snap.isOnline ? "\u2705" : "\u274c";
    const uptime = metrics?.uptimeSeconds
      ? formatUptime(metrics.uptimeSeconds)
      : "?";

    const models = (snap.loadedModels as Array<{ name: string }>) ?? [];
    const modelInfo =
      models.length > 0
        ? models.map((m) => m.name).join(", ")
        : "no models loaded";

    if (snap.isOnline) {
      lines.push(`${icon} *${server.name}* - online (${uptime}) - ${modelInfo}`);
    } else {
      lines.push(`${icon} *${server.name}* - offline`);
    }
  }

  await sendReply(botToken, chatId, lines.join("\n"));
}

async function handleLastReboot(botToken: string, chatId: number): Promise<void> {
  const allServers = await db.select().from(servers);
  const lines: string[] = ["*Recent Reboots*\n"];

  for (const server of allServers) {
    const [reboot] = await db
      .select()
      .from(serverEvents)
      .where(
        and(
          eq(serverEvents.serverId, server.id),
          eq(serverEvents.eventType, "reboot")
        )
      )
      .orderBy(desc(serverEvents.occurredAt))
      .limit(1);

    if (!reboot) {
      lines.push(`*${server.name}* - no reboots recorded`);
      continue;
    }

    const ago = timeAgo(reboot.occurredAt.toISOString());
    const detail = reboot.detail ?? "unknown cause";
    lines.push(`*${server.name}* - ${ago} - ${detail}`);
  }

  await sendReply(botToken, chatId, lines.join("\n"));
}

/**
 * Find the best online server to pull a model to (most free VRAM).
 */
async function findBestPullServer(): Promise<{
  name: string;
  host: string;
  totalRamGb: number;
  freeVramGb: number;
} | null> {
  const allServers = await db.select().from(servers);
  const candidates: { server: (typeof allServers)[number]; freeVramBytes: number }[] = [];

  for (const server of allServers) {
    const [snap] = await db
      .select()
      .from(serverSnapshots)
      .where(eq(serverSnapshots.serverId, server.id))
      .orderBy(desc(serverSnapshots.polledAt))
      .limit(1);

    if (!snap?.isOnline) continue;

    candidates.push({
      server,
      freeVramBytes: server.totalRamGb * 1024 * 1024 * 1024 - (snap.totalVramUsed ?? 0),
    });
  }

  const best = selectPullTarget(candidates);
  if (!best) return null;

  return {
    name: best.server.name,
    host: best.server.host,
    totalRamGb: best.server.totalRamGb,
    freeVramGb: Math.round((best.freeVramBytes / (1024 * 1024 * 1024)) * 10) / 10,
  };
}

/**
 * Handle /pull_missing: download the most recent missing model to the best server.
 * Accepts optional model name: /pull_missing <model>
 */
async function handlePullMissing(botToken: string, chatId: number, args: string): Promise<void> {
  let modelName = args.trim();

  // If no model specified, find the most recent 404 from request_logs
  if (!modelName) {
    const [recent] = await db
      .select({ model: requestLogs.model })
      .from(requestLogs)
      .where(
        and(
          eq(requestLogs.statusCode, 404),
          isNotNull(requestLogs.model)
        )
      )
      .orderBy(desc(requestLogs.createdAt))
      .limit(1);

    if (!recent?.model) {
      await sendReply(botToken, chatId, "No recent missing models found.");
      return;
    }
    modelName = recent.model;
  }

  // Find best server
  const target = await findBestPullServer();
  if (!target) {
    await sendReply(botToken, chatId, "\u274c No online servers available for pulling.");
    return;
  }

  await sendReply(
    botToken,
    chatId,
    `\u2b07\ufe0f Pulling *${modelName}* to *${target.name}* (${target.freeVramGb} GB free of ${target.totalRamGb} GB)...\n\nThis may take a while for large models.`
  );

  try {
    const controller = new AbortController();
    // 30-minute timeout for very large model downloads
    const timeout = setTimeout(() => controller.abort(), 1800000);

    const res = await fetch(`http://${target.host}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelName, stream: false }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      await sendReply(
        botToken,
        chatId,
        `\u2705 *${modelName}* pulled to *${target.name}* successfully!`
      );
    } else {
      const body = await res.text();
      await sendReply(
        botToken,
        chatId,
        `\u274c Pull failed (${res.status}): ${body.slice(0, 300)}`
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort")) {
      await sendReply(botToken, chatId, `\u274c Pull timed out after 30 minutes.`);
    } else {
      await sendReply(botToken, chatId, `\u274c Pull error: ${msg}`);
    }
  }
}

async function handleHelp(botToken: string, chatId: number): Promise<void> {
  const text = [
    "*Available Commands*\n",
    "/status - Show fleet status: online/offline state, uptime, and loaded models for each server",
    "/last_reboot - Show the most recent reboot for each server with timestamp and cause",
    "/pull_missing - Download the last missing model to the best server",
    "/pull_missing <model> - Download a specific model to the best server",
    "/help - Show this list of commands",
  ].join("\n");
  await sendReply(botToken, chatId, text);
}

// --- Command dispatcher ---

async function processCommand(botToken: string, chatId: number, text: string, isAdmin: boolean): Promise<void> {
  // Strip @botname suffix and normalize
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase().split("@")[0];
  const args = parts.slice(1).join(" ");

  if (cmd === "/status") {
    await handleStatus(botToken, chatId);
  } else if (cmd === "/last_reboot" || cmd === "/lastreboot") {
    await handleLastReboot(botToken, chatId);
  } else if (cmd === "/pull_missing" || cmd === "/pullmissing") {
    // /pull_missing triggers model downloads on the fleet — admins only.
    if (!isAdmin) {
      await sendReply(botToken, chatId, "⛔ /pull_missing is admin-only.");
      return;
    }
    await handlePullMissing(botToken, chatId, args);
  } else if (cmd === "/help" || cmd === "/start") {
    await handleHelp(botToken, chatId);
  }
}

// --- Bot listener management --- loop management ---

interface BotListener {
  botToken: string;
  chatId: string;
  label: string;
  lastUpdateId: number;
  running: boolean;
  // Consecutive poll failures. Drives exponential backoff and log suppression.
  errorStreak: number;
  // Whether this bot's owner may run admin commands (e.g. /pull_missing).
  isAdmin: boolean;
}

// Normal cadence between long-polls; backoff grows from here on failure.
const BASE_POLL_DELAY_MS = 1000;
const MAX_POLL_BACKOFF_MS = 60_000;

const activeListeners = new Map<string, BotListener>();

async function pollBotUpdates(listener: BotListener): Promise<void> {
  try {
    const url = `https://api.telegram.org/bot${listener.botToken}/getUpdates?offset=${listener.lastUpdateId + 1}&timeout=30&allowed_updates=["message"]`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      // A 409 means another getUpdates poller owns this token (e.g. a second
      // gateway instance during a migration or scale-up — Telegram allows only
      // one poller per bot). Back off instead of hammering once per second and
      // flooding the logs. Log only the first failure of a streak.
      if (listener.errorStreak === 0) {
        const hint =
          res.status === 409
            ? " — another instance is polling this bot token; backing off"
            : " — backing off";
        console.error(`[TelegramBot:${listener.label}] getUpdates failed: ${res.status}${hint}`);
      }
      listener.errorStreak++;
      return;
    }

    if (listener.errorStreak > 0) {
      console.log(
        `[TelegramBot:${listener.label}] getUpdates recovered after ${listener.errorStreak} failure(s)`
      );
      listener.errorStreak = 0;
    }

    const data = await res.json();
    const updates: TelegramUpdate[] = data.result ?? [];

    for (const update of updates) {
      listener.lastUpdateId = Math.max(listener.lastUpdateId, update.update_id);
      const msg = update.message;
      if (!msg?.text) continue;

      // Only respond to the configured chat for this bot
      if (String(msg.chat.id) !== listener.chatId) continue;

      try {
        await processCommand(listener.botToken, msg.chat.id, msg.text, listener.isAdmin);
      } catch (err) {
        console.error(`[TelegramBot:${listener.label}] Error processing command:`, err);
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") return;
    if (listener.errorStreak === 0) {
      console.error(`[TelegramBot:${listener.label}] Poll error:`, err);
    }
    listener.errorStreak++;
  }
}

function startBotLoop(listener: BotListener): void {
  listener.running = true;

  const loop = async () => {
    while (listener.running) {
      await pollBotUpdates(listener);
      const delay =
        listener.errorStreak === 0
          ? BASE_POLL_DELAY_MS
          : Math.min(BASE_POLL_DELAY_MS * 2 ** listener.errorStreak, MAX_POLL_BACKOFF_MS);
      await new Promise((r) => setTimeout(r, delay));
    }
  };

  loop().catch((err) => {
    console.error(`[TelegramBot:${listener.label}] Fatal error:`, err);
    listener.running = false;
  });
}

async function syncUserBotListeners(): Promise<void> {
  try {
    const configs = await db
      .select({
        botToken: userTelegramConfigs.botToken,
        chatId: userTelegramConfigs.chatId,
        userId: userTelegramConfigs.userId,
        isEnabled: userTelegramConfigs.isEnabled,
        isAdmin: users.isAdmin,
      })
      .from(userTelegramConfigs)
      .innerJoin(users, eq(userTelegramConfigs.userId, users.id));

    const currentTokens = new Set<string>();

    for (const config of configs) {
      if (!config.isEnabled) continue;
      currentTokens.add(config.botToken);

      // Skip if already listening on this token
      if (activeListeners.has(config.botToken)) continue;

      const listener: BotListener = {
        botToken: config.botToken,
        chatId: config.chatId,
        label: `user-${config.userId}`,
        lastUpdateId: 0,
        running: false,
        errorStreak: 0,
        isAdmin: config.isAdmin,
      };

      activeListeners.set(config.botToken, listener);
      startBotLoop(listener);
      console.log(`[TelegramBot] Started listener for user-${config.userId}`);
    }

    // Stop listeners for removed/disabled configs
    for (const [token, listener] of activeListeners) {
      if (!currentTokens.has(token)) {
        listener.running = false;
        activeListeners.delete(token);
        console.log(`[TelegramBot] Stopped listener: ${listener.label}`);
      }
    }
  } catch (err) {
    console.error("[TelegramBot] Error syncing user listeners:", err);
  }
}

export async function startTelegramBot(): Promise<void> {
  // Start global bot listener (from env vars) if configured
  if (isTelegramConfigured()) {
    const { botToken, chatId } = getTelegramConfig();
    if (botToken && chatId) {
      const globalListener: BotListener = {
        botToken,
        chatId,
        label: "global",
        lastUpdateId: 0,
        running: false,
        errorStreak: 0,
        isAdmin: true, // env-configured global bot is the operator's
      };
      activeListeners.set(botToken, globalListener);
      startBotLoop(globalListener);
      console.log("[TelegramBot] Started global command listener");
    }
  }

  // Start per-user bot listeners
  await syncUserBotListeners();

  // Re-sync every 60s to pick up new/changed/removed user configs
  setInterval(syncUserBotListeners, 60000);
}
