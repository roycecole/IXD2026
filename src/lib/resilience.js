// 展場防呆的純邏輯：崩潰紀錄（環狀 + 去重）/ 自動重載的退避與熔斷 / 渲染看門狗 / WebGL context 遺失復原 /
// 版本與資料新舊比較 / 閒置判斷 / 每日重載，以及把它們接起來的 startGuards()。
//
// 設計重點（展場整天不關機、沒有工程師可以手動重整）：
//   · 環境全部可注入（計時器 / rAF / fetch / document / reload / 時鐘 / 儲存），Node 用假物件測（見 resilience.test.mjs）。
//   · 預設環境（defaultEnv）在「呼叫當下」才從 globalThis 取值，而且一律包一層箭頭函式：瀏覽器的原生函式（setTimeout / fetch / rAF /
//     location.reload …）不能存成物件屬性再脫離原物件呼叫，否則 TypeError: Illegal invocation（Node 不檢查 this，所以測試要用「會檢查 this 的假環境」）。
//   · 所有自動重載（畫面錯誤 / WebGL 失效 / 看門狗）都寫進崩潰紀錄並走同一套退避與熔斷：10 分鐘內累積 5 次就停止「快速」重載，避免無限重載風暴。
//   · 熔斷是「半開」的：停止快速重載後排一次冷卻重試（最後一次致命事件起算 BREAKER_WINDOW_MS + 30 秒，讓舊紀錄滑出 10 分鐘視窗、重載後退避鏈重新從 5 秒開始），
//     到點自動重載一次，配合日後修好的部署把展場救回來；再崩潰就再走一輪。每個熔斷週期最多 5 次快速重試 + 1 次冷卻重試（約每 13 分鐘 ≤ 5 次重載），不會形成重載風暴。
//   · 這個檔案不含任何使用者看得到的文字（畫面文字在 ErrorBoundary.jsx / OpsSection.jsx / OpsLight.jsx，全走 t()）。
//   · 不 import store / three：ErrorBoundary 在入口 chunk 裡，手機遙控頁也要載它，必須保持輕量。
import { flagOn } from './urlFlags.js'
import { LS, loadLS, saveLS, removeLS } from './persist.js'

// ───────────────────────────── 常數 ─────────────────────────────
export const CRASH_MAX = 20                      // 崩潰紀錄環狀上限
export const STACK_MAX = 300                     // stack 只留前 300 字
export const MSG_MAX = 300
export const BACKOFF_MS = [5000, 15000, 60000]   // 第 1 次 5 秒；1 分鐘內第 2 次 15 秒、第 3 次（含以後）60 秒
export const CHAIN_WINDOW_MS = 60 * 1000         // 「1 分鐘內」
export const BREAKER_WINDOW_MS = 10 * 60 * 1000  // 「10 分鐘內」
export const BREAKER_MAX = 5                     // 累積 5 次就停止自動重載
export const INCIDENT_MS = 200                   // 同一瞬間（同一個任務裡）記下的多筆致命事件算一次事故：React 一次 render 可能有好幾個元件同時丟錯，各自呼叫一次邊界
export const GL_RESTORE_MS = 4000                // WebGL context 遺失後等多久沒 restore 就重載
export const GL_SCAN_MS = 2000                   // 多久重找一次 canvas（R3F 的 canvas 是非同步建立、也可能被換掉）
export const WATCHDOG_STALL_MS = 10000           // 分頁可見時超過這麼久沒有任何 rAF 回呼 → 卡死（內嵌預覽面板約 1fps，遠低於門檻）
export const WATCHDOG_CHECK_MS = 2000
export const WATCHDOG_STRIKES = 2                // 連續 2 次檢查都判定卡死才動作（主執行緒被長時間占住後計時器可能先於 rAF 回來）
export const VERSION_MS = 10 * 60 * 1000
export const VERSION_MS_KIOSK = 5 * 60 * 1000
export const DATA_MS = 3 * 60 * 60 * 1000
export const DATA_MS_KIOSK = 30 * 60 * 1000
export const HALF_OPEN_GRACE_MS = 30 * 1000      // 熔斷冷卻：比 BREAKER_WINDOW_MS 多等的緩衝（讓最後一筆致命紀錄確實滑出視窗）
export const HALF_OPEN_MS = BREAKER_WINDOW_MS + HALF_OPEN_GRACE_MS   // 熔斷後多久自動重試一次（10 分 30 秒）
export const IDLE_MIN_MS = 60 * 1000             // 「閒置」= 沒有人為輸入至少這麼久
export const REMOTE_PRESENCE_MS = 3 * 60 * 1000  // 手機遙控器（導覽員 / 玩家）最近一次「有效操作訊息」在這麼久之內 → 算有人在（不看連線數）
export const OPLIGHT_EVENT_MS = BREAKER_WINDOW_MS // 角落指示燈：崩潰紀錄近這麼久有事件 → 琥珀
export const PENDING_RETRY_MS = 15 * 1000        // 有新版 / 新資料在等閒置時，多久再看一次
export const DAILY_CHECK_MS = 30 * 1000          // ?reload=HH：多久檢查一次是否到點（用輪詢而非一個長計時器：休眠喚醒後也準）

export const FATAL_KINDS = new Set(['render', 'webgl', 'watchdog'])   // 會造成重載的事件（熔斷只算這些）；'error' / 'rejection' 只記錄，'reload' 是資訊性事件
export const BUILD_ID = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev'   // vite.config.js 的 define；dev / Node 為 'dev'
const BASE_URL = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || '/'
export const BOOT_ID = Math.random().toString(36).slice(2, 8)   // 這次載入的識別（崩潰紀錄用來合併「同一次載入內」重複的錯誤）

// ───────────────────────────── 小工具 ─────────────────────────────
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const safe = (fn, fb) => { try { return fn() } catch (e) { return fb } }
const clip = (v, n) => { let s = ''; try { s = v == null ? '' : String(v) } catch (e) { s = '' } return s.length > n ? s.slice(0, n) : s }
function hash32(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36) }
export const joinBase = (base, path) => `${base ? (String(base).endsWith('/') ? base : base + '/') : '/'}${String(path).replace(/^\/+/, '')}`

// ───────────────────────────── 網址旗標 → 設定 ─────────────────────────────
const OFF_RE = /^(0|false|off|no)$/i
const rawFlag = (search, name) => safe(() => new URLSearchParams(search || '').get(name), null)
export const flagOff = (search, name) => { const v = rawFlag(search, name); return v !== null && OFF_RE.test(v) }

// ?reload=HH（0–23）→ 小時；沒帶 / 不是 0–23 的整數 → null
export function parseReloadHour(search) {
  const v = rawFlag(search, 'reload')
  if (v === null || !/^\d{1,2}$/.test(v.trim())) return null
  const h = Number(v)
  return h >= 0 && h <= 23 ? h : null
}

// 目前是哪一種頁面（順序與 main.jsx 的路由一致：遙控頁 > 診斷頁 > 觀眾視窗 > 主畫面）
export function resolveMode(search, hash) {
  if (/^#remote=/.test(hash || '')) return 'remote'
  if (flagOn(search, 'diagnostics')) return 'diagnostics'
  if (flagOn(search, 'audience')) return 'audience'
  return 'main'
}

const FLAG_NAMES = ['kiosk', 'audience', 'diagnostics', 'watchdog', 'autoupdate', 'reload', 'tour', 'lang', 'quality', 'fps']
// 崩潰紀錄用的「網址旗標」摘要：只留已知的開關名稱與短值（分享連結的 ?s= 等長參數、遙控頁的 host id 都不記）
export function flagSummary(search, hash) {
  const out = []
  let q = null
  try { q = new URLSearchParams(search || '') } catch (e) { q = null }
  if (q) for (const k of FLAG_NAMES) if (q.has(k)) { const v = clip(q.get(k), 12).replace(/[^\w.-]/g, ''); out.push(v ? `${k}=${v}` : k) }
  if (/^#remote=/.test(hash || '')) out.push('remote')
  return clip(out.join(' '), 160)
}

// 依網址與 build id 算出「這個視窗要啟用哪些防呆」。
//   看門狗：只在展場模式（?kiosk）、觀眾視窗（?audience=1：投影機整天開著、卡死了沒人會發現）或明確 ?watchdog=1 啟用；?watchdog=0 一律關閉（一般使用者的背景 / 省電情境不會被誤重載）
//   版本檢查：正式建置一律檢查；有新版時的自動重載預設開（展場 / 閒置才動），?autoupdate=0 只記錄不重載；dev 建置不檢查
//   資料更新：展場 30 分鐘、一般 3 小時（一般只在頁面可見時）；觀眾視窗一律 30 分鐘（投影機整天開著，資料要跟得上展場的主視窗；它的網址不帶 ?kiosk）
export function resolveConfig({ search = '', hash = '', buildId = BUILD_ID } = {}) {
  const mode = resolveMode(search, hash)
  const kiosk = flagOn(search, 'kiosk')
  let watchdog
  if (flagOff(search, 'watchdog')) watchdog = { on: false, reason: 'flag-off' }
  else if (flagOn(search, 'watchdog')) watchdog = { on: true, reason: 'flag' }
  else if (kiosk) watchdog = { on: true, reason: 'kiosk' }
  else if (mode === 'audience') watchdog = { on: true, reason: 'audience' }
  else watchdog = { on: false, reason: 'default' }
  const dev = !buildId || buildId === 'dev'
  const autoOff = flagOff(search, 'autoupdate')
  const version = { check: !dev, auto: !dev && !autoOff, reason: dev ? 'dev' : autoOff ? 'flag-off' : kiosk ? 'kiosk' : 'idle', everyMs: kiosk ? VERSION_MS_KIOSK : VERSION_MS }
  const data = mode === 'audience' ? { everyMs: DATA_MS_KIOSK, visibleOnly: false } : { everyMs: kiosk ? DATA_MS_KIOSK : DATA_MS, visibleOnly: !kiosk }
  return { mode, kiosk, buildId, watchdog, version, data, reloadHour: parseReloadHour(search), flags: flagSummary(search, hash) }
}

// ───────────────────────────── 崩潰紀錄（環狀 + 去重）─────────────────────────────
// 把任何被丟出來的東西整理成 { name, message, stack }（stack 只留前 300 字）
export function errorInfo(err) {
  if (err && typeof err === 'object') {
    const name = clip(safe(() => err.name, ''), 60)
    let message = safe(() => (err.message != null ? String(err.message) : String(err)), '')
    if (name && name !== 'Error' && !message.startsWith(name)) message = `${name}: ${message}`
    return { name, message: clip(message, MSG_MAX), stack: clip(safe(() => err.stack, ''), STACK_MAX) }
  }
  return { name: '', message: clip(err, MSG_MAX), stack: '' }
}

// 同一個錯誤 = 同一種事件 + 同一段訊息 + 同一段 stack → 同一個簽章
export const crashSignature = (kind, message, stack) => `${kind}:${hash32(`${message}\n${stack}`)}`

function sanitizeEntry(e) {
  if (!e || typeof e !== 'object' || !isNum(e.t)) return null
  const kind = clip(e.kind || 'error', 20)
  return {
    t: e.t, last: isNum(e.last) ? e.last : e.t, kind, msg: clip(e.msg, MSG_MAX), stack: clip(e.stack, STACK_MAX),
    build: clip(e.build, 60), flags: clip(e.flags, 160), boot: clip(e.boot, 16), sig: clip(e.sig, 40),
    n: isNum(e.n) && e.n >= 1 ? Math.floor(e.n) : 1, fatal: FATAL_KINDS.has(kind),
  }
}
export function sanitizeList(v, max = CRASH_MAX) {
  if (!Array.isArray(v)) return []
  return v.map(sanitizeEntry).filter(Boolean).slice(-max)
}

// 預設儲存：localStorage（見 persist.js 的 LS.crashes）；隱私模式丟例外時 persist 會吞掉，讀回空陣列
export function defaultCrashStorage() {
  return {
    load: () => loadLS(LS.crashes, []),
    save: (list) => saveLS(LS.crashes, list),
    clear: () => removeLS(LS.crashes),
  }
}

// 崩潰紀錄：{ add, list, clear, flush }。
//   · 環狀：最多 max 筆（新的擠掉舊的）。
//   · 去重：同一次載入（boot）內、同一個簽章的事件合併成一筆（n 加一、last 更新）——React StrictMode 下 componentDidCatch 可能呼叫兩次，
//     每幀都丟出的錯誤也不會把 20 筆環狀紀錄洗掉。合併的更新最多每 flushMs 寫一次儲存，中間的次數先記在記憶體（pagehide 時 flush）。
//   · 每次寫入都「先讀後寫」：主視窗與觀眾視窗共用同一份 localStorage，不互相覆蓋。
export function createCrashLog({ storage = defaultCrashStorage(), now = () => Date.now(), boot = BOOT_ID, max = CRASH_MAX, flushMs = 2000 } = {}) {
  const pending = new Map()   // key → { n, last }：還沒寫進儲存的重複次數
  const wrote = new Map()     // key → 上次寫入時間
  const load = () => sanitizeList(safe(() => storage.load(), []), max)
  const save = (list) => { try { storage.save(list) } catch (e) { /* 儲存失敗（隱私模式 / 額滿）不影響頁面 */ } }
  const keyOf = (sig) => `${boot}|${sig}`

  function add(input = {}) {
    const t = now()
    const kind = clip(input.kind || 'error', 20)
    const info = input.error !== undefined ? errorInfo(input.error) : { message: clip(input.message, MSG_MAX), stack: clip(input.stack, STACK_MAX) }
    const sig = crashSignature(kind, info.message, info.stack)
    const key = keyOf(sig)
    if (wrote.has(key) && t - wrote.get(key) < flushMs) {   // 剛寫過同一筆：只在記憶體累計
      const p = pending.get(key) || { n: 0, last: t }
      p.n++; p.last = t; pending.set(key, p)
      return { entry: null, isNew: false, coalesced: true }
    }
    const list = load()
    const extra = pending.get(key) ? pending.get(key).n : 0
    let entry = null
    for (let i = list.length - 1; i >= 0; i--) if (list[i].boot === boot && list[i].sig === sig) { entry = list[i]; break }
    const isNew = !entry
    if (entry) { entry.n += 1 + extra; entry.last = t }
    else {
      entry = { t, last: t, kind, msg: info.message, stack: info.stack, build: clip(input.build != null ? input.build : BUILD_ID, 60), flags: clip(input.flags, 160), boot, sig, n: 1 + extra, fatal: FATAL_KINDS.has(kind) }
      list.push(entry)
      while (list.length > max) list.shift()
    }
    save(list)
    wrote.set(key, t); pending.delete(key)
    return { entry, isNew, coalesced: !isNew }
  }
  function flush() {
    if (!pending.size) return
    const list = load()
    for (const [key, p] of pending) {
      const e = list.find((x) => keyOf(x.sig) === key && x.boot === boot)
      if (e) { e.n += p.n; e.last = p.last }
    }
    pending.clear()
    save(list)
  }
  return {
    add, flush,
    list: () => load(),
    clear: () => { pending.clear(); wrote.clear(); try { storage.clear() } catch (e) { /* ignore */ } },
  }
}

let sharedLog = null
export function getCrashLog() { return sharedLog || (sharedLog = createCrashLog()) }

// 給面板用：總筆數（不含資訊性的 reload 事件）/ 近 10 分鐘內造成重載的次數
export function summarizeCrashes(entries, now = Date.now()) {
  const list = Array.isArray(entries) ? entries : []
  return {
    total: list.filter((e) => e.kind !== 'reload').length,
    fatal10: list.filter((e) => e.fatal && now - e.t <= BREAKER_WINDOW_MS).length,
  }
}

// ───────────────────────────── 自動重載：退避 + 熔斷 ─────────────────────────────
// entries：崩潰紀錄（含剛記下的這一筆）；只算 fatal 的（畫面錯誤 / WebGL 失效 / 看門狗）。
//   10 分鐘內累積 5 次 → 停止快速重載（stop:true），並附上 cooldownMs：熔斷是「半開」的，冷卻到點（最後一次致命事件起算 10 分 30 秒）自動再重載一次；
//   否則依「1 分鐘內」的次數決定等待：1 次 5 秒、2 次 15 秒、3 次以上 60 秒；10 分鐘內第 4 次也一律 60 秒（最後一次機會，別再快速重試）。
// 把 INCIDENT_MS 內連續記下的致命事件併成一筆：一次崩潰不能被算成兩次（否則退避直接跳 15 秒、熔斷提早在第 3 次真的崩潰就停手）
function collapseIncidents(list) {
  const sorted = [...list].sort((a, b) => a.t - b.t)
  const out = []
  for (const e of sorted) if (!out.length || e.t - out[out.length - 1].t > INCIDENT_MS) out.push(e)
  return out
}
// 熔斷後多久重試：最後一次致命事件起算 HALF_OPEN_MS（= 視窗 + 30 秒，那時視窗內已沒有任何舊的致命紀錄，重載後的退避鏈重新從 5 秒開始）。
// 不會比 HALF_OPEN_MS 長（時鐘被往回調時不無限等）；正常情況剛崩潰的那一刻就是 HALF_OPEN_MS。
function cooldownFor(fatal, now) {
  let last = -Infinity
  for (const e of fatal) if (e.t > last) last = e.t
  if (!Number.isFinite(last)) return HALF_OPEN_MS
  return Math.min(HALF_OPEN_MS, Math.max(0, last + HALF_OPEN_MS - now))
}
// 冷卻倒數的分鐘數（顯示用，至少 1；分鐘級、進位）
export const minutesLeft = (ms) => Math.max(1, Math.ceil((Number(ms) || 0) / 60000))
export const cooldownMinutes = (retryAt, now = Date.now()) => (isNum(retryAt) ? minutesLeft(retryAt - now) : 1)
export function planAutoReload(entries, now = Date.now()) {
  const fatal = collapseIncidents((Array.isArray(entries) ? entries : []).filter((e) => e && e.fatal && isNum(e.t)))
  const in10 = fatal.filter((e) => now - e.t <= BREAKER_WINDOW_MS)
  const in1 = in10.filter((e) => now - e.t <= CHAIN_WINDOW_MS)
  const count10 = in10.length, count1 = in1.length
  if (count10 >= BREAKER_MAX) return { stop: true, delayMs: null, cooldownMs: cooldownFor(fatal, now), count1, count10 }
  let delayMs = BACKOFF_MS[Math.min(Math.max(count1, 1), BACKOFF_MS.length) - 1]
  if (count10 >= BREAKER_MAX - 1) delayMs = Math.max(delayMs, BACKOFF_MS[BACKOFF_MS.length - 1])
  return { stop: false, delayMs, count1, count10 }
}
// 各種事件實際等多久再重載：畫面錯誤顯示倒數（用 plan 的等待）；WebGL 失效 / 看門狗本來就已經等過了，一開始直接重載，短時間內反覆發生（1 分鐘內第 2 次、或 10 分鐘內第 4 次）才套退避
export function reloadDelayFor(kind, plan) {
  if (!plan || plan.stop) return null
  if (kind === 'render') return plan.delayMs
  return plan.count1 <= 1 && plan.count10 < BREAKER_MAX - 1 ? 0 : plan.delayMs
}

// ───────────────────────────── 渲染看門狗 ─────────────────────────────
// 純判斷：off = 未啟用 · hidden = 分頁不可見（不判定；瀏覽器本來就會停 rAF）· stalled = 可見卻超過 stallMs 沒有 rAF · ok
// 從「分頁變可見」的那一刻起算：不會因為背景時沒有 rAF 而在切回來的瞬間誤判。
export function watchdogVerdict({ enabled, visible, now, lastFrameAt, visibleSince, stallMs = WATCHDOG_STALL_MS }) {
  if (!enabled) return 'off'
  if (!visible) return 'hidden'
  const ref = Math.max(isNum(lastFrameAt) ? lastFrameAt : 0, isNum(visibleSince) ? visibleSince : 0)
  return now - ref > stallMs ? 'stalled' : 'ok'
}

// ───────────────────────────── 版本 / 資料 比較 ─────────────────────────────
export function parseVersion(v) {
  if (!v || typeof v !== 'object') return null
  const id = typeof v.id === 'string' ? v.id.trim() : ''
  if (!id || id.length > 80) return null
  return { id, builtAt: typeof v.builtAt === 'string' ? v.builtAt : '' }
}
// 'skip'：本機是 dev 建置（不比對）· 'unknown'：遠端資料無效 · 'same' · 'new'
export function compareVersion(localId, remote) {
  if (!localId || localId === 'dev') return 'skip'
  const r = parseVersion(remote)
  if (!r) return 'unknown'
  return r.id === localId ? 'same' : 'new'
}

const timeOf = (s) => { if (isNum(s)) return s; const t = Date.parse(String(s == null ? '' : s)); return Number.isFinite(t) ? t : null }
// 'newer'：遠端較新 · 'same' · 'older' · 'unknown'：遠端沒有可用的時間戳（不採用）。本機沒有時間戳 → 遠端較新（有資料勝過沒資料）
export function compareData(localFetchedAt, remoteFetchedAt) {
  const r = timeOf(remoteFetchedAt)
  if (r === null) return 'unknown'
  const l = timeOf(localFetchedAt)
  if (l === null) return 'newer'
  return r > l ? 'newer' : r < l ? 'older' : 'same'
}
// 和 lib/govdata.js 的 loadOceanData 同一個標準：有 params 或非空的 options
export function isValidOcean(d) { return !!d && typeof d === 'object' && !!(d.params || (Array.isArray(d.options) && d.options.length)) }
// 換資料時保留使用者目前選的海況選項（新資料裡還找得到才算），否則用資料的預設。不動任何參數。
export function pickOptionId(gov, wantedId) {
  const opts = gov && Array.isArray(gov.options) ? gov.options : []
  if (wantedId && opts.some((o) => o && o.id === wantedId)) return wantedId
  return (gov && (gov.defaultOption || (opts[0] && opts[0].id))) || null
}

// ───────────────────────────── 閒置判斷 ─────────────────────────────
// state：{ idleMs（距離最後一次人為輸入 / 導覽員操作）, remoteIdleMs?（距離手機遙控器最後一次有效操作訊息）, recMode, tourRunning, tourAuto, modalOpen, xrActive?, fullscreen? }。
// busy 的原因依序：彈窗 > XR 工作階段 > 全螢幕（觀眾視窗）> 有人操作 > 遙控器使用中 > 錄製 > 導覽 > 播放。
//   · remote：手機遙控器（導覽員在講解、玩家在玩）REMOTE_PRESENCE_MS（3 分鐘）內有「有效的操作訊息」（參數 / 動作 / 打擊墊 / 導覽員指令；連線、心跳、狀態同步不算，
//     見 lib/remoteDispatch.js 的 remoteActivity）。判斷的是「最近有訊息」而不是連線數——桌上一支沒關頁面的手機會讓連線數永遠大於 0，展場就永遠等不到閒置。
//     排在 active 之後：本機 60 秒內有輸入時，原因回報較直接的「有人操作中」；本機已閒置但遙控器還在動，才回報 remote。排在錄製 / 導覽 / 播放之前，
//     而且展場（kiosk）也適用——那是真人在操作，不是展場常態的自動導覽 / 播放。沒帶 remoteIdleMs 的環境（觀眾視窗等）不受影響。
//   · xrActive：手機正在 immersive-ar 看桌上的海，可能整段沒有任何輸入；重載會直接結束 XR 工作階段。展場（kiosk）也不放行——XR 一定是使用者主動開的。
//   · fullscreen：只有觀眾視窗會帶（投影機的 requestFullscreen 全螢幕）。重載會退出全螢幕，而回去要有人走到投影機前點一下（瀏覽器不准腳本自己進全螢幕）→ 全螢幕中延後「重載」。
//     資料更新是就地換資料（不重載），不受它影響（見 startGuards 的 getDataIdle）。
// 展場（kiosk）或「閒置自動啟動的導覽」本來就是沒人時的常態（自動導覽會無限循環、播放序列）：不算忙，否則展場永遠等不到閒置。
export const DEFAULT_IDLE_STATE = { idleMs: Infinity, remoteIdleMs: Infinity, recMode: 'idle', tourRunning: false, tourAuto: false, modalOpen: false, xrActive: false, fullscreen: false }
export function evaluateIdle(state, { kiosk = false, minIdleMs = IDLE_MIN_MS, remotePresenceMs = REMOTE_PRESENCE_MS } = {}) {
  const s = state || {}
  if (s.modalOpen) return { idle: false, reason: 'modal' }
  if (s.xrActive) return { idle: false, reason: 'xr' }
  if (s.fullscreen) return { idle: false, reason: 'fullscreen' }
  if (!(Number(s.idleMs) >= minIdleMs)) return { idle: false, reason: 'active' }
  if (s.remoteIdleMs != null && Number(s.remoteIdleMs) < remotePresenceMs) return { idle: false, reason: 'remote' }   // NaN < x 為 false：壞資料不會讓展場永遠忙
  if (s.recMode === 'recording') return { idle: false, reason: 'recording' }
  const autoTour = !!s.tourRunning && (!!kiosk || !!s.tourAuto)
  if (s.tourRunning && !autoTour) return { idle: false, reason: 'tour' }
  if (s.recMode === 'playing' && !autoTour) return { idle: false, reason: 'playing' }
  return { idle: true, reason: '' }
}

// 把各處讀到的「原始訊號」組成 evaluateIdle 要的狀態（純函式，Node 可測；services/ResilienceService.jsx 的 readIdleState 負責讀真實來源，每個來源各自 try/catch）。
// 三個時間戳同一個時鐘（performance.now）：lastInputAt = activity.last（人為輸入）、guideAt = activity.guideAt（導覽員在本機的操作）、remoteAt = remoteActivity.at（手機遙控器的有效操作訊息）。
//   · idleMs = now - max(lastInputAt, guideAt)；讀不到本機輸入時間 → 0（保守：當作有人在）。
//   · remoteIdleMs：沒有遙控器訊息 / 讀不到 → Infinity（沒有這個訊號；不是保守的「忙」——否則介面一改壞、展場就永遠不重載）。
export function composeIdleState({ now, lastInputAt, guideAt, remoteAt, recMode = 'idle', tourRunning = false, tourAuto = false, modalOpen = false, xrActive = false } = {}) {
  const guide = isNum(guideAt) ? guideAt : -Infinity
  const idleMs = isNum(now) && isNum(lastInputAt) ? now - Math.max(lastInputAt, guide) : 0
  const remoteIdleMs = isNum(now) && isNum(remoteAt) ? Math.max(0, now - remoteAt) : Infinity
  return { idleMs, remoteIdleMs, recMode, tourRunning: !!tourRunning, tourAuto: !!tourAuto, modalOpen: !!modalOpen, xrActive: !!xrActive }
}

// ?reload=HH：下一次「本地時間 hour:00」（嚴格晚於 now）
export function nextReloadAt(hour, now = Date.now()) {
  const d = new Date(now)
  d.setHours(hour, 0, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}

// ───────────────────────────── 維運狀態（給 OpsSection / 提示訂閱）─────────────────────────────
export function createStatusStore(initial) {
  let state = initial
  const subs = new Set()
  const api = {
    get: () => state,
    set(patch) {
      const next = { ...state, ...patch }
      if (Object.keys(next).every((k) => next[k] === state[k])) return
      state = next
      for (const f of [...subs]) { try { f() } catch (e) { /* 訂閱者出錯不影響其他人 */ } }
    },
    patch(key, obj) { api.set({ [key]: { ...(state[key] || {}), ...obj } }) },   // 合併進某個子物件
    subscribe(f) { subs.add(f); return () => { subs.delete(f) } },
  }
  return api
}
export function initialStatus(now = Date.now()) {
  return {
    bootAt: now, started: false, config: null,
    version: { state: 'idle', checkedAt: 0, remoteId: '', deferred: '' },   // state：idle | off | same | new | error
    data: { state: 'idle', checkedAt: 0, remoteFetchedAt: '', appliedAt: 0, deferred: '' },   // state：idle | off | same | pending | applied | error
    gl: { state: 'idle', at: 0 },                                           // state：idle | lost | restored | reloading
    watchdog: { on: false, supported: true, reason: '', stalled: false },
    daily: { hour: null, at: 0 },
    halted: false,                                                          // 熔斷：短時間內反覆異常，已停止「快速」自動重載（半開：haltRetryAt 到點還會自動重載一次）
    haltRetryAt: 0,                                                         // 熔斷後排定的冷卻重試時間（env.now() 時鐘的毫秒；0 = 沒有排定）
    reloading: null,                                                        // { reason, at }：已排定的重載（reason：webgl / watchdog / version / daily / cooldown）
    crashRev: 0,                                                            // 崩潰紀錄有新增時遞增
    oplightRev: 0,                                                          // 角落指示燈偏好（LS.oplight）有變動時遞增（讓訂閱者重讀偏好）
  }
}
export const opsStatus = createStatusStore(initialStatus())
export const guardControls = { current: null }   // 目前執行中的 startGuards 控制把手（面板的「立即檢查更新」用）

// ───────────────────────────── 展場角落指示燈（ui/OpsLight.jsx）─────────────────────────────
// 純判斷：把維運狀態（opsStatus）+ 崩潰紀錄 → { level, items }，畫面文字由 OpsLight.jsx 依 items 的 code 用 t() 組出來（這個檔案不放使用者看得到的文字）。
//   level：'bad'（紅）看門狗判定卡死 / WebGL 遺失中 / 熔斷停止快速重載（halted）/ 即將重載
//          'warn'（琥珀）新版在等閒置 / 新資料排隊中 / 崩潰紀錄近 10 分鐘有事件（遙控器使用中延後重載 = 等閒置的原因之一，帶在 why 裡）
//          'off'（灰）防呆未啟用（尚未啟動 / 開發版；沒有更糟的事情時才顯示灰）
//          'ok'（綠）一切正常。
//   items 依嚴重程度排序（第一項就是最該看的那一行）；code：halted{m} halted-manual reloading{reason} stalled gl-lost version-wait{id,why} version-soon{id} version-manual{id} data-wait{why} events{n} ok off off-dev
// 崩潰紀錄的「事件」：不含資訊性的 reload（新版 / 每日 / 冷卻重載）；以 last（最後一次發生）或 t 較晚者為準。
export function recentEventCount(entries, now = Date.now(), windowMs = OPLIGHT_EVENT_MS) {
  let n = 0
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.kind === 'reload') continue
    const at = Math.max(isNum(e.t) ? e.t : 0, isNum(e.last) ? e.last : 0)
    if (at > 0 && now - at <= windowMs) n++   // 時鐘被往回調（時間戳在未來）也算「剛剛」
  }
  return n
}
export function deriveOpsLight({ status, entries = [], now = Date.now() } = {}) {
  const st = status || {}
  const cfg = st.config || null
  const bad = [], warn = []
  if (st.halted) bad.push(isNum(st.haltRetryAt) && st.haltRetryAt > 0 ? { code: 'halted', m: cooldownMinutes(st.haltRetryAt, now) } : { code: 'halted-manual' })
  if (st.reloading) bad.push({ code: 'reloading', reason: String(st.reloading.reason || '') })
  if (st.watchdog && st.watchdog.stalled) bad.push({ code: 'stalled' })
  if (st.gl && (st.gl.state === 'lost' || st.gl.state === 'reloading')) bad.push({ code: 'gl-lost' })
  const v = st.version || {}
  if (v.state === 'new') {
    const id = String(v.remoteId || '')
    if (cfg && cfg.version && cfg.version.auto === false) warn.push({ code: 'version-manual', id })
    else if (v.deferred) warn.push({ code: 'version-wait', id, why: String(v.deferred) })
    else warn.push({ code: 'version-soon', id })
  }
  const d = st.data || {}
  if (d.state === 'pending') warn.push({ code: 'data-wait', why: String(d.deferred || '') })
  const n = recentEventCount(entries, now)
  if (n > 0) warn.push({ code: 'events', n })
  if (bad.length) return { level: 'bad', items: [...bad, ...warn] }
  if (warn.length) return { level: 'warn', items: warn }
  if (!st.started || !cfg) return { level: 'off', items: [{ code: 'off' }] }
  if (cfg.version && cfg.version.reason === 'dev') return { level: 'off', items: [{ code: 'off-dev' }] }
  return { level: 'ok', items: [{ code: 'ok' }] }
}

// 顯示偏好：?oplight=1 / 0 只覆寫這一次（不寫偏好）> LS.oplight（'on' | 'off'，「裝置」面板的開關寫的）> 預設（展場 ?kiosk 顯示、一般不顯示）。
// 回傳 { show, source: 'flag' | 'pref' | 'default' }。?oplight（沒有值）視為開，與 urlFlags 的其他旗標一致。
export function resolveOpLightPref({ search = '', saved = null, kiosk = false } = {}) {
  const raw = rawFlag(search, 'oplight')
  if (raw !== null) return { show: !OFF_RE.test(raw), source: 'flag' }
  if (saved === 'on' || saved === 'off') return { show: saved === 'on', source: 'pref' }
  return { show: !!kiosk, source: 'default' }
}
export function readOpLightSaved() { const v = loadLS(LS.oplight, null); return v === 'on' || v === 'off' ? v : null }
export function setOpLightPref(value, status = opsStatus) {
  if (value !== 'on' && value !== 'off') return false
  saveLS(LS.oplight, value)
  status.set({ oplightRev: (status.get().oplightRev || 0) + 1 })
  return true
}

// ───────────────────────────── 環境（可注入）─────────────────────────────
// 呼叫當下才取 globalThis；原生函式一律包一層（脫離原物件呼叫會 Illegal invocation）；缺的功能給 null（功能偵測在使用之前）。
export function defaultEnv() {
  const g = globalThis
  return {
    win: g.window || null,
    doc: g.document || null,
    search: safe(() => g.location.search, ''),
    hash: safe(() => g.location.hash, ''),
    baseUrl: BASE_URL,
    now: () => Date.now(),
    setTimeout: (fn, ms) => g.setTimeout(fn, ms),
    clearTimeout: (id) => g.clearTimeout(id),
    setInterval: (fn, ms) => g.setInterval(fn, ms),
    clearInterval: (id) => g.clearInterval(id),
    raf: typeof g.requestAnimationFrame === 'function' ? (cb) => g.requestAnimationFrame(cb) : null,
    caf: typeof g.cancelAnimationFrame === 'function' ? (id) => g.cancelAnimationFrame(id) : null,
    fetch: typeof g.fetch === 'function' ? (url, init) => g.fetch(url, init) : null,
    reload: () => { g.location.reload() },
    idleState: () => DEFAULT_IDLE_STATE,     // 主畫面由 ResilienceService 換成讀 store / activity 的版本；觀眾視窗由 audienceEnv() 換成「永遠閒置、但全螢幕中不放行重載」
    getLocalFetchedAt: null,                 // 主畫面：() => 目前 store.gov 的 fetchedAt
    applyData: null,                         // 主畫面：(gov) => 換掉 store.gov（不動海況與參數）；沒有 → 不做資料更新
    onDataApplied: null,                     // 主畫面：(gov) => 寫一行 OUT 日誌
  }
}

// 觀眾視窗的防呆環境（ErrorBoundary 啟動它；入口 chunk 不能 import store，所以「怎麼換資料」由 AudienceApp 掛載後才用 registerDataHooks 註冊進來）。
//   · 閒置：沒有人為輸入 → 永遠閒置，但「DOM 全螢幕中」不放行重載（見 evaluateIdle 的 fullscreen）。
//   · 資料：觀眾視窗只在自己載入時抓一次 ocean.json；建置 id 只反映程式碼（vite.config.js），純資料的部署不會讓它重載——所以要自己定時就地換資料，才不會跟主視窗顯示不同的數值。
export const dataHooks = { apply: null, getLocalFetchedAt: null, onApplied: null }
export function registerDataHooks(h) {
  const mine = { apply: null, getLocalFetchedAt: null, onApplied: null, ...(h || {}) }
  Object.assign(dataHooks, mine)
  return () => { if (dataHooks.apply === mine.apply && dataHooks.getLocalFetchedAt === mine.getLocalFetchedAt) Object.assign(dataHooks, { apply: null, getLocalFetchedAt: null, onApplied: null }) }
}
export function isFullscreen(doc = globalThis.document) {
  try { return !!(doc && (doc.fullscreenElement || doc.webkitFullscreenElement)) } catch (e) { return false }
}
export function audienceEnv({ doc } = {}) {
  return {
    idleState: () => ({ ...DEFAULT_IDLE_STATE, fullscreen: isFullscreen(doc || globalThis.document) }),
    getLocalFetchedAt: () => (typeof dataHooks.getLocalFetchedAt === 'function' ? dataHooks.getLocalFetchedAt() : null),
    applyData: (d) => { if (typeof dataHooks.apply !== 'function') throw new Error('audience data applier is not registered yet'); dataHooks.apply(d) },
    onDataApplied: (d) => { if (typeof dataHooks.onApplied === 'function') dataHooks.onApplied(d) },
  }
}

const isVisible = (doc) => !doc || doc.visibilityState === undefined || doc.visibilityState === 'visible'

// ───────────────────────────── 重載器：記錄 + 退避 / 熔斷 + 單次飛行 ─────────────────────────────
//   熔斷（10 分鐘內累積 5 次致命事件）是「半開」的：停止快速重載後，排一次冷卻重試（plan.cooldownMs = 最後一次致命事件起算 10 分 30 秒），到點自動重載一次（寫一筆資訊性的 'cooldown' 紀錄）。
//   · 冷卻計時器與「已排定的異常重載」（timer）分開：halted 期間 ResilienceService 仍掛載，版本檢查繼續跑——偵測到新版且閒置就直接 soft('version') 重載，不必等冷卻。
//   · 熔斷期間又有新的致命事件 → 冷卻重新從那一筆起算（10 分鐘內都沒有新事件才試一次，退避鏈才會真的重新從頭）。
//   · 冷卻到點時若 halted 已被人工解除（維運面板「清除崩潰紀錄」）→ 不重載。
//   · cancel() 一併取消冷卻（停止防呆 / 卸載時）；重載後新頁面的崩潰紀錄視窗重新計算：最後一筆致命事件已超過 10 分鐘，退避鏈從 5 秒開始。
export function createReloader({ env, status, crashLog, cfg }) {
  let timer = null, coolTimer = null, fired = false
  const fire = () => { timer = null; fired = true; try { env.reload() } catch (e) { fired = false } }
  const clearCool = () => { if (coolTimer !== null) { env.clearTimeout(coolTimer); coolTimer = null } }
  function soft(reason) {
    if (timer !== null || fired) return false
    try { crashLog.add({ kind: 'reload', message: reason, build: cfg.buildId, flags: cfg.flags }); crashLog.flush() } catch (e) { /* ignore */ }
    status.set({ crashRev: status.get().crashRev + 1, reloading: { reason, at: env.now() } })
    fire()
    return true
  }
  const onCooldown = () => {
    coolTimer = null
    if (fired || timer !== null || !status.get().halted) return
    soft('cooldown')
  }
  function armCooldown(ms) {
    clearCool()
    const wait = isNum(ms) && ms >= 0 ? ms : HALF_OPEN_MS
    coolTimer = env.setTimeout(onCooldown, wait)
    status.set({ halted: true, haltRetryAt: env.now() + wait })
    return wait
  }
  return {
    // 異常重載（kind：'webgl' | 'watchdog'）。回傳 { ok, halted?, delayMs?, cooldownMs?, already? }
    crash(kind, error) {
      if (timer !== null || fired) return { ok: true, already: true }
      try { crashLog.add({ kind, error, build: cfg.buildId, flags: cfg.flags }) } catch (e) { /* ignore */ }
      status.set({ crashRev: status.get().crashRev + 1 })
      const plan = planAutoReload(safe(() => crashLog.list(), []), env.now())
      if (plan.stop) { const cooldownMs = armCooldown(plan.cooldownMs); return { ok: false, halted: true, cooldownMs, plan } }
      const delayMs = reloadDelayFor(kind, plan)
      status.set({ reloading: { reason: kind, at: env.now() + delayMs } })
      if (delayMs <= 0) fire()
      else timer = env.setTimeout(fire, delayMs)
      return { ok: true, delayMs, plan }
    },
    // 一般重載（新版 / 每日 / 熔斷冷卻）：資訊性紀錄，立刻重載，不受熔斷影響（這些不是崩潰，且一天只會有零星幾次；冷卻重試每個熔斷週期最多一次）
    soft,
    cancel() {
      if (timer !== null) { env.clearTimeout(timer); timer = null; status.set({ reloading: null }) }
      if (coolTimer !== null) { clearCool(); status.set({ haltRetryAt: 0 }) }
    },
    pending: () => timer !== null,
    cooling: () => coolTimer !== null,
  }
}

// ───────────────────────────── WebGL context 遺失復原 ─────────────────────────────
const CANVAS_SCOPE = '.canvas-wrap canvas, .aud-scene canvas'   // 主畫面 / 觀眾視窗的場景 canvas
export function findSceneCanvas(doc) {
  const list = safe(() => doc.querySelectorAll(CANVAS_SCOPE), null)
  if (!list || !list.length) return null
  // three 會在自己的 canvas 上標 data-engine；優先用它（畫布區也可能有 QR code 的 2D canvas）
  for (let i = 0; i < list.length; i++) if (list[i] && list[i].getAttribute && list[i].getAttribute('data-engine')) return list[i]
  return list[0]
}
// 找到 canvas 後監聽 webglcontextlost（preventDefault，讓瀏覽器有機會 restore）與 webglcontextrestored；
// 遺失後 restoreMs 內沒 restore → onGiveUp（重新載入；分頁在背景時等回到前景再計）。每 scanMs 重找一次 canvas（被換掉就重新綁）。
export function createGlGuard({ env, status, onGiveUp, restoreMs = GL_RESTORE_MS, scanMs = GL_SCAN_MS }) {
  const doc = env.doc
  if (!doc || typeof doc.querySelectorAll !== 'function') return { stop() {}, supported: false }
  let canvas = null, timer = null, stopped = false, waitingVisible = false
  const clear = () => { if (timer !== null) { env.clearTimeout(timer); timer = null } waitingVisible = false }
  const arm = () => {
    clear()
    timer = env.setTimeout(() => {
      timer = null
      if (stopped) return
      // 背景分頁：瀏覽器要等分頁回到前景才會 restore（記憶體被回收時很常見）→ 不在背景重載，回到前景後再給一次機會
      if (!isVisible(doc)) { waitingVisible = true; return }
      status.patch('gl', { state: 'reloading', at: env.now() })
      onGiveUp()
    }, restoreMs)
  }
  const onLost = (ev) => {
    try { if (ev && typeof ev.preventDefault === 'function') ev.preventDefault() } catch (e) { /* ignore */ }
    status.patch('gl', { state: 'lost', at: env.now() })
    arm()
  }
  const onRestored = () => { clear(); status.patch('gl', { state: 'restored', at: env.now() }) }
  const onVis = () => { if (waitingVisible && isVisible(doc)) arm() }
  doc.addEventListener('visibilitychange', onVis)
  const unbind = () => {
    if (!canvas) return
    canvas.removeEventListener('webglcontextlost', onLost, false)
    canvas.removeEventListener('webglcontextrestored', onRestored, false)
    canvas = null
  }
  const scan = () => {
    const c = findSceneCanvas(doc)
    if (c === canvas) return
    unbind()
    if (status.get().gl.state === 'lost') { clear(); status.patch('gl', { state: 'idle', at: env.now() }) }   // 舊 canvas 被換掉：新 canvas 是新的 context
    if (c) {
      canvas = c
      c.addEventListener('webglcontextlost', onLost, false)
      c.addEventListener('webglcontextrestored', onRestored, false)
    }
  }
  scan()
  const iv = env.setInterval(scan, scanMs)
  return {
    supported: true, current: () => canvas,
    stop() { stopped = true; clear(); env.clearInterval(iv); doc.removeEventListener('visibilitychange', onVis); unbind() },
  }
}

// ───────────────────────────── 渲染看門狗（rAF 心跳）─────────────────────────────
// 自己掛一個 rAF 迴圈只記時間戳（每幀只有一次賦值，不碰場景）；每 checkMs 檢查一次。
// 連續 strikes 次檢查都是 stalled 才動作，且只動作一次（之後由重載器的熔斷接手）。
export function createWatchdog({ env, status, onStall, stallMs = WATCHDOG_STALL_MS, checkMs = WATCHDOG_CHECK_MS, strikes = WATCHDOG_STRIKES }) {
  const doc = env.doc
  if (!doc || typeof env.raf !== 'function') return { stop() {}, supported: false }
  let stopped = false, fired = false, bad = 0, rafId = null
  let lastFrame = env.now()
  let visibleSince = isVisible(doc) ? env.now() : 0
  const loop = () => {
    if (stopped) return
    lastFrame = env.now()
    rafId = env.raf(loop)
  }
  rafId = env.raf(loop)
  const onVis = () => { if (isVisible(doc)) { visibleSince = env.now(); bad = 0 } }
  doc.addEventListener('visibilitychange', onVis)
  const iv = env.setInterval(() => {
    if (stopped || fired) return
    const now = env.now()
    const v = watchdogVerdict({ enabled: true, visible: isVisible(doc), now, lastFrameAt: lastFrame, visibleSince, stallMs })
    if (v !== 'stalled') { bad = 0; return }
    if (++bad < strikes) return
    fired = true
    status.patch('watchdog', { stalled: true })
    onStall({ stalledMs: now - Math.max(lastFrame, visibleSince) })
  }, checkMs)
  return {
    supported: true,
    stop() {
      stopped = true
      env.clearInterval(iv)
      if (rafId !== null && typeof env.caf === 'function') { try { env.caf(rafId) } catch (e) { /* ignore */ } }
      doc.removeEventListener('visibilitychange', onVis)
    },
  }
}

// ───────────────────────────── 輪詢器（頁面不可見時可延後）─────────────────────────────
export function createPoller({ env, everyMs, run, visibleOnly = false }) {
  let stopped = false, running = false, dueWhileHidden = false
  const fire = () => {
    if (stopped || running) return Promise.resolve()
    running = true
    return Promise.resolve().then(run).catch(() => {}).then(() => { running = false })
  }
  const iv = env.setInterval(() => {
    if (visibleOnly && !isVisible(env.doc)) { dueWhileHidden = true; return }
    dueWhileHidden = false
    fire()
  }, everyMs)
  const onVis = () => { if (dueWhileHidden && isVisible(env.doc)) { dueWhileHidden = false; fire() } }
  if (env.doc) env.doc.addEventListener('visibilitychange', onVis)
  return {
    runNow: fire,
    stop() { stopped = true; env.clearInterval(iv); if (env.doc) env.doc.removeEventListener('visibilitychange', onVis) },
  }
}

// ───────────────────────────── 版本檢查 ─────────────────────────────
// 每 everyMs 以 fetch('/version.json', { cache: 'no-store' }) 比對 build id；不同 = 有新版。
// 自動重載（cfg.version.auto）只在「展場 / 閒置」時；忙碌就每 PENDING_RETRY_MS 再看一次，只在維運狀態記錄、不打擾使用者。fetch 失敗（離線）靜默略過。
export function createVersionChecker({ env, status, cfg, reloader, getIdle }) {
  let stopped = false, retry = null, pendingId = ''
  const url = joinBase(env.baseUrl, 'version.json')
  const stopRetry = () => { if (retry !== null) { env.clearInterval(retry); retry = null } }
  function tryApply() {
    if (stopped || !pendingId || !cfg.version.auto) return
    const idle = getIdle()
    if (idle.idle) { stopRetry(); reloader.soft('version'); return }
    status.patch('version', { deferred: idle.reason })
    if (retry === null) retry = env.setInterval(tryApply, PENDING_RETRY_MS)
  }
  async function check() {
    if (stopped) return
    const fail = () => { if (!stopped) status.patch('version', pendingId ? { checkedAt: env.now() } : { state: 'error', checkedAt: env.now() }) }   // 已知有新版時，離線 / 失敗不蓋掉「有新版」
    let remote
    try {
      const res = await env.fetch(url, { cache: 'no-store' })
      if (!res || !res.ok) return fail()
      remote = await res.json()
    } catch (e) { return fail() }
    if (stopped) return
    const cmp = compareVersion(cfg.buildId, remote)
    const checkedAt = env.now()
    if (cmp === 'new') {
      pendingId = parseVersion(remote).id
      status.patch('version', { state: 'new', checkedAt, remoteId: pendingId, deferred: '' })
      tryApply()
    } else if (cmp === 'same') {
      pendingId = ''; stopRetry()
      status.patch('version', { state: 'same', checkedAt, remoteId: parseVersion(remote).id, deferred: '' })
    } else fail()
  }
  const poller = createPoller({ env, everyMs: cfg.version.everyMs, run: check })
  return { check: () => poller.runNow(), stop() { stopped = true; stopRetry(); poller.stop() } }
}

// ───────────────────────────── 資料更新 ─────────────────────────────
// 每 everyMs（展場 30 分鐘 / 一般 3 小時且頁面可見時）重抓 /data/ocean.json；fetchedAt 較新 → 交給 env.applyData 換掉 store 的 gov。
// applyData 由主畫面提供，必須「不動使用者目前的海況與參數」（只換資料、保留目前的海況選項，不呼叫 applyGov）。
// 忙碌（有人操作 / 錄製 / 資料播放 / 導覽 / 彈窗）時排到閒置再套。失敗靜默，下次再試。
export function createDataRefresher({ env, status, cfg, getIdle }) {
  let stopped = false, retry = null, pendingData = null
  const url = joinBase(env.baseUrl, 'data/ocean.json')
  const stopRetry = () => { if (retry !== null) { env.clearInterval(retry); retry = null } }
  function tryApply() {
    if (stopped || !pendingData) return
    const idle = getIdle()
    if (!idle.idle) {
      status.patch('data', { state: 'pending', deferred: idle.reason })
      if (retry === null) retry = env.setInterval(tryApply, PENDING_RETRY_MS)
      return
    }
    const d = pendingData
    try { env.applyData(d) } catch (e) { status.patch('data', { state: 'error', checkedAt: env.now() }); return }   // 套用失敗：保留 pending，下次檢查再試
    pendingData = null; stopRetry()
    status.patch('data', { state: 'applied', appliedAt: env.now(), remoteFetchedAt: String(d.fetchedAt || ''), deferred: '' })
    if (typeof env.onDataApplied === 'function') { try { env.onDataApplied(d) } catch (e) { /* ignore */ } }
  }
  async function check() {
    if (stopped) return
    const fail = () => { if (!stopped) status.patch('data', { state: 'error', checkedAt: env.now() }) }
    let d
    try {
      const res = await env.fetch(url, { cache: 'no-store' })
      if (!res || !res.ok) return fail()
      d = await res.json()
    } catch (e) { return fail() }
    if (stopped) return
    if (!isValidOcean(d)) return fail()
    const local = typeof env.getLocalFetchedAt === 'function' ? safe(() => env.getLocalFetchedAt(), null) : null
    const cmp = compareData(local, d.fetchedAt)
    const checkedAt = env.now()
    if (cmp === 'newer') {
      pendingData = d
      status.patch('data', { state: 'pending', checkedAt, remoteFetchedAt: String(d.fetchedAt || ''), deferred: '' })
      tryApply()
    } else if (cmp === 'unknown') fail()
    else {
      pendingData = null; stopRetry()
      const cur = status.get().data
      status.patch('data', { state: cur.state === 'applied' ? 'applied' : 'same', checkedAt, remoteFetchedAt: String(d.fetchedAt || ''), deferred: '' })
    }
  }
  const poller = createPoller({ env, everyMs: cfg.data.everyMs, run: check, visibleOnly: cfg.data.visibleOnly })
  return { check: () => poller.runNow(), stop() { stopped = true; stopRetry(); poller.stop() } }
}

// ───────────────────────────── ?reload=HH：每天固定時間在閒置時重載一次 ─────────────────────────────
export function createDailyReload({ env, status, hour, reloader, getIdle, checkMs = DAILY_CHECK_MS }) {
  const target = nextReloadAt(hour, env.now())   // 每次載入都重算：重載後的新頁面算出來就是明天，不會連環重載
  status.patch('daily', { hour, at: target })
  const iv = env.setInterval(() => { if (env.now() >= target && getIdle().idle) reloader.soft('daily') }, checkMs)
  return { stop() { env.clearInterval(iv) } }
}

// ───────────────────────────── 全域錯誤只記錄（不重載）─────────────────────────────
const BENIGN = /ResizeObserver loop/i
// 掛 window 的 'error' / 'unhandledrejection'（只記錄）與 'pagehide'（把記憶體裡合併的次數寫進儲存）。回傳解除函式。
export function installErrorCapture({ win, crashLog, status = opsStatus, cfg = {} }) {
  if (!win || typeof win.addEventListener !== 'function') return () => {}
  const record = (kind, input) => {
    try {
      const r = crashLog.add({ kind, build: cfg.buildId, flags: cfg.flags, ...input })
      if (r && r.isNew) status.set({ crashRev: status.get().crashRev + 1 })
    } catch (e) { /* 記錄本身不能再出錯 */ }
  }
  const onError = (ev) => {
    const msg = ev && ev.message
    if (msg && BENIGN.test(msg)) return
    if (ev && ev.error) record('error', { error: ev.error })
    else record('error', { message: `${msg || 'Script error'}${ev && ev.filename ? ` @${clip(ev.filename, 80)}:${ev.lineno || 0}` : ''}` })
  }
  const onRejection = (ev) => record('rejection', ev && ev.reason !== undefined ? { error: ev.reason } : { message: 'Unhandled rejection (no reason)' })
  const onHide = () => { try { crashLog.flush() } catch (e) { /* ignore */ } }
  win.addEventListener('error', onError)
  win.addEventListener('unhandledrejection', onRejection)
  win.addEventListener('pagehide', onHide)
  return () => {
    win.removeEventListener('error', onError)
    win.removeEventListener('unhandledrejection', onRejection)
    win.removeEventListener('pagehide', onHide)
  }
}

// ───────────────────────────── 組裝 ─────────────────────────────
// 依設定啟動這個視窗需要的防呆；回傳 { config, stop, checkNow, reloader }。可重複啟動（StrictMode：start → stop → start），stop 會清掉所有計時器 / 監聽 / 排定的重載。
// 只有主畫面（'main'）與觀眾視窗（'audience'）會啟動；遙控頁 / 診斷頁什麼都不做。資料更新只在有提供 env.applyData 時才啟動（主畫面：ResilienceService；觀眾視窗：audienceEnv）。
// opts：{ config?, env?（覆寫 defaultEnv 的任何欄位）, status?, crashLog?, buildId? }
export function startGuards(opts = {}) {
  const env = { ...defaultEnv(), ...(opts.env || {}) }
  const cfg = opts.config || resolveConfig({ search: env.search, hash: env.hash, buildId: opts.buildId || BUILD_ID })
  const status = opts.status || opsStatus
  const crashLog = opts.crashLog || getCrashLog()
  const reloader = createReloader({ env, status, crashLog, cfg })
  const readIdle = () => safe(() => env.idleState(), DEFAULT_IDLE_STATE)
  const getIdle = () => evaluateIdle(readIdle(), { kiosk: cfg.kiosk })                                          // 重載用（版本 / 每日）
  const getDataIdle = () => evaluateIdle({ ...readIdle(), fullscreen: false }, { kiosk: cfg.kiosk })             // 資料就地更新用：不重載，觀眾視窗全螢幕中也照樣更新
  const parts = []
  const checkers = []
  status.set({ started: true, config: cfg })

  if (cfg.mode === 'main' || cfg.mode === 'audience') {
    const gl = createGlGuard({ env, status, onGiveUp: () => reloader.crash('webgl', new Error('WebGL context lost and not restored')) })
    parts.push(gl)
    if (cfg.watchdog.on) {
      const wd = createWatchdog({ env, status, onStall: ({ stalledMs }) => reloader.crash('watchdog', new Error(`No animation frame for ${Math.round(stalledMs / 1000)} s`)) })
      status.patch('watchdog', { on: true, supported: wd.supported, reason: cfg.watchdog.reason, stalled: false })
      parts.push(wd)
    } else status.patch('watchdog', { on: false, supported: true, reason: cfg.watchdog.reason, stalled: false })

    if (cfg.version.check && typeof env.fetch === 'function') {
      const vc = createVersionChecker({ env, status, cfg, reloader, getIdle })
      parts.push(vc); checkers.push(vc.check)
    } else status.patch('version', { state: 'off' })

    if (typeof env.fetch === 'function' && typeof env.applyData === 'function') {   // 主畫面 + 觀眾視窗（觀眾視窗的 applyData 由 audienceEnv() 提供）
      const dr = createDataRefresher({ env, status, cfg, getIdle: getDataIdle })
      parts.push(dr); checkers.push(dr.check)
    } else status.patch('data', { state: 'off' })

    if (cfg.reloadHour !== null && cfg.reloadHour !== undefined) parts.push(createDailyReload({ env, status, hour: cfg.reloadHour, reloader, getIdle }))
  }

  let stopped = false
  const handle = {
    config: cfg, reloader,
    checkNow: () => Promise.all(checkers.map((c) => c())).then(() => undefined),
    stop() {
      if (stopped) return
      stopped = true
      for (const p of parts) { try { p.stop() } catch (e) { /* ignore */ } }
      reloader.cancel()
      if (guardControls.current === handle) guardControls.current = null
    },
  }
  guardControls.current = handle
  return handle
}
