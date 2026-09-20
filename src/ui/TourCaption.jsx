import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useTourStore, captionText, captionNote } from '../lib/tour.js'
import { tourRunner } from '../services/tourCore.js'
import TourNav from './TourNav.jsx'
import { useT, useLocale } from '../i18n/index.js'
import '../styles/tour.css'
import '../styles/tourpresenter.css'
import '../styles/tourplan.css'

// 資料導覽字幕：畫布下方置中的大字幕（標題一行 + 說明最多兩行）、淡入淡出、一排進度點（第 n / N 站）、導覽員控制列。
// 屬於「畫布上的資訊面板」：受 overlays.hud 控制（關閉時不顯示，導覽仍照跑）。
// 字幕只存資料 { key, p }，這裡依「當下語系」組文字——useT() 訂閱語系，切換語言時字幕立刻跟著換。
// 觀眾視窗也渲染同一個元件，資料來自 mirror（見 lib/tour.js）：那邊（remote）進度點是純顯示、沒有導覽員控制列，只多一個「已暫停」小標。
// 主視窗：進度點是真的 <button>（點了跳到該站；視覺上仍是小點，觸控熱區 ≥ 44px 靠按鈕本身的高度，見 tourpresenter.css），下方是 TourNav。
// 容器整塊 pointer-events: none（不擋 3D 畫布的拖曳），只有按鈕收事件；朗讀用的 live region 只包標題 / 說明（按鈕與「已暫停」小標不在裡面：狀態變化不會把整段字幕重讀一次，
// 暫停 / 繼續由 TourNav 內那個一直存在的 live region 簡短播報）。
// 空氣品質站字幕若帶了「模型 vs 環境部測站觀測」（caption.p.cmp），字幕下方附一行小字出處與授權（政府資料開放授權條款－第1版）。
// 導覽腳本的備註（caption.p.note，導覽員輸入的原文、不翻譯）顯示在說明下方：較小字、另一種顏色、最多兩行（超出省略）；主視窗與觀眾視窗（經 mirror）都看得到。
// 說明比平常長（例如空氣品質站多了「模型 vs 觀測」一句）時 data-long 讓說明放寬到 3 行，誠實的比較句才不會被省略號吃掉。
// 淡入用 setTimeout（不是 rAF）：內嵌 / 背景面板的 rAF 會被節流。
const stopDbl = (e) => e.stopPropagation()   // .canvas-wrap 的雙擊 = 切換演出模式：連點進度點不該把演出模式切掉

const LONG_BODY = { zh: 62, en: 120 }   // 超過這個字數（既有各站字幕的上限）→ 說明放寬到 3 行

export default function TourCaption() {
  const t = useT()
  const locale = useLocale()
  const hud = useStore((s) => s.overlays.hud)
  const running = useTourStore((s) => s.running)
  const caption = useTourStore((s) => s.caption)
  const index = useTourStore((s) => s.index)
  const total = useTourStore((s) => s.total)
  const stopMs = useTourStore((s) => s.stopMs)
  const seq = useTourStore((s) => s.seq)
  const paused = useTourStore((s) => s.paused)
  const remote = useTourStore((s) => s.remote)
  const stopList = useTourStore((s) => s.stopList)
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
  const note = view ? captionNote(view.caption) : ''
  const cmpSrc = !!(view && view.caption && view.caption.key === 'air' && view.caption.p && view.caption.p.cmp)   // 字幕用了環境部測站觀測 → 附出處與授權
  const interactive = !remote                // 主視窗：進度點可點 + 導覽員控制列；觀眾視窗：純顯示
  const dotClass = (i) => 'tour-dot' + (i < view.index ? ' done' : i === view.index ? ' cur' : '')
  const dotFill = (i) => i === view.index && <b key={view.seq} style={{ animationDuration: view.stopMs + 'ms' }} />
  const stopTitle = (i) => { const s = stopList && stopList[i]; return s ? captionText(s.caption).title : '' }
  return (
    <div className={'tour-caption' + (shown ? ' on' : '')} data-paused={paused ? 'true' : undefined} data-tour-ui>
      {view && txt && (
        <div className="tour-cap">
          {paused && <span className="tour-paused">{t('已暫停')}</span>}
          <div className="tour-cap-text" role="status" aria-live="polite" aria-label={t('資料導覽字幕')}>
            <div className="tour-cap-title">{txt.title}</div>
            <div className="tour-cap-body" data-long={txt.body.length > (locale === 'en' ? LONG_BODY.en : LONG_BODY.zh) ? 'true' : undefined}>{txt.body}</div>
            {cmpSrc && <div className="tour-cap-src">{t('資料來源：環境部測站觀測（政府資料開放授權條款－第1版）')}</div>}
            {note && <div className="tour-cap-note">{note}</div>}
            <span className="tour-sr">{t('第 {n} / {total} 站', { n: view.index + 1, total: view.total })}</span>
          </div>
          {interactive ? (
            <div className="tour-dots tour-dots-nav" role="group" aria-label={t('導覽進度（點一下跳到該站）')} onDoubleClick={stopDbl}>
              {Array.from({ length: view.total }, (_, i) => {
                const title = stopTitle(i)
                return (
                  <button key={i} type="button" className="tour-dotbtn" data-tour-ui aria-current={i === view.index ? 'step' : undefined}
                          aria-label={title ? t('第 {n} 站：{title}', { n: i + 1, title }) : t('第 {n} 站', { n: i + 1 })}
                          onClick={() => tourRunner.goto(i)}>
                    <i className={dotClass(i)}>{dotFill(i)}</i>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="tour-dots" aria-hidden="true">
              {Array.from({ length: view.total }, (_, i) => <i key={i} className={dotClass(i)}>{dotFill(i)}</i>)}
            </div>
          )}
          {interactive && <TourNav variant="caption" />}
        </div>
      )}
    </div>
  )
}
