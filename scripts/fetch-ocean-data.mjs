// 刷新 public/data/ocean.json：保留水庫選項（政府開放資料快照），以 Open-Meteo 即時海象/氣象
// 重算每個水庫選項的海洋參數。於 GitHub Actions 排程執行（refresh-data.yml）。Node 18+ 內建 fetch。
import { readFile, writeFile } from 'node:fs/promises'

const LAT = 24.0, LON = 121.6
const clamp01 = (v) => Math.max(0, Math.min(1, v))
const r2 = (v) => Math.round(v * 100) / 100

function optionParams(w, level) {
  const tempN = clamp01((w.airTemp - 16) / 16)
  const current = clamp01(w.windSpeed / 14)
  const rad = (w.windDir * Math.PI) / 180
  const clarity = clamp01(0.5 + (w.clear ? 0.3 : 0) - w.precip * 0.15 - Math.max(0, (w.humidity - 80) / 100))
  return {
    seaLevel: r2(clamp01(0.30 + (level / 100) * 0.5)),
    current: r2(current),
    flowX: r2(clamp01(0.5 + 0.4 * Math.sin(rad))),
    flowY: r2(clamp01(0.5 + 0.4 * Math.cos(rad))),
    clarity: r2(clarity),
    glow: r2(clamp01((w.isDay ? 0.7 : 0.5) + (w.clear ? 0.1 : 0))),
    jellyCount: r2(clamp01(0.35 + tempN * 0.45)),
    fishCount: r2(clamp01(0.4 + (level / 100) * 0.35)),
    trashCount: r2(clamp01(0.08 + w.precip * 0.3 + (1 - clarity) * 0.25)),
    swimSpeed: r2(clamp01(0.4 + current * 0.4)),
    spin: 0.28, zoom: 0.5,
  }
}

const FALLBACK = [
  { id: 'feitsui', name: '翡翠水庫', region: '北', level: 77.3 },
  { id: 'shimen', name: '石門水庫', region: '北', level: 100 },
  { id: 'zengwen', name: '曾文水庫', region: '南', level: 100 },
]

async function main() {
  const url = new URL('../public/data/ocean.json', import.meta.url)
  let cur = null
  try { cur = JSON.parse(await readFile(url, 'utf8')) } catch (e) {}

  let w
  try {
    const wx = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation,cloud_cover,is_day&timezone=Asia%2FTaipei`).then((r) => r.json())
    const c = wx.current
    w = { airTemp: c.temperature_2m, humidity: c.relative_humidity_2m, windSpeed: r2(c.wind_speed_10m / 3.6), windDir: c.wind_direction_10m, precip: c.precipitation, clear: c.cloud_cover < 40, isDay: !!c.is_day, weather: c.cloud_cover < 40 ? '晴' : c.cloud_cover < 80 ? '多雲' : '陰', time: c.time }
    try { const wave = await fetch(`https://marine-api.open-meteo.com/v1/marine?latitude=${LAT}&longitude=${LON}&current=sea_surface_temperature&timezone=Asia%2FTaipei`).then((r) => r.json()); if (wave?.current?.sea_surface_temperature) w.airTemp = wave.current.sea_surface_temperature } catch (e) {}
  } catch (e) {
    console.error('weather fetch failed:', e.message)
    process.exit(0) // 不覆蓋既有檔案
  }

  const base = (cur?.options && cur.options.length ? cur.options : FALLBACK)
  const options = base.map((o) => ({ id: o.id, name: o.name, region: o.region, level: o.level, params: optionParams(w, o.level) }))
  const out = {
    source: '水利署水庫快照 + Open-Meteo 即時海象/氣象', sourceShort: '水利署 · Open-Meteo',
    fetchedAt: w.time, station: '花蓮外海',
    weather: { airTemp: w.airTemp, humidity: w.humidity, windSpeed: w.windSpeed, windDir: w.windDir, precip: w.precip, weather: w.weather },
    defaultOption: cur?.defaultOption || options[0].id, options,
    mapping: cur?.mapping || '水庫水位→海水高度 · 風速→洋流 · 晴雨→清澈 · 氣溫→水母',
  }
  await writeFile(url, JSON.stringify(out, null, 2) + '\n')
  console.log('refreshed', options.length, 'options @', w.time)
}
main()
