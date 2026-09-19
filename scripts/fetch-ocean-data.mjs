// 取真實環境/氣象/水文資料 → 正規化成海洋參數 → public/data/ocean.json
// 優先 CWA 政府開放資料（需 CWA_KEY），無金鑰時退回 Open-Meteo（免金鑰、含海象）。
// 於 GitHub Actions 排程執行（見 .github/workflows/refresh-data.yml）。Node 18+ 內建 fetch。
import { writeFile } from 'node:fs/promises'

const LAT = 24.0, LON = 121.6 // 台灣東岸（花蓮外海）
const clamp01 = (v) => Math.max(0, Math.min(1, v))
const r2 = (v) => Math.round(v * 100) / 100

function toParams(m) {
  const tempN = clamp01((m.airTemp - 16) / 16)
  const current = clamp01(m.windSpeed / 14)
  const rad = (m.windDir * Math.PI) / 180
  const clarity = clamp01(0.5 + (m.clear ? 0.3 : 0) - m.precip * 0.15 - Math.max(0, (m.humidity - 80) / 100))
  return {
    seaLevel: r2(clamp01(0.30 + (m.reservoirPct / 100) * 0.5)),
    current: r2(current),
    flowX: r2(clamp01(0.5 + 0.4 * Math.sin(rad))),
    flowY: r2(clamp01(0.5 + 0.4 * Math.cos(rad))),
    clarity: r2(clarity),
    glow: r2(clamp01((m.isDay ? 0.7 : 0.5) + (m.clear ? 0.1 : 0))),
    jellyCount: r2(clamp01(0.35 + tempN * 0.45)),
    fishCount: r2(clamp01(0.35 + clarity * 0.5)),
    trashCount: r2(clamp01(0.08 + m.precip * 0.3 + (1 - clarity) * 0.25)),
    swimSpeed: r2(clamp01(0.4 + current * 0.4)),
    spin: 0.28,
    zoom: 0.5,
  }
}

async function fromOpenMeteo() {
  const wx = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation,cloud_cover,is_day&timezone=Asia%2FTaipei`).then((r) => r.json())
  let wave = null
  try { wave = await fetch(`https://marine-api.open-meteo.com/v1/marine?latitude=${LAT}&longitude=${LON}&current=wave_height,sea_surface_temperature&timezone=Asia%2FTaipei`).then((r) => r.json()) } catch (e) {}
  const c = wx.current
  const m = {
    airTemp: c.temperature_2m, humidity: c.relative_humidity_2m, windSpeed: c.wind_speed_10m / 3.6,
    windDir: c.wind_direction_10m, precip: c.precipitation, clear: c.cloud_cover < 40, isDay: !!c.is_day,
    reservoirPct: 70, weather: c.cloud_cover < 40 ? '晴' : c.cloud_cover < 80 ? '多雲' : '陰',
    waveHeightEst: wave?.current?.wave_height ?? r2(c.wind_speed_10m / 3.6 * 0.12),
  }
  if (wave?.current?.sea_surface_temperature) m.airTemp = wave.current.sea_surface_temperature
  return {
    source: 'Open-Meteo（海象 + 氣象，免金鑰即時資料）', sourceShort: 'Open-Meteo',
    fetchedAt: c.time, station: '花蓮外海', metrics: m, params: toParams(m),
    mapping: '風速→洋流 · 風向→方向 · 雲量→清澈 · 海溫→水母 · 降雨→垃圾',
  }
}

async function main() {
  let out
  try {
    out = await fromOpenMeteo() // TODO: 有 CWA_KEY 時可改抓 CWA opendata（政府源）
  } catch (e) {
    console.error('fetch failed:', e.message)
    process.exit(0) // 失敗不覆蓋既有檔案（保留上次資料）
  }
  await writeFile(new URL('../public/data/ocean.json', import.meta.url), JSON.stringify(out, null, 2) + '\n')
  console.log('wrote ocean.json:', out.sourceShort, out.fetchedAt, JSON.stringify(out.params))
}
main()
