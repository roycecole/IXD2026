import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n/index.js'
import { useStore } from '../store/useStore.js'
import { useLayoutPrefs, watchNarrowViewport, pickLatestOut, isDataLine, throttleDelay, MONITOR_ID, MONITOR_TOGGLE_ID } from '../lib/layoutPrefs.js'
import { toggleMonitorVisible } from './Monitor.jsx'
import '../styles/monitor.css'

const EVENT_URL = 'https://ixda.kktix.cc/events/ixda-member-2026'
const LATEST_MS = 500   // 最新事件那一行最快每 0.5 秒換一次（事件很密時不狂閃）。0.5 秒對螢幕閱讀器仍然太密：資料播放的 DATA 行不進朗讀（見 LatestLine）

// 最新一則 OUT 事件：日誌裡沒有新的 OUT（例如一直在收 IN）時，保留上一則；日誌一則都沒有 → 空（不顯示）。
function useLatestOutText(latest) {
  const [shown, setShown] = useState(latest)
  const lastAt = useRef(Date.now())
  useEffect(() => {
    if (latest == null || latest === shown) return
    const id = setTimeout(() => { lastAt.current = Date.now(); setShown(latest) }, throttleDelay(lastAt.current, Date.now(), LATEST_MS))
    return () => clearTimeout(id)
  }, [latest, shown])
  return shown
}

function LatestLine() {
  const latest = useStore((s) => pickLatestOut(s.log))   // 回傳字串：內容沒變就不重繪
  const text = useLatestOutText(latest)
  if (!text) return null
  // 資料播放（空氣品質每 0.2 秒一步、月亮 0.25 秒…）每一步都寫一行「DATA …」：放進 aria-live 會變成每 0.5 秒一次的朗讀佇列，蓋過導覽字幕、還落後畫面。
  // 所以 DATA 行只給眼睛看（aria-hidden：aria-live 區域裡被隱藏的內容不會被朗讀）；使用者的動作、導覽站名等其他事件照常朗讀。畫面上的內容與樣式不變。
  return (
    <>
      <span className="footer-out-tag" aria-hidden="true">OUT</span>
      <span className="footer-out-text" title={text} aria-hidden={isDataLine(text) ? 'true' : undefined}>{text}</span>
    </>
  )
}

export default function Footer({ onInfo, installEvt, onInstall }) {
  const t = useT()
  const shown = useLayoutPrefs((s) => s.monitorShown)

  // 沒有偏好、沒有網址覆寫時，視窗跨過手機斷點（820px）就自動顯示 / 隱藏監看；Footer 一直掛著，所以由它訂閱（Monitor 隱藏時不渲染）
  useEffect(() => watchNarrowViewport(typeof window !== 'undefined' ? window : null, (narrow) => useLayoutPrefs.getState().setNarrow(narrow)), [])

  return (
    <footer className="footer">
      <span className="footer-main"><b>MidiSea</b> · {t('IxDA Taiwan 2026 會員工作坊「AI 共生黑客鬆」')}</span>
      <span className="footer-sep">·</span>
      <span className="footer-team">{t('{n}組 卡加布列島', { n: 12 })}</span>
      <a href={EVENT_URL} target="_blank" rel="noopener noreferrer">{t('活動 ↗')}</a>
      {/* 監看隱藏時，這裡用一行小字顯示最新一則 OUT 系統事件（polite：不打斷；常駐在 DOM 裡，內容出現才會被朗讀；高頻的 DATA 行不朗讀，見 LatestLine） */}
      <span className="footer-out" aria-live="polite" aria-atomic="true">{shown ? null : <LatestLine />}</span>
      <button type="button" id={MONITOR_TOGGLE_ID} className={'footer-log' + (shown ? ' on' : '')} onClick={toggleMonitorVisible} data-tour-ui
              aria-label={t('系統事件')} aria-pressed={shown} aria-expanded={shown} aria-controls={shown ? MONITOR_ID : undefined}
              title={shown ? t('隱藏系統事件（快速鍵 L）') : t('顯示系統事件（快速鍵 L）')}>
        <i className="footer-log-sw" aria-hidden="true" />
        <span className="footer-log-long" aria-hidden="true">{t('系統事件')}</span>
        <span className="footer-log-short" aria-hidden="true">{t('事件')}</span>
      </button>
      <button className="footer-help" onClick={onInfo}>{t('操作說明')}</button>
      {installEvt && <button className="footer-install" onClick={onInstall} title={t('安裝成 App：離線可開、全螢幕演出')}>{t('加入主畫面')}</button>}
    </footer>
  )
}
