// 視角自動取景（純函式，沒有 three / DOM 依賴，可直接用 node 測）。
//
// 為什麼需要：相機垂直視角固定（fov 45°），水平可視範圍 = 垂直 × 畫布長寬比。
// 手機直式全螢幕（例如 375x812，長寬比約 0.46）時水平只剩約 ±1.26 個單位，半徑 2.02 的球被左右切掉。
// 解法：長寬比比「球剛好貼滿」還窄時，把相機沿原本的視線方向拉遠（只拉遠、不拉近），
// 讓球的角半徑 asin(radius / d) 不超過「較窄那個方向」的半視角。寬螢幕（桌面 / 橫式）倍率恆為 1，畫面與改版前完全一致。

export const FIT_FOV = 45          // 與 <Canvas camera fov> 一致
export const FIT_RADIUS = 2.42     // 球體「視覺半徑」：球殼 2.02 + 輝光 / 溢流水花外緣
export const FIT_BASE_DIST = 6.6   // zoom 0.5 的既有相機距離 4.6 + (1 - 0.5) * 4
export const FIT_MAX = 6           // 倍率上限（極端窄的畫布不要把相機飛到天邊）
const MIN_ASPECT = 0.02            // fitDist 內部的長寬比下限（避免 tan * 0 → 距離無限大）

const DEG = Math.PI / 180

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
// 有效的長寬比：有限、> 0 的數字（0 / NaN / 負值 / Infinity / 非數字 = 無效，代表「畫布還沒量到」）
export function validAspect(a) { return isNum(a) && a > 0 }
const okFov = (f) => (isNum(f) && f > 0 && f < 180 ? f : FIT_FOV)
const posOr = (v, d) => (isNum(v) && v > 0 ? v : d)

// 半視角（弧度）：v = 垂直、h = 水平
export function halfAngles(aspect, fovDeg = FIT_FOV) {
  const a = Math.max(validAspect(aspect) ? aspect : 1, MIN_ASPECT)
  const v = (okFov(fovDeg) * DEG) / 2
  return { v, h: Math.atan(Math.tan(v) * a) }
}

// 讓半徑 radius * margin 的球完整落在視野內所需的最小相機距離（相機到球心）。
// margin >= 1 是「多留的空間」倍數（1.1 = 半徑多算 10%）。aspect 無效 → 當作 1（正方形）。
export function fitDist({ aspect, fovDeg = FIT_FOV, radius = FIT_RADIUS, margin = 1.0 } = {}) {
  const { v, h } = halfAngles(aspect, fovDeg)
  return (posOr(radius, FIT_RADIUS) * posOr(margin, 1)) / Math.sin(Math.min(v, h))
}

// 相機距離倍率：>= 1，只放大距離、不縮小（fitDist <= baseDist 時恆為 1）。aspect 無效 → 1（不調整）。
export function fitScale({ aspect, fovDeg = FIT_FOV, radius = FIT_RADIUS, baseDist = FIT_BASE_DIST, margin = 1.0, maxFit = FIT_MAX } = {}) {
  if (!validAspect(aspect)) return 1
  const k = fitDist({ aspect, fovDeg, radius, margin }) / posOr(baseDist, FIT_BASE_DIST)
  return Math.min(Math.max(1, k), Math.max(1, posOr(maxFit, FIT_MAX)))
}

// 畫布尺寸 → 長寬比（任一邊 <= 0 / 非數字 → NaN，交給 fitScale 當「無效」處理）
export function aspectOf(width, height) {
  return isNum(width) && isNum(height) && width > 0 && height > 0 ? width / height : NaN
}

// 相機目標位置（CameraRig 與測試共用同一個公式）：
// z = 既有的 zoom 公式 * fit；y 也等比放大 → 純粹「沿同一條視線後退」，構圖（含俯角）與 fit = 1 完全相同。
// zoom 不是有限數字 → 0.5（既有預設）。
export function rigTarget(zoom, fit = 1) {
  const z = isNum(zoom) ? zoom : 0.5
  const f = isNum(fit) && fit >= 1 ? fit : 1
  return { x: 0, y: 0.4 * f, z: (4.6 + (1 - z) * 4) * f }
}

// 相機狀態機（CameraRig 每幀呼叫 step；不依賴 three / DOM，pos 只要有 x / y / z 屬性，例如 THREE.Vector3）。
// - 第一次有效尺寸的那一幀：直接就位（不從 Canvas 預設的 z = 7 慢慢滑進來，直式手機一開始球不會被切掉）
// - 之後：以 lerp（每幀 0.06，與改版前相同）逼近目標；畫布尺寸（視窗 / 方向 / 分隔線 / 面板）變了才重算 fit，不是每幀
// - 尚未量到尺寸（0 / NaN）→ 回傳 null 不動作，等量到再就位
// - enabled: false（?fit=0）→ fit 恆為 1
// 回傳 { fit：目前目標倍率, shown：跟著相機平滑的倍率（給霧等依距離的效果用）, target }
export function createCameraRig({ enabled = true, lerp = 0.06 } = {}) {
  let init = false, w = -1, h = -1, fit = 1, shown = 1
  return {
    step(pos, { width, height, zoom, fovDeg } = {}) {
      const asp = aspectOf(width, height)
      if (width !== w || height !== h) { w = width; h = height; fit = enabled ? fitScale({ aspect: asp, fovDeg }) : 1 }
      if (!init && !validAspect(asp)) return null
      const g = rigTarget(zoom, fit)
      if (!init) { init = true; pos.x = g.x; pos.y = g.y; pos.z = g.z; shown = fit }
      else { pos.x += (g.x - pos.x) * lerp; pos.y += (g.y - pos.y) * lerp; pos.z += (g.z - pos.z) * lerp; shown += (fit - shown) * lerp }
      return { fit, shown, target: g }
    },
  }
}

// ?fit=0 / false / off / no（不分大小寫）= 關閉自動取景（除錯用）；沒有這個參數或其他值 = 開。
export function fitEnabled(search) {
  try {
    const v = new URLSearchParams(search || '').get('fit')
    return v === null || !/^(0|false|off|no)$/i.test(v)
  } catch (e) { return true }
}

// 背景星殼縮放：星殼（內半徑 innerR 的球殼）要一直在相機「外面」，否則相機拉遠後會有星點貼在鏡頭前變成一大團光。
// 保持「星殼內緣到相機」至少 gap（桌面最遠 zoom 0 時相機在 hypot(8.6, 0.4) = 8.61，星殼內緣 12 → 差 3.39，所以 gap = 3.3，桌面倍率恆為 1）。
export function shellScale(camDist, innerR, gap = 3.3) {
  if (!isNum(camDist) || !isNum(innerR) || innerR <= 0) return 1
  return Math.max(1, (camDist + gap) / innerR)
}

const smooth = (t) => { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c) }
const lerp = (a, b, t) => a + (b - a) * t

// 測站星座（河川流量測站，台灣外形；縮放後 x 約 ±1.36、y 約 ±2.7）的位置與縮放。
// halfW / halfH：星座所在深度平面的半可視範圍；sphereR：球體在該平面的投影半徑；aspect：畫布長寬比。
// 長寬比 >= 0.95（桌面 / 橫式 / 平板橫式）：與改版前完全相同（排在球的右側，依可視範圍夾取）。
// 長寬比 <= 0.8（手機直式 / 平板直式）：球右側放不下 → 改放到球的上方（水平置中，空間不夠時縮小），
// 不會被夾到球後面看不見；中間用 smoothstep 連續過渡（拖曳分隔線改變畫布大小時不會跳）。
export function stationLayout({ halfW, halfH, sphereR, aspect, extX = 1.36, extY = 2.7 }) {
  const bx = Math.max(2.4, Math.min(halfW - 1.5, sphereR + 1.4))   // 既有公式（球右側）
  const by = -0.3
  const w = validAspect(aspect) ? smooth((0.95 - aspect) / 0.15) : 0
  if (w <= 0) return { x: bx, y: by, s: 1 }
  const margin = Math.max(0.6, halfH * 0.13)                        // 上緣留白（HUD 條在最上面）
  const room = halfH - margin - sphereR * 0.9                       // 球頂（允許重疊 10%）到上緣的空間
  const s = Math.min(1, Math.max(0.55, room / (2 * extY)), Math.max(0.3, (halfW - 0.3) / extX))
  const sy = halfH - margin - extY * s
  return { x: lerp(bx, 0, w), y: lerp(by, sy, w), s: lerp(1, s, w) }
}
