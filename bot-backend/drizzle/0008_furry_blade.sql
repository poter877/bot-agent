CREATE TABLE "ai_service_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_type" text NOT NULL,
	"provider" text,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key" text NOT NULL,
	"model" text,
	"endpoint" text,
	"query_endpoint" text,
	"priority" integer DEFAULT 0,
	"is_default" boolean DEFAULT false,
	"is_active" boolean DEFAULT true,
	"settings" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_service_providers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"display_name" text,
	"service_type" text NOT NULL,
	"provider" text NOT NULL,
	"default_url" text,
	"preset_models" text,
	"description" text,
	"is_active" boolean DEFAULT true,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"drama_id" integer,
	"episode_id" integer,
	"storyboard_id" integer,
	"storyboard_num" integer,
	"name" text,
	"description" text,
	"type" text,
	"category" text,
	"url" text,
	"thumbnail_url" text,
	"local_path" text,
	"file_size" integer,
	"mime_type" text,
	"width" integer,
	"height" integer,
	"duration" integer,
	"format" text,
	"image_gen_id" integer,
	"video_gen_id" integer,
	"is_favorite" boolean DEFAULT false,
	"view_count" integer DEFAULT 0,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"id" serial PRIMARY KEY NOT NULL,
	"drama_id" integer NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"description" text,
	"appearance" text,
	"styling" text,
	"final_prompt" text,
	"personality" text,
	"image_url" text,
	"reference_images" text,
	"seed_value" text,
	"sort_order" integer,
	"local_path" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text
);
--> statement-breakpoint
CREATE TABLE "creative_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"actions" text DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creative_models" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"metadata" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creative_pipeline_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"stage_id" text,
	"kind" text NOT NULL,
	"payload" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creative_pipeline_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"definition" text NOT NULL,
	"snapshot" text NOT NULL,
	"revision" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"stages" text NOT NULL,
	"error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creative_projects" (
	"project_id" integer PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"approved_revision" integer,
	"document" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creative_renders" (
	"outputs" text DEFAULT '[]' NOT NULL,
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"revision" integer NOT NULL,
	"snapshot" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"video_url" text,
	"subtitle_url" text,
	"duration" double precision,
	"error_msg" text,
	"warnings" text DEFAULT '[]' NOT NULL,
	"created_at" text NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "creative_shot_tasks" (
	"project_id" integer NOT NULL,
	"shot_id" text NOT NULL,
	"kind" text NOT NULL,
	"fingerprint" text NOT NULL,
	"task_id" integer NOT NULL,
	CONSTRAINT "creative_shot_tasks_project_id_shot_id_kind_pk" PRIMARY KEY("project_id","shot_id","kind")
);
--> statement-breakpoint
CREATE TABLE "creative_tool_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"kind" text NOT NULL,
	"fingerprint" text NOT NULL,
	"revision" integer NOT NULL,
	"input" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"remote_id" text,
	"progress" integer DEFAULT 0 NOT NULL,
	"result" text DEFAULT '{}' NOT NULL,
	"error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dramas" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"project_type" text DEFAULT 'drama' NOT NULL,
	"creative_category" text,
	"film_style" text,
	"description" text,
	"genre" text,
	"style" text DEFAULT '3d',
	"aspect_ratio" text DEFAULT '16:9',
	"total_episodes" integer DEFAULT 1,
	"total_duration" integer DEFAULT 0,
	"status" text DEFAULT 'draft' NOT NULL,
	"thumbnail" text,
	"tags" text,
	"metadata" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text
);
--> statement-breakpoint
CREATE TABLE "episode_characters" (
	"id" serial PRIMARY KEY NOT NULL,
	"episode_id" integer NOT NULL,
	"character_id" integer NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "episode_props" (
	"id" serial PRIMARY KEY NOT NULL,
	"episode_id" integer NOT NULL,
	"prop_id" integer NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "episode_scenes" (
	"id" serial PRIMARY KEY NOT NULL,
	"episode_id" integer NOT NULL,
	"scene_id" integer NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "episodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"drama_id" integer NOT NULL,
	"episode_number" integer NOT NULL,
	"title" text NOT NULL,
	"content" text,
	"script_content" text,
	"description" text,
	"duration" integer DEFAULT 0,
	"status" text DEFAULT 'draft',
	"video_url" text,
	"thumbnail" text,
	"image_config_id" integer,
	"video_config_id" integer,
	"resolution" text DEFAULT '720p',
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text
);
--> statement-breakpoint
CREATE TABLE "film_projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"style_slug" text NOT NULL,
	"topic" text DEFAULT '' NOT NULL,
	"language" text DEFAULT 'zh' NOT NULL,
	"duration_sec" integer DEFAULT 45 NOT NULL,
	"has_voice" integer DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "film_render_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"run_id" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"phase" text,
	"video_url" text,
	"poster_url" text,
	"srt_url" text,
	"error_msg" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "film_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"definition" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"stages" text NOT NULL,
	"error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "production_tool_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"tool_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"revision" integer NOT NULL,
	"input" text NOT NULL,
	"state" text DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"result" text DEFAULT '{}' NOT NULL,
	"error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "props" (
	"id" serial PRIMARY KEY NOT NULL,
	"drama_id" integer NOT NULL,
	"name" text NOT NULL,
	"type" text,
	"description" text,
	"prompt" text,
	"final_prompt" text,
	"image_url" text,
	"reference_images" text,
	"local_path" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text
);
--> statement-breakpoint
CREATE TABLE "scenes" (
	"id" serial PRIMARY KEY NOT NULL,
	"drama_id" integer NOT NULL,
	"episode_id" integer,
	"location" text NOT NULL,
	"time" text NOT NULL,
	"prompt" text NOT NULL,
	"lighting" text,
	"final_prompt" text,
	"storyboard_count" integer DEFAULT 1,
	"image_url" text,
	"status" text DEFAULT 'pending',
	"local_path" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text
);
--> statement-breakpoint
CREATE TABLE "storyboard_characters" (
	"storyboard_id" integer NOT NULL,
	"character_id" integer NOT NULL,
	CONSTRAINT "storyboard_characters_storyboard_id_character_id_pk" PRIMARY KEY("storyboard_id","character_id")
);
--> statement-breakpoint
CREATE TABLE "storyboard_props" (
	"storyboard_id" integer NOT NULL,
	"prop_id" integer NOT NULL,
	CONSTRAINT "storyboard_props_storyboard_id_prop_id_pk" PRIMARY KEY("storyboard_id","prop_id")
);
--> statement-breakpoint
CREATE TABLE "storyboards" (
	"id" serial PRIMARY KEY NOT NULL,
	"episode_id" integer NOT NULL,
	"scene_id" integer,
	"storyboard_number" integer NOT NULL,
	"title" text,
	"location" text,
	"time" text,
	"shot_type" text,
	"angle" text,
	"movement" text,
	"result" text,
	"atmosphere" text,
	"image_prompt" text,
	"video_prompt" text,
	"bgm_prompt" text,
	"sound_effect" text,
	"description" text,
	"duration" integer DEFAULT 0,
	"composed_image" text,
	"first_frame_image" text,
	"last_frame_image" text,
	"reference_images" text,
	"video_url" text,
	"subtitle_url" text,
	"composed_video_url" text,
	"status" text DEFAULT 'pending',
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text
);
--> statement-breakpoint
CREATE TABLE "style_presets" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"prompt" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0,
	"is_active" boolean DEFAULT true,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sys_task" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"storyboard_id" integer,
	"drama_id" integer,
	"scene_id" integer,
	"character_id" integer,
	"prop_id" integer,
	"provider" text,
	"prompt" text,
	"model" text,
	"params" text,
	"task_id" text,
	"result_url" text,
	"local_path" text,
	"status" text DEFAULT 'processing',
	"error_msg" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "video_merges" (
	"id" serial PRIMARY KEY NOT NULL,
	"episode_id" integer,
	"drama_id" integer,
	"title" text,
	"provider" text,
	"model" text,
	"status" text DEFAULT 'pending',
	"scenes" text,
	"merged_url" text,
	"duration" integer,
	"task_id" text,
	"error_msg" text,
	"created_at" text NOT NULL,
	"completed_at" text,
	"deleted_at" text
);
--> statement-breakpoint
ALTER TABLE "creative_models" ADD CONSTRAINT "creative_models_project_id_dramas_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dramas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_pipeline_events" ADD CONSTRAINT "creative_pipeline_events_run_id_creative_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."creative_pipeline_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_pipeline_runs" ADD CONSTRAINT "creative_pipeline_runs_project_id_dramas_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dramas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_projects" ADD CONSTRAINT "creative_projects_project_id_dramas_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dramas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_renders" ADD CONSTRAINT "creative_renders_project_id_dramas_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dramas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_shot_tasks" ADD CONSTRAINT "creative_shot_tasks_project_id_dramas_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dramas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_shot_tasks" ADD CONSTRAINT "creative_shot_tasks_task_id_sys_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."sys_task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_tool_jobs" ADD CONSTRAINT "creative_tool_jobs_project_id_dramas_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dramas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "film_projects" ADD CONSTRAINT "film_projects_project_id_dramas_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dramas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "film_render_jobs" ADD CONSTRAINT "film_render_jobs_project_id_dramas_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dramas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "film_runs" ADD CONSTRAINT "film_runs_project_id_dramas_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dramas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_tool_jobs" ADD CONSTRAINT "production_tool_jobs_project_id_dramas_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dramas"("id") ON DELETE no action ON UPDATE no action;