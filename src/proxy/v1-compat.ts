// OpenAI /v1/chat/completions <-> Ollama native /api/chat conversion.
// All /v1/chat/completions requests are converted to native /api/chat format
// to ensure Ollama-specific features (think, num_ctx) work correctly and
// thinking model responses are properly handled. Responses are converted back.

import { Transform, type TransformCallback } from "node:stream";

interface ParsedV1Body {
  model?: string;
  messages?: unknown[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
  stop?: unknown;
  stream?: boolean;
  tools?: unknown[];
  think?: boolean;
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ConversionContext {
  model: string;
  isStreaming: boolean;
}

/**
 * Check if a /v1/chat/completions body should be converted to native /api/chat.
 *
 * Always converts: the native endpoint supports Ollama-specific fields (think,
 * options.num_ctx) that the OpenAI-compatible endpoint ignores. Converting all
 * /v1 requests ensures consistent behavior for thinking models (which return
 * reasoning content that breaks OpenAI-format clients) and allows options like
 * num_ctx to take effect.
 */
export function detectNativeConversion(body: Buffer): { parsed: ParsedV1Body; ctx: ConversionContext } | null {
  try {
    const parsed: ParsedV1Body = JSON.parse(body.toString());
    if (!parsed.model) return null;
    return {
      parsed,
      ctx: {
        model: (parsed.model as string) ?? "",
        isStreaming: parsed.stream !== false,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Convert OpenAI /v1/chat/completions request body to Ollama /api/chat format.
 */
/**
 * Convert OpenAI-format messages to Ollama native format.
 *
 * Key differences:
 * - OpenAI tool_calls have id, type, and JSON-string arguments
 * - Ollama tool_calls have only function.name and object arguments
 * - OpenAI tool messages have tool_call_id
 * - Ollama tool messages have no tool_call_id
 */
function convertMessagesToNative(messages: unknown[]): unknown[] {
  return messages.map((msgRaw) => {
    if (!msgRaw || typeof msgRaw !== "object") return msgRaw;
    const msg = msgRaw as Record<string, unknown>;
    const converted: Record<string, unknown> = { role: msg.role };

    // Flatten array content to string. OpenAI allows content as an array
    // of parts (e.g. [{"type":"text","text":"..."}]) but Ollama expects
    // a plain string.
    if (Array.isArray(msg.content)) {
      converted.content = (msg.content as Array<Record<string, unknown>>)
        .filter((p) => p?.type === "text")
        .map((p) => (p.text as string) ?? "")
        .join("");
    } else if (msg.content !== undefined) {
      converted.content = msg.content;
    }

    // Convert assistant tool_calls from OpenAI to Ollama format
    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      converted.tool_calls = (msg.tool_calls as unknown[]).map((tcRaw) => {
        const tc = (tcRaw ?? {}) as Record<string, unknown>;
        const fn = (tc.function ?? {}) as Record<string, unknown>;
        return {
          function: {
            name: fn.name ?? tc.name,
            arguments:
              typeof fn.arguments === "string"
                ? (() => { try { return JSON.parse(fn.arguments); } catch { return {}; } })()
                : fn.arguments ?? {},
          },
        };
      });
    }

    // Strip tool_call_id from tool messages (Ollama does not use it)
    // All other fields are passed through
    return converted;
  });
}

export function convertRequestToNative(parsed: ParsedV1Body): Buffer {
  const native: Record<string, unknown> = {
    model: parsed.model,
    messages: convertMessagesToNative(parsed.messages ?? []),
    stream: parsed.stream ?? true,
  };

  if (parsed.think !== undefined) native.think = parsed.think;
  if (parsed.tools) native.tools = parsed.tools;
  if (parsed.stop !== undefined) native.stop = parsed.stop;

  // Merge OpenAI params into Ollama options
  const options: Record<string, unknown> = {
    ...(typeof parsed.options === "object" && parsed.options !== null
      ? (parsed.options as Record<string, unknown>)
      : {}),
  };
  if (parsed.temperature !== undefined) options.temperature = parsed.temperature;
  if (parsed.top_p !== undefined) options.top_p = parsed.top_p;
  if (parsed.max_tokens !== undefined) options.num_predict = parsed.max_tokens;
  if (parsed.frequency_penalty !== undefined) options.frequency_penalty = parsed.frequency_penalty;
  if (parsed.presence_penalty !== undefined) options.presence_penalty = parsed.presence_penalty;
  if (parsed.seed !== undefined) options.seed = parsed.seed;

  // Pass through Ollama-native options sent at the top level of the request
  // (e.g. num_ctx, num_gpu, num_thread, repeat_penalty, mirostat, etc.).
  // This lets clients like opencode include Ollama-specific params alongside
  // standard OpenAI fields without needing a nested "options" object.
  const ollamaPassthrough = [
    "num_ctx", "num_gpu", "num_thread", "num_keep", "num_batch",
    "repeat_penalty", "repeat_last_n", "mirostat", "mirostat_tau",
    "mirostat_eta", "penalize_newline", "num_predict", "tfs_z", "typical_p",
    "min_p", "top_k"
  ];
  for (const key of ollamaPassthrough) {
    if (parsed[key] !== undefined && options[key] === undefined) options[key] = parsed[key];
  }

  if (Object.keys(options).length > 0) native.options = options;

  return Buffer.from(JSON.stringify(native));
}

/**
 * Convert Ollama tool_calls to OpenAI format (arguments as JSON string, with id/type).
 */
function convertToolCalls(toolCalls: unknown[]): unknown[] {
  return toolCalls.map((tcRaw, i: number) => {
    const fn = ((tcRaw as Record<string, unknown>)?.function ?? {}) as Record<string, unknown>;
    return {
      index: i,
      id: `call_${Date.now()}_${i}`,
      type: "function",
      function: {
        name: fn.name,
        arguments:
          typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments),
      },
    };
  });
}

/**
 * Convert a non-streaming Ollama /api/chat response to OpenAI format.
 */
export function convertResponseToV1(responseBody: Buffer, model: string): Buffer {
  try {
    const native = JSON.parse(responseBody.toString());
    const message = native.message ?? { role: "assistant", content: "" };

    if (message.tool_calls) {
      message.tool_calls = convertToolCalls(message.tool_calls);
    }

    // Remove Ollama-specific reasoning field so it does not leak into content
    delete message.reasoning;

    const v1 = {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: native.model ?? model,
      system_fingerprint: `fp_ollama`,
      choices: [
        {
          index: 0,
          message,
          finish_reason: message.tool_calls ? "tool_calls" : (native.done_reason ?? "stop"),
        },
      ],
      usage: {
        prompt_tokens: native.prompt_eval_count ?? 0,
        completion_tokens: native.eval_count ?? 0,
        total_tokens: (native.prompt_eval_count ?? 0) + (native.eval_count ?? 0),
      },
    };
    return Buffer.from(JSON.stringify(v1));
  } catch {
    return responseBody;
  }
}

/**
 * Create a Transform stream that converts Ollama streaming /api/chat to OpenAI SSE.
 *
 * Ollama sends newline-delimited JSON:
 *   {"model":"x","message":{"role":"assistant","content":"H"},"done":false}\n
 *
 * OpenAI expects SSE:
 *   data: {"id":"x","object":"chat.completion.chunk","choices":[{"delta":{"content":"H"}}]}\n\n
 */
export function createV1StreamTransform(model: string): Transform {
  const chatId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  let buffer = "";
  let sentRole = false;
  let sentToolCalls = false;

  return new Transform({
    transform(chunk: Buffer, _encoding: string, callback: TransformCallback) {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const native = JSON.parse(line);
          if (native.done) {
            // Final chunk
            const final_chunk = {
              id: chatId,
              object: "chat.completion.chunk",
              created,
              model: native.model ?? model,
              system_fingerprint: "fp_ollama",
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: (native.message?.tool_calls || sentToolCalls) ? "tool_calls" : (native.done_reason ?? "stop"),
                },
              ],
              usage: {
                prompt_tokens: native.prompt_eval_count ?? 0,
                completion_tokens: native.eval_count ?? 0,
                total_tokens:
                  (native.prompt_eval_count ?? 0) + (native.eval_count ?? 0),
              },
            };
            this.push(`data: ${JSON.stringify(final_chunk)}\n\n`);
            this.push("data: [DONE]\n\n");
          } else {
            const msg = native.message ?? {};
            const delta: Record<string, unknown> = {};
            if (!sentRole && msg.role) {
              delta.role = msg.role;
              sentRole = true;
            }
            if (msg.content) delta.content = msg.content;
            if (msg.tool_calls) {
              sentToolCalls = true;
              delta.tool_calls = convertToolCalls(msg.tool_calls);
            }
            // Skip chunks with empty delta (e.g. reasoning-only chunks)
            if (Object.keys(delta).length === 0) continue;

            const chunk_data = {
              id: chatId,
              object: "chat.completion.chunk",
              created,
              model: native.model ?? model,
              system_fingerprint: "fp_ollama",
              choices: [{ index: 0, delta, finish_reason: null }],
            };
            this.push(`data: ${JSON.stringify(chunk_data)}\n\n`);
          }
        } catch {
          // Skip unparseable lines
        }
      }
      callback();
    },

    flush(callback: TransformCallback) {
      if (buffer.trim()) {
        try {
          const native = JSON.parse(buffer);
          if (native.done) {
            this.push("data: [DONE]\n\n");
          }
        } catch {
          // Ignore
        }
      }
      callback();
    },
  });
}
