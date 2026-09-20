import { useStore } from '../store/useStore.js'
import { useT, t } from '../i18n/index.js'
import { useLayoutPrefs, MONITOR_ID, MONITOR_TOGGLE_ID } from '../lib/layoutPrefs.js'
import '../styles/monitor.css'

// 顯示 / 隱藏「輸入輸出監看」：Monitor 標題列的隱藏鈕、Footer 的「系統事件」開關、鍵盤 L 三處共用這一個入口。
// 隱藏只是不渲染——日誌（store.log / 完整 LOG）照常累積，再顯示就看得到全部。切換時在 OUT 記一行（同「畫面資訊面板」的作法），
// 用鍵盤 L 切換時螢幕閱讀器與 Footer 那一行才有回饋。
export function setMonitorVisible(show) {
  const prefs = useLayoutPrefs.getState()
  const v = !!show
  if (prefs.monitorShown === v) return
  prefs.setMonitorShown(v)
  useStore.getState().pushLog('out', v ? t('系統事件面板：顯示') : t('系統事件面板：隱藏'))
}
export function toggleMonitorVisible() { setMonitorVisible(!useLayoutPrefs.getState().monitorShown) }

export default function Monitor() {
  const t = useT()
  const log = useStore((s) => s.log)
  const ins = log.filter((l) => l.dir === 'in').slice(-4)
  const outs = log.filter((l) => l.dir === 'out').slice(-4)

  // 按「隱藏」後這顆鈕會隨 Monitor 一起消失 → 把焦點交給 Footer 的切換鈕（鍵盤 / 螢幕閱讀器使用者不會掉到頁首）
  const hide = () => {
    setMonitorVisible(false)
    setTimeout(() => { try { const b = document.getElementById(MONITOR_TOGGLE_ID); if (b) b.focus() } catch (e) {} }, 0)
  }

  return (
    <section id={MONITOR_ID} className="monitor" aria-label={t('輸入輸出監看：MIDI 進、系統事件出')}>
      <div className="mcol">
        <div className="mhead">{t('IN · 演奏者（KORG）')}</div>
        {ins.length
          ? ins.map((l, i) => <div key={i} className="mline">{l.text}</div>)
          : <div className="mline dim">{t('等待輸入…（先按「連線 MIDI」）')}</div>}
      </div>
      <div className="mcol">
        <div className="mhead mhead-row">
          <span>{t('OUT · 系統事件')}</span>
          <button type="button" className="monitor-hide" onClick={hide} data-tour-ui
                  aria-label={t('隱藏系統事件')} title={t('隱藏系統事件（快速鍵 L）')} aria-expanded="true" aria-controls={MONITOR_ID}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
              <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        {outs.length
          ? outs.map((l, i) => <div key={i} className="mline">{l.text}</div>)
          : <div className="mline dim">—</div>}
      </div>
    </section>
  )
}
