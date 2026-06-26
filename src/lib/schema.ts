import type { OllamaRunningModel, OllamaAvailableModel } from "./types";
import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  bigint,
  jsonb,
} from "drizzle-orm/pg-core";

// --- Fleet configuration ---

export const servers = pgTable("servers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  host: text("host").notNull().unique(),
  totalRamGb: integer("total_ram_gb").notNull(),
  backendType: text("backend_type").default("ollama").notNull(),
  maxConcurrent: integer("max_concurrent").default(1).notNull(),
  isDisabled: boolean("is_disabled").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// --- Monitoring data ---

export const serverSnapshots = pgTable("server_snapshots", {
  id: serial("id").primaryKey(),
  serverId: integer("server_id")
    .references(() => servers.id)
    .notNull(),
  isOnline: boolean("is_online").notNull(),
  ollamaVersion: text("ollama_version"),
  loadedModels: jsonb("loaded_models").$type<OllamaRunningModel[]>().default([]),
  availableModels: jsonb("available_models").$type<OllamaAvailableModel[]>().default([]),
  totalVramUsed: bigint("total_vram_used", { mode: "number" }).default(0),
  polledAt: timestamp("polled_at").defaultNow().notNull(),
});

export const modelEvents = pgTable("model_events", {
  id: serial("id").primaryKey(),
  serverId: integer("server_id")
    .references(() => servers.id)
    .notNull(),
  modelName: text("model_name").notNull(),
  eventType: text("event_type").notNull(), // "loaded" | "unloaded"
  modelSize: bigint("model_size", { mode: "number" }).default(0),
  vramSize: bigint("vram_size", { mode: "number" }).default(0),
  parameterSize: text("parameter_size"),
  quantization: text("quantization"),
  occurredAt: timestamp("occurred_at").defaultNow().notNull(),
});

export const systemMetrics = pgTable("system_metrics", {
  id: serial("id").primaryKey(),
  serverId: integer("server_id")
    .references(() => servers.id)
    .notNull(),
  cpuTempC: integer("cpu_temp_c"),
  gpuTempC: integer("gpu_temp_c"),
  cpuPercent: integer("cpu_percent"),
  gpuPercent: integer("gpu_percent"),
  memTotalMb: integer("mem_total_mb"),
  memUsedMb: integer("mem_used_mb"),
  memAvailableMb: integer("mem_available_mb"),
  swapTotalMb: integer("swap_total_mb"),
  swapUsedMb: integer("swap_used_mb"),
  loadAvg1: integer("load_avg_1"), // value * 100
  loadAvg5: integer("load_avg_5"),
  loadAvg15: integer("load_avg_15"),
  uptimeSeconds: integer("uptime_seconds"),
  diskTotalGb: integer("disk_total_gb"),
  diskUsedGb: integer("disk_used_gb"),
  recentBoots: jsonb("recent_boots").$type<string[]>().default([]),
  polledAt: timestamp("polled_at").defaultNow().notNull(),
});

// --- Proxy request logging ---

export const requestLogs = pgTable("request_logs", {
  id: serial("id").primaryKey(),
  sourceIp: text("source_ip").notNull(),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  model: text("model"),
  endpoint: text("endpoint").notNull(),
  method: text("method").notNull(),
  targetServerId: integer("target_server_id").references(() => servers.id),
  targetHost: text("target_host"),
  statusCode: integer("status_code"),
  durationMs: integer("duration_ms"),
  routingReason: text("routing_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// --- Job scheduling ---

export const scheduledJobs = pgTable("scheduled_jobs", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  sourceIdentifier: text("source_identifier").notNull(),
  cronExpression: text("cron_expression").notNull(),
  timezone: text("timezone").default("UTC").notNull(),
  targetModel: text("target_model").notNull(),
  preferredServerId: integer("preferred_server_id").references(() => servers.id),
  expectedDurationMs: integer("expected_duration_ms").default(60000).notNull(),
  isEnabled: boolean("is_enabled").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// --- Server lifecycle events ---

export const serverEvents = pgTable("server_events", {
  id: serial("id").primaryKey(),
  serverId: integer("server_id")
    .references(() => servers.id)
    .notNull(),
  eventType: text("event_type").notNull(), // "offline" | "online" | "reboot"
  detail: text("detail"),
  occurredAt: timestamp("occurred_at").defaultNow().notNull(),
});

// --- Multi-user tables ---

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  isAdmin: boolean("is_admin").default(false).notNull(),
  apiKey: text("api_key").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const userTelegramConfigs = pgTable("user_telegram_configs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull()
    .unique(),
  botToken: text("bot_token").notNull(),
  chatId: text("chat_id").notNull(),
  isEnabled: boolean("is_enabled").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// --- Fleet management ---

export const fleetSettings = pgTable("fleet_settings", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const managementActions = pgTable("management_actions", {
  id: serial("id").primaryKey(),
  action: text("action").notNull(), // "pull" | "delete"
  modelName: text("model_name").notNull(),
  serverId: integer("server_id")
    .references(() => servers.id)
    .notNull(),
  serverName: text("server_name").notNull(),
  status: text("status").notNull(), // "pending" | "success" | "failed"
  detail: text("detail"),
  triggeredBy: text("triggered_by").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// --- Model discovery ---

export const modelDiscoveries = pgTable("model_discoveries", {
  id: serial("id").primaryKey(),
  modelName: text("model_name").notNull().unique(),
  modelFamily: text("model_family"),
  families: jsonb("families").$type<string[]>().default([]),
  parameterSize: text("parameter_size"),
  quantization: text("quantization"),
  modelSize: bigint("model_size", { mode: "number" }).default(0),
  description: text("description"),
  capabilities: jsonb("capabilities").$type<string[]>().default([]),
  pullCount: text("pull_count"),
  registryExists: boolean("registry_exists"),
  firstSeenServerName: text("first_seen_server_name").notNull(),
  infoFetchStatus: text("info_fetch_status").default("pending").notNull(),
  infoFetchedAt: timestamp("info_fetched_at"),
  discoveredAt: timestamp("discovered_at").defaultNow().notNull(),
});

export const userServerSubscriptions = pgTable("user_server_subscriptions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  serverId: integer("server_id")
    .references(() => servers.id, { onDelete: "cascade" })
    .notNull(),
  notifyOffline: boolean("notify_offline").default(true).notNull(),
  notifyOnline: boolean("notify_online").default(true).notNull(),
  notifyReboot: boolean("notify_reboot").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
