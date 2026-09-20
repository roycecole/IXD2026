// 政府資料模組共用小工具（純函式，無 I/O）。
const TAIPEI_MS = 8 * 3600 * 1000
const DAY_MS = 24 * 3600 * 1000

export const clamp01 = (v) => Math.max(0, Math.min(1, v))

export const round = (v, digits = 2) => {
  const k = 10 ** digits
  return Math.round(v * k) / k
}

// 嚴格轉數字：空字串 / null / 非數字 → null（不像 parseFloat 會把 "12abc" 當 12）
export function toNum(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v).trim()
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

// 水利署 API 的字串常帶 HTML 實體，例如「許厝寮&#40;10號越堤路&#41;堤防揚塵監控站」。單層解碼。
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
    }
    const v = NAMED_ENTITIES[e.toLowerCase()]
    return v === undefined ? m : v
  })
}

// 時間：一律以台北時間（UTC+8，無夏令）表示。無時區後綴的字串視為台北時間（CI 主機是 UTC，不能吃本機時區）。
export function parseTaipeiTime(s) {
  if (s === null || s === undefined || s === '') return null
  const str = String(s).trim()
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(str)
  const ms = Date.parse(hasZone ? str : str.replace(' ', 'T') + '+08:00')
  return Number.isFinite(ms) ? ms : null
}
export const toTaipeiIso = (ms) => new Date(ms + TAIPEI_MS).toISOString().slice(0, 19) + '+08:00'
export const taipeiDateStr = (ms) => new Date(ms + TAIPEI_MS).toISOString().slice(0, 10)
export const addDays = (dateStr, n) => new Date(Date.parse(dateStr + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10)
