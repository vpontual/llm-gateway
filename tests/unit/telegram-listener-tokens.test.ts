import assert from "node:assert/strict";
import test from "node:test";
import { listenerTokenSet } from "../../src/lib/telegram-listeners";

// Regression: the global (env-configured) listener has no user_telegram_configs
// row, so it was never added to the "still wanted" set and the reap loop in
// syncUserBotListeners deleted it ~60s after every startup. Outbound alerts kept
// working (they read env directly), so the command bot just quietly went deaf.
test("keeps the global env token even with no user configs", () => {
  const tokens = listenerTokenSet("global-token", []);
  assert.ok(tokens.has("global-token"));
});

test("keeps the global env token when every user config is disabled", () => {
  const tokens = listenerTokenSet("global-token", [
    { botToken: "user-a", isEnabled: false },
    { botToken: "user-b", isEnabled: false },
  ]);
  assert.ok(tokens.has("global-token"), "global listener must survive the reap");
  assert.equal(tokens.size, 1);
});

test("includes enabled user tokens and excludes disabled ones", () => {
  const tokens = listenerTokenSet("global-token", [
    { botToken: "user-a", isEnabled: true },
    { botToken: "user-b", isEnabled: false },
  ]);
  assert.deepEqual([...tokens].sort(), ["global-token", "user-a"]);
});

// VP's real shape: user 1's row holds the same token as the env global, so the
// set must dedupe rather than imply two pollers on one token (that is a 409).
test("dedupes when a user config repeats the global token", () => {
  const tokens = listenerTokenSet("shared-token", [
    { botToken: "shared-token", isEnabled: true },
  ]);
  assert.equal(tokens.size, 1);
});

test("omits the global entry when Telegram is not configured", () => {
  assert.equal(listenerTokenSet(null, []).size, 0);
  assert.equal(listenerTokenSet(undefined, []).size, 0);
  assert.equal(listenerTokenSet("", []).size, 0);
});
