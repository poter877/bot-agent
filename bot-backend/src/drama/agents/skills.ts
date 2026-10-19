/**
 * Agent 技能加载 — 直读 backend/workspace/skills/ 下的 SKILL.md
 * 注入 instructions 时拼接技能全文（保证行为一致）
 *
 * 注意：workspace 目录名在提示词文案里刻意不出现——
 * 路径里含 workspace 目录名时，Gemini 系低思考档位下
 * 偶发把其脑补成 Google Workspace 然后以"组织政策"为由拒绝调用工具。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
// 桌面版由 Electron 主进程注入 WORKSPACE_PATH（userData 下的可写副本）；dev 锚定 backend/workspace
const WORKSPACE_DIR = process.env.WORKSPACE_PATH
  ? path.resolve(process.env.WORKSPACE_PATH)
  : path.resolve(__dirname, '../../workspace')
const SKILLS_DIR = path.join(WORKSPACE_DIR, 'skills')

// 启动时确保工作目录存在（技能/提示词文件的 jail 根）
// 桌面版打包后模块可能仍从只读位置加载，失败不阻断启动（路由层会给出明确报错）
try {
  fs.mkdirSync(SKILLS_DIR, { recursive: true })
} catch (err) {
  console.warn(`[skills] 工作目录创建失败（只读环境？）: ${(err as Error).message}`)
}

/** 相对路径 → jail 在 WORKSPACE_DIR 内的绝对路径（越界拒绝，保持原 workspace filesystem 的隔离语义） */
function resolveWorkspacePath(relPath: string): string {
  const full = path.resolve(WORKSPACE_DIR, relPath)
  if (full !== WORKSPACE_DIR && !full.startsWith(WORKSPACE_DIR + path.sep)) {
    throw new Error(`路径越出工作目录：${relPath}`)
  }
  return full
}

/** workspace 文件读写（相对 WORKSPACE_DIR；原 Mastra LocalFilesystem 的最小替代面） */
export const workspaceFs = {
  exists(relPath: string): Promise<boolean> {
    return Promise.resolve(fs.existsSync(resolveWorkspacePath(relPath)))
  },
  async readFile(relPath: string, _opts?: { encoding?: 'utf-8' }): Promise<string> {
    return fs.readFileSync(resolveWorkspacePath(relPath), { encoding: 'utf-8' })
  },
  async writeFile(relPath: string, content: string, opts?: { recursive?: boolean; overwrite?: boolean }): Promise<void> {
    const full = resolveWorkspacePath(relPath)
    if (opts?.recursive) fs.mkdirSync(path.dirname(full), { recursive: true })
    if (opts?.overwrite === false && fs.existsSync(full)) throw new Error(`文件已存在：${relPath}`)
    fs.writeFileSync(full, content)
  },
  async deleteFile(relPath: string): Promise<void> {
    fs.rmSync(resolveWorkspacePath(relPath))
  },
  async rmdir(relPath: string, opts?: { recursive?: boolean }): Promise<void> {
    fs.rmSync(resolveWorkspacePath(relPath), { recursive: opts?.recursive })
  },
}

/** 从 SKILL.md 风格文本解析 frontmatter 的 name/description 标量字段 */
function parseFrontmatter(raw: string): { name?: string; description?: string } {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] || ''
  const get = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(fm)?.[1]?.trim()
  return { name: get('name'), description: get('description') }
}

/** 每个 Agent 注册的 skill 目录（相对 workspace/skills/，含子规范目录；目录名需符合 Agent Skills 规范：小写+连字符） */
const AGENT_SKILL_MAP: Record<string, string[]> = {
  script_rewriter: ['script-rewriter'],
  extractor: ['extractor'],
  storyboard_breaker: ['storyboard-breaker'],
  prompt_generator: [
    'prompt-generator/character-prompt',
    'prompt-generator/scene-prompt',
    'prompt-generator/prop-prompt',
    'prompt-generator/video-prompt',
  ],
}

/** 递归扫描 workspace/skills/ 下所有含 SKILL.md 的目录（相对 workspace 根的路径） */
function scanSkillPaths(): string[] {
  const found: string[] = []
  const walk = (dir: string, prefix: string) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = path.join(dir, entry.name)
      if (fs.existsSync(path.join(full, 'SKILL.md'))) found.push(`skills/${rel}`)
      walk(full, rel)
    }
  }
  walk(SKILLS_DIR, '')
  return found
}

/** 技能元数据列表（设置页用；原 workspace.skills.list() 的直读替代） */
export async function listSkillMetas(): Promise<Array<{ path: string; name: string; description: string }>> {
  return scanSkillPaths().map(relPath => {
    let name = relPath.replace(/^skills\//, '')
    let description = ''
    try {
      const fm = parseFrontmatter(fs.readFileSync(path.join(WORKSPACE_DIR, relPath, 'SKILL.md'), { encoding: 'utf-8' }))
      if (fm.name) name = fm.name
      if (fm.description) description = fm.description
    } catch {
      // 读失败的技能目录按目录名呈现，不阻断列表
    }
    return { path: relPath, name, description }
  })
}

function formatSkillSection(skillId: string, content: string): string {
  return [`## Skill: ${skillId}`, content].join('\n')
}

/** 剥离 SKILL.md 风格文件的 frontmatter，返回正文（供语言变体直读使用） */
function stripFrontmatter(raw: string): string {
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return (m ? raw.slice(m[0].length) : raw).trim()
}

/** 读取技能的语言变体正文（SKILL.<lang>.md，直读永远最新）；不存在返回 null */
async function readLocalizedSkill(relPath: string, lang: string): Promise<string | null> {
  const p = `skills/${relPath}/SKILL.${lang}.md`
  try {
    if (!await workspaceFs.exists(p)) return null
    const body = stripFrontmatter(await workspaceFs.readFile(p))
    return body || null
  } catch {
    return null
  }
}

/** 读取 Agent 专属技能全文（直读 SKILL.md 正文，注入格式不变）
 *  AGENT_SKILL_MAP 的目录按前缀匹配：目录自身及其子目录下所有 SKILL.md 都会注入，
 *  因此设置页新建的子技能（如 storyboard-breaker/xxx）无需改代码即可生效。
 *  lang 非 zh 时逐技能优先 SKILL.<lang>.md，缺失回退基础版（中文） */
export async function loadAgentSkills(agentType: string, lang?: string | null): Promise<string> {
  const prefixes = AGENT_SKILL_MAP[agentType] || []
  if (!prefixes.length) return ''

  const allPaths = scanSkillPaths().map(p => p.replace(/^skills\//, ''))
  const relPaths = allPaths.filter(p =>
    prefixes.some(prefix => p === prefix || p.startsWith(prefix + '/')))

  const useLocalized = Boolean(lang && lang !== 'zh')
  const contents: string[] = []
  for (const relPath of relPaths) {
    let body: string | null | undefined
    if (useLocalized) body = await readLocalizedSkill(relPath, lang!)
    if (!body) {
      const raw = await workspaceFs.readFile(`skills/${relPath}/SKILL.md`).catch(() => null)
      body = raw ? stripFrontmatter(raw) : null
    }
    if (body) contents.push(formatSkillSection(relPath, body))
  }

  if (!contents.length) return ''

  return [
    '以下是该 Agent 专属的项目技能规范（SKILL.md）。',
    '不同 Agent 会加载不同 skill；你只需要遵守当前注入的这些技能。',
    '你必须在不违背当前工具边界的前提下优先遵守这些规范；若与用户明确要求冲突，以用户要求为准。',
    '',
    contents.join('\n\n'),
  ].join('\n')
}
