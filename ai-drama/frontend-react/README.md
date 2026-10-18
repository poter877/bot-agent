# 视频工厂 React 前端

`frontend-react/` 是项目唯一前端。开发、服务器部署、Docker 和 Electron 桌面版统一使用本目录，静态产物位于 `dist/`。

## 技术栈

React 19、TypeScript strict、Vite 7、React Router 7、TanStack Query v5、Zustand v5、Tailwind CSS v4、React Hook Form、Zod、Radix Dialog/AlertDialog、i18next、lucide-react。

构建环境使用 Node.js 22.12+。

## 开发与检查

在仓库根目录安装依赖并分别启动前后端：

```bash
npm --prefix backend ci
npm --prefix frontend-react ci

# 终端一
npm run dev:backend

# 终端二
npm run dev:frontend
```

页面地址为 `http://localhost:3014`。Vite 开发与预览均把 `/api`、`/static` 代理至 `http://localhost:5679`。

```bash
npm run typecheck:frontend
npm run lint:frontend
npm run test:frontend
npm run build:frontend
```

`dev:frontend-react`、`build:frontend-react`、`test:frontend-react` 继续作为上述命令的别名。

## 生产与桌面

```bash
# 单服务：在仓库根目录执行，后端直接读取 frontend-react/dist
npm run build:frontend
npm --prefix backend start

# 桌面开发：自动构建 React、后端和主进程
npm run dev:desktop

# 桌面安装包：自动构建 React，再准备资源和打包
npm run dist
npm run dist:win
```

后端默认静态目录为 `frontend-react/dist`，可用 `FRONTEND_DIST` 覆盖。React Router 的页面直达与刷新由后端回退至 `index.html`。Electron 打包时将该产物复制至 `resources/frontend`，由主进程注入路径；开发模式直接读取本目录 `dist`。Docker 默认从当前源码构建本地 React 镜像，前端阶段执行 `npm run build`，运行时复制同一份产物，无需额外复制或创建符号链接。Watchtower 仅在配置自己的镜像并启用 `auto-update` profile 后启动。

`vite preview` 用于本地检查构建产物，生产部署通过 Hono 提供页面与 API。

## 架构

依赖方向为 `app/routes → features → entities → shared`：

```text
src/
  app/       应用入口、providers、路由、布局、主题和样式
  routes/    项目列表、项目详情、工作台和设置的 lazy 路由入口
  features/  业务交互、工作台、设置、偏好和桌面操作
  entities/  领域 API、DTO 映射和查询配置
  shared/    请求客户端、状态、基础组件、多语言词库和工具
```

- 服务端数据由 TanStack Query 管理，查询键包含工作区与资源 ID；任务终态由聚合查询派生，mutation 后更新或失效相关缓存。
- Zustand 保存主题、语言、面板记忆与工作台临时交互状态；剧集临时状态通过 store 工厂和 Context 隔离。
- 表单使用 React Hook Form 与 Zod；加载、错误和空状态由各业务模块处理。
- URL 保持 `/`、`/settings`、`/drama/:id`、`/drama/:id/episode/:episodeNumber`。
- 桌面能力通过类型化的 `shared/desktop/bridge.ts` 访问；非桌面环境隐藏对应操作。

## 样式与兼容

统一样式入口为 `src/app/styles/index.css`。层顺序为 `theme → base → vendor → components → utilities`；Tailwind Preflight 未启用，由 `base.css` 提供基础 reset。

`runtime-tokens.css` 定义 light/dark 设计值，`theme.css` 映射语义 utility；`vendor-overrides.css` 管理 driver.js 覆盖，`exceptions.css` 登记必要例外。公共控件使用 `shared/ui` 的 variants 和 `shared/lib/cn.ts`，不再使用 CSS Modules 或 legacy bridge。

主题使用 `html[data-theme]`，首帧在 `index.html` 初始化。用户偏好保留 `huobao:*` 存储键迁移逻辑，桌面桥保留 `window.huobaoDesktop`，确保已有项目、偏好和桌面能力兼容。四语言词库位于 `src/shared/locales/`。

## 测试

Vitest 覆盖 DTO 映射、偏好迁移、Tailwind 类合并、模型配置归属、参考图序号、工作台任务状态和布局尺寸约束。构建命令先执行 TypeScript 检查，再生成 Vite 静态产物。
