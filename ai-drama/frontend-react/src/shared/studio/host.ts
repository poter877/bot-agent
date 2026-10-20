/**
 * StudioHost — 嵌入宿主（桌面 app）注入给视频工厂的能力接口（《重构》方案 §4）。
 *
 * 四组能力：business（业务 API）、account（账号状态投影）、assets（媒体 URL
 * 解析）、agent（P2 接入会话/事件流，首期占位）。视频工厂 React 树保持独立
 * root；它不通过隐式全局变量寻找宿主，也不在各页面硬编码服务地址——嵌入时
 * 由 embed 入口调用 setStudioHost 注入，独立浏览器版不注入（回退同源相对
 * 路径 + 自行登录，仅保留业务浏览）。
 *
 * 宿主实现方：apps/desktop/src/app/drama/host.ts。
 */
export interface StudioUser {
  id: string
  email: string
  name?: string
}

/** 宿主 Agent 会话通道的事件（网关推送的统一形态）。type 为网关事件名
 *  （message.delta 流式文本、tool.start/complete 工具活动、approval.pending
 *  审批、session.* 会话生命周期）；payload 为该事件的原始载荷。 */
export interface StudioAgentEvent {
  type: string
  sessionId?: string
  payload?: unknown
}

export interface StudioAgentSession {
  sessionId: string
  storedSessionId?: string
}

export interface StudioHost {
  /** 业务 API：固定映射到 bot-backend（经宿主通道，用户身份由宿主持有；
   *  前端不接触任何服务密钥）。path 为 bot-backend 语义的绝对路径
   *  （如 /api/v1/dramas、/api/auth/get-session）。返回标准 Response，
   *  前端现有的状态码/JSON 处理分支原样复用。 */
  business: {
    request(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal }): Promise<Response>
    /** multipart 上传（path 为 /api/v1 语义）；宿主未实现时回退 request 通道。 */
    upload(path: string, file: File, signal?: AbortSignal): Promise<Response>
  }
  /** 宿主登录门的账号状态投影；嵌入模式不再出现第二次登录。 */
  account: {
    status(): Promise<{ authenticated: boolean; user: StudioUser | null }>
  }
  /** 媒体资源（/static/...）的访问 URL 解析。首期直接透传相对路径
   *  （宿主同源代理/通道就绪前不改变行为）；票据化访问在 P1 后续接入。 */
  assets: {
    resolveUrl(path: string): string
  }
  /** 宿主 Agent 会话（《重构》方案 §4/§5）：复用宿主 serve 的会话与事件流。
   *  独立会话由调用方按项目维度管理（见 shared/studio/sessions.ts）；
   *  本接口不承担会话身份与凭据——一切随宿主登录态。 */
  agent: {
    createSession(opts: { title?: string; idempotencyKey?: string }): Promise<StudioAgentSession>
    submit(sessionId: string, text: string): Promise<{ status?: string }>
    interrupt(sessionId: string): Promise<void>
    /** 订阅事件流；返回退订函数。事件含所有会话——按 sessionId 过滤是
     *  调用方的责任（多项目并行时）。 */
    onEvent(handler: (event: StudioAgentEvent) => void): () => void
  }
}

let host: StudioHost | null = null

/** 嵌入入口调用一次；重复注入以最后一次为准（宿主热替换/重挂载）。 */
export function setStudioHost(next: StudioHost | null): void {
  host = next
}

/** 当前宿主；独立浏览器版为 null（消费方据此回退同源相对路径）。 */
export function studioHost(): StudioHost | null {
  return host
}
