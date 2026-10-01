// Fleet metrics agent client -- fetches system metrics from servers

import { normalizeTemperatures } from "./alert-rules";

const TIMEOUT_MS = 3000;

export interface RebootCause {
  cause: string; // "user_command" | "power_button" | "unknown"
  detail: string;
  user?: string;
}

export interface MetricsAgentResponse {
  hostname: string;
  uptime_seconds: number;
  boot_time: string;
  temperatures: Record<string, number>;
  memory: {
    total_mb: number;
    used_mb: number;
    available_mb: number;
    swap_total_mb: number;
    swap_used_mb: number;
  };
  load_avg: [number, number, number];
  cpu_percent: number | null;
  gpu_percent: number | null;
  recent_boots: string[];
  reboot_causes: Record<string, RebootCause>;
  disk: {
    total_gb: number;
    used_gb: number;
    free_gb: number;
  };
}

export async function fetchSystemMetrics(
  metricsHost: string
): Promise<MetricsAgentResponse | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(`http://${metricsHost}/metrics`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = (await res.json()) as MetricsAgentResponse;
    data.temperatures = normalizeTemperatures(data.temperatures);
    return data;
  } catch {
    return null;
  }
}
