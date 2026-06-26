// Background-jobs leader election via a Postgres session-level advisory lock.
//
// The poller and Telegram bot must run on exactly ONE process. They keep
// coordination state in memory (poll dedup, alert cooldown, WAN monitor, bot
// getUpdates offset), so running them on a second replica produces duplicate
// snapshots, duplicate alerts, and getUpdates 409s. This guard makes the
// single-replica assumption enforced rather than assumed: only the lock holder
// runs them, so an accidental `replicas: 2` stays safe.
//
// The lock is held on a DEDICATED connection (not the shared pool) for the
// lifetime of the process — pg advisory locks are session-scoped, and a pooled
// connection could be handed to someone else and drop the lock.

import postgres from "postgres";

// Arbitrary app-specific constant key for the background-jobs lock.
const LEADER_LOCK_KEY = 4927310;

// Module-level so the connection (and thus the lock) lives for the process.
let lockClient: ReturnType<typeof postgres> | null = null;

/**
 * Try to become the background-jobs leader.
 * - Returns true (and holds the lock for the process lifetime) if acquired.
 * - Returns false if another process holds it — caller should stay passive.
 * - Fails OPEN (returns true) if the lock machinery errors, so a single-replica
 *   deploy never loses monitoring over a transient DB hiccup. Logs loudly.
 */
export async function tryAcquireLeader(): Promise<boolean> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return true; // db layer will surface the real error
  try {
    lockClient = postgres(connectionString, { max: 1 });
    const rows = await lockClient<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${LEADER_LOCK_KEY}) AS locked
    `;
    const locked = rows[0]?.locked === true;
    if (!locked) {
      await lockClient.end({ timeout: 5 }).catch(() => {});
      lockClient = null;
    }
    return locked;
  } catch (err) {
    console.error("[leader-lock] advisory lock failed, running jobs anyway:", err);
    return true; // fail open — single replica must keep monitoring
  }
}
