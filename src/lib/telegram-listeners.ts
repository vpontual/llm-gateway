// Pure listener-set logic for the Telegram bot.
//
// Kept in its own module (no ./db import) so it is unit-testable — importing
// telegram-bot.ts pulls in the database layer, which requires DATABASE_URL at
// module load and cannot run under `node --test`.

/**
 * Every token that SHOULD have a live listener right now.
 *
 * syncUserBotListeners() reaps any listener whose token is missing from this
 * set, so anything omitted here gets silently killed. The global listener is
 * configured from env (TELEGRAM_BOT_TOKEN) and has no `user_telegram_configs`
 * row, so it must be seeded explicitly — leaving it out is what stopped the
 * global command bot ~60s after every startup ("Started global command
 * listener" immediately followed by "Stopped listener: global").
 *
 * Outbound alerts were never affected by that bug: sendTelegramMessage() reads
 * env directly and does not consult activeListeners.
 */
export function listenerTokenSet(
  globalToken: string | null | undefined,
  configs: readonly { botToken: string; isEnabled: boolean }[],
): Set<string> {
  const tokens = new Set<string>();
  if (globalToken) tokens.add(globalToken);
  for (const config of configs) {
    if (config.isEnabled) tokens.add(config.botToken);
  }
  return tokens;
}
