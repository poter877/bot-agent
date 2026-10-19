/**
 * MCP 服务端 — 把 agent 领域工具暴露为 MCP tools，供外部编排大脑（hermes）调用。
 *
 * 两类工具：
 * 1. src/agents/tools/ 的全部领域工具（只包不改）：原本地工具循环经 toolsContext
 *    按请求注入 episodeId/dramaId；MCP 调用方没有这条注入链，因此把这两个上下文字段
 *    并入每个工具的 input schema 作为可选入参，handler 抽出后拼成 options.context
 *    喂给工具体内既有的守卫逻辑（缺省时守卫返回 error 结果，行为与原来一致）。
 *    其余上下文字段（modelOverride/textConfigId/language）只在构建本地工具循环时
 *    消费，工具 execute 不读，不并入。
 * 2. 生成任务工具：submit_image_task / submit_video_task 包 services/generation 的
 *    入队函数，get_task_status 读 sys_task —— film pipeline 的驱动权由此外移。
 * 3. film build 工程工具：write_file / render_frame / run_blender / generate_texture
 *    包 services/film-pipeline/build-tools.ts（原 film build 循环的内联工具提取）。
 *    render_frame/run_blender 的结果携带 ImageContent，hermes 的 MCP 客户端原生
 *    回喂模型完成渲帧自检闭环。
 *
 * 会话/状态：无状态调用，每次 tools/call 带齐参数（transport 层见 route.ts）。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { AgentToolContext, AgentToolSet } from '../agents/context.js'
import { extractTools } from '../agents/tools/extract-tools.js'
import { imagePromptTools } from '../agents/tools/image-prompt-tools.js'
import { scriptTools } from '../agents/tools/script-tools.js'
import { storyboardTools } from '../agents/tools/storyboard-tools.js'
import { db, schema } from '../db/index.js'
import { generateImage, generateVideo } from '../services/generation.js'
import {
  generateProjectTexture,
  renderProjectFrame,
  runProjectBlender,
  writeProjectFile,
} from '../services/film-pipeline/build-tools.js'

type AgentTool = AgentToolSet[string]

/** 并入每个工具入参的请求上下文字段（可选）。字段名与 agentContextSchema 一致，
 *  handler 原样放入 options.context */
const CONTEXT_INPUT_FIELDS = {
  episodeId: z.number().optional().describe(
    'Request context: current episode id. Tools with an episode scope need it; omitting makes the tool return an error result.',
  ),
  dramaId: z.number().optional().describe(
    'Request context: drama project id. Tools with a project scope need it; omitting makes the tool return an error result.',
  ),
}

/** 工具原 inputSchema 是 zod object（tool({ inputSchema: z.object({...}) })），取其 raw shape */
function inputShape(agentTool: AgentTool): z.ZodRawShape {
  const shape = (agentTool.inputSchema as z.ZodObject | undefined)?.shape
  if (!shape || typeof shape !== 'object') {
    throw new Error('MCP wrap: agent tool inputSchema is not a zod object schema')
  }
  return shape
}

/** description 是 Resolvable（静态定义均为 string；函数形态按无 context 解析） */
function toolDescription(name: string, agentTool: AgentTool): string {
  const d = agentTool.description
  if (typeof d === 'string') return d || name
  if (typeof d === 'function') return d({ context: undefined as unknown as AgentToolContext })
  return name
}

/** 工具体只读 context.episodeId/dramaId 且守卫容忍缺省（typeof 检查），可空拼装 */
function contextFromInput(input: { episodeId?: unknown; dramaId?: unknown }): AgentToolContext {
  const context: Record<string, unknown> = {}
  if (typeof input.episodeId === 'number') context.episodeId = input.episodeId
  if (typeof input.dramaId === 'number') context.dramaId = input.dramaId
  return context as AgentToolContext
}

/** MCP 工具结果统一为 JSON 文本（hermes 侧解析 text）；领域工具的 { error } 也是普通返回值 */
function jsonResult(output: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(output) }] }
}

function registerAgentToolSet(server: McpServer, tools: AgentToolSet) {
  for (const [name, agentTool] of Object.entries(tools)) {
    if (!agentTool.execute) throw new Error(`MCP wrap: agent tool ${name} has no execute`)
    const execute = agentTool.execute
    server.registerTool(name, {
      description: toolDescription(name, agentTool),
      inputSchema: { ...inputShape(agentTool), ...CONTEXT_INPUT_FIELDS },
    }, async (input, extra) => {
      const { episodeId, dramaId, ...toolInput } = input ?? {}
      const output = await execute(toolInput, {
        toolCallId: `mcp-${name}-${String(extra.requestId)}`,
        messages: [],
        context: contextFromInput({ episodeId, dramaId }),
      })
      return jsonResult(output)
    })
  }
}

function registerTaskTools(server: McpServer) {
  server.registerTool('submit_image_task', {
    description: 'Submit an image generation task (sys_task). Returns { task_id } immediately; poll it with get_task_status. Uses the active image AI config unless config_id is given.',
    inputSchema: {
      prompt: z.string().describe('Image prompt'),
      model: z.string().optional(),
      size: z.string().optional().describe('e.g. 1920x1080 (default)'),
      reference_images: z.array(z.string()).optional().describe('Reference images (data URL / static path / http URL)'),
      frame_type: z.string().optional().describe('Storyboard frame to write back: first_frame | last_frame | composed (default)'),
      storyboard_id: z.number().optional(),
      drama_id: z.number().optional(),
      scene_id: z.number().optional(),
      character_id: z.number().optional(),
      prop_id: z.number().optional(),
      config_id: z.number().optional().describe('AI config id; omit to use the active image config'),
    },
  }, async (input) => jsonResult({ task_id: await generateImage({
    prompt: input.prompt,
    model: input.model,
    size: input.size,
    referenceImages: input.reference_images,
    frameType: input.frame_type,
    storyboardId: input.storyboard_id,
    dramaId: input.drama_id,
    sceneId: input.scene_id,
    characterId: input.character_id,
    propId: input.prop_id,
    configId: input.config_id,
  }) }))

  server.registerTool('submit_video_task', {
    description: 'Submit a video generation task (sys_task). Returns { task_id } immediately; poll it with get_task_status. Uses the active video AI config unless config_id is given.',
    inputSchema: {
      prompt: z.string().optional().describe('Video prompt (omit when driving purely with reference media)'),
      model: z.string().optional(),
      image_url: z.string().optional().describe('Reference image (data URL / static path / http URL)'),
      first_frame_url: z.string().optional(),
      last_frame_url: z.string().optional(),
      reference_image_urls: z.array(z.string()).optional(),
      reference_video_urls: z.array(z.string()).optional().describe('Needs PUBLIC_BASE_URL configured when using local static paths'),
      reference_audio_urls: z.array(z.string()).optional().describe('Needs PUBLIC_BASE_URL configured when using local static paths'),
      file_url: z.string().optional(),
      link_url: z.string().optional(),
      duration: z.number().optional(),
      aspect_ratio: z.string().optional(),
      resolution: z.string().optional().describe('480p | 720p | 1080p | 2k'),
      seed: z.number().optional(),
      generate_audio: z.boolean().optional().default(true),
      prompt_extend: z.boolean().optional(),
      watermark: z.boolean().optional(),
      storyboard_id: z.number().optional(),
      drama_id: z.number().optional(),
      config_id: z.number().optional().describe('AI config id; omit to use the active video config'),
    },
  }, async (input) => jsonResult({ task_id: await generateVideo({
    prompt: input.prompt ?? '',
    model: input.model,
    imageUrl: input.image_url,
    firstFrameUrl: input.first_frame_url,
    lastFrameUrl: input.last_frame_url,
    referenceImageUrls: input.reference_image_urls,
    referenceVideoUrls: input.reference_video_urls,
    referenceAudioUrls: input.reference_audio_urls,
    referenceFileUrl: input.file_url,
    referenceLinkUrl: input.link_url,
    generateAudio: input.generate_audio,
    duration: input.duration,
    aspectRatio: input.aspect_ratio,
    resolution: input.resolution,
    seed: input.seed,
    promptExtend: input.prompt_extend,
    watermark: input.watermark,
    storyboardId: input.storyboard_id,
    dramaId: input.drama_id,
    configId: input.config_id,
  }) }))

  server.registerTool('get_task_status', {
    description: 'Read a generation task from sys_task (fields: id, type, status: processing|completed|failed, result_url, local_path, error_msg, ...). Use it to poll submit_image_task / submit_video_task.',
    inputSchema: {
      task_id: z.number(),
    },
  }, async ({ task_id }) => {
    const [row] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, task_id))
    return jsonResult(row ?? { error: `Task ${task_id} not found` })
  })
}

/** film build 工程工具：路径沙箱/日志/JPEG 回喂都在 build-tools.ts，这里只声明 wire 契约 */
function registerBuildTools(server: McpServer) {
  server.registerTool('write_file', {
    description: 'Write a file inside the film project workspace (relative path; ../ traversal is rejected). Every write is logged to the project agent.log.',
    inputSchema: {
      projectId: z.number().describe('Film project id the build loop is working on'),
      path: z.string().describe('Relative path inside the project workspace, e.g. index.html, ink.js'),
      content: z.string().describe('Full file content'),
    },
  }, async ({ projectId, path: rel, content }) => writeProjectFile({ projectId, path: rel, content }))

  server.registerTool('render_frame', {
    description: 'Render the current film project at time t (seconds) with film-core and return the JPEG as an image for visual self-check against STYLE.md.',
    inputSchema: {
      projectId: z.number(),
      t: z.number().describe('Time point in seconds'),
      note: z.string().optional().describe('What this frame is meant to verify'),
      aspect_ratio: z.string().optional().describe('Aspect ratio like 16:9 / 9:16 (drives frame size); defaults to 16:9'),
    },
  }, async ({ projectId, t, note, aspect_ratio }) => renderProjectFrame({ projectId, t, note, aspectRatio: aspect_ratio }))

  server.registerTool('run_blender', {
    description: 'Run a headless bpy script from the project workspace (write it with write_file first). Use for modeling, exporting GLB assets, rendering PNG self-checks. Fixed camera and seeds, no randomness. Script reads business args from sys.argv after "--" ([0]=absolute output image path).',
    inputSchema: {
      projectId: z.number(),
      script: z.string().describe('Relative path of the .py script inside the project'),
      output_image: z.string().describe('Relative path the script renders its PNG/JPG result to (the script receives its absolute path via sys.argv after "--")'),
      args: z.array(z.string()).optional().describe('Extra args appended for the script (sys.argv[2:])'),
    },
  }, async ({ projectId, script, output_image, args }) => runProjectBlender({ projectId, script, output_image, args }))

  server.registerTool('generate_texture', {
    description: 'Generate a texture PNG/JPG with the image model into the project workspace. The prompt must state: flat lighting, no shadows/highlights, seamless tileable texture, appearance only. For Blender/three.js albedo use.',
    inputSchema: {
      projectId: z.number(),
      prompt: z.string().describe('Texture description (include flat lighting / seamless / texture only constraints)'),
      filename: z.string().describe('Relative path to save, e.g. assets/rust_metal.png'),
    },
  }, async ({ projectId, prompt, filename }) => generateProjectTexture({ projectId, prompt, filename }))
}

/** 构建一个装好全部工具的 McpServer（route.ts 按请求各建一个，无状态） */
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'ai-drama', version: '1.0.0' })
  registerAgentToolSet(server, scriptTools)
  registerAgentToolSet(server, extractTools)
  registerAgentToolSet(server, storyboardTools)
  registerAgentToolSet(server, imagePromptTools)
  registerTaskTools(server)
  registerBuildTools(server)
  return server
}
