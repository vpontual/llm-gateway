CREATE TABLE "fleet_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "fleet_settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "management_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"model_name" text NOT NULL,
	"server_id" integer NOT NULL,
	"server_name" text NOT NULL,
	"status" text NOT NULL,
	"detail" text,
	"triggered_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_discoveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_name" text NOT NULL,
	"model_family" text,
	"families" jsonb DEFAULT '[]'::jsonb,
	"parameter_size" text,
	"quantization" text,
	"model_size" bigint DEFAULT 0,
	"description" text,
	"capabilities" jsonb DEFAULT '[]'::jsonb,
	"pull_count" text,
	"registry_exists" boolean,
	"first_seen_server_name" text NOT NULL,
	"info_fetch_status" text DEFAULT 'pending' NOT NULL,
	"info_fetched_at" timestamp,
	"discovered_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "model_discoveries_model_name_unique" UNIQUE("model_name")
);
--> statement-breakpoint
CREATE TABLE "model_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"model_name" text NOT NULL,
	"event_type" text NOT NULL,
	"model_size" bigint DEFAULT 0,
	"vram_size" bigint DEFAULT 0,
	"parameter_size" text,
	"quantization" text,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_ip" text NOT NULL,
	"user_id" integer,
	"model" text,
	"endpoint" text NOT NULL,
	"method" text NOT NULL,
	"target_server_id" integer,
	"target_host" text,
	"status_code" integer,
	"duration_ms" integer,
	"routing_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source_identifier" text NOT NULL,
	"cron_expression" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"target_model" text NOT NULL,
	"preferred_server_id" integer,
	"expected_duration_ms" integer DEFAULT 60000 NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"detail" text,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"is_online" boolean NOT NULL,
	"ollama_version" text,
	"loaded_models" jsonb DEFAULT '[]'::jsonb,
	"available_models" jsonb DEFAULT '[]'::jsonb,
	"total_vram_used" bigint DEFAULT 0,
	"polled_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"total_ram_gb" integer NOT NULL,
	"backend_type" text DEFAULT 'ollama' NOT NULL,
	"max_concurrent" integer DEFAULT 1 NOT NULL,
	"is_disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "servers_host_unique" UNIQUE("host")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"cpu_temp_c" integer,
	"gpu_temp_c" integer,
	"cpu_percent" integer,
	"gpu_percent" integer,
	"mem_total_mb" integer,
	"mem_used_mb" integer,
	"mem_available_mb" integer,
	"swap_total_mb" integer,
	"swap_used_mb" integer,
	"load_avg_1" integer,
	"load_avg_5" integer,
	"load_avg_15" integer,
	"uptime_seconds" integer,
	"disk_total_gb" integer,
	"disk_used_gb" integer,
	"recent_boots" jsonb DEFAULT '[]'::jsonb,
	"polled_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_server_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"server_id" integer NOT NULL,
	"notify_offline" boolean DEFAULT true NOT NULL,
	"notify_online" boolean DEFAULT true NOT NULL,
	"notify_reboot" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_telegram_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"bot_token" text NOT NULL,
	"chat_id" text NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_telegram_configs_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"api_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_api_key_unique" UNIQUE("api_key")
);
--> statement-breakpoint
ALTER TABLE "management_actions" ADD CONSTRAINT "management_actions_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_events" ADD CONSTRAINT "model_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_target_server_id_servers_id_fk" FOREIGN KEY ("target_server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_preferred_server_id_servers_id_fk" FOREIGN KEY ("preferred_server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_events" ADD CONSTRAINT "server_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_snapshots" ADD CONSTRAINT "server_snapshots_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_metrics" ADD CONSTRAINT "system_metrics_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_server_subscriptions" ADD CONSTRAINT "user_server_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_server_subscriptions" ADD CONSTRAINT "user_server_subscriptions_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_telegram_configs" ADD CONSTRAINT "user_telegram_configs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_model_events_occurred" ON "model_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "idx_model_events_server_occurred" ON "model_events" USING btree ("server_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_request_logs_created" ON "request_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_request_logs_model_created" ON "request_logs" USING btree ("model","created_at");--> statement-breakpoint
CREATE INDEX "idx_server_events_occurred" ON "server_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "idx_server_events_occurred_at" ON "server_events" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_server_events_server_id" ON "server_events" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_server_snapshots_server_polled" ON "server_snapshots" USING btree ("server_id","polled_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_system_metrics_server_polled" ON "system_metrics" USING btree ("server_id","polled_at");