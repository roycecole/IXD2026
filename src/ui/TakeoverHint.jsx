import { useEffect, useRef } from 'react'
import { getTakeoverHints } from '../store/useStore.js'

// 播放時，畫面下方顯示「待接管」的參數與實體旋鈕該轉的方向（配合 nanoKONTROL2 R 鍵閃燈）
export default function TakeoverHint() {
  const ref = useRef()
  useEffect(() => {
    let raf
    const loop = () => {
      const el = ref.current
      if (el) {
        const hints = getTakeoverHints()
        if (hints.length) { el.style.opacity = 1; el.textContent = '待接管　' + hints.map((h) => `${h.label}${h.dir}`).join('　') }
        else el.style.opacity = 0
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  return <div className="takeover-hint" ref={ref} aria-live="polite" />
}
