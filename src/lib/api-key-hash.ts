// API keys are stored as a SHA-256 hash, never plaintext. The plaintext is
// shown once at generation; every later comparison hashes the incoming key.
// Separate from crypto.ts so the proxy bundle doesn't pull in bcryptjs.
import { createHash } from "node:crypto";

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
