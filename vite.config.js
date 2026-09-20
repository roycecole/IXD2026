import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash, randomBytes } from 'node:crypto'

// 供測試（scripts/vite-config.test.mjs）：node_modules 路徑 → chunk 名稱（其餘交給 Rollup 自動分塊）
export function manualChunk(id) {
  const p = String(id).replace(/\\/g, '/')
  if (!p.includes('/node_modules/')) return undefined
  if (/\/node_modules\/@react-three\//.test(p)) return 'r3f'
  if (/\/node_modules\/three\//.test(p)) return 'three'
  if (/\/node_modules\/(react|react-dom|scheduler|use-sync-external-store|zustand)\//.test(p)) return 'react'
  return undefined
}

// ---- 版本檔（展場防呆：頁面定期比對 /version.json，有新版就在閒置時自動重新載入；見 src/lib/resilience.js）----
// build id = 建置時間戳（UTC，YYYYMMDDHHMMSS）+ 短 hash（時間戳 + 隨機鹽的 sha1 前 7 碼）。同一次建置用同一個 id：
//   · 外掛在建置時輸出 dist/version.json：{ id, builtAt }
//   · define 把同一個 id 注入程式（__BUILD_ID__；dev 模式為 'dev'，程式據此不做版本檢查）
export function makeBuildId(date = new Date(), salt = randomBytes(8).toString('hex')) {
  const p = (n) => String(n).padStart(2, '0')
  const ts = `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`
  return `${ts}-${createHash('sha1').update(ts + salt).digest('hex').slice(0, 7)}`
}

// command：'build' → 產生新的 id；'serve'（dev）→ 'dev'
export function buildInfo(command, now = new Date()) {
  if (command !== 'build') return { id: 'dev', builtAt: '' }
  return { id: makeBuildId(now), builtAt: now.toISOString() }
}

export function versionPlugin(info) {
  return {
    name: 'midisea-version',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ id: info.id, builtAt: info.builtAt }) + '\n' })
    },
  }
}

export default defineConfig(({ command }) => {
  const info = buildInfo(command)
  return {
    // 自訂網域 midisea.shyetech.com 於根路徑服務 → base 一律 '/'
    base: '/',
    define: { __BUILD_ID__: JSON.stringify(info.id) },
    plugins: [react(), versionPlugin(info)],
    build: {
      // HTML 只預載入口 chunk 直接需要的東西，不預抓 three / r3f（保險：即使日後有人把它們放回入口的靜態依賴，也不會被 <link rel=modulepreload> 拉進來）。
      // 真正讓手機遙控頁（#remote=）不下載 three（~176KB gzip）的是下面的 manualChunks + main.jsx 不靜態載入 store / 場景：
      // 入口 chunk 只依賴 react（RemoteApp 只需要 react、ice、sensors、i18n）；App 與場景（three / r3f）都是動態載入。
      modulePreload: {
        resolveDependencies: (filename, deps, { hostType }) =>
          hostType === 'html' ? deps.filter((d) => !/three|r3f/.test(d)) : deps,
      },
      rollupOptions: {
        output: {
          // 函式形式 + 錨定路徑：物件形式 { r3f: ['@react-three/fiber'] } 會把 r3f 依賴的 react / react-dom 也吸進 r3f chunk，
          // 於是「只要用到 React 就要下載 r3f，而 r3f 又靜態 import three」——入口一路把 three 拉進來（手機遙控頁 ≈308KB gzip，實際只需要 ≈97KB）。
          // 順序：先比對 @react-three（否則 /three/ 的比對會把它也吃進 three chunk）。
          manualChunks: manualChunk,
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
  }
})
