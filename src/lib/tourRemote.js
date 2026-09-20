// 導覽員遙控（手機當導覽員遙控器）：協定訊息 + 遙控頁的檢視模型 + 主畫面（host）端的導覽員邏輯。
// 純函式 / 可注入依賴：不含 PeerJS、React、store、tour.js——Node 可用「會檢查 this 的假連線 / 假計時器 / 假 runner」測試；
// 手機遙控頁（#remote=）也會 import 本檔，所以必須保持輕量（沒有任何 import）。
//
// 協定（契約 C8）：
//   遙控頁 → host   { t:'hello', guide: token }                      連線 open 後送一次（網址 #remote=<id>&guide=<token> 帶來的 token）
//                   { t:'g', c:'next'|'prev'|'pause'|'resume'|'toggle'|'start'|'stop'|'goto'|'speak', i?, v? }
//   host → 遙控頁   { t:'guide', ok:true|false }                     hello 的回覆；ok:false 時該連線仍是一般遙控
//                   { t:'tour', running, paused, index, total, stops:[{ id, note? }], speak?, canSpeak?, ready? }
//                                                                    導覽狀態（狀態變化即推、每 2 秒補一次）。speak / canSpeak / ready 是選用的附加欄位
//                                                                    （旁白偏好 / 這台有沒有語音合成 / 主畫面海況資料是否已載入，遙控頁據此顯示「開始導覽」是否可按）。
// 安全：導覽員權限只授予「操控導覽」。token 由 host 每個 session 隨機產生（存記憶體），驗證相符的連線才收導覽員指令；
//   一般遙控連線送來的導覽員指令一律靜默忽略；驗證失敗次數過多的連線會被關閉（擋暴力猜測）。
//   導覽員指令呼叫 touchGuide()（只記時間、不中止導覽）與 noteActivity()（遙控「有人在」），絕不呼叫 touch()（否則導覽會把它當成輸入而自己中止）。

// ---------------------------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------------------------
// 站 id 白名單（與 lib/tourLink.js 的 TOUR_STOP_IDS、lib/tour.js buildTour 的順序一致；測試會核對沒有走樣）。遙控頁只拿站 id，站名由它自己依語系顯示。
export const GUIDE_STOP_IDS = ['reservoir', 'tide', 'moon', 'dust', 'air', 'birds', 'fish', 'stations']
export const GUIDE_STOP_OTHER = 'other'            // 不在白名單的站 id（未來新增的站）：保留位置（goto 的 index 才不會位移），遙控頁只顯示「第 n 站」
export const GUIDE_CMDS = ['next', 'prev', 'pause', 'resume', 'toggle', 'start', 'stop', 'goto', 'speak']
export const GUIDE_NOTE_MAX = 120                  // 每站備註的字數上限
export const GUIDE_MAX_STOPS = 32                  // 站數上限（防止異常訊息撐大狀態）
export const GUIDE_MIN_GAP_MS = 150                // 同一連線、同一指令的最短間隔：手機連點 / 網路重送不會造成連續跳站
export const GUIDE_PUSH_MS = 2000                  // 狀態補推的間隔（丟包保險）
export const GUIDE_HELLO_WAIT_MS = 6000            // 遙控頁送出 hello 後等回覆的時間：逾時就當作沒有導覽員權限（例如主畫面是舊版）
export const GUIDE_MAX_BAD_HELLO = 5               // 同一連線驗證失敗達這麼多次 → 關閉連線
export const GUIDE_TOKEN_LEN = 10                  // 10 碼 base36 ≈ 5e15 種
export const GUIDE_QR_MS = 60000                   // 展場 QR：按 G 顯示導覽員 QR 多久後自動換回一般 QR
const TOKEN_RE = /^[0-9a-z]{6,32}$/

const noop = () => {}
const isObj = (m) => !!m && typeof m === 'object' && !Array.isArray(m)
const clampInt = (v, hi) => (Number.isFinite(v) ? Math.max(0, Math.min(hi, Math.trunc(v))) : 0)
const clip = (s, n) => { const a = Array.from(String(s)); return a.length > n ? a.slice(0, n).join('') : String(s) }   // 以字元（非 UTF-16 單元）為單位，不切斷代理對

// ---------------------------------------------------------------------------------------------
// token
// ---------------------------------------------------------------------------------------------
export const isGuideToken = (s) => typeof s === 'string' && TOKEN_RE.test(s)

// 隨機 token（base36）。rng(Uint8Array) 可注入（測試）；預設 crypto.getRandomValues（在呼叫當下才讀全域）。拒絕取樣（b < 252）避免取模偏差。
// 沒有安全亂數來源 → 回傳 ''（導覽員功能停用），絕不退回 Math.random。
export function makeGuideToken(rng) {
  try {
    const fill = typeof rng === 'function' ? rng
      : (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function' ? (a) => globalThis.crypto.getRandomValues(a) : null)
    if (!fill) return ''
    let out = ''
    for (let round = 0; round < 16 && out.length < GUIDE_TOKEN_LEN; round++) {
      const a = new Uint8Array(GUIDE_TOKEN_LEN * 2)
      fill(a)
      for (const b of a) if (b < 252 && out.length < GUIDE_TOKEN_LEN) out += (b % 36).toString(36)
    }
    return out.length === GUIDE_TOKEN_LEN ? out : ''
  } catch (e) { return '' }
}

function safeEqual(a, b) {                          // 固定時間比較（token 短，主要是習慣：不因第一個不同字元就提早回傳）
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

// ---------------------------------------------------------------------------------------------
// 網址 hash：#remote=<hostId>[&guide=<token>][&其他參數…]
// ---------------------------------------------------------------------------------------------
function safeDecode(s) { try { return decodeURIComponent(s) } catch (e) { return String(s) } }

// → null（不是遙控頁網址 / hostId 是空的）| { hostId, guide }。hostId 只取第一個 & 之前；guide 必須是合法 token（否則當作沒有）；其他參數忽略。
export function parseRemoteHash(hash) {
  try {
    const s = typeof hash === 'string' ? hash : ''
    if (!s.startsWith('#remote=')) return null
    const parts = s.slice('#remote='.length).split('&')
    const hostId = safeDecode(parts[0])
    if (!hostId) return null
    let guide = null
    for (const p of parts.slice(1)) {
      const k = p.indexOf('=')
      if (k > 0 && p.slice(0, k) === 'guide' && guide === null) { const v = safeDecode(p.slice(k + 1)); if (isGuideToken(v)) guide = v }
    }
    return { hostId, guide }
  } catch (e) { return null }
}

// base = origin + pathname（呼叫端給）；guide 為 token 時帶 &guide=
export function buildRemoteUrl(base, id, guide) {
  if (!id) return ''
  return `${base}#remote=${encodeURIComponent(id)}${guide ? `&guide=${encodeURIComponent(guide)}` : ''}`
}

// ---------------------------------------------------------------------------------------------
// 訊息：建立 / 驗證
// ---------------------------------------------------------------------------------------------
export const helloMsg = (guide) => ({ t: 'hello', guide })

// guideCmd('next') · guideCmd('goto', 3) · guideCmd('speak', true)
export function guideCmd(c, arg) {
  const m = { t: 'g', c }
  if (c === 'goto') m.i = arg
  else if (c === 'speak') m.v = arg
  return m
}

// 導覽員指令的驗證與正規化：只回傳需要的欄位；未知 / 格式錯誤 → null
export function parseGuideCmd(m) {
  if (!isObj(m) || m.t !== 'g' || typeof m.c !== 'string' || !GUIDE_CMDS.includes(m.c)) return null
  if (m.c === 'goto') return Number.isInteger(m.i) && m.i >= 0 && m.i < GUIDE_MAX_STOPS ? { c: 'goto', i: m.i } : null
  if (m.c === 'speak') return typeof m.v === 'boolean' ? { c: 'speak', v: m.v } : null
  return { c: m.c }
}

// 狀態酬載：由 useTourStore 的狀態（running / paused / index / total / stopList）組出。
// stops 只有站 id（白名單）與備註（stopList[i].caption.p.note；沒有 / 空白就省略，最多 120 字）。extra：{ speak, canSpeak, ready }（只收 boolean）。
export function tourPayload(state, extra) {
  const s = isObj(state) ? state : {}
  const list = Array.isArray(s.stopList) ? s.stopList.slice(0, GUIDE_MAX_STOPS) : []
  const stops = list.map((x) => {
    const id = x && GUIDE_STOP_IDS.includes(x.id) ? x.id : GUIDE_STOP_OTHER
    const stop = { id }
    const note = x && x.caption && x.caption.p && x.caption.p.note
    if (typeof note === 'string' && note.trim()) stop.note = clip(note, GUIDE_NOTE_MAX)
    return stop
  })
  const m = { t: 'tour', running: !!s.running, paused: !!s.paused, index: clampInt(s.index, GUIDE_MAX_STOPS), total: clampInt(s.total, GUIDE_MAX_STOPS), stops }
  const e = isObj(extra) ? extra : {}
  for (const k of ['speak', 'canSpeak', 'ready']) if (typeof e[k] === 'boolean') m[k] = e[k]
  return m
}

// 遙控頁收到的 { t:'tour' }：驗證並正規化；格式錯誤 → null（沿用舊狀態）
export function parseTourPayload(m) {
  if (!isObj(m) || m.t !== 'tour') return null
  if (typeof m.running !== 'boolean' || typeof m.paused !== 'boolean') return null
  if (!Number.isInteger(m.index) || !Number.isInteger(m.total) || m.index < 0 || m.total < 0 || m.total > GUIDE_MAX_STOPS) return null
  if (!Array.isArray(m.stops) || m.stops.length > GUIDE_MAX_STOPS) return null
  const stops = []
  for (const x of m.stops) {
    if (!isObj(x) || typeof x.id !== 'string' || !/^[a-z]{1,16}$/.test(x.id)) return null
    const stop = { id: GUIDE_STOP_IDS.includes(x.id) ? x.id : GUIDE_STOP_OTHER }
    if (typeof x.note === 'string' && x.note) stop.note = clip(x.note, GUIDE_NOTE_MAX)
    stops.push(stop)
  }
  const out = { running: m.running, paused: m.paused, index: m.index, total: m.total, stops }
  for (const k of ['speak', 'canSpeak', 'ready']) if (typeof m[k] === 'boolean') out[k] = m[k]
  return out
}

const sameJson = (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b) } catch (e) { return false } }

// 遙控頁的連線狀態：{ guide: 'none' | 'pending' | 'ok' | 'denied', tour }。'none' = 網址沒有 token（一般遙控，什麼都不理）。
//   { t:'guide', ok:true } → 'ok'；ok:false → 'denied'（清掉導覽狀態）；{ t:'tour' } 只在 'ok' 時收；內容沒變就回傳同一個 tour 物件（避免多餘的重繪）。
export function reduceGuideMsg(state, m) {
  const st = isObj(state) ? state : { guide: 'none', tour: null }
  if (!isObj(m) || st.guide === 'none') return st
  if (m.t === 'guide') {
    if (m.ok === true) return { guide: 'ok', tour: st.tour }
    if (m.ok === false) return { guide: 'denied', tour: null }
    return st
  }
  if (m.t === 'tour') {
    if (st.guide !== 'ok') return st
    const tour = parseTourPayload(m)
    if (!tour) return st
    return { guide: 'ok', tour: sameJson(tour, st.tour) ? st.tour : tour }
  }
  return st
}

// 遙控頁導覽員區塊的檢視模型（純函式）：按鈕能不能按、目前站、備註、站 chips、要顯示哪種提示。connected = 與主畫面的連線是否可用。
export function guideView(tour, connected) {
  const on = !!connected
  const tr = isObj(tour) ? tour : null
  const running = !!(tr && tr.running)
  const stops = tr && Array.isArray(tr.stops) ? tr.stops : []
  const index = tr ? tr.index : 0
  const cur = running ? stops[index] || null : null
  const noData = !!tr && !running && tr.ready === false        // 主畫面還沒載入海況資料（沒有東西可導覽）
  return {
    connected: on,
    known: !!tr,                                                // 收到過主畫面的導覽狀態
    running,
    paused: running && !!tr.paused,
    noData,
    index,
    total: tr ? tr.total : 0,
    stopId: cur ? cur.id : null,
    note: cur && cur.note ? cur.note : '',
    chips: running ? stops.map((s, i) => ({ i, id: s.id, current: i === index })) : [],
    canNav: on && running,                                      // 上一站 / 暫停 / 下一站
    canStart: on && !!tr && !running && !noData,
    canStop: on && running,
    showSpeak: !!tr && tr.canSpeak !== false,
    speak: !!(tr && tr.speak),
  }
}

// 展場 QR 的快速鍵：G（大小寫、Shift / CapsLock 皆可）。忽略修飾鍵（ctrl / meta / alt）、輸入法組字、按住不放，以及輸入元件與彈窗內（判斷函式由呼叫端注入）。
export function isGuideQrKey(e, { typing = noop, inModal = noop } = {}) {
  if (!e || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.repeat) return false
  if (e.key !== 'g' && e.key !== 'G') return false
  try { if (typing(e.target) || inModal(e.target)) return false } catch (err) { return false }
  return true
}

// ---------------------------------------------------------------------------------------------
// host 端：導覽員連線集合 + 驗證 + 指令
// ---------------------------------------------------------------------------------------------
// deps：
//   runner        導覽執行器（tourCore.js 的 tourRunner）：next / prev / pause / resume / start / stop / goto / isRunning / isPaused / current。永遠以方法呼叫
//   tourStore     useTourStore（getState）：組狀態酬載用
//   touchGuide    () => 記錄「導覽員在場」（activity.touchGuide）
//   noteActivity  () => 遙控「有人在」（remoteDispatch.noteRemoteActivity）
//   now           () => 毫秒時鐘（節流用；預設 Date.now）
//   getToken      () => 目前 host session 的 guide token（multiplayer.js 的 multiState.guide）
//   setSpeak      (bool) => 設定旁白偏好（tour.js 的 setSpeak）
//   getExtra      () => { speak, canSpeak, ready }（狀態酬載的附加欄位）
//   log           (event, n) => 記錄：'join' / 'leave'（n = 目前導覽員連線數）
// 連線物件（PeerJS DataConnection 或假的）需有 send(m)；open === false 視為已關閉。
export function createGuideHost(deps = {}) {
  const {
    runner, tourStore, touchGuide = noop, noteActivity = noop, now = () => Date.now(),
    getToken = () => null, setSpeak = null, getExtra = () => ({}), log = noop,
    minGapMs = GUIDE_MIN_GAP_MS, maxBadHello = GUIDE_MAX_BAD_HELLO,
  } = deps
  const guides = new Map()           // conn → { last: Map(指令簽名 → 上次受理時間) }
  const bad = new WeakMap()          // conn → 驗證失敗次數
  const listeners = new Set()
  const changed = () => { for (const f of [...listeners]) { try { f() } catch (e) { /* 訂閱者出錯不影響連線 */ } } }

  function sendTo(conn, msg) {
    try {
      if (!conn || conn.open === false) return false
      conn.send(msg)
      return true
    } catch (e) { return false }
  }
  function payload() {
    let extra = {}
    try { extra = getExtra() || {} } catch (e) { /* 附加欄位取不到就不帶 */ }
    return tourPayload(tourStore && tourStore.getState ? tourStore.getState() : {}, extra)
  }

  function drop(conn) {
    if (!guides.delete(conn)) return false
    changed()
    try { log('leave', guides.size) } catch (e) { /* ignore */ }
    return true
  }

  function hello(conn, m) {
    const tok = getToken()
    const ok = isGuideToken(tok) && isGuideToken(m.guide) && safeEqual(tok, m.guide)
    if (ok) {
      const isNew = !guides.has(conn)
      if (isNew) guides.set(conn, { last: new Map() })   // 重複 hello：冪等（不重複加入、不重複記錄），仍回 ok 並補推一次狀態
      sendTo(conn, { t: 'guide', ok: true })
      sendTo(conn, payload())                            // 通過驗證的當下立刻推一次
      if (isNew) { changed(); try { log('join', guides.size) } catch (e) { /* ignore */ } }
      return
    }
    drop(conn)                                            // 換成錯誤的 token → 撤銷（該連線回到一般遙控）
    sendTo(conn, { t: 'guide', ok: false })
    const n = (bad.get(conn) || 0) + 1
    bad.set(conn, n)
    if (n >= maxBadHello) { try { conn.close() } catch (e) { /* ignore */ } }
  }

  // 指令執行：回傳 'ok'（有呼叫 runner）或 'noop'（沒有動作）。導覽沒在跑時 next / prev / pause / resume / stop / goto 一律 noop（不意外開始導覽）；只有 start / toggle 會開始。
  function exec(cmd) {
    const running = !!runner.isRunning()
    switch (cmd.c) {
      case 'next': if (!running) return 'noop'; runner.next(); return 'ok'
      case 'prev': if (!running) return 'noop'; runner.prev(); return 'ok'
      case 'pause': if (!running || runner.isPaused()) return 'noop'; runner.pause(); return 'ok'
      case 'resume': if (!running || !runner.isPaused()) return 'noop'; runner.resume(); return 'ok'
      case 'toggle':
        if (!running) return runner.start({ auto: false }) ? 'ok' : 'noop'
        if (runner.isPaused()) runner.resume(); else runner.pause()
        return 'ok'
      case 'start': if (running) return 'noop'; return runner.start({ auto: false }) ? 'ok' : 'noop'
      case 'stop': if (!running) return 'noop'; runner.stop('user'); return 'ok'
      case 'goto': {
        if (!running) return 'noop'
        const cur = runner.current ? runner.current() : null
        if (!cur || !(cmd.i < cur.total)) return 'noop'      // 超出這一輪的站數
        runner.goto(cmd.i)
        return 'ok'
      }
      case 'speak': if (typeof setSpeak !== 'function') return 'noop'; setSpeak(cmd.v); return 'ok'
      default: return 'noop'
    }
  }

  function command(conn, m) {
    const g = guides.get(conn)
    if (!g) return                                        // 非導覽員連線：靜默忽略
    const cmd = parseGuideCmd(m)
    if (!cmd) return                                      // 未知 / 格式錯誤：靜默忽略
    const sig = cmd.c === 'goto' ? `goto:${cmd.i}` : cmd.c === 'speak' ? `speak:${cmd.v}` : cmd.c
    const t = now()
    const last = g.last.get(sig)
    if (last !== undefined && t - last >= 0 && t - last < minGapMs) return   // 節流：同一連線同一指令 150ms 內的重複丟棄（時鐘倒退不算重複）
    g.last.set(sig, t)
    try { touchGuide() } catch (e) { /* 記錄失敗不影響導覽 */ }      // 先記「導覽員在場」（不是 touch()：不能中止導覽）
    try { noteActivity() } catch (e) { /* ignore */ }               // 遙控「有人在」
    exec(cmd)
  }

  return {
    // 收到一則遙控訊息：hello / g 由這裡處理並回傳 true（呼叫端不要再當一般遙控訊息派送）；其他回傳 false。永遠不丟例外。
    handle(conn, m) {
      try {
        if (!isObj(m)) return false
        if (m.t === 'hello') { hello(conn, m); return true }
        if (m.t === 'g') { command(conn, m); return true }
      } catch (e) { return true }
      return false
    },
    exec(cmd) { try { return exec(cmd) } catch (e) { return 'noop' } },
    remove: (conn) => drop(conn),
    clear() { const had = guides.size > 0; guides.clear(); if (had) { changed(); try { log('leave', 0) } catch (e) { /* ignore */ } } },
    has: (conn) => guides.has(conn),
    size: () => guides.size,
    conns: () => [...guides.keys()],
    payload,
    // 推給所有導覽員連線；已關閉的順手移出集合。回傳送出的連線數
    broadcast(msg) {
      let n = 0
      for (const conn of [...guides.keys()]) {
        if (conn.open === false) { drop(conn); continue }
        if (sendTo(conn, msg)) n++
      }
      return n
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  }
}

// ---------------------------------------------------------------------------------------------
// host 端：狀態推送（只在有導覽員連線時才 start；訂閱 tourStore + 每 2 秒補推）
// ---------------------------------------------------------------------------------------------
//   tourStore：useTourStore（subscribe）；payload：() => 訊息；broadcast：(msg) => 送出
//   setIv / clearIv：預設是「裸函式包一層」的 setInterval / clearInterval（原生計時器掛在物件上呼叫會丟 Illegal invocation）
//   start()：立刻推一次、之後 tourStore 有變化且酬載不同才推、另每 everyMs 無條件補推一次；重複 start 無效。stop()：退訂 + 清計時器。
export function createGuideSync({
  tourStore, payload, broadcast, everyMs = GUIDE_PUSH_MS,
  setIv = (fn, ms) => setInterval(fn, ms), clearIv = (id) => clearInterval(id),
} = {}) {
  let off = null, iv = null, last = ''
  const push = (force) => {
    try {
      const m = payload()
      const key = JSON.stringify(m)
      if (!force && key === last) return
      last = key
      broadcast(m)
    } catch (e) { /* 推送失敗下一輪再來 */ }
  }
  return {
    start() {
      if (off) return
      off = tourStore.subscribe(() => push(false))
      iv = setIv(() => push(true), everyMs)
      push(true)
    },
    stop() {
      if (off) { try { off() } catch (e) { /* ignore */ } off = null }
      if (iv !== null) { clearIv(iv); iv = null }
      last = ''
    },
    push,
    isRunning: () => !!off,
  }
}
