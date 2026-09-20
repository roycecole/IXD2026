// 「輸出顯示資料」：把目前海況背後的真實資料整理成一列列可讀文字（純函式，可在 Node 測試）。
// 資料看板（畫布上）與 OUT 監看（底部日誌）共用，讓使用者看得到「這個畫面是哪筆資料、映射成什麼」。
import { birdSeasonal, flockCount } from './birds.js'
import { ageFromLunar, moonAge, moonAltAz, moonPhaseName } from './moon.js'
import { t, getLocale } from '../i18n/index.js'
import { nameText, weatherText, lunarDayText, tideRangeText } from '../i18n/data.js'
import { seriesFromSurvey, gapRangeText } from './series.js'

const num = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null)
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const f2 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '—')
const avg = (arr) => { const a = arr.filter((v) => typeof v === 'number' && Number.isFinite(v)); return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null }

// 揚塵各站有效值平均
export function dustSummary(dust) {
  if (!dust || !Array.isArray(dust.stations) || !dust.stations.length) return null
  const st = dust.stations
  return { county: dust.county || '', n: st.length, pm10: avg(st.map((s) => s.pm10)), wind: avg(st.map((s) => s.wind)), temp: avg(st.map((s) => s.temp)), rh: avg(st.map((s) => s.rh)), t: st.map((s) => s.t).filter(Boolean).sort().pop() || '' }
}

const fmtSpan = (d) => (d && d.yearly && d.yearly.length ? `${d.yearly[0].y}–${d.yearly[d.yearly.length - 1].y}` : '')
// 調查年表中間的空窗年（沒有調查的年份區間，與年表時間軸 / 導覽字幕同一份：series.js 的 extra.gaps）：'2007–2013' / '2007–2013、2016'；沒有空窗 → ''
function surveyGapText(opt, kind) {
  let gaps = []
  try { const spec = seriesFromSurvey(opt, kind); gaps = (spec && spec.extra && spec.extra.gaps) || [] } catch (e) { gaps = [] }
  return gaps.map(gapRangeText).join(getLocale() === 'en' ? ', ' : '、')
}

// 鳥 / 魚調查「某月」的一段文字（資料看板與套用日誌共用）：'淡水河流域 9 月 79 種（內插）'
// month0：0..11；season：birdSeasonal() 的回傳（可為 null）
export function surveyMonthText(basin, month0, season) {
  const P = { basin: nameText(basin), m: month0 + 1, v: season ? season.value : '' }
  if (!season) return t('{basin} {m} 月', P)
  return season.interpolated ? t('{basin} {m} 月 {v} 種（內插）', P) : t('{basin} {m} 月 {v} 種', P)
}

// 目前海況的資料列。ctx：{ month, params, now(Date) }。回傳 [{ k: 標籤, v: 文字 }]
export function describeBoard(gov, opt, ctx = {}) {
  if (!gov || !opt) return []
  const rows = []
  const p = opt.params || {}
  const now = ctx.now || new Date()
  if (opt.kind === 'tide' && opt.series) {
    const s = opt.series
    rows.push({ k: t('潮汐'), v: t('{name} {date} · 農曆 {lunar}', { name: nameText(opt.name), date: s.date, lunar: lunarDayText(s.lunarLabel) }) + (s.range ? ' · ' + tideRangeText(s.range) : '') })
    const hr = now.getHours()
    const pt = s.points && s.points[Math.min(s.points.length - 1, hr)]
    if (pt) {                                        // 與播放時同一個映射：最低潮 → 0.45、最高潮 → 1.00（滿潮溢流）
      const vs = s.points.map((q) => q.v), lo = Math.min(...vs), hi = Math.max(...vs)
      const sea = 0.45 + (hi > lo ? (pt.v - lo) / (hi - lo) : 0.5) * 0.55
      const P = { hr, v: pt.v, unit: s.unit, sea: f2(sea) }
      rows.push({ k: t('潮位'), v: sea > 0.97 ? t('{hr}:00 {v}{unit} → 海水高度 {sea}（滿潮溢流）', P) : t('{hr}:00 {v}{unit} → 海水高度 {sea}', P) })
    }
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const fromLunar = s.date === todayStr ? ageFromLunar(s.lunar, hr + now.getMinutes() / 60) : null
    const age = fromLunar != null ? fromLunar : moonAge(now)
    rows.push({ k: t('月亮'), v: t('{phase} · 月齡 {age} 天', { phase: moonPhaseName(age), age: age.toFixed(1) }) })
  } else if (opt.kind === 'dust') {
    const d = dustSummary(gov.dust)
    if (d) {
      let v = t('{county} {n} 站 · PM10 {pm}', { county: nameText(d.county), n: d.n, pm: d.pm10 != null ? num(d.pm10) + ' μg/m³' : t('無效') })
      if (d.wind != null) v += ' · ' + t('風 {v} m/s', { v: num(d.wind) })
      if (d.rh != null) v += ' · ' + t('濕度 {v}%', { v: num(d.rh, 0) })
      if (d.temp != null) v += ' · ' + num(d.temp) + '°C'
      rows.push({ k: t('揚塵'), v })
      const P = { clarity: f2(p.clarity), trash: f2(p.trashCount), current: f2(p.current) }
      rows.push({ k: t('映射'), v: d.pm10 != null
        ? t('PM10 ↑ → 海水清澈 {clarity} · 垃圾 {trash} · 洋流 {current}', P)
        : t('PM10 感測器回報無效值 → 以預設 40 μg/m³ 示意（清澈 {clarity} · 垃圾 {trash}）· 風速 → 洋流 {current}', P) })
    } else rows.push({ k: t('揚塵'), v: t('尚無資料') })
  } else if (opt.kind === 'moon') {
    const m = gov.moon
    if (m && Array.isArray(m.days) && m.days.length) {
      const idx = m.days.findIndex((d) => d[0] === ymd(now))
      if (idx >= 0) {
        const d = m.days[idx]
        const P = { county: nameText(m.county), rise: d[1] || '—', transit: d[3] || '—', alt: d[4], dir: d[5] || '', set: d[6] || '—' }
        rows.push({ k: t('月亮'), v: d[4] != null ? t('{county} 今日 · 月出 {rise} · 中天 {transit}（仰角 {alt}°{dir}） · 月沒 {set}', P) : t('{county} 今日 · 月出 {rise} · 中天 {transit} · 月沒 {set}', P) })
        const r = moonAltAz(m.days, idx, now.getHours() + now.getMinutes() / 60)
        rows.push({ k: t('位置'), v: r.up ? t('現在 方位 {az}° · 仰角 {alt}°（依月出 / 中天 / 月沒時刻內插）', { az: Math.round(r.az % 360), alt: Math.round(r.alt) }) : t('現在在地平線下') })
      } else rows.push({ k: t('月亮'), v: t('{county} 月出月沒表 {from} → {to} 不含今日，改用天文公式', { county: nameText(m.county), from: m.from, to: m.to }) })
      const age = moonAge(now)
      rows.push({ k: t('月相'), v: t('{phase} · 月齡 {age} 天 · 資料 {from} → {to}（{n} 天）', { phase: moonPhaseName(age), age: age.toFixed(1), from: m.from, to: m.to, n: m.days.length }) })
    } else rows.push({ k: t('月亮'), v: t('尚無資料') })
  } else {
    const P = { name: nameText(opt.name), level: opt.level, sea: f2(p.seaLevel) }
    rows.push({ k: t('水庫'), v: (p.seaLevel ?? 0) > 0.97 ? t('{name} 水位 {level}% → 海水高度 {sea}（滿庫溢流）', P) : t('{name} 水位 {level}% → 海水高度 {sea}', P) })
  }
  const w = gov.weather
  if (w) rows.push({ k: t('氣象'), v: t('{weather} · {temp}°C · 濕度 {rh}% · 風 {wind} m/s → 洋流 {current}', { weather: weatherText(w.weather), temp: w.airTemp, rh: w.humidity, wind: w.windSpeed, current: f2(p.current) }) })
  for (const kind of ['birds', 'fish']) {
    const d = opt[kind]
    if (!d) continue
    const mo = ctx.month != null ? ctx.month : now.getMonth()
    const s = birdSeasonal(d.monthly, mo)
    let v = surveyMonthText(d.basin, mo, s)
    if (kind === 'birds' && s) v += ' → ' + t('{n} 群', { n: flockCount(d.species, s.rel) })
    if (fmtSpan(d)) {
      const gaps = surveyGapText(opt, kind)   // 「調查 2004–2015」只寫首尾年，看不出中間有空窗（曾文溪的魚：2004–2006、2014–2015）→ 有空窗就補上
      v += ' · ' + (gaps ? t('調查 {span}（空窗 {gaps}）', { span: fmtSpan(d), gaps }) : t('調查 {span}', { span: fmtSpan(d) }))
    }
    rows.push({ k: kind === 'birds' ? t('鳥群') : t('魚群'), v })
  }
  if (gov.rivers && gov.rivers.length) {
    const pct = avg(gov.rivers.map((r) => r.pct))
    rows.push({ k: t('河川'), v: t('{n} 站即時水位', { n: gov.rivers.length }) + (pct != null ? ' · ' + t('平均警戒比 {v}', { v: num(pct, 2) }) : '') + ' → ' + t('銀河濃度') })
  }
  if (gov.stations && gov.stations.total) rows.push({ k: t('測站'), v: t('河川流量站 {total} 站（現存 {active}）→ 星座', { total: gov.stations.total, active: gov.stations.active }) })
  return rows
}

// 套用海況時寫進 OUT 監看的資料行
export function describeForLog(gov, opt, ctx = {}) {
  return describeBoard(gov, opt, ctx).map((r) => t('資料 {k}｜{v}', { k: r.k, v: r.v }))
}
