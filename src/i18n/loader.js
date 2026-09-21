// 英文字典的「載入狀態機」與「語系切換協調器」（純函式模組：不碰 window / navigator / document / import.meta，Node 可直接測）。
// 為什麼獨立成檔：英文字典（src/i18n/en/*.js，約 130KB 原始碼）改成瀏覽器動態載入之後，
// 「載入中共用同一個 promise / 失敗可重試 / 成功後快取 / 逾時」與「字典還沒載入時按 EN 要怎麼切」都有狀態、都容易寫錯，
// 抽成可注入（載入函式、計時器、語系的讀寫）的純函式，才有辦法在 Node 用假環境逐案測。真正接上 import() / zustand 在 index.js。
//
//   createLoader({ load, onReady, onError, attemptTimeoutMs, timers })   → 載入狀態機
//       state：idle → loading → ready | failed（failed 之後再呼叫 load() 會重試）；沒有 load 函式 = 「無需載入」，一開始就是 ready（Node：字典靠 registerEn）
//   raceTimeout(promise, ms, timers)                                     → 永遠 resolve：{ status: 'ok' | 'error' | 'timeout', value?, error? }（計時器一定會清掉）
//   createLocaleSwitcher({ getLocale, applyLocale, english, ... })       → setLocale 的非同步協調（字典未就緒 → 先載入、載完才切；失敗維持原語系）
//
// 瀏覽器專屬陷阱（過去踩過的 Illegal invocation）：這裡不把 setTimeout / clearTimeout 存成物件屬性再脫離 globalThis 呼叫——預設計時器一律是「呼叫當下才去 globalThis 上取」的箭頭函式。

export const LOAD_STATE = Object.freeze({ IDLE: 'idle', LOADING: 'loading', READY: 'ready', FAILED: 'failed' })
// 看門狗判定「載入逾時」時 reject 的錯誤訊息（呼叫端據此分辨「還在跑、只是太慢」與「硬失敗」——後者的 import() 失敗在瀏覽器的模組表裡可能被快取，同一個網址再 import 一次不會重新請求）
export const LOAD_TIMEOUT_MESSAGE = 'load timeout'

// 預設計時器：每次呼叫才讀 globalThis（不存原生函式參考）。注入的計時器（測試用假物件，或 globalThis 本身）
// 一律「在原物件上」呼叫（保留 this）——瀏覽器的原生 setTimeout 若被掛到別的物件上再呼叫會丟 Illegal invocation。
export const defaultTimers = Object.freeze({
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
})
const pickTimers = (t) => ({
  setTimeout: t && typeof t.setTimeout === 'function' ? (fn, ms) => t.setTimeout(fn, ms) : defaultTimers.setTimeout,
  clearTimeout: t && typeof t.clearTimeout === 'function' ? (id) => t.clearTimeout(id) : defaultTimers.clearTimeout,
})
const finitePositive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0
const safe = (fn, ...args) => { if (typeof fn !== 'function') return; try { fn(...args) } catch (e) { /* 通知用的回呼出錯不能影響載入結果 */ } }

// ---------------------------------------------------------------------------------------------
// 載入狀態機
//   · load() 回傳 Promise：ready → 立刻 resolve 快取值；loading → 共用同一個進行中的 promise（不重複載入）；idle / failed → 開始（或重試）一次載入
//   · 失敗：promise reject、state = failed、快取不動；下一次 load() 重新嘗試（不會卡在「已失敗」）
//   · attemptTimeoutMs（選填）：一次嘗試超過這麼久還沒結果就判定失敗（防網路卡住讓「載入中」永遠占著位子、之後每次呼叫都共用那個永不結束的 promise）。
//     被判定逾時的舊嘗試若之後又成功，仍然接受（state → ready）——載入函式本身是冪等的（把字典合併進去）。
//   · onReady(value)：第一次成功時呼叫一次；onError(error)：每次失敗呼叫（皆包 try/catch）
// ---------------------------------------------------------------------------------------------
export function createLoader({ load = null, onReady = null, onError = null, attemptTimeoutMs = 0, timers } = {}) {
  const tm = pickTimers(timers)
  const hasLoad = typeof load === 'function'
  let state = hasLoad ? LOAD_STATE.IDLE : LOAD_STATE.READY
  let value
  let error = null
  let inflight = null
  let seq = 0

  function start() {
    const id = ++seq
    state = LOAD_STATE.LOADING
    error = null
    let timer = null
    let settled = false
    let self = null
    const clear = () => { if (timer !== null) { try { tm.clearTimeout(timer) } catch (e) { /* ignore */ } timer = null } }
    self = new Promise((resolve, reject) => {
      const ok = (v) => {
        clear()
        if (state !== LOAD_STATE.READY) { value = v; state = LOAD_STATE.READY; error = null; safe(onReady, v) }   // 逾時後才到的成功也算（見上）
        if (inflight === self) inflight = null
        if (!settled) { settled = true; resolve(value) }
      }
      const fail = (e) => {
        clear()
        if (settled) return                                            // 已因逾時判定失敗
        settled = true
        if (id === seq && state !== LOAD_STATE.READY) { state = LOAD_STATE.FAILED; error = e }
        if (inflight === self) inflight = null
        safe(onError, e)
        reject(e)
      }
      if (finitePositive(attemptTimeoutMs)) timer = tm.setTimeout(() => { timer = null; fail(new Error(LOAD_TIMEOUT_MESSAGE)) }, attemptTimeoutMs)
      let r
      try { r = Promise.resolve(load()) } catch (e) { r = Promise.reject(e) }
      r.then(ok, fail)
    })
    return self
  }

  return {
    getState: () => state,
    isReady: () => state === LOAD_STATE.READY,
    isLoading: () => state === LOAD_STATE.LOADING,
    getValue: () => value,
    getError: () => error,
    load() {
      if (state === LOAD_STATE.READY) return Promise.resolve(value)
      if (inflight) return inflight
      inflight = start()
      return inflight
    },
  }
}

// ---------------------------------------------------------------------------------------------
// raceTimeout：等 promise 最多 ms 毫秒。永遠 resolve（不 reject）：
//   { status: 'ok', value } | { status: 'error', error } | { status: 'timeout' }
// ms 不是「有限正數」→ 不設逾時（一直等）。逾時後原 promise 繼續跑（呼叫端可以之後再處理它）。計時器在任何一邊先完成時都會清掉（無洩漏）。
// ---------------------------------------------------------------------------------------------
export function raceTimeout(promise, ms, timers) {
  const tm = pickTimers(timers)
  return new Promise((resolve) => {
    let timer = null
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      if (timer !== null) { try { tm.clearTimeout(timer) } catch (e) { /* ignore */ } timer = null }
      resolve(r)
    }
    if (finitePositive(ms)) timer = tm.setTimeout(() => { timer = null; finish({ status: 'timeout' }) }, ms)
    Promise.resolve(promise).then((value) => finish({ status: 'ok', value }), (error) => finish({ status: 'error', error }))
  })
}

// ---------------------------------------------------------------------------------------------
// 語系切換協調器（setLocale 的非同步版；同步路徑與 Node 行為不變）
//   deps.getLocale()               → 目前「生效」的語系（t() 用的那個）
//   deps.applyLocale(loc, opts)    → 同步套用（改 store / 存偏好 / 更新網址 / 文件語言）；opts 原樣轉交（例如 { persist: false }）
//   deps.english                   → { isReady(), load() }（createLoader 的回傳值即可；load() 失敗要 reject）
//   deps.initialDesired            → 「使用者想要的語系」的初值（啟動時偵測到 en 但字典還沒載入：想要 en、生效 zh）；預設 = getLocale()
//   deps.onBusy(bool)              → 有沒有切換在等字典（給 UI 顯示忙碌用）
//   deps.onError(err)              → 載入失敗（記一行 log；協調器本身不丟例外）
//   request(loc, opts)  → Promise<目前生效的語系>（永遠 resolve）。
//       · zh、或 en 而字典已就緒 → 同步套用（呼叫回來時 getLocale() 已經是新語系）
//       · en 而字典未就緒 → 先 english.load()，載完才套用；載入中再呼叫 → 共用同一個載入；失敗 → 維持原語系、onError 一次
//       · 「想要的語系」以最後一次 request 為準：等字典期間又要求 zh → 字典到了也不切 en
//   boot({ timeoutMs, timers }) → Promise<{ status, locale }>：啟動時用（main.jsx 在第一次 render 前等）。
//       status：'skip'（想要的就是目前的，不必等）| 'ready'（在時限內切到 en）| 'timeout'（逾時：先以目前語系 render；字典之後到了會自動切）
//               | 'failed'（沒切到想要的語系：載入失敗，或等待期間使用者改選了別的；不論哪種都維持目前語系）
// ---------------------------------------------------------------------------------------------
export function createLocaleSwitcher({ getLocale, applyLocale, english, initialDesired, onBusy, onError, valid = ['zh', 'en'] } = {}) {
  let desired = initialDesired == null ? getLocale() : initialDesired
  let pending = 0

  const busy = (b) => safe(onBusy, b)

  function request(loc, opts) {
    if (!valid.includes(loc)) return Promise.resolve(getLocale())
    desired = loc                                                          // 先記下「想要的」——即使已經是目前語系，也要能取消還在等字典的另一個要求
    if (loc === getLocale()) return Promise.resolve(getLocale())
    if (loc !== 'en' || english.isReady()) { applyLocale(loc, opts); return Promise.resolve(getLocale()) }

    pending += 1
    if (pending === 1) busy(true)
    const settle = () => { pending = Math.max(0, pending - 1); if (pending === 0) busy(false); return getLocale() }
    let p
    try { p = Promise.resolve(english.load()) } catch (e) { p = Promise.reject(e) }
    return p.then(
      () => { if (desired === loc && getLocale() !== loc) { try { applyLocale(loc, opts) } catch (e) { safe(onError, e) } } },
      (err) => { safe(onError, err); if (desired === loc) desired = getLocale() },   // 失敗：維持原語系；之後再按 EN 會重試
    ).then(settle, settle)
  }

  function boot({ timeoutMs, timers } = {}) {
    const want = desired
    if (want === getLocale()) return Promise.resolve({ status: 'skip', locale: getLocale() })
    const started = request(want, { persist: false })                      // 啟動時偵測到的語系不算「使用者手動選擇」：不寫偏好
    return raceTimeout(started, timeoutMs, timers).then((r) => {
      if (r.status === 'timeout') return { status: 'timeout', locale: getLocale() }
      return { status: getLocale() === want ? 'ready' : 'failed', locale: getLocale() }   // 失敗時 desired 已退回目前語系，所以要跟「一開始想要的」比
    })
  }

  return { request, boot, getDesired: () => desired, isPending: () => pending > 0 }
}

// ---------------------------------------------------------------------------------------------
// prefetchWhenIdle：畫面出來之後，趁閒置把英文字典預抓進來（記憶體 + Service Worker 快取）。
//   為什麼：英文字典是動態載入的 chunk；中文使用者按 EN 時才第一次去抓，展場網路不穩 / 離線（PWA 離線可開）時會失敗，而 SW 沒有預先快取它。
//   預抓之後：(1) 按 EN 是同步生效，不再依賴當下的網路；(2) chunk 經過 SW 的 stale-while-revalidate 進了快取，離線也切得過去。
//   環境全部注入（Node 可測）：
//     english   { isReady(), load() }（createLoader 的回傳值）
//     idle(fn)  排一個「閒置時執行」的回呼（瀏覽器：requestIdleCallback；沒有就用計時器）——不是函式 → 不預抓
//     saveData() / online()  省流量模式（回 true → 不預抓）/ 是否在線（回 false → 不預抓；回傳 undefined = 不知道，照抓）
//   預抓失敗完全靜默（使用者沒有要求它）：不記錄成「載入失敗」——之後使用者按 EN 才是真正的嘗試（失敗會有畫面提示）。
//   回傳：有排程 = true；不需要 / 不能排 = false。任何環境的例外都不外洩。
// ---------------------------------------------------------------------------------------------
export function prefetchWhenIdle(deps) {
  try {
    const { english, idle, saveData, online } = deps || {}
    if (!english || typeof english.isReady !== 'function' || typeof english.load !== 'function') return false
    if (english.isReady() || typeof idle !== 'function') return false
    if (call(saveData) === true) return false
    idle(() => {
      try {
        if (english.isReady() || call(online) === false) return
        Promise.resolve(english.load()).then(() => {}, () => {})
      } catch (e) { /* 預抓出錯不影響任何事 */ }
    })
    return true
  } catch (e) { return false }
}
const call = (fn) => { if (typeof fn !== 'function') return undefined; try { return fn() } catch (e) { return undefined } }
