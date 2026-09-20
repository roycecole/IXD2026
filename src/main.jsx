import React, { Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { t } from './i18n/index.js'
import { flagOn } from './lib/urlFlags.js'
import './styles.css'

// 開發輔助：主控台可用 window.__store 驅動測試（無實體 MIDI 時模擬 handleCC 等）。
// 動態載入 + 只在 DEV：正式建置整段被移除。不能靜態 import——store 有頂層副作用，Rollup 不會 tree-shake，
// 於是整個 store（連同 haptics 等）會被拉進入口 chunk，手機遙控頁（#remote=）也得下載一份用不到的程式。
if (import.meta.env.DEV) import('./store/useStore.js').then((m) => { window.__store = m.useStore })

// PWA：正式環境註冊 service worker（離線可開、可加入主畫面）
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}

// #remote=<hostId> → 手機遙控頁（輕量，不載 three / 主畫面）；否則載入完整導演台
const remoteMatch = (location.hash || '').match(/^#remote=(.+)$/)
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
// 主畫面 / 觀眾視窗一開始就預載 3D 場景（three / r3f）：它們不在入口 chunk 裡（手機遙控頁不需要），不預載的話要等 App 渲染完才開始抓 → 多一趟往返。
// 手機遙控頁（#remote=）不預載，維持輕量。
if (!remoteMatch) import('./scene/Scene3D.jsx').catch(() => {})

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Suspense fallback={<div className="canvas-loading">{t('載入中…')}</div>}>
      {remoteMatch ? <RemoteApp hostId={decodeURIComponent(remoteMatch[1])} /> : audienceMode ? <AudienceApp /> : <App />}
    </Suspense>
  </React.StrictMode>,
)
