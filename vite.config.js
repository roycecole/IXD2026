import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // GitHub Pages 專案頁面路徑（Actions 建置時自動套用；本機 dev 仍為 /）
  base: process.env.GITHUB_ACTIONS ? '/IXD2026/' : '/',
  plugins: [react()],
  server: {
    // 之後接真實政府開放資料時，在這裡加代理層：解 CORS，並把 API Key 藏在後端（不進前端）。
    // 例：CWA 開放平台
    // proxy: {
    //   '/api/cwa': {
    //     target: 'https://opendata.cwa.gov.tw',
    //     changeOrigin: true,
    //     rewrite: (p) => p.replace(/^\/api\/cwa/, ''),
    //   },
    // },
  },
})
