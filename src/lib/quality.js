// 自動畫質（FPS 自適應）的純邏輯：等級表、FPS 滑動視窗、降 / 升級狀態機、偏好序列化。
// 不碰 DOM / rAF / store / 計時器：時間一律由呼叫端以毫秒傳入（services/QualityService.jsx 以 rAF 量 dt 餵進來），
// 所以可以用假時鐘在 node 測（見 quality.test.mjs）。
//
// 規則（預設值見 DEFAULTS）：
//   降級：連續 3 秒平均 FPS < 40 → 降一級（high → medium → low）
//   升級：連續 8 秒平均 FPS > 55 → 升一級
//   遲滯：40 ~ 55 之間什麼都不做；任何一次換級後至少停留 10 秒（最短停留）；
//   冷卻：降級與降級之間 10 秒；降級之後要等 30 秒才會嘗試升級，升級後又馬上被降回去（抖動）→ 下次升級冷卻倍增（30 → 60 → 120 → 240 秒），穩定 2 分鐘後歸零
//   暖機：頁面剛載入的前 5 秒（編譯 shader、載資料）不判斷；只計「實際收到的樣本時間」，背景分頁不算
//   暫停：頁面隱藏 / 錄影 / 使用者拖曳中 → pause(reason)，樣本不收；全部解除後視窗歸零重量（不拿舊資料下判斷）
//   手動覆寫：setMode('high'|'medium'|'low') 鎖定等級、狀態機不再動作（只繼續量 FPS 供顯示）；setMode('auto') 由目前等級接手
//   斷點：單一樣本 dt > 1 秒（分頁凍結、除錯暫停）→ 視窗歸零，不當成「很低的 FPS」

export const TIERS = ['low', 'medium', 'high']            // 由低到高
export const MODES = ['auto', 'high', 'medium', 'low']
export const LS_KEY = 'ixd2026.quality'

// 各等級的效果（Scene3D 讀這張表；high = 現況）
//   dprMax：像素比上限（Canvas 的 dpr = [1, dprMax]）；particles / creatures：粒子、生物（含垃圾）上限係數；
//   shootingStars：背景流星；backdropBlur：背景模糊 / 清澈的完整管線（false → 只剩便宜的暗化）
export const TIER_FX = Object.freeze({
  high: Object.freeze({ dprMax: 2, particles: 1, creatures: 1, shootingStars: true, backdropBlur: true }),
  medium: Object.freeze({ dprMax: 1.5, particles: 0.7, creatures: 0.7, shootingStars: true, backdropBlur: true }),
  low: Object.freeze({ dprMax: 1, particles: 0.5, creatures: 0.5, shootingStars: false, backdropBlur: false }),
})

export const DEFAULTS = Object.freeze({
  downFps: 40, downMs: 3000,
  upFps: 55, upMs: 8000,
  minDwellMs: 10000,        // 任何換級之後的最短停留
  downCooldownMs: 10000,    // 兩次降級之間
  upCooldownMs: 30000,      // 降級之後多久才允許嘗試升級（會因抖動倍增）
  flapMs: 45000,            // 升級後這麼快又被降回去 = 抖動
  stableMs: 120000,         // 同一等級穩定這麼久 → 抖動計數歸零
  backoffMax: 3,            // 升級冷卻最多倍增 2^3
  warmupMs: 5000,
  maxDtMs: 1000,
  evalEveryMs: 250,
  fpsWindowMs: 1000,        // 「目前 FPS」的取樣視窗
  coverage: 0.95,           // 視窗至少要有這個比例的時間有樣本，才算「連續」
  startTier: 'high',
})

export const normalizeTier = (t) => (TIERS.includes(t) ? t : 'high')
export const normalizeMode = (m) => (MODES.includes(m) ? m : 'auto')
export const tierFx = (tier) => TIER_FX[normalizeTier(tier)]
export function stepTier(tier, dir) {
  const i = TIERS.indexOf(normalizeTier(tier)) + (dir < 0 ? -1 : 1)
  return TIERS[Math.max(0, Math.min(TIERS.length - 1, i))]
}
// Canvas 的 dpr 範圍：每級一個固定陣列（identity 穩定，避免 React 每次 render 都當成新設定）
const DPR = Object.fromEntries(TIERS.map((k) => [k, Object.freeze([1, TIER_FX[k].dprMax])]))
export const dprRange = (tier) => DPR[normalizeTier(tier)]

// ---------- FPS 滑動視窗 ----------
// push(now, dtMs)：一個幀（now = 該幀時間戳、dtMs = 距上一幀）。stats(now, windowMs)：時間加權平均 FPS = 幀數 / 總時間。
// coverageMs = 視窗內樣本涵蓋的總時間（用來判斷「是否已連續量滿這麼久」）。
export function createFpsWindow(maxMs = 10000) {
  let ts = [], dts = [], head = 0
  const prune = (now) => {
    while (head < ts.length && ts[head] <= now - maxMs) head++
    if (head > 256 && head * 2 > ts.length) { ts = ts.slice(head); dts = dts.slice(head); head = 0 }   // 偶爾壓實，避免陣列無限長
  }
  return {
    push(now, dtMs) { ts.push(now); dts.push(dtMs); prune(now) },
    clear() { ts = []; dts = []; head = 0 },
    size() { return ts.length - head },
    stats(now, windowMs) {
      let n = 0, sum = 0
      for (let i = ts.length - 1; i >= head; i--) {
        if (ts[i] <= now - windowMs) break
        n++; sum += dts[i]
      }
      return { frames: n, coverageMs: sum, fps: sum > 0 ? (n * 1000) / sum : null }
    },
  }
}

// ---------- 狀態機 ----------
// opts：DEFAULTS 的任一欄位 + { mode, startTier, onChange(tier, info) }
//   info = { kind: 'down'|'up'|'manual', from, to, fps, windowMs, threshold, at }
export function createQualityController(opts = {}) {
  const c = { ...DEFAULTS, ...opts }
  const win = createFpsWindow(Math.max(c.downMs, c.upMs, c.fpsWindowMs) + 500)   // 判斷用（暫停時不收）
  const disp = createFpsWindow(c.fpsWindowMs + 500)                                // 顯示「目前 FPS」用（暫停時照收，只要有畫面就量得到）
  const paused = new Set()
  let mode = normalizeMode(opts.mode)
  let tier = mode === 'auto' ? normalizeTier(c.startTier) : mode
  let sampledMs = 0                       // 累計「實際收到的樣本時間」（暖機用）
  let lastChangeAt = null                 // 最近一次換級 / 切回自動（最短停留的起點）；null = 從未換過（此時只受暖機約束）
  let lastDownAt = -Infinity, lastUpAt = -Infinity
  let failedUps = 0
  let lastEvalAt = -Infinity
  let lastReason = null                   // 最近一次「自動降級」的原因
  let changes = 0

  const emit = (kind, from, to, fps, windowMs, now) => {
    const info = { kind, from, to, fps, windowMs, threshold: kind === 'down' ? c.downFps : kind === 'up' ? c.upFps : null, at: now }
    if (c.onChange) c.onChange(to, info)
    return info
  }
  const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10)

  function change(now, to, kind, fps, windowMs) {
    const from = tier
    tier = to; lastChangeAt = now; changes++
    win.clear()
    if (kind === 'down') {
      if (now - lastUpAt <= c.flapMs) failedUps = Math.min(c.backoffMax, failedUps + 1)   // 剛升上去就撐不住 → 之後升級更保守
      lastDownAt = now
      lastReason = { at: now, from, to, fps: round1(fps), windowMs, threshold: c.downFps }
    } else if (kind === 'up') lastUpAt = now
    return emit(kind, from, to, round1(fps), windowMs, now)
  }

  function evaluate(now) {
    const since = lastChangeAt == null ? Infinity : now - lastChangeAt
    if (since < c.minDwellMs) return null
    if (failedUps && since > c.stableMs) failedUps = 0
    if (tier !== 'low' && now - lastDownAt >= c.downCooldownMs) {
      const w = win.stats(now, c.downMs)
      if (w.coverageMs >= c.downMs * c.coverage && w.fps != null && w.fps < c.downFps) return change(now, stepTier(tier, -1), 'down', w.fps, c.downMs)
    }
    if (tier !== 'high' && now - lastDownAt >= c.upCooldownMs * Math.pow(2, failedUps)) {
      const w = win.stats(now, c.upMs)
      if (w.coverageMs >= c.upMs * c.coverage && w.fps != null && w.fps > c.upFps) return change(now, stepTier(tier, +1), 'up', w.fps, c.upMs)
    }
    return null
  }

  return {
    // 餵一個幀。回傳這一幀造成的換級資訊（沒有換級 → null）。
    feed(now, dtMs) {
      if (!Number.isFinite(now) || !Number.isFinite(dtMs) || dtMs <= 0) return null
      if (dtMs > c.maxDtMs) { win.clear(); disp.clear(); return null }
      disp.push(now, dtMs)
      if (paused.size) return null
      win.push(now, dtMs)
      sampledMs += dtMs
      if (mode !== 'auto') return null
      if (sampledMs < c.warmupMs) return null
      if (now - lastEvalAt < c.evalEveryMs) return null
      lastEvalAt = now
      return evaluate(now)
    },
    // 手動覆寫：'high' | 'medium' | 'low' 鎖定；'auto' 從目前等級繼續自動調整
    setMode(m, now = 0) {
      const next = normalizeMode(m)
      mode = next
      win.clear(); lastEvalAt = -Infinity
      if (next === 'auto') { lastChangeAt = now; return null }   // 重新計最短停留，避免一切回自動就立刻被判斷
      if (next === tier) { lastChangeAt = now; return null }
      const from = tier
      tier = next; lastChangeAt = now; changes++
      return emit('manual', from, next, null, 0, now)
    },
    pause(reason = 'pause', now = 0) { paused.add(reason); win.clear() },
    resume(reason = 'pause', now = 0) {
      paused.delete(reason)
      if (!paused.size) { win.clear(); lastEvalAt = -Infinity }
    },
    isPaused() { return paused.size > 0 },
    getState(now) {
      const cur = disp.stats(now, c.fpsWindowMs)
      return {
        mode, tier, paused: paused.size > 0, pauseReasons: [...paused],
        fps: cur.fps == null ? null : Math.round(cur.fps), reason: lastReason,
        sampledMs, failedUps, changes,
      }
    },
    getFps(now) { return disp.stats(now, c.fpsWindowMs).fps },
  }
}

// ---------- 偏好（localStorage 'ixd2026.quality'）----------
// 存 JSON：{ mode, tier }。mode = 使用者選的；tier = 自動模式最後停在哪一級（下次載入從這級起跳，舊機不必再從 high 慢慢掉）。
// 相容純字串（'low' 或 '"low"'）。所有讀寫都吞例外（私密模式 / 停用儲存不能壞功能）。
export function parsePrefs(raw) {
  let v = raw
  if (typeof raw === 'string') { try { v = JSON.parse(raw) } catch (e) { v = raw } }
  if (v && typeof v === 'object') return { mode: normalizeMode(v.mode), tier: normalizeTier(v.tier) }
  const mode = normalizeMode(v)
  return { mode, tier: mode === 'auto' ? 'high' : mode }
}
export const serializePrefs = (p) => JSON.stringify({ mode: normalizeMode(p && p.mode), tier: normalizeTier(p && p.tier) })
const defaultStorage = () => { try { return typeof localStorage !== 'undefined' ? localStorage : null } catch (e) { return null } }
export function readPrefs(storage = defaultStorage()) {
  try { const raw = storage && storage.getItem(LS_KEY); if (raw != null) return parsePrefs(raw) } catch (e) { /* ignore */ }
  return { mode: 'auto', tier: 'high' }
}
export function writePrefs(prefs, storage = defaultStorage()) {
  try { if (storage) storage.setItem(LS_KEY, serializePrefs(prefs)); return !!storage } catch (e) { return false }
}
// 手動模式一律以模式為準；自動模式用上次記住的等級
export const initialTier = (prefs) => (prefs.mode === 'auto' ? normalizeTier(prefs.tier) : prefs.mode)

// 網址參數：?quality=auto|high|medium|low（本次覆寫、不寫入偏好，方便展場與測試）、?fps=1（畫面角落顯示 FPS，除錯用）
export function parseQueryMode(search) {
  try { const v = new URLSearchParams(search || '').get('quality'); return v && MODES.includes(v.toLowerCase()) ? v.toLowerCase() : null } catch (e) { return null }
}
export function isFpsDebug(search) {
  try { return new URLSearchParams(search || '').get('fps') === '1' } catch (e) { return false }
}
