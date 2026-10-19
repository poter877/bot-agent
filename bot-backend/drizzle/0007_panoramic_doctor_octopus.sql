CREATE TABLE "llm_provider_credentials" (
	"provider" text NOT NULL,
	"base_url" text DEFAULT '' NOT NULL,
	"api_key" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_provider_credentials_provider_base_url_pk" PRIMARY KEY("provider","base_url")
);
--> statement-breakpoint
ALTER TABLE "llm_models" ADD COLUMN "base_url" text;--> statement-breakpoint
ALTER TABLE "media_models" ADD COLUMN "base_url" text;