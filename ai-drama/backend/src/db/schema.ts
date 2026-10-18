/**
 * Drizzle schema - SQLite column mappings.
 * 自 MySQL 迁移：varchar(x)→text（SQLite 不校验长度）、int→integer、
 * boolean→integer boolean mode、时间戳仍为 text 存 ISO 字符串，表/列名不变。
 */
import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core'

export const creativeMessages = sqliteTable('creative_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  role: text('role').notNull(),
  content: text('content').notNull(),
  actions: text('actions').notNull().default('[]'),
  status: text('status').notNull().default('completed'),
  createdAt: text('created_at').notNull(),
})

export const dramas = sqliteTable('dramas', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  projectType: text('project_type').notNull().default('drama'),
  creativeCategory: text('creative_category'),
  filmStyle: text('film_style'),
  description: text('description'),
  genre: text('genre'),
  style: text('style').default('3d'),
  aspectRatio: text('aspect_ratio').default('16:9'),
  totalEpisodes: integer('total_episodes').default(1),
  totalDuration: integer('total_duration').default(0),
  status: text('status').notNull().default('draft'),
  thumbnail: text('thumbnail'),
  tags: text('tags'),
  metadata: text('metadata'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const episodes = sqliteTable('episodes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  episodeNumber: integer('episode_number').notNull(),
  title: text('title').notNull(),
  content: text('content'),
  scriptContent: text('script_content'),
  description: text('description'),
  duration: integer('duration').default(0),
  status: text('status').default('draft'),
  videoUrl: text('video_url'),
  thumbnail: text('thumbnail'),
  imageConfigId: integer('image_config_id'),
  videoConfigId: integer('video_config_id'),
  resolution: text('resolution').default('720p'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const characters = sqliteTable('characters', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  name: text('name').notNull(),
  role: text('role'),
  description: text('description'),
  appearance: text('appearance'),
  styling: text('styling'),
  finalPrompt: text('final_prompt'),
  personality: text('personality'),
  imageUrl: text('image_url'),
  referenceImages: text('reference_images'),
  seedValue: text('seed_value'),
  sortOrder: integer('sort_order'),
  localPath: text('local_path'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

// Episode-Character many-to-many
export const episodeCharacters = sqliteTable('episode_characters', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  characterId: integer('character_id').notNull(),
  createdAt: text('created_at').notNull(),
})

// Episode-Scene many-to-many
export const episodeScenes = sqliteTable('episode_scenes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  sceneId: integer('scene_id').notNull(),
  createdAt: text('created_at').notNull(),
})

// Episode-Prop many-to-many
export const episodeProps = sqliteTable('episode_props', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  propId: integer('prop_id').notNull(),
  createdAt: text('created_at').notNull(),
})

export const scenes = sqliteTable('scenes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  episodeId: integer('episode_id'),
  location: text('location').notNull(),
  time: text('time').notNull(),
  prompt: text('prompt').notNull(),
  lighting: text('lighting'),
  finalPrompt: text('final_prompt'),
  storyboardCount: integer('storyboard_count').default(1),
  imageUrl: text('image_url'),
  status: text('status').default('pending'),
  localPath: text('local_path'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const storyboards = sqliteTable('storyboards', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  sceneId: integer('scene_id'),
  storyboardNumber: integer('storyboard_number').notNull(),
  title: text('title'),
  location: text('location'),
  time: text('time'),
  shotType: text('shot_type'),
  angle: text('angle'),
  movement: text('movement'),
  result: text('result'),
  atmosphere: text('atmosphere'),
  imagePrompt: text('image_prompt'),
  videoPrompt: text('video_prompt'),
  bgmPrompt: text('bgm_prompt'),
  soundEffect: text('sound_effect'),
  description: text('description'),
  duration: integer('duration').default(0),
  composedImage: text('composed_image'),
  firstFrameImage: text('first_frame_image'),
  lastFrameImage: text('last_frame_image'),
  referenceImages: text('reference_images'),
  videoUrl: text('video_url'),
  subtitleUrl: text('subtitle_url'),
  composedVideoUrl: text('composed_video_url'),
  status: text('status').default('pending'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const storyboardCharacters = sqliteTable('storyboard_characters', {
  storyboardId: integer('storyboard_id').notNull(),
  characterId: integer('character_id').notNull(),
}, (table) => [
  primaryKey({ columns: [table.storyboardId, table.characterId] }),
])

export const storyboardProps = sqliteTable('storyboard_props', {
  storyboardId: integer('storyboard_id').notNull(),
  propId: integer('prop_id').notNull(),
}, (table) => [
  primaryKey({ columns: [table.storyboardId, table.propId] }),
])

export const aiServiceConfigs = sqliteTable('ai_service_configs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  serviceType: text('service_type').notNull(),
  provider: text('provider'),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  apiKey: text('api_key').notNull(),
  model: text('model'),
  endpoint: text('endpoint'),
  queryEndpoint: text('query_endpoint'),
  priority: integer('priority').default(0),
  isDefault: integer('is_default', { mode: 'boolean' }).default(false),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  settings: text('settings'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  // 注意: 此表无 deleted_at
})

export const aiServiceProviders = sqliteTable('ai_service_providers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  displayName: text('display_name'),
  serviceType: text('service_type').notNull(),
  provider: text('provider').notNull(),
  defaultUrl: text('default_url'),
  presetModels: text('preset_models'),
  description: text('description'),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const stylePresets = sqliteTable('style_presets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  value: text('value').notNull(),
  prompt: text('prompt').notNull(),
  description: text('description'),
  sortOrder: integer('sort_order').default(0),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  // 注意: 此表无 deleted_at（硬删除），value 列有唯一索引（见 sqlite-schema.ts DDL）
})

// 统一生成任务表：图片/视频生成共用，type 区分，生成参数存 params(JSON)
export const sysTask = sqliteTable('sys_task', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(), // image | video
  storyboardId: integer('storyboard_id'),
  dramaId: integer('drama_id'),
  sceneId: integer('scene_id'),
  characterId: integer('character_id'),
  propId: integer('prop_id'),
  provider: text('provider'),
  prompt: text('prompt'),
  model: text('model'),
  // image: {size, frameType, referenceImages[]}
  // video: {referenceMode, firstFrameUrl, lastFrameUrl, referenceImageUrls[], referenceVideoUrls[], referenceAudioUrls[], referenceFileUrl, referenceLinkUrl, generateAudio, duration, aspectRatio, resolution, seed, promptExtend, watermark}
  params: text('params'),
  taskId: text('task_id'),
  resultUrl: text('result_url'),
  localPath: text('local_path'),
  status: text('status').default('processing'),
  errorMsg: text('error_msg'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
})

export const videoMerges = sqliteTable('video_merges', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id'),
  dramaId: integer('drama_id'),
  title: text('title'),
  provider: text('provider'),
  model: text('model'),
  status: text('status').default('pending'),
  scenes: text('scenes'), // JSON
  mergedUrl: text('merged_url'),
  duration: integer('duration'),
  taskId: text('task_id'),
  errorMsg: text('error_msg'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
  deletedAt: text('deleted_at'),
})

export const props = sqliteTable('props', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  name: text('name').notNull(),
  type: text('type'),
  description: text('description'),
  prompt: text('prompt'),
  finalPrompt: text('final_prompt'),
  imageUrl: text('image_url'),
  referenceImages: text('reference_images'),
  localPath: text('local_path'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const assets = sqliteTable('assets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id'),
  episodeId: integer('episode_id'),
  storyboardId: integer('storyboard_id'),
  storyboardNum: integer('storyboard_num'),
  name: text('name'),
  description: text('description'),
  type: text('type'),
  category: text('category'),
  url: text('url'),
  thumbnailUrl: text('thumbnail_url'),
  localPath: text('local_path'),
  fileSize: integer('file_size'),
  mimeType: text('mime_type'),
  width: integer('width'),
  height: integer('height'),
  duration: integer('duration'),
  format: text('format'),
  imageGenId: integer('image_gen_id'),
  videoGenId: integer('video_gen_id'),
  isFavorite: integer('is_favorite', { mode: 'boolean' }).default(false),
  viewCount: integer('view_count').default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// Creative videos are independent documents, never synthetic episodes/storyboards.
export const creativeProjects = sqliteTable('creative_projects', {
  projectId: integer('project_id').primaryKey().references(() => dramas.id),
  revision: integer('revision').notNull().default(1),
  approvedRevision: integer('approved_revision'),
  document: text('document').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const creativeShotTasks = sqliteTable('creative_shot_tasks', {
  projectId: integer('project_id').notNull().references(() => dramas.id),
  shotId: text('shot_id').notNull(),
  kind: text('kind').notNull(),
  fingerprint: text('fingerprint').notNull(),
  taskId: integer('task_id').notNull().references(() => sysTask.id),
}, table => [primaryKey({ columns: [table.projectId, table.shotId, table.kind] })])

export const creativeRenders = sqliteTable('creative_renders', {
  outputs: text('outputs').notNull().default('[]'),
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => dramas.id),
  revision: integer('revision').notNull(),
  snapshot: text('snapshot').notNull(),
  status: text('status').notNull().default('pending'),
  progress: integer('progress').notNull().default(0),
  videoUrl: text('video_url'),
  subtitleUrl: text('subtitle_url'),
  duration: real('duration'),
  errorMsg: text('error_msg'),
  warnings: text('warnings').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
})

export const creativePipelineRuns = sqliteTable('creative_pipeline_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => dramas.id),
  definition: text('definition').notNull(),
  snapshot: text('snapshot').notNull(),
  revision: integer('revision').notNull(),
  version: integer('version').notNull().default(1),
  status: text('status').notNull().default('ready'),
  cursor: integer('cursor').notNull().default(0),
  stages: text('stages').notNull(),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})
export const filmProjects = sqliteTable('film_projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => dramas.id),
  styleSlug: text('style_slug').notNull(),
  topic: text('topic').notNull().default(''),
  language: text('language').notNull().default('zh'),
  durationSec: integer('duration_sec').notNull().default(45),
  hasVoice: integer('has_voice').notNull().default(1),
  revision: integer('revision').notNull().default(1),
  updatedAt: text('updated_at').notNull(),
})
export const filmRuns = sqliteTable('film_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => dramas.id),
  definition: text('definition').notNull(),
  status: text('status').notNull().default('ready'),
  cursor: integer('cursor').notNull().default(0),
  stages: text('stages').notNull(),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})
export const filmRenderJobs = sqliteTable('film_render_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => dramas.id),
  runId: integer('run_id'),
  status: text('status').notNull().default('pending'),
  progress: integer('progress').notNull().default(0),
  phase: text('phase'),
  videoUrl: text('video_url'),
  posterUrl: text('poster_url'),
  srtUrl: text('srt_url'),
  errorMsg: text('error_msg'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})
export const creativePipelineEvents = sqliteTable('creative_pipeline_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id').notNull().references(() => creativePipelineRuns.id),
  stageId: text('stage_id'),
  kind: text('kind').notNull(),
  payload: text('payload').notNull(),
  createdAt: text('created_at').notNull(),
})

export const creativeToolJobs = sqliteTable('creative_tool_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => dramas.id),
  kind: text('kind').notNull(), fingerprint: text('fingerprint').notNull(),
  revision: integer('revision').notNull(), input: text('input').notNull(),
  status: text('status').notNull().default('queued'), remoteId: text('remote_id'),
  progress: integer('progress').notNull().default(0), result: text('result').notNull().default('{}'),
  error: text('error'), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
})
export const creativeModels = sqliteTable('creative_models', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => dramas.id),
  name: text('name').notNull(), url: text('url').notNull(), metadata: text('metadata').notNull(),
  createdAt: text('created_at').notNull(),
})

/** Durable, per-project production-tool work, separate from engine stage checkpoints. */
export const productionToolJobs = sqliteTable('production_tool_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull().references(() => dramas.id),
  toolId: text('tool_id').notNull(), fingerprint: text('fingerprint').notNull(),
  revision: integer('revision').notNull(), input: text('input').notNull(),
  state: text('state').notNull().default('{}'), status: text('status').notNull().default('queued'),
  progress: integer('progress').notNull().default(0), result: text('result').notNull().default('{}'),
  error: text('error'), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
})
