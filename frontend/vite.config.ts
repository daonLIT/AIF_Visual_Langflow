import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const workbenchSrc = fileURLToPath(new URL('../packages/aif-workbench/src', import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    // 공유 화면 패키지는 빌드 없이 소스를 그대로 쓴다. 세부 모듈은 '@aif/workbench/<경로>'.
    alias: [
      { find: /^@aif\/workbench$/, replacement: `${workbenchSrc}/index.ts` },
      { find: /^@aif\/workbench\/(.*)$/, replacement: `${workbenchSrc}/$1` },
    ],
  },
  server: {
    // 개발 중 /api 는 중계 서버(backend, 기본 8000 포트)로 전달한다. API 키는 서버에만 있다.
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})
