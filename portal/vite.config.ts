import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 门户壳：hermes dashboard(:30176) 与 ai-drama(:30170) 的运行时切换入口。
// 开发时两个子前端各自跑 dev server；生产经反代/端口直连（TRIO_* 可覆盖）。
const DRAMA = process.env.PORTAL_DRAMA_URL || 'http://localhost:30170'
const DASHBOARD = process.env.PORTAL_DASHBOARD_URL || 'http://localhost:30176'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 30178,
    strictPort: true,
  },
  define: {
    __PORTAL_DRAMA_URL__: JSON.stringify(process.env.PORTAL_DRAMA_URL || ''),
    __PORTAL_DASHBOARD_URL__: JSON.stringify(process.env.PORTAL_DASHBOARD_URL || ''),
  },
  build: { outDir: 'dist' },
})
