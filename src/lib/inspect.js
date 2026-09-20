// 點物件看資料出處：純邏輯（不碰 three / DOM，可直接用 node 測試：inspect.test.mjs）。
//   1) 選取：螢幕空間「最近點 + 距離閾值」（pickTarget），物件由 Scene3D 以 registerPickSource 暴露（世界座標 → collectCandidates 投影成螢幕座標）
//   2) 輕點判定：createTapTracker（位移 < 10px 且 < 450ms、單指、非雙擊的第二下才算輕點；不與拖曳 / 長按 / 兩指縮放衝突）
//   3) 卡片：資料描述（stationData / moonData / birdData，存進 store 與鏡像的是「純 JSON 的資料」，不含翻譯好的字串）
//            + describeInspect（顯示時才 t()，語系切換會跟著變）+ placeCard（貼近物件、邊界夾住、窄畫面改停靠下緣）
//   4) 卡片狀態小 store（createInspectStore）：開 / 關 / 6 秒無操作自動關 / 游標停在卡片上暫停計時 / 觀眾視窗鏡像
import { t } from '../i18n/index.js'
import { nameText, tideRangeText, lunarDayText } from '../i18n/data.js'
import { birdSeasonal, flockCount } from './birds.js'
import { ageFromLunar, moonAge, moonAltAz, moonPhaseName, dateAtHour } from './moon.js'

const fin = (v) => typeof v === 'number' && Number.isFinite(v)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const clamp01 = (v) => clamp(v, 0, 1)
const numOrNull = (v) => (fin(v) ? v : null)
const pad2 = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

// ───────────────────────────── 選取 ─────────────────────────────
export const KINDS = ['station', 'bird', 'moon']
export const THRESHOLD_PX = { touch: 24, pen: 16, mouse: 12 }   // 點擊點到物件的最大螢幕距離（手指比滑鼠粗）
export const MIN_ALPHA = { station: 0.5, bird: 0.5, moon: 0.25 }   // 淡出到這個透明度以下就看不見了 → 不可選取
export const PRIORITY = { station: 0, bird: 1, moon: 2 }        // 小而具體的點（測站）優先於鳥群、再優先於月亮這種大圓盤
export const thresholdFor = (pointerType) => THRESHOLD_PX[pointerType] || THRESHOLD_PX.mouse

// 物件註冊表：Scene3D 的各元件在 effect 裡註冊「回傳世界座標」的函式（按需呼叫，不在每幀更新）
//   fn() → null | { alpha?: 0..1, items: [{ id, x, y, z, rWorld?: 物件本體的世界半徑（月亮圓盤 / 鳥群），alpha?: 個別透明度 }] }
export const pickSources = new Map()
export function registerPickSource(kind, fn) {
  pickSources.set(kind, fn)
  return () => { if (pickSources.get(kind) === fn) pickSources.delete(kind) }
}

// 註冊表 → 螢幕空間候選。project(x, y, z) → null（在相機後方）| { sx, sy, pxPerUnit }：螢幕座標（相對畫布左上）與該深度每個世界單位的像素數
export function collectCandidates(sources, project) {
  const out = []
  for (const [kind, fn] of sources) {
    let s = null
    try { s = fn() } catch (e) { s = null }
    if (!s || !Array.isArray(s.items)) continue
    for (const it of s.items) {
      if (!it || !fin(it.x) || !fin(it.y) || !fin(it.z)) continue
      const p = project(it.x, it.y, it.z)
      if (!p || !fin(p.sx) || !fin(p.sy)) continue
      out.push({ kind, id: it.id, sx: p.sx, sy: p.sy, r: (it.rWorld || 0) * (p.pxPerUnit || 0), alpha: fin(it.alpha) ? it.alpha : fin(s.alpha) ? s.alpha : 1 })
    }
  }
  return out
}

// 在螢幕點 pt = {x, y} 附近選一個物件。cands：[{ kind, id, sx, sy, r?, alpha? }]（r＝本體的螢幕半徑，點狀物件為 0）
// 規則：alpha 低於該類的 MIN_ALPHA 不可選；本體邊緣（距離 − r）超過閾值不可選；bounds { w, h } 給了就排除中心在畫布外的；
//      先比優先序（測站 > 鳥群 > 月亮），同優先序取邊緣距離最近，再平手取中心較近。
export function pickTarget(cands, pt, opts = {}) {
  if (!Array.isArray(cands) || !pt || !fin(pt.x) || !fin(pt.y)) return null
  const th = fin(opts.threshold) ? opts.threshold : thresholdFor(opts.pointerType)
  let best = null
  for (const c of cands) {
    if (!c || !fin(c.sx) || !fin(c.sy)) continue
    if (opts.bounds && (c.sx < 0 || c.sy < 0 || c.sx > opts.bounds.w || c.sy > opts.bounds.h)) continue
    const minA = fin(c.minAlpha) ? c.minAlpha : (MIN_ALPHA[c.kind] ?? 0.5)
    if ((fin(c.alpha) ? c.alpha : 1) < minA) continue
    const d = Math.hypot(c.sx - pt.x, c.sy - pt.y)
    const score = Math.max(0, d - (c.r || 0))
    if (score > th) continue
    const pr = fin(c.priority) ? c.priority : (PRIORITY[c.kind] ?? 9)
    if (!best || pr < best.pr || (pr === best.pr && (score < best.score || (score === best.score && d < best.d)))) best = { c, pr, score, d }
  }
  return best ? { ...best.c, dist: best.d } : null
}

// ───────────────────────────── 輕點判定 ─────────────────────────────
// 事件：down({id,x,y,t,type,button,meta}) / move({id,x,y}) / up({id,x,y,t}) → null | { x, y, type, meta, dbl } / cancel(id)。
// 「輕點」＝單指、位移 < maxMove px、按住 < maxMs 毫秒。第二根手指落下 → 兩根都作廢（兩指縮放）；滑鼠非左鍵作廢。
// dbl：距上一次輕點 < dblMs（雙擊的第二下）——呼叫端應忽略它，讓 App 的雙擊切換演出模式照常運作。
export function createTapTracker({ maxMove = 10, maxMs = 450, dblMs = 320 } = {}) {
  const ptrs = new Map()
  let lastTapAt = -Infinity
  return {
    get size() { return ptrs.size },
    down({ id, x, y, t: t0, type = 'mouse', button = 0, meta = null }) {
      const bad = ptrs.size > 0 || (type === 'mouse' && button !== 0)
      if (ptrs.size > 0) for (const p of ptrs.values()) p.bad = true    // 多指：先落下的那根也作廢
      ptrs.set(id, { x0: x, y0: y, t0, type, moved: 0, bad, meta })
    },
    move({ id, x, y }) {
      const p = ptrs.get(id)
      if (p) p.moved = Math.max(p.moved, Math.hypot(x - p.x0, y - p.y0))
    },
    up({ id, x, y, t: t1 }) {
      const p = ptrs.get(id)
      if (!p) return null
      ptrs.delete(id)
      if (fin(x) && fin(y)) p.moved = Math.max(p.moved, Math.hypot(x - p.x0, y - p.y0))
      if (p.bad || p.moved >= maxMove || t1 - p.t0 >= maxMs) return null
      const dbl = t1 - lastTapAt < dblMs
      lastTapAt = t1
      return { x, y, type: p.type, meta: p.meta, dbl }
    },
    cancel(id) { ptrs.delete(id) },
    reset() { ptrs.clear() },
  }
}

// ───────────────────────────── 卡片位置 ─────────────────────────────
export const DOCK_W = 520   // 畫布寬度 ≤ 此值（手機）→ 卡片改停靠在畫布下緣
// (x, y)：物件在畫布內的位置（px）；cw/ch：卡片尺寸；w/h：畫布尺寸。優先放物件右下、放不下就翻到左 / 上、再不行就夾在邊界內。
export function placeCard({ x, y, cw, ch, w, h, margin = 8, gap = 14, dockWidth = DOCK_W }) {
  if (w <= dockWidth) return { dock: true, left: margin, top: Math.max(margin, h - ch - margin), placement: 'dock' }
  let left, top, hp, vp
  if (x + gap + cw + margin <= w) { left = x + gap; hp = 'right' }
  else if (x - gap - cw >= margin) { left = x - gap - cw; hp = 'left' }
  else { left = x - cw / 2; hp = 'center' }
  if (y + gap + ch + margin <= h) { top = y + gap; vp = 'below' }
  else if (y - gap - ch >= margin) { top = y - gap - ch; vp = 'above' }
  else { top = y - ch / 2; vp = 'middle' }
  left = clamp(left, margin, Math.max(margin, w - cw - margin))
  top = clamp(top, margin, Math.max(margin, h - ch - margin))
  return { dock: false, left: Math.round(left), top: Math.round(top), placement: `${hp}-${vp}` }
}

// ───────────────────────────── 播放脈絡 ─────────────────────────────
// 資料播放中，月亮顯示的是「序列的那一天 / 那個時刻」，卡片要跟著（與 MoonSky 同一套算法）。
export function playContext(meta, rec) {
  if (!meta || !meta.active || !rec || rec.mode !== 'playing' || !Array.isArray(meta.points) || !meta.points.length) return null
  const step = meta.step > 0 ? meta.step : 1
  const f = Math.max(0, (rec.playhead || 0) / step)
  const last = meta.points.length - 1
  const i0 = Math.min(last, Math.floor(f))
  if (meta.kind === 'tide') {
    const i1 = Math.min(last, i0 + 1)
    const h0 = meta.points[i0] && meta.points[i0].h, h1 = meta.points[i1] && meta.points[i1].h
    return { kind: 'tide', idx: i0, hour: fin(h0) ? h0 + ((fin(h1) ? h1 : h0) - h0) * (f - Math.floor(f)) : null }
  }
  return { kind: meta.kind, idx: i0 }
}

// ───────────────────────────── 資料（純 JSON，不含翻譯）─────────────────────────────
export function stationData(list, id) {
  const q = Array.isArray(list) ? list[id] : null
  if (!q) return null
  return { kind: 'station', n: String(q.n == null ? '' : q.n), r: q.r ? String(q.r) : '', a: numOrNull(q.a), s: q.s ? 1 : 0 }
}

// 月亮：月亮海況＝CWA 月出月沒（今日 × 現在；資料播放時＝播放到的那天 × 當晚 21:00）；潮汐海況＝月相 + 潮差；其他＝天文公式月相
export function moonData({ gov, opt, now = new Date(), play = null } = {}) {
  const kind = opt && opt.kind
  const m = gov && gov.moon
  if (kind === 'moon' && m && Array.isArray(m.days) && m.days.length) {
    const replay = !!(play && play.kind === 'moon' && m.days[play.idx])
    const idx = replay ? play.idx : m.days.findIndex((d) => d[0] === ymd(now))
    if (idx >= 0) {
      const d = m.days[idx]
      const hour = replay ? 21 : now.getHours() + now.getMinutes() / 60
      const r = moonAltAz(m.days, idx, hour)
      return {
        kind: 'moon', mode: 'real', county: m.county || '', date: d[0], replay,
        rise: d[1] || '', riseAz: numOrNull(d[2]), transit: d[3] || '', alt: numOrNull(d[4]), dir: d[5] || '', set: d[6] || '', setAz: numOrNull(d[7]),
        up: !!r.up, az: Math.round(r.az % 360), elev: Math.round(r.alt), age: moonAge(replay ? dateAtHour(d[0], hour) : now),
      }
    }
    return { kind: 'moon', mode: 'sky', age: moonAge(now), outOfRange: true, from: m.from || '', to: m.to || '', county: m.county || '' }
  }
  if (kind === 'tide' && opt.series) {
    const s = opt.series
    const tp = play && play.kind === 'tide' && fin(play.hour) ? play : null
    const hour = tp ? tp.hour : now.getHours() + now.getMinutes() / 60
    const fromLunar = tp || s.date === ymd(now) ? ageFromLunar(s.lunar, hour) : null
    const age = fromLunar != null ? fromLunar : moonAge(tp ? dateAtHour(s.date, hour) : now)
    return { kind: 'moon', mode: 'tide', name: opt.name || '', date: s.date || '', lunarLabel: s.lunarLabel || '', range: s.range || '', age }
  }
  return { kind: 'moon', mode: 'sky', age: moonAge(now) }
}

// 鳥群：該海況流域的鳥類調查（本月鳥種數 / 調查年範圍 / 由此推算的群數）
export function birdData({ opt, month = null, now = new Date() } = {}) {
  const d = opt && opt.birds
  if (!d) return { kind: 'bird', none: true }
  const mo = month != null ? month : now.getMonth()
  const s = birdSeasonal(d.monthly, mo)
  const ys = Array.isArray(d.yearly) ? d.yearly.map((y) => y && y.y).filter(fin) : []
  return {
    kind: 'bird', basin: d.basin || '', month: mo,
    value: s ? s.value : null, interpolated: !!(s && s.interpolated),
    from: ys.length ? Math.min(...ys) : null, to: ys.length ? Math.max(...ys) : null, years: ys.length,
    flocks: s ? flockCount(d.species, s.rel) : null,
  }
}

// 命中的物件 → 卡片資料（資料選項 / 月份 / 播放狀態由 ctx 提供：{ gov, opt, now, month, play }）
export function buildInspectData(target, ctx = {}) {
  if (!target) return null
  switch (target.kind) {
    case 'station': return stationData(ctx.gov && ctx.gov.stations && ctx.gov.stations.list, target.id)
    case 'moon': return moonData(ctx)
    case 'bird': return birdData(ctx)
    default: return null
  }
}

// ───────────────────────────── 卡片內容（顯示時才翻譯）─────────────────────────────
const fmtArea = (a) => {
  if (!fin(a) || a <= 0) return '—'
  const v = a >= 100 ? Math.round(a) : Math.round(a * 10) / 10
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' km²'
}
const dash = (v) => (v == null || v === '' ? '—' : v)
// 中天：時刻 + 仰角 + 中天在天頂的哪一側（CWA：N＝北側、S＝南側；台灣在北回歸線附近，多半在南方天空）
function transitText(d) {
  if (!d.transit) return '—'
  if (!fin(d.alt)) return d.transit
  const P = { time: d.transit, alt: d.alt }
  if (d.dir === 'N') return t('{time} · 仰角 {alt}°（北方）', P)
  if (d.dir === 'S') return t('{time} · 仰角 {alt}°（南方）', P)
  return t('{time} · 仰角 {alt}°', P)
}

// data → { kind, eyebrow, title, rows: [{k, v}], note?, source? }。讀「當下語系」（元件請 useT() 訂閱語系後呼叫）。對缺欄位寬容。
export function describeInspect(data) {
  if (!data || typeof data !== 'object') return null
  if (data.kind === 'station') {
    return {
      kind: 'station', eyebrow: t('河川流量測站'), title: dash(data.n),
      rows: [
        { k: t('所屬河川'), v: dash(data.r) },
        { k: t('集水面積'), v: fmtArea(data.a) },
        { k: t('狀態'), v: data.s ? t('現存') : t('已廢') },
      ],
      note: t('星星亮度依集水面積（取對數）：現存較亮，已廢較暗'),
      source: t('資料來源：水利署 河川流量測站站況（data.gov.tw 22223）'),
    }
  }
  if (data.kind === 'moon') {
    const age = fin(data.age) ? data.age : 0
    const phase = { k: t('月相'), v: t('{phase} · 月齡 {age} 天', { phase: moonPhaseName(age), age: age.toFixed(1) }) }
    if (data.mode === 'real') {
      const bearing = (time, az) => (!time ? '—' : fin(az) ? t('{time} · 方位 {az}°', { time, az: Math.round(az) }) : time)
      const now = data.up
        ? t('方位 {az}° · 仰角 {alt}°', { az: dash(data.az), alt: dash(data.elev) })
        : (data.replay ? t('在地平線下') : t('現在在地平線下'))
      return {
        kind: 'moon', eyebrow: t('月出月沒 · {county} {date}', { county: nameText(data.county), date: dash(data.date) }), title: t('月亮'),
        rows: [
          { k: t('月出'), v: bearing(data.rise, data.riseAz) },
          { k: t('中天'), v: transitText(data) },
          { k: t('月沒'), v: bearing(data.set, data.setAz) },
          { k: data.replay ? t('當晚 21:00') : t('現在'), v: now },
          phase,
        ],
        source: t('資料來源：氣象署 月出月沒時刻（A-B0063-001）'),
      }
    }
    if (data.mode === 'tide') {
      const rows = [
        { k: t('潮汐'), v: t('{name} {date} · 農曆 {lunar}', { name: nameText(data.name), date: dash(data.date), lunar: lunarDayText(data.lunarLabel) }) },
      ]
      if (data.range) rows.push({ k: t('潮差'), v: tideRangeText(data.range) })
      rows.push(phase)
      return {
        kind: 'moon', eyebrow: t('潮汐與月亮'), title: t('月亮'), rows,
        note: t('潮汐是月亮的引力：背景月亮的盈虧與位置對應當日月齡與時刻'),
        source: t('資料來源：氣象署 潮汐預報（F-A0021-001）；月齡由農曆日期推算'),
      }
    }
    return {
      kind: 'moon', eyebrow: t('月亮'), title: moonPhaseName(age), rows: [phase],
      note: data.outOfRange ? t('月出月沒表 {from} → {to} 不含今日，月相改用天文公式估算', { from: dash(data.from), to: dash(data.to) }) : t('月相以天文公式估算（誤差約 ±0.5 天）'),
    }
  }
  if (data.kind === 'bird') {
    if (data.none) return { kind: 'bird', eyebrow: t('鳥類調查'), title: t('鳥群'), rows: [], note: t('此海況沒有對應的鳥類調查資料') }
    const m = fin(data.month) ? data.month + 1 : 1
    const rows = [{ k: t('流域'), v: nameText(dash(data.basin)) }]
    rows.push({
      k: t('鳥種數'),
      v: data.value == null ? t('尚無資料') : data.interpolated ? t('{m} 月 · {v} 種（內插）', { m, v: data.value }) : t('{m} 月 · {v} 種', { m, v: data.value }),
    })
    rows.push({ k: t('調查年'), v: data.from == null ? '—' : t('{from}–{to}（{n} 個年度）', { from: data.from, to: data.to, n: data.years }) })
    if (data.flocks != null) rows.push({ k: t('推算群數'), v: t('{n} 群', { n: data.flocks }) })
    return {
      kind: 'bird', eyebrow: t('鳥類調查'), title: t('鳥群'), rows,
      note: t('每個月份只涵蓋 1–3 個調查年度，近似單一年份快照；缺月以相鄰月份內插'),
      source: t('資料來源：水利署 河川鳥類調查（data.gov.tw 32720）'),
    }
  }
  return null
}

// ───────────────────────────── 卡片狀態 store ─────────────────────────────
// 狀態：{ open, data, x, y, seq }：x / y 是物件在畫布內的相對位置（0..1，觀眾視窗畫布大小不同也能對上）；seq 每次開卡 +1（同一物件再點也會重新廣播）。
// 自動關：開卡 / 使用者在卡片上操作後 idleMs 無操作就關；游標停在卡片上（hold）暫停計時。
//   idleMs 預設依卡片內容長度算（idleMsFor）：資料出處在卡片「最後一行」，固定 6 秒在觸控裝置（沒有 hover 可暫停）根本讀不到那一行——
//   一張測站卡英文約 9–15 秒、中文約 13–19 秒才讀得完。傳入數字則固定（測試用）。
// 觀眾視窗：applyMirror 只設定狀態；為了主視窗斷線時卡片不會卡住，另有 failsafeMs 的保險計時（必須比任何卡片的停留時間都長，否則觀眾視窗會比主視窗早關）。
export const IDLE_MS = 6000          // 最短停留（很短的卡片也至少這麼久）
export const IDLE_MAX_MS = 25000     // 最長停留
export const FAILSAFE_MS = 30000     // > IDLE_MAX_MS
const CJK = /[㐀-鿿豈-﫿]/g

// 依「當下語系」的卡片文字長度估閱讀時間：3 秒起跳 + 每個中文字 0.16 秒 + 每個英文單字 0.28 秒，夾在 [IDLE_MS, IDLE_MAX_MS]
export function idleMsFor(data) {
  let view = null
  try { view = describeInspect(data) } catch (e) { view = null }
  if (!view) return IDLE_MS
  const text = [view.eyebrow, view.title, ...(view.rows || []).flatMap((r) => [r.k, r.v]), view.note, view.source].filter(Boolean).join(' ')
  const cjk = (text.match(CJK) || []).length
  const words = text.replace(CJK, ' ').split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length
  return clamp(Math.round(3000 + cjk * 160 + words * 280), IDLE_MS, IDLE_MAX_MS)
}

export function sanitizeInspectState(v) {
  if (!v || typeof v !== 'object') return null
  const data = v.data && typeof v.data === 'object' && KINDS.includes(v.data.kind) ? v.data : null
  const open = v.open === true && !!data
  return { open, data: open ? data : null, x: clamp01(fin(v.x) ? v.x : 0.5), y: clamp01(fin(v.y) ? v.y : 0.5), seq: fin(v.seq) ? Math.max(0, Math.floor(v.seq)) : 0 }
}

export function createInspectStore({ setTimeoutFn = (f, ms) => setTimeout(f, ms), clearTimeoutFn = (id) => clearTimeout(id), idleMs = null, failsafeMs = FAILSAFE_MS } = {}) {
  let state = { open: false, data: null, x: 0.5, y: 0.5, seq: 0 }
  const subs = new Set()
  const idle = () => (typeof idleMs === 'number' ? idleMs : idleMsFor(state.data))   // 數字 = 固定；否則依卡片內容
  let timer = null, held = false
  const emit = () => subs.forEach((f) => { try { f() } catch (e) { /* 訂閱者出錯不影響其他人 */ } })
  const stop = () => { if (timer != null) { clearTimeoutFn(timer); timer = null } }
  const arm = (ms) => { stop(); if (state.open && !held) timer = setTimeoutFn(() => { timer = null; api.close() }, ms) }
  const api = {
    get: () => state,                                            // 狀態沒變時參考不變（useSyncExternalStore 相容）
    subscribe(f) { subs.add(f); return () => subs.delete(f) },
    open(data, pos = {}) {
      if (!data || !KINDS.includes(data.kind)) return false
      state = { open: true, data, x: clamp01(fin(pos.x) ? pos.x : 0.5), y: clamp01(fin(pos.y) ? pos.y : 0.5), seq: state.seq + 1 }
      held = false                                               // 舊卡片被移除時 pointerleave 不一定會來：新卡片一律重新計時
      emit(); arm(idle())
      return true
    },
    close() {
      stop(); held = false
      if (!state.open) return
      state = { ...state, open: false, data: null }
      emit()
    },
    touch() { arm(idle()) },                                     // 使用者在卡片上操作 → 重新計時
    hold(on) { held = !!on; if (held) stop(); else arm(idle()) },  // 游標停在卡片上：不自動關
    applyMirror(v) {                                             // 觀眾視窗：套用主視窗送來的狀態
      const s = sanitizeInspectState(v)
      if (!s) return
      state = s
      emit(); arm(failsafeMs)
    },
    dispose() { stop(); subs.clear() },
  }
  return api
}

export const inspectStore = createInspectStore()   // 主視窗 / 觀眾視窗各自一份（同一份程式）
