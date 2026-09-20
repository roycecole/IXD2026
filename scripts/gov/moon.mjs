// 中央氣象署 A-B0063-001「月出月沒時刻」→ 單一縣市逐日資料列。純函式，無 I/O。
//   days 每列 = [日期, 月出 HH:MM|"", 月出方位角|null, 中天 HH:MM|"", 中天仰角|null, 仰角方位 "N"|"S"|"", 月沒 HH:MM|"", 月沒方位角|null]
//   原始欄位的 MoonTransitAlt 是 "41S" / "87N"（仰角 + 月球在天頂的南／北側），此處拆成兩欄；無月出／月沒／中天的日子為空字串。
import { toNum, taipeiDateStr, addDays } from './util.mjs'

export const MOON_DATASET = 'A-B0063-001'
export const MOON_COUNTY = '花蓮縣'
export const MOON_DEMO_KEY = 'rdec-key-123-45678-011121314' // CWA 公開示範金鑰（公開資訊、非機密）；CI 有設 CWA_KEY 時優先使用
export const MOON_WINDOW_DAYS = 180 // API 每次每縣市最多回 180 天
export const MOON_LOOKBACK_DAYS = 2 // 視窗從「今天前 2 天」起算：跨午夜的月出／月沒需要看前一天

export const MOON_PARAMS = {
  seaLevel: 0.6, current: 0.35, flowX: 0.5, flowY: 0.5, clarity: 0.85, glow: 0.7, hue: 0.58,
  jellyCount: 0.5, fishCount: 0.6, trashCount: 0.08, swimSpeed: 0.5, spin: 0.28, zoom: 0.5,
}

export const MOON_NOTE =
  '中央氣象署 A-B0063-001「月出月沒時刻」：花蓮縣逐日月出／中天／月沒（台北時間 HH:MM）、月出與月沒的方位角（°，正北 0、順時針）、過中天時的仰角（°）與仰角方位（N／S：月球在天頂的北／南側）。' +
  'days 每列 = [日期, 月出, 月出方位角, 中天, 中天仰角, 仰角方位, 月沒, 月沒方位角]；該日沒有月出／月沒／中天時為 ""（方位角、仰角為 null，每個陰曆月各有一天）。' +
  'CI 每次刷新以 timeFrom／timeTo 取「今日前 2 日起 180 天」的滾動視窗（API 每次至多 180 天；目前公開 2025-01-01 至 2027-12-31）；抓取失敗則保留舊資料，涵蓋範圍隨 CWA 發布而變，請以 from／to 判斷是否涵蓋今日。'

// timeTo 為「不含」的結束日：timeFrom=2026-09-18&timeTo=2027-03-17 剛好回 180 天（到 2027-03-16）
export function moonWindow(nowMs) {
  const from = addDays(taipeiDateStr(nowMs), -MOON_LOOKBACK_DAYS)
  return { from, to: addDays(from, MOON_WINDOW_DAYS) }
}

export const moonApiUrl = (key, from, to, county = MOON_COUNTY) =>
  `https://opendata.cwa.gov.tw/api/v1/rest/datastore/${MOON_DATASET}?Authorization=${encodeURIComponent(key)}&format=JSON&CountyName=${encodeURIComponent(county)}&timeFrom=${from}&timeTo=${to}`

// 先用環境變數的金鑰（repo secret），失敗再用公開示範金鑰
export const moonKeyCandidates = (envKey) => [...new Set([envKey, MOON_DEMO_KEY].filter(Boolean))]

// datastore API（records.locations.location）與公開檔（…dataset.location）外殼不同，遞迴找 location 陣列
function findLocations(json) {
  if (!json || typeof json !== 'object') return null
  if (Array.isArray(json.location)) return json.location
  for (const v of Object.values(json)) {
    const r = findLocations(v)
    if (r) return r
  }
  return null
}

const hhmm = (v) => {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(v ?? '').trim())
  return m ? m[1].padStart(2, '0') + ':' + m[2] : ''
}
const azimuth = (v) => {
  const n = toNum(v)
  return n !== null && n >= 0 && n <= 360 ? n : null
}
const altitude = (v) => {
  const m = /^(\d+(?:\.\d+)?)\s*([NS])?$/i.exec(String(v ?? '').trim())
  const n = m ? Number(m[1]) : null
  return n !== null && n <= 90 ? [n, (m[2] || '').toUpperCase()] : [null, '']
}

/** API 回應 → { county, from, to, days }；找不到該縣市或沒有任何有效日期 → null */
export function buildMoon(json, county = MOON_COUNTY) {
  const loc = (findLocations(json) || []).find((l) => l && l.CountyName === county)
  if (!loc || !Array.isArray(loc.time)) return null
  const byDate = new Map()
  for (const t of loc.time) {
    const date = String(t?.Date ?? '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const [alt, dir] = altitude(t.MoonTransitAlt)
    byDate.set(date, [date, hhmm(t.MoonRiseTime), azimuth(t.MoonRiseAZ), hhmm(t.MoonTransitTime), alt, dir, hhmm(t.MoonSetTime), azimuth(t.MoonSetAZ)])
  }
  const days = [...byDate.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  return days.length ? { county, from: days[0][0], to: days[days.length - 1][0], days } : null
}
