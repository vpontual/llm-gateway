// Shared "where should we pull a model to" selector, used by both the proxy
// router (the 404 pull hint) and the Telegram /pull_missing handler so they
// always agree. Lives in lib/ so neither the proxy nor lib imports the other.

/**
 * Pick the candidate with the most free VRAM. Callers pass only ONLINE servers,
 * each carrying a `freeVramBytes`.
 */
export function selectPullTarget<T extends { freeVramBytes: number }>(candidates: T[]): T | null {
  let best: T | null = null;
  for (const c of candidates) {
    if (!best || c.freeVramBytes > best.freeVramBytes) best = c;
  }
  return best;
}
