// GET/PATCH/DELETE /api/users/:id -- manage individual user (self or admin)

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import { hashPassword } from "@/lib/auth";
import { forbiddenResponse, isSelfOrAdmin, jsonError, withAuth } from "@/lib/api/route-helpers";
import { eq } from "drizzle-orm";
import { validateNumericId } from "@/lib/validations/numbers";
import { validateUserUpdateInput } from "@/lib/validations/users";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAuth(async (caller) => {
    const { id } = await params;
    const targetIdValidation = validateNumericId(id, "user ID");
    if (!targetIdValidation.ok) {
      return jsonError(targetIdValidation.error, 400);
    }
    const targetId = targetIdValidation.data;
    const bodyValidation = validateUserUpdateInput(await request.json());
    if (!bodyValidation.ok) {
      return jsonError(bodyValidation.error, 400);
    }
    const body = bodyValidation.data;

    // Non-admin can only change their own password
    if (!isSelfOrAdmin(caller, targetId)) {
      return forbiddenResponse();
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (body.password) {
      updates.passwordHash = await hashPassword(body.password);
    }

    if (caller.isAdmin && body.isAdmin !== undefined) {
      updates.isAdmin = body.isAdmin;
    }

    await db.update(users).set(updates).where(eq(users.id, targetId));

    return NextResponse.json({ ok: true });
  });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return withAuth(async (caller) => {
    if (!caller.isAdmin) {
      return forbiddenResponse();
    }

    const { id } = await params;
    const targetIdValidation = validateNumericId(id, "user ID");
    if (!targetIdValidation.ok) {
      return jsonError(targetIdValidation.error, 400);
    }
    const targetId = targetIdValidation.data;

    if (caller.id === targetId) {
      return NextResponse.json({ error: "Cannot delete yourself" }, { status: 400 });
    }

    try {
      await db.delete(users).where(eq(users.id, targetId));
    } catch (err) {
      console.error(`Failed to delete user ${targetId}:`, err);
      return jsonError("Failed to delete user", 500);
    }
    return NextResponse.json({ ok: true });
  });
}
