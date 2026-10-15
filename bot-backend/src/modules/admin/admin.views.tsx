import type { Child } from 'hono/jsx'
import type { LlmModelRow, LlmRequestLogRow, UserQuotaRow } from '../../db/schema.js'

/**
 * Operations console views (server-rendered, 中文界面). Everything escapes
 * through hono/jsx; forms POST to sibling handlers and redirect back with a
 * `?ok=`/`?err=` flash.
 */

export interface AdminIdentity {
  userId: string
  email: string
}

const NAV = [
  { href: '/admin', label: '用户' },
  { href: '/admin/models', label: '模型' },
  { href: '/admin/requests', label: '请求' },
  { href: '/admin/status', label: '状态' },
]

function Layout(props: { identity: AdminIdentity; active: string; ok?: string; err?: string; children: Child }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>运营管理后台</title>
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
          input, select, textarea { border: 1px solid #d0d5dd; border-radius: 6px; padding: 5px 8px; font-size: 13px; font-family: inherit; }
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
        `}</style>
      </head>
      <body>
        <header>
          <span class="brand">运营管理后台</span>
          <nav>
            {NAV.map((item) => (
              <a href={item.href} class={item.label === props.active ? 'active' : ''}>{item.label}</a>
            ))}
          </nav>
          <span class="who">{props.identity.email}</span>
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

export function ForbiddenPage(props: { identity: AdminIdentity | null }) {
  return (
    <Layout identity={props.identity ?? { userId: '', email: '未登录' }} active="" err="需要管理员权限。">
      <div class="card">
        <p>此区域仅对 <code>role=admin</code> 的账号开放。请在 BOT_BACKEND_ADMIN_EMAILS 名单内的邮箱注册，或联系现有管理员。</p>
        <p class="muted">
          <a href="/api/auth/sign-in">前往登录</a>
        </p>
      </div>
    </Layout>
  )
}

export interface UserRowView {
  id: string
  email: string
  name: string
  role: string
  banned: boolean
  banReason: string | null
  createdAt: Date
}

export function UsersPage(props: {
  identity: AdminIdentity
  users: UserRowView[]
  query: string
  ok?: string
  err?: string
}) {
  return (
    <Layout identity={props.identity} active="用户" ok={props.ok} err={props.err}>
      <div class="card">
        <form method="get" action="/admin" style={{ display: 'flex', gap: 8 }}>
          <input type="search" name="q" placeholder="按邮箱搜索" value={props.query} />
          <button>搜索</button>
        </form>
      </div>
      <table>
        <thead>
          <tr>
            <th>邮箱</th>
            <th>昵称</th>
            <th>角色</th>
            <th>状态</th>
            <th>注册时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {props.users.map((user) => (
            <tr>
              <td>{user.email}</td>
              <td>{user.name}</td>
              <td>{user.role === 'admin' ? <span class="pill warn">管理员</span> : <span class="pill off">用户</span>}</td>
              <td>
                {user.banned ? (
                  <span class="pill bad" title={user.banReason ?? ''}>已停用{user.banReason ? `：${user.banReason}` : ''}</span>
                ) : (
                  <span class="pill ok">正常</span>
                )}
              </td>
              <td>{user.createdAt.toISOString().slice(0, 16).replace('T', ' ')}</td>
              <td>
                {user.banned ? (
                  <form method="post" action={`/admin/users/${user.id}/unban`}>
                    <button>启用</button>
                  </form>
                ) : (
                  <form method="post" action={`/admin/users/${user.id}/ban`}>
                    <input type="text" name="reason" placeholder="停用原因" size={10} />
                    <button class="danger">停用</button>
                  </form>
                )}{' '}
                <form method="post" action={`/admin/users/${user.id}/role`}>
                  <input type="hidden" name="role" value={user.role === 'admin' ? 'user' : 'admin'} />
                  <button>{user.role === 'admin' ? '取消管理员' : '设为管理员'}</button>
                </form>{' '}
                <a href={`/admin/users/${user.id}`}>额度 »</a>
              </td>
            </tr>
          ))}
          {props.users.length === 0 ? (
            <tr>
              <td colspan={6} class="muted">没有匹配的用户。</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </Layout>
  )
}

export function UserDetailPage(props: {
  identity: AdminIdentity
  user: UserRowView
  quota: UserQuotaRow | null
  todayTokens: number
  requests: LlmRequestLogRow[]
  ok?: string
  err?: string
}) {
  const allowlist = props.quota?.modelAllowlist ? (JSON.parse(props.quota.modelAllowlist) as string[]).join(', ') : ''
  return (
    <Layout identity={props.identity} active="用户" ok={props.ok} err={props.err}>
      <div class="card">
        <h2>
          {props.user.email} — {props.user.name}{' '}
          {props.user.banned ? <span class="pill bad">已停用</span> : <span class="pill ok">正常</span>}
        </h2>
        <p class="muted">
          角色：{props.user.role} · 注册：{props.user.createdAt.toISOString().slice(0, 16).replace('T', ' ')} · 今日已知用量：{props.todayTokens} tokens
          {props.quota?.dailyTokenLimit != null ? ` / 上限 ${props.quota.dailyTokenLimit}` : '（未设上限）'}
        </p>
      </div>
      <div class="card stack">
        <h2>额度设置（留空 = 跟随服务默认/不限制）</h2>
        <form method="post" action={`/admin/users/${props.user.id}/quota`}>
          <label for="daily">每日 token 上限</label>
          <input id="daily" name="daily_token_limit" type="number" min="0" value={props.quota?.dailyTokenLimit ?? ''} />
          <label for="conc">并发流上限</label>
          <input id="conc" name="concurrency_limit" type="number" min="1" value={props.quota?.concurrencyLimit ?? ''} />
          <label for="allow">可用模型（逗号分隔，空 = 全部）</label>
          <input id="allow" name="model_allowlist" value={allowlist} />
          <div class="full">
            <button class="primary">保存额度</button>
          </div>
        </form>
      </div>
      <h2 style={{ fontSize: 15 }}>最近请求（20）</h2>
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>模型</th>
            <th>状态</th>
            <th>错误</th>
            <th>tokens</th>
            <th>耗时</th>
          </tr>
        </thead>
        <tbody>
          {props.requests.map((row) => (
            <tr>
              <td>{row.createdAt.toISOString().slice(5, 16).replace('T', ' ')}</td>
              <td>{row.modelId}</td>
              <td>
                <StatusPill status={row.status} />
              </td>
              <td>{row.errorMessage ?? row.errorCode ?? ''}</td>
              <td>{row.totalTokens ?? '—'}</td>
              <td>{row.durationMs}ms</td>
            </tr>
          ))}
          {props.requests.length === 0 ? (
            <tr>
              <td colspan={6} class="muted">暂无请求记录。</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </Layout>
  )
}

export function StatusPill(props: { status: string }) {
  if (props.status === 'complete') return <span class="pill ok">完成</span>
  if (props.status === 'failed') return <span class="pill bad">失败</span>
  return <span class="pill warn">已拒绝</span>
}

export function ModelsPage(props: {
  identity: AdminIdentity
  models: LlmModelRow[]
  editId: string | null
  ok?: string
  err?: string
}) {
  const editing = props.editId ? (props.models.find((model) => model.id === props.editId) ?? null) : null
  return (
    <Layout identity={props.identity} active="模型" ok={props.ok} err={props.err}>
      <div class="card stack">
        <h2>{editing ? `编辑模型 ${editing.id}` : '新增模型'}</h2>
        <form method="post" action="/admin/models">
          <label for="m-id">模型 ID（客户端用名）</label>
          <input id="m-id" name="id" required value={editing?.id ?? ''} />
          <label for="m-provider">Provider</label>
          <select id="m-provider" name="provider">
            {(['openai', 'anthropic', 'google'] as const).map((provider) => (
              <option value={provider} selected={editing?.provider === provider}>{provider}</option>
            ))}
          </select>
          <label for="m-model">上游模型串（保密）</label>
          <input id="m-model" name="model" required value={editing?.model ?? ''} />
          <label for="m-display">展示名</label>
          <input id="m-display" name="display_name" value={editing?.displayName ?? ''} />
          <label for="m-max">输出上限（可空）</label>
          <input id="m-max" name="max_output_tokens" type="number" min="1" value={editing?.maxOutputTokens ?? ''} />
          <label for="m-ctx">上下文长度（可空）</label>
          <input id="m-ctx" name="context_length" type="number" min="1" value={editing?.contextLength ?? ''} />
          <label for="m-note">备注</label>
          <input id="m-note" name="note" value={editing?.note ?? ''} />
          <label for="m-default">默认模型</label>
          <input id="m-default" name="is_default" type="checkbox" checked={editing?.isDefault ?? false} />
          <label for="m-enabled">启用</label>
          <input id="m-enabled" name="enabled" type="checkbox" checked={editing ? editing.enabled : true} />
          <div class="full">
            <button class="primary">保存</button>
            {editing ? (
              <a href="/admin/models" style={{ marginLeft: 10 }}>取消编辑</a>
            ) : null}
          </div>
        </form>
      </div>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Provider</th>
            <th>上游模型</th>
            <th>默认</th>
            <th>状态</th>
            <th>输出上限</th>
            <th>备注</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {props.models.map((model) => (
            <tr>
              <td>{model.id}</td>
              <td>{model.provider}</td>
              <td>{model.model}</td>
              <td>{model.isDefault ? '✓' : ''}</td>
              <td>{model.enabled ? <span class="pill ok">启用</span> : <span class="pill off">停用</span>}</td>
              <td>{model.maxOutputTokens ?? '—'}</td>
              <td>{model.note ?? ''}</td>
              <td>
                <a href={`/admin/models?edit=${encodeURIComponent(model.id)}`}>编辑</a>{' '}
                <form method="post" action={`/admin/models/${encodeURIComponent(model.id)}/toggle`}>
                  <button>{model.enabled ? '停用' : '启用'}</button>
                </form>{' '}
                <form method="post" action={`/admin/models/${encodeURIComponent(model.id)}/delete`}>
                  <button class="danger">删除</button>
                </form>
              </td>
            </tr>
          ))}
          {props.models.length === 0 ? (
            <tr>
              <td colspan={8} class="muted">目录为空。LLM_MODEL_CATALOG 仅在空表时播种一次。</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </Layout>
  )
}

export function RequestsPage(props: {
  identity: AdminIdentity
  rows: (LlmRequestLogRow & { email: string | null })[]
  status: string
  ok?: string
  err?: string
}) {
  return (
    <Layout identity={props.identity} active="请求" ok={props.ok} err={props.err}>
      <div class="card">
        <form method="get" action="/admin/requests" style={{ display: 'flex', gap: 8 }}>
          <select name="status">
            <option value="" selected={props.status === ''}>全部状态</option>
            <option value="failed" selected={props.status === 'failed'}>仅失败</option>
            <option value="rejected" selected={props.status === 'rejected'}>仅拒绝</option>
            <option value="complete" selected={props.status === 'complete'}>仅完成</option>
          </select>
          <button>筛选</button>
        </form>
      </div>
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>用户</th>
            <th>模型</th>
            <th>状态</th>
            <th>错误 / 结束原因</th>
            <th>tokens (入/出)</th>
            <th>耗时</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr>
              <td>{row.createdAt.toISOString().slice(5, 16).replace('T', ' ')}</td>
              <td>{row.email ?? row.userId ?? '—'}</td>
              <td>{row.modelId}</td>
              <td>
                <StatusPill status={row.status} />
              </td>
              <td>
                {row.errorMessage ?? row.errorCode ?? ''}
                {row.finishReason ? <span class="muted"> / {row.finishReason}</span> : null}
              </td>
              <td>{row.inputTokens ?? '—'} / {row.outputTokens ?? '—'}</td>
              <td>{row.durationMs}ms</td>
            </tr>
          ))}
          {props.rows.length === 0 ? (
            <tr>
              <td colspan={7} class="muted">暂无记录。</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </Layout>
  )
}

export function StatusPage(props: {
  identity: AdminIdentity
  stats: {
    dbOk: boolean
    redisOk: boolean
    uptimeSeconds: number
    activeStreams: number | null
    totalUsers: number
    bannedUsers: number
    adminUsers: number
    modelsEnabled: number
    modelsTotal: number
    dayComplete: number
    dayFailed: number
    dayRejected: number
  }
  ok?: string
  err?: string
}) {
  const pct = (part: number, total: number) => (total === 0 ? '—' : `${Math.round((part / total) * 100)}%`)
  return (
    <Layout identity={props.identity} active="状态" ok={props.ok} err={props.err}>
      <div class="grid">
        <div class="card stat">
          <div class="num">{props.stats.dbOk ? '正常' : '故障'}</div>
          <div class="lbl">PostgreSQL</div>
        </div>
        <div class="card stat">
          <div class="num">{props.stats.redisOk ? '正常' : '故障'}</div>
          <div class="lbl">Redis</div>
        </div>
        <div class="card stat">
          <div class="num">{props.stats.activeStreams ?? '?'}</div>
          <div class="lbl">进行中的模型流</div>
        </div>
        <div class="card stat">
          <div class="num">{Math.floor(props.stats.uptimeSeconds / 3600)}h {Math.floor((props.stats.uptimeSeconds % 3600) / 60)}m</div>
          <div class="lbl">服务运行时长</div>
        </div>
        <div class="card stat">
          <div class="num">{props.stats.totalUsers}</div>
          <div class="lbl">用户（{props.stats.bannedUsers} 停用 / {props.stats.adminUsers} 管理员）</div>
        </div>
        <div class="card stat">
          <div class="num">{props.stats.modelsEnabled}/{props.stats.modelsTotal}</div>
          <div class="lbl">启用模型 / 目录总数</div>
        </div>
        <div class="card stat">
          <div class="num">{props.stats.dayComplete + props.stats.dayFailed + props.stats.dayRejected}</div>
          <div class="lbl">24h 模型请求</div>
        </div>
        <div class="card stat">
          <div class="num">
            {pct(props.stats.dayFailed, props.stats.dayComplete + props.stats.dayFailed)}
          </div>
          <div class="lbl">24h 流内失败率（{props.stats.dayFailed} 失败 / {props.stats.dayRejected} 拒绝）</div>
        </div>
      </div>
    </Layout>
  )
}
