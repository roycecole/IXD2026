import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useTourStore, captionText } from '../lib/tour.js'
import { useT } from '../i18n/index.js'
import '../styles/tour.css'

// 資料導覽字幕：畫布下方置中的大字幕（標題一行 + 說明最多兩行）、淡入淡出、一排進度點（第 n / N 站）。
// 屬於「畫布上的資訊面板」：受 overlays.hud 控制（關閉時不顯示，導覽仍照跑）。
// 字幕只存資料 { key, p }，這裡依「當下語系」組文字——useT() 訂閱語系，切換語言時字幕立刻跟著換。
// 觀眾視窗也渲染同一個元件，資料來自 mirror（見 lib/tour.js），所以這裡不含任何導覽邏輯。
// 淡入用 setTimeout（不是 rAF）：內嵌 / 背景面板的 rAF 會被節流。
export default function TourCaption() {
  const t = useT()
  const hud = useStore((s) => s.overlays.hud)
  const running = useTourStore((s) => s.running)
  const caption = useTourStore((s) => s.caption)
  const index = useTourStore((s) => s.index)
  const total = useTourStore((s) => s.total)
  const stopMs = useTourStore((s) => s.stopMs)
  const seq = useTourStore((s) => s.seq)
  const [view, setView] = useState(null)     // 目前畫面上的那張字幕（換站時先淡出舊的、換內容、再淡入）
  const [shown, setShown] = useState(false)
  const viewRef = useRef(null)

  useEffect(() => {
    const timers = []
    const later = (fn, ms) => { timers.push(setTimeout(fn, ms)) }
    if (running && caption && hud) {
      const next = { caption, index, total, stopMs, seq }
      const cur = viewRef.current
      if (cur && cur.seq !== seq) {          // 換站
        setShown(false)
        later(() => { viewRef.current = next; setView(next); later(() => setShown(true), 30) }, 280)
      } else {
        viewRef.current = next; setView(next)
        later(() => setShown(true), 30)
      }
    } else {
      setShown(false)
      later(() => { viewRef.current = null; setView(null) }, 450)
    }
    return () => timers.forEach(clearTimeout)
  }, [running, hud, caption, index, total, stopMs, seq])

  const txt = view ? captionText(view.caption) : null
  return (
    <div className={'tour-caption' + (shown ? ' on' : '')} role="status" aria-live="polite" aria-label={t('資料導覽字幕')} data-tour-ui>
      {view && txt && (
        <div className="tour-cap">
          <div className="tour-cap-title">{txt.title}</div>
          <div className="tour-cap-body">{txt.body}</div>
          <div className="tour-dots" aria-hidden="true">
            {Array.from({ length: view.total }, (_, i) => (
              <i key={i} className={'tour-dot' + (i < view.index ? ' done' : i === view.index ? ' cur' : '')}>
                {i === view.index && <b key={view.seq} style={{ animationDuration: view.stopMs + 'ms' }} />}
              </i>
            ))}
          </div>
          <span className="tour-sr">{t('第 {n} / {total} 站', { n: view.index + 1, total: view.total })}</span>
        </div>
      )}
    </div>
  )
}
