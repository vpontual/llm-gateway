// Alert threshold rules: pure functions for evaluating server health conditions

export const THRESHOLDS = {
  GPU_TEMP: 90,
  CPU_TEMP: 85,
  DISK_USAGE: 0.9,
  MEM_AVAILABLE: 0.1,
} as const;

// Inference-fleet servers run vLLM/Ollama at sustained ~90%+ RAM by design.
// Tighter floor catches a real runaway without firing on steady-state.
export const MEM_AVAILABLE_OVERRIDES: Record<string, number> = {
  "Orin AGX": 0.02,
  "DGX Spark": 0.02,
  "Jetson Nano 1": 0.02,
  "Jetson Nano 2": 0.02,
};

// The DGX Spark's only thermal zone is "acpitz", the SoC package that holds both the
// CPU and the GPU. Long-prompt prefill drives it to ~94C within 45 s at ~90 W and it
// falls back below 65C seconds later (measured 2026-10-01); the kernel's critical trip
// point is 104C. 85C would alert on every long prompt, so it gets its own threshold.
export const CPU_TEMP_OVERRIDES: Record<string, number> = {
  "DGX Spark": 98,
};

// Agents name sensors after the kernel's thermal zones. Jetson/Orin zones are literally
// "cpu" and "gpu"; the DGX Spark reports only "acpitz" (and its GPU, when an agent adds
// it, as "gpu0"). Everything downstream reads temperatures.cpu / .gpu, so without this the
// DGX stored NULL temperatures for months and its overheating alert could never fire.
// A host that already reports "cpu" / "gpu" is left exactly as it was.
const CPU_SENSOR = /^(cpu|acpitz|tj|x86_pkg_temp|coretemp|k10temp|soc\d*)$/i;
const GPU_SENSOR = /^gpu\d*$/i;

export function normalizeTemperatures(
  temps: Record<string, number> | null | undefined
): Record<string, number> {
  const out: Record<string, number> = { ...(temps ?? {}) };
  const hottest = (re: RegExp): number | undefined => {
    const vals = Object.entries(out)
      .filter(([k, v]) => re.test(k) && Number.isFinite(v))
      .map(([, v]) => v);
    return vals.length ? Math.max(...vals) : undefined;
  };
  if (out.cpu == null) {
    const cpu = hottest(CPU_SENSOR);
    if (cpu !== undefined) out.cpu = cpu;
  }
  if (out.gpu == null) {
    const gpu = hottest(GPU_SENSOR);
    if (gpu !== undefined) out.gpu = gpu;
  }
  return out;
}

export interface AlertCondition {
  alertType: string;
  message: string;
}

interface MetricsInput {
  temperatures: Record<string, number | undefined>;
  disk: { total_gb: number; used_gb: number };
  memory: { total_mb: number; available_mb: number };
}

/**
 * Evaluate server metrics against alert thresholds.
 * Returns an array of alert conditions that should fire.
 * Does NOT handle cooldowns or message delivery.
 */
export function evaluateMetrics(
  serverName: string,
  metrics: MetricsInput
): AlertCondition[] {
  const alerts: AlertCondition[] = [];

  // GPU overheating
  const gpuTemp = metrics.temperatures.gpu;
  if (gpuTemp != null && gpuTemp >= THRESHOLDS.GPU_TEMP) {
    alerts.push({
      alertType: "gpu_temp",
      message: `${serverName} GPU ${Math.round(gpuTemp)}C (threshold: ${THRESHOLDS.GPU_TEMP}C)`,
    });
  }

  // CPU overheating
  const cpuTemp = metrics.temperatures.cpu;
  const cpuLimit = CPU_TEMP_OVERRIDES[serverName] ?? THRESHOLDS.CPU_TEMP;
  if (cpuTemp != null && cpuTemp >= cpuLimit) {
    alerts.push({
      alertType: "cpu_temp",
      message: `${serverName} CPU ${Math.round(cpuTemp)}C (threshold: ${cpuLimit}C)`,
    });
  }

  // Disk nearly full
  if (metrics.disk.total_gb > 0) {
    const diskUsage = metrics.disk.used_gb / metrics.disk.total_gb;
    if (diskUsage >= THRESHOLDS.DISK_USAGE) {
      alerts.push({
        alertType: "disk",
        message: `${serverName} disk at ${Math.round(diskUsage * 100)}%`,
      });
    }
  }

  // Low memory
  if (metrics.memory.total_mb > 0) {
    const availableRatio = metrics.memory.available_mb / metrics.memory.total_mb;
    const memFloor = MEM_AVAILABLE_OVERRIDES[serverName] ?? THRESHOLDS.MEM_AVAILABLE;
    if (availableRatio < memFloor) {
      alerts.push({
        alertType: "memory",
        message: `${serverName} memory at ${Math.round((1 - availableRatio) * 100)}%`,
      });
    }
  }

  return alerts;
}

/**
 * State-edge alert tracker. Fires once when an alert state is entered and
 * stays silent until `markResolved` clears it. Pass a finite `reminderMs`
 * to also fire periodic reminders while the state persists; the default
 * (Infinity) means no reminders — one alert per state transition.
 */
export class AlertCooldown {
  private active = new Map<string, number>();

  constructor(private reminderMs: number = Number.POSITIVE_INFINITY) {}

  canAlert(serverName: string, alertType: string): boolean {
    const key = `${serverName}:${alertType}`;
    const last = this.active.get(key);
    if (last === undefined) return true;
    if (!Number.isFinite(this.reminderMs)) return false;
    return Date.now() - last > this.reminderMs;
  }

  markAlerted(serverName: string, alertType: string): void {
    this.active.set(`${serverName}:${alertType}`, Date.now());
  }

  markResolved(serverName: string, alertType: string): boolean {
    return this.active.delete(`${serverName}:${alertType}`);
  }

  reset(): void {
    this.active.clear();
  }
}
