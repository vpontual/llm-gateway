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
  if (cpuTemp != null && cpuTemp >= THRESHOLDS.CPU_TEMP) {
    alerts.push({
      alertType: "cpu_temp",
      message: `${serverName} CPU ${Math.round(cpuTemp)}C (threshold: ${THRESHOLDS.CPU_TEMP}C)`,
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
