-- request_logs.user_id was ON DELETE NO ACTION, so deleting a user that had any
-- request logs failed with an FK violation (unhandled 500). Switch to SET NULL:
-- the column is nullable, so audit rows are retained but anonymized, and user
-- deletion succeeds.
--
-- The existing constraint was created by raw SQL in 0006 without a name, so
-- Postgres auto-named it request_logs_user_id_fkey. Drop that (and the
-- drizzle-style name, defensively) before re-adding with the cascade rule.
ALTER TABLE "request_logs" DROP CONSTRAINT IF EXISTS "request_logs_user_id_fkey";

ALTER TABLE "request_logs" DROP CONSTRAINT IF EXISTS "request_logs_user_id_users_id_fk";

ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL;
