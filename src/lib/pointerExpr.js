// 觸控筆的壓力與傾斜 → 海的參數（純函式與小型狀態機，不碰瀏覽器 API，可直接用 node 測試：pointerExpr.test.mjs）。
//
// 只對 pointerType === 'pen' 啟用：滑鼠按著時 pressure 固定 0.5、手指 / iOS 觸控的壓力值不可靠，用了會誤動。
//   1) 壓力 → 「浪勁」乘數（Scene3D 拖曳球體時的 spinImpulse / waveMomentum 增量乘以它）
//        壓力 0.5 → 1（與沒有壓力資料的裝置、滑鼠、手指完全相同）；壓越輕越小（下限 forceMin）；壓越重越大（上限 forceMax）。
//        壓力先做指數平滑（筆的原始壓力很毛躁），無壓力資料 / 非筆 → 恆為 1。
//   2) 傾斜 → 洋流方向 flowX / flowY（0..1，0.5 = 靜止）
//        筆「上端」往哪個方向倒，洋流就往哪個方向流（像搖桿：右倒 → 向右流；朝自己倒 → 朝自己流）。
//        tiltX / tiltY（度，-90..90）先去掉死區（筆立著時不動洋流，不會把使用者原本的洋流打回中央）、
//        再換成 -1..1、再映到 0..1；只在「筆尖按在畫布上」時輸出、節流 ≤ 20 次/秒、變化太小不送。
//        沒有 tiltX / tiltY 的環境（例如 Safari 的 Apple Pencil 只給 altitudeAngle / azimuthAngle）改由這兩個角度推回傾斜。

export const PEN_CFG = {
  forceMin: 0.4,        // 壓力趨近 0 時的浪勁乘數
  forceMax: 2.0,        // 壓力 = 1 時的浪勁乘數
  pressureAlpha: 0.35,  // 壓力平滑係數（每個事件向新值靠近的比例；越小越平滑）
  tiltDead: 6,          // 死區（度）：|tilt| ≤ 6° 視為「立著」
  tiltMax: 60,          // 滿刻度（度）：傾斜 ≥ 60° 視為推到底
  flowAlpha: 0.3,       // 洋流目標平滑係數
  flowGapMs: 50,        // 洋流輸出最小間隔 → ≤ 20 次/秒
  flowEps: 0.01,        // 與上次輸出的差小於此值就不送（洋流參數是 0..1）
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const fin = (v) => typeof v === 'number' && Number.isFinite(v)

export const isPen = (e) => !!e && e.pointerType === 'pen'

// ── 壓力 → 浪勁乘數 ──
// 0.5 是錨點：分段線性（0 → forceMin、0.5 → 1、1 → forceMax），所以「不知道壓力」與「壓力 0.5」都給 1。
export function pressureToForce(pressure, cfg = PEN_CFG) {
  if (!fin(pressure) || pressure <= 0) return 1          // 無資料（或筆尚未落下的 0）→ 不改變行為
  const p = Math.min(1, pressure)
  if (p <= 0.5) return cfg.forceMin + (1 - cfg.forceMin) * (p / 0.5)
  return 1 + (cfg.forceMax - 1) * ((p - 0.5) / 0.5)
}

// 有狀態的壓力讀取器：一次追一支筆。down 時以第一筆壓力當起點（第一個 move 不會被舊值拖著走）、up 時歸零。
export function createPenForce(userCfg = {}) {
  const cfg = { ...PEN_CFG, ...userCfg }
  let id = null, p = null
  const reset = () => { id = null; p = null }
  return {
    reset,
    get active() { return id != null },
    get smoothed() { return p },
    down(e) {
      if (!isPen(e)) return false
      id = e.pointerId ?? 0
      p = fin(e.pressure) && e.pressure > 0 ? Math.min(1, e.pressure) : null
      return true
    },
    // 回傳目前的浪勁乘數。非筆 / 不是被追的那支筆 / 沒有壓力 → 1（不動狀態）
    move(e) {
      if (!isPen(e)) return 1
      const pid = e.pointerId ?? 0
      if (id == null) { id = pid; p = null }               // 沒收到 down（例如筆是在球殼上按下、事件先被別處吃掉）：以第一個 move 起頭
      if (pid !== id) return 1
      const raw = e.pressure
      if (!fin(raw) || raw <= 0) return p == null ? 1 : pressureToForce(p, cfg)
      const v = Math.min(1, raw)
      p = p == null ? v : p + (v - p) * cfg.pressureAlpha
      return pressureToForce(p, cfg)
    },
    up(e) { if (!e || (e.pointerId ?? 0) === id) reset() },
  }
}

// ── 傾斜 → 洋流方向 ──
// Pointer Events 的 altitudeAngle（弧度，π/2 = 垂直）+ azimuthAngle（弧度）→ tiltX / tiltY（度）。公式取自規格附錄。
export function tiltFromAltAz(altitudeAngle, azimuthAngle) {
  if (!fin(altitudeAngle) || !fin(azimuthAngle)) return { tiltX: 0, tiltY: 0 }
  const alt = clamp(altitudeAngle, 0.01, Math.PI / 2)
  const tan = Math.tan(alt)
  const rad = 180 / Math.PI
  return { tiltX: Math.atan(Math.cos(azimuthAngle) / tan) * rad, tiltY: Math.atan(Math.sin(azimuthAngle) / tan) * rad }
}

// 讀事件的傾斜（度）。tiltX / tiltY 都是 0 或缺席、卻有 altitudeAngle 時（且明顯不是垂直）→ 由角度推算。
export function readTilt(e) {
  if (!e) return { tiltX: 0, tiltY: 0 }
  const tx = fin(e.tiltX) ? e.tiltX : 0, ty = fin(e.tiltY) ? e.tiltY : 0
  if ((tx !== 0 || ty !== 0)) return { tiltX: tx, tiltY: ty }
  if (fin(e.altitudeAngle) && fin(e.azimuthAngle) && e.altitudeAngle < Math.PI / 2 - 0.05) return tiltFromAltAz(e.altitudeAngle, e.azimuthAngle)
  return { tiltX: 0, tiltY: 0 }
}

// 角度（度）→ -1..1：去死區、線性到滿刻度、保留正負號
export function tiltToUnit(deg, cfg = PEN_CFG) {
  if (!fin(deg)) return 0
  const a = Math.abs(deg)
  if (a <= cfg.tiltDead) return 0
  return Math.sign(deg) * Math.min(1, (a - cfg.tiltDead) / Math.max(1e-6, cfg.tiltMax - cfg.tiltDead))
}

// 傾斜（度）→ 洋流參數 { x: flowX, y: flowY }（0..1）；兩軸都在死區內 → null（不動洋流）。
// tiltX > 0 = 筆上端向右倒 → flowX > 0.5；tiltY > 0 = 筆上端朝使用者倒 → flowY > 0.5（洋流朝向使用者，與畫面 +z 一致）。
export function tiltToFlow(tiltX, tiltY, cfg = PEN_CFG) {
  const ux = tiltToUnit(tiltX, cfg), uy = tiltToUnit(tiltY, cfg)
  if (ux === 0 && uy === 0) return null
  return { x: 0.5 + 0.5 * ux, y: 0.5 + 0.5 * uy }
}

// 有狀態的洋流輸出器：只在「筆按在畫布上」（down 之後、up 之前，且 buttons 的筆尖位元為 1）輸出。
//   move(e, nowMs) → null | { flowX, flowY }（呼叫端拿去 store.input）
export function createPenFlow(userCfg = {}) {
  const cfg = { ...PEN_CFG, ...userCfg }
  let id = null, sx = null, sy = null, lx = null, ly = null, lastAt = -Infinity
  const reset = () => { id = null; sx = sy = lx = ly = null; lastAt = -Infinity }
  return {
    reset,
    get active() { return id != null },
    down(e) {
      if (!isPen(e)) return false
      reset(); id = e.pointerId ?? 0
      return true
    },
    move(e, nowMs) {
      if (id == null || !isPen(e) || (e.pointerId ?? 0) !== id) return null
      if (typeof e.buttons === 'number' && (e.buttons & 1) === 0) { reset(); return null }   // 筆尖已離開畫面（up 事件掉了）
      const { tiltX, tiltY } = readTilt(e)
      const target = tiltToFlow(tiltX, tiltY, cfg)
      if (!target) { sx = sy = null; return null }                                            // 立著：不動洋流；下次傾斜重新起頭，不被舊值拖著走
      sx = sx == null ? target.x : sx + (target.x - sx) * cfg.flowAlpha
      sy = sy == null ? target.y : sy + (target.y - sy) * cfg.flowAlpha
      if (nowMs - lastAt < cfg.flowGapMs) return null                                         // 節流 ≤ 1000/flowGapMs 次/秒
      if (lx != null && Math.abs(sx - lx) < cfg.flowEps && Math.abs(sy - ly) < cfg.flowEps) return null
      lastAt = nowMs; lx = sx; ly = sy
      return { flowX: clamp(sx, 0, 1), flowY: clamp(sy, 0, 1) }
    },
    up(e) { if (!e || (e.pointerId ?? 0) === id) reset() },
  }
}
