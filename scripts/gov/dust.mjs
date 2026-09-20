// IoW 揚塵（水利署物聯網，雲林縣濁水溪沿岸揚塵監控站）→ 各站最新值 + 全縣摘要 + 「揚塵」海況參數。純函式，無 I/O。
//   最新值資料集（data.gov.tw 143273）只有 sensorid / latestvalue / timestamp，沒有物理量名稱；
//   物理量（sensorname）、單位、站名、經緯度、鄉鎮在「基本資料」（143272），以 sensorid join。
//   兩者皆為公開、免金鑰的 JSON 端點。
import { clamp01, round, toNum, mean, decodeEntities, parseTaipeiTime, toTaipeiIso } from './util.mjs'

export const DUST_LATEST_URL = 'https://opendata.wra.gov.tw/api/v2/ae7bd821-a879-4b65-ad34-b3dac36874e0?sort=_importdate%20asc&format=JSON'
export const DUST_META_URL = 'https://opendata.wra.gov.tw/api/v2/a2ea1f32-9876-4228-8ee6-2284e49ea28d?sort=_importdate%20asc&format=JSON'
export const DUST_COUNTY = '雲林縣'
export const DUST_HISTORY_MAX = 120 // CI 每 3 小時一次 → 約 15 天

export const DUST_NOTE =
  '水利署 IoW 揚塵監控站最新值（data.gov.tw 143273 最新值 + 143272 基本資料；雲林縣濁水溪沿岸 3 站，PM10／風速／氣溫／相對濕度，約每小時更新）。' +
  'API 只提供最新一筆，history 由 CI 每 3 小時累積（保留最近 120 筆，約 15 天）。' +
  '感測器故障時會回傳哨兵值或離譜值（PM10 常為 4999.4、氣溫曾見 1957℃）：PM10 有效範圍 0–3000μg/m³（排除 4999.4）、風速 0–60m/s、氣溫 −20–50℃、相對濕度 0–100%，超出者一律為 null；' +
  'PM10 全數無效時，dust-yunlin 選項以預設 PM10=40μg/m³ 計算海況參數（level=0）。' +
  '來源也可能長時間回傳相同數值、只有時戳照常前進（凍結），請以 history 是否有變動判讀。'

const SENTINEL_PM10 = 4999.4

// sensorname（+ unit 交叉驗證）→ 物理量。注意不能用 sensorfullname：中興村的風速計全名叫「…風向計」。
const KINDS = {
  pm10: { name: /pm\s*[-_]?\s*10/i, unit: /[μµu]g\/?m/i, valid: (v) => v > 0 && v < 3000 && v !== SENTINEL_PM10 },
  wind: { name: /風速|wind\s*speed/i, unit: /m\/?s|公尺/i, valid: (v) => v >= 0 && v <= 60 },
  temp: { name: /氣溫|溫度|temperature/i, unit: /℃|°c|^c$|攝氏/i, valid: (v) => v >= -20 && v <= 50 },
  rh: { name: /相對[濕溼]度|[濕溼]度|humidity/i, unit: /^[%％]|%rh/i, valid: (v) => v >= 0 && v <= 100 },
}
export const DUST_KINDS = Object.keys(KINDS)

const normUnit = (u) => String(u ?? '').replace(/／/g, '/').replace(/\s+/g, '').toLowerCase()

// 名稱對得上、且（有給單位時）單位相容才算；名稱相同但單位矛盾（例如「風速」卻是 ℃）視為未知，寧可略過
export function sensorKind(sensorname, unit) {
  const name = String(sensorname ?? '')
  const u = normUnit(unit)
  for (const [kind, rule] of Object.entries(KINDS)) {
    if (!rule.name.test(name)) continue
    return u === '' || rule.unit.test(u) ? kind : null
  }
  return null
}

export const isValidReading = (kind, v) => Number.isFinite(v) && !!KINDS[kind] && KINDS[kind].valid(v)

/**
 * 最新值列 + 基本資料列 → { stations, summary, stats }
 *   stations[]：以 observatoryidentifier 分組，同站 4 個物理量併成一筆；無效值為 null
 *   summary：全縣各物理量「有效站值」的平均（無有效值為 null）與最新時戳
 *   stats：{ sensors, invalid:{pm10,wind,temp,rh}, invalidTotal, unmatched }
 */
export function buildDust(latestRows, metaRows, { county = DUST_COUNTY } = {}) {
  const meta = new Map()
  for (const m of Array.isArray(metaRows) ? metaRows : []) {
    if (!m || !m.sensorid) continue
    if (String(m.isenable).toLowerCase() === 'false') continue
    if (county && m.countyname && m.countyname !== county) continue
    meta.set(String(m.sensorid).toLowerCase(), m)
  }

  const stats = { sensors: 0, invalid: { pm10: 0, wind: 0, temp: 0, rh: 0 }, invalidTotal: 0, unmatched: 0 }
  const byStation = new Map()
  for (const row of Array.isArray(latestRows) ? latestRows : []) {
    const m = meta.get(String(row?.sensorid ?? '').toLowerCase())
    const kind = m && sensorKind(m.sensorname, m.unit)
    if (!kind) { stats.unmatched++; continue }
    stats.sensors++
    const id = m.observatoryidentifier || String(m.observatoryname || m.sensorid)
    let st = byStation.get(id)
    if (!st) byStation.set(id, (st = { m, vals: { pm10: [], wind: [], temp: [], rh: [] }, ts: [] }))
    const ts = parseTaipeiTime(row.timestamp)
    if (ts !== null) st.ts.push(ts)
    const v = toNum(row.latestvalue)
    if (v !== null && isValidReading(kind, v)) st.vals[kind].push(v)
    else { stats.invalid[kind]++; stats.invalidTotal++ }
  }

  const stations = []
  for (const [id, st] of [...byStation].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const lon = toNum(st.m.longitude), lat = toNum(st.m.latitude)
    const avg = (xs) => (xs.length ? round(mean(xs), 2) : null)
    stations.push({
      id,
      name: decodeEntities(String(st.m.observatoryname ?? '').trim()),
      town: decodeEntities(String(st.m.townname ?? '').trim()),
      lon: lon === null ? null : round(lon, 4),
      lat: lat === null ? null : round(lat, 4),
      pm10: avg(st.vals.pm10), wind: avg(st.vals.wind), temp: avg(st.vals.temp), rh: avg(st.vals.rh),
      t: st.ts.length ? toTaipeiIso(Math.max(...st.ts)) : null,
    })
  }

  const across = (key) => {
    const xs = stations.map((s) => s[key]).filter((v) => v !== null)
    return xs.length ? round(mean(xs), 2) : null
  }
  const times = stations.map((s) => (s.t ? Date.parse(s.t) : null)).filter((t) => t !== null)
  const summary = {
    t: times.length ? toTaipeiIso(Math.max(...times)) : null,
    pm10: across('pm10'), wind: across('wind'), temp: across('temp'), rh: across('rh'),
  }
  return { stations, summary, stats }
}

// 揚塵選項 level = 有效 PM10 平均取整（無有效值 → 0）
export const dustLevel = (pm10) => (pm10 === null || pm10 === undefined ? 0 : Math.round(pm10))

// 海況參數：缺值用預設 pm=40、wind=3、temp=25。13 個鍵、皆 0..1、小數 2 位。
export function dustParams({ pm10, wind, temp } = {}) {
  const pm = pm10 ?? 40, w = wind ?? 3, tp = temp ?? 25
  const p = {
    seaLevel: 0.55,
    current: clamp01(w / 12),
    flowX: 0.5,
    flowY: 0.5,
    clarity: clamp01(0.95 - pm / 220),
    glow: 0.6,
    hue: clamp01(0.5 - pm / 600),
    jellyCount: clamp01(0.3 + (tp - 15) / 40),
    fishCount: clamp01(0.7 - pm / 400),
    trashCount: clamp01(0.06 + pm / 450),
    swimSpeed: clamp01(0.4 + w / 25),
    spin: 0.28,
    zoom: 0.5,
  }
  for (const k of Object.keys(p)) p[k] = round(p[k], 2)
  return p
}

// 滾動累積：最新時戳不在 history 就追加；依時間排序、去重（以時刻為準），只留最近 max 筆
export function appendHistory(history, entry, max = DUST_HISTORY_MAX) {
  const norm = (x) => ({ t: x.t, pm10: x.pm10 ?? null, wind: x.wind ?? null, temp: x.temp ?? null, rh: x.rh ?? null })
  const list = new Map()
  for (const x of Array.isArray(history) ? history : []) {
    const ms = x && parseTaipeiTime(x.t)
    if (ms !== null && ms !== undefined) list.set(ms, norm(x))
  }
  const ms = entry && parseTaipeiTime(entry.t)
  if (ms !== null && ms !== undefined && !list.has(ms)) list.set(ms, norm(entry))
  return [...list].sort((a, b) => a[0] - b[0]).map(([, v]) => v).slice(-max)
}
