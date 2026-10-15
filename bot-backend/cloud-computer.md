# 公司账号云电脑

## 已实现的链路

```text
Electron 云电脑页面 ─┐
                   ├→ 本地 Python（账号会话）→ Hono（Better Auth / 归属 / 控制租约）
本地 Agent computer_use ┘                         ↓ 私有 worker 认证
                                             Linux Docker worker
                                                 ↓
                              每账号独立桌面容器 + 持久化 home 数据卷
```

每个 Better Auth 用户在 PostgreSQL 中只有一条 `cloud_computer` 记录。客户端不提交
用户 id、容器 id、Docker 参数、宿主路径或 worker 地址。服务端用已验证的账号解析资源。
Hono 的厂商密钥、账号数据库和 worker token 不进入桌面容器。

点击“启动”首次创建并启动；停止后再次启动恢复同一个资源和 home。停止保留下载文件、
浏览器资料与登录状态，但关闭进程，不能恢复进程内尚未保存的内容。此版本不提供删除数据、
系统快照、自动扩容、计费或闲置自动关机。

## 控制与会话

- 页面可以在不接管的情况下查看截图。接管后发放仅驻留页面内存的随机 viewer token，
  绑定账号、Better Auth 登录会话与电脑代次，服务端只存哈希；60 秒过期，页面每 20 秒续租。
- 接管期间 Hono 拒绝 Agent 截图和输入，交还、过期或登录会话撤销后恢复 Agent 权限。
  PostgreSQL 事务锁把电脑输入、截图和接管串行化，适用于多个 Hono 副本。
- 请求携带电脑 generation 和控制 epoch。启停、意外重建或控制权变化使旧请求失效；
  409 只刷新状态，不自动重放点击或键盘输入。私有 worker 按账号串行执行，接管先确认
  worker 已完成先前操作；内部控制命令使用执行期限，迟到的命令不能继续落下输入。
- 退出账号或切换连接/profile 清除页面画面与 token，本地 Python 客户端绑定账号代次，
  旧客户端不能借用后续登录。用户退出不会删除文件或自动停止已经运行的云电脑。

页面的“让助手使用云电脑”选择现有 `computer_use.backend=company-cloud`，只对新 Agent
会话生效。原会话固定其 provider，避免中途改变工具含义和提示缓存。云 provider 不回退
本机桌面；不支持的应用树、元素编号等操作明确报错，使用全屏截图和像素坐标。Terminal、
文件与 browser 工具的执行目标继续遵守各自配置，本次不把整个 Agent 搬到服务器。

## Linux 部署

使用专用 Linux Docker 主机或专用虚拟机作为 worker。公开 Hono 以普通用户运行；worker
拥有管理 Docker 和检查主机防火墙的权限，仅监听回环或受保护的私网入口。不同主机之间
使用私有 TLS，不把 worker 端口暴露到公网。API 与 worker 都使用本仓库的 Node 24+ 运行时。
容器参数、持久卷和防火墙配置分别参考 Docker 官方的
[运行说明](https://docs.docker.com/engine/containers/run/)、
[数据卷说明](https://docs.docker.com/engine/storage/volumes/)和
[网络防火墙说明](https://docs.docker.com/engine/network/packet-filtering-firewalls/)。

1. 在仓库根构建桌面镜像：

   ```bash
   docker build -f bot-backend/cloud-computer-runtime/Dockerfile -t bot-cloud-desktop:local .
   ```

   发布时把基础镜像和 `CLOUD_WORKER_IMAGE` 固定到审核过的 digest。容器以 UID 1000
   运行，根文件系统只读、移除 capabilities，禁止获得新权限，有 CPU/内存/PID 限额，
   没有公开端口、宿主目录或 Docker socket；home 为账号专属 named volume。
   可通过 `CLOUD_WORKER_RUNTIME` 使用宿主已配置的额外隔离 runtime。

2. 配置隔离网络（仅在目标 Linux worker 主机执行）：

   ```bash
   sudo bash bot-backend/cloud-computer-runtime/setup-network.sh
   ```

   该脚本创建专用 bridge、禁止容器间通信，并安装 DOCKER-USER/INPUT 规则，阻断私网、
   link-local、metadata 和宿主访问，默认只放行公网 HTTP(S) 与 DNS 出口。部署前确认
   子网不与公司网络冲突；脚本支持网络名和子网参数。持久化这些规则，机器重启后先恢复
   防火墙再启动 worker。worker 启动电脑前检查实际规则，缺失时拒绝运行。

3. 在 `bot-backend` 安装依赖并构建：

   ```bash
   npm ci
   npm run build
   ```

   为 worker 单独设置 `CLOUD_WORKER_TOKEN`（随机、至少 32 字符），以及镜像、网络、资源
   上限。默认 `CLOUD_WORKER_HOST=127.0.0.1`、`CLOUD_WORKER_PORT=3031`，最多同时运行
   10 台桌面，每台 2 CPU / 2048 MiB。启动入口：

   ```bash
   node --env-file=cloud-worker.env dist/cloud-worker/index.js
   ```

   可参考运行目录的 `worker.env.example` 和 systemd 示例。worker 环境只放运行服务所需
   的凭据，不提供模型密钥或账号数据库连接信息。

4. Hono 设置并应用迁移：

   ```dotenv
   CLOUD_COMPUTER_ENABLED=true
   CLOUD_COMPUTER_WORKER_URL=http://127.0.0.1:3031
   CLOUD_COMPUTER_WORKER_TOKEN=<与 worker 相同的私有随机 token>
   ```

   ```bash
   npm run db:migrate
   node --env-file=.env dist/index.js
   ```

   迁移工具需要部署环境提供 `DATABASE_URL`。Hono 启动后自动扫描持久化 desired state，
   API 重启不会丢失启停请求。运行状态每约 30 秒与 worker 对账，失败保留可见错误并重试。
   容器退出后的重启由 Hono 负责，先更新电脑代次再恢复；Docker 自动重启关闭，日常运维
   也通过此生命周期操作，避免绕过旧画面失效机制。
   不能访问 worker 时不会改走用户本机。默认关闭功能时，状态接口返回 `enabled:false`。
   反向代理为 `/v1/cloud-computer/` 配置 64 KiB 请求限制，参考 `deploy/nginx.conf.example`。

5. 桌面登录公司账号，打开“云电脑”，启动并等待画面出现。接管后可直接点击画面，
   输入文本或快捷键；交还后开启新聊天，让助手通过 `computer_use` 操作该桌面。

## 公共接口

统一前缀 `/v1/cloud-computer`，全部要求 Better Auth；POST 要求匹配后端的 Origin。
接口中不存在可由客户端指定的 owner 或实例 id。

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/status` | 功能状态、账号电脑状态、尺寸、generation、控制 epoch；不返回 viewer token |
| POST | `/start` | 幂等创建/启动/恢复，立即返回 starting，由后台 worker 完成 |
| POST | `/stop` | 停止请求，保留持久化 home |
| POST | `/capture` | 经权限检查返回 PNG base64、尺寸、generation、epoch |
| POST | `/actions` | click / move / drag / type / key / scroll；坐标和输入体积有界 |
| POST | `/lease/acquire` | 接管；返回当前状态和 viewer token |
| POST | `/lease/renew` | 持 token 延长当前登录会话的租约 |
| POST | `/lease/release` | 持 token 交还给助手 |

截图不缓存。云电脑请求使用独立的 64 KiB 请求预算、账号和 IP 限流，避免画面轮询挤占
普通账号接口预算。请求日志不记录正文、图片、输入内容或控制 token。

## 验证与部署边界

集成测试使用真实 PostgreSQL、Redis 和 Better Auth，验证账号归属、认证撤销、租约过期、
跨登录会话拒绝、旧 generation/epoch 拒绝、持久启停状态和 worker 故障恢复。私有 HTTP
适配器测试认证头、禁止重定向和返回资源匹配。Docker worker 与固定控制 helper 有独立的
进程契约测试，桌面和 Python 有实际协议回归。

开发机没有 Docker，因此镜像构建、Linux 防火墙、实际 Xvnc/Chromium、文字输入和停止后
数据恢复仍需在目标 worker 上执行 smoke 验收。测试通过不代表已部署或已验证真实桌面。
目标机器可运行 `cloud-computer-runtime/smoke-test.py --help` 查看真实运行验收步骤；
该脚本会创建随机测试电脑，默认仅清理本次创建的测试容器和卷；传 `--keep` 可保留供检查。
named volume 的备份、磁盘容量和配额由公司存储运维配置；本版没有每账号磁盘配额系统。
