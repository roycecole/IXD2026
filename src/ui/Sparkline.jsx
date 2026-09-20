import '../styles/air.css'

// 迷你折線圖（純 SVG、無依賴、可無障礙）。【介面契約——資料卡 / 資料看板 / 導覽字幕依此使用】
//   <Sparkline points={(number|null)[]} obs={(number|null)[]?} height={number?=28} marker={index?} ariaLabel={string} />
//   points：主要序列（模型 PM2.5，琥珀色）；obs：第二條線（環境部觀測，綠色；與 points 同一條時間軸、依索引對齊；null / 非數字 = 缺值，線在那裡斷開）；
//   marker：目前播放位置（索引；超出範圍 → 夾在頭尾；不是整數 / 負數 → 不畫）。
//   寬度 100% 自適應（viewBox 固定寬、preserveAspectRatio="none"，線用 non-scaling-stroke，所以縮放不會讓線變粗變細）；
//   顏色都是 CSS 變數（--amber / --accent / --muted，見 styles/air.css）；role="img" + aria-label（沒給 ariaLabel → 視為裝飾，aria-hidden）；
//   points 不足 2 筆、或整條都沒有有效數字 → 不渲染（回傳 null）。沒有任何動畫（也就不必特別處理 prefers-reduced-motion）；SSR 可渲染（沒有 effect / 瀏覽器 API）。
export const SPARK_W = 240   // viewBox 寬；只是座標系，實際寬度是 100%
const PAD_X = 2, PAD_Y = 3
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const c2 = (v) => Math.round(v * 100) / 100

// 純函式：把資料排成 SVG 座標（可在 Node 測試）。回傳 null 表示不必畫。
//   zero：所有值都 ≥ 0 時 y 軸從 0 起算（濃度類資料的誠實畫法，不把 20→24 放大成暴起暴落）
export function sparkModel({ points, obs, height = 28, marker, zero = true } = {}) {
  if (!Array.isArray(points) || points.length < 2) return null
  const a = points.map(num), b = Array.isArray(obs) ? obs.map(num) : null
  const n = Math.max(a.length, b ? b.length : 0)
  const vals = [...a, ...(b || [])].filter((v) => v !== null)
  if (!vals.length) return null
  const H = Number.isFinite(height) && height > 4 ? height : 28
  let lo = Math.min(...vals), hi = Math.max(...vals)
  if (zero && lo >= 0) { lo = 0; hi = hi > 0 ? hi * 1.08 : 1 }
  else if (hi === lo) { lo -= 1; hi += 1 }
  else { const pad = (hi - lo) * 0.08; lo -= pad; hi += pad }
  const innerW = SPARK_W - 2 * PAD_X, innerH = H - 2 * PAD_Y
  const x = (i) => c2(PAD_X + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW))
  const y = (v) => c2(PAD_Y + (1 - (v - lo) / (hi - lo)) * innerH)
  // 折線路徑：缺值處斷開（下一個有值的點重新 M）；孤立的一點（前後都缺）畫成零長度線段，圓端點會顯示成一個點
  const path = (arr) => {
    if (!arr) return ''
    const out = []
    let pen = false
    for (let i = 0; i < n; i++) {
      const v = i < arr.length ? arr[i] : null
      if (v === null) { pen = false; continue }
      const nextGap = i + 1 >= arr.length || arr[i + 1] === null
      if (!pen) out.push(`M${x(i)} ${y(v)}${nextGap ? ` L${x(i)} ${y(v)}` : ''}`)
      else out.push(`L${x(i)} ${y(v)}`)
      pen = true
    }
    return out.join('')
  }
  const mk = Number.isInteger(marker) && marker >= 0 ? Math.min(marker, n - 1) : null
  const dot = (arr) => (mk !== null && arr && mk < arr.length && arr[mk] !== null ? { x: x(mk), y: y(arr[mk]) } : null)
  return { w: SPARK_W, h: H, n, lo, hi, a: path(a), b: b ? path(b) : '', baseY: y(lo), markerX: mk === null ? null : x(mk), dotA: dot(a), dotB: dot(b) }
}

export default function Sparkline({ points, obs, height = 28, marker, ariaLabel }) {
  const m = sparkModel({ points, obs, height, marker })
  if (!m) return null
  const label = typeof ariaLabel === 'string' && ariaLabel ? ariaLabel : ''
  return (
    <svg className="spark" viewBox={`0 0 ${m.w} ${m.h}`} preserveAspectRatio="none" width="100%" height={m.h} focusable="false"
         {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' })}>
      <line className="spark-base" x1="0" x2={m.w} y1={m.baseY} y2={m.baseY} vectorEffect="non-scaling-stroke" />
      {m.a && <path className="spark-line spark-a" d={m.a} fill="none" vectorEffect="non-scaling-stroke" />}
      {m.b && <path className="spark-line spark-b" d={m.b} fill="none" vectorEffect="non-scaling-stroke" />}
      {m.markerX !== null && <line className="spark-marker" x1={m.markerX} x2={m.markerX} y1="0" y2={m.h} vectorEffect="non-scaling-stroke" />}
      {m.dotB && <line className="spark-dot spark-b" x1={m.dotB.x} x2={m.dotB.x} y1={m.dotB.y} y2={m.dotB.y} vectorEffect="non-scaling-stroke" />}
      {m.dotA && <line className="spark-dot spark-a" x1={m.dotA.x} x2={m.dotA.x} y1={m.dotA.y} y2={m.dotA.y} vectorEffect="non-scaling-stroke" />}
    </svg>
  )
}
