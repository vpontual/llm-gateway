// GET/POST /api/scheduled-jobs/discover -- discover jobs from container env vars

import { NextResponse } from "next/server";
import http from "http";
import { withAdmin } from "@/lib/api/route-helpers";

export const dynamic = "force-dynamic";

interface DiscoveredJob {
  name: string;
  sourceIdentifier: string;
  cronExpression: string;
  targetModel: string;
  description: string;
}

interface ContainerEnv {
  containerName: string;
  envVars: Record<string, string>;
}

// Make HTTP request to Docker socket
function dockerRequest(path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const options = {
      socketPath: "/var/run/docker.sock",
      path,
      method: "GET",
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error("Failed to parse Docker response"));
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

async function getContainerEnvVars(): Promise<ContainerEnv[]> {
  try {
    // Get list of running containers
    const containers = (await dockerRequest("/containers/json")) as Array<{
      Names: string[];
      Id: string;
    }>;

    const results: ContainerEnv[] = [];

    for (const container of containers) {
      const name = container.Names[0]?.replace(/^\//, "") || container.Id.slice(0, 12);

      try {
        // Get detailed info for each container
        const info = (await dockerRequest(`/containers/${container.Id}/json`)) as {
          Config: { Env: string[] };
        };

        const envVars: Record<string, string> = {};
        for (const line of info.Config.Env || []) {
          const eqIndex = line.indexOf("=");
          if (eqIndex > 0) {
            const key = line.slice(0, eqIndex);
            const value = line.slice(eqIndex + 1);
            envVars[key] = value;
          }
        }

        results.push({ containerName: name, envVars });
      } catch {
        // Skip containers we can't inspect
      }
    }

    return results;
  } catch (error) {
    console.error("Failed to get container env vars:", error);
    return [];
  }
}

function discoverJobsFromEnv(containers: ContainerEnv[]): DiscoveredJob[] {
  const jobs: DiscoveredJob[] = [];

  for (const { containerName, envVars } of containers) {
    // Look for CRON_SCHEDULE or similar patterns
    const cronKeys = Object.keys(envVars).filter(
      (k) =>
        k.includes("CRON") ||
        k.includes("SCHEDULE")
    );

    // Look for Ollama model patterns
    const modelKeys = Object.keys(envVars).filter(
      (k) =>
        k.includes("OLLAMA") &&
        (k.includes("MODEL") || k.includes("model"))
    );

    // Skip if no cron schedule found
    const cronKey = cronKeys.find((k) => {
      const val = envVars[k];
      // Check if it looks like a cron expression (has spaces and typical cron chars)
      return val && /^[\d*\/,\-\s]+$/.test(val) && val.split(/\s+/).length >= 5;
    });

    if (!cronKey) continue;

    const cronExpression = envVars[cronKey];

    // Get all models used by this container
    for (const modelKey of modelKeys) {
      const model = envVars[modelKey];
      if (!model || model.startsWith("http")) continue; // Skip URLs

      // Generate a descriptive name
      const modelType = modelKey
        .replace("OLLAMA_", "")
        .replace("_MODEL", "")
        .replace(/_/g, " ")
        .toLowerCase();

      jobs.push({
        name: `${containerName} - ${modelType}`,
        sourceIdentifier: containerName,
        cronExpression,
        targetModel: model,
        description: `Auto-discovered from ${containerName} (${modelKey})`,
      });
    }

    // If we found a cron but no specific models, add a generic entry
    if (cronKey && modelKeys.length === 0) {
      jobs.push({
        name: containerName,
        sourceIdentifier: containerName,
        cronExpression,
        targetModel: "unknown",
        description: `Auto-discovered from ${containerName}`,
      });
    }
  }

  return jobs;
}

export async function GET() {
  return withAdmin(async () => {
    try {
      const containers = await getContainerEnvVars();
      const discoveredJobs = discoverJobsFromEnv(containers);

      return NextResponse.json({
        containers: containers.length,
        jobs: discoveredJobs,
      });
    } catch (error) {
      console.error("Discovery failed:", error);
      return NextResponse.json(
        { error: "Failed to discover jobs. Is Docker socket mounted?" },
        { status: 500 }
      );
    }
  });
}

export async function POST() {
  return withAdmin(async () => {
  try {
    const containers = await getContainerEnvVars();
    const discoveredJobs = discoverJobsFromEnv(containers);

    // Import what we need to add jobs
    const { db } = await import("@/lib/db");
    const { scheduledJobs } = await import("@/lib/schema");
    const { eq } = await import("drizzle-orm");

    const added: string[] = [];
    const skipped: string[] = [];

    for (const job of discoveredJobs) {
      // Skip if target model is unknown
      if (job.targetModel === "unknown") {
        skipped.push(`${job.name} (no model specified)`);
        continue;
      }

      // Check if job already exists (by name and source)
      const existing = await db
        .select()
        .from(scheduledJobs)
        .where(eq(scheduledJobs.name, job.name))
        .limit(1);

      if (existing.length > 0) {
        skipped.push(`${job.name} (already exists)`);
        continue;
      }

      // Add the job
      await db.insert(scheduledJobs).values({
        name: job.name,
        description: job.description,
        sourceIdentifier: job.sourceIdentifier,
        cronExpression: job.cronExpression,
        targetModel: job.targetModel,
        expectedDurationMs: 300000, // Default 5 minutes
      });

      added.push(job.name);
    }

    return NextResponse.json({
      discovered: discoveredJobs.length,
      added: added.length,
      skipped: skipped.length,
      addedJobs: added,
      skippedJobs: skipped,
    });
  } catch (error) {
    console.error("Discovery failed:", error);
    return NextResponse.json(
      { error: "Failed to discover jobs. Is Docker socket mounted?" },
      { status: 500 }
    );
  }
});
}
