// 語系（zh / en）。設計：以「中文原文」當 key（程式本來就是中文，補譯只要把字面量包進 t()），
// 英文字典放 src/i18n/en/*.js（各功能各一檔，Vite 以 import.meta.glob 自動合併——新增功能不必改任何共用檔）。
//   React 元件：const t = useT()   → 語系切換時自動重繪
//   非 React（純函式、store 日誌）：import { t }   → 用「當下」語系
//   靜態表（例如 registry 的參數名）：用 T('海水高度') 標記（原樣回傳中文），顯示時再 t(label)
//   插值：t('{n} 站', { n: 3 })；英文值可以是函式 (params) => string，處理單複數等
//   找不到英文 → 退回中文原文（DEV 會在 console 記一次，window.__i18nMissing 可查）
// 注意（新功能的實作者請務必遵守）：
//   · 元件若呼叫「讀當下語系的純函式」（describeBoard、formatHud、moonPhaseName、buildTour…），必須自己 useT() / useLocale() 訂閱語系，否則切換語言不會重繪。
//   · 常駐服務若持有「和語言有關的狀態」（例：語音辨識的 lang、導覽字幕、逐字快取），要監聽語系變化並重設（useLocaleStore.subscribe）。
//   · 存進 store / 日誌的字串是「當下語系」的快照；要能跟著切換的內容，請存 { key, params } 顯示時再 t()。
// Node（測試）沒有 window：預設 zh，字典可用 registerEn() 手動註冊。
import { useCallback } from 'react'
import { create } from 'zustand'
import { LS, loadLS, saveLS } from '../lib/persist.js'

export const LOCALES = ['zh', 'en']
const HAS_WINDOW = typeof window !== 'undefined' && typeof document !== 'undefined'

let EN = {}
try {
  const mods = import.meta.glob('./en/*.js', { eager: true })   // Vite 於建置時展開；Node 沒有 import.meta.glob → 丟例外 → 走 registerEn
  for (const m of Object.values(mods)) Object.assign(EN, m.default || {})
} catch (e) { /* Node：見 registerEn */ }

export function registerEn(dict) { Object.assign(EN, dict || {}) }
export function getEnDict() { return EN }

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

export const useLocaleStore = create(() => ({ locale: detect() }))

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
export function setLocale(loc) {
  if (loc !== 'zh' && loc !== 'en') return
  if (loc === getLocale()) return
  useLocaleStore.setState({ locale: loc })
  if (HAS_WINDOW) {
    saveLS(LS.lang, loc)
    // 網址若帶 ?lang=（展場網址 / 分享連結），切換後同步更新，否則重新整理又會被網址蓋回去
    try {
      const u = new URL(location.href)
      if (u.searchParams.has('lang')) { u.searchParams.set('lang', loc); history.replaceState(history.state, '', u) }
    } catch (e) { /* ignore */ }
  }
  applyDocumentLocale(loc)
}
export function toggleLocale() { setLocale(getLocale() === 'zh' ? 'en' : 'zh'); return getLocale() }

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
    if (HAS_WINDOW && !missing.has(zh)) { missing.add(zh); if (import.meta.env && import.meta.env.DEV) console.debug('[i18n] 缺英文：', zh) }
    return interpolate(zh, params)
  }
  return interpolate(typeof v === 'function' ? v(params || {}) : v, params)
}

export function t(zh, params) { return translate(useLocaleStore.getState().locale, zh, params) }
export const T = (zh) => zh               // 「標記待翻譯」：靜態表使用，原樣回傳中文，顯示時再 t()

// React：訂閱語系，回傳綁定當下語系的 t（語系切換 → 元件重繪）
export function useT() {
  const loc = useLocaleStore((s) => s.locale)
  return useCallback((zh, params) => translate(loc, zh, params), [loc])
}
export function useLocale() { return useLocaleStore((s) => s.locale) }

if (HAS_WINDOW) applyDocumentLocale()
