// 依事件設計的觸覺回饋：每種事件有自己的「觸感節奏」。
//   手機：navigator.vibrate 模式陣列 [on, off, on…]（馬達只能控制長短，無法控制強弱）
//   手把：Gamepad vibrationActuator.playEffect('dual-rumble')（weak = 高頻輕震、strong = 低頻重震，magnitude 0..1）
// 純邏輯 + 可注入的裝置介面（vibrateFn / getGamepads / now / setTimeoutFn…），node 可直接測；
// 瀏覽器端的預設環境由 browserEnv() 提供（getHaptics() 首次呼叫時才建立單例，不在 import 時碰任何 API）。
// iOS Safari 沒有 navigator.vibrate：偵測不到就靜默略過（不丟錯、不提示），仍可用手把。
import { loadLS, saveLS } from './persist.js'

export const HAPTICS_LS_KEY = 'ixd2026.haptics'   // { enabled?: boolean, level?: 'weak'|'medium'|'strong' }（只存使用者明確設過的欄位）

export const LEVELS = ['weak', 'medium', 'strong']
export const LEVEL_SCALE = { weak: 0.6, medium: 1, strong: 1.5 }

// 硬體與節流上限（單位 ms，除特別註明）
export const LIMITS = {
  minOn: 6, maxOn: 1200, maxPatternMs: 2400,   // 手機：單段震動長度、整段模式總長
  minRumble: 10, maxRumble: 1500,              // 手把：單段長度
  windowMs: 1000, maxPerWindow: 6,             // 全域：每秒最多 6 次（非關鍵事件）
  maxDutyMs: 600,                              // 全域：每秒累計震動上限（非關鍵事件），避免水滴連發變成持續嗡嗡
  essentialFactor: 2,                          // 關鍵事件（essential）的次數上限 = maxPerWindow × 2，且不受 duty 限制
}

const deepFreeze = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v) }); return Object.freeze(o) }

// 事件表。vibrate = 手機模式；rumble = 手把（基本段 duration/weak/strong 從 t=0 開始，then 為之後的段落，delay 是「距事件開始」的毫秒，段落之間不可重疊）；
// cooldown = 同一事件最短間隔；essential = 關鍵事件（不因水滴 / 點擊佔滿額度而被擋，且可打斷進行中的震動）。
export const PATTERNS = deepFreeze({
  // 鯨魚：長而低（三段漸長的低頻重震 + 尾韻）
  whale: { vibrate: [110, 40, 180, 50, 320], rumble: { duration: 700, weak: 0.08, strong: 0.9, then: [{ delay: 720, duration: 300, weak: 0, strong: 0.4 }] }, cooldown: 2000, essential: true },
  // 海豚：兩下短促輕點（高頻）
  dolphin: { vibrate: [28, 70, 28], rumble: { duration: 35, weak: 0.75, strong: 0.05, then: [{ delay: 105, duration: 35, weak: 0.75, strong: 0.05 }] }, cooldown: 800, essential: true },
  // 海龜：緩慢、鈍的兩下
  turtle: { vibrate: [60, 140, 100], rumble: { duration: 70, weak: 0.3, strong: 0.5, then: [{ delay: 210, duration: 120, weak: 0.3, strong: 0.55 }] }, cooldown: 900, essential: true },
  // 淨化波：由弱漸強（震動段一段比一段長；手把 magnitude 一段比一段大）
  purify: {
    vibrate: [8, 60, 14, 54, 22, 46, 34, 36, 52],
    rumble: { duration: 80, weak: 0.1, strong: 0.1, then: [
      { delay: 100, duration: 80, weak: 0.2, strong: 0.25 },
      { delay: 200, duration: 80, weak: 0.35, strong: 0.45 },
      { delay: 300, duration: 90, weak: 0.5, strong: 0.65 },
      { delay: 410, duration: 160, weak: 0.7, strong: 0.9 },
    ] },
    cooldown: 1200, essential: true,
  },
  // 水滴：短而輕
  drip: { vibrate: [9], rumble: { duration: 18, weak: 0.4, strong: 0 }, cooldown: 320, essential: false },
  // 溢流開始：細碎的三下（水面漫出來）
  overflow: { vibrate: [10, 70, 10, 70, 16], rumble: { duration: 30, weak: 0.35, strong: 0, then: [{ delay: 100, duration: 30, weak: 0.35, strong: 0 }, { delay: 200, duration: 50, weak: 0.45, strong: 0 }] }, cooldown: 3000, essential: true },
  // 點擊 / 輕觸
  tap: { vibrate: [8], rumble: { duration: 14, weak: 0.3, strong: 0 }, cooldown: 60, essential: false },
  // 錄製開始：短、短、稍長（像「預備、預備、開始」）
  record: { vibrate: [30, 50, 70], rumble: { duration: 35, weak: 0.5, strong: 0.1, then: [{ delay: 85, duration: 80, weak: 0.6, strong: 0.3 }] }, cooldown: 500, essential: true },
  recordStop: { vibrate: [50], rumble: { duration: 50, weak: 0.3, strong: 0.3 }, cooldown: 300, essential: true },
  // 播放開始：輕快上揚
  playStart: { vibrate: [12, 36, 20, 36, 34], rumble: { duration: 25, weak: 0.3, strong: 0, then: [{ delay: 60, duration: 30, weak: 0.4, strong: 0.1 }, { delay: 125, duration: 45, weak: 0.5, strong: 0.2 }] }, cooldown: 500, essential: true },
  playStop: { vibrate: [30], rumble: { duration: 30, weak: 0.25, strong: 0.15 }, cooldown: 300, essential: true },
  // 錯誤：兩下急促 + 一下長（供其他功能呼叫 trigger('error')）
  error: { vibrate: [60, 50, 60, 50, 140], rumble: { duration: 60, weak: 0.5, strong: 0.5, then: [{ delay: 110, duration: 60, weak: 0.5, strong: 0.5 }, { delay: 220, duration: 140, weak: 0.6, strong: 0.8 }] }, cooldown: 600, essential: true },
})
export const EVENT_NAMES = Object.keys(PATTERNS)

// 「測試」按鈕依序播放的事件
export const TEST_SEQUENCE = ['whale', 'drip', 'purify', 'dolphin', 'turtle', 'record']

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const clamp01 = (v) => clamp(v, 0, 1)
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const round3 = (v) => Math.round(v * 1000) / 1000

// ---- 純函式：事件表檢查 / 縮放 ----

// 檢查單一事件定義；回傳錯誤字串陣列（空 = 合法）
export function validatePattern(p) {
  const errs = []
  if (!p || typeof p !== 'object') return ['not an object']
  const v = p.vibrate
  if (!Array.isArray(v) || !v.length) errs.push('vibrate must be a non-empty array')
  else {
    if (v.length % 2 === 0) errs.push('vibrate must start and end with an "on" segment (odd length)')
    if (!v.every((n) => Number.isInteger(n) && n >= 1)) errs.push('vibrate entries must be positive integers')
    if (v.reduce((a, b) => a + b, 0) > LIMITS.maxPatternMs) errs.push('vibrate total too long')
  }
  const r = p.rumble
  if (!r || typeof r !== 'object') errs.push('rumble missing')
  else {
    const seg = (s, label) => {
      if (!Number.isInteger(s.duration) || s.duration < 1 || s.duration > LIMITS.maxRumble) errs.push(label + ': bad duration')
      for (const k of ['weak', 'strong']) if (!isNum(s[k]) || s[k] < 0 || s[k] > 1) errs.push(label + ': bad ' + k)
      if (!(s.weak > 0 || s.strong > 0)) errs.push(label + ': both magnitudes are 0')
    }
    seg(r, 'rumble')
    let end = r.duration
    for (const [i, s] of (r.then || []).entries()) {
      seg(s, 'rumble.then[' + i + ']')
      if (!Number.isInteger(s.delay) || s.delay < end) errs.push('rumble.then[' + i + ']: delay overlaps the previous segment')
      end = s.delay + s.duration
    }
  }
  if (!isNum(p.cooldown) || p.cooldown < 0) errs.push('cooldown must be >= 0')
  if (typeof p.essential !== 'boolean') errs.push('essential must be boolean')
  return errs
}

// 手機模式縮放：只縮放「震動」段（偶數位），間隔不變；單段限制在 [minOn, maxOn]；總長不超過 maxPatternMs
export function scaleVibrate(pattern, k) {
  if (!Array.isArray(pattern) || !(k > 0)) return []
  const out = []
  let total = 0
  for (let i = 0; i < pattern.length; i++) {
    const raw = Number(pattern[i])
    if (!isNum(raw) || raw < 0) break
    const ms = i % 2 === 0 ? clamp(Math.round(raw * k), LIMITS.minOn, LIMITS.maxOn) : Math.round(raw)
    if (total + ms > LIMITS.maxPatternMs) break
    out.push(ms); total += ms
  }
  if (out.length && out.length % 2 === 0) out.pop()   // 不以「間隔」結尾
  return out
}

// 手把段落縮放：magnitude × k（夾在 0..1）、duration × k，且不會與下一段重疊 → [{ at, duration, weak, strong }]
export function rumbleSteps(rumble, k) {
  if (!rumble || !(k > 0)) return []
  const raw = [{ at: 0, duration: rumble.duration, weak: rumble.weak, strong: rumble.strong },
    ...(rumble.then || []).map((s) => ({ at: s.delay, duration: s.duration, weak: s.weak, strong: s.strong }))]
  return raw.map((s, i) => {
    let duration = clamp(Math.round(s.duration * k), LIMITS.minRumble, LIMITS.maxRumble)
    const next = raw[i + 1]
    if (next) duration = Math.max(1, Math.min(duration, next.at - s.at))
    return { at: s.at, duration, weak: round3(clamp01(s.weak * k)), strong: round3(clamp01(s.strong * k)) }
  })
}

// 一次事件大約佔用的毫秒（手機模式總長 vs 手把最後一段結束，取大者）
export function patternMs(p, k) {
  const v = scaleVibrate(p.vibrate, k).reduce((a, b) => a + b, 0)
  const steps = rumbleSteps(p.rumble, k)
  const r = steps.length ? steps[steps.length - 1].at + steps[steps.length - 1].duration : 0
  return Math.max(v, r)
}

// 預設是否開啟：偵測到 vibrate 的「觸控裝置」預設開；桌機預設關（插了手把可手動開）；prefers-reduced-motion 預設關
export function defaultEnabled(env) {
  return !!(env && env.vibrateFn && env.isTouch && !env.reducedMotion)
}

// ---- 事件來源（純函式）：store 狀態變化 → 該觸發哪些事件 ----
export const OVERFLOW_AT = 0.97   // 與 audio/engine.js、OverflowFx 同門檻
export const overflowDepth = (seaLevel) => (isNum(seaLevel) ? clamp01((seaLevel - OVERFLOW_AT) / (1 - OVERFLOW_AT)) : 0)
// 溢流水滴節奏：深度 0→1，每秒 0.4→1.8 滴（比聲音的水滴稀疏，觸覺連發會變成嗡嗡）
export const dripIntervalMs = (depth) => 1000 / (0.4 + clamp01(depth) * 1.4)
export const purifyScale = (v) => 0.5 + 0.5 * clamp01(isNum(v) ? v : 1)

// prev / next 是 store 狀態（只讀 spawns、rec.mode、params.seaLevel）；ctx.purifyV = 淨化波力度（purifyMeta.v）
export function diffEvents(prev, next, ctx = {}) {
  const out = []
  if (!prev || !next) return out
  const sp0 = prev.spawns || {}, sp1 = next.spawns || {}
  for (const k of ['whale', 'dolphin', 'turtle']) if ((sp1[k] || 0) > (sp0[k] || 0)) out.push({ name: k, scale: 1 })
  if ((sp1.purify || 0) > (sp0.purify || 0)) out.push({ name: 'purify', scale: purifyScale(ctx.purifyV) })
  const m0 = prev.rec && prev.rec.mode, m1 = next.rec && next.rec.mode
  if (m0 !== m1) {
    if (m0 === 'idle' && m1 === 'recording') out.push({ name: 'record', scale: 1 })
    else if (m0 === 'recording' && m1 === 'idle') out.push({ name: 'recordStop', scale: 1 })
    else if (m0 === 'idle' && m1 === 'playing') out.push({ name: 'playStart', scale: 1 })
    else if (m0 === 'playing' && m1 === 'idle') out.push({ name: 'playStop', scale: 1 })
  }
  const s0 = prev.params && prev.params.seaLevel, s1 = next.params && next.params.seaLevel
  if (isNum(s1) && s1 > OVERFLOW_AT && !(isNum(s0) && s0 > OVERFLOW_AT)) out.push({ name: 'overflow', scale: 1 })
  return out
}

// 溢流水滴計時器（固定節奏，與畫面 / 音訊幀率無關）：setDepth(0..1) 後以 tick(dtMs) 餵時間，回傳這次該不該滴一下
export function createDripAccumulator() {
  let acc = 0, depth = 0
  return {
    setDepth(d) { depth = clamp01(d); if (depth <= 0) acc = 0 },
    get depth() { return depth },
    tick(dtMs) {
      if (depth <= 0) return false
      acc += clamp(dtMs, 0, 500) / dripIntervalMs(depth)
      if (acc >= 1) { acc = Math.min(acc - 1, 0.99); return true }
      return false
    },
  }
}

// 把 store 的狀態變化接到觸覺引擎（HapticsService 只是在 useEffect 裡呼叫它；抽出來以便用假 store 測試）。
//   store = { getState(), subscribe(fn(state, prev)) → unsubscribe }（zustand store 即符合）
//   回傳 dispose()：取消訂閱、停計時器、停止進行中的震動。
// 每次 store 變動（資料播放時每幀）都會進到訂閱函式，所以先用參考比較快速略過與觸覺無關的變動。
export function attachHapticsSource({ store, haptics, getPurifyV, setIntervalFn, clearIntervalFn, now, isHidden, tickMs = 150 }) {
  const setI = setIntervalFn || ((fn, ms) => setInterval(fn, ms))
  const clearI = clearIntervalFn || ((id) => clearInterval(id))
  const nowMs = now || (() => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()))
  const acc = createDripAccumulator()
  let timer = null, lastT = 0, disposed = false

  const tick = () => {
    const n = nowMs(), dt = n - lastT
    lastT = n
    if (isHidden && isHidden()) return
    if (!haptics.getState().enabled) return
    if (acc.tick(dt)) haptics.trigger('drip', 0.7 + 0.5 * acc.depth)   // 越滿越用力一點
  }
  // 溢流期間才有計時器（平時沒有任何常駐計時）
  const setDepth = (d) => {
    acc.setDepth(d)
    if (d > 0 && timer == null) { lastT = nowMs(); timer = setI(tick, tickMs) }
    else if (d <= 0 && timer != null) { clearI(timer); timer = null }
  }

  const st0 = store.getState()
  setDepth(overflowDepth(st0 && st0.params && st0.params.seaLevel))   // 掛載時海面就已溢流 → 直接進入滴水節奏（不觸發 overflow 起始事件）

  const unsub = store.subscribe((s, prev) => {
    if (disposed || !prev) return
    if (s.spawns === prev.spawns && s.rec.mode === prev.rec.mode && s.params.seaLevel === prev.params.seaLevel) return
    for (const ev of diffEvents(prev, s, { purifyV: getPurifyV ? getPurifyV() : 1 })) haptics.trigger(ev.name, ev.scale)
    if (s.params.seaLevel !== prev.params.seaLevel) setDepth(overflowDepth(s.params.seaLevel))
  })

  return function dispose() {
    disposed = true
    unsub()
    if (timer != null) { clearI(timer); timer = null }
    haptics.cancel()
  }
}

// ---- 觸覺引擎（可注入環境）----
// env（皆可省略）：
//   vibrateFn(pattern)  → boolean | undefined；null / undefined = 不支援（iOS Safari）
//   getGamepads()       → Gamepad[]
//   now()               → ms（單調時間）
//   setTimeoutFn / clearTimeoutFn
//   userActivated()     → 使用者是否互動過（Chrome 在沒有互動前呼叫 vibrate 會被擋並在 console 報警）
//   isHidden()          → 分頁在背景
//   isTouch / reducedMotion → boolean（只影響預設開關）
//   storage { get(): {enabled?,level?}|null, set(obj) }
export function createHaptics(env = {}) {
  const now = typeof env.now === 'function' ? env.now : () => Date.now()
  const setT = env.setTimeoutFn || ((fn, ms) => setTimeout(fn, ms))
  const clearT = env.clearTimeoutFn || ((id) => clearTimeout(id))
  const storage = env.storage || null
  const listeners = new Set()

  let saved = {}
  try { const s = storage && storage.get && storage.get(); if (s && typeof s === 'object') saved = { ...s } } catch (e) { saved = {} }
  const level0 = LEVELS.includes(saved.level) ? saved.level : 'medium'
  let snapshot = { enabled: typeof saved.enabled === 'boolean' ? saved.enabled : defaultEnabled(env), level: level0 }

  let timers = []            // 手把後續段落的計時器
  let seqTimer = null        // runSequence 的計時器
  let busyUntil = 0          // 進行中的事件預估結束時間（非關鍵事件不打斷它）
  const lastAt = {}          // 事件 → 上次觸發時間
  let recent = []            // 全域視窗：{ t, ms }

  const clearTimers = () => { for (const id of timers) { try { clearT(id) } catch (e) {} } timers = [] }
  const emit = () => { for (const fn of [...listeners]) { try { fn(snapshot) } catch (e) {} } }
  const persist = (patch) => { saved = { ...saved, ...patch }; try { storage && storage.set && storage.set(saved) } catch (e) {} }

  const hidden = () => { try { return !!(env.isHidden && env.isHidden()) } catch (e) { return false } }
  const activated = () => { try { return env.userActivated ? !!env.userActivated() : true } catch (e) { return true } }
  const rawPads = () => { try { return (env.getGamepads && env.getGamepads()) || [] } catch (e) { return [] } }
  const padRumble = (pad) => {
    const a = pad && pad.vibrationActuator
    if (!a || typeof a.playEffect !== 'function') return false
    if (a.effects != null) { try { return Array.from(a.effects).includes('dual-rumble') } catch (e) { return true } }
    return true
  }
  const livePads = () => { const out = []; for (const p of Array.from(rawPads())) if (p && p.connected !== false) out.push(p); return out }
  const rumblePads = () => livePads().filter(padRumble)

  function playStep(step) {
    let ok = false
    for (const pad of rumblePads()) {
      try {
        const r = pad.vibrationActuator.playEffect('dual-rumble', { startDelay: 0, duration: step.duration, weakMagnitude: step.weak, strongMagnitude: step.strong })
        if (r && typeof r.catch === 'function') r.catch(() => {})
        ok = true
      } catch (e) { /* 手把在此刻不可用：略過 */ }
    }
    return ok
  }
  function vibrate(pattern) {
    if (!env.vibrateFn || !activated()) return false
    try { return env.vibrateFn(pattern) !== false } catch (e) { return false }
  }

  function cancel() {
    clearTimers()
    if (busyUntil > now()) {
      if (env.vibrateFn && activated()) { try { env.vibrateFn(0) } catch (e) {} }
      for (const p of rumblePads()) { try { const r = p.vibrationActuator.reset && p.vibrationActuator.reset(); if (r && typeof r.catch === 'function') r.catch(() => {}) } catch (e) {} }
    }
    busyUntil = 0
  }

  // 觸發事件。scale = 該次力度倍率（0..2，例如淨化波力度）；opts.force = 略過總開關與節流（測試按鈕用）
  // 回傳：是否真的送出震動（不支援 / 被節流 / 總開關關閉 → false，永遠不丟錯）
  function trigger(name, scale = 1, opts = null) {
    const p = PATTERNS[name]
    if (!p) return false
    const force = !!(opts && opts.force)
    if (!force && !snapshot.enabled) return false
    if (hidden()) return false
    const k = LEVEL_SCALE[snapshot.level] * (isNum(scale) ? clamp(scale, 0, 2) : 1)
    if (!(k > 0)) return false
    const canPhone = !!env.vibrateFn && activated()
    const pads = rumblePads()
    if (!canPhone && !pads.length) return false   // iOS Safari / 桌機沒手把：靜默略過

    const t = now()
    if (!force) {
      const last = lastAt[name]
      if (last != null && t - last < p.cooldown) return false
      recent = recent.filter((r) => t - r.t < LIMITS.windowMs)
      const duty = recent.reduce((a, r) => a + r.ms, 0)
      if (p.essential) { if (recent.length >= LIMITS.maxPerWindow * LIMITS.essentialFactor) return false }
      else if (recent.length >= LIMITS.maxPerWindow || duty >= LIMITS.maxDutyMs || t < busyUntil) return false
    }

    clearTimers()   // 新事件會打斷舊的（手機 vibrate 與手把 playEffect 本來就會被取代）
    let fired = false, ms = 0   // ms = 實際送出的裝置佔用多久（只算真的有震的那種裝置）
    if (canPhone) {
      const pat = scaleVibrate(p.vibrate, k)
      if (pat.length && vibrate(pat)) { fired = true; ms = pat.reduce((a, b) => a + b, 0) }
    }
    if (pads.length) {
      const steps = rumbleSteps(p.rumble, k)
      if (steps.length && playStep(steps[0])) {
        fired = true
        const last = steps[steps.length - 1]
        ms = Math.max(ms, last.at + last.duration)
        steps.slice(1).forEach((s) => timers.push(setT(() => playStep(s), s.at)))
      }
    }
    if (fired) {
      lastAt[name] = t
      recent.push({ t, ms })
      busyUntil = t + ms
    }
    return fired
  }

  // 舊式「震 N 毫秒」（store 的 haptic(ms)）：只走手機、受總開關與強度影響；不計入節流，但不打斷進行中的事件
  function pulse(ms) {
    if (!snapshot.enabled || !env.vibrateFn || !isNum(ms) || ms <= 0) return false
    if (hidden() || now() < busyUntil) return false
    return vibrate(clamp(Math.round(ms * LEVEL_SCALE[snapshot.level]), LIMITS.minOn, LIMITS.maxOn))
  }

  // 依序播放事件（測試按鈕）；每步之間等該事件播完再加 gap。回傳取消函式。
  function runSequence(names = TEST_SEQUENCE, cb = {}) {
    const { onStep, onDone, gap = 500 } = cb
    let i = 0, stopped = false
    const next = () => {
      seqTimer = null
      if (stopped) return
      if (i >= names.length) { if (onDone) onDone(); return }
      const name = names[i++]
      if (onStep) onStep(name, i - 1)
      trigger(name, 1, { force: true })
      const p = PATTERNS[name]
      const wait = (p ? patternMs(p, LEVEL_SCALE[snapshot.level]) : 0) + gap
      seqTimer = setT(next, wait)
    }
    next()
    return () => { stopped = true; if (seqTimer != null) { try { clearT(seqTimer) } catch (e) {} seqTimer = null }; cancel() }
  }

  function setEnabled(on) {
    on = !!on
    if (on === snapshot.enabled) return
    if (!on) cancel()
    snapshot = { ...snapshot, enabled: on }
    persist({ enabled: on })
    emit()
  }
  function setLevel(level) {
    if (!LEVELS.includes(level) || level === snapshot.level) return
    snapshot = { ...snapshot, level }
    persist({ level })
    emit()
  }

  function listPads() {
    return livePads().map((p, i) => ({ index: typeof p.index === 'number' ? p.index : i, id: String(p.id || ''), rumble: padRumble(p) }))
  }
  function caps() {
    const pads = listPads()
    return { vibrate: typeof env.vibrateFn === 'function', touch: !!env.isTouch, reducedMotion: !!env.reducedMotion, pads, padCount: pads.length, padRumble: pads.filter((p) => p.rumble).length }
  }

  return {
    trigger, pulse, cancel, runSequence, setEnabled, setLevel, caps,
    getState: () => snapshot,   // 穩定的快照物件（改變才換），可直接給 useSyncExternalStore
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
  }
}

// ---- 瀏覽器預設環境 + 單例 ----
export function browserEnv() {
  const w = typeof window !== 'undefined' ? window : null
  const nav = typeof navigator !== 'undefined' ? navigator : null
  const mm = (q) => { try { return !!(w && w.matchMedia && w.matchMedia(q).matches) } catch (e) { return false } }
  const hasMM = !!(w && typeof w.matchMedia === 'function')
  return {
    vibrateFn: nav && typeof nav.vibrate === 'function' ? (p) => nav.vibrate(p) : null,
    getGamepads: nav && typeof nav.getGamepads === 'function' ? () => nav.getGamepads() : () => [],
    now: () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()),
    setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn: (id) => clearTimeout(id),
    userActivated: () => { const ua = nav && nav.userActivation; return ua ? !!ua.hasBeenActive : true },
    isHidden: () => typeof document !== 'undefined' && document.hidden === true,
    isTouch: hasMM ? mm('(pointer: coarse)') : !!(nav && nav.maxTouchPoints > 0),
    reducedMotion: mm('(prefers-reduced-motion: reduce)'),
    storage: { get: () => loadLS(HAPTICS_LS_KEY, null), set: (v) => saveLS(HAPTICS_LS_KEY, v) },
  }
}

let singleton = null
export function getHaptics() { return singleton || (singleton = createHaptics(browserEnv())) }
export const trigger = (name, scale, opts) => getHaptics().trigger(name, scale, opts)   // 其他功能想加觸感：import { trigger } from '../lib/haptics.js'
export const pulse = (ms) => getHaptics().pulse(ms)                                     // useStore 的 haptic(ms)
