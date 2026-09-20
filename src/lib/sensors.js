// 手機感測器（遙控頁用）：傾斜 → 洋流方向、搖晃 → 浪湧。輸出走既有 wire 協定
// （{t:'p', pid:'flowX'|'flowY'} 與 {t:'n', note:17}），主畫面端不需任何新程式。
// 保持輕量：不依賴 store / three，遙控頁可以單獨載入。
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// iOS 13+ 需在使用者手勢內請求；Android / 桌面直接放行
export async function askSensorPermission() {
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
      if ((await DeviceOrientationEvent.requestPermission()) !== 'granted') return false
    }
    if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission) {
      if ((await DeviceMotionEvent.requestPermission()) !== 'granted') return false
    }
    return true
  } catch (e) { return false }
}

// 傾斜：以啟用當下姿勢為基準（歸零可重設）。gamma=左右、beta=前後；range 度 = 洋流打滿。
// 傾向哪邊，洋流就流向哪邊（上緣朝外傾 = 流向遠方）。50ms 節流 + 變化 <1% 不送 + 死區防抖。
export function startTilt(emit, opts = {}) {
  const range = opts.range || 40
  const dead = opts.deadzone == null ? 3 : opts.deadzone
  let beta0 = null, lastX = -1, lastY = -1, lastT = 0, first = true
  const dz = (v) => (Math.abs(v) < dead ? 0 : v - Math.sign(v) * dead)
  const handler = (e) => {
    if (e.beta == null || e.gamma == null) return
    if (first) { first = false; opts.onFirst && opts.onFirst() }
    if (beta0 == null) beta0 = e.beta
    const fx = clamp(0.5 + (dz(e.gamma) / range) * 0.5, 0, 1)
    const fy = clamp(0.5 + (dz(e.beta - beta0) / range) * 0.5, 0, 1)
    const now = performance.now()
    if (now - lastT < 50) return
    if (Math.abs(fx - lastX) < 0.01 && Math.abs(fy - lastY) < 0.01) return
    lastT = now; lastX = fx; lastY = fy
    emit({ flowX: fx, flowY: fy })
  }
  window.addEventListener('deviceorientation', handler)
  return { stop: () => window.removeEventListener('deviceorientation', handler), recenter: () => { beta0 = null } }
}

// 搖晃：合加速度偏離重力 > threshold，冷卻 cooldown ms；回傳力度 0.5..1
export function startShake(onShake, opts = {}) {
  const th = opts.threshold == null ? 9 : opts.threshold
  const cool = opts.cooldown == null ? 700 : opts.cooldown
  let last = 0
  const handler = (e) => {
    const a = e.accelerationIncludingGravity
    if (!a) return
    const mag = Math.abs(Math.hypot(a.x || 0, a.y || 0, a.z || 0) - 9.81)
    const now = performance.now()
    if (mag > th && now - last > cool) { last = now; onShake(clamp(mag / 28, 0.5, 1)) }
  }
  window.addEventListener('devicemotion', handler)
  return () => window.removeEventListener('devicemotion', handler)
}
