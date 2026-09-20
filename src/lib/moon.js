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

// ---- 以 CWA 月出月沒表（A-B0063-001）推「某天某時刻」的月亮位置 ----
// days：每列 [日期, 月出 HH:MM, 月出方位, 中天 HH:MM, 中天仰角, 'N'|'S', 月沒 HH:MM, 月沒方位]，
// 無月出/月沒/中天的日子欄位為空字串。一次「月出→月沒」常跨午夜，某天的「月沒」屬於前一天的那一輪，
// 所以要看 idx-1 / idx / idx+1 三天，把事件排成絕對時間軸（以 idx 那天 00:00 為 0）再配對。
const hm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? +m[1] + +m[2] / 60 : null }

// 回傳 { up, az, alt }：az 0=北 90=東 180=南 270=西；alt 為仰角（度）；up=false 表示在地平線下
export function moonAltAz(days, idx, hour) {
  const ev = []
  for (let k = -1; k <= 1; k++) {
    const d = days[idx + k]
    if (!d) continue
    const base = k * 24
    const r = hm(d[1]), tr = hm(d[3]), s = hm(d[6])
    if (r != null) ev.push({ t: base + r, type: 'rise', az: d[2] })
    if (tr != null) ev.push({ t: base + tr, type: 'transit', alt: d[4], dir: d[5] })
    if (s != null) ev.push({ t: base + s, type: 'set', az: d[7] })
  }
  ev.sort((a, b) => a.t - b.t)
  let rise = null
  for (const e of ev) if (e.type === 'rise' && e.t <= hour) rise = e            // 最近一次月出
  if (!rise) return { up: false, az: 90, alt: 0 }
  const set = ev.find((e) => e.type === 'set' && e.t > rise.t)                    // 這一輪的月沒
  if (!set || set.t <= hour) return { up: false, az: 270, alt: 0 }
  const tr = ev.find((e) => e.type === 'transit' && e.t > rise.t && e.t < set.t)
  const trT = tr ? tr.t : (rise.t + set.t) / 2                                    // 缺中天 → 取月出月沒中點
  const maxAlt = tr && typeof tr.alt === 'number' ? tr.alt : 60
  const trAz = tr && tr.dir === 'N' ? 0 : 180                                     // 中天在天頂北側 / 南側
  const rAz = typeof rise.az === 'number' ? rise.az : 90
  const sAz = typeof set.az === 'number' ? set.az : 270
  let az, alt
  if (hour <= trT) {                                                              // 上升段：東側 → 中天
    const g = trT > rise.t ? (hour - rise.t) / (trT - rise.t) : 1
    az = rAz + (trAz - rAz) * g
    alt = maxAlt * Math.sin(g * Math.PI / 2)
  } else {                                                                        // 下降段：中天 → 西側（北側中天以 360° 接續，避免 0→300 倒轉）
    const g = set.t > trT ? (hour - trT) / (set.t - trT) : 1
    const from = trAz === 0 ? 360 : trAz
    az = from + (sAz - from) * g
    alt = maxAlt * Math.cos(g * Math.PI / 2)
  }
  return { up: true, az, alt }
}

// 方位 / 仰角 → 畫面座標（面向南：東在左、西在右；仰角 0..90° → 高度 0.6..4.0）
export function moonScreenFromAltAz(az, alt, xr) {
  return { x: Math.sin(((az - 180) * Math.PI) / 180) * xr, y: 0.6 + (Math.max(0, Math.min(90, alt)) / 90) * 3.4 }
}

// "YYYY-MM-DD"（可含 T 時間）+ 小時 → Date（以本地時區）
export function dateAtHour(dateStr, hour) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return new Date()
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0)
  dt.setMinutes(Math.round(hour * 60))
  return dt
}
