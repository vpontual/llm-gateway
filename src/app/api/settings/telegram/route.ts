// GET/PUT/DELETE /api/settings/telegram -- manage Telegram bot config

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { userTelegramConfigs } from "@/lib/schema";
import { withAuth } from "@/lib/api/route-helpers";
import { eq } from "drizzle-orm";
import { validateTelegramConfigInput } from "@/lib/validations/telegram";

export const dynamic = "force-dynamic";

export async function GET() {
  return withAuth(async (user) => {
    const [config] = await db
      .select()
      .from(userTelegramConfigs)
      .where(eq(userTelegramConfigs.userId, user.id))
      .limit(1);

    if (!config) return NextResponse.json(null);

    // Mask bot token -- only show last 8 chars for identification
    const masked = config.botToken.length > 8
      ? "****" + config.botToken.slice(-8)
      : "****";

    return NextResponse.json({
      chatId: config.chatId,
      botToken: masked,
      isEnabled: config.isEnabled,
    });
  });
}

export async function PUT(request: NextRequest) {
  return withAuth(async (user) => {
    const validation = validateTelegramConfigInput(await request.json());
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const { botToken, chatId, isEnabled } = validation.data;

    // Validate bot token by calling getMe
    try {
      const res = await fetch("https://api.telegram.org/bot" + botToken + "/getMe");
      if (!res.ok) {
        return NextResponse.json({ error: "Invalid bot token" }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: "Failed to validate bot token" }, { status: 400 });
    }

    // Upsert config
    const [existing] = await db
      .select({ id: userTelegramConfigs.id })
      .from(userTelegramConfigs)
      .where(eq(userTelegramConfigs.userId, user.id))
      .limit(1);

    if (existing) {
      await db
        .update(userTelegramConfigs)
        .set({ botToken, chatId, isEnabled })
        .where(eq(userTelegramConfigs.userId, user.id));
    } else {
      await db.insert(userTelegramConfigs).values({
        userId: user.id,
        botToken,
        chatId,
        isEnabled,
      });
    }

    // Send test message
    try {
      await fetch("https://api.telegram.org/bot" + botToken + "/sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "LLM Gateway: Telegram notifications configured successfully!",
        }),
      });
    } catch {
      // Non-fatal: config is saved regardless
    }

    return NextResponse.json({ ok: true });
  });
}

export async function DELETE() {
  return withAuth(async (user) => {
    await db.delete(userTelegramConfigs).where(eq(userTelegramConfigs.userId, user.id));
    return NextResponse.json({ ok: true });
  });
}
