import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateMetrics,
  AlertCooldown,
  THRESHOLDS,
  MEM_AVAILABLE_OVERRIDES,
} from "../../src/lib/alert-rules";

// --- Helper ---

function makeMetrics(overrides: {
  gpu?: number;
  cpu?: number;
  diskUsed?: number;
  diskTotal?: number;
  memAvailable?: number;
  memTotal?: number;
}) {
  return {
    temperatures: {
      gpu: overrides.gpu,
      cpu: overrides.cpu,
    } as Record<string, number | undefined>,
    disk: {
      total_gb: overrides.diskTotal ?? 100,
      used_gb: overrides.diskUsed ?? 50,
    },
    memory: {
      total_mb: overrides.memTotal ?? 16000,
      available_mb: overrides.memAvailable ?? 8000,
    },
  };
}

// --- evaluateMetrics ---

test("evaluateMetrics returns empty for healthy server", () => {
  const metrics = makeMetrics({ gpu: 60, cpu: 50 });
  const alerts = evaluateMetrics("test-server", metrics);
  assert.equal(alerts.length, 0);
});

test("evaluateMetrics triggers GPU alert at threshold", () => {
  const metrics = makeMetrics({ gpu: 90 });
  const alerts = evaluateMetrics("test-server", metrics);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].alertType, "gpu_temp");
});

test("evaluateMetrics triggers GPU alert above threshold", () => {
  const metrics = makeMetrics({ gpu: 105 });
  const alerts = evaluateMetrics("test-server", metrics);
  const gpuAlert = alerts.find((a) => a.alertType === "gpu_temp");
  assert.ok(gpuAlert);
});

test("evaluateMetrics skips GPU when temperature is null", () => {
  const metrics = makeMetrics({});
  const alerts = evaluateMetrics("test-server", metrics);
  const gpuAlert = alerts.find((a) => a.alertType === "gpu_temp");
  assert.equal(gpuAlert, undefined);
});

test("evaluateMetrics triggers CPU alert at threshold", () => {
  const metrics = makeMetrics({ cpu: 85 });
  const alerts = evaluateMetrics("test-server", metrics);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].alertType, "cpu_temp");
});

test("evaluateMetrics does not trigger CPU alert below threshold", () => {
  const metrics = makeMetrics({ cpu: 84 });
  const alerts = evaluateMetrics("test-server", metrics);
  assert.equal(alerts.length, 0);
});

test("evaluateMetrics triggers disk alert at 90% usage", () => {
  const metrics = makeMetrics({ diskUsed: 90, diskTotal: 100 });
  const alerts = evaluateMetrics("test-server", metrics);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].alertType, "disk");
});

test("evaluateMetrics does not trigger disk alert at 89%", () => {
  const metrics = makeMetrics({ diskUsed: 89, diskTotal: 100 });
  const alerts = evaluateMetrics("test-server", metrics);
  assert.equal(alerts.length, 0);
});

test("evaluateMetrics skips disk check when total is zero", () => {
  const metrics = makeMetrics({ diskUsed: 0, diskTotal: 0 });
  const alerts = evaluateMetrics("test-server", metrics);
  const diskAlert = alerts.find((a) => a.alertType === "disk");
  assert.equal(diskAlert, undefined);
});

test("evaluateMetrics triggers memory alert below 10% available", () => {
  const metrics = makeMetrics({ memAvailable: 1500, memTotal: 16000 });
  const alerts = evaluateMetrics("test-server", metrics);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].alertType, "memory");
});

test("evaluateMetrics does not trigger memory alert at 10% available", () => {
  const metrics = makeMetrics({ memAvailable: 1600, memTotal: 16000 });
  const alerts = evaluateMetrics("test-server", metrics);
  assert.equal(alerts.length, 0);
});

test("evaluateMetrics can trigger multiple alerts simultaneously", () => {
  const metrics = makeMetrics({
    gpu: 95,
    cpu: 90,
    diskUsed: 95,
    diskTotal: 100,
    memAvailable: 500,
    memTotal: 16000,
  });
  const alerts = evaluateMetrics("test-server", metrics);
  assert.equal(alerts.length, 4);
  const types = alerts.map((a) => a.alertType).sort();
  assert.deepEqual(types, ["cpu_temp", "disk", "gpu_temp", "memory"]);
});

test("evaluateMetrics includes server name in messages", () => {
  const metrics = makeMetrics({ gpu: 95 });
  const alerts = evaluateMetrics("my-dgx", metrics);
  assert.ok(alerts[0].message.includes("my-dgx"));
});

// --- AlertCooldown ---

test("AlertCooldown allows first alert", () => {
  const cooldown = new AlertCooldown(30000);
  assert.equal(cooldown.canAlert("server1", "gpu_temp"), true);
});

test("AlertCooldown blocks alert within cooldown window", () => {
  const cooldown = new AlertCooldown(30000);
  cooldown.markAlerted("server1", "gpu_temp");
  assert.equal(cooldown.canAlert("server1", "gpu_temp"), false);
});

test("AlertCooldown allows different alert type on same server", () => {
  const cooldown = new AlertCooldown(30000);
  cooldown.markAlerted("server1", "gpu_temp");
  assert.equal(cooldown.canAlert("server1", "cpu_temp"), true);
});

test("AlertCooldown allows same alert type on different server", () => {
  const cooldown = new AlertCooldown(30000);
  cooldown.markAlerted("server1", "gpu_temp");
  assert.equal(cooldown.canAlert("server2", "gpu_temp"), true);
});

test("AlertCooldown reset clears all tracked alerts", () => {
  const cooldown = new AlertCooldown(30000);
  cooldown.markAlerted("server1", "gpu_temp");
  cooldown.markAlerted("server2", "cpu_temp");
  cooldown.reset();
  assert.equal(cooldown.canAlert("server1", "gpu_temp"), true);
  assert.equal(cooldown.canAlert("server2", "cpu_temp"), true);
});

test("AlertCooldown stays silent indefinitely when no reminderMs is set", async () => {
  const cooldown = new AlertCooldown(); // no reminders
  cooldown.markAlerted("server1", "offline");
  assert.equal(cooldown.canAlert("server1", "offline"), false);
  // Even after a brief delay, no reminder should fire.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cooldown.canAlert("server1", "offline"), false);
});

test("AlertCooldown markResolved re-arms the next alert", () => {
  const cooldown = new AlertCooldown();
  cooldown.markAlerted("server1", "offline");
  assert.equal(cooldown.canAlert("server1", "offline"), false);
  assert.equal(cooldown.markResolved("server1", "offline"), true);
  assert.equal(cooldown.canAlert("server1", "offline"), true);
});

test("AlertCooldown markResolved returns false when no active alert", () => {
  const cooldown = new AlertCooldown();
  assert.equal(cooldown.markResolved("server1", "offline"), false);
});

test("AlertCooldown finite reminderMs fires reminders while state persists", async () => {
  const cooldown = new AlertCooldown(20);
  cooldown.markAlerted("server1", "offline");
  assert.equal(cooldown.canAlert("server1", "offline"), false);
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(cooldown.canAlert("server1", "offline"), true);
});

test("evaluateMetrics applies per-server memory override below default", () => {
  // 5% available -- triggers default 10% floor, but should NOT trigger 2% override
  const metrics = makeMetrics({ memAvailable: 800, memTotal: 16000 });
  const generic = evaluateMetrics("Some Other Box", metrics);
  assert.ok(generic.find((a) => a.alertType === "memory"), "default floor should fire");

  for (const fleetServer of Object.keys(MEM_AVAILABLE_OVERRIDES)) {
    const fleet = evaluateMetrics(fleetServer, metrics);
    assert.equal(
      fleet.find((a) => a.alertType === "memory"),
      undefined,
      `override should suppress memory alert for ${fleetServer}`
    );
  }
});

test("evaluateMetrics still fires memory alert below per-server override floor", () => {
  // 1% available -- below the 2% inference-fleet floor
  const metrics = makeMetrics({ memAvailable: 160, memTotal: 16000 });
  const fleet = evaluateMetrics("Orin AGX", metrics);
  const memAlert = fleet.find((a) => a.alertType === "memory");
  assert.ok(memAlert, "below override floor should still alert");
  assert.match(memAlert!.message, /Orin AGX/);
});

test("MEM_AVAILABLE_OVERRIDES covers the inference fleet", () => {
  const expected = ["Orin AGX", "DGX Spark", "Jetson Nano 1", "Jetson Nano 2"];
  for (const name of expected) {
    assert.ok(name in MEM_AVAILABLE_OVERRIDES, `missing override for ${name}`);
    assert.ok(
      MEM_AVAILABLE_OVERRIDES[name] < THRESHOLDS.MEM_AVAILABLE,
      `override for ${name} should be tighter than default`
    );
  }
});

test("THRESHOLDS are exported with expected values", () => {
  assert.equal(THRESHOLDS.GPU_TEMP, 90);
  assert.equal(THRESHOLDS.CPU_TEMP, 85);
  assert.equal(THRESHOLDS.DISK_USAGE, 0.9);
  assert.equal(THRESHOLDS.MEM_AVAILABLE, 0.1);
});
