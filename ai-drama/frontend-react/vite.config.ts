import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

// 开发与预览均将 API 和媒体请求代理到 Hono，保持与生产部署相同的请求路径。
// 后端固定用高位端口 30171，避开 n8n(5678) 等常规占用；例外时可用 AI_DRAMA_BACKEND_ORIGIN 覆盖。
const backendOrigin = process.env.AI_DRAMA_BACKEND_ORIGIN || 'http://localhost:30172'
const backendProxy = {
  '/api': { target: backendOrigin, changeOrigin: true },
  '/static': { target: backendOrigin, changeOrigin: true },
  '/console': { target: backendOrigin, changeOrigin: true },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 30170,
    strictPort: true,
    proxy: backendProxy,
  },
  preview: {
    port: 30170,
    strictPort: true,
    proxy: backendProxy,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router'],
          'vendor-query': ['@tanstack/react-query'],
        },
      },
    },
  },
  css: {
    modules: {
      // 允许 styles['kebab-class'] 与 styles.camelClass 两种访问方式
      localsConvention: 'camelCase',
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
