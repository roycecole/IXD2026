import { useEffect, useMemo, useRef } from 'react'
import { useStore, seriesMeta } from '../store/useStore.js'
import { useT } from '../i18n/index.js'
import { formatHud, gapRangeText, timelineLayout, timelineAxis, timelineAlt, playheadAt, isSameSeries } from '../lib/series.js'
import '../styles/timeline.css'

// 鳥 / 魚調查年表的時間軸：橫向從第一個調查年到最後一個調查年，依「真實年份」等比例排列（每個日曆年一格）。
//   調查年 → 小柱（高度依物種數）；空窗年 → 斜線陰影並標「無調查 2007–2013」（柱是淡淡的內插幽靈柱）。
//   播放這條序列時：游標隨 rec.playhead 連續掃過各年、目前年份的小柱亮起、右上角顯示「年份 · 種數（或無調查）」。
// 游標 / 亮起 / 讀數都由 store.subscribe 直接寫 DOM（transform、classList、textContent），不觸發 React 重繪；
// subscribe 只在 rec 換新物件（＝播放每一幀）時才動作，離開播放或卸載時取消訂閱。
// 版面位置全部是百分比（不量測像素）→ 任意寬度（含 ≤ 400px 手機）都不會溢出。

const LABEL_MIN_W = 30   // 空窗區間寬度（占整條 %）夠寬才把標籤寫在區間裡；較窄的只留 tooltip 與文字替代

export default function SurveyTimeline({ spec }) {
  const t = useT()
  // 父層每次重繪都會重算 spec（新物件）：以內容簽章當依賴，版面與訂閱才不會跟著重建
  const sig = spec && Array.isArray(spec.points) ? `${spec.kind}|${spec.name}|${spec.points.map((p) => p.t + ':' + p.v).join(',')}` : ''
  const L = useMemo(() => timelineLayout(spec), [sig])
  const ticks = useMemo(() => timelineAxis(L), [L])
  const root = useRef(null), cursor = useRef(null), readout = useRef(null)

  useEffect(() => {
    const el = root.current, cur = cursor.current, out = readout.current
    if (!L || !el || !cur || !out) return undefined
    const bars = new Map()
    el.querySelectorAll('[data-i]').forEach((b) => bars.set(Number(b.dataset.i), b))
    let on = false, idx = -1, x = -1, lastRec = null, seen = null, mine = false
    const isMine = () => {   // 播放一條新序列時 seriesMeta.points 會換成新陣列：以參照快取比對結果，不必每幀逐點比
      if (seriesMeta.points !== seen) { seen = seriesMeta.points; mine = isSameSeries(seriesMeta, spec) }
      return mine
    }
    const clear = () => {
      if (!on) return
      on = false; el.classList.remove('playing'); out.textContent = ''
      const b = bars.get(idx); if (b) b.classList.remove('cur')
      idx = -1; x = -1
    }
    const update = (st) => {
      const r = st.rec
      if (r.mode !== 'playing' || !seriesMeta.active || !isMine()) { clear(); return }
      const h = playheadAt(L, r.playhead, seriesMeta.step)
      if (!on) { on = true; el.classList.add('playing') }
      if (h.x !== x) { x = h.x; cur.style.transform = `translateX(${h.x}%)` }
      if (h.idx !== idx) {
        const prev = bars.get(idx); if (prev) prev.classList.remove('cur')
        idx = h.idx
        const b = bars.get(idx); if (b) b.classList.add('cur')
        const p = spec.points[idx]
        out.textContent = p.gap ? t('{year} 年 · 無調查（內插）', { year: p.t }) : t('{year} 年 · {v} 種', { year: p.t, v: p.v })
      }
    }
    update(useStore.getState())   // 掛載時若正好在播這條序列（例如切換海況又切回來），立刻接上
    const unsub = useStore.subscribe((st) => { if (st.rec === lastRec) return; lastRec = st.rec; update(st) })
    return () => { unsub(); clear() }
  }, [L, t])   // 語系變了要重建（讀數文字用當下語系）

  if (!L) return null
  const nYears = spec.extra.years.length
  const gapYears = L.bands.reduce((s, b) => s + b.len, 0)
  const summary = gapYears ? t('{n} 個調查年 · 空窗 {g} 年', { n: nYears, g: gapYears }) : t('{n} 個調查年 · 連續無空窗', { n: nYears })

  return (
    <div className="stl" ref={root} role="img" aria-label={timelineAlt(spec)}>
      <div className="stl-head">
        <span className="stl-title">{t('調查時間軸')}</span>
        <span className="stl-sum">{summary}</span>
        <span className="stl-now" ref={readout} />
      </div>
      <div className="stl-track">
        {L.bands.map((b) => {
          const label = t('無調查 {range}', { range: gapRangeText([b.a, b.b]) })
          return (
            <div key={'g' + b.a} className="stl-gap" style={{ left: b.x + '%', width: b.w + '%' }} title={label}>
              {b.w >= LABEL_MIN_W && <span>{label}</span>}
            </div>
          )
        })}
        {L.slots.map((s) => (
          <i key={s.year} data-i={s.i} className={'stl-bar' + (s.gap ? ' ghost' : '')}
             style={{ left: s.x + '%', width: s.w + '%', '--h': s.h + '%' }} title={formatHud(spec, spec.points[s.i])}><b /></i>
        ))}
        <div className="stl-phwrap"><div className="stl-ph" ref={cursor}><i /></div></div>
      </div>
      <div className="stl-axis">
        {ticks.map((k) => <span key={k.i} style={{ left: k.x + '%' }}>{k.year}</span>)}
      </div>
    </div>
  )
}
