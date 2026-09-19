import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // 自訂網域 midisea.shyetech.com 於根路徑服務 → base 一律 '/'
  base: '/',
  plugins: [react()],
  build: {
    // 把 three / r3f 拆成獨立可快取 chunk；配合 App 的 React.lazy(Scene3D)，shell 先 paint
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          r3f: ['@react-three/fiber'],
        },
      },
    },
  },
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
