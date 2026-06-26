"use client";

import { mutate } from "swr";
import type { ServerState } from "@/lib/types";
import { VramBar } from "./vram-bar";

function isPinned(expiresAt: string | undefined): boolean {
  if (!expiresAt) return false;
  const year = new Date(expiresAt).getFullYear();
  return year >= 2100;
}

function formatUptime(loadedAt: string): string {
  const ms = Date.now() - new Date(loadedAt).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const hrs = hours % 24;
  return hrs > 0 ? `${days}d ${hrs}h` : `${days}d`;
}

function formatUptimeSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const hrs = hours % 24;
  return hrs > 0 ? `${days}d ${hrs}h` : `${days}d`;
}

function tempColor(c: number | null): string {
  if (c == null) return "text-text-muted";
  if (c >= 70) return "text-danger";
  if (c >= 50) return "text-warning";
  return "text-success";
}

function recentRebootCount(boots: string[]): number {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  return boots.filter((b) => new Date(b).getTime() > oneDayAgo).length;
}

export function ServerCard({
  server,
  latestVersion,
  expanded,
}: {
  server: ServerState;
  latestVersion: string | null;
  expanded: boolean;
}) {
  const modelCount = server.loadedModels.length;
  const isOutdated =
    latestVersion &&
    server.ollamaVersion &&
    server.ollamaVersion !== latestVersion;

  return (
    <div className={`bg-surface-raised border border-border rounded-xl p-4 transition-all duration-200 ${server.isDisabled ? "opacity-60" : ""}`}>
      {/* Header — always visible */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`inline-block w-2 h-2 rounded-full shrink-0 ${
              server.isDisabled ? "bg-warning" : server.isOnline ? "bg-success" : "bg-danger"
            }`}
            role="img"
            aria-label={server.isDisabled ? "Disabled" : server.isOnline ? "Online" : "Offline"}
          />
          <h2 className="text-sm font-semibold text-text-primary truncate">
            {server.name}
          </h2>
          <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider rounded bg-accent/15 text-accent">
            {server.backendType}
          </span>
          {server.isDisabled && (
            <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider rounded bg-warning/15 text-warning">
              maintenance
            </span>
          )}
        </div>
      </div>

      {/* VRAM bar — always visible */}
      <div className="mb-3">
        <VramBar used={server.totalVramUsed} totalGb={server.totalRamGb} />
      </div>

      {/* Loaded models summary — always visible */}
      <div className={expanded ? "mb-1" : ""}>
        {modelCount === 0 ? (
          <p className="text-xs text-text-muted italic">No models loaded</p>
        ) : (
          <ul className="space-y-0.5">
            {server.loadedModels.map((model) => (
              <li key={model.name} className="flex items-center gap-1.5 text-xs">
                {isPinned(model.expires_at) && (
                  <span className="text-accent" title="Pinned" role="img" aria-label="Pinned model">&bull;</span>
                )}
                <span className="text-text-primary font-mono truncate">
                  {model.name}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Expanded details */}
      <div
        className={`grid transition-all duration-200 ease-in-out ${
          expanded ? "grid-rows-[1fr] opacity-100 mt-3" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="overflow-hidden">
          {/* Host + version info */}
          <div className="border-t border-border pt-3 mb-3">
            <p className="text-xs text-text-muted font-mono mb-1">{server.host}</p>
            <div className="flex gap-3 text-xs text-text-secondary">
              <span>RAM: {server.totalRamGb} GB</span>
              {server.ollamaVersion && (
                <span className={isOutdated ? "text-warning" : ""}>
                  v{server.ollamaVersion}
                  {isOutdated && " (outdated)"}
                </span>
              )}
            </div>
            <button
              onClick={async () => {
                await fetch(`/api/servers/${server.id}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ isDisabled: !server.isDisabled }),
                });
                mutate("/api/servers");
              }}
              className={`mt-2 px-3 py-1 text-xs rounded-lg border transition-colors ${
                server.isDisabled
                  ? "border-success/30 text-success hover:bg-success/10"
                  : "border-warning/30 text-warning hover:bg-warning/10"
              }`}
            >
              {server.isDisabled ? "Reconnect" : "Disconnect"}
            </button>
          </div>

          {/* System metrics */}
          {server.systemMetrics && (
            <div className="mb-3">
              <p className="text-xs text-text-muted uppercase tracking-wide mb-2">
                System
              </p>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-text-secondary">CPU</span>
                  <span className={tempColor(server.systemMetrics.cpuTempC)}>
                    {server.systemMetrics.cpuTempC != null
                      ? `${server.systemMetrics.cpuTempC}\°C`
                      : "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary">GPU</span>
                  <span className={tempColor(server.systemMetrics.gpuTempC)}>
                    {server.systemMetrics.gpuTempC != null
                      ? `${server.systemMetrics.gpuTempC}\°C`
                      : "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary">RAM</span>
                  <span className="text-text-primary">
                    {(server.systemMetrics.memUsedMb / 1024).toFixed(1)} /{" "}
                    {(server.systemMetrics.memTotalMb / 1024).toFixed(0)} GB
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary">Disk</span>
                  <span className="text-text-primary">
                    {server.systemMetrics.diskUsedGb} /{" "}
                    {server.systemMetrics.diskTotalGb} GB
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary">Uptime</span>
                  <span className="text-text-primary">
                    {formatUptimeSeconds(server.systemMetrics.uptimeSeconds)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary">Load</span>
                  <span className="text-text-primary">
                    {server.systemMetrics.loadAvg[0].toFixed(2)}
                  </span>
                </div>
              </div>
              {server.systemMetrics.swapUsedMb > 0 && (
                <div className="flex justify-between text-xs mt-1">
                  <span className="text-text-secondary">Swap</span>
                  <span className="text-warning">
                    {(server.systemMetrics.swapUsedMb / 1024).toFixed(1)} /{" "}
                    {(server.systemMetrics.swapTotalMb / 1024).toFixed(0)} GB
                  </span>
                </div>
              )}
              {recentRebootCount(server.systemMetrics.recentBoots) > 1 && (
                <div className="mt-2 px-2 py-1 bg-danger/10 border border-danger/20 rounded-lg text-xs text-danger">
                  {recentRebootCount(server.systemMetrics.recentBoots)} reboots in
                  last 24h
                </div>
              )}
            </div>
          )}

          {/* Full model details */}
          {modelCount > 0 && (
            <div>
              <p className="text-xs text-text-muted uppercase tracking-wide mb-2">
                Model Details
              </p>
              <ul className="space-y-1">
                {server.loadedModels.map((model) => {
                  const loadedAt = server.modelLoadTimes?.[model.name];
                  return (
                    <li
                      key={model.name}
                      className="flex items-center justify-between text-xs"
                    >
                      <span className="text-text-primary font-mono truncate mr-2">
                        {model.name}
                      </span>
                      <span className="text-text-muted whitespace-nowrap">
                        {loadedAt && (
                          <span className="mr-1.5">{formatUptime(loadedAt)}</span>
                        )}
                        {model.details?.parameter_size ?? ""}
                        {model.details?.quantization_level
                          ? ` ${model.details.quantization_level}`
                          : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
