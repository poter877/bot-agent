CREATE TABLE "llm_models" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"display_name" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"context_length" integer,
	"capabilities" text,
	"max_output_tokens" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_request_log" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"user_id" text,
	"session_id" text,
	"model_id" text NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"finish_reason" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"total_tokens" integer,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_quotas" (
	"user_id" text PRIMARY KEY NOT NULL,
	"daily_token_limit" integer,
	"concurrency_limit" integer,
	"model_allowlist" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "impersonated_by" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "role" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "banned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "ban_reason" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "ban_expires" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_quotas" ADD CONSTRAINT "user_quotas_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_request_log_created_at_idx" ON "llm_request_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "llm_request_log_user_idx" ON "llm_request_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "llm_request_log_status_idx" ON "llm_request_log" USING btree ("status");