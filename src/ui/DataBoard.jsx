import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { describeBoard } from '../lib/describe.js'

// 資料看板：畫布左上角列出「目前海況背後的真實資料」與它映射成的畫面參數（輸出顯示資料）。
// 展場 / 簡報時讓觀眾一眼看出「這片海是哪筆政府資料變的」。右上 × / 面板「畫面顯示」/ 快速鍵 I 可隱藏。
export default function DataBoard() {
  const show = useStore((s) => s.overlays.board)
  const setOverlay = useStore((s) => s.setOverlay)
  const gov = useStore((s) => s.gov)
  const optId = useStore((s) => s.govOptionId)
  const surveyMonth = useStore((s) => s.surveyMonth)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!show) return
    const iv = setInterval(() => tick((x) => x + 1), 1000) // 潮位 / 月亮等依「現在時刻」的列每秒重算
    return () => clearInterval(iv)
  }, [show])
  if (!show || !gov || !gov.options) return null
  const opt = gov.options.find((o) => o.id === optId) || gov.options[0]
  const rows = describeBoard(gov, opt, { month: surveyMonth == null ? undefined : surveyMonth })
  if (!rows.length) return null
  return (
    <div className="data-board" role="complementary" aria-label="資料看板">
      <div className="data-board-head">
        <div className="data-board-title">資料 · {opt.name}</div>
        <button className="data-board-x" onClick={() => setOverlay('board', false)} aria-label="隱藏資料看板" title="隱藏資料看板（快速鍵 I 全部隱藏 / 顯示；面板「畫面顯示」可單獨開關）">×</button>
      </div>
      {rows.map((r, i) => (
        <div className="data-board-row" key={i}><span className="k">{r.k}</span><span className="v">{r.v}</span></div>
      ))}
    </div>
  )
}
