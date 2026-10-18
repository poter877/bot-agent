import type { CreativeCategory } from '../creative-catalog.js'

export type StageKind =
  | 'research'
  | 'idea'
  | 'proposal'
  | 'script'
  | 'character_design'
  | 'rig_plan'
  | 'scene_plan'
  | 'assets'
  | 'edit'
  | 'compose'
  | 'publish'
export interface PipelineStage {
  id: StageKind
  title: string
  instruction: string
  review: boolean
  produces: string[]
  requires: StageKind[]
}
export interface PipelineDefinition {
  id: string
  category: CreativeCategory
  version: number
  title: string
  delivery: 'movie' | 'clips'
  stages: PipelineStage[]
}
const stages: Record<StageKind, Omit<PipelineStage, 'requires'>> = {
  research: {
    id: 'research',
    title: '资料研究',
    produces: ['research_brief'],
    instruction:
      '从用户资料中提取可核对事实、来源、待核实问题和三个不同切入角度。没有查阅过的网页不能作为已验证来源；缺少资料时明确列出缺口。',
    review: false,
  },
  idea: {
    id: 'idea',
    title: '创作简报',
    review: true,
    produces: ['brief', 'decision_log'],
    instruction: '明确目标观众、主题、时长、素材来源、交付要求和制作限制，记录用户已经确定的选择。',
  },
  proposal: {
    id: 'proposal',
    title: '方案提案',
    review: true,
    produces: ['proposal_packet', 'decision_log'],
    instruction:
      '依据研究提出三个不同创作方案，说明叙事、视觉、声音与可执行工具路径，选出推荐方案。没有价格依据不编造费用，区分已具备和需要用户补充的素材。',
  },
  script: {
    id: 'script',
    title: '脚本与讲稿',
    review: true,
    produces: ['script'],
    instruction:
      '依照已确认简报/提案编写分段脚本，包含段落时长、旁白、画面意图和停顿。已有原片只能引用逐字稿中的原话和时间，不能编造转录或说话人。',
  },
  character_design: {
    id: 'character_design',
    title: '角色设计',
    review: true,
    produces: ['character_design'],
    instruction:
      '形成角色卡：外形、比例、服装、配色、表情、运动特点、各视角不变特征与参考素材编号，供后续每个镜头保持一致。',
  },
  rig_plan: {
    id: 'rig_plan',
    title: '骨骼与表演规划',
    review: true,
    produces: ['rig_plan'],
    instruction:
      '将角色动作拆解成关节/部件、动作状态、约束和表演节奏。明确当前制作路径为生成视频或导入已有动画；启用骨骼绑定时执行真实模型任务，否则只输出规划。规划不得声称已经完成模型绑定或三维渲染。',
  },
  scene_plan: {
    id: 'scene_plan',
    title: '分镜与时序',
    review: true,
    produces: ['scene_plan'],
    instruction: '将前序批准产物转为可编辑镜头。素材编号和时间范围必须真实，每个生成镜头最多15秒。',
  },
  assets: {
    id: 'assets',
    title: '素材制作',
    review: true,
    produces: ['asset_manifest'],
    instruction:
      '复用已经存在的素材，生成缺失镜头，记录每个生成任务和来源；需要原声或专用数字人服务的片段必须先导入。',
  },
  edit: {
    id: 'edit',
    title: '剪辑决策',
    review: true,
    produces: ['edit_decisions'],
    instruction: '校验每段画面、音频、裁剪时序和字幕，生成逐段时间线；保留原声与配音选择。',
  },
  compose: {
    id: 'compose',
    title: '合成与验片',
    review: true,
    produces: ['render_report', 'final_review'],
    instruction: '按批准时间线实际合成，验证输出尺寸、编码、时长，保留已完成的独立片段。请用户预览确认。',
  },
  publish: {
    id: 'publish',
    title: '交付打包',
    review: false,
    produces: ['publish_log'],
    instruction:
      '生成包含成片、字幕、标题、简介、章节和来源说明的交付清单。只在本地准备交付，不自动发布到外部平台。',
  },
}
const generated: StageKind[] = [
  'research',
  'proposal',
  'script',
  'scene_plan',
  'assets',
  'edit',
  'compose',
  'publish',
]
const sourced: StageKind[] = ['idea', 'script', 'scene_plan', 'assets', 'edit', 'compose', 'publish']
function define(
  category: CreativeCategory,
  id: string,
  title: string,
  order: StageKind[],
  guidance: Partial<Record<StageKind, string>> = {},
  delivery: 'movie' | 'clips' = 'movie',
): PipelineDefinition {
  return {
    category,
    id,
    title,
    version: 2,
    delivery,
    stages: order.map((id, index) => ({
      ...stages[id],
      instruction: `${stages[id].instruction}\n${guidance[id] ?? ''}`.trim(),
      requires: order.slice(0, index),
    })),
  }
}
/** Independent definitions and prompts written for our document contract; reference runtime is not imported. */
export const pipelineDefinitions: PipelineDefinition[] = [
  define('explainer', 'animated-explainer', '科普解说', generated, {
    script: '每段只解释一个知识点，区分事实与比喻。',
    scene_plan: '将概念分成图解、对比、示例和总结画面，字幕承载准确文字。',
  }),
  define('animation', 'animation', '动态图形', generated, {
    proposal: '明确运动规则、可复用图形母题、转场规则与动画技术路径。',
    script: '为每个动画段落描述初始、变化与结束状态，保留读图时间。',
  }),
  define(
    'character_animation',
    'character-animation',
    '角色动画',
    [
      'research',
      'proposal',
      'script',
      'character_design',
      'rig_plan',
      'scene_plan',
      'assets',
      'edit',
      'compose',
      'publish',
    ],
    { scene_plan: '引用角色卡与表演规划，保持人物服装、外观、空间关系与动作衔接。' },
  ),
  define('cinematic', 'cinematic', '电影感短片', generated, {
    proposal: '提出不同故事弧线、摄影语言和视觉母题。',
    script: '以具体动作叙事，设计开场、变化与收束，避免无关联画面。',
  }),
  define(
    'documentary',
    'documentary-montage',
    '纪录片 / 视频文章',
    ['idea', 'scene_plan', 'assets', 'edit', 'compose'],
    {
      idea: '先列论点、证据、出处，区分纪录素材与重现画面。',
      scene_plan: '依照简报建立纪录叙事，每个事实只使用用户证据，缺少资料时不虚构。',
    },
  ),
  define('hybrid', 'hybrid', '实拍 + AI 混合', sourced, {
    script: '逐段明确哪些内容必须保留实拍原声、哪些允许生成补充画面。',
    scene_plan: '原片镜头引用sourceId和trimStart，AI补充镜头与真实纪录明确区分。',
  }),
  define('talking_head', 'talking-head', '真人口播 / 访谈', sourced, {
    script: '依据带时码原稿挑选自洽原话，保留上下文，注明可删口误和冗余。',
    scene_plan: '所有主体出镜使用原视频，字幕忠于原话。',
  }),
  define('avatar', 'avatar-spokesperson', '数字人讲解', sourced, {
    idea: '先明确数字人来源、出镜形象和音频路径。精准口型可启用 Sync 服务，输入人物画面和逐镜头配音，或导入专用服务产物。普通生成视频不能视为已完成口型。',
    script: '按自然口语组织短句、停顿和镜头切换。',
  }),
  define('screen_demo', 'screen-demo', '软件演示 / 录屏', sourced, {
    script: '依据用户实际录屏和操作步骤编写教程，不伪造界面或操作结果。',
    scene_plan: '使用真实录屏并留出读屏时间，每段对应一个任务步骤。',
  }),
  define('podcast', 'podcast-repurpose', '播客转视频', sourced, {
    script: '从逐字稿挑选有完整观点的段落，保留嘉宾原话、原音和时间。',
    scene_plan: '音频素材使用波形封面，视频素材保留原画面，所有镜头绑定原始来源。',
  }),
  define(
    'clip_factory',
    'clip-factory',
    '长视频批量切片',
    sourced,
    {
      script: '提出多个可独立理解的选段，包含准确起止时码、标题和选段理由。',
      scene_plan: '每个镜头就是一条独立交付的视频片段，使用源视频，避免句子被截断。',
      compose: '每个片段分别导出成独立视频和字幕。',
    },
    'clips',
  ),
  define('localization', 'localization-dub', '字幕翻译 / 配音', sourced, {
    script: '翻译用户提供的字幕与旁白，保持原意和术语；不改动源时序。',
    scene_plan: '优先沿用已经导入的SRT时序与镜头，原音或替换配音必须明确。',
  }),
]
export function getPipelineDefinition(category: string) {
  return pipelineDefinitions.find((definition) => definition.category === category) ?? null
}
