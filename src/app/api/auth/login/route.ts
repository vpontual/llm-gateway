// POST /api/auth/login -- validate credentials and create session

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import { eq } from "drizzle-orm";
import { verifyPassword, hashPassword, createSession, SESSION_COOKIE } from "@/lib/auth";
import { validateLoginInput } from "@/lib/validations/auth";
import { isProduction } from "@/lib/env";

export const dynamic = "force-dynamic";

// Basic in-memory brute-force throttle, per source IP. Single-replica deploy,
// so process-local state is sufficient.
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 5 * 60 * 1000;
const attempts = new Map<string, { count: number; resetAt: number }>();

function clientIp(request: NextRequest): string {
  const fwd = request.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : "unknown";
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  rec.count++;
  return rec.count > MAX_ATTEMPTS;
}

// Cached dummy hash so an unknown username still pays the bcrypt cost — avoids a
// timing oracle that would let an attacker enumerate valid usernames.
let dummyHash: string | null = null;

export async function POST(request: NextRequest) {
  const ip = clientIp(request);
  if (rateLimited(ip)) {
    return NextResponse.json({ error: "Too many attempts, try again later" }, { status: 429 });
  }

  const validation = validateLoginInput(await request.json());
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const { username, password } = validation.data;

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  if (!user) {
    if (!dummyHash) dummyHash = await hashPassword("timing-equalizer");
    await verifyPassword(password, dummyHash); // still run bcrypt to equalize timing
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  // Successful login: clear this IP's attempt counter.
  attempts.delete(ip);

  const sessionId = await createSession(user.id);

  const response = NextResponse.json({
    user: { id: user.id, username: user.username, isAdmin: user.isAdmin },
  });

  response.cookies.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });

  return response;
}
