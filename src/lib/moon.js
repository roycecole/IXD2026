// 月相 / 月位（純函式）：以朔望月週期估算，誤差約 ±0.5 天，視覺用途足夠。
// 潮汐本來就是月亮的引力 —— 潮汐海況時背景的月亮盈虧與位置都對應「當日月齡 + 當下時刻」。
export const SYNODIC = 29.530588853
const EPOCH_MS = Date.UTC(2000, 0, 6, 18, 14) // 2000-01-06 18:14 UTC 新月

export function moonAge(date) {
  const d = (date.getTime() - EPOCH_MS) / 86400000
  return ((d % SYNODIC) + SYNODIC) % SYNODIC
}
export const moonPhaseAngle = (age) => (age / SYNODIC) * Math.PI * 2        // 0 新月 → π 滿月 → 2π
export const moonIllum = (age) => (1 - Math.cos(moonPhaseAngle(age))) / 2  // 受光比例 0..1

const NAMES = ['新月', '眉月', '上弦月', '盈凸月', '滿月', '虧凸月', '下弦月', '殘月']
export const moonPhaseName = (age) => NAMES[Math.floor((age / SYNODIC) * 8 + 0.5) % 8]

// 月亮在天空的位置：月中天時刻 ≈ 12h + 24h·(月齡/朔望月)（新月正午、上弦傍晚、滿月午夜、下弦清晨）
// 時角 H ∈ (−π, π]：0=中天、−π/2=東方升起（畫面左）、+π/2=西方落下（畫面右）；up=cos(H)>0 在地平線上
export function moonSky(age, hour) {
  const transit = (12 + 24 * (age / SYNODIC)) % 24
  const H = ((hour - transit) / 24) * Math.PI * 2
  const w = Math.atan2(Math.sin(H), Math.cos(H))
  return { H: w, up: Math.cos(w) }
}

// 由 CWA 農曆日期（"2026-08-10" = 農曆八月初十）推月齡：初一 00:00 時月齡約 −0.5（新月落在初一當天的平均位置），
// 故 age ≈ 日 − 1.5 + 時/24。比平均朔望月公式更貼真實月相（後者有 ±0.7 天漂移），也讓月亮直接對應氣象署資料。
export function ageFromLunar(lunarStr, hour = 0) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(lunarStr || '')
  if (!m) return null
  const day = parseInt(m[3], 10)
  if (!(day >= 1 && day <= 30)) return null
  return Math.max(0, Math.min(SYNODIC - 0.01, day - 1.5 + hour / 24))
}

// "YYYY-MM-DD"（可含 T 時間）+ 小時 → Date（以本地時區）
export function dateAtHour(dateStr, hour) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return new Date()
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0)
  dt.setMinutes(Math.round(hour * 60))
  return dt
}
