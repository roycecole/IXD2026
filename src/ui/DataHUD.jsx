import { useEffect, useRef } from 'react'
import { useStore, seriesMeta } from '../store/useStore.js'
import { ageFromLunar, moonPhaseName } from '../lib/moon.js'
import { formatHud } from '../lib/series.js'
import { t } from '../i18n/index.js'

// 資料播放時，畫布上方顯示「現在播到哪一筆資料」：潮汐 / 進流量 / 揚塵歷史 / 魚鳥調查年表 / 月出月沒，
// 含倍速 / 循環標記。文字由 formatHud 統一產生（OUT 監看的 DATA 行用同一份）。
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
          let moonName = ''
          if (seriesMeta.kind === 'tide') { const age = ageFromLunar(seriesMeta.lunar, p.h); if (age != null) moonName = moonPhaseName(age) } // 潮汐是月亮的引力
          const txt = formatHud(seriesMeta, p, { moonName }) +
            (st.rec.speed < 0.01 ? ' · ' + t('已暫停') : (st.rec.speed || 1) !== 1 ? ` · ×${st.rec.speed}` : '') + (st.rec.loop ? ' · ' + t('循環') : '')
          if (el.__t !== txt) { el.__t = txt; el.textContent = txt } // 內容變了才寫 DOM（空氣品質 0.2 秒、月亮 0.25 秒一步，不必每幀寫）
          el.style.opacity = 1
        } else el.style.opacity = 0
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  // 不是 live region：這行每 0.2–1 秒就換一次（空氣品質 0.2 秒一步、導覽時再加速），aria-live 會讓螢幕閱讀器的朗讀佇列堆積、播完還在念。
  // 內容仍在無障礙樹裡（瀏覽模式讀得到）；播放的開始 / 結束與站名由資料卡、導覽字幕（換站才更新的 live region）負責。
  return <div className="data-hud" ref={ref} aria-live="off" />
}
