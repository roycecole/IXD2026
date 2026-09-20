import { useEffect, useRef } from 'react'
import { useStore, seriesMeta } from '../store/useStore.js'
import { ageFromLunar, moonPhaseName } from '../lib/moon.js'

// 資料播放時，畫布上方顯示「現在播到幾點的資料」：站名 日期 時刻 · 數值（含倍速/循環標記）。
// 潮汐另外顯示：乾/滿潮標記、農曆日期、潮差、月相（潮汐是月亮的引力）。
export default function DataHUD() {
  const ref = useRef()
  useEffect(() => {
    let raf
    const loop = () => {
      const el = ref.current
      if (el) {
        const st = useStore.getState()
        if (seriesMeta.active && st.rec.mode === 'playing' && seriesMeta.points.length) {
          const idx = Math.max(0, Math.min(seriesMeta.points.length - 1, Math.floor(st.rec.playhead / seriesMeta.step)))
          const p = seriesMeta.points[idx]
          const hh = String(Math.floor(p.h)).padStart(2, '0')
          const mm = String(Math.round((p.h % 1) * 60)).padStart(2, '0')
          let txt = `${seriesMeta.name} ${seriesMeta.date} ${hh}:${mm} · ${seriesMeta.label} ${p.v}${seriesMeta.unit}`
          if (seriesMeta.target === 'seaLevel') {
            const ev = (seriesMeta.events || []).find((e) => Math.abs(e.h - p.h) < 0.75) // 乾 / 滿潮時刻前後 45 分鐘
            if (ev) txt += ev.type === '滿潮' ? ' ↑滿潮' : ev.type === '乾潮' ? ' ↓乾潮' : ''
            const age = ageFromLunar(seriesMeta.lunar, p.h)
            if (seriesMeta.lunarLabel) txt += ` · ${seriesMeta.lunarLabel}${seriesMeta.range ? ' ' + seriesMeta.range + '潮' : ''}`
            if (age != null) txt += ` · ${moonPhaseName(age)}`
          }
          txt += ((st.rec.speed || 1) !== 1 ? ` · ×${st.rec.speed}` : '') + (st.rec.loop ? ' · 循環' : '')
          if (el.__t !== txt) { el.__t = txt; el.textContent = txt } // 內容 1.1s 才變，不必每幀寫 DOM
          el.style.opacity = 1
        } else el.style.opacity = 0
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  return <div className="data-hud" ref={ref} aria-live="polite" />
}
