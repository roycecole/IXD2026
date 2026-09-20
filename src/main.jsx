import React, { Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { t, bootLocale } from './i18n/index.js'
import { flagOn } from './lib/urlFlags.js'
import ErrorBoundary from './ErrorBoundary.jsx'
import './styles.css'

// 英文字典是動態載入的 chunk（i18n-en；中文使用者完全不下載）：語系偵測為 en（?lang=en / 存過偏好 / 瀏覽器語言）時，要在「第一次 render 之前」就緒，
// 否則使用者會先看到中文再變英文。所以最前面就開始載入（與下面路由 chunk 的載入並行），最後 render 前才等它——
// 最多等 8 秒：逾時 / 載入失敗 → 先以中文 render（不白屏）；字典之後才到就自動切換並重繪（見 i18n/index.js 的 bootLocale）。語系是 zh 時這裡立刻完成、什麼都不載。
const localeReady = bootLocale()

// 開發輔助：主控台可用 window.__store 驅動測試（無實體 MIDI 時模擬 handleCC 等）。
// 動態載入 + 只在 DEV：正式建置整段被移除。不能靜態 import——store 有頂層副作用，Rollup 不會 tree-shake，
// 於是整個 store（連同 haptics 等）會被拉進入口 chunk，手機遙控頁（#remote=）也得下載一份用不到的程式。
if (import.meta.env.DEV) import('./store/useStore.js').then((m) => { window.__store = m.useStore })

// PWA：正式環境註冊 service worker（離線可開、可加入主畫面）
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}

// #remote=<hostId>[&guide=<token>] → 手機遙控頁（輕量，不載 three / 主畫面）；否則載入完整導演台。
// hostId 只取第一個 & 之前；guide 是導覽員 token（導覽員 QR 帶來的；不合法就當作沒有）；其他參數忽略；壞編碼不丟例外。
// 解析規則與 lib/tourRemote.js 的 parseRemoteHash 完全相同（tourRemote.test.mjs 會擷取這個函式逐案核對）——這裡內聯而不 import，
// 免得把導覽員的 host 邏輯（createGuideHost 等）拉進入口 chunk：手機遙控頁、展場與診斷頁都要先下載入口。
const parseRemote = (hash) => {
  const parts = typeof hash === 'string' && hash.startsWith('#remote=') ? hash.slice(8).split('&') : null
  const dec = (v) => { try { return decodeURIComponent(v) } catch (e) { return v } }
  const hostId = parts && dec(parts[0])
  if (!hostId) return null
  let guide = null
  for (const p of parts.slice(1)) {
    const k = p.indexOf('=')
    if (k > 0 && p.slice(0, k) === 'guide' && guide === null) { const v = dec(p.slice(k + 1)); if (/^[0-9a-z]{6,32}$/.test(v)) guide = v }
  }
  return { hostId, guide }
}
const remoteMatch = parseRemote(location.hash)
// 已開的分頁換 hash（切遙控模式、或掃到「新的 host id」）→ 一律重載重建連線
const initialHash = location.hash || ''
window.addEventListener('hashchange', () => {
  if ((location.hash || '') !== initialHash) location.reload()
})
const App = lazy(() => import('./App.jsx'))
const RemoteApp = lazy(() => import('./remote/RemoteApp.jsx'))
// ?audience=1 → 觀眾視窗（雙螢幕：投影機顯示同一片海，主視窗的操作即時同步；不載 UI / 服務）
const audienceMode = flagOn(location.search, 'audience')
const AudienceApp = lazy(() => import('./AudienceApp.jsx'))
// ?diagnostics=1 → 裝置診斷頁（展前在現場硬體逐項檢查相機 / 麥克風 / 語音 / 震動 / XR…並匯出報告；不載 three / 主畫面）
const diagnosticsMode = flagOn(location.search, 'diagnostics')
const DiagnosticsApp = lazy(() => import('./DiagnosticsApp.jsx'))
// 主畫面 / 觀眾視窗一開始就預載 3D 場景（three / r3f）：它們不在入口 chunk 裡（手機遙控頁不需要），不預載的話要等 App 渲染完才開始抓 → 多一趟往返。
// 手機遙控頁（#remote=）不預載，維持輕量。
if (!remoteMatch && !diagnosticsMode) import('./scene/Scene3D.jsx').catch(() => {})
// 與英文字典並行預抓「這個網址會用到的」路由 chunk：等字典期間不閒著；之後 lazy() 的 import() 命中同一個模組（瀏覽器的模組表會去重），不改變上面的路由分流。
// 前提：這些模組在 import 當下不呼叫 t()（i18n.test.mjs 掃描守住）——它們可能比英文字典先執行完。
;(remoteMatch ? import('./remote/RemoteApp.jsx') : diagnosticsMode ? import('./DiagnosticsApp.jsx') : audienceMode ? import('./AudienceApp.jsx') : import('./App.jsx')).catch(() => {})

// 第一次 render 等英文字典就緒（或逾時 / 失敗）；bootLocale 永遠 resolve，所以不論結果都 render
const mount = () => createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {/* 最外層錯誤邊界（展場防呆）：render 出錯 → 復原畫面 + 倒數自動重新載入；觀眾視窗的防呆也由它啟動（見 ErrorBoundary.jsx） */}
    <ErrorBoundary>
      <Suspense fallback={<div className="canvas-loading">{t('載入中…')}</div>}>
        {remoteMatch ? <RemoteApp hostId={remoteMatch.hostId} guide={remoteMatch.guide} /> : diagnosticsMode ? <DiagnosticsApp /> : audienceMode ? <AudienceApp /> : <App />}
      </Suspense>
    </ErrorBoundary>
  </React.StrictMode>,
)

localeReady.then(mount, mount)
