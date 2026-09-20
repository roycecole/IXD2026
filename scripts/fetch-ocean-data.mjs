// 刷新 public/data/ocean.json：保留水庫選項與時間序列（政府開放資料快照），
// 以即時氣象重算每個水庫選項的海洋參數，並刷新「花蓮外海」的 24h 潮汐 series。
// 於 GitHub Actions 排程執行（refresh-data.yml）。Node 18+ 內建 fetch。
//   氣象：有 CWA_KEY（repo secret）→ 中央氣象署 opendata 觀測站；否則 / 失敗 → Open-Meteo。
//   潮汐：有 CWA_KEY → datastore API；否則 / 失敗 → CWA 公開檔（免金鑰）；再失敗 → 保留舊 series。
import { readFile, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  TIDE_FILE_URL, tideApiUrl, findTideForecasts, pickLocation, flattenEvents,
  buildTideSeries, dayMeta, lunarLabel, taipeiDate, taipeiHour,
} from './tide.mjs'

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

async function getJson(url, ms = 90000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.replace(/Authorization=[^&]+/, 'Authorization=***')}`)
  return res.json()
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

const FALLBACK = [
  { id: 'feitsui', name: '翡翠水庫', region: '北', level: 77.3 },
  { id: 'shimen', name: '石門水庫', region: '北', level: 100 },
  { id: 'zengwen', name: '曾文水庫', region: '南', level: 100 },
]

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
  const options = base.map((o) => {
    const next = { id: o.id, name: o.name, region: o.region, level: o.level, params: optionParams(w, o.level) }
    if (o.kind) next.kind = o.kind     // 潮汐等特殊海況
    if (o.birds) next.birds = o.birds  // 鳥類調查（球外鳥群）
    if (o.series) next.series = o.series // 保留時間序列（資料播放用）
    return next
  })

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

  const parts = [w.gov ? '中央氣象署 CWA 觀測站' : 'Open-Meteo 即時氣象', '水利署水庫水情']
  if (tideVia || tideOpt?.series) parts.push('CWA 潮汐預報')
  if (cur?.rivers) parts.push('水利署河川水位')
  if (cur?.birdsNote) parts.push('水利署鳥類調查')
  const out = {
    source: parts.join(' + ') + (w.gov ? '（政府開放資料 OGDL v1）' : '（政府資料 OGDL v1；氣象備援 Open-Meteo CC BY 4.0）'),
    sourceShort: w.gov ? 'CWA · 水利署' : '水利署 · CWA潮汐 · Open-Meteo',
    fetchedAt: w.time, station: w.gov ? '花蓮' : '花蓮外海',
    weather: { airTemp: w.airTemp, humidity: w.humidity, windSpeed: w.windSpeed, windDir: w.windDir, precip: w.precip, weather: w.weather },
    defaultOption: cur?.defaultOption || options[0].id, options,
    mapping: cur?.mapping || '水庫水位%→海水高度（滿庫=滿球、溢流）· 風速→洋流 · 晴雨→清澈 · 氣溫→水母 · 進流量時序→資料播放',
  }
  if (cur?.rivers) { out.rivers = cur.rivers; out.riversNote = cur.riversNote }   // 河川水位（銀河濃度）
  if (cur?.birdsNote) out.birdsNote = cur.birdsNote
  // TODO: 可加 WRA opendata 25768 即時水位刷新 rivers（公開、免金鑰；limit>=373 才涵蓋東南部站）
  await writeFile(url, JSON.stringify(out, null, 2) + '\n')
  console.log('refreshed', options.length, 'options @', w.time)
}

// 只在直接執行時跑（讓純函式可被測試匯入）。比對 realpath：經符號連結執行時 argv[1] 與 import.meta.url 路徑不同，
// 若只比字串會靜默什麼都不做。
const isMain = (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href } catch (e) { return false } })()
if (isMain) main()
