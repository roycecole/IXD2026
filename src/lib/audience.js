// 觀眾視窗（雙螢幕）：傳輸協定與純邏輯。
// 展場情境：筆電上的「主視窗」（host，控制台）操作，投影機上的「觀眾視窗」（audience）全螢幕顯示同一片海。
// 本檔不碰任何瀏覽器全域（BroadcastChannel / window / timers 全部以參數注入），所以可在 Node 用假 channel 測。
//
// ── 傳輸：BroadcastChannel('midisea-audience')（同源兩視窗）。所有訊息帶版本號 v:1，版本不符一律忽略。
//   audience → host   { v, type:'hello', id, host? }      我上線 / 我要完整狀態（host? = 我鎖定的主視窗；沒有 = 誰都可以回我）
//   host → audience   { v, type:'snapshot', host, slices }  完整狀態（對 hello 的回應；觀眾視窗中途載入、主視窗重整後都靠它自我修復）
//   host → audience   { v, type:'slice', host, key, value } 增量（某個切片變了）
//   host → audience   { v, type:'ping', host, n }          周期探測（主視窗藉此知道有幾個觀眾視窗還活著）
//   audience → host   { v, type:'pong', id, host }
//   audience → host   { v, type:'bye', id, host? }          觀眾視窗關閉
//   host → audience   { v, type:'close', host }             請觀眾視窗自己關掉（window.close，僅腳本開啟的視窗有效）
//   BroadcastChannel 是「廣播」：host 的訊息所有觀眾都收得到（一次送出即可服務多個觀眾視窗）；觀眾的訊息其他觀眾也收得到，
//   所以每個接收端都要依 type / host 欄位過濾。
//
// ── 同步內容：以 lib/mirror.js 的「鏡像切片」註冊表實作。切片 { get, apply, subscribe?, hz? }，本檔額外認得兩個選用欄位：
//     dedupe:false   事件型切片（每次都要送，例如打擊墊事件）——不做「內容相同就不送」
//     snapshot:false 事件型切片不放進完整快照（事件是一次性的，不該在新觀眾連上時補放）
//   get() 回傳 undefined ＝ 這次沒有東西要送。apply(value, meta) 的 meta.snapshot 為 true 表示這是完整快照（不是增量）。
//   核心切片（createCoreSlices）：locale / overlays / gov / params / series / rec / spawns / pad；
//   其他功能自己 registerMirror 的切片（導覽字幕、點物件卡片…）對本檔是「任意切片」——host 每次探測都會重新掃描註冊表，晚註冊的也會被接上。
//
// ── 成本：host 平時只掛一個 channel 監聽（零計時器、零訂閱）；第一個觀眾 hello 之後才啟動切片訂閱與 ping 計時，最後一個觀眾離開就全部收掉。

export const AUDIENCE_CHANNEL = 'midisea-audience'
export const AUDIENCE_NAME = 'midisea-audience'   // window.open 的視窗名（同名視窗會被重用）
export const PROTO_V = 1
export const PING_MS = 2000            // host 每 2 秒 ping 一次
export const MAX_MISSED = 3            // 連續 3 次 ping 沒回 → 判定斷線
export const HELLO_MS = 1000           // 觀眾視窗：尚未同步 / 疑似斷線時，每秒喊一次 hello
export const PROBE_AFTER_MS = 3000     // 觀眾視窗：主視窗安靜超過 3 秒 → 解除鎖定並重新 hello（主視窗可能重整了）
export const HOST_LOST_MS = 5000       // 觀眾視窗：主視窗安靜超過 5 秒 → 顯示「等待主視窗…」
export const DEFAULT_HZ = 10           // 切片預設最高廣播頻率
export const MAX_AUDIENCES = 16

const nowDefault = () => { try { return performance.now() } catch (e) { return Date.now() } }
const isObj = (v) => v !== null && typeof v === 'object'
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

export function newId(prefix = 'x') {
  return prefix + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4)
}
// 是不是本協定的訊息（物件、v 相符、有 type）。版本不符 → false（呼叫端直接忽略）。
export function isMsg(m) { return isObj(m) && m.v === PROTO_V && typeof m.type === 'string' }
const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 64

// ───────────────────────────── 狀態小倉庫（host 狀態給「裝置」面板訂閱；useSyncExternalStore 相容）─────────────────────────────
export function createStatusStore(initial) {
  let state = initial
  const subs = new Set()
  return {
    get: () => state,
    set(patch) {
      const next = { ...state, ...patch }
      if (Object.keys(next).every((k) => next[k] === state[k])) return
      state = next
      subs.forEach((f) => { try { f() } catch (e) { /* 訂閱者出錯不影響其他人 */ } })
    },
    subscribe(f) { subs.add(f); return () => subs.delete(f) },
  }
}
export const hostStatus = createStatusStore({ count: 0, active: false })   // count：連著的觀眾視窗數
export const hostControl = { closeAll: null }                               // 由 AudienceService 掛上（面板的「關閉觀眾視窗」用）

// ───────────────────────────── host：主視窗端 ─────────────────────────────
// opts: { channel, listSlices(): [[key, slice]…], now?, timers?, hostId?, pingMs?, maxMissed?, onChange?({count,active}) }
export function createHost(opts) {
  const ch = opts.channel
  const listSlices = opts.listSlices || (() => [])
  const now = opts.now || nowDefault
  const T = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, ...(opts.timers || {}) }
  const hostId = opts.hostId || newId('h')
  const pingMs = opts.pingMs || PING_MS
  const maxMissed = opts.maxMissed || MAX_MISSED
  const audiences = new Map()   // id → { awaiting }：已送出但還沒收到 pong 的 ping 次數
  const subs = new Map()        // key → entry（只在有觀眾時存在）
  let active = false, pingIv = null, seq = 0, destroyed = false

  const emit = () => { try { opts.onChange && opts.onChange({ count: audiences.size, active }) } catch (e) { /* ignore */ } }
  const post = (m) => { try { ch.postMessage({ v: PROTO_V, host: hostId, ...m }) } catch (e) { /* channel 已關 / 值不可序列化 */ } }
  const gapOf = (slice) => 1000 / clamp(num(slice.hz, DEFAULT_HZ) || DEFAULT_HZ, 0.5, 60)

  // 評估一個切片：get → （去重）→ 廣播。lastAt 記「評估時間」，所以連續變動也不會超過 slice.hz
  function flush(e) {
    if (e.timer) { T.clearTimeout(e.timer); e.timer = null }
    if (!active) return
    e.lastAt = now()
    let value
    try { value = e.slice.get() } catch (err) { return }
    if (value === undefined) return
    if (e.slice.dedupe !== false) {
      let str
      try { str = JSON.stringify(value) } catch (err) { return }
      if (str === e.lastStr) return
      e.lastStr = str
    }
    post({ type: 'slice', key: e.key, value })
  }
  // 節流：距上次評估夠久 → 立刻送（領先緣，操作零延遲）；否則排一個尾端計時器補送「最新值」
  function notify(e) {
    if (!active || e.timer) return
    const gap = gapOf(e.slice), dt = now() - e.lastAt
    if (dt >= gap) flush(e)
    else e.timer = T.setTimeout(() => { e.timer = null; flush(e) }, Math.max(1, gap - dt))
  }

  function attach(key, slice) {
    const e = { key, slice, unsub: null, lastStr: undefined, lastAt: -Infinity, timer: null, poll: null }
    subs.set(key, e)
    if (typeof slice.subscribe === 'function') {
      try { const u = slice.subscribe(() => notify(e)); if (typeof u === 'function') e.unsub = u } catch (err) { /* 壞切片不拖垮別人 */ }
    } else {
      e.poll = T.setInterval(() => notify(e), gapOf(slice))   // 沒有 subscribe 的切片：以 hz 輪詢 get()（有去重，沒變不送）
    }
    return e
  }
  function detach(e) {
    if (e.unsub) { try { e.unsub() } catch (err) { /* ignore */ } e.unsub = null }
    if (e.timer) { T.clearTimeout(e.timer); e.timer = null }
    if (e.poll) { T.clearInterval(e.poll); e.poll = null }
    subs.delete(e.key)
  }
  // 對齊註冊表：新增的接上、移除 / 被換掉的拆掉。sendNew：新接上的切片立刻送一次目前值（晚註冊的切片也能同步）
  function refresh(sendNew) {
    let cur
    try { cur = new Map(listSlices()) } catch (err) { return }
    for (const e of [...subs.values()]) if (cur.get(e.key) !== e.slice) detach(e)
    for (const [key, slice] of cur) {
      if (subs.has(key) || !slice || typeof slice.get !== 'function') continue
      const e = attach(key, slice)
      if (sendNew && slice.snapshot !== false) flush(e)
    }
  }
  function snapshot() {
    const slices = {}
    for (const [key, e] of subs) {
      if (e.slice.snapshot === false) continue
      let v
      try { v = e.slice.get() } catch (err) { continue }
      if (v === undefined) continue
      slices[key] = v
      if (e.slice.dedupe !== false) { try { e.lastStr = JSON.stringify(v) } catch (err) { /* ignore */ } }
    }
    post({ type: 'snapshot', slices })
  }

  function activate() {
    if (active) return
    active = true
    refresh(false)
    pingIv = T.setInterval(tick, pingMs)
  }
  function deactivate() {
    if (!active) return
    active = false
    for (const e of [...subs.values()]) detach(e)
    if (pingIv != null) { T.clearInterval(pingIv); pingIv = null }
  }
  // 周期：先踢掉「連續 maxMissed 次 ping 沒回」的觀眾，再掃描註冊表、ping。
  // 用「未回覆次數」而非牆鐘時間判斷——背景分頁的計時器被瀏覽器降頻時，也不會把還活著的觀眾誤踢。
  function tick() {
    let dropped = false
    for (const [id, a] of [...audiences]) if (a.awaiting >= maxMissed) { audiences.delete(id); dropped = true }
    if (dropped) emit()
    if (!audiences.size) { deactivate(); emit(); return }
    refresh(true)
    post({ type: 'ping', n: ++seq })
    for (const a of audiences.values()) a.awaiting++
  }
  function register(id) {
    const a = audiences.get(id)
    if (a) { a.awaiting = 0; return true }
    if (audiences.size >= MAX_AUDIENCES) return false
    audiences.set(id, { awaiting: 0 })
    if (audiences.size === 1) activate()
    emit()
    return true
  }
  function onMessage(ev) {
    const m = ev && ev.data
    if (destroyed || !isMsg(m)) return
    if (m.host && m.host !== hostId) return   // 這個訊息是給別的主視窗的（例如開了兩個控制台分頁）
    if (!validId(m.id)) return                // 只處理觀眾端訊息（host 自己的 / 別的 host 的訊息沒有 id）
    if (m.type === 'hello') { if (register(m.id)) snapshot() }
    else if (m.type === 'pong') { if (audiences.has(m.id)) audiences.get(m.id).awaiting = 0; else if (register(m.id)) snapshot() }
    else if (m.type === 'bye') { if (audiences.delete(m.id)) { if (!audiences.size) deactivate(); emit() } }
  }

  ch.onmessage = onMessage
  return {
    hostId,
    count: () => audiences.size,
    isActive: () => active,
    closeAudiences: () => post({ type: 'close' }),   // 不論 host 認不認得那些視窗，都廣播一次
    refresh: () => { if (active) refresh(true) },
    destroy() {
      if (destroyed) return
      destroyed = true
      deactivate()
      audiences.clear()
      try { ch.onmessage = null; ch.close() } catch (e) { /* ignore */ }
      emit()
    },
  }
}

// ───────────────────────────── audience：觀眾視窗端 ─────────────────────────────
// opts: { channel, apply(key, value, meta), id?, now?, timers?, onStatus?({state,synced,hostId}), onClose?, helloMs?, probeAfterMs?, hostLostMs? }
// state：'waiting'（還沒收到第一個快照）→ 'live'（同步中）→ 'lost'（主視窗安靜超過 hostLostMs）→ 收到新快照又回 'live'
export function createAudience(opts) {
  const ch = opts.channel
  const now = opts.now || nowDefault
  const T = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, ...(opts.timers || {}) }
  const id = opts.id || newId('a')
  const helloMs = opts.helloMs || HELLO_MS
  const probeAfterMs = opts.probeAfterMs || PROBE_AFTER_MS
  const hostLostMs = opts.hostLostMs || HOST_LOST_MS
  let state = 'waiting', hostId = null, lastAt = now(), synced = false, iv = null, stopped = false

  const status = () => ({ state, synced, hostId })
  const setState = (s) => { if (state !== s) { state = s; try { opts.onStatus && opts.onStatus(status()) } catch (e) { /* ignore */ } } }
  const post = (m) => { try { ch.postMessage({ v: PROTO_V, id, ...(hostId ? { host: hostId } : {}), ...m }) } catch (e) { /* ignore */ } }
  const applyOne = (key, value, meta) => { try { opts.apply(key, value, meta) } catch (e) { /* 一個切片壞掉不影響其他切片 */ } }

  function onMessage(ev) {
    const m = ev && ev.data
    if (stopped || !isMsg(m) || typeof m.host !== 'string' || !m.host) return   // 觀眾之間互傳的 hello / bye 沒有 host 或不是主視窗類型 → 忽略
    if (m.type === 'snapshot') {
      if (hostId && m.host !== hostId) return                 // 已鎖定另一個主視窗 → 忽略
      hostId = m.host; lastAt = now()
      if (isObj(m.slices)) for (const key of Object.keys(m.slices)) applyOne(key, m.slices[key], { snapshot: true })
      synced = true
      setState('live')
    } else if (m.type === 'slice') {
      if (!synced || !hostId || m.host !== hostId || typeof m.key !== 'string') return
      lastAt = now()
      applyOne(m.key, m.value, { snapshot: false })
      setState('live')
    } else if (m.type === 'ping') {
      if (!synced || !hostId || m.host !== hostId) return
      lastAt = now()
      post({ type: 'pong' })
      setState('live')
    } else if (m.type === 'close') {
      if (hostId && m.host !== hostId) return
      try { opts.onClose && opts.onClose() } catch (e) { /* ignore */ }
    }
  }
  function tick() {
    if (stopped) return
    const idle = now() - lastAt
    if (!synced) { post({ type: 'hello' }); return }          // 還沒同步：每秒喊一次（主視窗可能還沒載入完）
    if (idle > probeAfterMs) { hostId = null; post({ type: 'hello' }) }   // 主視窗安靜太久（可能重整了）：解除鎖定重新要快照
    if (idle > hostLostMs) setState('lost')
  }

  return {
    id,
    getStatus: status,
    start() {
      if (iv != null || stopped) return
      ch.onmessage = onMessage
      lastAt = now()
      post({ type: 'hello' })
      iv = T.setInterval(tick, helloMs)
    },
    stop() {
      if (stopped) return
      post({ type: 'bye' })
      stopped = true
      if (iv != null) { T.clearInterval(iv); iv = null }
      try { ch.onmessage = null; ch.close() } catch (e) { /* ignore */ }
    },
  }
}

// ───────────────────────────── 核心切片（把 store 的狀態接到鏡像註冊表）─────────────────────────────
// deps: { store: zustand（getState / setState / subscribe）, seriesMeta, purifyMeta?, padEvents?, locale: { get, set, subscribe } }
// 回傳 [[key, slice], …]，順序即完整快照的套用順序（series 在 rec 之前：播放中的資料先到位，HUD 才有東西可畫）。
const SERIES_EMPTY = { active: false, kind: '', name: '', label: '', unit: '', date: '', step: 1.1, points: [], target: '', extra: {}, lunar: '', lunarLabel: '', range: '', events: [] }
const COUNT_KEYS = ['whale', 'dolphin', 'turtle', 'purify']
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
// 打擊墊事件裡「純視覺」的那幾種（漣漪 / 氣泡 / 亮星 / 閃光 / 衝刺 / 三漣 / 星雨 / 大浪）才走 pad 切片；
// 5 海豚 6 鯨魚 7 海龜 8 淨化 9 垃圾 10 洋流轉向 的效果會經由 spawns / params 切片同步，再送一次觀眾端會重複生成。
export const PAD_MIRROR = new Set([0, 1, 2, 3, 4, 11, 12, 13, 14, 15])
const PAD_OUTBOX_MAX = 64

// 包住 arr.push：每次 push 先通知 fn(items)，再照常 push。回傳還原函式（只有自己還是最外層包裝時才還原，否則轉為直通）。
export function tapPush(arr, fn) {
  const had = Object.prototype.hasOwnProperty.call(arr, 'push')
  const orig = arr.push
  let on = true
  const wrapper = function (...items) {
    if (on) { try { fn(items) } catch (e) { /* 鏡像失敗不影響原本行為 */ } }
    return orig.apply(this, items)
  }
  arr.push = wrapper
  return () => {
    on = false
    if (arr.push === wrapper) { if (had) arr.push = orig; else delete arr.push }
  }
}

export function createCoreSlices(deps) {
  const { store, seriesMeta, purifyMeta, padEvents, locale } = deps
  const out = []
  const watch = (pick) => (cb) => store.subscribe((s, p) => { if (pick(s, p)) cb() })

  out.push(['locale', {
    hz: 5,
    get: () => locale.get(),
    apply: (v) => { if (v === 'zh' || v === 'en') locale.set(v) },
    subscribe: locale.subscribe,
  }])

  out.push(['overlays', {
    hz: 5,
    get: () => { const o = store.getState().overlays || {}; return { board: !!o.board, hud: !!o.hud, qr: !!o.qr } },
    apply: (v) => { if (isObj(v)) store.setState({ overlays: { board: !!v.board, hud: !!v.hud, qr: !!v.qr } }) },   // 直接 setState：不走 setOverlay（它會寫 localStorage，兩個視窗共用同一份偏好）
    subscribe: watch((s, p) => s.overlays !== p.overlays),
  }])

  out.push(['gov', {   // 只同步「選了哪個海況選項 / 哪個月份」；資料本身由觀眾視窗自己載入 ocean.json，也不 applyGov（參數由 params 切片決定）
    hz: 5,
    get: () => { const s = store.getState(); return { id: s.govOptionId == null ? null : s.govOptionId, month: s.surveyMonth == null ? null : s.surveyMonth } },
    apply: (v) => {
      if (!isObj(v)) return
      const patch = {}
      if (typeof v.id === 'string' && v.id) patch.govOptionId = v.id
      if (v.month === null || (Number.isInteger(v.month) && v.month >= 0 && v.month <= 11)) patch.surveyMonth = v.month
      if (Object.keys(patch).length) store.setState(patch)
    },
    subscribe: watch((s, p) => s.govOptionId !== p.govOptionId || s.surveyMonth !== p.surveyMonth),
  }])

  out.push(['params', {   // 視覺參數：走 applyParams（不走 input()：否則會寫進錄製、觸發 soft-takeover、閃 HUD）
    hz: 30,
    get: () => store.getState().params,
    apply: (v) => { if (isObj(v)) store.getState().applyParams(v) },
    subscribe: watch((s, p) => s.params !== p.params),
  }])

  out.push(['series', {   // 資料播放的內容（seriesMeta 是模組層可變物件，不會觸發 store 訂閱 → 以 rec 的模式 / 長度變化當時機）
    hz: 10,
    get: () => (seriesMeta.active ? { ...seriesMeta } : { active: false }),
    apply: (v) => {
      if (!isObj(v)) return
      if (!v.active || !Array.isArray(v.points)) { seriesMeta.active = false; return }
      for (const k of Object.keys(SERIES_EMPTY)) {
        const d = SERIES_EMPTY[k]
        seriesMeta[k] = k in v ? v[k] : Array.isArray(d) ? [] : isObj(d) ? {} : d   // 缺的欄位還原成空值（陣列 / 物件不共用同一個參考）
      }
      for (const k of Object.keys(v)) if (!(k in SERIES_EMPTY) && !UNSAFE_KEYS.has(k)) seriesMeta[k] = v[k]   // 之後 seriesMeta 新增的欄位也照單全收（get 送的是整份）
      seriesMeta.active = true
    },
    subscribe: watch((s, p) => s.rec.mode !== p.rec.mode || s.rec.duration !== p.rec.duration || s.rec.count !== p.rec.count),
  }])

  out.push(['rec', {   // 播放狀態：觀眾端只「顯示」（DataHUD / 場景讀 playhead），不驅動——不跑 tickPlayback
    hz: 30,               // 潮汐 / 月亮場景用 playhead 做小數內插；30Hz 夠平滑，每則訊息只有一百多 byte
    get: () => {
      const r = store.getState().rec || {}
      const playing = r.mode === 'playing'
      return { mode: r.mode, playhead: playing ? Math.round(num(r.playhead) * 1000) / 1000 : 0, speed: num(r.speed, 1), loop: !!r.loop, duration: num(r.duration) }   // 錄製中 playhead 每幀都變、觀眾端用不到 → 固定為 0 讓去重生效
    },
    apply: (v) => {
      if (!isObj(v)) return
      const mode = v.mode === 'playing' || v.mode === 'recording' ? v.mode : 'idle'
      store.setState((s) => ({ rec: { ...s.rec, mode, playhead: num(v.playhead), speed: num(v.speed, 1) || 1, loop: !!v.loop, duration: num(v.duration) } }))
    },
    subscribe: watch((s, p) => s.rec !== p.rec),
  }])

  {   // 觸發計數（鯨 / 豚 / 龜 / 淨化波）：場景以「計數增加」偵測事件。觀眾端只加「增量」，快照只當基準——中途連上不會補放過去的訪客。
    let base = null
    const pick = (v) => { const o = {}; for (const k of COUNT_KEYS) o[k] = num(v && v[k]); return o }
    out.push(['spawns', {
      hz: 20,
      get: () => { const c = pick(store.getState().spawns); c.pv = purifyMeta ? num(purifyMeta.v, 1) : 1; return c },
      apply: (v, meta) => {
        if (!isObj(v)) return
        const cur = pick(v)
        if (!base || (meta && meta.snapshot)) { base = cur; return }
        const s0 = store.getState().spawns || {}
        const next = { ...s0 }
        let any = false
        for (const k of COUNT_KEYS) { const d = cur[k] - base[k]; if (d > 0) { next[k] = num(s0[k]) + d; any = true } }   // d<0：主視窗重整過（計數歸零）→ 只重設基準
        base = cur
        if (purifyMeta && typeof v.pv === 'number') purifyMeta.v = clamp(v.pv, 0.2, 1)
        if (any) store.setState({ spawns: next })
      },
      subscribe: watch((s, p) => s.spawns !== p.spawns),
    }])
  }

  if (Array.isArray(padEvents)) {   // 打擊墊事件（一次性事件流）：包住 padEvents.push 收集純視覺事件，觀眾端原樣 push 回自己的佇列
    const outbox = []
    out.push(['pad', {
      hz: 30, dedupe: false, snapshot: false,
      get: () => (outbox.length ? outbox.splice(0, outbox.length) : undefined),
      apply: (v) => {
        if (!Array.isArray(v)) return
        for (const e of v.slice(0, PAD_OUTBOX_MAX)) {
          if (!isObj(e) || !Number.isFinite(e.ev)) continue
          padEvents.push({ ev: ((Math.trunc(e.ev) % 16) + 16) % 16, bank: clamp(Math.trunc(num(e.bank)), 0, 3), vel: clamp(num(e.vel, 0.7), 0, 1) })
          if (padEvents.length > 40) padEvents.shift()
        }
      },
      subscribe: (cb) => tapPush(padEvents, (items) => {
        let n = 0
        for (const e of items) {
          if (!isObj(e) || !Number.isFinite(e.ev) || !PAD_MIRROR.has(((Math.trunc(e.ev) % 16) + 16) % 16)) continue
          outbox.push({ ev: Math.trunc(e.ev), bank: Math.trunc(num(e.bank)), vel: Math.round(num(e.vel, 0.7) * 1000) / 1000 })
          n++
        }
        if (outbox.length > PAD_OUTBOX_MAX) outbox.splice(0, outbox.length - PAD_OUTBOX_MAX)
        if (n) cb()
      }),
    }])
  }
  return out
}

// 觀眾視窗載入 ocean.json 之後，決定用哪個海況選項：主視窗已經送來的 id 優先（找得到才算），否則用資料的預設。
export function pickGovOptionId(gov, wantedId) {
  const opts = gov && Array.isArray(gov.options) ? gov.options : []
  if (wantedId && opts.some((o) => o && o.id === wantedId)) return wantedId
  return (gov && (gov.defaultOption || (opts[0] && opts[0].id))) || null
}

// ───────────────────────────── 開視窗 / 螢幕偵測（純邏輯；window 以參數注入）─────────────────────────────
export function buildAudienceUrl(loc) {
  const l = loc || {}
  return `${l.origin || ''}${l.pathname || '/'}?audience=1`
}

const sameScreen = (a, b) => a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height)

// 從 getScreenDetails() 的結果挑「放觀眾視窗的螢幕」：不是目前這個視窗所在的螢幕；優先外接（isInternal===false），再來非主要螢幕。
export function pickAudienceScreen(details) {
  const screens = details && Array.isArray(details.screens) ? details.screens : []
  if (screens.length < 2) return null
  const others = screens.filter((s) => !sameScreen(s, details.currentScreen))
  if (!others.length) return null
  return others.find((s) => s.isInternal === false) || others.find((s) => !s.isPrimary) || others[0]
}

// window.open 的 features：有指定螢幕 → 放在該螢幕的可用區域；否則一般彈出視窗尺寸
export function popupFeatures(screen) {
  if (!screen) return 'popup,width=1280,height=720'
  const r = (v) => Math.round(num(v))
  const left = screen.availLeft != null ? screen.availLeft : screen.left
  const top = screen.availTop != null ? screen.availTop : screen.top
  const width = screen.availWidth != null ? screen.availWidth : screen.width
  const height = screen.availHeight != null ? screen.availHeight : screen.height
  return `popup,left=${r(left)},top=${r(top)},width=${Math.max(320, r(width))},height=${Math.max(240, r(height))}`
}

// 請求螢幕資訊（可能跳出權限提示——必須在使用者手勢內呼叫）。回傳 { details, reason }：
// reason：null（成功）| 'unsupported'（沒有 getScreenDetails：Safari / Firefox / 非安全來源）| 'denied'（使用者拒絕）| 'error'
export async function requestScreens(win) {
  if (!win || typeof win.getScreenDetails !== 'function') return { details: null, reason: 'unsupported' }
  try {
    const details = await win.getScreenDetails()
    return { details, reason: null }
  } catch (e) {
    return { details: null, reason: e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'denied' : 'error' }
  }
}

// 依 requestScreens 的結果決定怎麼開：placed（放到外接螢幕）| unsupported / denied / error / single（只有一個螢幕）→ 一般視窗 + 手動拖曳提示
export function planAudienceOpen(res) {
  const details = res && res.details
  if (!details) return { placed: false, reason: (res && res.reason) || 'unsupported', features: popupFeatures(null), screens: null }
  const screens = Array.isArray(details.screens) ? details.screens.length : 0
  const screen = pickAudienceScreen(details)
  if (!screen) return { placed: false, reason: 'single', features: popupFeatures(null), screens }
  return { placed: true, reason: null, screen, features: popupFeatures(screen), screens }
}

// 視窗管理權限狀態（Chrome 新名 window-management，舊名 window-placement）：'granted' | 'prompt' | 'denied' | 'unknown'
export async function queryWindowPermission(win) {
  const perms = win && win.navigator && win.navigator.permissions
  if (!perms || typeof perms.query !== 'function') return 'unknown'
  for (const name of ['window-management', 'window-placement']) {
    try { const r = await perms.query({ name }); if (r && r.state) return r.state } catch (e) { /* 這個名稱不支援 → 試下一個 */ }
  }
  return 'unknown'
}

// 偵測螢幕數量給「裝置」面板顯示（不會跳權限提示）：
//   已授權 → 精確數量（screens.length）；否則用 screen.isExtended（Chrome，免權限）只能知道「是不是多螢幕」。
export async function readScreenInfo(win) {
  const info = { count: null, extended: null, canPlace: !!win && typeof win.getScreenDetails === 'function', permission: 'unknown' }
  try { if (win && win.screen && typeof win.screen.isExtended === 'boolean') info.extended = win.screen.isExtended } catch (e) { /* ignore */ }
  if (!info.canPlace) return info
  info.permission = await queryWindowPermission(win)
  if (info.permission === 'granted') {
    try { const d = await win.getScreenDetails(); if (d && Array.isArray(d.screens)) { info.count = d.screens.length; info.extended = d.screens.length > 1 } } catch (e) { /* ignore */ }
  }
  return info
}
