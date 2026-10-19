/**
 * 桌面后端入口 — 统一后端时代的 shim：以独立进程承载 drama 子应用。
 * 注意：数据层已切换 PostgreSQL，桌面单机版需可访问的 DATABASE_URL
 * （内嵌 pg 不在范围）；公司部署形态见 deploy/trio。
 */
import { serve } from '@hono/node-server'
import { createDramaApp, recoverDrama } from '../../bot-backend/src/drama/app.js'
// 桌面壳内 Better Auth 会话门不可用（无宿主 auth）——走 Bearer AI_DRAMA_API_TOKEN 模式
const app = createDramaApp(null as never)
void recoverDrama().catch(() => {})
const port = Number(process.env.PORT || 30171)
serve({ fetch: app.fetch, port }, () => console.log(`[desktop-backend] drama on ${port}`))
