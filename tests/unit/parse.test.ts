import assert from "node:assert/strict";
import test from "node:test";
import { extractModel, extractModelFromParsed, injectProxyDefaults } from "../../src/proxy/parse";

test("extractModelFromParsed returns null for null/missing/non-string", () => {
  assert.equal(extractModelFromParsed(null), null);
  assert.equal(extractModelFromParsed({ foo: 1 }), null);
  assert.equal(extractModelFromParsed({ model: 5 }), null); // non-string ignored
});

test("extractModelFromParsed reads model, then falls back to name", () => {
  assert.equal(extractModelFromParsed({ model: "a" }), "a");
  assert.equal(extractModelFromParsed({ name: "b" }), "b");
  assert.equal(extractModelFromParsed({ model: "a", name: "b" }), "a");
});

test("extractModel parses model field from JSON body", () => {
  const body = Buffer.from(JSON.stringify({ model: "llama3:8b", prompt: "hello" }));
  assert.equal(extractModel(body), "llama3:8b");
});

test("extractModel parses name field (used by /api/copy and /api/create)", () => {
  const body = Buffer.from(JSON.stringify({ name: "my-custom-model" }));
  assert.equal(extractModel(body), "my-custom-model");
});

test("extractModel prefers model over name when both present", () => {
  const body = Buffer.from(JSON.stringify({ model: "llama3", name: "other" }));
  assert.equal(extractModel(body), "llama3");
});

test("extractModel returns null for empty body", () => {
  assert.equal(extractModel(Buffer.alloc(0)), null);
});

test("extractModel returns null for invalid JSON", () => {
  assert.equal(extractModel(Buffer.from("not json")), null);
});

test("extractModel returns null when no model or name field", () => {
  const body = Buffer.from(JSON.stringify({ prompt: "hello" }));
  assert.equal(extractModel(body), null);
});

test("extractModel handles OpenAI-format request", () => {
  const body = Buffer.from(JSON.stringify({
    model: "qwen3:8b",
    messages: [{ role: "user", content: "hi" }],
  }));
  assert.equal(extractModel(body), "qwen3:8b");
});

// --- injectProxyDefaults (defaults: keep_alive=30m, MIN_NUM_CTX=8192) ---

test("injectProxyDefaults injects keep_alive and num_ctx when both absent", () => {
  const { body, injected } = injectProxyDefaults(Buffer.from(JSON.stringify({ model: "m" })));
  const parsed = JSON.parse(body.toString());
  assert.equal(parsed.keep_alive, "30m");
  assert.equal(parsed.options.num_ctx, 8192);
  assert.ok(injected.includes("keep_alive=30m"));
  assert.ok(injected.includes("num_ctx=8192"));
});

test("injectProxyDefaults preserves an explicit keep_alive", () => {
  const { body, injected } = injectProxyDefaults(
    Buffer.from(JSON.stringify({ model: "m", keep_alive: "5m" }))
  );
  assert.equal(JSON.parse(body.toString()).keep_alive, "5m");
  assert.ok(!injected.some((i) => i.startsWith("keep_alive=")));
});

test("injectProxyDefaults adds num_ctx into an existing options object", () => {
  const { body, injected } = injectProxyDefaults(
    Buffer.from(JSON.stringify({ model: "m", keep_alive: "5m", options: { temperature: 0.2 } }))
  );
  const parsed = JSON.parse(body.toString());
  assert.equal(parsed.options.num_ctx, 8192);
  assert.equal(parsed.options.temperature, 0.2);
  assert.ok(injected.includes("num_ctx=8192"));
});

test("injectProxyDefaults flags but does not override a below-minimum num_ctx", () => {
  const { body, injected } = injectProxyDefaults(
    Buffer.from(JSON.stringify({ model: "m", keep_alive: "5m", options: { num_ctx: 2048 } }))
  );
  // keep_alive present + num_ctx explicitly set => body unchanged
  assert.equal(JSON.parse(body.toString()).options.num_ctx, 2048);
  assert.ok(injected.includes("num_ctx_low=2048"));
});

test("injectProxyDefaults makes no changes when keep_alive and a sufficient num_ctx are present", () => {
  const original = Buffer.from(JSON.stringify({ model: "m", keep_alive: "5m", options: { num_ctx: 16384 } }));
  const { body, injected } = injectProxyDefaults(original);
  assert.equal(body, original); // same buffer reference, not rebuilt
  assert.deepEqual(injected, []);
});

test("injectProxyDefaults returns the original body for invalid JSON", () => {
  const original = Buffer.from("not json");
  const { body, injected } = injectProxyDefaults(original);
  assert.equal(body, original);
  assert.deepEqual(injected, []);
});
