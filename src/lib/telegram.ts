// Telegram messaging -- global bot notifications via env-configured token

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export function isTelegramConfigured(): boolean {
  return !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
}

export function getTelegramConfig() {
  return { botToken: TELEGRAM_BOT_TOKEN, chatId: TELEGRAM_CHAT_ID };
}

const SEND_ATTEMPTS = 3;

/**
 * POST JSON to the Telegram Bot API with retry on transient failures so a
 * brief network blip (ETIMEDOUT reaching api.telegram.org) or a 5xx doesn't
 * silently drop an alert. 4xx is not retried (it won't fix itself). Returns
 * the final Response, or null if every attempt failed to connect.
 */
export async function postTelegramJson(url: string, payload: unknown): Promise<Response | null> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify(payload),
      });
      if (res.ok || res.status < 500) return res; // success or non-retryable
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < SEND_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    }
  }
  console.error(`[Telegram] send failed after ${SEND_ATTEMPTS} attempts:`, lastErr);
  return null;
}

export async function sendTelegramMessage(text: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await postTelegramJson(url, {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
  if (res && !res.ok) {
    console.error(`[Telegram] Send failed: ${res.status} ${res.statusText}`);
  }
}

