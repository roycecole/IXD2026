import React, { Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { useStore } from './store/useStore.js'
import { t } from './i18n/index.js'
import './styles.css'

// 開發輔助：主控台可用 window.__store 驅動測試（無實體 MIDI 時模擬 handleCC 等）
if (import.meta.env.DEV) window.__store = useStore

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
const audienceMode = (() => { try { return new URLSearchParams(location.search).get('audience') === '1' } catch (e) { return false } })()
const AudienceApp = lazy(() => import('./AudienceApp.jsx'))

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Suspense fallback={<div className="canvas-loading">{t('載入中…')}</div>}>
      {remoteMatch ? <RemoteApp hostId={decodeURIComponent(remoteMatch[1])} /> : audienceMode ? <AudienceApp /> : <App />}
    </Suspense>
  </React.StrictMode>,
)
