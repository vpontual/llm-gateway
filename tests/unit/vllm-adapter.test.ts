import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import {
  adaptRequestOllamaToVllm,
  adaptResponseVllmToOllama,
  createVllmToOllamaStreamTransform,
  type VllmAdaptContext,
} from "../../src/proxy/vllm-adapter";

// --- helpers ---

function parseJsonBuf(buf: Buffer): any {
  return JSON.parse(buf.toString());
}

function buf(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj));
}

function makeCtx(overrides: Partial<VllmAdaptContext> & { clientPath: string }): VllmAdaptContext {
  return {
    model: "qwen3.5:35b",
    isStreaming: false,
    startedAt: Date.now() - 100,
    ...overrides,
  };
}

async function runStream(input: string[], ctx: VllmAdaptContext): Promise<string[]> {
  const transform = createVllmToOllamaStreamTransform(ctx);
  const src = Readable.from(input.map((s) => Buffer.from(s)));
  const chunks: string[] = [];
  src.pipe(transform);
  for await (const chunk of transform) {
    chunks.push(chunk.toString());
  }
  // NDJSON frames are one line each; split incoming chunks on newlines
  return chunks
    .join("")
    .split("\n")
    .filter((l) => l.length > 0);
}

// --- adaptRequestOllamaToVllm ---

test("adapter: /api/generate -> /v1/completions with option mapping", () => {
  const result = adaptRequestOllamaToVllm(
    "/api/generate",
    buf({
      model: "qwen3.5:35b",
      prompt: "Hello",
      stream: false,
      options: { temperature: 0.7, top_p: 0.9, num_predict: 128, seed: 42, repeat_penalty: 1.1 },
      keep_alive: "30m",
    }),
  );
  assert.ok(result);
  assert.equal(result.path, "/v1/completions");
  const body = parseJsonBuf(result.body);
  assert.equal(body.model, "qwen3.5:35b");
  assert.equal(body.prompt, "Hello");
  assert.equal(body.stream, false);
  assert.equal(body.temperature, 0.7);
  assert.equal(body.top_p, 0.9);
  assert.equal(body.max_tokens, 128);
  assert.equal(body.seed, 42);
  assert.equal(body.repetition_penalty, 1.1);
  // Ollama-only fields dropped
  assert.equal(body.keep_alive, undefined);
  assert.equal(body.options, undefined);
  // Streaming is off, so no stream_options
  assert.equal(body.stream_options, undefined);
});

test("adapter: /api/generate streaming adds stream_options.include_usage", () => {
  const result = adaptRequestOllamaToVllm(
    "/api/generate",
    buf({ model: "m", prompt: "hi", stream: true }),
  );
  assert.ok(result);
  const body = parseJsonBuf(result.body);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
});

test("adapter: existing stream_options keys are preserved when include_usage is forced on", () => {
  const result = adaptRequestOllamaToVllm(
    "/api/chat",
    buf({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { foo: "bar", include_usage: false },
    }),
  );
  assert.ok(result);
  const body = parseJsonBuf(result.body);
  assert.equal(body.stream_options.foo, "bar");
  // include_usage is always forced on so the final chunk has usage.
  assert.equal(body.stream_options.include_usage, true);
});

test("adapter: /api/generate defaults stream to true (no stream field)", () => {
  const result = adaptRequestOllamaToVllm("/api/generate", buf({ model: "m", prompt: "hi" }));
  assert.ok(result);
  const body = parseJsonBuf(result.body);
  // No stream field in body means Ollama defaults to true; adapter injects stream_options.
  assert.deepEqual(body.stream_options, { include_usage: true });
});

test("adapter: /api/generate format='json' translates to response_format json_object", () => {
  const result = adaptRequestOllamaToVllm(
    "/api/generate",
    buf({ model: "m", prompt: "extract", stream: false, format: "json" }),
  );
  assert.ok(result);
  const body = parseJsonBuf(result.body);
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("adapter: /api/chat format='json' translates to response_format json_object", () => {
  const result = adaptRequestOllamaToVllm(
    "/api/chat",
    buf({
      model: "m",
      messages: [{ role: "user", content: "extract" }],
      stream: false,
      format: "json",
    }),
  );
  assert.ok(result);
  const body = parseJsonBuf(result.body);
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("adapter: /api/chat format=<schema> translates to response_format json_schema", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, age: { type: "integer" } },
    required: ["name"],
  };
  const result = adaptRequestOllamaToVllm(
    "/api/chat",
    buf({
      model: "m",
      messages: [{ role: "user", content: "extract" }],
      stream: false,
      format: schema,
    }),
  );
  assert.ok(result);
  const body = parseJsonBuf(result.body);
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema, schema);
});

test("adapter: missing/empty format produces no response_format field", () => {
  for (const fmt of [undefined, null, ""]) {
    const result = adaptRequestOllamaToVllm(
      "/api/chat",
      buf({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
        ...(fmt !== undefined ? { format: fmt } : {}),
      }),
    );
    assert.ok(result);
    const body = parseJsonBuf(result.body);
    assert.equal(body.response_format, undefined, `format=${JSON.stringify(fmt)} should not emit response_format`);
  }
});

test("adapter: /api/chat -> /v1/chat/completions preserves messages", () => {
  const result = adaptRequestOllamaToVllm(
    "/api/chat",
    buf({
      model: "qwen3.5:35b",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hi" },
      ],
      stream: false,
    }),
  );
  assert.ok(result);
  assert.equal(result.path, "/v1/chat/completions");
  const body = parseJsonBuf(result.body);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[1].content, "Hi");
});

test("adapter: /api/chat tool_calls stringify arguments from Ollama object to OpenAI string", () => {
  const result = adaptRequestOllamaToVllm(
    "/api/chat",
    buf({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "get_weather", arguments: { city: "Boston" } } }],
        },
        { role: "tool", content: "sunny", tool_call_id: "call_0" },
      ],
      tools: [{ type: "function", function: { name: "get_weather" } }],
      stream: false,
    }),
  );
  assert.ok(result);
  const body = parseJsonBuf(result.body);
  const tc = body.messages[0].tool_calls[0];
  assert.equal(tc.type, "function");
  assert.equal(typeof tc.function.arguments, "string");
  assert.deepEqual(JSON.parse(tc.function.arguments), { city: "Boston" });
  // Tool result message preserves tool_call_id
  assert.equal(body.messages[1].tool_call_id, "call_0");
  assert.ok(Array.isArray(body.tools));
});

test("adapter: /api/embed -> /v1/embeddings with input passthrough", () => {
  const result = adaptRequestOllamaToVllm(
    "/api/embed",
    buf({ model: "nomic-embed-text", input: ["hello", "world"] }),
  );
  assert.ok(result);
  assert.equal(result.path, "/v1/embeddings");
  const body = parseJsonBuf(result.body);
  assert.deepEqual(body.input, ["hello", "world"]);
});

test("adapter: /api/embeddings (legacy) maps prompt -> input", () => {
  const result = adaptRequestOllamaToVllm(
    "/api/embeddings",
    buf({ model: "nomic", prompt: "hello" }),
  );
  assert.ok(result);
  const body = parseJsonBuf(result.body);
  assert.equal(body.input, "hello");
});

test("adapter: unsupported path returns null", () => {
  assert.equal(adaptRequestOllamaToVllm("/api/pull", buf({ model: "x" })), null);
});

test("adapter: malformed JSON returns null", () => {
  assert.equal(
    adaptRequestOllamaToVllm("/api/chat", Buffer.from("not json")),
    null,
  );
});

// --- adaptResponseVllmToOllama ---

test("adapter: /v1/completions response -> Ollama /api/generate shape", () => {
  const ctx = makeCtx({ clientPath: "/api/generate" });
  const buf = adaptResponseVllmToOllama(
    Buffer.from(
      JSON.stringify({
        id: "cmpl-1",
        model: "qwen3.5:35b",
        choices: [{ text: "Hello world", finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }),
    ),
    ctx,
  );
  const out = parseJsonBuf(buf);
  assert.equal(out.model, "qwen3.5:35b");
  assert.equal(out.response, "Hello world");
  assert.equal(out.done, true);
  assert.equal(out.done_reason, "stop");
  assert.equal(out.prompt_eval_count, 4);
  assert.equal(out.eval_count, 2);
  assert.equal(typeof out.total_duration, "number");
  assert.ok(out.total_duration > 0);
});

test("adapter: /v1/chat/completions response -> Ollama /api/chat shape", () => {
  const ctx = makeCtx({ clientPath: "/api/chat" });
  const buf = adaptResponseVllmToOllama(
    Buffer.from(
      JSON.stringify({
        id: "chatcmpl-1",
        model: "qwen3.5:35b",
        choices: [
          {
            message: { role: "assistant", content: "Hi there!" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      }),
    ),
    ctx,
  );
  const out = parseJsonBuf(buf);
  assert.equal(out.message.role, "assistant");
  assert.equal(out.message.content, "Hi there!");
  assert.equal(out.done_reason, "stop");
  assert.equal(out.eval_count, 3);
});

test("adapter: chat response with tool_calls parses arguments back to object", () => {
  const ctx = makeCtx({ clientPath: "/api/chat" });
  const buf = adaptResponseVllmToOllama(
    Buffer.from(
      JSON.stringify({
        model: "m",
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_0",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"Boston"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      }),
    ),
    ctx,
  );
  const out = parseJsonBuf(buf);
  assert.equal(out.done_reason, "tool_calls");
  assert.deepEqual(out.message.tool_calls[0].function.arguments, { city: "Boston" });
  assert.equal(out.message.tool_calls[0].function.name, "get_weather");
});

test("adapter: /v1/embeddings response -> /api/embed (embeddings array)", () => {
  const ctx = makeCtx({ clientPath: "/api/embed" });
  const buf = adaptResponseVllmToOllama(
    Buffer.from(
      JSON.stringify({
        model: "nomic",
        data: [
          { embedding: [0.1, 0.2], index: 0, object: "embedding" },
          { embedding: [0.3, 0.4], index: 1, object: "embedding" },
        ],
        usage: { prompt_tokens: 8 },
      }),
    ),
    ctx,
  );
  const out = parseJsonBuf(buf);
  assert.deepEqual(out.embeddings, [[0.1, 0.2], [0.3, 0.4]]);
  assert.equal(out.prompt_eval_count, 8);
});

test("adapter: /v1/embeddings response -> legacy /api/embeddings (single vector)", () => {
  const ctx = makeCtx({ clientPath: "/api/embeddings" });
  const buf = adaptResponseVllmToOllama(
    Buffer.from(
      JSON.stringify({
        model: "nomic",
        data: [{ embedding: [0.5, 0.6], index: 0, object: "embedding" }],
      }),
    ),
    ctx,
  );
  const out = parseJsonBuf(buf);
  assert.deepEqual(out.embedding, [0.5, 0.6]);
});

test("adapter: malformed response body is returned unchanged", () => {
  const ctx = makeCtx({ clientPath: "/api/chat" });
  const raw = Buffer.from("not valid json");
  const out = adaptResponseVllmToOllama(raw, ctx);
  assert.equal(out.toString(), "not valid json");
});

test("adapter: response with empty choices array uses sensible defaults", () => {
  const ctx = makeCtx({ clientPath: "/api/generate" });
  const buf = adaptResponseVllmToOllama(
    Buffer.from(JSON.stringify({ model: "m", choices: [] })),
    ctx,
  );
  const out = parseJsonBuf(buf);
  assert.equal(out.response, "");
  assert.equal(out.done, true);
  assert.equal(out.done_reason, "stop");
  assert.equal(out.prompt_eval_count, 0);
  assert.equal(out.eval_count, 0);
});

// --- createVllmToOllamaStreamTransform ---

test("stream: /api/generate converts text deltas to NDJSON response frames", async () => {
  const ctx = makeCtx({ clientPath: "/api/generate", isStreaming: true });
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ text: "Hello" }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ text: " world" }] })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ text: "", finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    })}\n\n`,
    `data: [DONE]\n\n`,
  ];
  const out = await runStream(chunks, ctx);
  assert.ok(out.length >= 3, `expected >=3 frames, got ${out.length}`);
  const parsed = out.map((l) => JSON.parse(l));
  assert.equal(parsed[0].response, "Hello");
  assert.equal(parsed[1].response, " world");
  const done = parsed[parsed.length - 1];
  assert.equal(done.done, true);
  assert.equal(done.done_reason, "stop");
  assert.equal(done.prompt_eval_count, 3);
  assert.equal(done.eval_count, 2);
});

test("stream: /api/chat converts delta.content to NDJSON message frames", async () => {
  const ctx = makeCtx({ clientPath: "/api/chat", isStreaming: true });
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "Hi" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: " there" } }] })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    })}\n\n`,
    `data: [DONE]\n\n`,
  ];
  const out = await runStream(chunks, ctx);
  const parsed = out.map((l) => JSON.parse(l));
  assert.equal(parsed[0].message.role, "assistant");
  assert.equal(parsed[0].message.content, "Hi");
  assert.equal(parsed[1].message.content, " there");
  const done = parsed[parsed.length - 1];
  assert.equal(done.done, true);
  assert.equal(done.prompt_eval_count, 5);
});

test("stream: /api/chat accumulates tool_call fragments and emits them on done", async () => {
  const ctx = makeCtx({ clientPath: "/api/chat", isStreaming: true });
  const chunks = [
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_0",
                type: "function",
                function: { name: "get_weather", arguments: '{"cit' },
              },
            ],
          },
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: 'y":"Boston"}' } }],
          },
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 7 },
    })}\n\n`,
    `data: [DONE]\n\n`,
  ];
  const out = await runStream(chunks, ctx);
  const parsed = out.map((l) => JSON.parse(l));
  const done = parsed[parsed.length - 1];
  assert.equal(done.done, true);
  assert.equal(done.done_reason, "tool_calls");
  const tc = done.message.tool_calls?.[0];
  assert.ok(tc, "expected tool_calls on done frame");
  assert.equal(tc.function.name, "get_weather");
  assert.deepEqual(tc.function.arguments, { city: "Boston" });
});

test("stream: upstream ends without [DONE] still emits a done frame", async () => {
  const ctx = makeCtx({ clientPath: "/api/generate", isStreaming: true });
  const chunks = [`data: ${JSON.stringify({ choices: [{ text: "hi" }] })}\n\n`];
  const out = await runStream(chunks, ctx);
  const parsed = out.map((l) => JSON.parse(l));
  assert.equal(parsed[0].response, "hi");
  const done = parsed[parsed.length - 1];
  assert.equal(done.done, true);
});

test("stream: handles split-across-chunks SSE framing", async () => {
  const ctx = makeCtx({ clientPath: "/api/generate", isStreaming: true });
  const payload = JSON.stringify({ choices: [{ text: "hello" }] });
  // Deliberately split mid-event across two chunks.
  const chunks = [`data: ${payload.slice(0, 15)}`, `${payload.slice(15)}\n\n`];
  const out = await runStream(chunks, ctx);
  const parsed = out.map((l) => JSON.parse(l));
  assert.equal(parsed[0].response, "hello");
});

test("stream: skips unparseable SSE events and keeps going", async () => {
  const ctx = makeCtx({ clientPath: "/api/generate", isStreaming: true });
  const chunks = [
    `data: not-json-at-all\n\n`,
    `data: ${JSON.stringify({ choices: [{ text: "ok" }] })}\n\n`,
    `data: [DONE]\n\n`,
  ];
  const out = await runStream(chunks, ctx);
  const parsed = out.map((l) => JSON.parse(l));
  assert.equal(parsed[0].response, "ok");
  assert.equal(parsed[parsed.length - 1].done, true);
});
