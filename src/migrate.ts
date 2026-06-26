// Standalone one-shot migration runner. Bundled via esbuild (like proxy.js) so
// it runs in the Next.js standalone runtime image, which has no drizzle-kit.
//
// entrypoint.sh runs this ONCE before starting the app and proxy, replacing the
// previous design where instrumentation.ts AND proxy/server.ts each called
// migrate() in parallel on every boot — a race that crash-looped one process on
// every schema-change deploy.
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("[migrate] DATABASE_URL is not set");
  process.exit(1);
}

async function main(cs: string) {
  const client = postgres(cs, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
    console.log("[migrate] Migrations applied");
  } finally {
    await client.end({ timeout: 5 });
  }
}

main(connectionString)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[migrate] Migration failed:", err);
    process.exit(1);
  });
