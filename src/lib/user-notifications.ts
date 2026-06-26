import { isWanUp } from "./wan-health";
// Per-user Telegram notifications for server events (offline, online, reboot)

import { db } from "./db";
import { userTelegramConfigs, userServerSubscriptions, users } from "./schema";
import { eq, and } from "drizzle-orm";
import { isTelegramConfigured, getTelegramConfig, postTelegramJson } from "./telegram";

interface ServerEventNotification {
  serverId: number;
  serverName: string;
  eventType: "offline" | "online" | "reboot";
  detail: string | null;
}

export async function notifySubscribedUsers(event: ServerEventNotification): Promise<void> {
  try {
    // Suppress user notifications during WAN outage (Telegram unreachable)
    if (!isWanUp()) {
      console.log(`[UserNotify] Suppressed ${event.eventType} for ${event.serverName} — WAN outage in progress`);
      return;
    }
    // Build the filter for the relevant notify boolean
    const notifyColumn =
      event.eventType === "offline"
        ? userServerSubscriptions.notifyOffline
        : event.eventType === "online"
          ? userServerSubscriptions.notifyOnline
          : userServerSubscriptions.notifyReboot;

    const subscribers = await db
      .select({
        botToken: userTelegramConfigs.botToken,
        chatId: userTelegramConfigs.chatId,
        username: users.username,
      })
      .from(userServerSubscriptions)
      .innerJoin(
        userTelegramConfigs,
        and(
          eq(userServerSubscriptions.userId, userTelegramConfigs.userId),
          eq(userTelegramConfigs.isEnabled, true)
        )
      )
      .innerJoin(users, eq(userServerSubscriptions.userId, users.id))
      .where(
        and(
          eq(userServerSubscriptions.serverId, event.serverId),
          eq(notifyColumn, true)
        )
      );

    // Avoid double-notifying the global env chat: the global alert path
    // (checkServerAlerts) already sends "offline" and "reboot" messages to the
    // env-configured chat, but never "online". So for those two event types,
    // drop the subscriber whose token+chat exactly matches the global config.
    let recipients = subscribers;
    if ((event.eventType === "offline" || event.eventType === "reboot") && isTelegramConfigured()) {
      const { botToken: envToken, chatId: envChat } = getTelegramConfig();
      recipients = subscribers.filter(
        (sub) => !(sub.botToken === envToken && sub.chatId === envChat)
      );
    }

    if (recipients.length === 0) return;

    const message = formatEventMessage(event);

    await Promise.allSettled(
      recipients.map((sub) => sendUserTelegram(sub.botToken, sub.chatId, message))
    );

    console.log(
      `[UserNotify] ${event.serverName} ${event.eventType}: notified ${recipients.length} user(s)`
    );
  } catch (err) {
    console.error("[UserNotify] Error:", err);
  }
}

async function sendUserTelegram(botToken: string, chatId: string, text: string): Promise<void> {
  const url = "https://api.telegram.org/bot" + botToken + "/sendMessage";
  const res = await postTelegramJson(url, {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
  if (res && !res.ok) {
    console.error("[UserNotify] Telegram send failed for chat " + chatId + ": " + res.status);
  }
}

function formatEventMessage(event: ServerEventNotification): string {
  switch (event.eventType) {
    case "offline":
      return "*\u26a0\ufe0f Server Offline*\n\n*" + event.serverName + "* is not responding.";
    case "online":
      return "*\u2705 Server Online*\n\n*" + event.serverName + "* is back online.";
    case "reboot":
      return "*\ud83d\udd04 Server Rebooted*\n\n*" + event.serverName + "* rebooted." +
        (event.detail ? "\n" + event.detail : "");
  }
}
