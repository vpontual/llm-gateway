// Authentication -- password hashing, sessions, API keys

import { db } from "./db";
import { users, sessions } from "./schema";
import { eq, lt } from "drizzle-orm";
import { cookies } from "next/headers";
import { hashPassword, verifyPassword, generateApiKey } from "./crypto";
import { hashApiKey } from "./api-key-hash";

export { hashPassword, verifyPassword, generateApiKey, hashApiKey };

const SESSION_COOKIE = "fleet_session";
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function createSession(userId: number): Promise<string> {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);

  await db.insert(sessions).values({
    id: sessionId,
    userId,
    expiresAt,
  });

  return sessionId;
}

export async function getSessionUser() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  if (!sessionId) return null;

  const [session] = await db
    .select({ userId: sessions.userId, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  if (!session || session.expiresAt < new Date()) return null;

  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
      isAdmin: users.isAdmin,
      apiKey: users.apiKey,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  return user ?? null;
}

export async function requireAuth() {
  const user = await getSessionUser();
  if (!user) throw new Error("Unauthorized");
  return user;
}

export async function requireAdmin() {
  const user = await requireAuth();
  if (!user.isAdmin) throw new Error("Forbidden");
  return user;
}

export async function isFirstUser(): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).limit(1);
  return !row;
}

export async function deleteExpiredSessions(): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}

export { SESSION_COOKIE };
