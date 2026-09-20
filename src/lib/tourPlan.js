// 導覽腳本（Tour Plan）：導覽員自訂「要講哪幾站、什麼順序、每站給觀眾的備註」，可存在這台瀏覽器、可用網址分享。純函式，Node 可測；
// 瀏覽器物件（localStorage）以可注入的 io 傳入，import 時不碰任何全域。
//   plan = { name?: string（≤24 字）, stops: [{ id, note?: string（≤120 字） }] }
//     id 只能是站白名單（= tourLink.js 的 TOUR_STOP_IDS：reservoir / tide / moon / dust / air / birds / fish / stations）、不可重複、至少 1 站、最多 8 站。
//   normalizePlan(input)            → plan | null：清洗（控制字元 / 零寬字元 / 換行）、截斷、去重、丟掉未知 id；沒有任何合法站 → null。永不丟例外
//   planToOptions(plan)             → { plan } | {}：給 lib/tour.js 的 buildTour(gov, opts)（opts.plan）
//   網址：?tour=air,fish（站 id 清單）· ?tourplan=（同義別名）· ?tournotes=<base64url(JSON { id: 備註 })> · ?tourname=<名稱>
//     ★ ?tour= 另一個舊語意是「閒置自動導覽開關」0 / 1 / on / off——值是這四個字時維持原語意（不是腳本）；值是站 id 清單時才是腳本。兩者不衝突：
//       開關字沒有任何一個在站白名單內，所以 parsePlanFromSearch('?tour=1') 一律 null；resolveAutoIdle 對站 id 清單則視為「沒指定」。
//   parsePlanFromSearch(search)     → plan | null
//   encodePlan(plan, { reserve, max }) → { query, truncated }：緊湊、可放進網址的查詢字串（不含 ?）。reserve = 網址其餘部分已佔的字元數；
//                                    總長超過 max（預設 1800）→ 先丟掉備註（再不行連名稱也丟）並標 truncated:true
//   decodePlan({ ids, notes, name }) → plan | null（encodePlan 的反向；壞的 notes 只是被忽略，站序照樣讀回）
//   buildPlanLink({ href, plan, locale, stopId, hold }) → { url, truncated, length }：只保留 origin + 路徑（與 buildTourLink 同一套骨架），帶腳本；可另帶 tourstop / tourhold / lang=en
//   儲存：LS.tourplan = { active: 已存腳本 id | null, plans: [{ id, name?, stops }]（最多 MAX_SAVED = 5 份）}；normalizeStore / loadPlanStore / savePlanStore
//         與不可變的操作（savePlanAs / updatePlan / removePlan / setActive / findPlan）——寫入失敗（隱私模式）回 false，不丟例外
//   編輯器的純邏輯（TourPlanEditor.jsx 用）：draftFromPlan / draftToPlan / moveRow / toggleRow / setRowNote / setDraftName / countChars / planEquals
// 備註是導覽員輸入的「原文」：不翻譯、不朗讀以外的處理；只清洗控制字元與長度（顯示時一律當純文字，不會被當成 HTML）。
import { TOUR_STOP_IDS, linkBase } from './tourLink.js'
import { LS } from './persist.js'

export const PLAN_STOP_IDS = TOUR_STOP_IDS
export const PLAN_LIMITS = { name: 24, note: 120, stops: TOUR_STOP_IDS.length, saved: 5, url: 1800 }
export const MAX_SAVED = PLAN_LIMITS.saved
const MAX_SCAN = 64            // 只檢視前幾個項目：壞資料 / 惡意網址不能讓清洗跑很久
const MAX_NOTES_PARAM = 8000   // ?tournotes= 超過這麼長就不解碼（8 站 × 120 字的中文備註編碼後約 3900 字元，留一倍餘裕）

// ---------------------------------------------------------------------------------------------
// 文字清洗
// ---------------------------------------------------------------------------------------------
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g   // 零寬 / 雙向控制字元（可用來偽裝文字）：直接移除
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g                                 // 換行 / tab / 其他控制字元：換成空白

// 以「字」（Unicode code point）為單位截斷：不會把 emoji 等成對的字元切成一半。
function cutChars(s, max) {
  return Array.from(s.length > max * 4 ? s.slice(0, max * 4) : s).slice(0, max).join('')
}
export const countChars = (s) => (typeof s === 'string' ? Array.from(s).length : 0)

// 完整清洗（存檔 / 編碼前）：移除隱形字元、控制字元換空白、連續空白合併、修剪、截斷。非字串 → ''。
export function cleanText(v, max) {
  if (typeof v !== 'string' || !v) return ''
  const s = v.replace(INVISIBLE, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  return cutChars(s, max).trim()
}
// 輸入框「邊打邊清」用：只去掉不能存在的字元並限制長度，不修剪也不合併空白（否則打不出空白）。
export function sanitizeTyping(v, max) {
  if (typeof v !== 'string' || !v) return ''
  return cutChars(v.replace(INVISIBLE, '').replace(CONTROL, ' '), max)
}

// ---------------------------------------------------------------------------------------------
// 腳本
// ---------------------------------------------------------------------------------------------
export function normalizePlan(input) {
  if (!input || typeof input !== 'object') return null
  const raw = Array.isArray(input) ? input : input.stops
  if (!Array.isArray(raw)) return null
  const stops = []
  const seen = new Set()
  for (let i = 0; i < raw.length && i < MAX_SCAN && stops.length < PLAN_LIMITS.stops; i++) {
    const e = raw[i]
    const id = typeof e === 'string' ? e : e && typeof e === 'object' ? e.id : null
    const key = typeof id === 'string' ? id.trim().toLowerCase() : ''
    if (!TOUR_STOP_IDS.includes(key) || seen.has(key)) continue
    seen.add(key)
    const note = e && typeof e === 'object' ? cleanText(e.note, PLAN_LIMITS.note) : ''
    stops.push(note ? { id: key, note } : { id: key })
  }
  if (!stops.length) return null
  const name = Array.isArray(input) ? '' : cleanText(input.name, PLAN_LIMITS.name)
  return name ? { name, stops } : { stops }
}

export const planToOptions = (plan) => { const p = normalizePlan(plan); return p ? { plan: p } : {} }

const DEFAULT_KEY = TOUR_STOP_IDS.join(',')
// 「預設完整導覽」：沒有腳本，或腳本恰好是全部 8 站、預設順序、沒有備註與名稱——兩者在 UI 上視為同一件事
export function isDefaultPlan(plan) {
  const p = normalizePlan(plan)
  return !p || (!p.name && p.stops.map((s) => s.id).join(',') === DEFAULT_KEY && p.stops.every((s) => !s.note))
}
export function planEquals(a, b) {
  const da = isDefaultPlan(a), db = isDefaultPlan(b)
  if (da || db) return da && db
  return JSON.stringify(normalizePlan(a)) === JSON.stringify(normalizePlan(b))
}

// ---------------------------------------------------------------------------------------------
// base64url（UTF-8）：不依賴 btoa（只吃 Latin-1）與 Buffer（瀏覽器沒有）
// ---------------------------------------------------------------------------------------------
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const INDEX = (() => { const m = {}; for (let i = 0; i < ALPHA.length; i++) m[ALPHA[i]] = i; return m })()

export function b64urlEncode(str) {
  if (typeof TextEncoder === 'undefined') return ''
  const bytes = new TextEncoder().encode(String(str == null ? '' : str))
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2]
    out += ALPHA[a >> 2] + ALPHA[((a & 3) << 4) | ((b === undefined ? 0 : b) >> 4)]
    if (b !== undefined) out += ALPHA[((b & 15) << 2) | ((c === undefined ? 0 : c) >> 6)]
    if (c !== undefined) out += ALPHA[c & 63]
  }
  return out
}

// 壞輸入（非字串 / 不是 base64url 字母 / 長度不可能 / 不是合法 UTF-8）→ null
export function b64urlDecode(s) {
  if (typeof s !== 'string' || typeof TextDecoder === 'undefined') return null
  const t = s.replace(/=+$/, '')
  if (!/^[A-Za-z0-9_-]*$/.test(t) || t.length % 4 === 1) return null
  const bytes = []
  let acc = 0, bits = 0
  for (let i = 0; i < t.length; i++) {
    acc = (acc << 6) | INDEX[t[i]]
    bits += 6
    if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 255) }
    acc &= (1 << bits) - 1
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)) } catch (e) { return null }
}

// ---------------------------------------------------------------------------------------------
// 網址：編碼 / 解碼
// ---------------------------------------------------------------------------------------------
// 站 id 清單字串 → 白名單內、去重後的 id 陣列（開關字 0 / 1 / on / off 與任何未知字都不在白名單，所以會被丟掉）
export function parseIdList(v) {
  if (typeof v !== 'string') return []
  const out = []
  for (const tok of v.slice(0, 200).split(',')) {
    const id = tok.trim().toLowerCase()
    if (TOUR_STOP_IDS.includes(id) && !out.includes(id)) out.push(id)
  }
  return out
}

function decodeNotes(param) {
  if (typeof param !== 'string' || !param || param.length > MAX_NOTES_PARAM) return {}
  const json = b64urlDecode(param)
  if (json == null) return {}
  let obj
  try { obj = JSON.parse(json) } catch (e) { return {} }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
  const out = {}
  for (const id of TOUR_STOP_IDS) if (Object.prototype.hasOwnProperty.call(obj, id) && typeof obj[id] === 'string') out[id] = obj[id]
  return out
}

export function decodePlan(input) {
  const { ids, notes, name } = input && typeof input === 'object' ? input : {}
  const list = Array.isArray(ids) ? parseIdList(ids.join(',')) : parseIdList(ids)
  if (!list.length) return null
  const map = decodeNotes(notes)
  return normalizePlan({ name, stops: list.map((id) => ({ id, note: map[id] })) })
}

export function encodePlan(plan, opts) {
  const { reserve = 0, max = PLAN_LIMITS.url } = opts && typeof opts === 'object' ? opts : {}
  const p = normalizePlan(plan)
  if (!p) return { query: '', truncated: false }
  const ids = p.stops.map((s) => s.id).join(',')
  const noteMap = {}
  for (const s of p.stops) if (s.note) noteMap[s.id] = s.note
  const hasNotes = Object.keys(noteMap).length > 0
  const notes = hasNotes ? b64urlEncode(JSON.stringify(noteMap)) : ''
  const q = (withNotes, withName) => {
    const parts = ['tour=' + ids]
    if (withNotes && notes) parts.push('tournotes=' + notes)
    if (withName && p.name) parts.push('tourname=' + encodeURIComponent(p.name))
    return parts.join('&')
  }
  let query = q(true, true)
  if (reserve + query.length <= max) return { query, truncated: false }
  query = q(false, true)                                        // 太長：先丟備註（最長的部分）
  if (reserve + query.length > max) query = q(false, false)     // 還是太長（網址骨架本身很長）：連名稱也丟
  return { query, truncated: true }
}

export { encodePlan as encode, decodePlan as decode }   // 規格用語的別名（encode / decode）

// ?tour=air,fish 或 ?tourplan=air,fish（第一個能解出至少一個站 id 的參數）＋ ?tournotes= ＋ ?tourname=。沒有 / 不合法 → null。
export function parsePlanFromSearch(search) {
  const s = typeof search === 'string' ? search : ''
  let q
  try { q = new URLSearchParams(s) } catch (e) { return null }
  let ids = []
  for (const v of [...q.getAll('tour'), ...q.getAll('tourplan')]) {
    ids = parseIdList(v)
    if (ids.length) break
  }
  if (!ids.length) return null
  return decodePlan({ ids, notes: q.get('tournotes'), name: q.get('tourname') })
}

// 帶腳本的連結（複製腳本連結 / 複製此站連結用）。只保留 origin + 路徑：不帶原網址的一次性旗標 / hash / 帳密（與 buildTourLink 相同的原則）。
// href 不合法或 plan 沒有任何合法站 → { url:'' }。
export function buildPlanLink(input) {
  const { href, plan, locale = 'zh', stopId, hold = false, max = PLAN_LIMITS.url } = input && typeof input === 'object' ? input : {}
  const p = normalizePlan(plan)
  const base = linkBase(href)
  if (!p || !base) return { url: '', truncated: false, length: 0 }
  const tail = []
  const sid = typeof stopId === 'string' ? stopId.trim().toLowerCase() : ''
  if (TOUR_STOP_IDS.includes(sid)) { tail.push('tourstop=' + sid); if (hold) tail.push('tourhold=1') }
  if (locale === 'en') tail.push('lang=en')
  const tailStr = tail.length ? '&' + tail.join('&') : ''
  const enc = encodePlan(p, { reserve: base.length + 1 + tailStr.length, max })
  const url = `${base}?${enc.query}${tailStr}`
  return { url, truncated: enc.truncated, length: url.length }
}

// ---------------------------------------------------------------------------------------------
// 儲存（LS.tourplan）
// ---------------------------------------------------------------------------------------------
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/
export const emptyStore = () => ({ active: null, plans: [] })

// 讀進來的東西一律當不可信：壞形狀 → 空；每份腳本重新清洗；id 重複 / 不合法的丟掉；超過 5 份只留前 5 份；active 指向不存在的腳本 → null
export function normalizeStore(raw) {
  const out = emptyStore()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const list = Array.isArray(raw.plans) ? raw.plans.slice(0, MAX_SCAN) : []
  const seen = new Set()
  for (const e of list) {
    if (out.plans.length >= MAX_SAVED) break
    if (!e || typeof e !== 'object') continue
    const id = typeof e.id === 'string' && ID_RE.test(e.id) ? e.id : ''
    if (!id || seen.has(id)) continue
    const p = normalizePlan(e)
    if (!p) continue
    seen.add(id)
    out.plans.push({ id, ...p })
  }
  out.active = typeof raw.active === 'string' && seen.has(raw.active) ? raw.active : null
  return out
}

// io = { get(key) → 已解析的值 | null, set(key, value) → boolean }；預設用 localStorage（呼叫當下才讀全域；任何例外 → 讀不到 / 寫失敗）
export const defaultIO = {
  get(key) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null } catch (e) { return null } },
  set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); return true } catch (e) { return false } },
}
export function loadPlanStore(io = defaultIO) {
  try { return normalizeStore(io.get(LS.tourplan)) } catch (e) { return emptyStore() }
}
export function savePlanStore(store, io = defaultIO) {
  try { return !!io.set(LS.tourplan, normalizeStore(store)) } catch (e) { return false }
}

// 頁面載入時生效的腳本：網址腳本（?tour=air,fish …，本次有效）> 上次啟用的已存腳本 > 沒有（預設完整導覽）。純函式：search 與 lib 由呼叫端傳入。
export function resolveInitialPlan({ search = '', lib = emptyStore() } = {}) {
  const fromUrl = parsePlanFromSearch(search)
  if (fromUrl) return { plan: fromUrl, planSrc: 'url', planId: null }
  const act = findPlan(lib, lib && lib.active)
  const p = act ? normalizePlan(act) : null
  return p ? { plan: p, planSrc: 'saved', planId: act.id } : { plan: null, planSrc: null, planId: null }
}

export const findPlan = (store, id) => (store && Array.isArray(store.plans) && typeof id === 'string' ? store.plans.find((p) => p.id === id) || null : null)
const nextId = (store) => { for (let n = 1; ; n++) { const id = 'p' + n; if (!store.plans.some((p) => p.id === id)) return id } }

// 以下都是不可變的操作：回傳新的 store，不改傳入的物件。
export function savePlanAs(store, plan) {
  const p = normalizePlan(plan)
  if (!p) return { ok: false, reason: 'invalid', store }
  if (store.plans.length >= MAX_SAVED) return { ok: false, reason: 'full', store }
  const id = nextId(store)
  return { ok: true, id, store: { ...store, plans: [...store.plans, { id, ...p }] } }
}
export function updatePlan(store, id, plan) {
  const p = normalizePlan(plan)
  if (!p) return { ok: false, reason: 'invalid', store }
  if (!findPlan(store, id)) return { ok: false, reason: 'missing', store }
  return { ok: true, id, store: { ...store, plans: store.plans.map((x) => (x.id === id ? { id, ...p } : x)) } }
}
export function removePlan(store, id) {
  if (!findPlan(store, id)) return store
  return { active: store.active === id ? null : store.active, plans: store.plans.filter((x) => x.id !== id) }
}
export const setActive = (store, id) => ({ ...store, active: findPlan(store, id) ? id : null })

// ---------------------------------------------------------------------------------------------
// 編輯器草稿（每站一列：勾選 / 順序 / 備註）
//   draft = { name: string, rows: [{ id, on: boolean, note: string }] }（rows 恆為 8 列：勾選的站在前、依腳本順序；未勾選的接在後面）
// ---------------------------------------------------------------------------------------------
export function draftFromPlan(plan) {
  const p = normalizePlan(plan)
  const rows = []
  const seen = new Set()
  if (p) for (const s of p.stops) { rows.push({ id: s.id, on: true, note: s.note || '' }); seen.add(s.id) }
  for (const id of TOUR_STOP_IDS) if (!seen.has(id)) rows.push({ id, on: !p, note: '' })   // 沒有腳本 = 預設完整導覽：全部勾選
  return { name: p && p.name ? p.name : '', rows }
}
export function draftToPlan(draft) {
  if (!draft || !Array.isArray(draft.rows)) return null
  return normalizePlan({ name: draft.name, stops: draft.rows.filter((r) => r && r.on).map((r) => ({ id: r.id, note: r.note })) })
}
// 上移 / 下移一列（delta = -1 / +1）；超出範圍 → 原陣列（同一個參照，呼叫端可據此判斷「沒動」）
export function moveRow(rows, i, delta) {
  const j = i + delta
  if (!Array.isArray(rows) || !Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= rows.length || j >= rows.length || !delta) return rows
  const next = rows.slice()
  const t = next[i]; next[i] = next[j]; next[j] = t
  return next
}
export function toggleRow(rows, i) {
  if (!Array.isArray(rows) || !rows[i]) return rows
  return rows.map((r, k) => (k === i ? { ...r, on: !r.on } : r))
}
export function setRowNote(rows, i, text) {
  if (!Array.isArray(rows) || !rows[i]) return rows
  const note = sanitizeTyping(text, PLAN_LIMITS.note)
  return rows.map((r, k) => (k === i ? { ...r, note } : r))
}
export const setDraftName = (draft, text) => ({ ...draft, name: sanitizeTyping(text, PLAN_LIMITS.name) })
export const draftOnCount = (draft) => (draft && Array.isArray(draft.rows) ? draft.rows.filter((r) => r && r.on).length : 0)
