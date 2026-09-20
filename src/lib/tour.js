// 資料導覽（Data Tour）：閒置時依序巡演真實資料，畫面下方用字幕說明「現在看的是什麼、球為什麼長這樣」。
// 本檔是純邏輯（可在 Node 測試）：瀏覽器 API（store、時鐘、活動時間戳）一律以參數注入。
//   buildTour(gov, opts)       → stops[]：依資料產生導覽站（缺什麼資料就略過那一站，不會丟錯）
//   captionText(caption)       → { title, body }：字幕文字。caption 只存「資料」{ key, p }，顯示時才依「當下語系」翻譯，
//                                所以語系中途切換字幕會跟著換；也因此能安全地鏡像到觀眾視窗（JSON 可序列化、與語系無關）
//   createTourRunner(deps)     → 導覽執行器：start / tick / stop；負責套用海況、播放序列、偵測中斷、還原導覽前的狀態。
//                                導覽員控制：goto / next / prev / pause / resume（像簡報一樣跳站、暫停講解）；可選的字幕旁白（narration.js）
//   useTourStore               → 字幕狀態（zustand）；registerMirror('tour') 讓觀眾視窗顯示同一份字幕（含「已暫停」）
// 導覽用既有引擎：useStore 的 setGovOption / playGovSeries / playDust / playAir / playMoon / playSurvey / stopPlayback / setRecSpeed。
import { flagOn } from './urlFlags.js'
import { create } from 'zustand'
import { seriesFromOption, seriesFromSurvey, seriesFromDust, seriesFromAir, seriesFromMoon } from './series.js'
import { dustSummary } from './describe.js'
import { ageFromLunar, moonAge, moonPhaseName } from './moon.js'
import { registerMirror } from './mirror.js'
import { LS, loadLS, saveLS } from './persist.js'
import { t, getLocale, useLocaleStore } from '../i18n/index.js'
import { nameText, lunarLabelText, tideRangeText } from '../i18n/data.js'
import { narrator as sharedNarrator, speechText as sharedSpeechText } from './narration.js'

// ---------------------------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------------------------
export const IDLE_MS = 30000                     // 閒置多久自動開始（與 App 主迴圈的門檻一致；僅供 UI 說明用）
// 各站停留時間（ms）：八站合計約 111 秒（缺站時較短）。series 站會用倍速讓整段序列剛好在時間內播完。
export const TOUR_MS = { reservoir: 11000, tide: 20000, moon: 16000, dust: 12000, air: 12000, birds: 14000, fish: 15000, stations: 11000 }
export const MIN_SPEED = 0.25                    // 資料很稀疏（例如揚塵只有 2 筆）時，放慢到這個倍速就夠了，其餘時間停在終點
export const MAX_SPEED = 4                       // 與面板倍速鈕的上限一致
const HOLD_S = 1.5                               // 序列播完後在終點停留（秒）：讓人看清最後的狀態
export const AUTO_IDLE_DEFAULT = true            // 非 kiosk 時「閒置自動導覽」的預設值（沿用舊吸引模式的行為：閒置 30 秒才動）；想改成預設關閉只要改這裡
export const SPEAK_DEFAULT = false               // 字幕旁白預設不出聲（展場也一樣：要導覽員自己打開，或網址 ?speak=1）
export const PAUSE_SPEED = 1e-6                  // 暫停「序列播放」用的倍速：tickPlayback 用 speed || 1，設 0 會被當成 1；極小值 = 實質凍結，繼續時還原該站的倍速
export const NARRATION_MAX_WAIT_MS = 6000        // 該站時間到、旁白還沒念完時，最多再等這麼久（等的期間不算暫停，只是延後換站）

// ---------------------------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------------------------
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const round1 = (v) => Math.round(v * 10) / 10
const round2 = (v) => Math.round(v * 100) / 100
const two = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
const dash = (v) => (v == null || v === '' || (typeof v === 'number' && !Number.isFinite(v)) ? '—' : String(v))
const nm = (x) => (typeof x === 'string' && x ? nameText(x) : '—')   // 資料名稱（水庫 / 流域 / 選項）→ 當下語系；缺名稱時給破折號，不讓 undefined 漏進字幕
const safe = (fn) => { try { return fn() } catch (e) { return null } }

// 序列（points.length × step 秒）要在 durationMs 內播完的倍速：略早於整站結束（留 HOLD_S 停在終點），進位到 0.01 讓實際時間只會更短
export function speedFor(seqSec, durationMs) {
  if (!(seqSec > 0) || !(durationMs > 0)) return 1
  const dur = durationMs / 1000
  const target = Math.max(1, dur - Math.min(HOLD_S, dur * 0.1))
  const v = Math.ceil((seqSec / target) * 100) / 100
  return Math.max(MIN_SPEED, Math.min(MAX_SPEED, v))
}

// ---------------------------------------------------------------------------------------------
// buildTour：依資料組出導覽站
//   stop = { id, optionId, kind:'apply'|'series', series?, durationMs, speed, seqSec, caption:{ key, p } }
//   series：'tide'（playGovSeries）| 'dust'（playDust）| 'air'（playAir）| 'moon'（playMoon）| 'birds' / 'fish'（playSurvey）
// 順序：今日水庫 → 潮汐 → 月亮 → 揚塵 → 空氣品質 → 鳥群 → 魚群 → 河川測站星座（共 8 站，缺資料的站略過）。
// ---------------------------------------------------------------------------------------------
function reservoirStop(gov, options) {
  const cands = options.filter((o) => !o.kind && o.params && isNum(o.params.seaLevel) && isNum(o.level))
  const opt = cands.find((o) => o.id === 'feitsui') || cands.find((o) => o.id === gov.defaultOption) || cands[0]
  if (!opt) return null
  return { opt, kind: 'apply', caption: { key: 'reservoir', p: { name: opt.name, level: opt.level, sea: round2(opt.params.seaLevel) } } }
}

function tideStop(gov, options, now) {
  for (const opt of options) {
    if (opt.kind !== 'tide') continue
    const spec = seriesFromOption(opt)
    if (!spec || spec.kind !== 'tide' || spec.points.length < 2) continue
    const s = opt.series
    const fromLunar = ageFromLunar(s.lunar, 12)                       // 潮汐表當天的月齡（以農曆日推）；沒有農曆日 → 天文公式
    const age = fromLunar != null ? fromLunar : moonAge(now)
    return {
      opt, kind: 'series', series: 'tide', spec,
      caption: { key: 'tide', p: { name: opt.name, lo: Math.round(spec.stats.min), hi: Math.round(spec.stats.max), unit: s.unit || 'cm', range: s.range || '', lunar: s.lunarLabel || '', age: round1(age) } },
    }
  }
  return null
}

function moonStop(gov, options, now) {
  const opt = options.find((o) => o.kind === 'moon')
  const spec = opt && gov.moon ? seriesFromMoon(gov.moon) : null
  if (!opt || !spec) return null
  const today = gov.moon.days.find((d) => Array.isArray(d) && d[0] === ymd(now))
  return {
    opt, kind: 'series', series: 'moon', spec,
    caption: { key: 'moon', p: { name: opt.name, age: round1(moonAge(now)), today: !!today, rise: today ? today[1] || '' : '', set: today ? today[6] || '' : '', n: spec.points.length } },
  }
}

// 揚塵：有 ≥2 筆有效歷史 → 播放；否則只做靜態，字幕誠實說明（PM10 感測器無效 → 改看風速；歷史累積中）
function dustStop(gov, options) {
  const opt = options.find((o) => o.kind === 'dust')
  if (!opt || !gov.dust) return null
  const spec = seriesFromDust(gov.dust)
  const hist = Array.isArray(gov.dust.history) ? gov.dust.history : []
  const histN = hist.filter((h) => h && (isNum(h.pm10) || isNum(h.wind))).length
  if (spec) {
    const { min, max } = spec.stats
    return {
      opt, kind: 'series', series: 'dust', spec,
      caption: { key: 'dust', p: { name: opt.name, mode: 'play', metric: spec.extra && spec.extra.metric === 'pm10' ? 'pm10' : 'wind', lo: round1(min), hi: round1(max), frozen: max === min } },
    }
  }
  const sum = safe(() => dustSummary(gov.dust))
  const metric = sum && isNum(sum.pm10) ? 'pm10' : sum && isNum(sum.wind) ? 'wind' : 'none'
  return {
    opt, kind: 'apply',
    caption: { key: 'dust', p: { name: opt.name, mode: 'static', metric, pm: sum && isNum(sum.pm10) ? round1(sum.pm10) : null, wind: sum && isNum(sum.wind) ? round1(sum.wind) : null, n: histN } },
  }
}

// 空氣品質：Open-Meteo Air Quality（CAMS 全球大氣模型）的逐時 PM2.5——「模型資料」，不是政府觀測值，字幕一定要講清楚。
// 沒有 gov.air、沒有 kind === 'air' 的選項、或有效小時不足 2 個（seriesFromAir 回 null）→ 略過這一站，其他站不受影響。
// 字幕的 lo / hi 是 PM2.5 的範圍（四捨五入到整數）；flat = 範圍收斂成同一個數字（模型幾乎沒變化）。
function airStop(gov, options) {
  const opt = options.find((o) => o.kind === 'air')
  const spec = opt && gov.air ? seriesFromAir(gov.air) : null
  if (!opt || !spec) return null
  const lo = Math.round(spec.stats.min), hi = Math.round(spec.stats.max)
  return {
    opt, kind: 'series', series: 'air', spec,
    caption: { key: 'air', p: { name: opt.name, lo, hi, n: spec.points.length, flat: lo === hi } },
  }
}

// 鳥 / 魚調查年表：優先用 preferIds 裡有年表的海況（翡翠 → 淡水河的鳥；曾文 → 曾文溪的魚，中間有 2007–2013 的空窗），
// 否則取「調查年最多」的（同數取資料順序在前者）。空窗年（extra.gaps，series.js 提供）在字幕裡明講。
function surveyStop(kind, options, preferIds) {
  const specs = options.map((opt) => ({ opt, spec: seriesFromSurvey(opt, kind) })).filter((x) => x.spec && x.spec.points.length >= 2)
  if (!specs.length) return null
  let pick = null
  for (const id of preferIds) { pick = specs.find((x) => x.opt.id === id); if (pick) break }
  if (!pick) pick = specs.reduce((best, x) => ((x.spec.extra.years || []).length > (best.spec.extra.years || []).length ? x : best), specs[0])
  const { opt, spec } = pick
  const years = (spec.extra.years || []).filter(isNum)
  const gaps = (spec.extra.gaps || []).filter((g) => Array.isArray(g) && isNum(g[0]) && isNum(g[1])).map((g) => [g[0], g[1]])
  return {
    opt, kind: 'series', series: kind, spec,
    caption: { key: kind, p: { basin: opt[kind].basin || opt.name, a: years.length ? years[0] : Number(spec.points[0].t), b: years.length ? years[years.length - 1] : Number(spec.points[spec.points.length - 1].t), k: years.length || spec.points.length, lo: round1(spec.stats.min), hi: round1(spec.stats.max), gaps } },
  }
}

function stationsStop(gov, baseOpt) {
  const s = gov.stations
  const list = s && Array.isArray(s.list) ? s.list : null
  if (!list || !list.length) return null
  return { opt: baseOpt, kind: 'apply', caption: { key: 'stations', p: { total: isNum(s.total) ? s.total : list.length, active: isNum(s.active) ? s.active : list.filter((q) => q && q.s).length } } }
}

// opts：{ now: Date（測試用）, scale: 各站時間的倍率（預設 1）, skip: 要略過的站 id（例如 AR 實景時看不到背景的月亮與星座 → ['moon', 'stations']）}
export function buildTour(gov, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date()
  const scale = isNum(opts.scale) && opts.scale > 0 ? opts.scale : 1
  const skip = new Set(Array.isArray(opts.skip) ? opts.skip : [])
  const options = gov && Array.isArray(gov.options) ? gov.options.filter((o) => o && typeof o === 'object' && o.id != null) : []
  if (!options.length) return []
  const res = safe(() => reservoirStop(gov, options))
  const base = res ? res.opt : options[0]
  const plan = [
    ['reservoir', res],
    ['tide', safe(() => tideStop(gov, options, now))],
    ['moon', safe(() => moonStop(gov, options, now))],
    ['dust', safe(() => dustStop(gov, options))],
    ['air', safe(() => airStop(gov, options))],
    ['birds', safe(() => surveyStop('birds', options, ['feitsui']))],
    ['fish', safe(() => surveyStop('fish', options, ['zengwen']))],
    ['stations', safe(() => stationsStop(gov, base))],
  ]
  const stops = []
  for (const [id, x] of plan) {
    if (!x || skip.has(id)) continue
    const durationMs = Math.round(TOUR_MS[id] * scale)
    const seqSec = x.spec ? x.spec.points.length * x.spec.step : 0
    const stop = { id, optionId: x.opt.id, kind: x.kind }
    if (x.series) stop.series = x.series
    stop.durationMs = durationMs
    stop.speed = x.kind === 'series' ? speedFor(seqSec, durationMs) : 1
    stop.seqSec = round2(seqSec)
    stop.caption = x.caption
    stops.push(stop)
  }
  return stops
}

export const tourTotalMs = (stops) => (stops || []).reduce((s, x) => s + (x.durationMs || 0), 0)

// ---------------------------------------------------------------------------------------------
// 字幕文字（依「當下語系」；元件要自己 useLocale() 訂閱，語系切換才會重繪）
// ---------------------------------------------------------------------------------------------
const gapsText = (gaps) => (Array.isArray(gaps) ? gaps : []).map(([a, b]) => (a === b ? String(a) : `${a}–${b}`)).join(getLocale() === 'en' ? ', ' : '、')

const CAPTIONS = {
  reservoir: (p) => {
    const P = { level: dash(p.level), sea: isNum(p.sea) ? p.sea.toFixed(2) : '—' }
    return {
      title: t('今日水庫 · {name}', { name: nm(p.name) }),
      body: p.sea > 0.97 ? t('水位 {level}% → 海水高度 {sea}（滿庫溢流）：水庫越滿，球裡的海越高', P) : t('水位 {level}% → 海水高度 {sea}：水庫越滿，球裡的海越高', P),
    }
  },
  tide: (p) => {
    const phase = isNum(p.age) ? moonPhaseName(p.age) : ''
    const bits = [p.lunar ? lunarLabelText(p.lunar) : '', getLocale() === 'en' && phase ? phase[0].toLowerCase() + phase.slice(1) : phase].filter(Boolean).join(' · ')   // 英文放在括號裡（句中）→ 首字小寫
    const P = { lo: dash(p.lo), hi: dash(p.hi), unit: p.unit || 'cm', bits, range: p.range ? tideRangeText(p.range) : '' }
    return {
      title: t('潮汐 · {name}', { name: nm(p.name) }),
      body: p.range ? t('今天是{range}（{bits}）：潮位 {lo}–{hi} {unit} 一日起落，帶動海水高度', P) : t('潮位 {lo}–{hi} {unit} 一日起落，帶動海水高度（{bits}）', P),
    }
  },
  moon: (p) => {
    const P = { phase: isNum(p.age) ? moonPhaseName(p.age) : '', rise: dash(p.rise), set: dash(p.set), n: dash(p.n) }
    return {
      title: nm(p.name),
      body: p.today ? t('{phase} · 今日月出 {rise}、月沒 {set}：月亮中天越高，海水越高（示意）', P) : t('{phase} · 月出月沒表 {n} 天：每一步一天，月亮中天越高，海水越高（示意）', P),
    }
  },
  dust: (p) => {
    const title = nm(p.name)
    if (p.mode === 'play') {
      const P = { lo: dash(p.lo), hi: dash(p.hi), v: dash(p.hi) }
      if (p.metric === 'pm10') return { title, body: p.frozen ? t('PM10 {v} μg/m³；來源疑似凍結，數值沒有變化', P) : t('PM10 {lo}–{hi} μg/m³：越高，海水越混濁、垃圾越多', P) }
      return { title, body: p.frozen ? t('PM10 感測器回報無效，改看風速 {v} m/s；來源疑似凍結，數值沒有變化', P) : t('PM10 感測器回報無效，改看風速 {lo}–{hi} m/s：風越大，洋流越急', P) }
    }
    const P = { pm: dash(p.pm), wind: dash(p.wind), n: dash(p.n) }
    if (p.metric === 'pm10') return { title, body: t('PM10 {pm} μg/m³：越高，海水越混濁；歷史還在累積（{n} 筆有效）', P) }
    if (p.metric === 'wind') return { title, body: t('PM10 感測器回報無效，改看風速 {wind} m/s 推動洋流；歷史還在累積（{n} 筆有效）', P) }
    return { title, body: t('這幾座感測站目前沒有有效讀數；歷史還在累積', P) }
  },
  // 空氣品質：對應以 series.js 的 automationFor('air') 為準——PM2.5 高 → 海水清澈度降低（混濁）、垃圾數量增加（色相偏黃綠、輝光收斂也是同一組係數，字幕只講最明顯的兩項）。
  // 誠實原則：標題點出「模型資料」，說明明講「Open-Meteo / CAMS 模型，非政府觀測」。
  air: (p) => {
    const P = { lo: dash(p.lo), hi: dash(p.hi), v: dash(p.lo) }
    return {
      title: t('{name} · 模型資料', { name: nm(p.name) }),
      body: p.flat ? t('PM2.5 約 {v} μg/m³（Open-Meteo / CAMS 模型，非政府觀測）：這段時間變化很小', P) : t('PM2.5 {lo}–{hi} μg/m³（Open-Meteo / CAMS 模型，非政府觀測）：越高，海水越混濁、垃圾越多', P),
    }
  },
  birds: (p) => surveyCaption('birds', p),
  fish: (p) => surveyCaption('fish', p),
  stations: (p) => ({
    title: t('河川測站星座'),
    body: t('水利署 {total} 座河川流量測站依真實座標排成台灣島形：亮星現存（{active}）、暗星已廢', { total: dash(p.total), active: dash(p.active) }),
  }),
}

function surveyCaption(kind, p) {
  const P = { a: dash(p.a), b: dash(p.b), k: dash(p.k), lo: dash(p.lo), hi: dash(p.hi) }
  const body = kind === 'birds' ? t('{a}–{b} 年 {k} 次調查，每年 {lo}–{hi} 種：種數越多，鳥群越多', P) : t('{a}–{b} 年 {k} 次調查，每年 {lo}–{hi} 種：種數越多，魚群越多', P)
  const gaps = Array.isArray(p.gaps) && p.gaps.length ? t('；{gaps} 無調查（內插）', { gaps: gapsText(p.gaps) }) : ''
  return { title: kind === 'birds' ? t('鳥群調查 · {basin}', { basin: nm(p.basin) }) : t('魚群調查 · {basin}', { basin: nm(p.basin) }), body: body + gaps }
}

export function captionText(caption) {
  if (!caption || typeof caption !== 'object' || !CAPTIONS[caption.key]) return { title: '', body: '' }
  try {
    const r = CAPTIONS[caption.key](caption.p && typeof caption.p === 'object' ? caption.p : {})
    return { title: r && r.title != null ? String(r.title) : '', body: r && r.body != null ? String(r.body) : '' }
  } catch (e) { return { title: '', body: '' } }
}

// ---------------------------------------------------------------------------------------------
// 偏好與環境判斷（純函式）
// ---------------------------------------------------------------------------------------------
// 「閒置自動導覽」是否開啟。優先序：網址 ?tour=0/1 > ?kiosk（展場預設開）> 使用者存的偏好 > AUTO_IDLE_DEFAULT
export function resolveAutoIdle({ saved = null, search = '' } = {}) {
  let q
  try { q = new URLSearchParams(search || '') } catch (e) { q = new URLSearchParams('') }
  const u = String(q.get('tour') || '').toLowerCase()
  if (u === '0' || u === 'off') return false
  if (u === '1' || u === 'on') return true
  if (flagOn(search, 'kiosk')) return true                 // ?kiosk=0 明確關閉不算
  if (typeof saved === 'boolean') return saved
  return AUTO_IDLE_DEFAULT
}

// 字幕旁白（語音朗讀）是否開啟。優先序：網址 ?speak=0/1 > 使用者存的偏好 > SPEAK_DEFAULT（預設不出聲，展場也一樣）
export function resolveSpeak({ saved = null, search = '' } = {}) {
  let q
  try { q = new URLSearchParams(search || '') } catch (e) { q = new URLSearchParams('') }
  const u = String(q.get('speak') || '').toLowerCase()
  if (u === '0' || u === 'off' || u === 'false' || u === 'no') return false
  if (u === '1' || u === 'on' || u === 'true' || u === 'yes') return true
  if (typeof saved === 'boolean') return saved
  return SPEAK_DEFAULT
}

// 觀眾視窗（第二個視窗）不能自己跑導覽：導覽由主視窗跑，字幕經 mirror 送過來。以網址判斷，另外收到第一個 mirror 訊息時也會標記為 remote。
export function isAudienceSearch(search) {
  try {
    const q = new URLSearchParams(search || '')
    if (flagOn(search, 'audience')) return true
    return ['audience', 'viewer', 'spectator'].includes(String(q.get('view') || q.get('mode') || q.get('role') || '').toLowerCase())
  } catch (e) { return false }
}

const safeSearch = () => { try { return typeof location !== 'undefined' ? location.search : '' } catch (e) { return '' } }
// LS.tour 是一個物件 { auto, speak }：各偏好各自「合併」寫入，不能互相洗掉（以前 setAutoIdle 整個物件覆寫，會把 speak 洗掉）
const readTourPrefs = () => { const v = loadLS(LS.tour, null); return v && typeof v === 'object' && !Array.isArray(v) ? v : {} }
const savedAuto = () => { const v = readTourPrefs().auto; return typeof v === 'boolean' ? v : null }
const savedSpeak = () => { const v = readTourPrefs().speak; return typeof v === 'boolean' ? v : null }

// 導覽員按鈕用：目前這個瀏覽器有沒有語音合成（沒有就不顯示「念出字幕」開關）。在呼叫當下才問，import 時不碰任何全域。
export function supportsNarration() {
  try { return !!sharedNarrator.supported() } catch (e) { return false }
}

// ---------------------------------------------------------------------------------------------
// 字幕狀態（zustand）：TourCaption / TourControls / TourNav 讀它；registerMirror 把它送到觀眾視窗
// ---------------------------------------------------------------------------------------------
export const useTourStore = create(() => ({
  running: false,
  caption: null,           // { key, p }（不含任何語系文字）
  index: 0,                // 第幾站（0 起算）
  total: 0,
  stopMs: 0,               // 這一站的停留時間（進度條動畫用）
  seq: 0,                  // 每換一站 +1（元件用來判斷「換站了」）
  paused: false,           // 導覽員按了暫停：這一站的計時與序列凍結，字幕標「已暫停」（鏡像到觀眾視窗）
  stopList: [],            // [{ id, caption }]：這一輪實際有的站（進度點按鈕的標籤、複製此站連結的站 id）。只有主視窗用，不鏡像
  autoIdle: resolveAutoIdle({ saved: savedAuto(), search: safeSearch() }),
  speak: resolveSpeak({ saved: savedSpeak(), search: safeSearch() }),   // 字幕旁白偏好（不鏡像：旁白只在跑導覽的主視窗出聲）
  remote: isAudienceSearch(safeSearch()),   // true = 這個視窗只顯示鏡像字幕、不跑導覽
}))

export function setAutoIdle(on) {
  saveLS(LS.tour, { ...readTourPrefs(), auto: !!on })
  useTourStore.setState({ autoIdle: !!on })
}
export function setSpeak(on) {
  saveLS(LS.tour, { ...readTourPrefs(), speak: !!on })
  useTourStore.setState({ speak: !!on })
}
export function setTourRemote(on) { useTourStore.setState({ remote: !!on }) }   // 觀眾視窗實作者可主動標記

// 鏡像切片（模組頂層註冊：兩個視窗載入時都會執行）。apply 只更新字幕 store，不觸發導覽邏輯。
const MIRROR_FIELDS = ['running', 'caption', 'index', 'total', 'stopMs', 'seq', 'paused']
registerMirror('tour', {
  get: () => { const s = useTourStore.getState(); return { running: s.running, caption: s.caption, index: s.index, total: s.total, stopMs: s.stopMs, seq: s.seq, paused: s.paused } },
  apply: (v) => {
    if (!v || typeof v !== 'object') return
    useTourStore.setState({ remote: true, running: !!v.running, caption: v.caption && typeof v.caption === 'object' ? v.caption : null, index: Number(v.index) || 0, total: Number(v.total) || 0, stopMs: Number(v.stopMs) || 0, seq: Number(v.seq) || 0, paused: !!v.paused })
  },
  // 只在「會被鏡像的欄位」改變、且不是由 apply 造成的（remote）時才通知，避免觀眾視窗把收到的字幕又送回去
  subscribe: (cb) => useTourStore.subscribe((s, prev) => { if (!s.remote && MIRROR_FIELDS.some((k) => s[k] !== prev[k])) cb() }),
})

// ---------------------------------------------------------------------------------------------
// 導覽執行器
//   deps.store        useStore（getState()）：讀 gov / params / govOptionId / rec，呼叫 setGovOption / play* / stopPlayback / setRecSpeed / applyParams / pushLog
//   deps.getActivity  () => 最後一次真實輸入的時間戳（activity.last）；比開始時新 = 有人動了 → 中止
//   deps.touch        () => 重置閒置計時（每次結束都呼叫，否則閒置自動導覽會在結束的瞬間又開始）
//   deps.now          () => 目前時間（ms，與 getActivity 同一個時鐘）
//   deps.emit         (partial) => 更新字幕 store（預設寫進 useTourStore）
//   deps.build        (gov, opts) => stops（預設 buildTour）
//   deps.isRemote     () => 是否為觀眾視窗（預設讀 useTourStore.remote）
//   deps.afterPlay    () => 導覽開始播放序列後的回呼（選用）
//   旁白（選用；預設不出聲）：
//   deps.narrator     旁白物件（narration.js 的 narrator：supported / speak / cancel / speaking），預設用共用實例。永遠以「方法呼叫」使用，不脫離原物件
//   deps.speechText   ({ title, body }, locale) => 朗讀用字串（預設 narration.js 的 speechText）
//   deps.isSpeak      () => 旁白偏好（預設讀 useTourStore.speak）
//   deps.getLocale    () => 目前語系（預設 i18n 的 getLocale）
//   deps.subscribeLocale / deps.subscribeSpeak   (cb) => 取消訂閱函式：語系切換 / 旁白開關切換時通知（預設訂閱 useLocaleStore / useTourStore）
// 還原：開始時記下「導覽前」的參數 / 海況選項 / 播放倍速；結束或被中斷時 setGovOption(舊選項) → applyParams(舊參數) → setRecSpeed(舊倍速)。
//   使用者「接手」（開始錄製、自己按播放、換了海況）時不還原——以使用者的操作為準，只停掉我們自己的播放。
//   使用者在導覽前暫存的錄製由 playSeries / stopPlayback 既有的機制還原。
// 自動（閒置）啟動的導覽會無限循環（展場）直到有人動；手動啟動的導覽播一輪後結束並還原。
// 導覽員控制（goto / next / prev / pause / resume）：
//   · 換站一律經過同一個 begin(i)（先寫導覽 OUT 日誌 → 套用海況 → 資料播放）；導覽員換站不是使用者「接手」，run.expect 同步更新，不會觸發 'input' / 'option' 中止。
//   · 暫停凍結兩件事：這一站的計時（繼續後從剩餘時間接著算）與序列播放（倍速設成 PAUSE_SPEED，繼續時還原該站的倍速）。
//     暫停不是「鎖定」：真實輸入（觸碰 / 按鍵 / MIDI）照樣中止導覽——tick 仍會偵測中斷，只是不推進時間。
// ---------------------------------------------------------------------------------------------
const PLAY = {
  tide: (s) => s.playGovSeries(),
  dust: (s) => s.playDust(),
  air: (s) => s.playAir(),
  moon: (s) => s.playMoon(),
  birds: (s) => s.playSurvey('birds'),
  fish: (s) => s.playSurvey('fish'),
}

const noop = () => {}

// 站的定位：整數 index（0 起算）或站 id 字串；找不到 → fallback
export function resolveStopIndex(stops, at, fallback = 0) {
  const list = Array.isArray(stops) ? stops : []
  if (typeof at === 'number' && Number.isInteger(at) && at >= 0 && at < list.length) return at
  if (typeof at === 'string' && at) { const k = list.findIndex((x) => x && x.id === at); if (k >= 0) return k }
  return fallback
}

export function createTourRunner(deps) {
  const store = deps.store
  const getActivity = deps.getActivity || (() => 0)
  const touch = deps.touch || (() => {})
  const now = deps.now || (() => Date.now())
  const emit = deps.emit || ((p) => useTourStore.setState(p))
  const build = deps.build || buildTour
  const isRemote = deps.isRemote || (() => useTourStore.getState().remote)
  const afterPlay = deps.afterPlay || (() => {})   // 每次「導覽自己開始播放序列」後呼叫（讓外層把 store 記的「演出次數」扣回去：導覽不是使用者的演出）
  const speaker = deps.narrator || sharedNarrator
  const speechOf = deps.speechText || sharedSpeechText
  const isSpeak = deps.isSpeak || (() => !!useTourStore.getState().speak)
  const localeNow = deps.getLocale || (() => getLocale())
  const subLocale = deps.subscribeLocale || ((cb) => useLocaleStore.subscribe((s, prev) => { if (s.locale !== prev.locale) cb() }))
  const subSpeak = deps.subscribeSpeak || ((cb) => useTourStore.subscribe((s, prev) => { if (s.speak !== prev.speak) cb() }))
  const st = () => store.getState()
  let run = null
  let stopping = false   // stop() 進行中（還原海況時的 playStop / overflow 等副作用事件，是「導覽收尾」引起的，不是使用者引起的）
  let seq = 0
  const api = { lastFail: '' }

  const log = (text) => { const s = st(); if (s.pushLog) s.pushLog('out', text) }

  // ---- 旁白：所有呼叫都包 try/catch——旁白壞了、被瀏覽器擋了（未經使用者手勢 → speak 以 'error' 解決）都不能影響導覽 ----
  const speechOn = () => { try { return !!isSpeak() && !isRemote() && !!speaker.supported() } catch (e) { return false } }
  function speakCurrent() {
    const r = run
    if (!r || r.paused || !speechOn()) return
    try {
      const text = speechOf(captionText(r.stops[r.i].caption), localeNow())
      if (!text) return
      if (r.spoke) { try { speaker.cancel() } catch (e) { /* ignore */ } }   // 前一句先取消（narrator.speak 本身也會取消前一句，這裡不去依賴它）
      r.spoke = true
      const p = speaker.speak(text)
      if (p && typeof p.then === 'function') p.then(noop, noop)  // 'done' / 'cancelled' / 'error' / 'unsupported' 都不影響導覽
    } catch (e) { /* ignore */ }
  }
  function cancelSpeech(r) {
    if (!r || !r.spoke) return                                   // 這一輪沒念過就不去動共用的旁白（可能是別的功能在用）
    r.spoke = false
    try { speaker.cancel() } catch (e) { /* ignore */ }
  }
  const narrationBusy = () => { try { return speechOn() && !!speaker.speaking() } catch (e) { return false } }

  // ---- 暫停 / 繼續的序列凍結 ----
  function thaw(r) {                                              // 還原「我們自己」設成極小值的倍速
    const cur = r.stops[r.i]
    st().setRecSpeed(cur && cur.kind === 'series' ? cur.speed : r.snap.speed)
    r.frozen = false
  }

  function begin(i) {
    const cur = run.stops[i]
    run.i = i; run.at = now(); run.own = false; run.frozenMs = 0; run.waitFrom = null
    log(t('導覽 {i}/{n}｜{title}', { i: i + 1, n: run.stops.length, title: captionText(cur.caption).title }))   // 先寫這一行，OUT 監看的順序才是「導覽 → 套用海況 → 資料播放」
    const s = st()
    if (s.rec.mode === 'playing') s.stopPlayback()        // 保險：轉站前先停掉上一站的播放（playSeries 只在 idle 才會開始）
    s.setGovOption(cur.optionId)                           // 套用該海況基準（同時寫一行 OUT 日誌）
    run.expect = cur.optionId                              // 導覽員換站也走這裡：expect 同步更新，tick 不會把它當成「有人換了海況」
    if (cur.kind === 'series' && PLAY[cur.series]) {
      st().setRecSpeed(run.paused ? PAUSE_SPEED : cur.speed)   // 暫停中換站：序列在該站起點凍結
      run.frozen = run.paused
      PLAY[cur.series](st())
      run.own = st().rec.mode === 'playing'                // 沒播起來（資料不足）→ 當作靜態站，字幕照顯示
      if (run.own) afterPlay()
    }
    emit({ running: true, paused: run.paused, caption: cur.caption, index: i, total: run.stops.length, stopMs: cur.durationMs, seq: ++seq })
    speakCurrent()
  }

  // 跳到第 i 站（0 起算的 index，或站 id）。跳到「目前這一站」= 重播該站；找不到那一站 → false（什麼都不動）
  function goto(i) {
    if (!run) return false
    const idx = resolveStopIndex(run.stops, i, -1)
    if (idx < 0) return false
    if (st().rec.mode === 'recording') return stop('rec')  // 剛好有人開始錄製、輪詢還沒偵測到：讓給使用者，不去換他的海
    if (st().rec.mode === 'playing') st().stopPlayback()   // 轉站前先停播放
    run.own = false
    begin(idx)
    return true
  }

  // 下一站：最後一站 → 自動（閒置啟動、無限循環）回第 0 站；手動 → 'done' 結束並還原
  function next() {
    if (!run) return false
    const n = run.i + 1
    if (n < run.stops.length) return goto(n)
    if (run.auto) return goto(0)
    return stop('done')
  }
  // 上一站：第 0 站 = 重播第 0 站
  function prev() {
    if (!run) return false
    return goto(Math.max(0, run.i - 1))
  }

  function pause() {
    const r = run
    if (!r || r.paused) return false
    r.paused = true
    r.frozenMs = Math.max(0, now() - r.at)                 // 這一站已經過了多久：繼續時從這裡接著算，不重新計滿
    r.waitFrom = null
    if (r.own && st().rec.mode === 'playing') { st().setRecSpeed(PAUSE_SPEED); r.frozen = true }   // apply 站沒有序列 → 只凍計時
    cancelSpeech(r)
    emit({ paused: true })
    log(t('資料導覽暫停（第 {n} 站）', { n: r.i + 1 }))
    return true
  }

  function resume() {
    const r = run
    if (!r || !r.paused) return false
    r.paused = false
    r.at = now() - r.frozenMs
    r.waitFrom = null
    if (r.frozen) thaw(r)
    emit({ paused: false })
    log(t('資料導覽繼續（第 {n} 站）', { n: r.i + 1 }))
    speakCurrent()                                         // 從頭重念目前這一站
    return true
  }

  // reason：'done' 播完一輪 · 'user' 使用者按停止 / Esc · 'input' 偵測到輸入 · 'rec' 開始錄製 · 'external' 自己按了播放 · 'option' 換了海況 · 'hidden' 分頁被隱藏 / 離開
  function stop(reason = 'user') {
    if (!run) return false
    const r = run
    run = null   // 先標成「已結束」：下面的 touch() 會觸發活動掛鉤（→ 再呼叫 stop），重入時在這裡直接回傳
    stopping = true
    try {
      for (const off of r.offs) { try { off() } catch (e) { /* ignore */ } }
      cancelSpeech(r)
      const takeover = reason === 'rec' || reason === 'external' || reason === 'option'
      let s = st()
      if (s.rec.mode === 'playing' && (r.own || !takeover)) s.stopPlayback()   // 我們的序列 → 停（並還原使用者暫存的錄製）
      s = st()
      if (!takeover && s.rec.mode === 'idle') {
        s.setGovOption(r.snap.optionId)                      // 導覽前的海況選項（同時套用該選項的參數）
        s.applyParams(r.snap.params)                         // 再蓋回導覽前的參數（保留使用者微調過的值）
        s.setRecSpeed(r.snap.speed)
        if (s.persistParams) s.persistParams()               // 導覽期間主迴圈可能已把「導覽中的參數」寫進偏好，這裡寫回還原後的
      } else if (r.frozen) {
        s.setRecSpeed(r.snap.speed)                          // 接手時不還原海況，但「暫停用的極小倍速」一定要還回去，否則使用者自己的播放會像當掉一樣不動
      }
      touch()
      emit({ running: false, paused: false, caption: null, index: 0, total: 0, stopMs: 0, stopList: [] })
      log(reason === 'done' ? t('■ 資料導覽結束，已還原原本的海') : takeover ? t('■ 資料導覽中止（改由你接手）') : t('■ 資料導覽中止，已還原原本的海'))
    } finally { stopping = false }
    return true
  }

  // opts：{ auto, opts（傳給 build）, at（起始站：0 起算的 index 或站 id；找不到 → 從 0）, hold（true = 到站後立即暫停：導覽員模式）}
  function start({ auto = false, opts, at, hold = false } = {}) {
    api.lastFail = ''
    if (run) { api.lastFail = 'running'; return false }
    if (isRemote()) { api.lastFail = 'remote'; return false }
    const s = st()
    if (!s.gov || !s.rec) { api.lastFail = 'nogov'; return false }
    if (s.rec.mode !== 'idle') { api.lastFail = 'busy'; return false }
    const stops = build(s.gov, opts)
    if (!stops || !stops.length) { api.lastFail = 'empty'; return false }
    const first = resolveStopIndex(stops, at, 0)
    touch()                                                 // 手動開始也算一次互動：閒置計時從現在重算
    const r = run = {
      stops, i: -1, at: 0, own: false, expect: null, auto: !!auto, base: getActivity(), snap: { params: { ...s.params }, optionId: s.govOptionId, speed: s.rec.speed },
      paused: !!hold, frozenMs: 0, frozen: false, spoke: false, waitFrom: null, offs: [],
    }
    log(t('▶ 資料導覽開始（{n} 站）', { n: stops.length }))
    emit({ stopList: stops.map((x) => ({ id: x.id, caption: x.caption })) })
    // 語系切換（字幕文字已換語言）→ 重念；旁白開關切換 → 立刻念 / 立刻停。停止時一併取消訂閱。
    try { r.offs.push(subLocale(() => { if (run === r) speakCurrent() })) } catch (e) { /* ignore */ }
    try { r.offs.push(subSpeak(() => { if (run !== r) return; if (isSpeak()) speakCurrent(); else cancelSpeech(r) })) } catch (e) { /* ignore */ }
    begin(first)
    if (r.paused) log(t('資料導覽暫停（第 {n} 站）', { n: first + 1 }))
    return true
  }

  // 由 setInterval（約 100ms）驅動：偵測中斷、到時間換站。不做任何昂貴的事。
  function tick(t0 = now()) {
    if (!run) return
    const s = st()
    if (getActivity() > run.base) return stop('input')      // MIDI / 滑桿 / 3D 拖曳 / 遙控 / 手把：任何真實輸入（暫停中也一樣：暫停不是鎖定）
    if (s.rec.mode === 'recording') return stop('rec')      // 開始錄製 = 輸入
    if (run.own && s.rec.mode === 'idle') run.own = false   // 我們的序列播完了（或被按了停止）：停在終點直到本站結束
    else if (!run.own && s.rec.mode === 'playing') return stop('external')   // 使用者自己按了播放
    if (s.govOptionId !== run.expect) return stop('option') // 有人換了海況選項
    if (run.paused) return                                  // 暫停：計時凍結，不換站
    if (t0 - run.at >= run.stops[run.i].durationMs) {
      // 旁白還在念：最多再等 NARRATION_MAX_WAIT_MS 讓句子念完（只是延後換站，不算暫停；暫停 / 中止 / 跳站都會結束這段等待）
      if (narrationBusy()) {
        if (run.waitFrom === null) run.waitFrom = t0
        if (t0 - run.waitFrom < NARRATION_MAX_WAIT_MS) return
      }
      next()
    }
  }

  return Object.assign(api, {
    start, stop, tick, goto, next, prev, pause, resume,
    isRunning: () => !!run,
    isPaused: () => !!(run && run.paused),
    isActive: () => !!run || stopping,   // 導覽進行中「或正在收尾」：觸覺回饋據此靜音（導覽自己的換站 / 播放 / 還原不是使用者的事件）
    current: () => (run ? { index: run.i, total: run.stops.length, stop: run.stops[run.i], auto: run.auto, paused: run.paused } : null),
  })
}
