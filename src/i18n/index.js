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
// 英文字典是「動態載入」的（瀏覽器）：中文使用者（多數人）與手機遙控頁的中文模式完全不下載它。
//   · 啟動：偵測到英文（?lang=en、存過偏好 en、瀏覽器語言為英文）→ main.jsx 在第一次 render 前 await bootLocale()（最多等 BOOT_TIMEOUT_MS；逾時 / 失敗先以中文 render，字典之後到了自動切換並重繪）。
//     字典就緒之前，store 的 locale 一律是 'zh'（不變式：瀏覽器裡 locale === 'en' 代表字典已載入）→ 不會出現「locale 是 en、內容卻是中文」的中間狀態。
//   · 切換：setLocale('en') 字典未載入 → 先 loadEnglish()，載完才真的切（期間 locale 維持原樣、useLocaleLoading() 為 true）；失敗 → 維持原語系、console 記一行、不丟例外，再按一次會重試。切回 zh 不需要載入。
//   · 安全網：有人直接把 store 設成 en（例如觀眾視窗跟隨主視窗的語系，它不走 setLocale）而字典還沒載入 → 自動補載，載完重繪（useT 訂閱 rev）。
// Node（測試）沒有 window：預設 zh，沒有載入器（視為「字典已就緒」），字典用 registerEn() 手動註冊；setLocale('en') 同步生效。
import { useCallback } from 'react'
import { create } from 'zustand'
import { LS, loadLS, saveLS } from '../lib/persist.js'
import { createLoader, createLocaleSwitcher } from './loader.js'

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
  try { console.warn('[i18n] 英文字典載入失敗，維持中文（再按一次 EN 會重試）：', err && err.message ? err.message : err) } catch (e) { /* ignore */ }
}

function onEnglishReady() {
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
// 有切換在等字典（給語言鈕顯示忙碌用；不放進 useLocaleStore，免得所有 useLocaleStore(...) 的呼叫端多一個會變的欄位）
const useLocaleBusyStore = create(() => ({ loading: false }))
export function useLocaleLoading() { return useLocaleBusyStore((s) => s.loading) }
export function isLocaleLoading() { return useLocaleBusyStore.getState().loading }

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
  onBusy: (b) => useLocaleBusyStore.setState({ loading: !!b }),
  onError: logLoadError,
})
let switcher = makeSwitcher(detected)

// setLocale：跟以前一樣回傳 undefined。字典已就緒（或 Node）→ 同步生效；en 而字典未載入 → 先載入、載完才切（見上）。
export function setLocale(loc) { switcher.request(loc) }
// 需要知道「切完了沒」的呼叫端（測試、語音指令）：回傳 Promise<切換後生效的語系>，永遠 resolve（失敗 = 維持原語系）
export function setLocaleAsync(loc) { return switcher.request(loc) }
// 回傳值語意 = 「目前」語系：en 的字典還在載入時仍是 'zh'
export function toggleLocale() { setLocale(getLocale() === 'zh' ? 'en' : 'zh'); return getLocale() }

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
  return english
}

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
