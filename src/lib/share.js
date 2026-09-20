import { PARAM_ORDER } from '../params/registry.js'
import { t } from '../i18n/index.js'

const clamp01 = (v) => Math.max(0, Math.min(1, v))

// 參數 → 緊湊 URL 字串：每個參數量化成 1 byte (0-255)，再 base64url。
// 位置編碼（依 PARAM_ORDER）絕不能動：舊分享連結靠它解碼。
export function encodeParams(params) {
  let bin = ''
  for (const pid of PARAM_ORDER) bin += String.fromCharCode(Math.round(clamp01(params[pid] ?? 0) * 255))
  try {
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  } catch (e) { return '' }
}

export function decodeParams(str) {
  try {
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'))
    const out = {}
    for (let i = 0; i < PARAM_ORDER.length && i < bin.length; i++) out[PARAM_ORDER[i]] = bin.charCodeAt(i) / 255
    return out
  } catch (e) { return null }
}

// ---------------------------------------------------------------------------------------------
// 資料脈絡：?s=（視覺參數）之外，附加可讀的 query，讓對方打開時「資料選項 / 月份 / 連動」都和分享者一致。
//   &o=<海況選項 id>   例 feitsui / hualien-tide
//   &m=<0..11>         手動預覽的調查月份（僅當分享者手動選過；沒選過就不帶）
//   &sl=<b?f?>         鳥 / 魚是否連動調查資料，例 b1f0 = 鳥連動、魚獨立
//   &lang=<zh|en>      分享者的語系
// 全部可選；解析一律容錯（亂碼 / 不存在的值只忽略該欄，不影響其他欄與舊連結）。
// ---------------------------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/     // 海況選項 id：只允許安全字元，所以 URL 不需再 encode

export function normalizeMonth(v) {
  if (v == null || v === '') return null
  if (typeof v === 'string' && !/^\d{1,2}$/.test(v)) return null
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 && n <= 11 ? n : null
}
export function normalizeLang(v) {                      // 與 i18n detect() 同一套容錯：EN / en-US / zh-TW / zh_Hant
  const s = String(v == null ? '' : v).toLowerCase()
  if (/^en(-|_|$)/.test(s)) return 'en'
  if (/^zh(-|_|$)/.test(s)) return 'zh'
  return null
}
export function encodeLinkCode(link) { return `b${link && link.birds ? 1 : 0}f${link && link.fish ? 1 : 0}` }
export function decodeLinkCode(code) {
  const m = /^b([01])f([01])$/.exec(String(code == null ? '' : code))
  return m ? { birds: m[1] === '1', fish: m[2] === '1' } : null
}

// 目前頁面網址基底（不含 query / hash）；沒有 location（Node 測試）→ 空字串。測試請直接傳入 base。
function defaultBase() { try { return location.origin + location.pathname } catch (e) { return '' } }

// ctx：{ optionId, month, link:{birds,fish}, lang }，全部可省略。與舊版相容：不給 ctx 時輸出和以前一模一樣的 ?s=…
export function buildShareUrl(params, ctx, base) {
  const b = typeof base === 'string' ? base : defaultBase()
  const q = ['s=' + encodeParams(params || {})]
  const c = ctx || {}
  if (typeof c.optionId === 'string' && ID_RE.test(c.optionId)) q.push('o=' + c.optionId)
  const m = normalizeMonth(c.month)
  if (m != null) q.push('m=' + m)
  if (c.link && typeof c.link === 'object') q.push('sl=' + encodeLinkCode(c.link))
  const lang = normalizeLang(c.lang)
  if (lang) q.push('lang=' + lang)
  return b + (b.includes('?') ? '&' : '?') + q.join('&')
}

// 從 store 狀態組出分享脈絡（純函式）。month：surveyMonth（null = 沒手動選過 → 不帶）。
export function shareContextOf(st, lang) {
  const s = st || {}
  return { optionId: s.govOptionId || null, month: s.surveyMonth ?? null, link: s.surveyLink || null, lang: lang || null }
}

// search：location.search（'?s=…&o=…'），也可傳完整網址或不含 '?' 的 query 字串。
// opts.optionIds：（可選）已知的海況選項 id 清單；給了就過濾掉不存在的 id。
// 回傳 { params, optionId, month, link:{birds,fish}|null, lang }，缺的 / 壞的欄位一律 null。
export function parseShareContext(search, opts) {
  const out = { params: null, optionId: null, month: null, link: null, lang: null }
  let q
  try {
    let s = typeof search === 'string' ? search : (search && typeof search.search === 'string' ? search.search : '')
    const h = s.indexOf('#'); if (h >= 0) s = s.slice(0, h)
    const i = s.indexOf('?'); if (i >= 0) s = s.slice(i + 1)
    q = new URLSearchParams(s)
  } catch (e) { return out }
  const s = q.get('s')
  if (s) { const p = decodeParams(s); if (p && Object.keys(p).length) out.params = p }
  const o = q.get('o')
  if (o && ID_RE.test(o)) {
    const ids = opts && opts.optionIds
    const known = !ids ? true : (typeof ids.has === 'function' ? ids.has(o) : Array.isArray(ids) && ids.includes(o))
    if (known) out.optionId = o
  }
  out.month = normalizeMonth(q.get('m'))
  out.link = decodeLinkCode(q.get('sl'))
  out.lang = normalizeLang(q.get('lang'))
  return out
}

// 有沒有「分享內容」：視覺參數或資料脈絡任一有效即算（只有 lang 不算——展場網址常單獨帶 ?lang=）。
// 有分享內容 → 不套用「首次到訪以今天真實的海開場」。
export function hasShareContext(ctx) {
  return !!(ctx && (ctx.params || ctx.optionId || ctx.month != null || ctx.link))
}

// 把分享脈絡套用到 store。順序很重要：
//   1. 海況選項（setGovOption 會連同該選項的海況參數一起套上）
//   2. 調查月份（setSurveyMonth）
//   3. 鳥 / 魚連動狀態（只進記憶體，不寫 localStorage，見 store.applySharedContext）
//   4. 分享的視覺參數——最後才套，蓋掉第 1、2 步帶來的海況參數，畫面才會和分享者一致
//   5. 語系（一次性覆蓋）
// store：帶 getState() 的物件（useStore）；每一步都重新 getState()，因為載入資料後 state 快照會過期。
// io：{ setLocale, getLocale } 可注入（測試不碰 DOM）。回傳實際套用了哪些欄位。
export function applyShareContext(store, ctx, io) {
  const done = { option: false, month: false, link: false, params: false, lang: false }
  if (!store || !ctx) return done
  const st = () => store.getState()
  const options = st().gov && st().gov.options
  if (ctx.optionId && Array.isArray(options) && options.some((o) => o && o.id === ctx.optionId)) { st().setGovOption(ctx.optionId); done.option = true }
  if (ctx.month != null && normalizeMonth(ctx.month) != null) { st().setSurveyMonth(ctx.month); done.month = true }
  if (ctx.link) { st().applySharedContext({ link: ctx.link }); done.link = true }
  if (ctx.params) { st().applyParams(ctx.params); done.params = true }
  const lang = normalizeLang(ctx.lang)
  if (lang && io && io.setLocale && lang !== (io.getLocale ? io.getLocale() : null)) { io.setLocale(lang); done.lang = true }
  return done
}

// ---------------------------------------------------------------------------------------------
// 圖片分享文案
// ---------------------------------------------------------------------------------------------

// 「我在 MidiSea 演了一片海 [網址]」。text 有給就以它為準（沒含網址就補在後面）；只給 url 就用語系文案組出來；
// 都沒給 → 舊文案（不含網址，向下相容）。
export function shareCaption(o) {
  const text = o && typeof o.text === 'string' ? o.text : ''
  const url = o && typeof o.url === 'string' ? o.url : ''
  if (text) return url && !text.includes(url) ? `${text} ${url}` : text
  return url ? t('我在 MidiSea 演了一片海 {url}', { url }) : t('我在 MidiSea 演了一片海')
}

// 分享卡文字排版：先縮字級（不低於 minPx），還是塞不下才截斷加「…」。measure(text, px) → 寬度（px）。
// 純函式（測試用假的 measure）。回傳 { text, px }。文字本來就塞得下 → 原樣回傳（不改變既有版面）。
export function fitText(measure, text, px, maxW, minPx) {
  const s = String(text == null ? '' : text)
  const lo = Math.min(px, minPx == null ? Math.round(px * 0.72) : minPx)
  if (!s || measure(s, px) <= maxW) return { text: s, px }
  let size = Math.max(lo, Math.min(px, Math.floor((px * maxW) / measure(s, px))))
  while (size > lo && measure(s, size) > maxW) size--
  if (measure(s, size) <= maxW) return { text: s, px: size }
  const chars = [...s]
  let a = 0, b = chars.length                           // 二分找「最長前綴 + …」仍塞得下的長度
  while (a < b) {
    const mid = (a + b + 1) >> 1
    if (measure(chars.slice(0, mid).join('') + '…', size) <= maxW) a = mid; else b = mid - 1
  }
  return { text: chars.slice(0, a).join('') + '…', px: size }
}
