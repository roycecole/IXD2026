// 刷新 public/data/ocean.json：保留水庫選項與時間序列（政府開放資料快照），
// 以即時氣象重算每個水庫選項的海洋參數，並刷新「花蓮外海」的 24h 潮汐 series。
// 於 GitHub Actions 排程執行（refresh-data.yml）。Node 18+ 內建 fetch。
//   氣象：有 CWA_KEY（repo secret）→ 中央氣象署 opendata 觀測站；否則 / 失敗 → Open-Meteo。
//   潮汐：有 CWA_KEY → datastore API；否則 / 失敗 → CWA 公開檔（免金鑰）；再失敗 → 保留舊 series。
//   揚塵：水利署 IoW 最新值 + 基本資料（免金鑰）→ dust.stations、滾動累積 dust.history、dust-yunlin 的 level / params。
//   月亮：CWA A-B0063-001 月出月沒（CWA_KEY，沒有就用公開示範金鑰）→ moon（今日前 2 日起 180 天的滾動視窗）。
//   空氣品質：Open-Meteo Air Quality API（CAMS 全球大氣模型，免金鑰；「模型資料」，不是政府觀測值）→ air（麥寮逐時 PM2.5 / PM10 / 沙塵 / US AQI，
//     最近 120 小時）、air-yunlin 的 level / params。逐時資料，每次抓 past_days=5 覆蓋更新並與舊 history 合併去重。
//     另外補上逐時風速 wind / 風向 windDir（Open-Meteo 預報 API，同樣是模型資料；請求失敗只是保留舊值 / null，不影響 PM 序列）。
//   環境部測站觀測：有 MOENV_KEY（使用者自己申請的金鑰；repo secret）→ 目前值 + 歷史資料集 → air.obs（離模型格點最近、25 公里內的測站；政府資料開放授權條款－第1版），
//     供前端做「模型 vs 觀測」並列。沒有金鑰 → 略過（印一行說明，不算失敗、不影響其他資料）；抓失敗 → 保留舊 obs（≤ 48 小時），更舊的移除。金鑰絕不進日誌 / ocean.json。
//   （歷史靜態資料 stations / fish / birds.yearly 由 bake-static-data.mjs 一次性烘焙，CI 只原樣保留。）
// 每個資料集各自 try/catch：失敗時 console.error 並保留舊資料，不會擋住其他資料集。
import { readFile, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  TIDE_FILE_URL, tideApiUrl, findTideForecasts, pickLocation, flattenEvents,
  buildTideSeries, dayMeta, lunarLabel, taipeiDate, taipeiHour,
} from './tide.mjs'
import { getJson, retry } from './gov/http.mjs'
import { buildDust, dustLevel, dustParams, appendHistory, DUST_LATEST_URL, DUST_META_URL, DUST_NOTE, DUST_COUNTY } from './gov/dust.mjs'
import { buildMoon, moonApiUrl, moonWindow, moonKeyCandidates, MOON_NOTE, MOON_COUNTY } from './gov/moon.mjs'
import {
  buildAirUrl, parseAir, mergeHistory, latestAirRow, airParams, airLevel, buildWindUrl, parseWind, applyWind,
  AIR_COUNTY, AIR_PLACE, AIR_LAT, AIR_LON, AIR_SOURCE, AIR_SOURCE_URL, AIR_NOTE, AIR_INLINE_PATHS,
} from './gov/air.mjs'
import { fetchAirObs, retainObs, normalizeKey, maskKey } from './gov/moenv.mjs'
import {
  ensureGovOptions, ensureAirOption, syncAirOption, orderOption, orderTop, appendParts, withBirdsNoteAppendix,
  SOURCE_LABEL, BASE_MAPPING, MAPPING_ADDITIONS, AIR_MAPPING, AIR_SOURCE_DISCLOSURE, OBS_MAPPING, OBS_SOURCE_DISCLOSURE, AIR_BASIN_OPTION_ID, BIRDS_NOTE_APPENDIX,
} from './gov/shape.mjs'
import { stringifyOcean, INLINE_PATHS } from './gov/json.mjs'
import { toTaipeiIso } from './gov/util.mjs'

const LAT = 24.0, LON = 121.6
const clamp01 = (v) => Math.max(0, Math.min(1, v))
const r2 = (v) => Math.round(v * 100) / 100
const HOUR = 3600 * 1000

function optionParams(w, level) {
  const tempN = clamp01((w.airTemp - 16) / 16)
  const current = clamp01(w.windSpeed / 14)
  const rad = (w.windDir * Math.PI) / 180
  const clarity = clamp01(0.5 + (w.clear ? 0.3 : 0) - w.precip * 0.15 - Math.max(0, (w.humidity - 80) / 100))
  return {
    seaLevel: r2(clamp01(level / 100)), // 水位%直接對應：滿庫=滿球（>98.5% 於場景端觸發外緣溢流）
    current: r2(current),
    flowX: r2(clamp01(0.5 + 0.4 * Math.sin(rad))),
    flowY: r2(clamp01(0.5 + 0.4 * Math.cos(rad))),
    clarity: r2(clarity),
    glow: r2(clamp01((w.isDay ? 0.7 : 0.5) + (w.clear ? 0.1 : 0))),
    hue: 0.5,
    jellyCount: r2(clamp01(0.35 + tempN * 0.45)),
    fishCount: r2(clamp01(0.4 + (level / 100) * 0.35)),
    trashCount: r2(clamp01(0.08 + w.precip * 0.3 + (1 - clarity) * 0.25)),
    swimSpeed: r2(clamp01(0.4 + current * 0.4)),
    spin: 0.28, zoom: 0.5,
  }
}

// 中央氣象署開放資料（政府源）：自動氣象站 O-A0001-001，取花蓮站
async function fromCWA(key) {
  const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0001-001?Authorization=${key}&StationName=花蓮`
  const j = await getJson(url, 30000)
  const st = j?.records?.Station?.[0]
  if (!st) throw new Error('CWA: no station row')
  const we = st.WeatherElement || {}
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }
  const weather = we.Weather || ''
  const hour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' })).getHours()
  return {
    airTemp: num(we.AirTemperature), humidity: num(we.RelativeHumidity),
    windSpeed: num(we.WindSpeed), windDir: num(we.WindDirection),
    precip: num(we.Now?.Precipitation), clear: weather.includes('晴'),
    isDay: hour >= 6 && hour < 18, weather: weather || '—',
    time: st.ObsTime?.DateTime || new Date().toISOString(), gov: true,
  }
}

async function fromOpenMeteo() {
  const wx = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation,cloud_cover,is_day&timezone=Asia%2FTaipei`, 30000)
  const c = wx.current
  const w = { airTemp: c.temperature_2m, humidity: c.relative_humidity_2m, windSpeed: r2(c.wind_speed_10m / 3.6), windDir: c.wind_direction_10m, precip: c.precipitation, clear: c.cloud_cover < 40, isDay: !!c.is_day, weather: c.cloud_cover < 40 ? '晴' : c.cloud_cover < 80 ? '多雲' : '陰', time: c.time, gov: false }
  try { const wave = await getJson(`https://marine-api.open-meteo.com/v1/marine?latitude=${LAT}&longitude=${LON}&current=sea_surface_temperature&timezone=Asia%2FTaipei`, 30000); if (wave?.current?.sea_surface_temperature) w.airTemp = wave.current.sea_surface_temperature } catch (e) {}
  return w
}

// 潮汐：CWA F-A0021-001 → 花蓮市當日 24h 潮位。併入上次保存的事件（前一日尾端）讓頭段曲線精準。
async function refreshTide(cur, now) {
  const key = process.env.CWA_KEY
  let json = null, via = ''
  if (key) {
    try { json = await getJson(tideApiUrl(key)); via = 'CWA opendata API（CWA_KEY）' }
    catch (e) { console.error('tide datastore failed → 改用公開檔:', e.message) }
  }
  if (!json || !findTideForecasts(json)) { json = await getJson(TIDE_FILE_URL); via = 'CWA 公開檔 F-A0021-001' }
  const list = findTideForecasts(json)
  if (!list) throw new Error('no TideForecasts in payload')
  const loc = pickLocation(list)
  if (!loc) throw new Error('no Hualien location')

  const date = taipeiDate(now)
  const t0 = Date.parse(date + 'T00:00:00+08:00')
  const oldAll = (cur?.options?.find((o) => o.kind === 'tide')?.series?.eventsAll || [])
    .map((e) => ({ t: Date.parse(e[0]), v: e[1], type: e[2] })).filter((e) => Number.isFinite(e.t))
  const merged = new Map()
  for (const e of oldAll) merged.set(e.t, e)
  for (const e of flattenEvents(loc)) merged.set(e.t, e)      // 新抓的覆蓋舊的
  const all = [...merged.values()].sort((a, b) => a.t - b.t)
  const built = buildTideSeries(all, date)
  if (!built) throw new Error('not enough tide events')
  const meta = dayMeta(loc, date) || {}
  const keep = all.filter((e) => e.t >= t0 - 36 * HOUR && e.t <= t0 + 60 * HOUR)
  return {
    via,
    series: {
      label: '潮位', unit: 'cm', date, target: 'seaLevel', station: loc.LocationName,
      lunar: meta.lunar || '', lunarLabel: lunarLabel(meta.lunar), range: meta.range || '',
      note: `${via}：花蓮乾滿潮事件之餘弦插值（海圖基準，恆正）。滿潮 → 海水滿球外緣溢流`,
      points: built.points, events: built.events,
      eventsAll: keep.map((e) => [new Date(e.t).toISOString(), e.v, e.type]),
    },
  }
}

// 揚塵：IoW 最新值 + 基本資料（sensorid join）→ dust 區塊 + dust-yunlin 選項的 level / params。
// 最新值只有一筆，history 在此滾動累積（最新時戳不在 history 才追加，保留最近 120 筆）。
// 注意：水利署 opendata「並行」請求時實測約 1/4 會回錯置（A 端點回 B 資料集內容）、空白或截斷的 JSON，依序請求則 60/60 正常
// → 這裡一律依序抓，不用 Promise.all；仍出現異常（沒有時戳、join 為空、空內容…）就整段重試（最多 3 次，間隔 10 / 20 秒），
// 仍失敗才保留舊資料。
async function refreshDust(cur) {
  return retry(async () => {
    const latest = await getJson(DUST_LATEST_URL, 60000)
    const meta = await getJson(DUST_META_URL, 60000)
    const { stations, summary, stats } = buildDust(latest, meta)
    if (!stations.length) throw new Error('no dust stations (latest/meta join is empty)')
    if (!summary.t) throw new Error(`no dust timestamp; sample row: ${JSON.stringify((Array.isArray(latest) ? latest : [])[0])}`)
    return {
      dust: { county: DUST_COUNTY, note: DUST_NOTE, stations, history: appendHistory(cur?.dust?.history, summary) },
      level: dustLevel(summary.pm10),
      params: dustParams(summary),
      summary, stats,
    }
  }, { attempts: 3, delayMs: 10000, label: 'dust' })
}

// 月出月沒：CWA A-B0063-001（花蓮縣）。以 timeFrom/timeTo 取「今日前 2 日起 180 天」，才會涵蓋今天
//（不帶時間參數只回 2025-01-01 起的 180 天）。先用 CWA_KEY，失敗再用公開示範金鑰。
async function refreshMoon(now) {
  const { from, to } = moonWindow(now)
  const errors = []
  for (const key of moonKeyCandidates(process.env.CWA_KEY)) {
    try {
      const json = await retry(() => getJson(moonApiUrl(key, from, to), 60000), { attempts: 2, delayMs: 5000, label: 'moon' }) // 401（金鑰錯）不重試，直接換下一把
      const m = buildMoon(json, MOON_COUNTY)
      if (!m) throw new Error(`no ${MOON_COUNTY} days for ${from}..${to}`)
      return { county: m.county, from: m.from, to: m.to, note: MOON_NOTE, days: m.days }
    } catch (e) { errors.push(e.message) }
  }
  throw new Error(errors.join(' | ') || 'no CWA key')
}

// 空氣品質：Open-Meteo Air Quality（CAMS 模型資料，免金鑰）。逐時資料（不像揚塵只有最新值），每次以 past_days=5 覆蓋抓取，
// 與舊 history 依小時合併去重、丟掉預報的未來小時、保留最近 120 筆。整段（請求 + 解析 + 檢查）失敗才重試（最多 3 次，間隔 5 / 10 秒）。
// 只有一個請求，不與其他資料集並行（main 依序 await）。deps 供測試注入：{ getJson, retryOpts }。
//   weather：今日海況的氣象（風速 → 洋流）；nowMs：「現在」——之後的小時是預報，不收進 history。
export async function refreshAir(cur, nowMs, weather, deps = {}) {
  const fetchJson = deps.getJson || getJson
  return retry(async () => {
    const json = await fetchJson(buildAirUrl(), 60000)
    const { rows, stats } = parseAir(json)
    if (!rows.length) throw new Error(`no valid air rows (points=${stats.points} skipped=${stats.skipped})`)
    if (!rows.some((r) => r.pm25 !== null)) throw new Error('no PM2.5 values in air response (schema changed?)')
    const history = mergeHistory(cur?.air?.history, rows, { nowMs })
    const last = latestAirRow(history)
    if (!last) throw new Error('no PM2.5 in air history (all rows are in the future?)')
    return {
      air: {
        county: AIR_COUNTY, place: AIR_PLACE, lat: AIR_LAT, lon: AIR_LON,
        source: AIR_SOURCE, sourceUrl: AIR_SOURCE_URL, note: AIR_NOTE, fetchedAt: toTaipeiIso(nowMs), history,
      },
      level: airLevel(last.pm25),
      params: airParams({ pm25: last.pm25, wind: weather && weather.windSpeed }),
      last, fetched: rows.length,
    }
  }, { attempts: 3, delayMs: 5000, label: 'air', ...(deps.retryOpts || {}) })
}

// 逐時風速 / 風向（Open-Meteo 預報 API，模型資料）→ 併進 air.history 對應的小時。與 PM 序列是不同的請求：這裡失敗只會讓風速 / 風向保持舊值（或 null），
// 絕不影響 PM 序列（永遠回傳 history，不丟例外）。deps 供測試注入：{ getJson, retryOpts }。
//   回傳 { history, fetched（回應裡的有效小時數）, matched（history 裡有風速的小時數）, error（失敗訊息或 null） }
export async function refreshAirWind(history, deps = {}) {
  const fetchJson = deps.getJson || getJson
  const count = (h) => h.filter((r) => r && typeof r.wind === 'number').length
  try {
    const rows = await retry(async () => {
      const { rows: r, stats } = parseWind(await fetchJson(buildWindUrl(), 60000))
      if (!r.length) throw new Error(`no valid wind rows (points=${stats.points} skipped=${stats.skipped})`)
      return r
    }, { attempts: 2, delayMs: 5000, label: 'air-wind', ...(deps.retryOpts || {}) })
    const out = applyWind(history, rows)
    return { history: out, fetched: rows.length, matched: count(out), error: null }
  } catch (e) {
    const out = applyWind(history, [])
    return { history: out, fetched: 0, matched: count(out), error: e && e.message ? e.message : String(e) }
  }
}

// 環境部測站觀測 → air.obs（見 gov/moenv.mjs）。金鑰只讀環境變數 MOENV_KEY（deps.key 可注入測試）：
//   · 沒有金鑰（未設 / 空字串 / 只有空白）→ 略過並印一行說明，不算失敗；仍套用「舊 obs 最多撐 48 小時、且最新一筆有效 PM2.5 的小時本身也不能過期」的規則（過期的觀測不能當現在的；見 moenv.mjs 的 retainObs）
//   · 有金鑰但請求失敗 / 逾時 / 回應格式不對 / 金鑰錯誤 → 保留舊 obs（fetchedAt 距今 ≤ 48 小時且最新有效 PM2.5 小時未過期），否則移除；各請求依序、有重試，整段 try/catch，不影響其他資料集
// 日誌與錯誤訊息一律不含金鑰（maskKey）。deps 供測試注入：{ key, fetch, retryOpts, log, error }。
//   回傳 { obs（要寫進 air.obs 的物件，或 null）, status: 'skipped' | 'fresh' | 'kept' | 'dropped' | 'none', error?, stats? }
export async function refreshAirObs(cur, nowMs, deps = {}) {
  const log = typeof deps.log === 'function' ? deps.log : (m) => console.log(m)
  const error = typeof deps.error === 'function' ? deps.error : (m) => console.error(m)
  const key = normalizeKey(deps.key !== undefined ? deps.key : process.env.MOENV_KEY)
  const old = cur && cur.air ? cur.air.obs : undefined
  const kept = retainObs(old, nowMs)
  if (!key) {
    log('MOENV_KEY 未設定，略過環境部觀測')
    return { obs: kept, status: 'skipped' }
  }
  try {
    const r = await fetchAirObs({ key, lat: AIR_LAT, lon: AIR_LON, nowMs, old: kept, fetch: deps.fetch, retryOpts: deps.retryOpts, log: (m) => log(maskKey(m, key)) })
    return { obs: r.obs, status: 'fresh', stats: r.stats }
  } catch (e) {
    const msg = maskKey(e && e.message ? e.message : String(e), key)
    error(`moenv obs failed, ${kept ? 'keep old obs (≤ 48h)' : old ? 'old obs is older than 48h → removed' : 'no old obs'}: ${msg}`)
    return { obs: kept, status: kept ? 'kept' : old ? 'dropped' : 'none', error: msg }
  }
}

// 舊 mapping 若帶著「可改用環境部測站觀測驅動」那句、但這次沒有 obs（金鑰移除 / 觀測過期）→ 拿掉，免得說明與現況不符
export const withoutObsMapping = (mapping, hasObs) => (typeof mapping === 'string' && !hasObs ? mapping.split(' · ').filter((p) => p !== OBS_MAPPING).join(' · ') : mapping)

const FALLBACK = [
  { id: 'feitsui', name: '翡翠水庫', region: '北', level: 77.3 },
  { id: 'shimen', name: '石門水庫', region: '北', level: 100 },
  { id: 'zengwen', name: '曾文水庫', region: '南', level: 100 },
]
// 揚塵／月亮／空氣品質選項的參數來自各自的資料集而非天氣：沿用上次值（揚塵、空氣品質刷新成功時再覆寫）
const OWN_PARAMS_KINDS = new Set(['dust', 'moon', 'air'])

async function main() {
  // pathToFileURL(resolve(...))：路徑含 # ? 空白或為 Windows 路徑都安全（字串拼 file:// 會錯）
  const url = process.env.OCEAN_JSON_PATH ? pathToFileURL(resolvePath(process.env.OCEAN_JSON_PATH)) : new URL('../public/data/ocean.json', import.meta.url)
  let cur = null
  try { cur = JSON.parse(await readFile(url, 'utf8')) } catch (e) {}

  let w = null
  const key = process.env.CWA_KEY
  if (key) {
    try { w = await fromCWA(key); console.log('CWA opendata ok（政府源）') }
    catch (e) { console.error('CWA fetch failed, fallback:', e.message) }
  }
  if (!w) {
    try { w = await fromOpenMeteo() }
    catch (e) {
      console.error('weather fetch failed:', e.message)
      // 天氣失敗不該擋住其他資料（例如每日潮汐、逐日刷新的各資料集）：沿用上次的天氣繼續刷新
      const o = cur && cur.weather
      if (!o) process.exit(0) // 連舊天氣都沒有 → 不覆蓋既有檔案
      const hr = taipeiHour(Date.now())
      w = { airTemp: o.airTemp, humidity: o.humidity, windSpeed: o.windSpeed, windDir: o.windDir, precip: o.precip, clear: o.weather === '晴', isDay: hr >= 6 && hr < 18, weather: o.weather, time: cur.fetchedAt, gov: false }
    }
  }

  const base = (cur?.options && cur.options.length ? cur.options : FALLBACK)
  // 其餘欄位（kind 特殊海況、birds / fish 調查、series 時間序列…）一律原樣帶過，不再逐欄列舉而漏掉新欄位
  const options = base.map((o) => orderOption({ ...o, params: OWN_PARAMS_KINDS.has(o.kind) && o.params ? o.params : optionParams(w, o.level) }))
  ensureGovOptions(options) // 舊檔還沒有揚塵／月亮選項時補上（放在既有選項之後）

  // 潮汐 series 每次刷新（失敗則保留舊的）
  let tideVia = ''
  const tideOpt = options.find((o) => o.kind === 'tide')
  if (tideOpt) {
    try {
      const r = await refreshTide(cur, Date.now())
      tideOpt.series = r.series
      tideVia = r.via
      const vs = r.series.points.map((p) => p.v)
      const vmin = Math.min(...vs), vmax = Math.max(...vs)
      const nowV = r.series.points[Math.min(23, Math.floor(taipeiHour(Date.now())))].v
      tideOpt.params.seaLevel = r2(0.45 + (vmax > vmin ? (nowV - vmin) / (vmax - vmin) : 0.5) * 0.55) // 與 store 潮汐映射一致
      console.log(`tide refreshed（${r.via}）${r.series.date} ${r.series.lunarLabel} ${r.series.range}潮 events=${r.series.events.length}`)
    } catch (e) { console.error('tide refresh failed, keep old series:', e.message) }
  }

  // 揚塵（每次刷新；失敗則保留舊的 dust 與 dust-yunlin 的 level / params）
  let dust = cur?.dust
  const dustOpt = options.find((o) => o.kind === 'dust')
  try {
    const r = await refreshDust(cur)
    dust = r.dust
    if (dustOpt) { dustOpt.level = r.level; dustOpt.params = r.params }
    const s = r.summary
    console.log(`dust refreshed ${s.t} pm10=${s.pm10} wind=${s.wind} temp=${s.temp} rh=${s.rh} invalid=${r.stats.invalidTotal}/${r.stats.sensors} history=${r.dust.history.length}`)
  } catch (e) { console.error('dust refresh failed, keep old data:', e.message) }

  // 月出月沒（每次刷新；失敗則保留舊的 moon）
  let moon = cur?.moon
  try {
    moon = await refreshMoon(Date.now())
    console.log(`moon refreshed ${moon.county} ${moon.from}..${moon.to} days=${moon.days.length}`)
  } catch (e) { console.error('moon refresh failed, keep old data:', e.message) }

  // 空氣品質（每次刷新；失敗則保留舊的 air 與 air-yunlin 的 level / params）。選項只在「有 air 資料」時才補上，抓不到就不憑空多出一個空選項
  let air = cur?.air
  let airFresh = null
  try {
    airFresh = await refreshAir(cur, Date.now(), w)
    air = airFresh.air
  } catch (e) { console.error('air refresh failed, keep old data:', e.message) }
  if (air) {
    const airOpt = ensureAirOption(options)
    // birds / fish：雲林 = 濁水溪流域，每次從揚塵選項複製（bake-static-data 的流域表不含空氣品質，重烘焙後這裡會跟上）
    syncAirOption(airOpt, options.find((o) => o.id === AIR_BASIN_OPTION_ID), airFresh ? { level: airFresh.level, params: airFresh.params } : {})
    if (airFresh) {
      const l = airFresh.last
      console.log(`air refreshed ${l.t} pm2.5=${l.pm25} pm10=${l.pm10} aqi=${l.aqi} fetched=${airFresh.fetched} history=${air.history.length}`)
    }
  }

  // 逐時風速 / 風向（模型）併進 history；失敗只保留舊值，不影響 PM 序列
  if (air) {
    const wr = await refreshAirWind(air.history)
    air = { ...air, history: wr.history }
    if (wr.error) console.error('air wind refresh failed, keep old wind values:', wr.error)
    else console.log(`air wind refreshed hours=${wr.fetched} matched=${wr.matched}/${air.history.length}`)
  }
  // 環境部測站觀測（需要 MOENV_KEY；沒有就略過）。obs 放在 air 的最後一個鍵
  if (air) {
    const { obs: _dropped, ...airRest } = air   // 舊 obs 的去留由 refreshAirObs 決定（從 cur.air.obs 讀）
    const ro = await refreshAirObs(cur, Date.now())
    air = ro.obs ? { ...airRest, obs: ro.obs } : airRest
    if (ro.status === 'fresh') {
      const s = ro.stats, l = s.last
      console.log(`air obs refreshed ${s.station} ${s.km} km pages=${s.pages} history=${ro.obs.history.length}${s.usedFallback ? '（只有目前值）' : ''} last=${l.t} pm2.5=${l.pm25}`)
    }
  }

  const parts = [w.gov ? '中央氣象署 CWA 觀測站' : 'Open-Meteo 即時氣象', '水利署水庫水情']
  if (tideVia || tideOpt?.series) parts.push('CWA 潮汐預報')
  if (cur?.rivers) parts.push('水利署河川水位')
  if (cur?.birdsNote) parts.push('水利署鳥類調查')
  if (dust) parts.push(SOURCE_LABEL.dust)
  if (cur?.stations) parts.push(SOURCE_LABEL.stations)
  if (options.some((o) => o.fish)) parts.push(SOURCE_LABEL.fish)
  if (moon) parts.push(SOURCE_LABEL.moon)
  const out = {
    // 空氣品質不是政府資料：揭露句放在「（政府資料 OGDL v1）」授權說明之後，不併進前面的政府資料來源清單
    source: parts.join(' + ') + (w.gov ? '（政府開放資料 OGDL v1）' : '（政府資料 OGDL v1；氣象備援 Open-Meteo CC BY 4.0）') + (air ? AIR_SOURCE_DISCLOSURE : '') + (air && air.obs ? OBS_SOURCE_DISCLOSURE : ''),
    sourceShort: w.gov ? 'CWA · 水利署' : '水利署 · CWA潮汐 · Open-Meteo',
    fetchedAt: w.time, station: w.gov ? '花蓮' : '花蓮外海',
    weather: { airTemp: w.airTemp, humidity: w.humidity, windSpeed: w.windSpeed, windDir: w.windDir, precip: w.precip, weather: w.weather },
    defaultOption: cur?.defaultOption || options[0].id, options,
    mapping: appendParts(withoutObsMapping(cur?.mapping, air && air.obs) || appendParts(BASE_MAPPING, MAPPING_ADDITIONS), air ? [AIR_MAPPING, ...(air.obs ? [OBS_MAPPING] : [])] : []),
  }
  if (cur?.rivers) { out.rivers = cur.rivers; out.riversNote = cur.riversNote }   // 河川水位（銀河濃度）
  if (cur?.birdsNote) out.birdsNote = air ? withBirdsNoteAppendix(cur.birdsNote, BIRDS_NOTE_APPENDIX) : cur.birdsNote   // 附錄的「對應」句補上空氣品質（冪等）
  if (dust) out.dust = dust
  if (moon) out.moon = moon
  if (air) out.air = air
  // 其餘既有的頂層鍵（stations 等烘焙資料）原樣保留，不因為這支腳本不認得就丟掉
  for (const [k, v] of Object.entries(cur || {})) if (!(k in out)) out[k] = v
  // TODO: 可加 WRA opendata 25768 即時水位刷新 rivers（公開、免金鑰；limit>=373 才涵蓋東南部站）
  await writeFile(url, stringifyOcean(orderTop(out), [...INLINE_PATHS, ...AIR_INLINE_PATHS]))   // air.history 逐時資料列收成單行（json.mjs 預設清單不含 air）
  console.log('refreshed', options.length, 'options @', w.time)
}

// 只在直接執行時跑（讓純函式可被測試匯入）。比對 realpath：經符號連結執行時 argv[1] 與 import.meta.url 路徑不同，
// 若只比字串會靜默什麼都不做。
const isMain = (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href } catch (e) { return false } })()
if (isMain) main()
