// 「輸出顯示資料」：把目前海況背後的真實資料整理成一列列可讀文字（純函式，可在 Node 測試）。
// 資料看板（畫布上）與 OUT 監看（底部日誌）共用，讓使用者看得到「這個畫面是哪筆資料、映射成什麼」。
import { birdSeasonal, flockCount } from './birds.js'
import { ageFromLunar, moonAge, moonPhaseName } from './moon.js'

const num = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null)
const f2 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '—')
const avg = (arr) => { const a = arr.filter((v) => typeof v === 'number' && Number.isFinite(v)); return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null }

// 揚塵各站有效值平均
export function dustSummary(dust) {
  if (!dust || !Array.isArray(dust.stations) || !dust.stations.length) return null
  const st = dust.stations
  return { county: dust.county || '', n: st.length, pm10: avg(st.map((s) => s.pm10)), wind: avg(st.map((s) => s.wind)), temp: avg(st.map((s) => s.temp)), rh: avg(st.map((s) => s.rh)), t: st.map((s) => s.t).filter(Boolean).sort().pop() || '' }
}

const fmtSpan = (d) => (d && d.yearly && d.yearly.length ? `${d.yearly[0].y}–${d.yearly[d.yearly.length - 1].y}` : '')

// 目前海況的資料列。ctx：{ month, params, now(Date) }。回傳 [{ k: 標籤, v: 文字 }]
export function describeBoard(gov, opt, ctx = {}) {
  if (!gov || !opt) return []
  const rows = []
  const p = opt.params || {}
  const now = ctx.now || new Date()
  if (opt.kind === 'tide' && opt.series) {
    const s = opt.series
    rows.push({ k: '潮汐', v: `${opt.name} ${s.date} · 農曆 ${s.lunarLabel ? s.lunarLabel.replace('農曆', '') : '—'}${s.range ? ' · ' + s.range + '潮' : ''}` })
    const hr = now.getHours()
    const pt = s.points && s.points[Math.min(s.points.length - 1, hr)]
    if (pt) {                                        // 與播放時同一個映射：最低潮 → 0.45、最高潮 → 1.00（滿潮溢流）
      const vs = s.points.map((q) => q.v), lo = Math.min(...vs), hi = Math.max(...vs)
      const sea = 0.45 + (hi > lo ? (pt.v - lo) / (hi - lo) : 0.5) * 0.55
      rows.push({ k: '潮位', v: `${hr}:00 ${pt.v}${s.unit} → 海水高度 ${f2(sea)}${sea > 0.97 ? '（滿潮溢流）' : ''}` })
    }
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const fromLunar = s.date === todayStr ? ageFromLunar(s.lunar, hr + now.getMinutes() / 60) : null
    const age = fromLunar != null ? fromLunar : moonAge(now)
    rows.push({ k: '月亮', v: `${moonPhaseName(age)} · 月齡 ${age.toFixed(1)} 天` })
  } else if (opt.kind === 'dust') {
    const d = dustSummary(gov.dust)
    if (d) {
      rows.push({ k: '揚塵', v: `${d.county} ${d.n} 站 · PM10 ${d.pm10 != null ? num(d.pm10) + ' μg/m³' : '—'}${d.wind != null ? ' · 風 ' + num(d.wind) + ' m/s' : ''}${d.temp != null ? ' · ' + num(d.temp) + '°C' : ''}` })
      rows.push({ k: '映射', v: `PM10 ↑ → 海水清澈 ${f2(p.clarity)} · 垃圾 ${f2(p.trashCount)} · 洋流 ${f2(p.current)}` })
    } else rows.push({ k: '揚塵', v: '尚無資料' })
  } else if (opt.kind === 'moon') {
    const m = gov.moon
    rows.push({ k: '月亮', v: m ? `${m.county} ${m.from} → ${m.to}（${(m.days || []).length} 天月出月沒）` : '尚無資料' })
  } else {
    rows.push({ k: '水庫', v: `${opt.name} 水位 ${opt.level}% → 海水高度 ${f2(p.seaLevel)}${(p.seaLevel ?? 0) > 0.97 ? '（滿庫溢流）' : ''}` })
  }
  const w = gov.weather
  if (w) rows.push({ k: '氣象', v: `${w.weather} · ${w.airTemp}°C · 濕度 ${w.humidity}% · 風 ${w.windSpeed} m/s → 洋流 ${f2(p.current)}` })
  for (const kind of ['birds', 'fish']) {
    const d = opt[kind]
    if (!d) continue
    const mo = ctx.month != null ? ctx.month : now.getMonth()
    const s = birdSeasonal(d.monthly, mo)
    const nm = kind === 'birds' ? '鳥群' : '魚群'
    const extra = kind === 'birds' && s ? ` → ${flockCount(d.species, s.rel)} 群` : ''
    rows.push({ k: nm, v: `${d.basin} ${mo + 1} 月${s ? ' ' + s.value + ' 種' + (s.interpolated ? '（內插）' : '') : ''}${extra}${fmtSpan(d) ? ' · 調查 ' + fmtSpan(d) : ''}` })
  }
  if (gov.rivers && gov.rivers.length) {
    const pct = avg(gov.rivers.map((r) => r.pct))
    rows.push({ k: '河川', v: `${gov.rivers.length} 站即時水位${pct != null ? ' · 平均警戒比 ' + num(pct, 2) : ''} → 銀河濃度` })
  }
  if (gov.stations && gov.stations.total) rows.push({ k: '測站', v: `河川流量站 ${gov.stations.total} 站（現存 ${gov.stations.active}）→ 星座` })
  return rows
}

// 套用海況時寫進 OUT 監看的資料行
export function describeForLog(gov, opt, ctx = {}) {
  return describeBoard(gov, opt, ctx).map((r) => `資料 ${r.k}｜${r.v}`)
}
