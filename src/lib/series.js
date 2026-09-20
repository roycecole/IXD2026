// 資料 → 可播放的時間序列規格（純函式，無 I/O，可在 Node 測試）。
// 規格 spec = { kind, name, label, unit, date, step, points[], target, extra, stats:{min,max,mean} }
//   kind：'tide' 潮汐 · 'inflow' 進流量 · 'dust' 揚塵（CI 累積的歷史）· 'survey-birds' / 'survey-fish' 調查年表 · 'moon' 月出月沒
//   points：tide/inflow → {h,v}；dust → {t,v,pm,w,tp,rh}（v＝主變數：PM10 或風速）；survey → {t,v,n}；moon → {t,v,rise,riseAz,transit,alt,altDir,set,setAz}
// 每一步由 automationFor() 轉成參數自動化事件，走既有的錄製/播放引擎（可倍速、循環、soft-takeover 接管）。
import { flockCount } from './birds.js'
import { t, T } from '../i18n/index.js'
import { nameText, lunarLabelText, tideRangeText } from '../i18n/data.js'

// 規格裡的 name / label / unit 一律存「中文原文」（用 T() 標記；資料本身的名稱也是中文），顯示時才翻：
//   formatHud 內用 nameText()；UI 想顯示 spec.label / spec.name，請用 t(label) / nameText(name)。
// 唯一例外：survey 的 date（「2005–2017 調查年表」）是建立當下的語系文字，只在建立當下寫進日誌。
const HIGH_TIDE = T('滿潮'), LOW_TIDE = T('乾潮')   // 與 CWA 事件名（資料值）比對用

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const round1 = (v) => Math.round(v * 10) / 10
const round2 = (v) => Math.round(v * 100) / 100

function withStats(spec) {
  const vs = spec.points.map((p) => p.v).filter((v) => typeof v === 'number' && Number.isFinite(v))
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

// 鳥 / 魚調查年表（依年度遞增的相異物種數）。至少 2 個年度才能播放。
export function seriesFromSurvey(o, kind) {
  const d = o && o[kind]
  if (!d || !d.yearly || d.yearly.length < 2) return null
  const points = d.yearly.map((y) => ({ t: String(y.y), v: y.s, n: y.n == null ? null : y.n }))
  return withStats({
    kind: 'survey-' + kind, name: d.basin || o.name, label: kind === 'birds' ? T('鳥種數') : T('魚種數'), unit: T('種'),
    date: `${points[0].t}–${points[points.length - 1].t} ${t('調查年表')}`, step: 1.4, points, target: kind === 'birds' ? 'birdCount' : 'fishCount',
    extra: { species: d.species },
  })
}

// 揚塵：CI 每 3 小時累積的最新值歷史（至少 2 筆有效才能播放；不足時回傳 null，UI 會顯示「累積中」）。
// 主變數＝PM10；來源的 PM10 感測器常回傳哨兵值（4999.4，被腳本判為無效 → null），此時改用「風速」（風是揚塵的成因），仍可播放。
export function seriesFromDust(dust, name = T('揚塵')) {
  const hist = dust && Array.isArray(dust.history) ? dust.history : []
  const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null)
  const withPm = hist.filter((x) => n(x && x.pm10) != null)
  const withWind = hist.filter((x) => n(x && x.wind) != null)
  const metric = withPm.length >= 2 ? 'pm10' : withWind.length >= 2 ? 'wind' : null
  if (!metric) return null
  const points = (metric === 'pm10' ? withPm : withWind).map((x) => ({
    t: fmtT(x.t), v: round1(metric === 'pm10' ? x.pm10 : x.wind), pm: n(x.pm10), w: n(x.wind), tp: n(x.temp), rh: n(x.rh),
  }))
  return withStats({
    kind: 'dust', name: `${name}${dust.county ? '（' + dust.county + '）' : ''}`,
    label: metric === 'pm10' ? 'PM10' : T('風速'), unit: metric === 'pm10' ? 'μg/m³' : 'm/s',
    date: `${points[0].t} → ${points[points.length - 1].t}`, step: 0.7, points, target: metric === 'pm10' ? 'clarity' : 'current', extra: { metric },
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
      if (spec.extra && spec.extra.metric === 'wind') {   // PM10 無效 → 風速驅動：風越大 → 洋流越急、海水越混、懸浮物越多
        const n = clamp01(p.v / 12)
        return [['current', clamp01(0.15 + n * 0.8)], ['clarity', clamp01(0.92 - n * 0.4)], ['trashCount', clamp01(0.06 + n * 0.3)], ['hue', clamp01(0.5 - n * 0.12)]]
      }
      const pm = p.v                                   // PM10 高 → 海水混濁、垃圾多、色相偏黃綠；風速 → 洋流
      const out = [['clarity', clamp01(0.95 - pm / 220)], ['trashCount', clamp01(0.06 + pm / 450)], ['hue', clamp01(0.5 - pm / 600)]]
      if (p.w != null) out.push(['current', clamp01(p.w / 12)])
      return out
    }
    case 'survey-birds': {                           // 該年鳥種數相對全期平均 → 球外鳥群數
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
    case 'survey-birds': case 'survey-fish':
      return t('{name} {year} 年 · {label} {v}', { name, year: p.t, label, v: p.v }) + (p.n != null ? ' · ' + t('隻次 {n}', { n: p.n }) : '')
    case 'moon': {
      const d = (p.altDir ? `${p.alt}°${p.altDir}` : '—')
      return t('{name} {date} · 月出 {rise} · 中天 {transit}（仰角 {alt}）· 月沒 {set}', { name, date: p.t, rise: p.rise || '—', transit: p.transit || '—', alt: d, set: p.set || '—' })
    }
    default: return `${name} ${p.t ?? p.h} · ${label} ${p.v}${nameText(meta.unit || '')}`
  }
}
