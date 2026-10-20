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

export interface StudioHost {
  /** 业务 API：固定映射到 bot-backend（经宿主通道，用户身份由宿主持有；
   *  前端不接触任何服务密钥）。path 为 bot-backend 语义的绝对路径
   *  （如 /api/v1/dramas、/api/auth/get-session）。返回标准 Response，
   *  前端现有的状态码/JSON 处理分支原样复用。 */
  business: {
    request(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal }): Promise<Response>
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
