// WebXR「桌面放置」（immersive-ar）的純邏輯：特徵偵測、放置數學、hit-test 追蹤、工作階段狀態機。
// 這個檔案不 import three / react / DOM：瀏覽器 API（navigator.xr、session、計時器、時鐘）全部可注入，node 用假物件就能測（見 xr.test.mjs）。
// 對接 three / R3F 的部分在 scene/XrRuntime.jsx（只在 XR 工作階段存在時才動態載入），畫面在 ui/XrOverlay.jsx。
//
// 狀態機：
//   idle ──start()──▶ requesting ──ready()──▶ placing ──place()──▶ placed
//                          │                     ▲                    │
//                          │                     └────replace()───────┘
//   requesting / placing / placed ──exit() / session 'end' / fail()──▶ ended ──start()──▶ requesting …
//   ended 帶 reason：'user'（使用者退出）/ 'system'（系統或瀏覽器中斷）/ 'error'（error = { code, detail }）。
// 不存文字：錯誤只記 code，畫面顯示時才 t()，這樣切語系會跟著換。

export const XR_PLACE = {
  radiusM: 0.14,          // 放置後球體半徑（公尺）：直徑 28 cm
  hoverM: 0.02,           // 球殼底離桌面的空隙（公尺）
  hitMinUp: 0.75,         // 命中面的法線 y 分量 ≥ 這個值才算水平面（約 41° 以內）；牆面 / 天花板不放
  lostFrames: 12,         // 連續這麼多幀沒有 hit-test 結果 → 視為「找不到平面」（避免準星閃爍）
  guardMs: 500,           // 進入放置狀態後這段時間內忽略點擊（重新放置的那一下不能同時被當成「放置」）
  readyTimeoutMs: 12000,  // 拿到 session 之後這麼久還沒接上渲染 → 逾時退場
  detectTimeoutMs: 4000,  // isSessionSupported 沒有回應 → 當作不支援
  near: 0.01, far: 20,    // 桌面尺度的近 / 遠裁切面（預設 near 0.1 會在手機靠近球時切掉）
}

const ACTIVE = new Set(['requesting', 'placing', 'placed'])
export const isActiveStatus = (s) => ACTIVE.has(s)

// ---- 特徵偵測 ----
// 同步預檢：沒有 navigator.xr（iOS Safari…）就完全不必載入任何 XR 程式碼
export function xrMaybeSupported(nav = globalThis.navigator) {
  try { return !!nav && 'xr' in nav && !!nav.xr && typeof nav.xr.isSessionSupported === 'function' } catch (e) { return false }
}

// 非同步確認：isSessionSupported('immersive-ar') 為 true 才算支援；丟例外 / 逾時 / 回傳非 true 一律當不支援
export async function detectXrAr(nav = globalThis.navigator, opts = {}) {
  if (!xrMaybeSupported(nav)) return false
  const setTo = opts.setTimeout || ((fn, ms) => globalThis.setTimeout(fn, ms))
  const clrTo = opts.clearTimeout || ((id) => globalThis.clearTimeout(id))
  let timer = null
  try {
    const timeout = new Promise((resolve) => { timer = setTo(() => resolve(false), opts.timeoutMs ?? XR_PLACE.detectTimeoutMs) })
    const asked = Promise.resolve().then(() => nav.xr.isSessionSupported('immersive-ar')).then((v) => v === true, () => false)
    return await Promise.race([asked, timeout])
  } catch (e) {
    return false
  } finally {
    if (timer != null) clrTo(timer)
  }
}

let supportP = null
export function isXrArSupported() { if (!supportP) supportP = detectXrAr(); return supportP }   // 整頁只問一次

// ---- requestSession 參數 / 錯誤分類 / 參考空間 ----
export function buildSessionInit(root) {
  const init = { requiredFeatures: ['hit-test'], optionalFeatures: ['dom-overlay', 'local-floor'] }
  if (root) init.domOverlay = { root }
  return init
}

// 例外 → { code, detail }。code：permission 權限被拒 / unsupported 裝置不支援（例如沒有 hit-test）/ insecure 非 HTTPS / busy 已有 AR 或相機占用 / unknown
export function classifyXrError(e) {
  const name = e && e.name
  const code = name === 'NotAllowedError' ? 'permission' : name === 'NotSupportedError' ? 'unsupported' : name === 'SecurityError' ? 'insecure' : name === 'InvalidStateError' ? 'busy' : 'unknown'
  const detail = e && e.message ? String(e.message).slice(0, 120) : ''
  return { code, detail }
}

// session 有啟用 local-floor 才用它，否則用一定有的 local（放置用的是 hit-test 的姿態，兩種空間都可以）
export function pickReferenceSpaceType(session) {
  const f = session && session.enabledFeatures
  return Array.isArray(f) && f.includes('local-floor') ? 'local-floor' : 'local'
}

// ---- 放置數學（座標：WebXR 參考空間，右手、+Y 向上；矩陣為 column-major 16 個數）----
export const xrScaleFor = (radiusM, shell) => (shell > 0 && radiusM > 0 ? radiusM / shell : 1)

// 命中面的法線（矩陣的 Y 軸 = elements 4,5,6）朝上 → 水平面（桌面 / 地板）
export function isHorizontalHit(m, minUp = XR_PLACE.hitMinUp) {
  if (!m || m.length < 16) return false
  const len = Math.hypot(m[4], m[5], m[6])
  return len > 1e-6 && Number.isFinite(len) && m[5] / len >= minUp
}

// 球的 +Z 面向觀看者：yaw = 繞 Y 軸的旋轉角（object.rotation.y）。觀看者幾乎在正上方時方向不明 → 0
export function facingYaw(px, pz, vx, vz) {
  const dx = vx - px, dz = vz - pz
  return Math.hypot(dx, dz) < 0.02 ? 0 : Math.atan2(dx, dz)
}

// 命中姿態 → 世界根 group 的擺放：球殼底離桌面 hoverM，球心在命中點正上方（永遠鉛直，不跟著命中面的傾斜）。
// hit：命中矩陣（16 個數）；viewer：觀看者位置 [x,y,z]（可省略）；shell：球殼半徑（Scene3D 的 SHELL）。無效輸入 → null。
export function computePlacement(hit, viewer, shell, opts = {}) {
  const radiusM = opts.radiusM ?? XR_PLACE.radiusM, hoverM = opts.hoverM ?? XR_PLACE.hoverM
  if (!hit || hit.length < 16) return null
  const px = hit[12], py = hit[13], pz = hit[14]
  if (![px, py, pz].every(Number.isFinite)) return null
  if (!isHorizontalHit(hit, opts.minUp ?? XR_PLACE.hitMinUp)) return null
  const scale = xrScaleFor(radiusM, shell)
  const cy = py + hoverM + shell * scale             // = py + hoverM + radiusM
  const v = viewer && viewer.length >= 3 && Number.isFinite(viewer[0]) && Number.isFinite(viewer[2]) ? viewer : null
  return {
    position: [px, cy, pz],
    yaw: v ? facingYaw(px, pz, v[0], v[2]) : 0,
    scale, radiusM,
    hit: Array.from(hit).slice(0, 16),              // 準星 / 底環用
  }
}

// ---- hit-test 追蹤：命中立刻算「找到」，連續 lostFrames 幀沒命中才算「遺失」 ----
export function createHitTracker(lostFrames = XR_PLACE.lostFrames) {
  let found = false, miss = 0
  return {
    update(ok) {
      const before = found
      if (ok) { miss = 0; found = true } else { miss++; if (miss >= lostFrames) found = false }
      return { found, changed: found !== before }
    },
    get found() { return found },
    reset() { found = false; miss = 0 },
  }
}

// ---- 給畫面用的純函式（回傳 code，不回傳文字）----
// 疊加層上方的提示：starting 啟動中 / find 找平面（含追蹤遺失）/ tap 可以點擊放置 / null 不必提示
export function overlayHint(s) {
  if (!s) return null
  if (s.status === 'requesting') return 'starting'
  if (s.status === 'placing') return !s.tracking || !s.hit ? 'find' : 'tap'
  if (s.status === 'placed') return s.tracking ? null : 'find'
  return null
}

// 結束之後「裝置」面板要顯示的說明：{ code, detail }（exited / interrupted / 錯誤 code），沒有結束 → null
export function endNotice(s) {
  if (!s || s.status !== 'ended') return null
  if (s.reason === 'user') return { code: 'exited', detail: '' }
  if (s.reason === 'system') return { code: 'interrupted', detail: '' }
  return { code: (s.error && s.error.code) || 'unknown', detail: (s.error && s.error.detail) || '' }
}

// ---- 工作階段控制器（狀態機）----
// env 可注入：nav()（回傳 navigator）、now()、setTimeout / clearTimeout。
const safeEnd = (session) => { try { return Promise.resolve(session.end()).catch(() => {}) } catch (e) { return Promise.resolve() } }

export function createXrController(env = {}) {
  const getNav = env.nav || (() => globalThis.navigator)
  const now = env.now || (() => Date.now())
  const setTo = env.setTimeout || ((fn, ms) => globalThis.setTimeout(fn, ms))
  const clrTo = env.clearTimeout || ((id) => globalThis.clearTimeout(id))
  const guardMs = env.guardMs ?? XR_PLACE.guardMs
  const readyTimeoutMs = env.readyTimeoutMs ?? XR_PLACE.readyTimeoutMs

  // XR 進出時廣播一個全域事件（{ active }）：不相依的模組（例如自動畫質）可以據此暫停——immersive session 期間 window 的
  // requestAnimationFrame 會停，結束後第一個超大 dt 會被誤判成效能不足而降畫質。沒有 window（node）時什麼都不做。
  const announce = env.announce || ((active) => {
    const g = globalThis
    if (g && typeof g.dispatchEvent === 'function' && typeof g.CustomEvent === 'function') g.dispatchEvent(new g.CustomEvent('midisea:xr', { detail: { active } }))
  })
  const initial = () => ({ status: 'idle', session: null, error: null, reason: null, tracking: false, hit: false, placement: null })
  let state = initial()
  const subs = new Set()
  let session = null, onEnd = null, seq = 0, endRequested = false, guardUntil = 0, readyTimer = null

  const set = (patch) => {
    const was = isActiveStatus(state.status)
    state = { ...state, ...patch }
    const is = isActiveStatus(state.status)
    if (was !== is) { try { announce(is) } catch (e) { /* 廣播失敗不能拖垮狀態機 */ } }
    for (const f of [...subs]) { try { f(state) } catch (e) { /* 訂閱者的錯誤不能拖垮狀態機 */ } }
  }
  const clearReady = () => { if (readyTimer != null) { clrTo(readyTimer); readyTimer = null } }
  const detach = () => { if (session && onEnd) { try { session.removeEventListener('end', onEnd) } catch (e) { /* ignore */ } } onEnd = null }

  // 收尾（冪等）：回到 ended、清掉所有暫存。error 退場時主動結束 session（若還沒結束）
  function finish(reason, error) {
    if (!isActiveStatus(state.status)) return false
    clearReady()
    const s = session
    detach(); session = null
    set({ status: 'ended', session: null, reason, error: error || null, tracking: false, hit: false, placement: null })
    if (s && reason === 'error') safeEnd(s)
    return true
  }

  function fail(code, detail) { return finish('error', { code, detail: detail ? String(detail).slice(0, 120) : '' }) }

  // 必須在使用者手勢（點擊）裡呼叫：requestSession 會在第一個 await 之前同步發出。
  async function start(opts = {}) {
    if (isActiveStatus(state.status)) return false                 // 重複進入：忽略
    const nav = getNav()
    const xr = nav && nav.xr
    const my = ++seq
    endRequested = false
    clearReady()
    if (!xr || typeof xr.requestSession !== 'function') {
      set({ ...initial(), status: 'ended', reason: 'error', error: { code: 'unsupported', detail: '' } })
      return false
    }
    set({ ...initial(), status: 'requesting' })
    let s
    try {
      s = await xr.requestSession('immersive-ar', buildSessionInit(opts.root))
    } catch (e) {
      if (my === seq && state.status === 'requesting') finish('error', classifyXrError(e))
      return false
    }
    if (my !== seq || state.status !== 'requesting') { safeEnd(s); return false }   // 等待期間已被取消 / 換了一輪：晚到的 session 立刻結束
    session = s
    onEnd = () => finish(endRequested ? 'user' : 'system')
    try { s.addEventListener('end', onEnd) } catch (e) { fail('unknown', 'listener'); return false }
    readyTimer = setTo(() => { readyTimer = null; if (state.status === 'requesting') fail('timeout') }, readyTimeoutMs)
    set({ session: s })
    return true
  }

  // 渲染已接上 session、hit-test 來源就緒 → 進入放置
  function ready() {
    if (state.status !== 'requesting' || !session) return false
    clearReady()
    guardUntil = now() + guardMs
    set({ status: 'placing' })
    return true
  }

  function setHit(found) {
    if (state.status !== 'placing' || state.hit === !!found) return false
    set({ hit: !!found })
    return true
  }
  function setTracking(ok) {
    if ((state.status !== 'placing' && state.status !== 'placed') || state.tracking === !!ok) return false
    set({ tracking: !!ok })
    return true
  }

  // 使用者點一下：把球放在目前準星的位置。太快（剛進入放置）/ 沒有命中 / 非水平面 → 忽略
  function place(hit, viewer, shell) {
    if (state.status !== 'placing' || !state.hit) return false
    if (now() < guardUntil) return false
    const pl = computePlacement(hit, viewer, shell)
    if (!pl) return false
    set({ status: 'placed', placement: pl })
    return true
  }

  function replace() {
    if (state.status !== 'placed') return false
    guardUntil = now() + guardMs
    set({ status: 'placing', placement: null })
    return true
  }

  // 使用者要求退出。session 結束的 'end' 事件（或 end() 的 promise）會走到 finish('user')；兩條路徑都冪等
  function exit() {
    if (!isActiveStatus(state.status)) return false
    endRequested = true
    const s = session
    if (!s) return finish('user')                                   // 還在等 session：直接取消，晚到的 session 會被結束
    let timer = null
    const done = () => { if (timer != null) { clrTo(timer); timer = null } finish('user') }
    timer = setTo(done, 2500)                                       // 保險：end() 沒有回應也要退場，畫面不能卡在 AR
    safeEnd(s).then(done, done)
    return true
  }

  function dismiss() { if (state.status === 'ended') set({ ...initial() }) }   // 說明看過了 → 回到 idle

  return {
    getState: () => state,
    subscribe: (fn) => { subs.add(fn); return () => { subs.delete(fn) } },
    isActive: () => isActiveStatus(state.status),
    start, ready, setHit, setTracking, place, replace, exit, fail, dismiss,
  }
}

let controller = null
export function getXrController() { return controller || (controller = createXrController()) }
