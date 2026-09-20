// 資料導覽（Data Tour）：閒置時依序巡演真實資料，畫面下方用字幕說明「現在看的是什麼、球為什麼長這樣」。
// 本檔是純邏輯（可在 Node 測試）：瀏覽器 API（store、時鐘、活動時間戳）一律以參數注入。
//   buildTour(gov, opts)       → stops[]：依資料產生導覽站（缺什麼資料就略過那一站，不會丟錯）
//   captionText(caption)       → { title, body }：字幕文字。caption 只存「資料」{ key, p }，顯示時才依「當下語系」翻譯，
//                                所以語系中途切換字幕會跟著換；也因此能安全地鏡像到觀眾視窗（JSON 可序列化、與語系無關）
//   createTourRunner(deps)     → 導覽執行器：start / tick / stop；負責套用海況、播放序列、偵測中斷、還原導覽前的狀態
//   useTourStore               → 字幕狀態（zustand）；registerMirror('tour') 讓觀眾視窗顯示同一份字幕
// 導覽用既有引擎：useStore 的 setGovOption / playGovSeries / playDust / playMoon / playSurvey / stopPlayback / setRecSpeed。
import { create } from 'zustand'
import { seriesFromOption, seriesFromSurvey, seriesFromDust, seriesFromMoon } from './series.js'
import { dustSummary } from './describe.js'
import { ageFromLunar, moonAge, moonPhaseName } from './moon.js'
import { registerMirror } from './mirror.js'
import { LS, loadLS, saveLS } from './persist.js'
import { t, getLocale } from '../i18n/index.js'
import { nameText, lunarLabelText, tideRangeText } from '../i18n/data.js'

// ---------------------------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------------------------
export const IDLE_MS = 30000                     // 閒置多久自動開始（與 App 主迴圈的門檻一致；僅供 UI 說明用）
// 各站停留時間（ms）：七站合計約 99 秒（缺站時較短）。series 站會用倍速讓整段序列剛好在時間內播完。
export const TOUR_MS = { reservoir: 11000, tide: 20000, moon: 16000, dust: 12000, birds: 14000, fish: 15000, stations: 11000 }
export const MIN_SPEED = 0.25                    // 資料很稀疏（例如揚塵只有 2 筆）時，放慢到這個倍速就夠了，其餘時間停在終點
export const MAX_SPEED = 4                       // 與面板倍速鈕的上限一致
const HOLD_S = 1.5                               // 序列播完後在終點停留（秒）：讓人看清最後的狀態
export const AUTO_IDLE_DEFAULT = true            // 非 kiosk 時「閒置自動導覽」的預設值（沿用舊吸引模式的行為：閒置 30 秒才動）；想改成預設關閉只要改這裡

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
//   series：'tide'（playGovSeries）| 'dust'（playDust）| 'moon'（playMoon）| 'birds' / 'fish'（playSurvey）
// 順序：今日水庫 → 潮汐 → 月亮 → 揚塵 → 鳥群 → 魚群 → 河川測站星座。
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
  if (q.has('kiosk')) return true
  if (typeof saved === 'boolean') return saved
  return AUTO_IDLE_DEFAULT
}

// 觀眾視窗（第二個視窗）不能自己跑導覽：導覽由主視窗跑，字幕經 mirror 送過來。以網址判斷，另外收到第一個 mirror 訊息時也會標記為 remote。
export function isAudienceSearch(search) {
  try {
    const q = new URLSearchParams(search || '')
    if (q.has('audience')) return true
    return ['audience', 'viewer', 'spectator'].includes(String(q.get('view') || q.get('mode') || q.get('role') || '').toLowerCase())
  } catch (e) { return false }
}

const safeSearch = () => { try { return typeof location !== 'undefined' ? location.search : '' } catch (e) { return '' } }
const savedAuto = () => { const v = loadLS(LS.tour, null); return v && typeof v.auto === 'boolean' ? v.auto : null }

// ---------------------------------------------------------------------------------------------
// 字幕狀態（zustand）：TourCaption / TourControls 讀它；registerMirror 把它送到觀眾視窗
// ---------------------------------------------------------------------------------------------
export const useTourStore = create(() => ({
  running: false,
  caption: null,           // { key, p }（不含任何語系文字）
  index: 0,                // 第幾站（0 起算）
  total: 0,
  stopMs: 0,               // 這一站的停留時間（進度條動畫用）
  seq: 0,                  // 每換一站 +1（元件用來判斷「換站了」）
  autoIdle: resolveAutoIdle({ saved: savedAuto(), search: safeSearch() }),
  remote: isAudienceSearch(safeSearch()),   // true = 這個視窗只顯示鏡像字幕、不跑導覽
}))

export function setAutoIdle(on) {
  saveLS(LS.tour, { auto: !!on })
  useTourStore.setState({ autoIdle: !!on })
}
export function setTourRemote(on) { useTourStore.setState({ remote: !!on }) }   // 觀眾視窗實作者可主動標記

// 鏡像切片（模組頂層註冊：兩個視窗載入時都會執行）。apply 只更新字幕 store，不觸發導覽邏輯。
const MIRROR_FIELDS = ['running', 'caption', 'index', 'total', 'stopMs', 'seq']
registerMirror('tour', {
  get: () => { const s = useTourStore.getState(); return { running: s.running, caption: s.caption, index: s.index, total: s.total, stopMs: s.stopMs, seq: s.seq } },
  apply: (v) => {
    if (!v || typeof v !== 'object') return
    useTourStore.setState({ remote: true, running: !!v.running, caption: v.caption && typeof v.caption === 'object' ? v.caption : null, index: Number(v.index) || 0, total: Number(v.total) || 0, stopMs: Number(v.stopMs) || 0, seq: Number(v.seq) || 0 })
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
// 還原：開始時記下「導覽前」的參數 / 海況選項 / 播放倍速；結束或被中斷時 setGovOption(舊選項) → applyParams(舊參數) → setRecSpeed(舊倍速)。
//   使用者「接手」（開始錄製、自己按播放、換了海況）時不還原——以使用者的操作為準，只停掉我們自己的播放。
//   使用者在導覽前暫存的錄製由 playSeries / stopPlayback 既有的機制還原。
// 自動（閒置）啟動的導覽會無限循環（展場）直到有人動；手動啟動的導覽播一輪後結束並還原。
// ---------------------------------------------------------------------------------------------
const PLAY = {
  tide: (s) => s.playGovSeries(),
  dust: (s) => s.playDust(),
  moon: (s) => s.playMoon(),
  birds: (s) => s.playSurvey('birds'),
  fish: (s) => s.playSurvey('fish'),
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
  const st = () => store.getState()
  let run = null
  let seq = 0
  const api = { lastFail: '' }

  const log = (text) => { const s = st(); if (s.pushLog) s.pushLog('out', text) }

  function begin(i) {
    const cur = run.stops[i]
    run.i = i; run.at = now(); run.own = false
    log(t('導覽 {i}/{n}｜{title}', { i: i + 1, n: run.stops.length, title: captionText(cur.caption).title }))   // 先寫這一行，OUT 監看的順序才是「導覽 → 套用海況 → 資料播放」
    const s = st()
    if (s.rec.mode === 'playing') s.stopPlayback()        // 保險：轉站前先停掉上一站的播放（playSeries 只在 idle 才會開始）
    s.setGovOption(cur.optionId)                           // 套用該海況基準（同時寫一行 OUT 日誌）
    run.expect = cur.optionId
    if (cur.kind === 'series' && PLAY[cur.series]) {
      st().setRecSpeed(cur.speed)
      PLAY[cur.series](st())
      run.own = st().rec.mode === 'playing'                // 沒播起來（資料不足）→ 當作靜態站，字幕照顯示
      if (run.own) afterPlay()
    }
    emit({ running: true, caption: cur.caption, index: i, total: run.stops.length, stopMs: cur.durationMs, seq: ++seq })
  }

  function advance() {
    const s = st()
    if (s.rec.mode === 'playing') s.stopPlayback()         // 轉下一站前先停播放
    run.own = false
    const next = run.i + 1
    if (next < run.stops.length) return begin(next)
    if (run.auto) return begin(0)                          // 展場：閒置啟動 → 無限循環，直到有人動
    stop('done')
  }

  // reason：'done' 播完一輪 · 'user' 使用者按停止 / Esc · 'input' 偵測到輸入 · 'rec' 開始錄製 · 'external' 自己按了播放 · 'option' 換了海況 · 'hidden' 分頁被隱藏 / 離開
  function stop(reason = 'user') {
    if (!run) return false
    const r = run
    run = null
    const takeover = reason === 'rec' || reason === 'external' || reason === 'option'
    let s = st()
    if (s.rec.mode === 'playing' && (r.own || !takeover)) s.stopPlayback()   // 我們的序列 → 停（並還原使用者暫存的錄製）
    s = st()
    if (!takeover && s.rec.mode === 'idle') {
      s.setGovOption(r.snap.optionId)                      // 導覽前的海況選項（同時套用該選項的參數）
      s.applyParams(r.snap.params)                         // 再蓋回導覽前的參數（保留使用者微調過的值）
      s.setRecSpeed(r.snap.speed)
      if (s.persistParams) s.persistParams()               // 導覽期間主迴圈可能已把「導覽中的參數」寫進偏好，這裡寫回還原後的
    }
    touch()
    emit({ running: false, caption: null, index: 0, total: 0, stopMs: 0 })
    log(reason === 'done' ? t('■ 資料導覽結束，已還原原本的海') : takeover ? t('■ 資料導覽中止（改由你接手）') : t('■ 資料導覽中止，已還原原本的海'))
    return true
  }

  function start({ auto = false, opts } = {}) {
    api.lastFail = ''
    if (run) { api.lastFail = 'running'; return false }
    if (isRemote()) { api.lastFail = 'remote'; return false }
    const s = st()
    if (!s.gov || !s.rec) { api.lastFail = 'nogov'; return false }
    if (s.rec.mode !== 'idle') { api.lastFail = 'busy'; return false }
    const stops = build(s.gov, opts)
    if (!stops || !stops.length) { api.lastFail = 'empty'; return false }
    touch()                                                 // 手動開始也算一次互動：閒置計時從現在重算
    run = { stops, i: -1, at: 0, own: false, expect: null, auto: !!auto, base: getActivity(), snap: { params: { ...s.params }, optionId: s.govOptionId, speed: s.rec.speed } }
    log(t('▶ 資料導覽開始（{n} 站）', { n: stops.length }))
    begin(0)
    return true
  }

  // 由 setInterval（約 100ms）驅動：偵測中斷、到時間換站。不做任何昂貴的事。
  function tick(t0 = now()) {
    if (!run) return
    const s = st()
    if (getActivity() > run.base) return stop('input')      // MIDI / 滑桿 / 3D 拖曳 / 遙控 / 手把：任何真實輸入
    if (s.rec.mode === 'recording') return stop('rec')      // 開始錄製 = 輸入
    if (run.own && s.rec.mode === 'idle') run.own = false   // 我們的序列播完了（或被按了停止）：停在終點直到本站結束
    else if (!run.own && s.rec.mode === 'playing') return stop('external')   // 使用者自己按了播放
    if (s.govOptionId !== run.expect) return stop('option') // 有人換了海況選項
    if (t0 - run.at >= run.stops[run.i].durationMs) advance()
  }

  return Object.assign(api, {
    start, stop, tick,
    isRunning: () => !!run,
    current: () => (run ? { index: run.i, total: run.stops.length, stop: run.stops[run.i], auto: run.auto } : null),
  })
}
