// Open-Meteo Air Quality API（CAMS 全球大氣模型；CC BY 4.0）→ 雲林縣麥寮「逐時」PM2.5 / PM10 / 沙塵 / US AQI + 「空氣品質」海況參數。純函式，無 I/O。
//   這是「模型資料」（分析 + 預報），不是政府測站的觀測值：任何顯示處都要誠實標示，note / source 都寫明。
//   為什麼有它：水利署 IoW 揚塵（雲林 3 站）的 PM10 感測器一律回傳哨兵值、其餘數值疑似凍結，歷史又只能靠排程每 3 小時累積，
//   導覽與播放沒東西可看；環境部空品 API 需要使用者自己申請的金鑰（無金鑰回「api_key 不存在」）。
//   Open-Meteo 免金鑰、一次回傳過去 5 天的逐時資料、數值會變（實測 PM2.5 1–50 μg/m³）。
import { clamp01, round, toNum, parseTaipeiTime, toTaipeiIso } from './util.mjs'

export const AIR_BASE_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality'
export const AIR_COUNTY = '雲林縣'
export const AIR_PLACE = '麥寮'
export const AIR_LAT = 23.79
export const AIR_LON = 120.25
export const AIR_PAST_DAYS = 5 // 每次刷新覆蓋抓取過去 5 天（120 小時）+ 今天；逐時資料，不必像揚塵靠排程累積
export const AIR_HISTORY_MAX = 120 // 只保留「現在以前」最近 120 個小時
export const AIR_HOURLY = ['pm10', 'pm2_5', 'dust', 'us_aqi'] // API 變數名（pm2_5 有底線）
export const AIR_SOURCE = 'Open-Meteo Air Quality API（CAMS 全球大氣模型；CC BY 4.0；模型資料，非政府觀測值）'
export const AIR_SOURCE_URL = 'https://open-meteo.com/en/docs/air-quality-api'

export const AIR_NOTE =
  'Open-Meteo Air Quality API（open-meteo.com；CC BY 4.0，Weather data by Open-Meteo.com）提供的 CAMS 全球大氣模型逐時資料：' +
  '雲林縣麥寮（約 23.79°N、120.25°E）的 PM2.5、PM10、沙塵（μg/m³）與 US AQI（美國 EPA 指標，不是環境部 AQI）。' +
  '這是模型資料（分析 + 預報），非政府觀測值——不是政府測站量到的數字；網格解析度粗（數十公里），數值與地面測站（例如環境部麥寮站）可能有落差，請勿當作官方空品判讀。' +
  '免金鑰、有歷史、數值會變，用來補足水利署 IoW 揚塵資料（PM10 感測器回報無效值、其餘數值疑似凍結）看不到變化的問題。' +
  '逐時資料，每次刷新以 past_days=5 覆蓋抓取，與舊 history 依時間合併去重，丟掉預報的未來小時，只保留「現在以前」最近 120 筆；時間為台北時間（+08:00）。' +
  '有效範圍 0–1000（PM／沙塵為 μg/m³，US AQI 為指數），超出者為 null；air-yunlin 選項以最新一小時的 PM2.5 與今日海況的風速計算海況參數。'

// ---- 請求網址 ----
const clampInt = (v, lo, hi, dflt) => {
  const n = toNum(v)
  return n === null ? dflt : Math.max(lo, Math.min(hi, Math.trunc(n)))
}

/** 逐時 PM10 / PM2.5 / 沙塵 / US AQI 的請求網址（台北時區；past_days 0–92、forecast_days 1–7）。座標不合法 → 丟 RangeError */
export function buildAirUrl({ lat = AIR_LAT, lon = AIR_LON, pastDays = AIR_PAST_DAYS, forecastDays = 1 } = {}) {
  const la = toNum(lat), lo = toNum(lon)
  if (la === null || lo === null || la < -90 || la > 90 || lo < -180 || lo > 180) throw new RangeError(`bad coordinates: ${lat}, ${lon}`)
  const q = [
    ['latitude', String(la)], ['longitude', String(lo)],
    ['hourly', AIR_HOURLY.map(encodeURIComponent).join(',')], // 逗號保持原樣（與實測請求相同）
    ['past_days', String(clampInt(pastDays, 0, 92, AIR_PAST_DAYS))], ['forecast_days', String(clampInt(forecastDays, 1, 7, 1))],
    ['timezone', 'Asia/Taipei'],
  ]
  return AIR_BASE_URL + '?' + q.map(([k, v]) => `${k}=${k === 'hourly' ? v : encodeURIComponent(v)}`).join('&')
}

// ---- 數值驗證 ----
// 有效範圍（含端點）；PM / 沙塵 μg/m³ 0–1000，US AQI 0–1000（指數本身 0–500，留餘裕給模型外插）。超出、非數字、Infinity / NaN → null
export const AIR_LIMITS = { pm10: [0, 1000], pm25: [0, 1000], dust: [0, 1000], aqi: [0, 1000] }
export const AIR_FIELDS = Object.keys(AIR_LIMITS)

// 只收 number 或「數字字串」；布林 / 陣列 / 物件 / 空字串一律當缺值（不像 Number([5]) 會悄悄變 5）
const strictNum = (v) => (typeof v === 'number' ? (Number.isFinite(v) ? v : null) : typeof v === 'string' ? toNum(v) : null)

/** kind：'pm10' | 'pm25' | 'dust' | 'aqi'。回傳四捨五入後的數字（PM / 沙塵 1 位小數、AQI 整數）或 null */
export function validate(kind, v) {
  const lim = AIR_LIMITS[kind]
  const n = strictNum(v)
  if (!lim || n === null || n < lim[0] || n > lim[1]) return null
  return kind === 'aqi' ? Math.round(n) : round(n, 1)
}

const HOUR_MS = 3600 * 1000
const hourFloor = (ms) => Math.floor(ms / HOUR_MS) * HOUR_MS
const isEmptyRow = (r) => AIR_FIELDS.every((k) => r[k] === null)

// 'YYYY-MM-DDTHH:MM'（帶 timezone=Asia/Taipei 時是台北當地時間）→ 該小時起點的絕對毫秒；不合法（含 2 月 30 日）→ null。offsetSec：回應的 utc_offset_seconds
function localHourMs(ts, offsetSec) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(String(ts ?? '').trim())
  if (!m) return null
  const [y, mo, d, h] = [m[1], m[2], m[3], m[4]].map(Number)
  const ms = Date.UTC(y, mo - 1, d, h, 0, 0)
  const back = new Date(ms)
  if (mo < 1 || mo > 12 || h > 23 || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return hourFloor(ms - offsetSec * 1000)
}

/**
 * API 回應 → { rows, stats }（不丟例外：壞資料 → rows: []）
 *   rows：時間遞增、每小時一筆 { t:'YYYY-MM-DDTHH:00:00+08:00', pm10, pm25, dust, aqi }；缺值 / 型別錯誤 / 超出範圍的欄位為 null，
 *         四個欄位全是 null 的小時（沒有任何資訊）與時間不合法的小時略過；重複的時間以後者為準
 *   stats：{ points（原始小時數）, valid（rows 筆數）, skipped }
 *   此處不丟掉未來小時：預報與過去混在同一個回應，「現在以前」的裁切由 mergeHistory 依 nowMs 做（純函式好測）
 */
export function parseAir(json) {
  const stats = { points: 0, valid: 0, skipped: 0 }
  const h = json && typeof json === 'object' ? json.hourly : null
  if (!h || typeof h !== 'object' || !Array.isArray(h.time)) return { rows: [], stats }
  const off = strictNum(json.utc_offset_seconds)
  const offsetSec = off === null ? 8 * 3600 : off
  const col = (name) => (Array.isArray(h[name]) ? h[name] : [])
  const cols = { pm10: col('pm10'), pm25: col('pm2_5'), dust: col('dust'), aqi: col('us_aqi') }
  const byMs = new Map()
  h.time.forEach((ts, i) => {
    stats.points++
    const ms = localHourMs(ts, offsetSec)
    if (ms === null) { stats.skipped++; return }
    const row = { t: toTaipeiIso(ms), pm10: validate('pm10', cols.pm10[i]), pm25: validate('pm25', cols.pm25[i]), dust: validate('dust', cols.dust[i]), aqi: validate('aqi', cols.aqi[i]) }
    if (isEmptyRow(row)) { stats.skipped++; return }
    byMs.set(ms, row)
  })
  const rows = [...byMs].sort((a, b) => a[0] - b[0]).map(([, r]) => r)
  stats.valid = rows.length
  return { rows, stats }
}

// history / rows 的一列 → { ms, row }；時間不合法或全欄位無效 → null（舊檔裡的壞資料也在這裡被清掉）
function normalize(x) {
  if (!x || typeof x !== 'object') return null
  const at = parseTaipeiTime(x.t)
  if (at === null) return null
  const ms = hourFloor(at)
  const row = { t: toTaipeiIso(ms), pm10: validate('pm10', x.pm10), pm25: validate('pm25', x.pm25), dust: validate('dust', x.dust), aqi: validate('aqi', x.aqi) }
  return isEmptyRow(row) ? null : { ms, row }
}

/**
 * 舊 history + 新抓的 rows → 新 history：依小時去重（新的覆蓋舊的；新資料某欄位缺值時保留舊值，整列全無效的新資料不覆蓋舊資料）、
 * 依時間遞增、丟掉「現在以後」的小時（預報）、只留最近 max 筆。不改動輸入。
 */
export function mergeHistory(oldHistory, newRows, { nowMs = Date.now(), max = AIR_HISTORY_MAX } = {}) {
  const byMs = new Map()
  for (const list of [oldHistory, newRows]) {
    for (const x of Array.isArray(list) ? list : []) {
      const n = normalize(x)
      if (!n) continue
      const prev = byMs.get(n.ms)
      byMs.set(n.ms, prev ? Object.fromEntries(Object.entries(n.row).map(([k, v]) => [k, k === 't' ? v : (v ?? prev[k])])) : n.row)
    }
  }
  const limit = Number.isFinite(nowMs) ? nowMs : Date.now()
  const cap = Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : AIR_HISTORY_MAX   // slice(-0) 會回全部，所以 0 要另外處理
  const list = [...byMs]
    .filter(([ms]) => ms <= limit)
    .sort((a, b) => a[0] - b[0])
    .map(([, r]) => r)
  return cap === 0 ? [] : list.slice(-cap)
}

/** 最新一筆「有 PM2.5」的小時；沒有 → null */
export function latestAirRow(history) {
  const list = Array.isArray(history) ? history : []
  for (let i = list.length - 1; i >= 0; i--) if (list[i] && validate('pm25', list[i].pm25) !== null) return list[i]
  return null
}

// ---- 映射 ----
export const AIR_PM_SCALE = 100 // 以台灣常見 PM2.5 範圍 0–100 μg/m³ 規一化
export const AIR_PM_DEFAULT = 15 // 沒有 PM2.5 時的示意值（約為 WHO 日均建議值，看起來偏清澈）

/** PM2.5 → 與 src/lib/series.js automationFor('air') 相同的四個參數（未四捨五入）：PM2.5 高 → 混濁、垃圾多、色相偏黃綠、輝光收斂 */
export function airMap(pm25) {
  const n = clamp01((strictNum(pm25) ?? AIR_PM_DEFAULT) / AIR_PM_SCALE)
  return { clarity: clamp01(0.95 - n * 0.85), trashCount: clamp01(0.06 + n * 0.6), hue: clamp01(0.5 - n * 0.14), glow: clamp01(0.72 - n * 0.42) }
}

/** 海況參數：13 個鍵、皆 0..1、2 位小數。wind（m/s，今日海況氣象）→ 洋流與游速；缺值用 pm25=15、wind=3 */
export function airParams({ pm25, wind } = {}) {
  const pm = strictNum(pm25) ?? AIR_PM_DEFAULT, w = strictNum(wind) ?? 3
  const n = clamp01(pm / AIR_PM_SCALE)
  const p = {
    seaLevel: 0.55,
    current: clamp01(w / 12),
    flowX: 0.5,
    flowY: 0.5,
    ...airMap(pm),
    jellyCount: 0.45,
    fishCount: clamp01(0.7 - n * 0.3),
    swimSpeed: clamp01(0.4 + w / 25),
    spin: 0.28,
    zoom: 0.5,
  }
  for (const k of Object.keys(p)) p[k] = round(p[k], 2)
  return p
}

/** 選項的 level = 最新 PM2.5 四捨五入（沒有 → 0） */
export const airLevel = (pm25) => {
  const n = strictNum(pm25)
  return n === null ? 0 : Math.round(n)
}

// ocean.json 序列化時收成單行的路徑（傳給 stringifyOcean 的第二個參數；json.mjs 的預設清單不含 air）
export const AIR_INLINE_PATHS = ['air.history.*']
