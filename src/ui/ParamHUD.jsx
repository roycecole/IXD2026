import { useEffect, useRef } from 'react'
import { hudState } from '../store/hud.js'
import { t } from '../i18n/index.js'

// 轉旋鈕 / 拉滑桿 / MIDI 時，畫面上方淡入「參數名 值」再淡出（rAF 直接寫 DOM，不觸發 re-render）
export default function ParamHUD() {
  const ref = useRef()
  useEffect(() => {
    let raf
    const loop = () => {
      const el = ref.current
      if (el) {
        const age = (performance.now() - hudState.t) / 1000
        const op = age < 1.4 ? Math.max(0, 1 - age / 1.4) : 0
        el.style.opacity = op
        if (op > 0 && hudState.label) el.textContent = `${t(hudState.label)}　${Math.round(hudState.value * 100)}`
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  return <div className="hud" ref={ref} aria-live="polite" />
}
