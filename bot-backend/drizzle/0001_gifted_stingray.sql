CREATE TABLE "cloud_computer" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"desired_state" text DEFAULT 'stopped' NOT NULL,
	"state" text DEFAULT 'stopped' NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"lease_epoch" integer DEFAULT 0 NOT NULL,
	"lease_token_hash" text,
	"lease_session_id" text,
	"lease_expires_at" timestamp with time zone,
	"width" integer DEFAULT 1440 NOT NULL,
	"height" integer DEFAULT 900 NOT NULL,
	"last_error" text,
	"reconcile_after" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_computer_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "cloud_computer" ADD CONSTRAINT "cloud_computer_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;