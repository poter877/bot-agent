import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

// 开发时 30177 代理到 bot-backend(30172)；生产由 Hono 同源挂在 /console。
// 代理把 Origin 改写成后端 origin：后端写操作有 same-origin 断言（admin.api.ts），
// better-auth 的 origin 校验也按后端 origin 进行。
const backend = 'http://localhost:30172'
const proxyToBackend = {
  target: backend,
  changeOrigin: true,
  headers: { origin: backend },
}

export default defineConfig({
  // 生产由 Hono 挂在 /console 下，资产引用必须带此前缀
  base: '/console/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 30177,
    strictPort: true,
    proxy: {
      '/api': proxyToBackend,
      '/admin/api': proxyToBackend,
    },
  },
  build: { outDir: 'dist', sourcemap: false },
})
