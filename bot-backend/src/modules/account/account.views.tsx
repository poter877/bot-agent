import type { Child } from 'hono/jsx'
import type { ApiTokenRow } from '../../db/schema.js'

/**
 * 用户门户视图（/account，server-rendered，中文界面）。与运营后台同一套
 * form-post + redirect flash 模式（复用 admin.views 的 Layout 思路，导航独立）。
 * 所有插值经 hono/jsx 转义；令牌明文只在创建后的一次性页面出现。
 */

export interface AccountIdentity {
  userId: string
  email: string
  name: string
}

const NAV = [
  { href: '/account', label: '用量' },
  { href: '/account/sessions', label: '会话' },
  { href: '/account/tokens', label: 'API 令牌' },
  { href: '/account/password', label: '修改密码' },
]

function Layout(props: { identity: AccountIdentity | null; active: string; ok?: string; err?: string; children: Child }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>个人中心</title>
        <style>{`
          :root { color-scheme: light; }
          body { font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; background: #f5f6f8; color: #1c2430; }
          header { background: #101828; color: #fff; padding: 0 24px; display: flex; align-items: center; gap: 24px; height: 52px; }
          header .brand { font-weight: 650; letter-spacing: .5px; }
          header nav a { color: #cbd5e1; text-decoration: none; padding: 16px 10px; display: inline-block; }
          header nav a.active { color: #fff; border-bottom: 2px solid #4f8ef7; }
          header .who { margin-left: auto; font-size: 13px; color: #94a3b8; }
          main { max-width: 1080px; margin: 24px auto; padding: 0 24px; }
          .banner { padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
          .banner.ok { background: #e7f7ec; color: #14642c; }
          .banner.err { background: #fdecec; color: #8f1f1f; }
          table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 2px rgba(16,24,40,.06); }
          th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid #eef0f3; font-size: 13.5px; vertical-align: top; }
          th { background: #f8fafc; color: #475467; font-weight: 600; white-space: nowrap; }
          td form { display: inline-flex; gap: 6px; align-items: center; }
          .pill { padding: 2px 8px; border-radius: 99px; font-size: 12px; white-space: nowrap; }
          .pill.ok { background: #e7f7ec; color: #14642c; }
          .pill.bad { background: #fdecec; color: #8f1f1f; }
          .pill.off { background: #eef0f3; color: #475467; }
          .pill.warn { background: #fdf3e0; color: #8a5a00; }
          button { border: 1px solid #d0d5dd; background: #fff; color: #1c2430; border-radius: 6px; padding: 4px 10px; font-size: 13px; cursor: pointer; }
          button.danger { border-color: #e0b4b4; color: #8f1f1f; }
          button.primary { background: #2f6fed; border-color: #2f6fed; color: #fff; }
          button:hover { filter: brightness(.97); }
          input, select { border: 1px solid #d0d5dd; border-radius: 6px; padding: 5px 8px; font-size: 13px; font-family: inherit; }
          .card { background: #fff; border-radius: 8px; box-shadow: 0 1px 2px rgba(16,24,40,.06); padding: 18px 20px; margin-bottom: 16px; }
          .card h2 { margin: 0 0 12px; font-size: 15px; }
          .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
          .stat .num { font-size: 26px; font-weight: 650; }
          .stat .lbl { color: #667085; font-size: 12.5px; margin-top: 2px; }
          .muted { color: #667085; }
          .stack form { display: grid; grid-template-columns: 160px 1fr; gap: 8px 12px; align-items: center; max-width: 640px; }
          .stack form .full { grid-column: 1 / -1; }
          .stack label { font-size: 13px; color: #475467; }
          code { background: #f2f4f7; padding: 1px 5px; border-radius: 4px; font-size: 12.5px; }
          .secret { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; background: #fdf3e0; border: 1px dashed #d8b25c; padding: 12px 14px; border-radius: 8px; word-break: break-all; }
        `}</style>
      </head>
      <body>
        <header>
          <span class="brand">个人中心</span>
          <nav>
            {NAV.map((item) => (
              <a href={item.href} class={item.label === props.active ? 'active' : ''}>{item.label}</a>
            ))}
          </nav>
          <span class="who">{props.identity?.email ?? '未登录'}</span>
        </header>
        <main>
          {props.ok ? <div class="banner ok">{props.ok}</div> : null}
          {props.err ? <div class="banner err">{props.err}</div> : null}
          {props.children}
        </main>
      </body>
    </html>
  )
}

export function LoginPage(props: { identity: null }) {
  return (
    <Layout identity={props.identity} active="" err="需要登录后才能访问个人中心。">
      <div class="card">
        <p>请先登录后再访问此页面。</p>
        <p class="muted">
          <a href="/api/auth/sign-in">前往登录</a>
        </p>
      </div>
    </Layout>
  )
}

export interface LlmUsageSummary {
  requests: number
  complete: number
  failed: number
  rejected: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface MediaUsageSummary {
  requests: number
  perModel: Array<{ modelId: string; requests: number }>
}

export interface ModelUsageRow {
  modelId: string
  requests: number
  totalTokens: number
}

export function OverviewPage(props: {
  identity: AccountIdentity
  llm: LlmUsageSummary
  topModels: ModelUsageRow[]
  media: MediaUsageSummary
  ok?: string
  err?: string
}) {
  return (
    <Layout identity={props.identity} active="用量" ok={props.ok} err={props.err}>
      <div class="card">
        <h2>近 7 天模型用量</h2>
        <div class="grid">
          <div class="stat"><div class="num">{props.llm.requests}</div><div class="lbl">请求总数</div></div>
          <div class="stat"><div class="num">{props.llm.complete}</div><div class="lbl">完成</div></div>
          <div class="stat"><div class="num">{props.llm.failed}</div><div class="lbl">失败</div></div>
          <div class="stat"><div class="num">{props.llm.rejected}</div><div class="lbl">已拒绝</div></div>
          <div class="stat"><div class="num">{props.llm.totalTokens}</div><div class="lbl">tokens 合计</div></div>
          <div class="stat"><div class="num">{props.llm.inputTokens} / {props.llm.outputTokens}</div><div class="lbl">tokens（入 / 出）</div></div>
          <div class="stat"><div class="num">{props.media.requests}</div><div class="lbl">媒体生成次数</div></div>
        </div>
      </div>
      <h2 style={{ fontSize: 15 }}>按模型（近 7 天，前 8）</h2>
      <table>
        <thead>
          <tr><th>模型</th><th>请求数</th><th>tokens 合计</th></tr>
        </thead>
        <tbody>
          {props.topModels.map((row) => (
            <tr><td>{row.modelId}</td><td>{row.requests}</td><td>{row.totalTokens}</td></tr>
          ))}
          {props.topModels.length === 0 ? <tr><td colspan={3} class="muted">暂无请求记录。</td></tr> : null}
        </tbody>
      </table>
      <h2 style={{ fontSize: 15, marginTop: 24 }}>媒体模型（近 7 天）</h2>
      <table>
        <thead>
          <tr><th>模型</th><th>生成次数</th></tr>
        </thead>
        <tbody>
          {props.media.perModel.map((row) => (
            <tr><td>{row.modelId}</td><td>{row.requests}</td></tr>
          ))}
          {props.media.perModel.length === 0 ? <tr><td colspan={2} class="muted">暂无媒体生成记录。</td></tr> : null}
        </tbody>
      </table>
    </Layout>
  )
}

export interface SessionRowView {
  id: string
  createdAt: Date
  expiresAt: Date
  ipAddress: string | null
  userAgent: string | null
  current: boolean
}

export function SessionsPage(props: { identity: AccountIdentity; sessions: SessionRowView[]; ok?: string; err?: string }) {
  return (
    <Layout identity={props.identity} active="会话" ok={props.ok} err={props.err}>
      <p class="muted" style={{ marginTop: 0 }}>撤销其他设备上的会话后，对方需重新登录；当前会话不可在此撤销。</p>
      <table>
        <thead>
          <tr><th>登录时间</th><th>过期时间</th><th>IP</th><th>设备（User-Agent）</th><th>操作</th></tr>
        </thead>
        <tbody>
          {props.sessions.map((session) => (
            <tr>
              <td>{session.createdAt.toISOString().slice(0, 16).replace('T', ' ')}</td>
              <td>{session.expiresAt.toISOString().slice(0, 16).replace('T', ' ')}</td>
              <td>{session.ipAddress ?? '—'}</td>
              <td style={{ maxWidth: 360, wordBreak: 'break-all' }}>{session.userAgent ?? '—'}</td>
              <td>
                {session.current ? (
                  <span class="pill ok">当前会话</span>
                ) : (
                  <form method="post" action={`/account/sessions/${session.id}/revoke`}>
                    <button class="danger">撤销</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
          {props.sessions.length === 0 ? <tr><td colspan={5} class="muted">暂无会话。</td></tr> : null}
        </tbody>
      </table>
    </Layout>
  )
}

export function TokensPage(props: { identity: AccountIdentity; tokens: ApiTokenRow[]; ok?: string; err?: string }) {
  return (
    <Layout identity={props.identity} active="API 令牌" ok={props.ok} err={props.err}>
      <div class="card stack">
        <h2>新建 API 令牌</h2>
        <p class="muted" style={{ margin: 0, gridColumn: '1 / -1', fontSize: 13 }}>
          令牌以 <code>bat_</code> 开头，创建后仅显示一次；用于脚本或无头终端以 Bearer 方式调用本服务 API。
        </p>
        <form method="post" action="/account/tokens">
          <label for="t-name">名称</label>
          <input id="t-name" name="name" required maxLength={64} placeholder="例如 my-laptop" />
          <div class="full"><button class="primary">创建令牌</button></div>
        </form>
      </div>
      <table>
        <thead>
          <tr><th>名称</th><th>创建时间</th><th>最近使用</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          {props.tokens.map((token) => (
            <tr>
              <td>{token.name}</td>
              <td>{token.createdAt.toISOString().slice(0, 16).replace('T', ' ')}</td>
              <td>{token.lastUsedAt ? token.lastUsedAt.toISOString().slice(0, 16).replace('T', ' ') : '从未使用'}</td>
              <td>
                {token.revokedAt ? <span class="pill off">已撤销</span> : <span class="pill ok">有效</span>}
              </td>
              <td>
                {token.revokedAt ? (
                  ''
                ) : (
                  <form method="post" action={`/account/tokens/${encodeURIComponent(token.id)}/revoke`}>
                    <button class="danger">撤销</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
          {props.tokens.length === 0 ? <tr><td colspan={5} class="muted">还没有 API 令牌。</td></tr> : null}
        </tbody>
      </table>
    </Layout>
  )
}

export function TokenCreatedPage(props: { identity: AccountIdentity; name: string; plaintext: string }) {
  return (
    <Layout identity={props.identity} active="API 令牌" ok="令牌已创建。">
      <div class="card">
        <h2>{props.name}</h2>
        <p class="muted">请立即复制保存——离开此页面后将无法再次查看，服务端只保存其哈希。</p>
        <div class="secret">{props.plaintext}</div>
        <p style={{ marginBottom: 0 }}>
          <a href="/account/tokens">返回令牌列表 »</a>
        </p>
      </div>
    </Layout>
  )
}

export function PasswordPage(props: { identity: AccountIdentity; ok?: string; err?: string }) {
  return (
    <Layout identity={props.identity} active="修改密码" ok={props.ok} err={props.err}>
      <div class="card stack">
        <h2>修改密码</h2>
        <form method="post" action="/account/password">
          <label for="pw-current">当前密码</label>
          <input id="pw-current" name="current_password" type="password" required autocomplete="current-password" />
          <label for="pw-new">新密码</label>
          <input id="pw-new" name="new_password" type="password" required minLength={8} autocomplete="new-password" />
          <label for="pw-confirm">确认新密码</label>
          <input id="pw-confirm" name="confirm_password" type="password" required minLength={8} autocomplete="new-password" />
          <label for="pw-revoke">撤销其他会话</label>
          <input id="pw-revoke" name="revoke_other_sessions" type="checkbox" checked />
          <div class="full"><button class="primary">保存新密码</button></div>
        </form>
      </div>
    </Layout>
  )
}

export function DeviceApprovePage(props: {
  identity: AccountIdentity
  code: string
  userAgent: string | null
  expiresAt: Date | null
  state: 'pending' | 'approved' | 'used' | 'unknown' | 'expired'
  ok?: string
  err?: string
}) {
  const stateView = () => {
    if (props.state === 'approved') return <span class="pill ok">已批准（等待终端领取）</span>
    if (props.state === 'used') return <span class="pill off">已被使用</span>
    if (props.state === 'expired') return <span class="pill bad">已过期</span>
    if (props.state === 'unknown') return <span class="pill bad">无效的码</span>
    return <span class="pill warn">待批准</span>
  }
  return (
    <Layout identity={props.identity} active="" ok={props.ok} err={props.err}>
      <div class="card">
        <h2>设备登录批准</h2>
        {props.state === 'unknown' || props.state === 'expired' ? (
          <p>这个设备码无效或已过期。请回到终端重新生成。</p>
        ) : (
          <>
            <p>
              设备码：<code>{props.code}</code> {stateView()}
            </p>
            <p>
              申请方 User-Agent：
              <br />
              <span class="muted" style={{ wordBreak: 'break-all' }}>{props.userAgent ?? '未提供'}</span>
            </p>
            {props.expiresAt ? (
              <p class="muted">有效期至 {props.expiresAt.toISOString().slice(0, 16).replace('T', ' ')}（UTC）。</p>
            ) : null}
            {props.state === 'pending' ? (
              <form method="post" action="/account/device/approve">
                <input type="hidden" name="code" value={props.code} />
                <button class="primary">批准此设备</button>
              </form>
            ) : null}
          </>
        )}
        <p class="muted" style={{ marginBottom: 0 }}>
          批准后，该终端将获得一枚以你的账号名义调用的 API 令牌；如需收回，请到
          <a href="/account/tokens">API 令牌</a> 页撤销。
        </p>
      </div>
    </Layout>
  )
}
