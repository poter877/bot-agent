from pathlib import Path
from html import escape
import json
import xml.etree.ElementTree as ET

ROOT = Path("/Users/ll/Desktop/ai-drama/draft_f2111900_folder")
blocks = []
title = "CSS → Tailwind CSS 生产级重构计划"

def p(text):
    blocks.append("<p>" + escape(text) + "</p>")

def h(text, level=1):
    blocks.append(f'<h{level} seq="auto">' + escape(text) + f"</h{level}>")

def ul(items):
    blocks.append("<ul>" + "".join("<li>" + escape(x) + "</li>" for x in items) + "</ul>")

def table(headers, rows):
    widths = {2: [220, 550], 3: [170, 275, 325], 4: [130, 215, 240, 185]}[len(headers)]
    cols = "<colgroup>" + "".join(f'<col width="{w}"/>' for w in widths) + "</colgroup>"
    head = "<thead><tr>" + "".join('<th background-color="light-gray"><p>' + escape(x) + "</p></th>" for x in headers) + "</tr></thead>"
    body = "<tbody>" + "".join("<tr>" + "".join("<td><p>" + escape(str(x)) + "</p></td>" for x in row) + "</tr>" for row in rows) + "</tbody>"
    blocks.append("<table>" + cols + head + body + "</table>")

def code(text, lang="typescript", caption=None):
    cap = "" if caption is None else ' caption="' + escape(caption, quote=True) + '"'
    blocks.append('<pre lang="' + lang + '"' + cap + "><code>" + escape(text.strip()) + "</code></pre>")

def refs(items):
    blocks.append("<p>参考：" + "；".join('<a href="' + escape(url, quote=True) + '">' + escape(label) + "</a>" for label, url in items) + "。</p>")

blocks.append("<title>" + escape(title) + "</title>")
p("编制日期：2026-10-14（Asia/Shanghai）。读者：ai-drama 项目的前端负责人、实施开发者与测试人员。本文交付 CSS/Tailwind 实施计划，样式代码尚未在本次任务中执行迁移。")
blocks.append('<p>关联方案：<a href="https://jcnfgzqwwg0u.feishu.cn/wiki/MJIsw5a53iGGhpkBKLlcTctHnqe">Vue → React 前端重构计划</a>。本计划补充该方案的样式层：新 React 组件采用 Tailwind，已有页面 CSS Modules 分阶段迁移；Zustand、React Query、路由、API 与任务可靠性职责沿用关联方案。</p>')
p("推荐目标：Tailwind CSS v4 + 语义设计 token + React 组件 variants + 少量有明确用途的 CSS。保留现有品牌、布局密度、主题和交互表现，通过样式基线与生产构建验收决定每批迁移是否完成。")

h("目标、范围与成功标准")
ul([
    "统一样式入口：应用通用布局、间距、字体、颜色、状态和响应式样式进入 Tailwind 规范；项目设计 token 具有单一来源。",
    "保留当前界面基线：火焰橙品牌渐变、light/dark/system 三态、紧凑工作台、四语言、Portal、媒体预览和关键控件表现一致。",
    "减少重复：Button、Input、Textarea、Badge、Card、Tabs、Dialog、菜单等统一 variants，页面通过组件和语义 utility 组合。",
    "限定自定义 CSS 用途：主题变量、第三方覆盖、精确光标镜像、复杂动画/滚动条以及必要的平台适配可以保留，并记录 owner、用途与测试。",
    "交付证据：生产构建包含实际使用的状态类；视觉/键盘/拖拽/输入法验证通过；旧样式的删除具有替代映射和回退路径。",
    "样式迁移与业务变更分别验收；新 React 组件直接使用本规范，现有 CSS Modules 按模块收敛，避免重复搬运整套样式。"
])
p("本文不承诺 Tailwind 会自动减少资源体积或提升帧率；CSS 体积、构建时间、交互与渲染性能都以同一基线数据集的测量结果判断。生产就绪需要样式、功能与部署验证共同通过。")

h("当前代码的样式基线")
table(["对象", "本次扫描结果", "实施意义"], [
    ["旧 Vue 前端", "16 个包含样式的文件/区域；约 5,435 行 CSS", "用于视觉和行为比对，避免只检查新 React 的局部实现。"],
    ["旧 Vue 工作台", "episode.vue 的样式约 2,730 行", "最大工作包；按侧栏、剧本、资产、视频和导出拆分。"],
    ["全局设计变量", "studio.css 约 574 行；120 个不同自定义变量名", "先建立 token 注册表，再接入 Tailwind @theme。"],
    ["覆盖与动画", "旧样式约 32 处 !important、11 个 keyframes", "逐项分类；应用内状态覆盖与第三方覆盖分开治理。"],
    ["现有断点", "max-width 760、860、900、1080px", "首轮保持边界，不能直接改成默认 md/lg 的不同阈值。"],
    ["当前 React 目录", "已出现 frontend-react；18 个 CSS 文件，其中 16 个 CSS Modules，约 5,524 行", "本计划以现有 React 样式为主要实施对象。"],
    ["React 大样式文件", "工作台 2,730 行；详情 699 行；tokens.css 583 行；设置 445 行；首页 276 行", "仍承接大部分旧样式，需要进行样式结构重构。"],
    ["当前 React 构建", "Vite 7 系列；main.tsx 导入 tokens.css 与 tour-theme.css；尚未配置 Tailwind", "在既有 Vite 配置中增加插件与统一入口。"]
])
p("以上为本次文件扫描快照，CSS 行数包含注释与空行，并非独立规则数。frontend-react 当前是未跟踪目录，可能仍在持续开发；T0 必须以实际实施时版本冻结基线。此次未验证 React 页面功能、运行截图或安装包表现。")
p("重点源码：frontend-react/src/app/styles/tokens.css、tour-theme.css；features/workbench/EpisodeWorkbenchPage.module.css；features/drama-detail/DramaDetailPage.module.css；features/projects/ProjectsPage.module.css；features/settings/SettingsPage.module.css；shared/ui/*.module.css；app/layouts/*.module.css。")
p("tokens.css 同时包含变量、reset、按钮/表单/弹窗/菜单和动画，必须按职责拆分，不能把整个文件重新包装为 @apply 后宣称已经完成。")

h("技术方案与工程约束")
table(["能力", "采用方案", "约束/验收"], [
    ["Tailwind", "Tailwind CSS v4 + @tailwindcss/vite", "T1 验证与当前 Vite/Node 兼容，锁定版本与 package-lock.json。"],
    ["主题", "CSS runtime token + @theme inline + html[data-theme]", "主题值由现有主题控制器提供，Portal 同样继承。"],
    ["组件 variants", "class-variance-authority 或同等静态变体表", "统一 size/variant/state，类名完整可扫描；只采用一种主要规范。"],
    ["className 合并", "clsx + 经兼容验证的 tailwind-merge", "自定义字号、圆角和 shadow 的合并语义要有测试。"],
    ["交互组件", "继续使用 React/Radix/既有菜单与输入组件", "Tailwind 负责样式，不替代 focus、键盘与 ARIA 逻辑。"],
    ["代码格式", "兼容锁定 Tailwind 版本的类名排序/检查工具", "审查稳定分组，避免依赖 className 字符串先后顺序决定 CSS 优先级。"],
    ["资源与运行", "Vite 生产编译，静态 CSS 随 dist 打包", "浏览器与 Electron 不依赖运行时 Tailwind CDN。"]
])
p("官方当前文档采用 v4 CSS 配置方式。优先使用 @theme、@custom-variant、@utility 和 @source；不用 v3 的 @tailwind 指令、旧 content/safelist 配置或升级工具机械转换原始 CSS。若必须支持官方 v4 范围外的浏览器，应在 T0 单独确定兼容方案。")
p("Tailwind v4 官方列出的基础浏览器范围包含 Chrome 111、Safari 16.4、Firefox 128。Electron 的实际 Chromium 版本与 Web 的浏览器范围分别核对；较新的 CSS 功能也需要独立确认，构建 target 不能为全部现代 CSS 自动提供兼容性。")
refs([
    ("Tailwind Vite 安装", "https://tailwindcss.com/docs/installation/using-vite"),
    ("Tailwind 兼容范围", "https://tailwindcss.com/docs/compatibility"),
    ("Tailwind v4 规则与升级说明", "https://tailwindcss.com/docs/upgrade-guide"),
    ("CVA", "https://cva.style/"),
    ("tailwind-merge", "https://github.com/dcastil/tailwind-merge")
])

h("统一入口、Preflight 与渐进共存")
code("""
frontend-react/src/app/styles/
  index.css                 # Tailwind、层顺序与样式入口
  runtime-tokens.css        # --hb-* 原始 light/dark 设计值
  theme.css                 # @theme inline / utilities / variants
  base.css                  # 页面根节点与必要基础规则
  legacy-bridge.css         # 有退出期限的旧变量/旧组件兼容
  vendor-overrides.css      # driver.js、sonner 等受控覆盖
  exceptions.css            # 有说明和 owner 的 CSS 例外

frontend-react/src/shared/ui/
  button.tsx
  button.variants.ts
  input.tsx
  badge.tsx
  card.tsx
  tabs.tsx
  dialog.tsx

frontend-react/src/shared/lib/
  cn.ts
""", "text", "实施后目标结构")
ul([
    "main.tsx 最终只导入 app/styles/index.css；公共样式不再由多个页面重复注入。driver.js 原始样式和覆盖的导入关系统一管理。",
    "固定 layer 顺序：theme → base → vendor → legacy → components → utilities。应用自己的 utility 可以按约定覆盖 legacy 普通规则。",
    "正常 CSS 中未分层的规则优先于分层规则；未迁移 CSS Modules 需要明确进入 legacy layer，或在该组件迁移时整体移除旧 import。只把 Tailwind 放到后面不保证有效。",
    "!important 的 layer 优先级有反转规则；每处现有 important 单独核对，应用状态逻辑优先通过结构/variants 解决，不采用全局 important 开关。",
    "第一批可只导入 Tailwind theme 与 utilities，暂不加入 Preflight，保持当前 reset；随后在独立验收批次启用 Preflight 并删除重复 reset。",
    "启用 Preflight 时检查 heading、button、input、select、SVG、img/video、border 和默认字体/line-height；先通过基础控件和 Mention 的基线，再迁移全站。",
    "既有 CSS Modules 若仍需 @apply/@variant，使用 @reference 引用统一主题，避免每个文件重复导入完整 Tailwind；适用范围限于残余 CSS 例外。"
])
code("""
/* 最终入口示例；Preflight 在独立验收批次后启用 */
@layer theme, base, vendor, legacy, components, utilities;
@import "tailwindcss" source("../..");
@import "./runtime-tokens.css" layer(base);
@import "./base.css" layer(base);
@import "./legacy-bridge.css" layer(legacy);
@import "./vendor-overrides.css" layer(components);
@import "./theme.css";

/* index.css 位于 src/app/styles，显式覆盖根 HTML */
@source "../../../index.html";
""", "css", "source 路径以该样式文件位置解析，T1 必须验证")
p("旧 Vue 与 React 是两个前端入口，首轮只在 React 入口引入 Tailwind。前端目录正式切换时复核 source 路径和 dist 引用。兼容层只服务未迁移组件，每次迁移同步减少对应 selector 和旧变量 alias。")
refs([
    ("Preflight 及禁用方式", "https://tailwindcss.com/docs/preflight"),
    ("自定义样式与 cascade layers", "https://tailwindcss.com/docs/adding-custom-styles"),
    ("@reference 与指令", "https://tailwindcss.com/docs/functions-and-directives")
])

h("设计 token 注册与映射")
p("先为现有 120 个变量建立注册表，字段包括旧名、新 --hb-* 名、light/dark 值、utility 名、使用组件、owner、兼容 alias 和删除条件。原始品牌值继续使用现有颜色和渐变，不在同一批迁移中改换色彩体系。")
table(["当前变量/含义", "目标 utility / token", "规则"], [
    ["--surface-base", "bg-app / --hb-surface-base", "页面背景随主题变化。"],
    ["--surface-raised", "bg-surface / --hb-surface-raised", "卡片、弹窗和菜单底色。"],
    ["--surface-muted、--surface-input", "bg-surface-muted、bg-input", "区分禁用/分组背景和输入背景。"],
    ["--text-0、--text-1、--text-2、--text-3", "text-content、text-content-secondary、text-content-muted、text-content-subtle", "保持正文、次级和提示层级，避免到处写 gray 色阶。"],
    ["--border、--border-strong、--border-focus", "border-outline、border-outline-strong、border-focus", "使用 border utility 时明确颜色。"],
    ["--accent、--accent-bg、--accent-text", "bg-brand / text-brand、bg-brand-soft、text-brand-content", "强调、选中与徽标语义分开。"],
    ["--accent-gradient", "bg-brand-gradient（@utility）", "保留既有线性渐变，hover/active 的 glow/scale 独立定义。"],
    ["--on-accent", "text-on-action", "主要动作的前景颜色。"],
    ["--button-bg、--button-text、--button-bg-hover、--button-bg-active", "bg-button、text-button-content、hover:bg-button-hover、active:bg-button-active", "背景与前景使用不同 token，默认按钮变体统一定义。"],
    ["--button-focus", "shadow-focus（精确 focus shadow）", "首轮保留 3.5px 焦点圈的尺寸和颜色，转 ring 前单独比较。"],
    ["--action-danger、--action-danger-bg", "text-danger / bg-danger、bg-danger-soft", "危险 ghost 与 solid variant 分开。"],
    ["success/error/info/warning 系列", "语义状态色与 soft 背景", "文本、图标和状态同时表达，不只依赖颜色。"],
    ["--radius-sm、--radius、--radius-lg、--radius-xl", "rounded-item、rounded-control、rounded-panel、rounded-dialog", "对应当前 8/10/14/20px，避免默认 radius 数值替换。"],
    ["--radius-pill", "rounded-pill", "按钮/标签的项目语义 token。"],
    ["--shadow-panel、--shadow-card、--shadow-elevated", "shadow-panel、shadow-card、shadow-dialog", "保持现有多层 shadow 参数。"],
    ["--font-body、--font-display、--font-mono", "font-ui、font-display、font-code", "继续当前中文/日文/韩文字体回退链。"],
    ["--sp-* 与各固定尺寸", "4px 基线 spacing + 少量尺寸 token", "匹配已有 4/8/12/16/20/24px；10/14/18px 等精确值按组件统一。"],
    ["--ease-out 与动画参数", "ease-app、animate-* 项目 utility", "交互 easing 保留；动画按 reduced motion 降级。"],
    ["--z-menu:1000、--z-blocking:2000", "z-[var(--hb-z-menu)]、z-[var(--hb-z-blocking)]", "保留层级并整理 Dialog、Toaster、Tour 的优先关系。"],
    ["scrim/media/header/scrollbar 等", "语义 raw token + 对应 utility/受控 CSS", "媒体黑底、透明遮罩和滚动条保留用途边界。"]
])
p("名称冲突必须提前处理：旧样式已有 --radius-lg、--shadow-sm、--font-mono，容易与 Tailwind theme namespace 同名；新原始值统一使用 --hb-*，Tailwind 用独立语义名映射，杜绝 --radius-lg: var(--radius-lg) 这类自引用。旧 alias 只在 legacy-bridge 内保留。")
code("""
/* runtime-tokens.css：下方仅示意一组，实施时完整迁移 light/dark 值 */
:root {
  --hb-surface-base: #f7f8fa;
  --hb-surface-raised: #ffffff;
  --hb-text-primary: #17181a;
  --hb-outline: #e7e9ee;
  --hb-brand: #f97316;
  --hb-brand-gradient: linear-gradient(135deg, #f97316 0%, #fb923c 100%);
  --hb-radius-control: 10px;
  --hb-radius-panel: 14px;
}

/* theme.css：映射原始变量，使 utility 在使用元素处解析 */
@theme inline {
  --color-app: var(--hb-surface-base);
  --color-surface: var(--hb-surface-raised);
  --color-content: var(--hb-text-primary);
  --color-outline: var(--hb-outline);
  --color-brand: var(--hb-brand);
  --radius-control: var(--hb-radius-control);
  --radius-panel: var(--hb-radius-panel);
}

@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));

@utility bg-brand-gradient {
  background-image: var(--hb-brand-gradient);
}
""", "css", "生产代码必须补齐 dark 值、完整 token 与基线验证")
p("字体大小要单独登记：当前 body 为 14px/1.6，按钮为 13px/1，表单为 13.5px，许多标签为 10–12px，且有 font-weight 550/650。保留 font-ui、text-ui、text-form 等精确 token 和 line-height；不能用 text-sm 的默认参数替换所有文字。")
refs([("Tailwind @theme 与 inline 映射", "https://tailwindcss.com/docs/theme")])

h("普通 CSS 到 utility 的转换规则")
table(["现有规则", "迁移表达", "注意点"], [
    ["display:flex；align-items:center", "flex items-center", "保留子元素的 shrink/min-size。"],
    ["flex:1；min-width:0；min-height:0", "flex-1 min-w-0 min-h-0", "工作台滚动边界需要全部保留。"],
    ["gap:12px；padding:16px", "gap-3 p-4（4px 基线）", "根字号/缩放影响 rem 时核对 computed style。"],
    ["border:1px solid var(--border)", "border border-outline", "border 的默认颜色不能省略。"],
    ["border-radius:var(--radius-lg)", "rounded-panel", "token 映射先完成。"],
    ["background/text/shadow", "bg-surface text-content shadow-panel", "通过语义 token 接主题。"],
    ["overflow-y:auto", "overflow-y-auto", "父级高度与 min-h-0 需要一起验收。"],
    ["ellipsis/truncate", "min-w-0 truncate", "多语言标题与 flex 布局下验证。"],
    ["单一 hover/focus/disabled", "hover:*、focus-visible:*、disabled:*", "键盘与触屏独立验证。"],
    ["active/on/selected/failed 类", "data-[active=true]:*、aria-selected:* 或 variants", "语义值由现有 React 状态提供，避免另建样式状态。"],
    ["父级 hover 显示按钮", "group + group-hover:* + group-focus-within:*", "关键操作也有非 hover 的访问路径。"],
    ["伪元素装饰", "before:*、after:* 或明确子节点", "装饰不承担唯一状态文本。"],
    ["max-width 精确断点", "项目断点/custom variant", "首轮保持 760/860/900/1080px 边界语义。"],
    ["动态像素宽度/位置", "静态 utility + runtime CSS variable/style", "只在运行时传值，不拼接动态 className。"],
    ["重要覆盖", "variants 或保留有记录的第三方 selector", "逐条解释 !important 用途和删除条件。"],
    ["动画/复杂背景/scrollbar", "小量 @utility/@keyframes 或 exceptions.css", "动画与定位 transform 分层；测试 reduced motion。"]
])
ul([
    "每批按组件执行转换，并同时清理对应 .module.css 引用；先提取重复 UI，再给组件定义 variants。",
    "优先表达布局与语义，单次精确值可用 arbitrary value；跨三处以上重复的设计值收敛为 token 或组件 prop。",
    "合理使用 @apply 处理第三方 DOM 和确需 CSS 的选择器；页面样式以 JSX 组合为主，避免长期保留巨大类选择器库。",
    "CSS 中 class 顺序不等于 className 字符串顺序。cn/merge 只处理约定冲突组，不能替代 cascade、状态 variants 或 DOM 层级设计。"
])

h("基础组件 variants 与状态样式")
table(["组件", "约定 props / variants", "验收重点"], [
    ["Button/IconButton", "variant: default/primary/ghost/danger；size: default/sm/icon；loading", "当前高度、字体、渐变、glow、按压、焦点、disabled。"],
    ["Input/Textarea", "size、invalid、disabled；统一 field wrapper", "placeholder、focus shadow、IME、错误文本与 readonly。"],
    ["Badge/StatusBadge", "tone: default/brand/success/error/info/warning", "语义配色、图标、长文本和对比。"],
    ["Card", "selected、interactive、padding", "shadow、hover border、selected outline，不改变点击范围。"],
    ["Tabs/Segmented", "orientation、size；由 aria-selected 或 data-state 表示当前项", "键盘导航、下划线/芯片和长语言文案。"],
    ["Dialog/AlertDialog", "size、tone；head/body/foot slot", "Portal、focus trap、滚动、遮罩层级与关闭结果。"],
    ["Popover/Combobox/Menu", "placement、size、selected、disabled", "定位交给现有 adapter/Floating UI，样式只描述外观。"],
    ["Skeleton/Progress", "size、motion、progress", "减少动画模式、实时数值和刷新状态。"]
])
code("""
/* 类名表保留完整字符串，供 Tailwind 扫描和组件 variants 复用 */
const buttonTone = {
  default: 'bg-button text-button-content hover:bg-button-hover active:bg-button-active',
  primary: 'bg-brand-gradient text-on-action hover:shadow-brand',
  ghost: 'bg-transparent text-brand-content hover:bg-brand-soft',
  danger: 'bg-danger-soft text-danger hover:bg-danger-soft-hover',
} as const

const buttonSize = {
  default: 'min-h-9 px-[18px] text-ui',
  sm: 'min-h-[30px] px-[14px] text-caption',
  icon: 'size-9 shrink-0 p-0',
} as const

const buttonBase =
  'inline-flex items-center justify-center gap-1.5 rounded-pill ' +
  'font-semibold leading-none whitespace-nowrap select-none ' +
  'focus-visible:outline-none focus-visible:shadow-focus ' +
  'disabled:cursor-not-allowed disabled:opacity-45 ' +
  'motion-reduce:transition-none'
""", caption="示意 token/class 表；shadow、active/motion 细节在 T2 按基线补齐")
p("状态样式直接消费 Zustand 的交互状态、React Query 的 pending/error/任务终态、Radix 的 data-state 等已有协议。loading 按钮保留可访问名称和宽度，spinner 不挤压文案；danger solid 与 soft 分开，避免改变删除确认的视觉语义。")
p("cn 辅助函数集中维护，合并器版本必须支持锁定的 Tailwind。测试自定义字号 text-ui、圆角 rounded-panel、shadow-focus 和组合 variants 的合并；重要尺寸变化通过组件 props 表达，不用任意 className 覆盖全套控制样式。")

h("页面与工作台迁移清单")
table(["工作包", "主要目标文件", "替换与验收"], [
    ["应用/布局", "app/layouts/*、RouteError.module.css", "shell/header/nav、全高布局、错误状态、内容滚动。"],
    ["首页", "ProjectsPage.module.css", "项目卡、筛选、搜索、空态、骨架和创建弹窗；group hover/focus。"],
    ["项目详情", "DramaDetailPage.module.css", "集卡片、素材库、编辑、删除和媒体预览；图片比例。"],
    ["设置", "SettingsPage.module.css", "页签、配置卡、模型 chips、表单、提示词/技能长文案、存储统计。"],
    ["工作台侧栏/顶栏", "EpisodeWorkbenchPage.module.css 的导航与进度段", "收起状态、stage selected/done/pending、按钮密度与进度标识。"],
    ["剧本/资产", "ScriptPanel、AssetsPanel 及对应样式", "编辑器与 dirty 状态、资产网格、预览、上传/生成。"],
    ["分镜/视频", "VideosPanel 及对应大样式段", "镜头列表、参考绑定、模型参数、提示词、历史、拖拽列宽。"],
    ["导出/任务", "ExportPanel、TaskDrawer、MigrationOverlay", "选择范围、成片卡、媒体、进度、遮罩和层级。"],
    ["公共控件", "shared/ui 的 8 类 CSS Modules", "Select/ModelSelect、Mention、Modal、确认/语言弹窗、主题/语言菜单。"],
    ["全局与第三方", "tokens.css、tour-theme.css", "拆 token/reset/components/animation，集中维护第三方覆盖。"]
])
p("顺序为基础 token/控件 → 首页 → 详情/设置 → 工作台 → 跨平台清理。工作台根据 React 已拆出的 parts 划分样式批次，不把 2,730 行 CSS 统一改成一个巨大 className 映射文件。")
p("原先用于 driver.js 引导的 selector 要与样式类脱钩：保留稳定 data-tour 属性，并更新引导配置与测试。删除 .head-actions、.tour-help-btn 等类前核对它们是否仍是功能/自动化定位入口。")

h("动态布局、浮层与 Mention 的精确迁移")
h("运行时尺寸与定位", 2)
ul([
    "当前视频列宽通过 --vleft/--vright 动态传入。继续由 Zustand 保存有限、校验后的数值，在 DOM 边界输出 --hb-video-left/right；静态 grid utility 消费变量。",
    "布局保留现有嵌套列结构，分别实现左侧列表+主区和主区+检查器，不因样式工具更换而调整分镜/检查器关系。",
    "Floating UI 或现有 panelStyle 中的 top/left/width/transform 保持 style 输出，Tailwind 处理边框、背景、间距等静态属性。",
    "定位 transform 与入场 scale/translate 尽量放在不同外层/内层节点，防止动画覆盖浮层定位。",
    "body 拖拽 cursor/user-select 状态使用专用 data 属性或小量全局例外 CSS；pointer up/cancel/unmount 均清理。"
])
code("""
import type { CSSProperties } from 'react'

const columnsStyle = {
  '--hb-video-left': String(leftWidth) + 'px',
  '--hb-video-right': String(rightWidth) + 'px',
} as CSSProperties

// 左侧列表 + 主区；右检查器仍由原来的嵌套布局处理
<section
  style={columnsStyle}
  className="grid min-h-0 min-w-0 grid-cols-[var(--hb-video-left)_minmax(0,1fr)]"
/>
""", caption="动态数据使用 CSS variable，className 保持静态")
h("Portal 与主题", 2)
ul([
    "html[data-theme] 上定义主题值，Portal 渲染到 body 后仍可继承。不要把主题只放在 #root 子节点。",
    "Dialog、菜单、Mention、Toaster、Tour 和迁移遮罩建立层级表；当前 menu 1000、blocking 2000 是基线，检查第三方实际层级后定义新完整规范。",
    "透明遮罩、backdrop-filter、视频黑底、滚动锁定与焦点恢复一起验收。样式迁移不能把弹窗遮挡或关闭行为问题藏在 z-index 数字里。"
])
h("MentionTextarea 镜像", 2)
ul([
    "textarea 与高亮镜像必须共享字体、字号、字重、line-height、padding、border 宽度、letter-spacing、white-space 和 wrap 规则。",
    "定义单一 mention surface metrics，将背景透明/文字透明/caret 分别作为变体。Preflight 对 textarea、边框和字体的改变进入专门回归。",
    "镜像的 scrollTop/scrollLeft 与真实输入保持同步，测试 emoji、中文 IME、日韩长文本、换行、粘贴、缩放和光标插入。",
    "高亮通过安全 React token 节点或明确 global 类输出；当前 CSS Modules 中 .mention-token 等原始字符串与局部哈希类的对应关系需要核对，不能假设自动匹配。",
    "光标下拉需要虚拟锚点计算和键盘逻辑；保留少量精确 CSS 属于允许例外，不以自定义 CSS 零行作为完成标准。"
])

h("主题、响应式、动画与可访问性")
ul([
    "Zustand 管 themeMode，启动控制器解析 system 后在首帧前写 html[data-theme]；Tailwind custom dark variant 只读取结果，不建立第二份主题状态。",
    "通常 bg-surface/text-content 随 raw token 自动变色；只有结构/显示方式有主题差异才加 dark variant，减少重复的 light/dark 色阶硬编码。",
    "现有 max-width 是 <= 边界，Tailwind max-* 是 < 边界；T0 记录 759/760/761、859/860/861、899/900/901、1079/1080/1081px 的行为。",
    "首轮可保留精确 media query 或定义与旧边界一致的 custom variant；改成 mobile-first 是后续独立布局调整。若引入 --breakpoint-*，与默认 breakpoints 统一使用 rem 或完整重设同一种单位，复核排序。",
    "spinner、skeleton、dialog/menu/task drawer、进度流水线和 marquee 有不同用途；在 motion-reduce 下取消非必要位移/闪动，保留文字/状态反馈。",
    "v4 hover 受设备 hover 能力影响。项目卡更多操作、媒体播放、下载和重试不能只有悬停入口，同时支持 focus、触屏或明确按钮。",
    "scale/translate 在 v4 可使用独立 CSS 属性；自定义 transition 列表包含实际改变的属性，不只留下 transform 导致动画失效。",
    "保持 focus-visible、ARIA 状态、disabled 命中区域、label/error 提示和较小窗口可操作性；强制色彩模式、200% 缩放与四语言长文案列入验证。"
])
refs([
    ("dark mode 与 data-theme", "https://tailwindcss.com/docs/dark-mode"),
    ("响应式断点", "https://tailwindcss.com/docs/responsive-design"),
    ("状态 variants", "https://tailwindcss.com/docs/hover-focus-and-other-states"),
    ("动画", "https://tailwindcss.com/docs/animation"),
    ("v4 hover 与 transforms", "https://tailwindcss.com/docs/upgrade-guide")
])

h("源码扫描、第三方覆盖与 CSS 例外")
ul([
    "明确 React src 与根 index.html 的扫描路径；从仓库根、frontend-react 或 CI 构建均得到相同结果。避免扫描旧 Vue、后端 prompt、构建产物和无关文档类名。",
    "variant/class map 使用完整字符串，例如失败态映射到 bg-danger-soft text-danger；禁止用 'bg-' + tone、任意运行时宽度拼出 utility。",
    "Tailwind 不默认扫描 CSS、node_modules、被 gitignore 忽略文件等。外部组件类名若需要 Tailwind 生成，使用明确 @source；动态第三方 DOM 的少量 utility 可使用有限 @source inline。",
    "不对全部颜色、宽度和状态做大范围 safelist；可枚举的类名放入静态变体表，运行时数值交给 CSS variable。",
    "driver.js 通过原始样式 + 项目覆盖支持主题。可管理的 vendor CSS 加入 vendor layer；不能控制的内联/运行时样式以允许的 API、CSS variables 或最小覆盖处理。",
    "sonner 优先使用库支持的样式/class 接口。背景、字色和焦点不依赖每个业务调用临时传入一套样式。",
    "滚动条、富文本/高亮镜像、需要精确浏览器行为的选择器和平台例外保留在登记清单；每条记录理由、owner、目标浏览器和验收用例。",
    "残余 CSS Modules 用于真正的局部特殊样式。迁移结束删除布局/间距/颜色等已由 utility 替代的规则；新增普通页面样式遵守 Tailwind 规范。"
])
refs([
    ("Tailwind 源码检测与 @source", "https://tailwindcss.com/docs/detecting-classes-in-source-files"),
    ("CSS Modules 与工具兼容", "https://tailwindcss.com/docs/compatibility")
])

h("视觉、交互与生产构建验收")
table(["验证层", "必测内容", "通过证据"], [
    ["Token/编译", "light/dark 值、utility、CVA 静态类、source 路径、css layers", "生产 CSS 实际命中；undefined/self-referential variable 为零。"],
    ["公共控件", "Button/输入/下拉/弹窗/菜单的默认、hover、focus、disabled、loading、error", "组件样例页或测试 fixture 截图、keyboard 行为通过。"],
    ["页面视觉", "首页、详情、设置、工作台各面板、空态、错误态、生成态", "同硬件/字体/数据集的基线截图与差异解释。"],
    ["主题/语言", "light/dark/system；zh/en/ja/ko", "关键页面长文案、Portal、图标、Toaster 和 Tour 验证。"],
    ["响应式", "主要桌面窗口与全部断点边界；200% 缩放", "无错误横向溢出、被裁剪关键操作或不可用检查器。"],
    ["复杂交互", "Mention/IME、列拖拽、媒体预览、Dialog/menu focus 与滚动", "行为测试与人工检查结果可复现。"],
    ["构建/部署", "Vite dist、Hono 深路由、Docker、Electron macOS/Windows", "CSS 资源无 404，冷启动主题无明显闪烁，动态状态样式齐全。"],
    ["资源/性能", "CSS gzip、加载请求、构建时间、卡片和工作台交互", "与冻结基线比较；性能目标和异常原因记录。"]
])
ul([
    "视觉回归用 Playwright 等工具，固定字体、视口、时间、模拟任务与数据；避免拿不同 OS 字体的差异当样式回归。",
    "截图差异阈值在 T0 对抗锯齿与平台波动校准。颜色、边界、字号、焦点和关键布局的变化都需要说明，不能仅用宽松像素阈值放行。",
    "测试不把 Tailwind className 字符串等同于表现正确；对控件执行用户动作，检查语义、计算样式与可见状态。",
    "CSS-only 批次也要验证点击目标、拖拽、focus 和输入法。常规测试用固定响应，不发起真实付费 AI 生成。",
    "生产冷启动检查全部状态和懒加载 route，防止开发环境出现过的类恰好掩盖 source 扫描遗漏。",
    "质量门槛：类型/lint/build 与现有业务关键测试通过；每个迁移包的视觉、交互与回退证据齐备；例外清单没有未归属条目。"
])
p("建议预算：最终普通自定义 CSS 相对基线明显减少，精确幅度在 T0 分类后设定；生产 CSS gzip 体积目标以基线为上限或明确解释增加的必要项。开发期间 legacy + utilities 的临时双份体积不作为最终完成结果，依赖 React 的全部流程测试再合并发布。")

h("里程碑、依赖与实施顺序")
table(["阶段", "输入 → 交付物", "退出条件", "估算"], [
    ["T0 基线", "当前代码 → CSS/token/例外清单、截图和支持矩阵、owner", "冻结版本和数据集，范围与预算可验收", "1–2 开发日"],
    ["T1 接入", "T0 → Tailwind/Vite、source、layers、临时 Preflight 方案", "dev/build/CI 产物一致，不破坏旧基础控件", "1–2 日"],
    ["T2 Token/variants", "T1 → 120 token 注册、theme、cn、Button/Input/Badge/Card", "主题、数值与状态变体通过", "2–3 日"],
    ["T3 公共复杂控件", "T2 → Select/ModelSelect/Dialog/Menu/Mention/主题语言菜单", "焦点、IME、Portal 与精确文本布局通过", "1–2 日"],
    ["T4 普通页面", "T2/T3 → 首页、详情、设置、布局样式迁移", "页面/四语言/断点回归通过，对应旧 CSS 清理", "2–3 日"],
    ["T5 工作台", "T3/T4 → 侧栏、剧本、资产、视频、任务、导出分批迁移", "拖拽、任务状态、媒体与生产流程通过", "3–5 日"],
    ["T6 发布验证", "T4/T5 → 完整 Preflight、性能、Docker、两平台包验收", "生产检查和兼容矩阵通过", "1–2 日"],
    ["T7 清理/回退", "T6 → 删除无引用 CSS、例外归档、开发规范与回退包", "无双重样式所有权，回退演练通过", "0.5–1 日"]
])
p("单名熟悉当前项目的前端开发者估算约 12–20 个开发工作日，建议预留约 20% 缓冲；设计/QA/发布等待另计。时间不是交付承诺，T0 后依据复杂控件和现有 React 完成度重新估算。")
p("关键路径：T0 → T1 → T2 → T3 → T5 → T6 → T7。普通页面在基础 variants 稳定后可分包推进；主题/layer/控件接口由同一负责人维护，避免并行批次产生不同 token 或不同按钮规范。")
p("与 React 重构衔接：React 基础接入时完成 T1/T2；新建页面直接遵守 Tailwind 规范，已有 CSS Modules 按 T3–T5 转换。每个样式批次单独记录风险与视觉结果，业务任务/缓存/草稿修正仍按 React 文档验收。")

h("责任、接口与变更治理")
p("以下是建议角色，具体人员尚未指派；T0 由项目负责人确认 owner 和验收方。本文不假设团队人数或未经确认的日期。")
table(["角色", "负责交付", "接口/验收方"], [
    ["前端架构 owner", "Tailwind 版本、layer/source、token/cn/variants 与例外规范", "接口提供给各页面实施者；技术负责人评审。"],
    ["模块实施 owner", "组件/页面转换、对应 CSS 删除、行为和视觉证据", "基于冻结 variants；交给 QA 与前端评审。"],
    ["设计/产品验收角色", "品牌、密度、主题、断点与文案外观", "确认必要的视觉偏差；不把新视觉提案混入迁移。"],
    ["QA/自动化角色", "截图/交互/键盘/IME/媒体与回归矩阵", "给出通过/阻断清单，失败回到对应模块 owner。"],
    ["桌面/发布角色", "CSS 静态资源、字体、窗口缩放、Docker 和两平台包", "产物版本、构建配置与回退演练归档。"],
    ["项目负责人", "范围、资源、里程碑调整与最终发布判断", "业务、设计和技术验收完成后进入切换。"]
])
p("治理节点只设置在关键交付上：T0 确认基线；T2 固定 token/组件接口；每个模块退出时验收；T6 确定可发布性。新增颜色/字号/组件变体、改变断点或改变控制布局，需要更新 token/variants 与相关截图，按受影响范围重新验收。")

h("风险触发、处理动作与回退")
table(["预警信号", "影响", "处理 / owner", "备选或回退终态"], [
    ["utility 在 dev 有效、build 缺失", "状态或 route 冷启动样式丢失", "架构 owner 修正 source 与静态 class map", "恢复该模块旧 CSS，生成确定产物后重试。"],
    ["Tailwind 类被旧 selector 覆盖", "布局与主题不稳定", "架构/模块 owner 修正 layer、删除同元素旧类并检查 important", "保留未迁移组件在 legacy，暂停该模块切换。"],
    ["Preflight 改变字号/边框/镜像", "控件和 Mention 错位", "控件 owner 校准 shared metrics；QA 回归", "暂不启用 Preflight，完成基础控件后单独切换。"],
    ["Portal 变色失败或被遮挡", "弹窗/菜单不可操作", "组件 owner 把 token 放在 html 并核对完整层级", "回退 Portal 组件样式，避免全站 z-index 补丁。"],
    ["拖拽/缩屏后列溢出", "工作台检查器与列表不可用", "工作台 owner 保持结构与动态值 clamp，测试边界", "恢复旧布局规则，新 token/普通 utility 可保留。"],
    ["主题变量自引用或同名冲突", "字体/圆角/阴影无效", "token owner 统一 --hb-* 原始名、修正 @theme inline", "保留旧 alias 与原值，撤销问题映射。"],
    ["class merge 删除了有效自定义 utility", "某些 size/state 外观错误", "组件 owner 调整 merge 配置与 props，补契约", "暂用确定的静态 variants，减少外部覆盖。"],
    ["大量 @apply/legacy 一直增加", "只有工具切换，没有样式治理", "架构 owner 拆基础组件，固定每批删除清单", "缩小批次，先完成公共控件再扩展页面。"],
    ["视觉差异来自业务/字体同时变化", "验收结论失真", "QA 冻结数据与环境，分离业务变更", "回到上一个可对比批次，重新建立基线。"]
])
p("回退单位为模块或前端静态产物：JSX 的 classes、token、legacy 对应删除与组件代码一起回退，不能只替换一份 CSS。发布前保留验证过的旧 dist 与构建信息，完成冷启动与深链接回退演练。")
p("样式重构不迁移数据库，也不改写生成任务协议。回退不触碰用户 SQLite 与媒体目录；此前已经提交的后台生成操作仍按既有后端流程处理。")

h("最终完成定义")
ul([
    "Tailwind/Vite、Node 与合并工具的版本兼容已验证，统一样式入口和 source 路径进入 CI。",
    "120 个原始设计变量完成注册/映射或有明确废弃记录；light/dark/system、Portal 和首帧主题验收通过。",
    "公共 Button/Input/Card/Badge/Tabs/Dialog/Select/Mention 等采用统一 variants，普通业务组件不再各自重定义同款样式。",
    "工作台及普通页面的通用布局/间距/颜色/状态进入 utility；每个旧 CSS 删除项有替代与截图依据。",
    "允许的自定义 CSS 和 !important 都在例外清单中，有用途、owner 和测试；兼容层只保留明确尚未退出的条目。",
    "断点边界、四语言、输入法、拖拽、键盘焦点、媒体、任务状态和 reduced motion 无阻断回归。",
    "类型/lint/build、业务关键回归与视觉/交互检查通过；生产 CSS 类与资源在冷启动、路由懒加载下完整。",
    "Hono、Docker、Electron macOS/Windows 的样式资源、窗口/主题与回退验收完成。",
    "开发规范、token/variants、例外与验收记录随代码维护；性能目标有测量结果，计划按实际实施更新。"
])

h("官方资料与实施参考")
p("资料查阅日期：2026-10-14。方案分工、时间区间和验收预算为本项目建议，具体 API 与工具配置以实施时锁定版本为准。")
for label,url in [
    ("Tailwind：Vite 集成", "https://tailwindcss.com/docs/installation/using-vite"),
    ("Tailwind：theme 与 inline", "https://tailwindcss.com/docs/theme"),
    ("Tailwind：暗色与 data-theme", "https://tailwindcss.com/docs/dark-mode"),
    ("Tailwind：source 检测与有限 safelist", "https://tailwindcss.com/docs/detecting-classes-in-source-files"),
    ("Tailwind：Preflight", "https://tailwindcss.com/docs/preflight"),
    ("Tailwind：添加样式与 layers", "https://tailwindcss.com/docs/adding-custom-styles"),
    ("Tailwind：指令与 @reference", "https://tailwindcss.com/docs/functions-and-directives"),
    ("Tailwind：状态 variants", "https://tailwindcss.com/docs/hover-focus-and-other-states"),
    ("Tailwind：响应式", "https://tailwindcss.com/docs/responsive-design"),
    ("Tailwind：animation", "https://tailwindcss.com/docs/animation"),
    ("Tailwind：兼容范围", "https://tailwindcss.com/docs/compatibility"),
    ("Tailwind：v4 变化与陷阱", "https://tailwindcss.com/docs/upgrade-guide"),
    ("CVA：组件 variants", "https://cva.style/"),
    ("tailwind-merge：类名合并与兼容", "https://github.com/dcastil/tailwind-merge"),
]:
    blocks.append('<p><a href="'+escape(url,quote=True)+'">'+escape(label)+"</a></p>")

content = "\n".join(blocks)
root = ET.fromstring("<fragment>"+content+"</fragment>")
assert len(root.findall("title")) == 1
assert all(e.attrib.get("seq") == "auto" for e in root.iter() if e.tag in {"h1","h2"})
assert len(root.findall(".//h1")) == 17
assert len(root.findall(".//table")) == 10
assert len(root.findall(".//pre")) == 5
draft = ROOT/"draft.xml"
draft.write_text(content,encoding="utf-8")
manifest = {"title":title,"characters":len(content),"bytes":len(content.encode()),"chapters":[e.text for e in root.findall(".//h1")],"tables":len(root.findall(".//table")),"code_blocks":len(root.findall(".//pre")),"links":len(root.findall(".//a")),"top_level_blocks":len(root)}
(ROOT/"manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
print(json.dumps(manifest,ensure_ascii=False,indent=2))
