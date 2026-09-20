// 「輸出顯示資料」：把目前海況背後的真實資料整理成一列列可讀文字（純函式，可在 Node 測試）。
// 資料看板（畫布上）與 OUT 監看（底部日誌）共用，讓使用者看得到「這個畫面是哪筆資料、映射成什麼」。
import { birdSeasonal, flockCount } from './birds.js'
import { ageFromLunar, moonAge, moonAltAz, moonPhaseName } from './moon.js'
import { t, T, getLocale } from '../i18n/index.js'
import { nameText, weatherText, lunarDayText, tideRangeText } from '../i18n/data.js'
import { seriesFromSurvey, seriesFromDust, gapRangeText, resolveAirSource, airMapping } from './series.js'
import { airCompare, airCompareParts, hourMs } from './airCompare.js'

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

// 空氣品質（Open-Meteo / CAMS 模型資料，不是政府觀測）：最新一筆「有 PM2.5」的小時；沒有 → null。history 依時間遞增，由後往前找
export function airSummary(air) {
  const hist = air && Array.isArray(air.history) ? air.history : []
  for (let i = hist.length - 1; i >= 0; i--) {
    const x = hist[i], pm25 = num(x && x.pm25)
    if (pm25 != null) return { county: air.county || '', place: air.place || '', t: x.t || '', pm25, pm10: num(x.pm10), dust: num(x.dust), aqi: num(x.aqi, 0), n: hist.length }
  }
  return null
}
// 「雲林縣麥寮」（英文 'Mailiao, Yunlin County'）
export function airWhereText(a) {
  const c = a && a.county ? nameText(a.county) : '', p = a && a.place ? nameText(a.place) : ''
  return getLocale() === 'en' ? [p, c].filter(Boolean).join(', ') : c + p
}
// 「PM2.5 21 · PM10 25 μg/m³ · US AQI 71」：數字 / 單位 / 指標名都不隨語系變。US AQI 是美國 EPA 指標（Open-Meteo 的 us_aqi），不是環境部 AQI。沒有 PM10 時單位跟在 PM2.5 後面
export function airPmText(a) {
  if (!a) return ''
  const parts = [a.pm10 != null ? `PM2.5 ${a.pm25} · PM10 ${a.pm10} μg/m³` : `PM2.5 ${a.pm25} μg/m³`]
  if (a.aqi != null) parts.push(`US AQI ${a.aqi}`)
  return parts.join(' · ')
}

// 環境部測站觀測（air.obs，政府觀測資料）：最新一筆「有 PM2.5」的小時；沒有 obs / 沒有有效 PM2.5 → null。history 依時間遞增，由後往前找
export function airObsSummary(air) {
  const obs = air && air.obs && typeof air.obs === 'object' ? air.obs : null
  const hist = obs && Array.isArray(obs.history) ? obs.history : []
  const st = obs && obs.station && typeof obs.station === 'object' ? obs.station : {}
  for (let i = hist.length - 1; i >= 0; i--) {
    const x = hist[i], pm25 = num(x && x.pm25)
    if (pm25 != null && hourMs(x && x.t) !== null) return { station: typeof st.name === 'string' ? st.name : '', county: typeof st.county === 'string' ? st.county : '', t: x.t || '', pm25, pm10: num(x.pm10), aqi: num(x.aqi, 0), wind: num(x.wind), n: hist.length }
  }
  return null
}
// 「環境部麥寮站」（英文 'MOENV Mailiao station'）；沒有站名 → 「環境部測站」
export function airObsWhereText(station) {
  const name = station ? nameText(station) : ''
  return name ? t('環境部{station}站', { station: name }) : t('環境部空品測站')
}
// 「PM2.5 25 · PM10 40 μg/m³ · AQI 62」：環境部的 AQI（不是 US AQI）
export function airObsPmText(a) {
  if (!a) return ''
  const parts = [airPmText({ pm25: a.pm25, pm10: a.pm10, aqi: null })]
  if (a.aqi != null) parts.push(`AQI ${a.aqi}`)
  return parts.join(' · ')
}
// 「模型 vs 觀測」的一句話結論（airCompare 的結果 → 文字）。誠實：高估 / 低估 / 「大致吻合」（|平均差| < 1 μg/m³ 且逐時誤差不大）/ 平均差小但逐時落差明顯。
//   short = true：不含「與環境部○○站觀測相比」的開頭（資料看板一列放不下）。沒有比較 → ''
export function airCompareText(cmp, { short = false } = {}) {
  const p = airCompareParts(cmp)
  if (!p) return ''
  const P = { where: airObsWhereText(p.station), bias: p.verdict === 'over' || p.verdict === 'under' ? p.absBias : p.bias, mae: p.mae, n: p.n }
  const K = {
    over: [T('與{where}觀測相比，模型平均高估 {bias} μg/m³（平均絕對誤差 {mae}，共 {n} 小時）'), T('模型平均高估 {bias} μg/m³（平均絕對誤差 {mae}，共 {n} 小時）')],
    under: [T('與{where}觀測相比，模型平均低估 {bias} μg/m³（平均絕對誤差 {mae}，共 {n} 小時）'), T('模型平均低估 {bias} μg/m³（平均絕對誤差 {mae}，共 {n} 小時）')],
    match: [T('與{where}觀測相比，模型與觀測大致吻合（平均差 {bias} μg/m³，平均絕對誤差 {mae}，共 {n} 小時）'), T('模型與觀測大致吻合（平均差 {bias} μg/m³，平均絕對誤差 {mae}，共 {n} 小時）')],
    mixed: [T('與{where}觀測相比，模型平均差僅 {bias} μg/m³，但逐小時落差明顯（平均絕對誤差 {mae}，共 {n} 小時）'), T('模型平均差僅 {bias} μg/m³，但逐小時落差明顯（平均絕對誤差 {mae}，共 {n} 小時）')],
  }
  return t(K[p.verdict][short ? 1 : 0], P)
}
// 揚塵：水利署風速凍結 / 無效、改用 air.history 的逐時模型風速時的說明資料 { reason, v, t }；不是這種情況 → null
export function dustModelWind(gov) {
  const spec = gov && gov.dust ? seriesFromDust(gov.dust, undefined, gov.air) : null
  if (!spec || !spec.extra || spec.extra.metric !== 'wind-model') return null
  const last = spec.points[spec.points.length - 1]
  return { reason: spec.extra.reason, v: last.v, t: last.t }
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

// 目前海況的資料列。ctx：{ month, params, now(Date), airDrive（'model' | 'obs'：空氣品質正在播放的序列用的來源；沒給 → 看 gov.airDrive，再沒有 → auto） }。回傳 [{ k: 標籤, v: 文字 }]
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
      const mw = dustModelWind(gov)   // 水利署風速凍結 / 無效 → 歷史播放改用逐時模型風速：誠實標示這是模型資料
      if (mw) rows.push({ k: t('風速'), v: t(mw.reason === 'frozen' ? T('風速為模型資料（Open-Meteo），水利署感測器凍結 · 最新 {v} m/s（{at}）') : T('風速為模型資料（Open-Meteo），水利署感測器無有效風速 · 最新 {v} m/s（{at}）'), { v: mw.v, at: String(mw.t) }) })
    } else rows.push({ k: t('揚塵'), v: t('尚無資料') })
  } else if (opt.kind === 'air') {
    const a = airSummary(gov.air)
    rows.push(a
      ? { k: t('空氣品質'), v: `${airWhereText(a)} · ${airPmText(a)}${a.t ? ' · ' + String(a.t).slice(5, 16).replace('T', ' ') : ''}` }
      : { k: t('空氣品質'), v: t('尚無資料') })
    rows.push({ k: t('來源'), v: t('Open-Meteo（CAMS 全球大氣模型）· 模型資料，非政府觀測值') })
    // 有環境部測站觀測（air.obs）：驅動海況的是觀測時，映射用觀測的最新 PM2.5 算（與資料卡播放同一組係數）；並列一列觀測、一列落差、一列「驅動海況」的資料來源標示
    const obsA = airObsSummary(gov.air)
    const drive = obsA ? resolveAirSource(gov.air, ctx.airDrive || gov.airDrive || 'auto') : 'model'   // ctx.airDrive：正在播放的序列實際用的來源（資料看板傳入；導覽播模型序列時，看板不能說「驅動 = 觀測」）
    const mp = drive === 'obs' ? (() => { const m = airMapping(obsA.pm25); return { clarity: m.clarity, trashCount: m.trashCount, glow: m.glow } })() : p
    if (a) rows.push({ k: t('映射'), v: t('PM2.5 ↑ → 海水清澈 {clarity} · 垃圾 {trash} · 輝光 {glow}', { clarity: f2(mp.clarity), trash: f2(mp.trashCount), glow: f2(mp.glow) }) })
    if (obsA) {
      rows.push({ k: t('觀測'), v: `${airObsWhereText(obsA.station)} · ${airObsPmText(obsA)}${obsA.t ? ' · ' + String(obsA.t).slice(5, 16).replace('T', ' ') : ''}` })
      const cmp = airCompare(gov.air)
      if (cmp) rows.push({ k: t('落差'), v: airCompareText(cmp, { short: true }) })
      rows.push({ k: t('驅動'), v: drive === 'obs' ? t('環境部觀測 · 政府資料開放授權條款－第1版') : t('模型資料，非政府觀測') })
    }
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
  if (w) {
    const W = { weather: weatherText(w.weather), temp: w.airTemp, rh: w.humidity, wind: w.windSpeed, current: f2(p.current) }
    // 「→ 洋流」只在洋流真的由這一列的風速（花蓮外海）算出來的選項才印（水庫 / 潮汐 / 空氣品質）：
    // 揚塵的洋流來自雲林測站風速（映射列已經寫了）、月亮的洋流是寫死的預設值——印上去會出現兩個不同的風速對到同一個洋流值，互相矛盾。
    const noCurrent = opt.kind === 'dust' || opt.kind === 'moon'
    rows.push({ k: t('氣象'), v: noCurrent ? t('{weather} · {temp}°C · 濕度 {rh}% · 風 {wind} m/s', W) : t('{weather} · {temp}°C · 濕度 {rh}% · 風 {wind} m/s → 洋流 {current}', W) })
  }
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
