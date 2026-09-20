// 視角自動取景（純函式，沒有 three / DOM 依賴，可直接用 node 測）。
//
// 為什麼需要：相機垂直視角固定（fov 45°），水平可視範圍 = 垂直 × 畫布長寬比。
// 手機直式全螢幕（例如 375x812，長寬比約 0.46）時水平只剩約 ±1.26 個單位，半徑 2.02 的球被左右切掉。
// 解法：長寬比比「球剛好貼滿」還窄時，把相機沿原本的視線方向拉遠（只拉遠、不拉近），
// 讓球的角半徑 asin(radius / d) 不超過「較窄那個方向」的半視角。寬螢幕（桌面 / 橫式）倍率恆為 1，畫面與改版前完全一致。
//
// 兩種取景模式（偏好與網址解析在 lib/viewPrefs.js）：
//   'full'（預設）：以含輝光的視覺半徑 FIT_RADIUS = 2.42 取景，整顆球連光暈都在畫面內。
//   'fill'：以球殼半徑 FILL_RADIUS = 2.02 取景，球殼剛好填滿較窄的那一邊（光暈自然被畫面邊緣裁掉一部分）——直式手機的球更大。
//           只影響「需要拉遠」的窄畫布：長寬比 >= 0.95 兩種模式都是 1；fill 的倍率恆 <= full（相機更近，霧 / 星殼 / far plane 的餘裕只多不少）。

export const FIT_FOV = 45          // 與 <Canvas camera fov> 一致
export const FIT_RADIUS = 2.42     // 球體「視覺半徑」：球殼 2.02 + 輝光 / 溢流水花外緣
export const FIT_BASE_DIST = 6.6   // zoom 0.5 的既有相機距離 4.6 + (1 - 0.5) * 4
export const FIT_MAX = 6           // 倍率上限（極端窄的畫布不要把相機飛到天邊）
export const FILL_RADIUS = 2.02    // 'fill' 取景的半徑 = 球殼半徑（Scene3D 的 SHELL）
export const FIT_MODES = ['full', 'fill']
export const DEFAULT_FIT_MODE = 'full'
const MIN_ASPECT = 0.02            // fitDist 內部的長寬比下限（避免 tan * 0 → 距離無限大）

const DEG = Math.PI / 180

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
// 有效的長寬比：有限、> 0 的數字（0 / NaN / 負值 / Infinity / 非數字 = 無效，代表「畫布還沒量到」）
export function validAspect(a) { return isNum(a) && a > 0 }
const okFov = (f) => (isNum(f) && f > 0 && f < 180 ? f : FIT_FOV)
const posOr = (v, d) => (isNum(v) && v > 0 ? v : d)
// 取景模式：只有 'fill' 是填滿，其餘（缺省 / 亂給）都當 'full'
export function fitMode(m) { return m === 'fill' ? 'fill' : 'full' }
export function modeRadius(mode) { return fitMode(mode) === 'fill' ? FILL_RADIUS : FIT_RADIUS }

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
// mode：'full'（預設；半徑 2.42，與加入 mode 之前逐位元相同）| 'fill'（半徑 2.02）；明確給 radius 時以 radius 為準。
export function fitScale({ aspect, fovDeg = FIT_FOV, radius, baseDist = FIT_BASE_DIST, margin = 1.0, maxFit = FIT_MAX, mode } = {}) {
  if (!validAspect(aspect)) return 1
  const k = fitDist({ aspect, fovDeg, radius: posOr(radius, modeRadius(mode)), margin }) / posOr(baseDist, FIT_BASE_DIST)
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
// - 之後：以 lerp（每幀 0.06，與改版前相同）逼近目標；畫布尺寸（視窗 / 方向 / 分隔線 / 面板）或取景模式變了才重算 fit，不是每幀
//   （模式切換 = 目標倍率變了，相機沿用同一個 lerp 平滑移過去，不跳）
// - 尚未量到尺寸（0 / NaN）→ 回傳 null 不動作，等量到再就位
// - enabled: false（?fit=0）→ fit 恆為 1（不管模式）
// - mode：建立時給預設，step 的參數可逐幀覆寫（'full' | 'fill'；缺省 = 'full'）
// 回傳 { fit：目前目標倍率, shown：跟著相機平滑的倍率（給霧等依距離的效果用）, target }
export function createCameraRig({ enabled = true, lerp = 0.06, mode: mode0 } = {}) {
  let init = false, w = -1, h = -1, m = '', fit = 1, shown = 1
  return {
    step(pos, { width, height, zoom, fovDeg, mode } = {}) {
      const asp = aspectOf(width, height), md = fitMode(mode !== undefined ? mode : mode0)
      if (width !== w || height !== h || md !== m) { w = width; h = height; m = md; fit = enabled ? fitScale({ aspect: asp, fovDeg, mode: md }) : 1 }
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

// 測站星座（河川流量測站，台灣外形；縮放後 x 約 ±1.36、y 約 ±2.7）的位置與縮放。
// halfW / halfH：星座所在深度平面的半可視範圍；sphereR：球體在該平面的投影半徑；aspect：畫布長寬比。
// 長寬比 >= 0.95（桌面 / 橫式 / 平板橫式）：與改版前完全相同（排在球的右側，依可視範圍夾取）。
// 長寬比 <= 0.8（手機直式 / 平板直式）：球右側放不下 → 改放到球的上方（水平置中，空間不夠時縮小），
// 不會被夾到球後面看不見；中間用 smoothstep 連續過渡（拖曳分隔線改變畫布大小時不會跳）。
// 選用參數（只影響直式 / 過渡帶；沒給 = 改版前的對稱近似，既有行為與測試不變）：
//   yc   ：畫面中心（球心）在該平面上的世界 y。相機微微俯視，遠處的平面上畫面中心不在 y = 0（約 -0.64）。
//   yTop ：星座上緣允許的最高世界 y（由 planeYAtRow 以精確透視算出的「資料 HUD 條之下」那一列）。給了就取代「上緣留白」。
const lerp = (a, b, t) => a + (b - a) * t
export function stationLayout({ halfW, halfH, sphereR, aspect, extX = 1.36, extY = 2.7, yc = 0, yTop }) {
  const bx = Math.max(2.4, Math.min(halfW - 1.5, sphereR + 1.4))   // 既有公式（球右側）
  const by = -0.3
  const w = validAspect(aspect) ? smooth((0.95 - aspect) / 0.15) : 0
  if (w <= 0) return { x: bx, y: by, s: 1 }
  const top = isNum(yTop) ? yTop : halfH - Math.max(0.6, halfH * 0.13)   // 星座上緣（世界 y）：預設在可視範圍頂端下留白（HUD 條在最上面）
  const room = top - yc - sphereR * 0.9                                   // 球頂（允許重疊 10%）到上緣的空間
  const s = Math.min(1, Math.max(0.55, room / (2 * extY)), Math.max(0.3, (halfW - 0.3) / extX))
  const sy = top - extY * s
  return { x: lerp(bx, 0, w), y: lerp(by, sy, w), s: lerp(1, s, w) }
}

// 平面 z = planeZ 上、螢幕第 row 列（從畫布頂端往下算，px）對應的世界 y（精確透視，看向原點的相機）。
// 為什麼不用「±halfH 對稱」近似：相機在 (0, camY, camZ) 微微俯視，遠處的平面在畫面上會偏高（畫面中心落在 y = camY * planeZ / camZ，約 -0.64，
// 而不是 0；上下緣也不對稱），直式手機上差約 25 ~ 35px，剛好讓星座蓋到頂端的資料 HUD。輸入無效 → NaN。
// 推導：相機前向 F = (0, -sinθ, -cosθ)、上向 U = (0, cosθ, -sinθ)（tanθ = camY / camZ）；平面上 (x, y, planeZ) 的螢幕 NDC y = (U·D) / (T · F·D)，
// D = P - C、T = tan(fov / 2)；反解 y = camY + L * (nT - tanθ) / (1 + nT * tanθ)，L = camZ - planeZ，n = 1 - 2 * row / height。
export function planeYAtRow({ camY, camZ, planeZ, fovDeg = FIT_FOV, height, row } = {}) {
  if (!isNum(camY) || !isNum(camZ) || camZ <= 0 || !isNum(planeZ) || !isNum(height) || height <= 0 || !isNum(row)) return NaN
  const T = Math.tan((okFov(fovDeg) / 2) * DEG), t = camY / camZ, n = 1 - (2 * row) / height
  return camY + ((camZ - planeZ) * (n * T - t)) / (1 + n * T * t)
}

export const STATION_Z = -10.5        // 測站星座所在的深度平面（與 Scene3D 的 STN_Z 相同）
export const STATION_HUD_PX = 72      // 直式時星座最高點與畫布頂端的最小距離（px）：資料 HUD 條約佔 0 ~ 64px，再留 8px（星點本身半徑約 4px）

// 測站星座的最終版位（StationStars 每幀呼叫；測試用同一個函式 → 畫出來與驗證的是同一份）。
// 輸入是相機位置（x = 0、看向原點）、畫布尺寸（px）與相機 fov；輸出 { x, y, s }（群組在 z = planeZ 的位置與縮放）。
// 寬螢幕（長寬比 >= 0.95）與改版前逐位元相同；直式 / 過渡帶：上緣至少在畫布頂端下 hudPx（也不高於原本的 13% 留白），並用精確透視。
// 點選拾取（Scene3D 的 registerPickSource('station')）讀的是這個位置設定後的群組矩陣 → 與畫出來的一致（單一來源）。
export function stationPlacement({ camY, camZ, planeZ = STATION_Z, fovDeg = FIT_FOV, width: w, height: hpx, hudPx = STATION_HUD_PX }) {
  const width = isNum(w) ? w : 0, height = isNum(hpx) ? hpx : 0        // 畫布還沒量到（0 / NaN / 缺省）→ 當 0（與舊行為相同：長寬比 0 = 寬螢幕版位）
  const dist = Math.max(4, camZ - planeZ)
  const halfH = Math.tan((okFov(fovDeg) / 2) * DEG) * dist
  const aspect = width / Math.max(1, height)
  const halfW = halfH * aspect
  const sphereR = 2.02 * (dist / Math.max(3, camZ))                  // 球體在此深度平面的投影半徑：星座要排在球體右側之外才看得出台灣輪廓
  let yc = 0, yTop
  if (isNum(camY) && isNum(height) && height > 0) {
    const args = { camY, camZ, planeZ, fovDeg, height }
    const c = planeYAtRow({ ...args, row: height / 2 })
    const row = Math.min(height * 0.25, Math.max(posOr(hudPx, STATION_HUD_PX), height * 0.065))   // HUD 之下；很高的畫布退回原本的 13% 留白（0.065 * 高度）
    const tp = planeYAtRow({ ...args, row })
    if (isNum(c) && isNum(tp)) { yc = c; yTop = tp }
  }
  return stationLayout({ halfW, halfH, sphereR, aspect, yc, yTop })
}
