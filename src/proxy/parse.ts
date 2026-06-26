// Request body parsing and injection utilities for the Ollama proxy

/**
 * Extract the model name from an Ollama API request body.
 * Handles both "model" (standard) and "name" (used by /api/copy, /api/create) fields.
 */
/**
 * Extract the model name from an already-parsed request body. Lets the proxy
 * parse the body once and reuse it instead of re-parsing per helper.
 */
export function extractModelFromParsed(parsed: Record<string, unknown> | null): string | null {
  if (!parsed) return null;
  const m = parsed.model ?? parsed.name;
  return typeof m === "string" ? m : null;
}

export function extractModel(body: Buffer): string | null {
  try {
    return extractModelFromParsed(JSON.parse(body.toString()) as Record<string, unknown>);
  } catch {
    return null;
  }
}

// Configurable defaults via env vars
const DEFAULT_KEEP_ALIVE = process.env.PROXY_DEFAULT_KEEP_ALIVE ?? "30m";
const MIN_NUM_CTX = parseInt(process.env.PROXY_MIN_NUM_CTX ?? "8192", 10);

/**
 * Inject proxy defaults into a request body for generation endpoints:
 *
 * - keep_alive: Set to DEFAULT_KEEP_ALIVE (default "30m") if not specified.
 *   Uses explicit duration, never -1 (which causes models to never unload
 *   even when new requests need VRAM).
 *
 * - num_ctx: Ensures a minimum context window (default 8192) by injecting
 *   options.num_ctx if the request doesn't specify one. Ollama defaults to
 *   4096 which silently truncates context for most use cases.
 *
 * Returns the modified body buffer, or the original if no changes were needed
 * or the body isn't valid JSON.
 */
export function injectProxyDefaults(body: Buffer): { body: Buffer; injected: string[] } {
  const injected: string[] = [];

  try {
    const parsed = JSON.parse(body.toString());
    let modified = false;

    // Inject keep_alive if not specified
    if (parsed.keep_alive === undefined) {
      parsed.keep_alive = DEFAULT_KEEP_ALIVE;
      injected.push(`keep_alive=${DEFAULT_KEEP_ALIVE}`);
      modified = true;
    }

    // Inject minimum num_ctx if not specified in options
    if (MIN_NUM_CTX > 0) {
      if (!parsed.options) {
        parsed.options = { num_ctx: MIN_NUM_CTX };
        injected.push(`num_ctx=${MIN_NUM_CTX}`);
        modified = true;
      } else if (parsed.options.num_ctx === undefined) {
        parsed.options.num_ctx = MIN_NUM_CTX;
        injected.push(`num_ctx=${MIN_NUM_CTX}`);
        modified = true;
      } else if (parsed.options.num_ctx < MIN_NUM_CTX) {
        // Don't override if explicitly set below minimum — the caller
        // might have a reason (e.g. constrained VRAM). Just log it.
        injected.push(`num_ctx_low=${parsed.options.num_ctx}`);
      }
    }

    if (!modified) return { body, injected };
    const newBody = Buffer.from(JSON.stringify(parsed));
    return { body: newBody, injected };
  } catch {
    return { body, injected };
  }
}
