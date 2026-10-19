/** 影片风格 pipeline 的阶段定义。
 *
 * 43 种 Lemo-Opuscar 风格共享这一条流程（Lemo 官方即单流程：DIRECTOR/TECHNIQUE
 * 全库共用，风格差异全部由 STYLE.md 约束注入）。阶段顺序固定：
 *
 *   treatment → style_frames → script → timeline → score → build → render → deliver
 *
 * - treatment/script/timeline/score/build 为文本/代码生成阶段（AI 按 STYLE.md
 *   + 两份指南产出，review 门槛等待用户确认）
 * - style_frames 用真实渲染代码画风格定妆帧（build 的先导，产物同样落工程目录）
 * - render 为异步渲染作业（film-core 逐帧渲染 + mux），作业进度轮询推进
 * - deliver 汇总成片/poster/srt 与制作清单
 */
export type FilmStageKind =
  | 'treatment'
  | 'style_frames'
  | 'script'
  | 'timeline'
  | 'score'
  | 'build'
  | 'render'
  | 'deliver'

export interface FilmStage {
  id: FilmStageKind
  title: string
  /** 注入给执行 agent 的阶段说明（与 STYLE.md/guides 拼接） */
  instruction: string
  /** 完成后是否需要用户确认才进入下一阶段 */
  review: boolean
  produces: string
}

const STAGE_TABLE: Record<FilmStageKind, Omit<FilmStage, 'id'>> = {
  treatment: {
    title: '导演阐述',
    review: true,
    produces: 'treatment',
    instruction: [
      '按 DIRECTOR 指南 §2–§4 写 TREATMENT.md：',
      '1) 一个对标参照（学什么/不学什么，只学语法不搬内容）；',
      '2) 三个候选结构（各两三行）并选出其一、说明理由；',
      '3) 一句话故事与 起→转→收 弧线；',
      '4) 镜头清单：每镜的景别/角度/运镜/时长/为什么这么拍；',
      '5) 逐秒节拍表；',
      '6) cue map：分段 tempo/BPM/小节网格、乐器编制，每个剪辑点与关键动作落在哪一拍；',
      '7) 声音设计表：每段的底噪/拟音/音乐状态；',
      '8) 字幕与标题设计（字体属于风格的一部分）。',
      '先想再写：某风格的第一直觉通常是它的俗套，避开它。',
    ].join('\n'),
  },
  style_frames: {
    title: '风格定妆帧',
    review: true,
    produces: 'style_frames',
    instruction: [
      '按 DIRECTOR §5 用真实渲染代码证明视觉：',
      '- 有角色：模型表（转面、3–4 个表情、2–3 个关键姿势、配色）+ 两张风格帧；',
      '- 无角色：三张风格帧，其中一张是招牌镜头。',
      '产出工程内的 frames 入口（可独立渲染的页面/函数），帧必须遵守 STYLE.md 的材质、色彩与字体规则；',
      '说明每帧检验了 STYLE.md 的哪些条款。',
    ].join('\n'),
  },
  script: {
    title: '旁白与字幕',
    review: true,
    produces: 'script',
    instruction: [
      '产出 lines.json（逐行 {id, text, voice?, speed?}）与字幕设计说明：',
      '- 数字在念稿里拼写成词、在字幕里写数字；',
      '- 每条字幕停留 ≥ max(1.8s, 语音+0.6s)，标题卡 ≥ 4s；',
      '- 台词/旁白语言与项目语言一致；风格的声音气质（画外音角色）在 STYLE.md 声音色盘中。',
    ].join('\n'),
  },
  timeline: {
    title: '时间线',
    review: true,
    produces: 'timeline',
    instruction: [
      '产出 timeline：sections（id/t/bpm/beats）、hit points（事件→小节）、EV 声音事件表。',
      '一条时间线驱动画面/配音/音乐/音效/字幕（TECHNIQUE §3）；至少两次以声音作转场（J/L-cut）、至少两处真实静默；',
      '节奏有快慢交替与一次明显加/减速；不要每一拍都剪。',
    ].join('\n'),
  },
  score: {
    title: '配乐与拟音谱',
    review: true,
    produces: 'score',
    instruction: [
      '按 cue map 写配乐谱与拟音清单：乐器来自 STYLE.md 声音色盘（禁止通用钢琴弦乐）；',
      '拟音按材质（纸/木/金属/墨/玻璃…）逐动作登记；混音特征（duck、−14 LUFS）；',
      '低频平衡注意事项（TECHNIQUE §5）。',
    ].join('\n'),
  },
  build: {
    title: '影片工程',
    review: true,
    produces: 'build',
    instruction: [
      '写完整影片工程代码并落盘：',
      '- index.html 暴露页面契约：window.DUR、window.render(t)（确定性：无 Date.now、未播种随机、不跨帧存状态）、window.READY、window.EV、window.TEXTS(t)；',
      '- 库文件用绝对 URL 引用（/core/lib.js、/node_modules/three/…）；',
      '- 混音脚本 mix.py：按 EV 合成拟音、叠加配乐与配音（引用 core.audio 工具）；',
      '- 渲染档位遵守风格 renderProfile（2d: Canvas2D；shader: WebGL2 后期；3d: three.js）。',
      '工程目录结构、文件清单与一键 build 命令一并写出。',
    ].join('\n'),
  },
  render: {
    title: '渲染合成',
    review: false,
    produces: 'render',
    instruction: '渲染作业：导出事件 → 逐帧渲染（24fps）→ 混音（如工程提供）→ mux 合成 −14 LUFS → 海报帧。进度由作业回传。',
  },
  deliver: {
    title: '交付',
    review: false,
    produces: 'deliver',
    instruction: '汇总交付清单：成片 mp4、poster、srt、工程源码位置与制作说明。',
  },
}

export const FILM_STAGE_ORDER: FilmStageKind[] = [
  'treatment',
  'style_frames',
  'script',
  'timeline',
  'score',
  'build',
  'render',
  'deliver',
]

export interface FilmPipelineDefinition {
  id: 'film'
  version: 1
  stages: FilmStage[]
}

export function filmPipelineDefinition(): FilmPipelineDefinition {
  return {
    id: 'film',
    version: 1,
    stages: FILM_STAGE_ORDER.map((id) => ({ id, ...STAGE_TABLE[id] })),
  }
}
