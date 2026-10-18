import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

// 开发与预览均将 API 和媒体请求代理到 Hono，保持与生产部署相同的请求路径。
const backendProxy = {
  '/api': { target: 'http://localhost:5679', changeOrigin: true },
  '/static': { target: 'http://localhost:5679', changeOrigin: true },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 3014,
    strictPort: true,
    proxy: backendProxy,
  },
  preview: {
    port: 3014,
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
