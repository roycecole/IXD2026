import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 供測試（scripts/vite-config.test.mjs）：node_modules 路徑 → chunk 名稱（其餘交給 Rollup 自動分塊）
// 例外：英文字典（src/i18n/en/*.js 與彙整它們的 src/i18n/en-all.js）全部歸同一個 chunk「i18n-en」——它只被 src/i18n/index.js 的 loadEnglish() 動態 import，
// 中文使用者與手機遙控頁的中文模式完全不下載；不能有任何靜態依賴指向它（src/i18n/data.js 用自己的 data-tables.js，不 import ./en/）。
export function manualChunk(id) {
  const p = String(id).replace(/\\/g, '/')
  if (!p.includes('/node_modules/')) return /\/src\/i18n\/(en\/[^/]+\.js|en-all\.js)(\?.*)?$/.test(p) ? 'i18n-en' : undefined
  if (/\/node_modules\/@react-three\//.test(p)) return 'r3f'
  if (/\/node_modules\/three\//.test(p)) return 'three'
  if (/\/node_modules\/(react|react-dom|scheduler|use-sync-external-store|zustand)\//.test(p)) return 'react'
  return undefined
}

// ---- 版本檔（展場防呆：頁面定期比對 /version.json，有新版就在閒置時自動重新載入；見 src/lib/resilience.js）----
// build id = 「程式碼內容」的 sha1 前 12 碼（不含時間戳 / 隨機鹽）：src/、index.html、package.json / package-lock.json、vite.config.js、public/（不含 public/data/）。
//   為什麼只看程式碼：CI 每 3 小時會重新整理 public/data/ocean.json 並重新部署（.github/workflows/refresh-data.yml）。id 若每次建置都不同，
//   每一次「只換資料」的部署都會讓所有視窗整頁重載（投影機的觀眾視窗退出全螢幕、MIDI 要重連、手機遙控斷線）；資料的更新由頁面自己就地換
//   （lib/resilience.js 的 createDataRefresher；觀眾視窗也是），只有程式真的變了才需要重載。測試檔（*.test.*）、測試專用的輔助檔（tourTestEnv.mjs）與文件（*.md）不算。
//   · 同一份程式碼（不論建置幾次、何時建置）id 相同；任何程式檔改一個字 id 就不同
//   · 外掛在建置時輸出 dist/version.json：{ id, builtAt }（builtAt 只給人看，比對只看 id）
//   · define 把同一個 id 注入程式（__BUILD_ID__；dev 模式為 'dev'，程式據此不做版本檢查）
const ROOT = dirname(fileURLToPath(import.meta.url))
const CODE_DIRS = ['src', 'public']
const CODE_FILES = ['index.html', 'package.json', 'package-lock.json', 'vite.config.js']
const SKIP_DIRS = new Set(['public/data'])                        // 相對於專案根目錄（POSIX 路徑）：資料快照不算程式碼
const SKIP_FILE = /(\.test\.[cm]?js$|(^|\/)tourTestEnv\.mjs$|\.md$|(^|\/)\.DS_Store$)/   // tourTestEnv.mjs：測試專用的輔助檔（9 個 *.test.mjs 匯入、不會被打包進任何 chunk），檔名沒有 .test. 所以要另外列出——只改它、程式行為完全沒變時，id 不該變（否則所有展場視窗都在閒置時白白重載）

// 會影響執行結果的檔案（相對路徑、POSIX 分隔、排序）。讀不到的目錄 / 檔案略過（不讓建置因此失敗）。
export function listCodeFiles(root = ROOT) {
  const out = []
  const walk = (dir) => {
    let ents = []
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch (e) { return }
    for (const d of ents) {
      const abs = join(dir, d.name)
      const rel = relative(root, abs).split(sep).join('/')
      if (d.isDirectory()) { if (!SKIP_DIRS.has(rel)) walk(abs) }
      else if (d.isFile() && !SKIP_FILE.test(rel)) out.push(rel)
    }
  }
  for (const d of CODE_DIRS) walk(join(root, d))
  for (const f of CODE_FILES) { try { readFileSync(join(root, f)); out.push(f) } catch (e) { /* 沒有這個檔：略過 */ } }
  return out.sort()
}

export function makeBuildId(root = ROOT) {
  const h = createHash('sha1')
  for (const rel of listCodeFiles(root)) {
    let buf = null
    try { buf = readFileSync(join(root, rel)) } catch (e) { continue }
    h.update(rel); h.update('\0'); h.update(buf); h.update('\0')
  }
  return h.digest('hex').slice(0, 12)
}

// command：'build' → 依程式碼算 id；'serve'（dev）→ 'dev'
export function buildInfo(command, now = new Date(), root = ROOT) {
  if (command !== 'build') return { id: 'dev', builtAt: '' }
  return { id: makeBuildId(root), builtAt: now.toISOString() }
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
