import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { useStore } from './store/useStore.js'
import './styles.css'

// 開發輔助：主控台可用 window.__store 驅動測試（無實體 MIDI 時模擬 handleCC 等）
if (import.meta.env.DEV) window.__store = useStore

// PWA：正式環境註冊 service worker（離線可開、可加入主畫面）
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
