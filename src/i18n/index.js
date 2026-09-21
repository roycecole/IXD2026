// 語系（zh / en）。設計：以「中文原文」當 key（程式本來就是中文，補譯只要把字面量包進 t()），
// 英文字典放 src/i18n/en/*.js（各功能各一檔，由 src/i18n/en-all.js 以 import.meta.glob 自動彙整——新增功能不必改任何共用檔）。
//   React 元件：const t = useT()   → 語系切換時自動重繪
//   非 React（純函式、store 日誌）：import { t }   → 用「當下」語系
//   靜態表（例如 registry 的參數名）：用 T('海水高度') 標記（原樣回傳中文），顯示時再 t(label)
//   插值：t('{n} 站', { n: 3 })；英文值可以是函式 (params) => string，處理單複數等
//   找不到英文 → 退回中文原文（DEV 會在 console 記一次，window.__i18nMissing 可查）
// 注意（新功能的實作者請務必遵守）：
//   · 元件若呼叫「讀當下語系的純函式」（describeBoard、formatHud、moonPhaseName、buildTour…），必須自己 useT() / useLocale() 訂閱語系，否則切換語言不會重繪。
//   · 常駐服務若持有「和語言有關的狀態」（例：語音辨識的 lang、導覽字幕、逐字快取），要監聽語系變化並重設（useLocaleStore.subscribe）。
//   · 存進 store / 日誌的字串是「當下語系」的快照；要能跟著切換的內容，請存 { key, params } 顯示時再 t()。
//   · 不要在「模組頂層」呼叫 t() / translate()（import 當下執行）：英文字典是動態載入的，路由 chunk 可能比字典先執行完（會固定成中文）。靜態表用 T() 標記，顯示時再 t()。
//     （src/i18n/i18n.test.mjs 會掃描整個 src 守住這一條。）
//
// 英文字典是「動態載入」的（瀏覽器）：手機遙控頁的中文模式完全不下載它；主畫面 / 觀眾視窗的中文使用者在畫面出來之後、閒置時才預抓（診斷頁與手機遙控頁不預抓；prefetchEnglish：
// 按 EN 不依賴當下的網路，chunk 也經 Service Worker 進快取——離線的 PWA 才切得過去；省流量模式 / 離線 / 手機遙控頁不預抓）。
//   · 啟動：偵測到英文（?lang=en、存過偏好 en、瀏覽器語言為英文）→ main.jsx 在第一次 render 前 await bootLocale()（最多等 BOOT_TIMEOUT_MS；逾時 / 失敗先以中文 render，字典之後到了自動切換並重繪）。
//     字典就緒之前，store 的 locale 一律是 'zh'（不變式：瀏覽器裡 locale === 'en' 代表字典已載入）→ 不會出現「locale 是 en、內容卻是中文」的中間狀態。
//   · 切換：setLocale('en') 字典未載入 → 先 loadEnglish()，載完才真的切（期間 locale 維持原樣、useLocaleLoading() 為 true——語言鈕據此顯示忙碌）；
//     失敗 → 維持原語系、不丟例外，useLocaleFailed() 變成 'retry'（逾時：還在跑、只是太慢）或 'reload'（硬失敗），約 FAIL_NOTICE_MS 後自己消失（i18n/LangNotice.jsx 顯示雙語提示，不能只有 console）。
//     再按一次：'retry' → 重新載入；'reload' → 存好偏好後整頁重新載入（瀏覽器可能把失敗的 import() 記在模組表裡，同一個網址再 import 一次不會重新請求）。切回 zh 不需要載入。
//   · 安全網：有人直接把 store 設成 en（例如觀眾視窗跟隨主視窗的語系，它不走 setLocale）而字典還沒載入 → 自動補載，載完重繪（useT 訂閱 rev）。
// Node（測試）沒有 window：預設 zh，沒有載入器（視為「字典已就緒」），字典用 registerEn() 手動註冊；setLocale('en') 同步生效。
import { useCallback } from 'react'
import { create } from 'zustand'
import { LS, loadLS, saveLS } from '../lib/persist.js'
import { createLoader, createLocaleSwitcher, prefetchWhenIdle, LOAD_TIMEOUT_MESSAGE } from './loader.js'

export const LOCALES = ['zh', 'en']
const HAS_WINDOW = typeof window !== 'undefined' && typeof document !== 'undefined'
// 只有「Vite 打包 / 開發伺服器」提供的瀏覽器才有辦法載入英文字典（en-all.js 用 import.meta.glob）；
// Node（測試）與只是假造了 window 的測試環境沒有載入器 → 一律維持同步行為（字典靠 registerEn）。
const CAN_LOAD_EN = HAS_WINDOW && typeof import.meta !== 'undefined' && !!import.meta.env

export const BOOT_TIMEOUT_MS = 8000            // 啟動時最多等英文字典這麼久，逾時先以中文 render
export const EN_ATTEMPT_TIMEOUT_MS = 20000     // 單次載入嘗試的看門狗：卡住超過這麼久 → 判定失敗（之後可重試）

const EN = {}
export function registerEn(dict) { Object.assign(EN, dict || {}) }
export function getEnDict() { return EN }

// ---- 英文字典載入器 ----
// 載入函式：動態 import 單一彙整模組（一個 chunk），合併進 EN 之後才 resolve。不把 import 存成變數或屬性再呼叫（每次呼叫當下才 import）。
const loadEnglishDict = () => import('./en-all.js').then((m) => { registerEn(m.default) })

function logLoadError(err) {
  try { console.warn('[i18n] 英文字典載入失敗，維持中文（畫面上有提示；再按一次 EN 會重試 / 重新載入頁面）：', err && err.message ? err.message : err) } catch (e) { /* ignore */ }
}

function onEnglishReady() {
  hardFailed = false; setFailed(false)
  // 字典到了：若 store 已經是 en（安全網路徑：有人直接改 store）→ rev + 1 讓元件重繪；標題 / description / <html lang> 再套一次
  try { if (useLocaleStore.getState().locale === 'en') useLocaleStore.setState((s) => ({ rev: (s.rev || 0) + 1 })) } catch (e) { /* ignore */ }
  applyDocumentLocale()
}

const makeEnglishLoader = (load, opts = {}) => createLoader({ load, onReady: onEnglishReady, attemptTimeoutMs: EN_ATTEMPT_TIMEOUT_MS, ...opts })
let english = makeEnglishLoader(CAN_LOAD_EN ? loadEnglishDict : null)

// 公開：載入英文字典（可重複呼叫、載入中共用同一個 promise、失敗時 reject 且可重試、成功後快取）。Node 沒有載入器 → 立刻 resolve。
export function loadEnglish() { return english.load() }
export function isEnglishReady() { return english.isReady() }

function detect() {
  if (!HAS_WINDOW) return 'zh'
  try {   // ?lang= 優先於偏好與瀏覽器語言；容忍大小寫與區域碼（?lang=EN、?lang=zh-TW、?lang=en-US）
    const q = String(new URLSearchParams(location.search).get('lang') || '').toLowerCase()
    if (/^en(-|_|$)/.test(q)) return 'en'
    if (/^zh(-|_|$)/.test(q)) return 'zh'
  } catch (e) { /* ignore */ }
  const saved = loadLS(LS.lang, null)
  if (saved === 'en' || saved === 'zh') return saved
  try { const nav = (navigator.languages && navigator.languages[0]) || navigator.language || ''; return /^zh/i.test(nav) ? 'zh' : 'en' } catch (e) { return 'zh' }
}

const missing = new Set()
if (HAS_WINDOW && import.meta.env && import.meta.env.DEV) window.__i18nMissing = missing

// 想要英文、但字典還沒載入 → 先以中文生效（不變式見上），由 bootLocale() 等字典到了再切
const detected = detect()
export const useLocaleStore = create(() => ({ locale: detected === 'en' && !english.isReady() ? 'zh' : detected, rev: 0 }))
// 有切換在等字典（給語言鈕顯示忙碌用；不放進 useLocaleStore，免得所有 useLocaleStore(...) 的呼叫端多一個會變的欄位）。
// failed：最近一次「使用者要求的」英文載入失敗（false | 'retry' | 'reload'）；約 FAIL_NOTICE_MS 後自己歸零，新的嘗試開始 / 載入成功也會歸零。
export const useLocaleBusyStore = create(() => ({ loading: false, failed: false }))   // 匯出給測試（SSR 渲染 LangNotice 時要設定它）；元件請用 useLocaleLoading / useLocaleFailed
export function useLocaleLoading() { return useLocaleBusyStore((s) => s.loading) }
export function isLocaleLoading() { return useLocaleBusyStore.getState().loading }
export function useLocaleFailed() { return useLocaleBusyStore((s) => s.failed) }
export function getLocaleFailed() { return useLocaleBusyStore.getState().failed }

export const FAIL_NOTICE_MS = 6000              // 「英文載入失敗」的提示顯示多久
let failTimer = null
let hardFailed = false                          // 最近一次失敗是「硬失敗」（不是逾時）：下一次按 EN 改成整頁重新載入
function setFailed(v) {
  useLocaleBusyStore.setState({ failed: v || false })
  try { if (failTimer !== null) clearTimeout(failTimer) } catch (e) { /* ignore */ }
  failTimer = null
  if (v) {
    try {
      failTimer = setTimeout(() => { failTimer = null; useLocaleBusyStore.setState({ failed: false }) }, FAIL_NOTICE_MS)
      if (failTimer && typeof failTimer.unref === 'function') failTimer.unref()   // Node：不要為了一個提示的計時器讓程序多活 6 秒
    } catch (e) { failTimer = null }
  }
}
// 使用者要求的英文載入失敗（協調器的 onError）：記一行 log、留下畫面提示
function onEnglishFailed(err) {
  logLoadError(err)
  hardFailed = !(err && err.message === LOAD_TIMEOUT_MESSAGE)
  setFailed(hardFailed ? 'reload' : 'retry')
}

// 把語系寫到 <html lang>、標題與 description（分享 / 無障礙 / 瀏覽器翻譯提示都會用到）
export function applyDocumentLocale(loc = useLocaleStore.getState().locale) {
  if (!HAS_WINDOW) return
  try {
    document.documentElement.lang = loc === 'zh' ? 'zh-Hant' : 'en'
    document.title = translate(loc, 'MidiSea 資料導演台 — MIDI × 線稿海洋互動 | IxDA Taiwan 2026')
    const d = document.querySelector('meta[name="description"]')
    if (d) d.setAttribute('content', translate(loc, '用 MIDI 控制器、滑鼠、鍵盤或手機觸控，演奏一顆透明球體裡的線稿海洋：調海水、召喚鯨豚海龜、清理海洋垃圾，可錄製回放。IxDA Taiwan 2026 會員工作坊「AI 共生黑客鬆」12組 卡加布列島作品。'))
  } catch (e) { /* ignore */ }
}

export function getLocale() { return useLocaleStore.getState().locale }

// 同步套用（字典已就緒、或切回 zh）。persist: false = 啟動時偵測到的語系（不是使用者手動選的）：不寫偏好、不動網址。
function applyLocale(loc, { persist = true } = {}) {
  useLocaleStore.setState({ locale: loc })
  if (persist && HAS_WINDOW) {
    saveLS(LS.lang, loc)
    // 網址若帶 ?lang=（展場網址 / 分享連結），切換後同步更新，否則重新整理又會被網址蓋回去
    try {
      const u = new URL(location.href)
      if (u.searchParams.has('lang')) { u.searchParams.set('lang', loc); history.replaceState(history.state, '', u) }
    } catch (e) { /* ignore */ }
  }
  applyDocumentLocale(loc)
}

const makeSwitcher = (initialDesired) => createLocaleSwitcher({
  getLocale,
  applyLocale,
  english: { isReady: () => english.isReady(), load: () => english.load() },   // 每次呼叫當下才讀目前的載入器（測試可換）
  initialDesired,
  onBusy: (b) => { useLocaleBusyStore.setState({ loading: !!b }); if (b) setFailed(false) },   // 新的嘗試開始：舊的失敗提示先收掉
  onError: onEnglishFailed,
})
let switcher = makeSwitcher(detected)

// setLocale：跟以前一樣回傳 undefined。字典已就緒（或 Node）→ 同步生效；en 而字典未載入 → 先載入、載完才切（見上）。
export function setLocale(loc) { switcher.request(loc) }
// 需要知道「切完了沒」的呼叫端（測試、語音指令）：回傳 Promise<切換後生效的語系>，永遠 resolve（失敗 = 維持原語系）
export function setLocaleAsync(loc) { return switcher.request(loc) }
// 回傳值語意 = 「目前」語系：en 的字典還在載入時仍是 'zh'
// 上一次英文載入是「硬失敗」（不是逾時）而字典仍未載入：再按 EN = 整頁重新載入（見檔頭；先存好偏好 / 更新網址的 ?lang=，重載後開機就會載入英文）——
// 同一個 import() 網址在有些瀏覽器會直接回傳被記住的失敗，光「再試一次」沒有用。載入中（useLocaleLoading）不重複觸發。
export function toggleLocale() {
  const want = getLocale() === 'zh' ? 'en' : 'zh'
  if (want === 'en' && hardFailed && !english.isReady() && !isLocaleLoading() && reloadForEnglish()) return getLocale()
  setLocale(want)
  return getLocale()
}

// 整頁重新載入並以英文開機。回傳是否真的觸發（沒有載入器的環境 = Node，reloader 是 null → 不重新載入；測試用 __setReloader 換成假的）。
let reloader = CAN_LOAD_EN ? () => { location.reload() } : null
function reloadForEnglish() {
  if (!reloader) return false
  try { saveLS(LS.lang, 'en') } catch (e) { /* 偏好存不了（隱私模式）就靠網址 */ }
  try {
    const u = new URL(location.href)
    u.searchParams.set('lang', 'en')                      // ?lang= 優先於偏好：網址若已帶 ?lang=zh（展場網址），不改的話重載又被蓋回中文；沒帶也補上，隱私模式存不了偏好時才有效
    history.replaceState(history.state, '', u)
  } catch (e) { /* ignore */ }
  try { reloader(); return true } catch (e) { return false }
}

// 啟動：偵測到英文而字典未就緒 → 載入並等它（最多 timeoutMs）。永遠 resolve { status: 'skip' | 'ready' | 'timeout' | 'failed', locale }。
// main.jsx 在第一次 render 前呼叫並等待；逾時後字典之後才到 → 自動切換並重繪。
export function bootLocale(opts) {
  try { return switcher.boot({ timeoutMs: BOOT_TIMEOUT_MS, ...(opts || {}) }) } catch (e) { return Promise.resolve({ status: 'failed', locale: getLocale() }) }
}

// 安全網：有人直接把 store 設成 en（例如觀眾視窗跟隨主視窗；它不走 setLocale）而字典還沒載入 → 補載（載完由 onEnglishReady 重繪）
useLocaleStore.subscribe((s) => { if (s.locale === 'en' && !english.isReady()) english.load().catch(logLoadError) })

// 測試用：換掉英文字典載入器並重置切換協調器（load 不是函式 = 沒有載入器 = Node 的預設，字典視為已就緒）。回傳新的載入器。
export function __setEnglishLoader(load, { desired, ...opts } = {}) {
  english = makeEnglishLoader(typeof load === 'function' ? load : null, opts)
  switcher = makeSwitcher(desired)
  useLocaleBusyStore.setState({ loading: false })
  hardFailed = false; setFailed(false)
  return english
}

// 畫面出來之後預抓英文字典（見 loader.js 的 prefetchWhenIdle）：閒置時（requestIdleCallback；沒有就 4 秒後的計時器）載入，失敗靜默。
// 呼叫端：main.jsx（手機遙控頁不呼叫）。Node / 沒有載入器 → 什麼都不做。回傳有沒有排程。
export const PREFETCH_FALLBACK_MS = 4000
export function prefetchEnglish() {
  if (!CAN_LOAD_EN) return false
  return prefetchWhenIdle({
    english,
    idle: (fn) => {
      try { if (typeof window.requestIdleCallback === 'function') { window.requestIdleCallback(fn, { timeout: 10000 }); return } } catch (e) { /* 走計時器 */ }
      setTimeout(fn, PREFETCH_FALLBACK_MS)
    },
    saveData: () => { const c = typeof navigator !== 'undefined' ? navigator.connection : null; return !!(c && c.saveData) },
    online: () => (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : undefined),
  })
}

// 測試用：換掉「整頁重新載入」的動作（預設瀏覽器 = location.reload、Node = 沒有），回傳還原函式
export function __setReloader(fn) { const prev = reloader; reloader = typeof fn === 'function' ? fn : null; return () => { reloader = prev } }
// 測試用：把失敗狀態歸零
export function __resetLocaleFailure() { hardFailed = false; setFailed(false) }

// 語音辨識 / Intl 等 API 要的語言標籤
export function localeTag(loc = getLocale()) { return loc === 'zh' ? 'zh-TW' : 'en-US' }

function interpolate(s, params) {
  if (!params || typeof s !== 'string') return s
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m))
}

export function translate(loc, zh, params) {
  if (loc !== 'en') return interpolate(zh, params)
  const v = EN[zh]
  if (v == null) {
    // 字典還沒載入時的退回中文不算「缺英文」（DEV 才記）
    if (HAS_WINDOW && english.isReady() && !missing.has(zh)) { missing.add(zh); if (import.meta.env && import.meta.env.DEV) console.debug('[i18n] 缺英文：', zh) }
    return interpolate(zh, params)
  }
  return interpolate(typeof v === 'function' ? v(params || {}) : v, params)
}

export function t(zh, params) { return translate(useLocaleStore.getState().locale, zh, params) }
export const T = (zh) => zh               // 「標記待翻譯」：靜態表使用，原樣回傳中文，顯示時再 t()

// React：訂閱語系，回傳綁定當下語系的 t（語系切換 → 元件重繪；字典晚到 → rev 變 → 也重繪）
export function useT() {
  const loc = useLocaleStore((s) => s.locale)
  const rev = useLocaleStore((s) => s.rev)
  return useCallback((zh, params) => translate(loc, zh, params), [loc, rev])   // rev 不在函式內用到：只是讓字典晚到時 t 的身分改變、元件重繪
}
export function useLocale() { return useLocaleStore((s) => s.locale) }

if (HAS_WINDOW) applyDocumentLocale()
