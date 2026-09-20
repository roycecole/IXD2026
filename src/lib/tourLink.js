// 資料導覽的「每站連結」（深連結）：純函式，Node 可測；瀏覽器物件（navigator / document）一律以參數注入。
//   parseTourLink(search)   → null | { stop: { index?: number, id?: string }, hold: boolean }
//                             ?tourstop=<n（1 起算）或站 id>；?tourhold=1 表示到站後暫停（導覽員模式）。
//                             回傳的 stop.index 是「0 起算」（= URL 的 n − 1），可直接給 runner.start({ at })；非法值一律 null。
//   buildTourLink({ href, stopId, hold, locale }) → 字串（只保留 origin + 路徑；只帶 tourstop（以站 id）、選帶 tourhold、lang（英文時））
//   hasTourLink(search)     → boolean（給新手導覽判斷「這是導覽員的連結，不要再蓋一層新手導覽」）
//   linkBase(href)          → 'origin + 路徑'（不合法 → ''）；lib/tourPlan.js 的 buildPlanLink（帶導覽腳本的連結）與 buildTourLink 共用
//   copyText(text, env)     → Promise<boolean>（Clipboard API → 退回隱藏 textarea + execCommand('copy')）
// 為什麼用「站 id」而不是序號：資料不齊或 AR 實景時導覽會略過某些站，序號會位移，站 id 不會。
import { flagOn } from './urlFlags.js'

// 站 id 白名單（與 lib/tour.js buildTour 的順序一致；tour.test.mjs 會核對兩邊沒有走樣）
export const TOUR_STOP_IDS = ['reservoir', 'tide', 'moon', 'dust', 'air', 'birds', 'fish', 'stations']

export function parseTourLink(search) {
  const s = typeof search === 'string' ? search : ''
  let raw
  try { raw = new URLSearchParams(s).get('tourstop') } catch (e) { return null }
  if (raw == null) return null
  const v = String(raw).trim().toLowerCase()
  let stop = null
  if (/^\d+$/.test(v)) {
    const n = Number(v)
    if (n >= 1 && n <= TOUR_STOP_IDS.length) stop = { index: n - 1 }
  } else if (TOUR_STOP_IDS.includes(v)) stop = { id: v }
  if (!stop) return null
  return { stop, hold: flagOn(s, 'tourhold') }
}

export const hasTourLink = (search) => parseTourLink(search) !== null

// href 不是合法網址、或 stopId 不在白名單 → ''（呼叫端當作「沒有連結可複製」）。
// 刻意不沿用原網址的任何參數與 hash：?kiosk / ?audience / ?diagnostics / #remote=… 之類的一次性旗標，
// 以及帳密（user:pass@）、分享參數（?s= ?o=）都不該跟著別人走。
export function buildTourLink({ href, stopId, hold = false, locale = 'zh' } = {}) {
  const id = typeof stopId === 'string' ? stopId.trim().toLowerCase() : ''
  if (!TOUR_STOP_IDS.includes(id)) return ''
  const base = linkBase(href)
  if (!base) return ''
  const q = [`tourstop=${id}`]
  if (hold) q.push('tourhold=1')
  if (locale === 'en') q.push('lang=en')
  return `${base}?${q.join('&')}`
}

// 連結的「origin + 路徑」（不含任何查詢參數與 hash、帳密）；href 不是合法網址 → ''。
// buildTourLink 與 lib/tourPlan.js 的 buildPlanLink（帶腳本的連結）共用，兩邊的網址骨架一致。
export function linkBase(href) {
  let u
  try { u = new URL(String(href)) } catch (e) { return '' }
  const origin = u.origin && u.origin !== 'null' ? u.origin : `${u.protocol}//${u.host}`
  return `${origin}${u.pathname}`
}

// ---------------------------------------------------------------------------------------------
// 複製到剪貼簿
// ---------------------------------------------------------------------------------------------
// env：{ navigator, document }。預設在「呼叫當下」才讀全域（import 時不碰 window / navigator：Node 測試會 import 本檔）。
// 注意：clipboard.writeText / document.execCommand 一律以「方法呼叫」（this 必須是原物件），不存成變數再呼叫，否則瀏覽器會丟 Illegal invocation。
function defaultEnv() {
  return {
    navigator: typeof navigator !== 'undefined' ? navigator : null,
    document: typeof document !== 'undefined' ? document : null,
  }
}

function legacyCopy(text, doc) {
  if (!doc || !doc.body || typeof doc.createElement !== 'function' || typeof doc.execCommand !== 'function') return false
  const prev = doc.activeElement
  let ta = null
  let ok = false
  try {
    ta = doc.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.setAttribute('aria-hidden', 'true')
    ta.tabIndex = -1
    ta.style.cssText = 'position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none'
    doc.body.appendChild(ta)
    if (typeof ta.focus === 'function') ta.focus({ preventScroll: true })
    if (typeof ta.select === 'function') ta.select()
    if (typeof ta.setSelectionRange === 'function') ta.setSelectionRange(0, text.length)
    ok = !!doc.execCommand('copy')
  } catch (e) {
    ok = false
  } finally {
    try { if (ta && ta.parentNode) ta.parentNode.removeChild(ta) } catch (e) { /* ignore */ }
    try { if (prev && typeof prev.focus === 'function') prev.focus({ preventScroll: true }) } catch (e) { /* ignore */ }
  }
  return ok
}

export async function copyText(text, env) {
  const { navigator: nav, document: doc } = env || defaultEnv()
  const s = String(text == null ? '' : text)
  if (!s) return false
  try {
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      await nav.clipboard.writeText(s)
      return true
    }
  } catch (e) { /* 被拒（權限 / 沒有使用者手勢 / 非安全環境）：退回舊寫法 */ }
  return legacyCopy(s, doc)
}
