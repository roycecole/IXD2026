// 資料 → 可播放的時間序列規格（純函式，無 I/O，可在 Node 測試）。
// 規格 spec = { kind, name, label, unit, date, step, points[], target, extra, stats:{min,max,mean} }
//   kind：'tide' 潮汐 · 'inflow' 進流量 · 'dust' 揚塵（CI 累積的歷史）· 'air' 空氣品質（Open-Meteo / CAMS 模型資料）· 'survey-birds' / 'survey-fish' 調查年表 · 'moon' 月出月沒
//   points：tide/inflow → {h,v}；dust → {t,v,pm,w,tp,rh}（v＝主變數：PM10、風速，或模型風速）；air → {t,v,pm10,dust,aqi}（v＝PM2.5；來源是環境部觀測時另有 wind）；survey → {t,v,n,gap}（逐年稠密：gap=true 是「無調查」年，v 為前後調查年的線性內插）；moon → {t,v,rise,riseAz,transit,alt,altDir,set,setAz}
// 每一步由 automationFor() 轉成參數自動化事件，走既有的錄製/播放引擎（可倍速、循環、soft-takeover 接管）。
import { flockCount } from './birds.js'
import { t, T, getLocale } from '../i18n/index.js'
import { nameText, lunarLabelText, tideRangeText } from '../i18n/data.js'
import { hourMs, airObsUsable } from './airCompare.js'

// 規格裡的 name / label / unit 一律存「中文原文」（用 T() 標記；資料本身的名稱也是中文），顯示時才翻：
//   formatHud 內用 nameText()；UI 想顯示 spec.label / spec.name，請用 t(label) / nameText(name)。
// 唯一例外：survey 的 date（「2005–2017 調查年表」）是建立當下的語系文字，只在建立當下寫進日誌。
const HIGH_TIDE = T('滿潮'), LOW_TIDE = T('乾潮')   // 與 CWA 事件名（資料值）比對用

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const round1 = (v) => Math.round(v * 10) / 10
const round2 = (v) => Math.round(v * 100) / 100

function withStats(spec) {
  // 調查年表的「無調查」年（gap）是內插值，不是觀測：不得影響 min / max / mean（automationFor 用 mean 當基準）
  const vs = spec.points.filter((p) => !p.gap).map((p) => p.v).filter((v) => typeof v === 'number' && Number.isFinite(v))
  const min = vs.length ? Math.min(...vs) : 0, max = vs.length ? Math.max(...vs) : 1
  spec.stats = { min, max, mean: vs.length ? vs.reduce((s, v) => s + v, 0) / vs.length : 0 }
  return spec
}

// ISO 時戳 → "MM-DD HH:MM"（直接取字串，保留資料自帶的時區，不受瀏覽器時區影響）
const fmtT = (iso) => String(iso || '').slice(5, 16).replace('T', ' ')

export function seriesFromOption(o) {
  const s = o && o.series
  if (!s || !s.points || !s.points.length) return null
  const kind = s.target === 'seaLevel' ? 'tide' : 'inflow'
  return withStats({
    kind, name: o.name, label: s.label, unit: s.unit || '', date: s.date || '', step: 1.1, points: s.points, target: s.target || '',
    extra: { lunar: s.lunar || '', lunarLabel: s.lunarLabel || '', range: s.range || '', events: s.events || [] },
  })
}

// 鳥 / 魚調查年表（依年度遞增的相異物種數）。至少 2 個「不同的調查年」才能播放。
// 逐年稠密序列：從第一個調查年到最後一個調查年，每個日曆年一個 point，時間軸才是真實的年份比例。
//   調查年 → { t:'2006', v:種數, n:隻次, gap:false }
//   空窗年 → { t:'2010', v:前後調查年線性內插, n:null, gap:true }（automationFor 照常用 v 驅動，formatHud 標「無調查（內插）」）
// extra.years＝調查年清單；extra.gaps＝連續空窗年的區間 [[起, 迄], …]（例 [[2007, 2013]]）。
// step 0.7 秒 / 年：連續 13 年 ≈ 9.1 秒、5 年 ≈ 3.5 秒、18 年 ≈ 12.6 秒。太慢會讓 8 年空窗拖成冗長的等待，
// 太快（< 0.5）則調查年的鳥 / 魚群變化來不及看清；0.7 與揚塵歷史同節奏，倍速鈕（×0.5–×4）再往兩側調。
const SURVEY_STEP = 0.7
const SURVEY_MAX_SPAN = 120   // 首尾相差超過 120 年視為資料異常（避免異常年份產生數萬個 point）
export function seriesFromSurvey(o, kind) {
  const d = o && o[kind]
  if (!d || !Array.isArray(d.yearly)) return null
  // 整理成「年份遞增、每年一筆」的有效調查年（略過壞資料；同年重複以後者為準）
  const byYear = new Map()
  for (const r of d.yearly) {
    const y = r ? Number(r.y) : NaN
    if (Number.isInteger(y) && typeof r.s === 'number' && Number.isFinite(r.s)) byYear.set(y, { y, s: r.s, n: r.n })
  }
  const ys = [...byYear.values()].sort((a, b) => a.y - b.y)
  if (ys.length < 2 || ys[ys.length - 1].y - ys[0].y > SURVEY_MAX_SPAN) return null
  const points = [], years = [], gaps = []
  let k = 0
  for (let y = ys[0].y; y <= ys[ys.length - 1].y; y++) {
    if (ys[k].y === y) {
      const r = ys[k++]
      points.push({ t: String(y), v: r.s, n: r.n == null ? null : r.n, gap: false })
      years.push(y)
    } else {                                          // 空窗年：在前後兩個調查年之間線性內插
      const a = ys[k - 1], b = ys[k]
      points.push({ t: String(y), v: a.s + (b.s - a.s) * ((y - a.y) / (b.y - a.y)), n: null, gap: true })
      const last = gaps[gaps.length - 1]
      if (last && last[1] === y - 1) last[1] = y; else gaps.push([y, y])
    }
  }
  return withStats({
    kind: 'survey-' + kind, name: d.basin || o.name, label: kind === 'birds' ? T('鳥種數') : T('魚種數'), unit: T('種'),
    date: `${points[0].t}–${points[points.length - 1].t} ${t('調查年表')}`, step: SURVEY_STEP, points, target: kind === 'birds' ? 'birdCount' : 'fishCount',
    extra: { species: d.species, years, gaps },
  })
}

// ---- 調查年表的時間軸（SurveyTimeline 用；純函式，可在 Node 測試）----
// 空窗區間的文字：'2007–2013'；單一年的空窗只寫 '2010'
export const gapRangeText = ([a, b]) => (a === b ? String(a) : `${a}–${b}`)

// 把逐年序列排成「依真實年份等比例」的版面：每個日曆年一格（寬 100/n %），空窗區間成為一段 band。
// 回傳 { n, first, last, maxV, slots:[{i,year,gap,x,w,h}], bands:[{a,b,i,len,x,w}] }（x / w 為 %；h 為柱高 %，最矮 8%）；不是調查年表則回 null
const pct = (v) => Math.round(v * 1000) / 1000
export function timelineLayout(spec) {
  const pts = spec && spec.points, ex = spec && spec.extra
  if (!Array.isArray(pts) || pts.length < 2 || !ex || !Array.isArray(ex.years)) return null
  const n = pts.length
  const maxV = Math.max(1e-9, ...pts.map((p) => (typeof p.v === 'number' && Number.isFinite(p.v) ? p.v : 0)))
  const first = Number(pts[0].t)
  const slots = pts.map((p, i) => ({ i, year: Number(p.t), gap: !!p.gap, x: pct((i / n) * 100), w: pct(100 / n), h: Math.max(8, Math.round((Math.max(0, p.v) / maxV) * 100)) }))
  const bands = (ex.gaps || []).map(([a, b]) => ({ a, b, i: a - first, len: b - a + 1, x: pct(((a - first) / n) * 100), w: pct(((b - a + 1) / n) * 100) }))
  return { n, first, last: Number(pts[n - 1].t), maxV, slots, bands }
}

// 年份軸上要標的年份：頭、尾優先，再來是每段連續調查的起訖年；用貪婪法避開彼此太近（minDist＝格中心間距的 %，預設約一個 4 位數年份的寬度）
export function timelineAxis(L, minDist = 10) {
  if (!L) return []
  const runs = []
  for (const s of L.slots) {
    if (s.gap) continue
    const run = runs[runs.length - 1]
    if (run && run[1] === s.i - 1) run[1] = s.i; else runs.push([s.i, s.i])
  }
  const cand = [0, L.n - 1]
  for (const [a, b] of runs) cand.push(a, b)
  const out = []
  for (const i of cand) {
    if (out.some((o) => o.i === i)) continue
    const x = pct(((i + 0.5) / L.n) * 100)
    if (out.every((o) => Math.abs(o.x - x) >= minDist)) out.push({ i, year: L.slots[i].year, x })
  }
  return out.sort((a, b) => a.i - b.i)
}

// 播放頭（rec.playhead 秒）→ 目前年份格 idx 與游標位置 x（0..100，%）。游標隨時間連續掃過每一格：一格 = 一個 step。
export function playheadAt(L, playhead, step) {
  const f = step > 0 && Number.isFinite(playhead) ? Math.max(0, playhead) / step : 0
  return { idx: Math.max(0, Math.min(L.n - 1, Math.floor(f))), x: pct(Math.max(0, Math.min(1, f / L.n)) * 100) }
}

// 目前播放中的序列（seriesMeta）是不是這張調查卡的序列：兩者是不同物件（播放時 store 會重新組一份），靠 kind / 名稱 / 每一年的年份與數值比對
// （逐點比對，所以同流域同類別但資料不同的序列不會被誤認；元件以 seriesMeta.points 的參照快取結果，不會每幀都比）
export function isSameSeries(meta, spec) {
  if (!meta || !spec || !Array.isArray(meta.points) || !Array.isArray(spec.points) || !meta.points.length || meta.points.length !== spec.points.length) return false
  if (meta.kind !== spec.kind || meta.name !== spec.name) return false
  return meta.points.every((p, i) => p.t === spec.points[i].t && p.v === spec.points[i].v)
}

// 時間軸的文字替代（aria-label 用）：「調查年度 2004、2005、2006、2014、2015；2007 到 2013 無調查」
export function timelineAlt(spec) {
  const ex = spec && spec.extra
  if (!ex || !Array.isArray(ex.years)) return ''
  const sep = getLocale() === 'en' ? ', ' : '、'
  const years = ex.years.join(sep)
  const gaps = (ex.gaps || []).map(([a, b]) => (a === b ? String(a) : t('{a} 到 {b}', { a, b }))).join(sep)
  return gaps ? t('調查年度 {years}；{gaps} 無調查', { years, gaps }) : t('調查年度 {years}；連續調查，無空窗', { years })
}

// 揚塵：CI 每 3 小時累積的最新值歷史（至少 2 筆有效才能播放；不足時回傳 null，UI 會顯示「累積中」）。
// 主變數＝PM10；來源的 PM10 感測器常回傳哨兵值（4999.4，被腳本判為無效 → null），此時改用「風速」（風是揚塵的成因），仍可播放。
// 第三個選用參數 air（= gov.air）：水利署 IoW 的風速也「無效或凍結」（有效筆數 < 2，或所有有效值完全相同）、而 air.history 有逐時「模型風速」（每筆 wind，m/s，
// Open-Meteo 預報 API）時，改回傳 extra.metric === 'wind-model' 的序列（label「風速（模型）」、每步 1 小時）——資料是模型的，不是水利署的：extra.model = true，
// extra.reason = 'frozen'（IoW 風速有值但不變）| 'invalid'（IoW 沒有可用的風速）；呼叫端（資料卡 / 導覽字幕）要誠實說明「風速為模型資料（Open-Meteo），水利署感測器凍結」。
// PM10 有效時（metric 'pm10'）或 IoW 風速還在變時，行為與沒有 air 參數時完全相同。
export function seriesFromDust(dust, name = T('揚塵'), air) {
  const hist = dust && Array.isArray(dust.history) ? dust.history : []
  const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null)
  const withPm = hist.filter((x) => n(x && x.pm10) != null)
  const withWind = hist.filter((x) => n(x && x.wind) != null)
  const label = `${name}${dust && dust.county ? '（' + dust.county + '）' : ''}`
  if (withPm.length < 2 && dust && typeof dust === 'object') {
    const frozen = withWind.length >= 2 && withWind.every((x) => x.wind === withWind[0].wind)
    if (withWind.length < 2 || frozen) {
      const pts = modelWindPoints(air)
      if (pts.length >= 2) {
        return withStats({
          kind: 'dust', name: label, label: T('風速（模型）'), unit: 'm/s', date: `${pts[0].t} → ${pts[pts.length - 1].t}`, step: AIR_STEP, points: pts, target: 'current',
          extra: { metric: 'wind-model', model: true, reason: frozen ? 'frozen' : 'invalid' },
        })
      }
    }
  }
  const metric = withPm.length >= 2 ? 'pm10' : withWind.length >= 2 ? 'wind' : null
  if (!metric) return null
  const points = (metric === 'pm10' ? withPm : withWind).map((x) => ({
    t: fmtT(x.t), v: round1(metric === 'pm10' ? x.pm10 : x.wind), pm: n(x.pm10), w: n(x.wind), tp: n(x.temp), rh: n(x.rh),
  }))
  return withStats({
    kind: 'dust', name: label,
    label: metric === 'pm10' ? 'PM10' : T('風速'), unit: metric === 'pm10' ? 'μg/m³' : 'm/s',
    date: `${points[0].t} → ${points[points.length - 1].t}`, step: 0.7, points, target: metric === 'pm10' ? 'clarity' : 'current', extra: { metric },
  })
}

// air.history 的逐時模型風速（每筆 wind，m/s）→ 揚塵序列的點（沒有 PM10 / 氣溫 / 濕度：那些是水利署感測器的值，模型沒有，不能拿別的東西充數）
function modelWindPoints(air) {
  const hist = air && Array.isArray(air.history) ? air.history : []
  const pts = []
  for (const x of hist) {
    const w = x && typeof x.wind === 'number' && Number.isFinite(x.wind) && x.wind >= 0 ? x.wind : null
    if (w != null) pts.push({ t: fmtT(x.t), v: round1(w), pm: null, w: round1(w), tp: null, rh: null })
  }
  return pts
}

// 空氣品質：Open-Meteo Air Quality（CAMS 全球大氣模型）的逐時 PM2.5 歷史——「模型資料」，不是政府觀測值（name 帶「模型資料」，extra.model = true）。
// air.history：[{ t:'YYYY-MM-DDTHH:00:00+08:00', pm10, pm25, dust, aqi }, …] 逐時遞增（最近 120 小時）；PM2.5 缺值的小時略過，有效點不足 2 個 → null。
// step：0.2 秒＝1 小時，120 點約 24 秒（與潮汐 24 點 × 1.1 秒同一個量級）。逐時的模型資料變化平滑（一小時多半只差 1–3 μg/m³），
// 步子小、事件密，海況才是連續漂移而不是一格一格跳；倍速鈕（×0.5–×4）再往兩側調。
const AIR_STEP = 0.2
// PM2.5 以台灣常見範圍 0–100 μg/m³ 規一化：PM2.5 高 → 海水混濁、垃圾 / 懸浮物多、色相偏黃綠、輝光收斂。
// 與 scripts/gov/air.mjs 的 airMap()（air-yunlin 選項的基準海況）同一組係數（src/lib/air.test.mjs 逐點比對）；洋流的風速沒有逐時資料 → 沿用選項基準，不在此自動化。
export const AIR_PM_SCALE = 100
export function airMapping(pm25) {
  const n = clamp01(pm25 / AIR_PM_SCALE)
  return { clarity: clamp01(0.95 - n * 0.85), trashCount: clamp01(0.06 + n * 0.6), hue: clamp01(0.5 - n * 0.14), glow: clamp01(0.72 - n * 0.42) }
}
// 空氣品質資料的來源：'model'（Open-Meteo / CAMS 模型；預設）| 'obs'（環境部測站觀測 air.obs）| 'auto'（有可用的觀測就用觀測，否則模型——播放 / 資料卡的預設）。
// 要求 'obs' 或 'auto' 但沒有可用的觀測（air.obs 不到 2 個有效的 PM2.5 小時）→ 'model'。回傳實際使用的來源。
export function resolveAirSource(air, source) {
  return (source === 'obs' || source === 'auto') && airObsUsable(air) ? 'obs' : 'model'
}
// 序列規格用的是哪個來源（'obs' | 'model'）：extra.source === 'obs' 才是觀測；其他（含舊規格）一律視為模型
export const airSourceOf = (spec) => (spec && spec.extra && spec.extra.source === 'obs' ? 'obs' : 'model')

// 第三個選用參數 opts.source（見 resolveAirSource；預設 'model'——沒有傳就與過去完全相同）。
//   'model'：模型資料。name 帶「模型資料」、extra = { model: true }——絕不出現「觀測」字樣。
//   'obs'：環境部測站觀測（air.obs.history 的 PM2.5，逐時）。name 帶測站與「環境部觀測」、extra = { model: false, source: 'obs', station }——絕不出現「模型」字樣。
//     點的欄位 { t, v（PM2.5）, pm10, dust: null, aqi（環境部 AQI，不是 US AQI）, wind }；映射（automationFor）與模型序列同一組係數。
export function seriesFromAir(air, name = T('空氣品質'), opts) {
  const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null)
  if (resolveAirSource(air, opts && opts.source) === 'obs') {
    const obs = air.obs, st = obs.station && typeof obs.station === 'object' ? obs.station : {}
    const byMs = new Map()                                             // 依小時排序去重（後者為準）；只收有 PM2.5 的小時
    for (const x of Array.isArray(obs.history) ? obs.history : []) {
      const ms = x && typeof x === 'object' ? hourMs(x.t) : null
      const v = n(x && x.pm25)
      if (ms !== null && v !== null && v >= 0 && v <= 1000) byMs.set(ms, { t: fmtT(x.t), v: round1(v), pm10: n(x.pm10), dust: null, aqi: n(x.aqi), wind: n(x.wind) })
    }
    const pts = [...byMs].sort((a, b) => a[0] - b[0]).map(([, p]) => p)
    if (pts.length >= 2) {
      const where = [air.county || st.county || '', typeof st.name === 'string' ? st.name : '', T('環境部觀測')].filter(Boolean).join(' · ')
      return withStats({
        kind: 'air', name: `${name}（${where}）`, label: 'PM2.5', unit: 'μg/m³',
        date: `${pts[0].t} → ${pts[pts.length - 1].t}`, step: AIR_STEP, points: pts, target: 'clarity',
        extra: { model: false, source: 'obs', station: { name: typeof st.name === 'string' ? st.name : '', county: typeof st.county === 'string' ? st.county : '' } },
      })
    }
  }
  const hist = air && Array.isArray(air.history) ? air.history : []
  const points = []
  for (const x of hist) {
    const v = n(x && x.pm25)
    if (v == null) continue
    points.push({ t: fmtT(x.t), v: round1(v), pm10: n(x.pm10), dust: n(x.dust), aqi: n(x.aqi) })
  }
  if (points.length < 2) return null
  return withStats({
    kind: 'air', name: `${name}（${air.county ? air.county + ' · ' : ''}${T('模型資料')}）`, label: 'PM2.5', unit: 'μg/m³',
    date: `${points[0].t} → ${points[points.length - 1].t}`, step: AIR_STEP, points, target: 'clarity', extra: { model: true },
  })
}

// 月出月沒：days 每列 [日期, 月出, 月出方位, 中天, 中天仰角, 仰角方位N/S, 月沒, 月沒方位]
export function seriesFromMoon(moon) {
  const days = moon && Array.isArray(moon.days) ? moon.days : []
  if (days.length < 3) return null
  const points = days.map((d) => ({
    t: d[0], v: typeof d[4] === 'number' ? d[4] : 0, rise: d[1] || '', riseAz: d[2], transit: d[3] || '', alt: d[4], altDir: d[5] || '', set: d[6] || '', setAz: d[7],
  }))
  return withStats({
    kind: 'moon', name: `${T('月亮')} · ${moon.county || ''}`, label: T('中天仰角'), unit: '°', date: `${moon.from} → ${moon.to}`, step: 0.25, points, target: 'seaLevel',
    extra: { days },
  })
}

// 一步 → 要寫入的參數自動化 [[pid, value], …]
export function automationFor(spec, i) {
  const p = spec.points[i]
  const { min, max, mean } = spec.stats
  switch (spec.kind) {
    case 'tide': {                                   // 潮高 → 海水高度（滿潮映到 1.0 → 觸發外緣溢流）+ 一點浪
      const n = max > min ? (p.v - min) / (max - min) : 0.5
      return [['seaLevel', clamp01(0.45 + n * 0.55)], ['current', clamp01(0.25 + n * 0.35)]]
    }
    case 'inflow': {                                 // 進流量大 → 水流急、魚群聚
      const n = clamp01(p.v / (max || 1))
      return [['current', clamp01(0.15 + n * 0.8)], ['fishCount', clamp01(0.3 + n * 0.6)], ['swimSpeed', clamp01(0.35 + n * 0.5)]]
    }
    case 'dust': {
      if (spec.extra && (spec.extra.metric === 'wind' || spec.extra.metric === 'wind-model')) {   // PM10 無效 → 風速（水利署，或水利署凍結時的模型風速）驅動：風越大 → 洋流越急、海水越混、懸浮物越多
        const n = clamp01(p.v / 12)
        return [['current', clamp01(0.15 + n * 0.8)], ['clarity', clamp01(0.92 - n * 0.4)], ['trashCount', clamp01(0.06 + n * 0.3)], ['hue', clamp01(0.5 - n * 0.12)]]
      }
      const pm = p.v                                   // PM10 高 → 海水混濁、垃圾多、色相偏黃綠；風速 → 洋流
      const out = [['clarity', clamp01(0.95 - pm / 220)], ['trashCount', clamp01(0.06 + pm / 450)], ['hue', clamp01(0.5 - pm / 600)]]
      if (p.w != null) out.push(['current', clamp01(p.w / 12)])
      return out
    }
    case 'air': {                                    // PM2.5 高 → 海水混濁、垃圾多、色相偏黃綠、輝光收斂（洋流留在選項基準：逐時風速沒有資料）
      const m = airMapping(p.v)
      return [['clarity', m.clarity], ['trashCount', m.trashCount], ['hue', m.hue], ['glow', m.glow]]
    }
    case 'survey-birds': {                           // 該年鳥種數相對全期平均 → 球外鳥群數（空窗年用內插的 v；mean 只含真實調查年）
      const rel = mean > 0 ? p.v / mean : 1
      return [['birdCount', flockCount(spec.extra.species, rel) / 5]]
    }
    case 'survey-fish': {
      const rel = mean > 0 ? p.v / mean : 1
      return [['fishCount', fishParam(spec.extra.species, rel)]]
    }
    case 'moon': {                                   // 月亮越高（引力越強，示意）→ 海水越高
      const n = max > min ? (p.v - min) / (max - min) : 0.5
      return [['seaLevel', clamp01(0.45 + n * 0.5)]]
    }
    default: return []
  }
}

// 魚群數量參數：基準（該流域年度魚種數）× 相對豐度（季節 / 年度）。與鳥群 flockCount 同樣的設計。
export function fishParam(species, rel) {
  const r = Math.min(1.6, Math.max(0.4, rel == null ? 1 : rel))
  return round2(clamp01(0.2 + (0.5 * r) / 1.6 + 0.3 * Math.min(1, (species || 60) / 150)))
}

// HUD / 輸出顯示用的一行文字（不含倍速 / 循環）
// meta.name / label / unit 是中文原文（資料名稱），這裡依當下語系翻譯；規格與執行期 seriesMeta 兩種形態都能讀。
export function formatHud(meta, p, ctx = {}) {
  if (!meta || !p) return ''
  const name = nameText(meta.name), label = nameText(meta.label)
  switch (meta.kind) {
    case 'tide': case 'inflow': {
      const hh = String(Math.floor(p.h)).padStart(2, '0'), mm = String(Math.round((p.h % 1) * 60)).padStart(2, '0')
      let txt = t('{name} {date} {time} · {label} {v}{unit}', { name, date: meta.date, time: `${hh}:${mm}`, label, v: p.v, unit: nameText(meta.unit) })
      if (meta.kind === 'tide') {
        const ex = meta.extra || meta                    // 規格（extra 內）與執行期 seriesMeta（同時展開在頂層）兩種形態都能讀
        const ev = (ex.events || []).find((e) => Math.abs(e.h - p.h) < 0.75)
        if (ev) txt += ev.type === HIGH_TIDE ? ' ' + t('↑滿潮') : ev.type === LOW_TIDE ? ' ' + t('↓乾潮') : ''
        if (ex.lunarLabel) txt += ' · ' + (ex.range ? t('{lunar} {range}', { lunar: lunarLabelText(ex.lunarLabel), range: tideRangeText(ex.range) }) : lunarLabelText(ex.lunarLabel))
        if (ctx.moonName) txt += ` · ${ctx.moonName}`
      }
      return txt
    }
    case 'dust': {
      let txt = t('{name} {time} · {label} {v}{unit}', { name, time: p.t, label, v: p.v, unit: nameText(meta.unit) })
      if (meta.label === 'PM10') { if (p.w != null) txt += ' · ' + t('風 {v} m/s', { v: p.w }) }
      else if (p.pm != null) txt += ` · PM10 ${p.pm} μg/m³`
      if (p.tp != null) txt += ' · ' + t('氣溫 {v}°C', { v: p.tp })
      if (p.rh != null) txt += ' · ' + t('濕度 {v}%', { v: p.rh })
      return txt
    }
    case 'air': {                                      // 模型資料：name 已帶「模型資料」；沙塵（模型的礦物沙塵濃度，台灣多半是 0）有值才顯示。環境部觀測：name 帶「環境部觀測」，AQI 是環境部的（不是 US AQI）
      const obs = ((meta.extra || meta) || {}).source === 'obs'
      let txt = t('{name} {time} · {label} {v}{unit}', { name, time: p.t, label, v: p.v, unit: nameText(meta.unit) })
      if (p.pm10 != null) txt += ` · PM10 ${p.pm10} μg/m³`
      if (p.aqi != null) txt += obs ? ` · AQI ${p.aqi}` : ` · US AQI ${p.aqi}`
      if (obs) { if (p.wind != null) txt += ' · ' + t('風 {v} m/s', { v: p.wind }) }
      else if (p.dust != null && p.dust > 0) txt += ' · ' + t('沙塵 {v} μg/m³', { v: p.dust })
      return txt
    }
    case 'survey-birds': case 'survey-fish': {
      if (p.gap) {                                     // 空窗年：標「無調查（內插）」、內插值、以及整段空窗區間
        const ex = meta.extra || meta                  // 規格（extra 內）與執行期 seriesMeta 兩種形態都能讀
        const y = Number(p.t)
        const g = (ex.gaps || []).find(([a, b]) => y >= a && y <= b)
        return t('{name} {year} 年 · 無調查（內插）', { name, year: p.t }) + ' · ' + t('{label} ≈{v}', { label, v: Math.round(p.v) }) + (g ? ' · ' + t('無調查 {range}', { range: gapRangeText(g) }) : '')
      }
      return t('{name} {year} 年 · {label} {v}', { name, year: p.t, label, v: p.v }) + (p.n != null ? ' · ' + t('隻次 {n}', { n: p.n }) : '')
    }
    case 'moon': {
      const d = (p.altDir ? `${p.alt}°${p.altDir}` : '—')
      return t('{name} {date} · 月出 {rise} · 中天 {transit}（仰角 {alt}）· 月沒 {set}', { name, date: p.t, rise: p.rise || '—', transit: p.transit || '—', alt: d, set: p.set || '—' })
    }
    default: return `${name} ${p.t ?? p.h} · ${label} ${p.v}${nameText(meta.unit || '')}`
  }
}
