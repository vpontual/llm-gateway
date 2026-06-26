// Ollama <-> vLLM (OpenAI /v1) request and response translation.
//
// Runs AFTER routing selects a vLLM backend. Lets upstream services keep using
// Ollama-native endpoints (/api/generate, /api/chat, /api/embed) while the
// chosen backend speaks OpenAI /v1/* under the hood.
//
// Non-streaming: request is rewritten, response is buffered and translated back.
// Streaming: response is an SSE stream from vLLM; a Transform adapter emits
// Ollama-shaped NDJSON frames.

import { Transform, type TransformCallback } from "node:stream";

// --- Context passed from server.ts into the adapters ---

export interface VllmAdaptContext {
  /** Path the client originally called, e.g. "/api/chat". */
  clientPath: string;
  /** Model name requested by the client (same identifier vLLM advertises). */
  model: string;
  /** Whether this request expects a streamed response. */
  isStreaming: boolean;
  /** Wall-clock start (ms since epoch) for synthesizing total_duration. */
  startedAt: number;
  /** OWUI reasoning path: prepend a <think> opener so reasoning is a balanced pair OWUI can parse. */
  wrapReasoning?: boolean;
}

// --- Request translation (Ollama-native -> OpenAI /v1) ---

export interface AdaptedRequest {
  path: string;
  body: Buffer;
}

/**
 * Map Ollama `options.*` keys to equivalent OpenAI /v1 params.
 * Unknown keys are silently dropped (vLLM rejects unknown fields).
 * Ollama-only keys (num_ctx, num_gpu, num_thread, keep_alive, mirostat*) are
 * dropped intentionally — vLLM owns serving configuration.
 */
function mapOptionsToVllm(
  options: Record<string, unknown> | undefined,
  target: Record<string, unknown>,
): void {
  if (!options || typeof options !== "object") return;
  if (typeof options.temperature === "number") target.temperature = options.temperature;
  if (typeof options.top_p === "number") target.top_p = options.top_p;
  if (typeof options.top_k === "number") target.top_k = options.top_k;
  if (typeof options.min_p === "number") target.min_p = options.min_p;
  if (typeof options.num_predict === "number") target.max_tokens = options.num_predict;
  if (typeof options.seed === "number") target.seed = options.seed;
  if (options.stop !== undefined) target.stop = options.stop;
  if (typeof options.repeat_penalty === "number") {
    // vLLM exposes this as repetition_penalty (extra OpenAI body field).
    target.repetition_penalty = options.repeat_penalty;
  }
  if (typeof options.frequency_penalty === "number") {
    target.frequency_penalty = options.frequency_penalty;
  }
  if (typeof options.presence_penalty === "number") {
    target.presence_penalty = options.presence_penalty;
  }
}

/** Convert Ollama historical messages to OpenAI shape (tool_call args stringified).
 *
 * Critical: synthesizes `tool_call_id` for tool-role messages that are missing
 * it. The Ollama API threads tool results to calls implicitly (by message
 * order), but OpenAI requires an explicit `tool_call_id`. vLLM with the Qwen3
 * chat template rejects requests where tool messages can't be linked back —
 * the user-visible failure is "No user query found in messages." (HTTP 400).
 *
 * We track the last assistant's tool_call IDs and assign them to subsequent
 * tool-role messages by positional order. If a client already provides a
 * tool_call_id, we honor it.
 */
function messagesOllamaToVllm(messages: unknown[]): unknown[] {
  let lastToolCallIds: string[] = [];
  let toolCursor = 0;
  return messages.map((m, msgIdx) => {
    if (!m || typeof m !== "object") return m;
    const src = m as Record<string, unknown>;
    const out: Record<string, unknown> = { role: src.role };
    if (src.content !== undefined) out.content = src.content;
    if (Array.isArray(src.tool_calls)) {
      const synthesized: string[] = [];
      out.tool_calls = src.tool_calls.map((tcRaw, i: number) => {
        const tc = (tcRaw ?? {}) as Record<string, unknown>;
        const fn = (tc.function ?? {}) as Record<string, unknown>;
        const args =
          typeof fn.arguments === "string"
            ? (fn.arguments as string)
            : JSON.stringify(fn.arguments ?? {});
        // Stable, request-scoped id — pairs with tool_call_id below.
        const id = (tc.id as string | undefined) ?? `call_${msgIdx}_${i}`;
        synthesized.push(id);
        return {
          id,
          type: "function",
          function: { name: fn.name, arguments: args },
        };
      });
      // Reset tool-result cursor so subsequent tool messages can claim these.
      lastToolCallIds = synthesized;
      toolCursor = 0;
    }
    if (src.role === "tool") {
      // Honor a client-provided tool_call_id; otherwise synthesize from the
      // most recent assistant's tool_calls by positional order.
      if (src.tool_call_id !== undefined) {
        out.tool_call_id = src.tool_call_id;
      } else if (toolCursor < lastToolCallIds.length) {
        out.tool_call_id = lastToolCallIds[toolCursor];
      }
      toolCursor += 1;
      if (src.name !== undefined) out.name = src.name;
    } else if (src.tool_call_id !== undefined) {
      out.tool_call_id = src.tool_call_id;
    }
    return out;
  });
}

/**
 * Translate Ollama's `format` field into OpenAI's `response_format`. Ollama
 * accepts either the literal string "json" (loose JSON mode) or a JSON schema
 * object (strict schema-constrained mode). vLLM supports both via OpenAI's
 * response_format.
 */
function applyOllamaFormat(parsed: Record<string, unknown>, target: Record<string, unknown>): void {
  const fmt = parsed.format;
  if (fmt === undefined || fmt === null || fmt === "") return;
  if (fmt === "json") {
    target.response_format = { type: "json_object" };
    return;
  }
  if (typeof fmt === "object") {
    // Schema-constrained. OpenAI expects {type: "json_schema", json_schema:
    // {name, schema, strict}}. Ollama sends a bare JSON Schema object.
    target.response_format = {
      type: "json_schema",
      json_schema: {
        name: "ollama_format_schema",
        schema: fmt,
        strict: true,
      },
    };
  }
}

function adaptGenerate(parsed: Record<string, unknown>): AdaptedRequest {
  const body: Record<string, unknown> = {
    model: parsed.model,
    prompt: (parsed.prompt as string | undefined) ?? "",
  };
  if (parsed.stream !== undefined) body.stream = parsed.stream;
  if (typeof parsed.suffix === "string") body.suffix = parsed.suffix;
  mapOptionsToVllm(parsed.options as Record<string, unknown> | undefined, body);
  applyOllamaFormat(parsed, body);
  if (parsed.stream !== false) mergeStreamOptions(parsed, body);
  return { path: "/v1/completions", body: Buffer.from(JSON.stringify(body)) };
}

/**
 * Merge `{include_usage: true}` into the target body's stream_options without
 * clobbering any client-provided keys. Ollama clients don't normally send this
 * field but an OpenAI-shaped client could hit /api/chat via the adapter.
 */
function mergeStreamOptions(parsed: Record<string, unknown>, target: Record<string, unknown>): void {
  const existing =
    typeof parsed.stream_options === "object" && parsed.stream_options !== null
      ? (parsed.stream_options as Record<string, unknown>)
      : {};
  target.stream_options = { ...existing, include_usage: true };
}

/**
 * Qwen3-family models support a `chat_template_kwargs.enable_thinking` flag that
 * toggles the model between Thinking and Instruct (non-thinking) modes via the
 * tokenizer's chat template. Other vLLM-served models don't recognize it (Jinja
 * templates ignore unknown kwargs), but we still gate on Qwen3 to be safe.
 */
function isQwen3Model(model: unknown): boolean {
  if (typeof model !== "string") return false;
  return /qwen3/i.test(model);
}

function adaptChat(parsed: Record<string, unknown>): AdaptedRequest {
  const body: Record<string, unknown> = {
    model: parsed.model,
    messages: messagesOllamaToVllm(Array.isArray(parsed.messages) ? parsed.messages : []),
  };
  if (parsed.stream !== undefined) body.stream = parsed.stream;
  if (Array.isArray(parsed.tools)) body.tools = parsed.tools;
  if (parsed.tool_choice !== undefined) body.tool_choice = parsed.tool_choice;
  mapOptionsToVllm(parsed.options as Record<string, unknown> | undefined, body);
  applyOllamaFormat(parsed, body);
  if (parsed.stream !== false) mergeStreamOptions(parsed, body);
  // Translate Ollama-shape `think: false` → vLLM `chat_template_kwargs.enable_thinking=false`
  // for Qwen3 models. Without this, `think: false` is silently dropped and the
  // model thinks regardless. `think: true` is the model's default — no kwargs needed.
  if (parsed.think === false && isQwen3Model(parsed.model)) {
    const existing = (body.chat_template_kwargs as Record<string, unknown> | undefined) ?? {};
    body.chat_template_kwargs = { ...existing, enable_thinking: false };
  }
  return { path: "/v1/chat/completions", body: Buffer.from(JSON.stringify(body)) };
}

function adaptEmbed(parsed: Record<string, unknown>): AdaptedRequest {
  // /api/embed uses `input`; legacy /api/embeddings uses `prompt`. vLLM wants `input`.
  const input =
    parsed.input !== undefined ? parsed.input : (parsed.prompt as string | undefined) ?? "";
  const body: Record<string, unknown> = { model: parsed.model, input };
  return { path: "/v1/embeddings", body: Buffer.from(JSON.stringify(body)) };
}

/**
 * Translate an Ollama-native request into an OpenAI /v1 request for vLLM.
 * Returns null if the path is not translatable (caller should 400).
 */
export function adaptRequestOllamaToVllm(path: string, body: Buffer): AdaptedRequest | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString() || "{}") as Record<string, unknown>;
  } catch {
    return null;
  }
  if (path === "/api/generate") return adaptGenerate(parsed);
  if (path === "/api/chat") return adaptChat(parsed);
  if (path === "/api/embed" || path === "/api/embeddings") return adaptEmbed(parsed);
  return null;
}

// --- Response translation (OpenAI /v1 -> Ollama-native) ---

function parseToolCallArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function openAiToolCallsToOllama(toolCalls: unknown): unknown[] | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined;
  return toolCalls.map((tcRaw) => {
    const tc = (tcRaw ?? {}) as Record<string, unknown>;
    const fn = (tc.function ?? {}) as Record<string, unknown>;
    return {
      function: {
        name: fn.name,
        arguments: parseToolCallArgs(fn.arguments),
      },
    };
  });
}

/**
 * Translate a non-streaming vLLM response back into the Ollama-native shape
 * that matches the client's original endpoint.
 */
export function adaptResponseVllmToOllama(buf: Buffer, ctx: VllmAdaptContext): Buffer {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(buf.toString()) as Record<string, unknown>;
  } catch {
    return buf;
  }

  const totalDurationNs = Math.max(0, (Date.now() - ctx.startedAt) * 1_000_000);
  const model = (data.model as string | undefined) ?? ctx.model;
  const usage = (data.usage ?? {}) as Record<string, unknown>;
  const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const completionTokens =
    typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  const choices = Array.isArray(data.choices) ? (data.choices as Record<string, unknown>[]) : [];
  const choice = choices[0] ?? {};
  const finishReason = (choice.finish_reason as string | undefined) ?? "stop";

  if (ctx.clientPath === "/api/generate") {
    const text = (choice.text as string | undefined) ?? "";
    const out = {
      model,
      created_at: new Date().toISOString(),
      response: text,
      done: true,
      done_reason: finishReason,
      context: [] as number[],
      total_duration: totalDurationNs,
      load_duration: 0,
      prompt_eval_count: promptTokens,
      prompt_eval_duration: 0,
      eval_count: completionTokens,
      eval_duration: totalDurationNs,
    };
    return Buffer.from(JSON.stringify(out));
  }

  if (ctx.clientPath === "/api/chat") {
    const message = (choice.message ?? {}) as Record<string, unknown>;
    const toolCalls = openAiToolCallsToOllama(message.tool_calls);
    const chatContent = (message.content as string | undefined) ?? "";
    const ollamaMessage: Record<string, unknown> = {
      role: (message.role as string | undefined) ?? "assistant",
      content: chatContent,
    };
    if (ctx.wrapReasoning) {
      const ci = chatContent.indexOf("</think>");
      if (ci !== -1) {
        const thinking = chatContent.slice(0, ci).replace(/^<think>\s*/, "").trim();
        ollamaMessage.content = chatContent.slice(ci + "</think>".length).replace(/^\s+/, "");
        if (thinking) ollamaMessage.thinking = thinking;
      }
    }
    if (toolCalls) ollamaMessage.tool_calls = toolCalls;
    const out = {
      model,
      created_at: new Date().toISOString(),
      message: ollamaMessage,
      done: true,
      done_reason: toolCalls ? "tool_calls" : finishReason,
      total_duration: totalDurationNs,
      load_duration: 0,
      prompt_eval_count: promptTokens,
      prompt_eval_duration: 0,
      eval_count: completionTokens,
      eval_duration: totalDurationNs,
    };
    return Buffer.from(JSON.stringify(out));
  }

  if (ctx.clientPath === "/api/embed" || ctx.clientPath === "/api/embeddings") {
    const dataArr = Array.isArray(data.data) ? (data.data as Record<string, unknown>[]) : [];
    const embeddings = dataArr.map((e) => e.embedding as number[]);
    if (ctx.clientPath === "/api/embed") {
      return Buffer.from(
        JSON.stringify({
          model,
          embeddings,
          total_duration: totalDurationNs,
          load_duration: 0,
          prompt_eval_count: promptTokens,
        }),
      );
    }
    // Legacy /api/embeddings is single-vector shape.
    return Buffer.from(JSON.stringify({ embedding: embeddings[0] ?? [] }));
  }

  return buf;
}

// --- Streaming transform (vLLM SSE -> Ollama NDJSON) ---

/**
 * Parse SSE data lines out of a raw chunk buffer. Returns the list of parsed
 * events and the residual (incomplete) suffix to carry forward.
 *
 * SSE framing: events separated by blank lines (\n\n or \r\n\r\n). Each event
 * contains one or more `data:` lines; for OpenAI streams there is exactly one
 * data line per event, optionally `[DONE]` as the sentinel.
 */
function drainSseEvents(buffer: string): { events: string[]; residual: string } {
  const events: string[] = [];
  const splitter = /\r?\n\r?\n/;
  const parts = buffer.split(splitter);
  const residual = parts.pop() ?? "";
  for (const part of parts) {
    const lines = part.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      events.push(trimmed.slice(5).trim());
    }
  }
  return { events, residual };
}

/**
 * Create a Transform that converts a vLLM SSE response stream into
 * Ollama-native NDJSON. One NDJSON frame per output delta, plus a final
 * `done: true` frame that carries usage and finish_reason.
 *
 * Tool calls arrive as incremental argument fragments over many deltas. We
 * accumulate them and emit the assembled tool_calls once on the done frame
 * (matching Ollama's own streaming behavior of emitting tool calls whole).
 */
export function createVllmToOllamaStreamTransform(ctx: VllmAdaptContext): Transform {
  let buffer = "";
  let doneEmitted = false;
  let roleEmitted = false;
  let reasoningPhase = ctx.wrapReasoning === true;
  let thinkBuf = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let finishReason: string | null = null;
  const accumulatedToolCalls = new Map<number, { id?: string; name?: string; args: string }>();

  const emitDone = (push: (frame: string) => void) => {
    if (doneEmitted) return;
    doneEmitted = true;
    const totalDurationNs = Math.max(0, (Date.now() - ctx.startedAt) * 1_000_000);
    const toolCalls =
      accumulatedToolCalls.size > 0
        ? [...accumulatedToolCalls.values()].map((t) => ({
            function: {
              name: t.name ?? "",
              arguments: (() => {
                const raw = t.args || "";
                try {
                  return JSON.parse(raw || "{}");
                } catch (parseErr) {
                  // vLLM tool-call parsers (e.g. qwen3_xml) occasionally emit
                  // malformed JSON for tool arguments (model interleaves reasoning
                  // and the parser drops content). Warn and return {} instead of
                  // throwing. No sync file I/O here — this runs in the streaming
                  // hot path.
                  console.warn(
                    `[vllm-adapter] malformed tool_call args: name=${t.name ?? "?"} err=${(parseErr as Error).message} raw=${JSON.stringify(raw.slice(0, 200))}`
                  );
                  return {};
                }
              })(),
            },
          }))
        : null;

    if (ctx.clientPath === "/api/generate") {
      const frame = {
        model: ctx.model,
        created_at: new Date().toISOString(),
        response: "",
        done: true,
        done_reason: finishReason ?? "stop",
        context: [] as number[],
        total_duration: totalDurationNs,
        load_duration: 0,
        prompt_eval_count: promptTokens,
        prompt_eval_duration: 0,
        eval_count: completionTokens,
        eval_duration: totalDurationNs,
      };
      push(JSON.stringify(frame) + "\n");
      return;
    }

    const message: Record<string, unknown> = { role: "assistant", content: "" };
    if (toolCalls) message.tool_calls = toolCalls;
    const frame = {
      model: ctx.model,
      created_at: new Date().toISOString(),
      message,
      done: true,
      done_reason: toolCalls ? "tool_calls" : (finishReason ?? "stop"),
      total_duration: totalDurationNs,
      load_duration: 0,
      prompt_eval_count: promptTokens,
      prompt_eval_duration: 0,
      eval_count: completionTokens,
      eval_duration: totalDurationNs,
    };
    push(JSON.stringify(frame) + "\n");
  };

  return new Transform({
    transform(chunk: Buffer, _enc: string, callback: TransformCallback) {
      buffer += chunk.toString();
      const { events, residual } = drainSseEvents(buffer);
      buffer = residual;

      for (const payload of events) {
        if (!payload) continue;
        if (payload === "[DONE]") {
          emitDone((b) => this.push(b));
          continue;
        }

        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue;
        }

        const usage = ev.usage as Record<string, unknown> | undefined;
        if (usage) {
          if (typeof usage.prompt_tokens === "number") promptTokens = usage.prompt_tokens;
          if (typeof usage.completion_tokens === "number") {
            completionTokens = usage.completion_tokens;
          }
        }

        const choices = Array.isArray(ev.choices) ? (ev.choices as Record<string, unknown>[]) : [];
        const choice = choices[0];
        if (!choice) continue;
        if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;

        if (ctx.clientPath === "/api/generate") {
          const text = (choice.text as string | undefined) ?? "";
          if (text) {
            const frame = {
              model: ctx.model,
              created_at: new Date().toISOString(),
              response: text,
              done: false,
            };
            this.push(JSON.stringify(frame) + "\n");
          }
          continue;
        }

        // /api/chat streaming: OpenAI uses delta.content and delta.tool_calls.
        const delta = (choice.delta ?? {}) as Record<string, unknown>;
        if (Array.isArray(delta.tool_calls)) {
          for (const tcRaw of delta.tool_calls) {
            const tc = (tcRaw ?? {}) as Record<string, unknown>;
            const idx = typeof tc.index === "number" ? tc.index : 0;
            const entry = accumulatedToolCalls.get(idx) ?? { args: "" };
            if (typeof tc.id === "string") entry.id = tc.id;
            const fn = (tc.function ?? {}) as Record<string, unknown>;
            if (typeof fn.name === "string" && fn.name) entry.name = fn.name;
            if (typeof fn.arguments === "string") entry.args += fn.arguments;
            accumulatedToolCalls.set(idx, entry);
          }
          continue;
        }

        let content = (delta.content as string | undefined) ?? "";
        if (content || (!roleEmitted && typeof delta.role === "string")) {
          const role = (delta.role as string | undefined) ?? "assistant";
          if (ctx.wrapReasoning && reasoningPhase && content) {
            thinkBuf += content;
            const ci = thinkBuf.indexOf("</think>");
            if (ci === -1) {
              // Hold back up to 7 chars in case "</think>" straddles two chunks.
              const cut = Math.max(0, thinkBuf.length - 7);
              const emit = thinkBuf.slice(0, cut);
              thinkBuf = thinkBuf.slice(cut);
              if (emit) {
                this.push(
                  JSON.stringify({ model: ctx.model, created_at: new Date().toISOString(), message: { role, thinking: emit }, done: false }) + "\n",
                );
                roleEmitted = true;
              }
              continue;
            }
            const before = thinkBuf.slice(0, ci).replace(/^<think>\s*/, "");
            const after = thinkBuf.slice(ci + "</think>".length).replace(/^\s+/, "");
            if (before) {
              this.push(
                JSON.stringify({ model: ctx.model, created_at: new Date().toISOString(), message: { role, thinking: before }, done: false }) + "\n",
              );
              roleEmitted = true;
            }
            reasoningPhase = false;
            thinkBuf = "";
            content = after;
            if (!content) continue;
          }
          const frame = {
            model: ctx.model,
            created_at: new Date().toISOString(),
            message: { role, content },
            done: false,
          };
          this.push(JSON.stringify(frame) + "\n");
          roleEmitted = true;
        }
      }
      callback();
    },

    flush(callback: TransformCallback) {
      // If the upstream closed without sending [DONE], still emit a done frame
      // so the client gets a well-formed NDJSON stream.
      emitDone((b) => this.push(b));
      callback();
    },
  });
}
