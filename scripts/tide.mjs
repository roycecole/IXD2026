// CWA F-A0021-001「潮汐預報」→ 24h 潮位 series（純函式，無 I/O，可直接在 Node 測試）。
// 兩種來源同一份資料、不同外殼，都以遞迴找 TideForecasts 解析：
//   · 有 CWA_KEY：opendata.cwa.gov.tw/api/v1/rest/datastore/F-A0021-001（records.TideForecasts）
//   · 無金鑰：公開檔 cwaopendata.s3…/Forecast/F-A0021-001.json（cwaopendata.Resources.Resource.Data.TideForecasts）
const HOUR = 3600 * 1000
const TAIPEI = 8 * HOUR

export const TIDE_FILE_URL = 'https://cwaopendata.s3.ap-northeast-1.amazonaws.com/Forecast/F-A0021-001.json'
export const tideApiUrl = (key) => `https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-A0021-001?Authorization=${encodeURIComponent(key)}&format=JSON`

export function findTideForecasts(json) {
  if (!json || typeof json !== 'object') return null
  if (Array.isArray(json.TideForecasts)) return json.TideForecasts
  for (const v of Object.values(json)) { const r = findTideForecasts(v); if (r) return r }
  return null
}

export function pickLocation(list, name = '花蓮縣花蓮市') {
  const locs = list.map((t) => t && t.Location).filter(Boolean)
  return locs.find((l) => l.LocationName === name) || locs.find((l) => (l.LocationName || '').includes('花蓮')) || null
}

// 展平成事件 [{ t(ms), v(cm), type }]，datum 預設「海圖基準」（恆正，適合畫水位）
export function flattenEvents(loc, datum = 'AboveChartDatum') {
  const out = []
  const daily = (loc && loc.TimePeriods && loc.TimePeriods.Daily) || []
  for (const day of daily) for (const e of day.Time || []) {
    const v = parseFloat(e.TideHeights && e.TideHeights[datum])
    const t = Date.parse(e.DateTime)
    if (Number.isFinite(v) && Number.isFinite(t)) out.push({ t, v, type: e.Tide || '' })
  }
  return out.sort((a, b) => a.t - b.t)
}

export const dayMeta = (loc, dateStr) => {
  const d = ((loc && loc.TimePeriods && loc.TimePeriods.Daily) || []).find((x) => x.Date === dateStr)
  return d ? { lunar: d.LunarDate, range: d.TideRange } : null
}

export const taipeiDate = (nowMs) => new Date(nowMs + TAIPEI).toISOString().slice(0, 10)
export const taipeiHour = (nowMs) => { const d = new Date(nowMs + TAIPEI); return d.getUTCHours() + d.getUTCMinutes() / 60 }

// 以「乾滿潮事件」餘弦插值出當日逐時潮位；頭尾缺鄰近事件時以相鄰半週期鏡射補齊（潮汐近似對稱）
export function buildTideSeries(events, dateStr) {
  const t0 = Date.parse(dateStr + 'T00:00:00+08:00')
  const t1 = t0 + 24 * HOUR
  const ev = events.slice().sort((a, b) => a.t - b.t)
  if (ev.length < 2) return null
  let guard = 0
  while (ev[0].t > t0 && guard++ < 4) ev.unshift({ t: ev[0].t - (ev[1].t - ev[0].t), v: ev[1].v, type: 'mirror' })
  guard = 0
  while (ev[ev.length - 1].t < t1 && guard++ < 4) { const n = ev.length; ev.push({ t: ev[n - 1].t + (ev[n - 1].t - ev[n - 2].t), v: ev[n - 2].v, type: 'mirror' }) }
  const points = []
  for (let h = 0; h < 24; h++) {
    const T = t0 + h * HOUR
    let i = 0
    while (i < ev.length - 2 && ev[i + 1].t <= T) i++
    const a = ev[i], b = ev[i + 1]
    const f = Math.max(0, Math.min(1, (T - a.t) / (b.t - a.t)))
    points.push({ h, v: Math.round(a.v + (b.v - a.v) * (1 - Math.cos(Math.PI * f)) / 2) })
  }
  const today = ev.filter((e) => e.type !== 'mirror' && e.t >= t0 && e.t < t1)
    .map((e) => ({ h: Math.round(((e.t - t0) / HOUR) * 100) / 100, v: e.v, type: e.type }))
  return { points, events: today }
}

// 農曆日期 "2026-08-10" → "農曆八月初十"
const LM = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']
const LD = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十', '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十']
export function lunarLabel(s) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s || '')
  if (!m) return ''
  const mo = LM[parseInt(m[2], 10) - 1], dy = LD[parseInt(m[3], 10) - 1]
  return mo && dy ? `農曆${mo}月${dy}` : ''
}
