// 手機遙控頁的自動重連（純邏輯 / 全部可注入：Node 可用「會檢查 this 的假 Peer / 假計時器」測試）。
// 手機遙控頁（#remote=）必須保持輕量：本檔沒有任何 import（不碰 three / store / PeerJS 本體；Peer 由呼叫端用 makePeer 交進來）。
//
// 三個零件：
//   createReconnector   退避排程 + 狀態機。不知道 PeerJS，只知道「一次嘗試」與「嘗試的結果」：
//                       idle → connecting → connected；連線掉了 → waiting（等退避時間）⇄ connecting；頁面在背景 → paused（不排計時器）；
//                       peer-unavailable 連續太多次 / 致命錯誤 → gaveup（停止）。
//   createRemoteLink    把 reconnector 接上 Peer / DataConnection：一個 Peer 重複使用（重連不換 peer id → 主畫面認得出「同一支手機」），
//                       每次嘗試只留一條連線（新的一條建立前先收掉舊的，舊連線殘留的事件一律忽略）；
//                       訊號伺服器斷線 → peer.reconnect()；Peer 被銷毀 / 註冊卡住 → 重建；回到前景 / 網路恢復立刻重試一次；
//                       回到前景時連線「看起來還開著」也可能其實已死（鎖屏期間 JS 被凍結）→ 等一小段時間沒收到主畫面的任何訊息就當死連線。
//   createPeerMemory    主畫面（host）端用：同一支手機（同一個 peer id）重連時沿用聲部；有界（不會無限長大）。
// 原生函式一律以「方法」呼叫（peer.connect / conn.close / doc.addEventListener…），計時器用「裸函式包一層」（不存進物件屬性再呼叫）：
//   瀏覽器脫離原物件呼叫原生函式會丟 Illegal invocation，Node 不會——測試用的假物件會檢查 this。

export const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000]   // 第 1、2、3… 次重試前等多久；之後一直是最後一個（15 秒封頂）
export const RECONNECT_MAX_UNAVAILABLE = 6                            // peer-unavailable（主畫面的 host id 已不存在）連續這麼多次 → 放棄
export const CONNECT_TIMEOUT_MS = 15000                               // 一次連線嘗試超過這麼久還沒 open → 視為失敗（PeerJS 對「從未 open」的連線不會發 close）
export const RESUME_PROBE_MS = 4000                                   // 回到前景後，連線看似開著卻這麼久沒收到主畫面的任何訊息 → 視為死連線（主畫面每秒推一次 sync）
export const PEER_MEMORY_MAX = 64

// PeerJS 的 peer 錯誤類型：這些重試也沒用（瀏覽器不支援 WebRTC / 網址或金鑰不合法 / 需要 https）
const FATAL_PEER_ERRORS = new Set(['browser-incompatible', 'invalid-id', 'invalid-key', 'ssl-unavailable'])

const noop = () => {}
const errText = (e) => { try { return String((e && (e.type || e.message)) || e || '') } catch (x) { return '' } }

// 第 n 次重試（1 起算）前要等多久：1、2、4、8、15、15、15…（秒）
export function backoffMs(n, table = RECONNECT_BACKOFF_MS) {
  const tb = Array.isArray(table) && table.length ? table : RECONNECT_BACKOFF_MS
  const i = Number.isFinite(n) ? Math.max(1, Math.trunc(n)) : 1
  return tb[Math.min(i, tb.length) - 1]
}

// ---------------------------------------------------------------------------------------------
// 退避排程 + 狀態機
//   attempt()      執行一次嘗試（呼叫端負責實際去連；結果以 opened() / failed(kind) 回報——可以同步、也可以晚一點）
//   onChange(s)    狀態變化通知：s = { phase, n, unavailable, reason }
//   isVisible()    頁面現在看得到嗎（背景時不排重試）
//   setTimer / clearTimer   預設是「裸函式包一層」的 setTimeout / clearTimeout
// n = 「第幾次重試」：連線掉了之後第 1 次重試前等 1 秒，n=1；那次也失敗 → n=2、等 2 秒……成功（opened）歸零。
// failed(kind)：'unavailable'（peer-unavailable；連續 maxUnavailable 次就放棄，中間夾一次別種失敗就重算）· 'fatal' / 'load'（重試沒用 → 立刻放棄）· 其他（'closed' / 'error' / 'timeout' / 'signal' / 'stale'…）→ 退避重試。
//   只有「一次嘗試進行中 / 連線中」才理會 failed()（同一次掉線的 close + error + disconnected 重複通知不會讓計數多跳、也不會排出兩個計時器）。
// ---------------------------------------------------------------------------------------------
export function createReconnector(o = {}) {
  const { attempt = noop, onChange = noop, isVisible = () => true, backoff = RECONNECT_BACKOFF_MS, maxUnavailable = RECONNECT_MAX_UNAVAILABLE } = o
  const setTimer = typeof o.setTimer === 'function' ? o.setTimer : (fn, ms) => setTimeout(fn, ms)
  const clearTimer = typeof o.clearTimer === 'function' ? o.clearTimer : (id) => clearTimeout(id)
  let phase = 'idle', n = 0, unavailable = 0, reason = '', timer = null

  const state = () => ({ phase, n, unavailable, reason })
  const emit = () => { try { onChange(state()) } catch (e) { /* 訂閱者出錯不影響重連 */ } }
  const cancel = () => { if (timer !== null) { const id = timer; timer = null; try { clearTimer(id) } catch (e) { /* ignore */ } } }
  const visible = () => { try { return !!isVisible() } catch (e) { return true } }

  function run() {
    cancel()
    phase = 'connecting'
    emit()
    try { attempt(state()) } catch (e) { failed('error') }
  }

  function failed(kind = 'closed') {
    if (phase !== 'connecting' && phase !== 'connected') return false
    cancel()
    if (kind === 'fatal' || kind === 'load') { phase = 'gaveup'; reason = kind; emit(); return true }
    unavailable = kind === 'unavailable' ? unavailable + 1 : 0
    if (unavailable >= maxUnavailable) { phase = 'gaveup'; reason = 'unavailable'; emit(); return true }
    n += 1
    if (!visible()) { phase = 'paused'; emit(); return true }     // 背景：不排計時器，回到前景（visibility(true)）再立刻試
    phase = 'waiting'
    timer = setTimer(() => { timer = null; if (phase === 'waiting') run() }, backoffMs(n, backoff))
    emit()
    return true
  }

  function opened() {
    if (phase !== 'connecting' && phase !== 'connected') return false
    cancel()
    phase = 'connected'; n = 0; unavailable = 0; reason = ''
    emit()
    return true
  }

  // 可見性改變：背景 → 取消等待中的計時器（paused）；回到前景 → paused / waiting 的立刻重試一次（不必等完退避時間）
  function visibility(v) {
    if (phase === 'idle' || phase === 'gaveup') return
    if (!v) { if (phase === 'waiting') { cancel(); phase = 'paused'; emit() } return }
    if (phase === 'paused' || phase === 'waiting') run()
  }

  return {
    start() { if (phase !== 'idle') return false; n = 0; unavailable = 0; reason = ''; run(); return true },   // 重複 start 無效
    stop() { cancel(); const was = phase; phase = 'idle'; if (was !== 'idle') emit() },                        // 取消一切（計時器清掉、之後的通知全部忽略）
    failed, opened, visibility,
    retryNow: () => visibility(true),
    state,
  }
}

// ---------------------------------------------------------------------------------------------
// 連線層：Peer + DataConnection + reconnector
//   hostId            主畫面的 peer id
//   makePeer()        建立一個新的 Peer（可回傳 Promise：動態 import peerjs）。重連時能沿用的 Peer 就沿用，不會多建
//   onOpen(conn, { reconnect })   每次連線 open（含每次重連成功）；reconnect = 這不是第一次成功（導覽員模式在這裡重送 hello）
//   onData(msg, conn)             收到主畫面的訊息（只轉發「目前這一條」連線的）
//   onChange(snapshot)            狀態變化：{ phase, n, unavailable, reason, detail, ever }（ever = 曾經連上過）
//   env               { doc, win }：可見性 / 網路事件來源（預設 document / window，在 start() 當下才讀）
//   setTimer / clearTimer   可注入（測試）；預設是「裸函式包一層」的 setTimeout / clearTimeout
// 回傳 { start, stop, send, state, conn, isOpen, retryNow }。stop() 之後不會再有任何 callback、Peer / 連線 / 監聽 / 計時器全部收乾淨；可再 start()（StrictMode）。
// ---------------------------------------------------------------------------------------------
export function createRemoteLink(o = {}) {
  const { hostId, makePeer, onOpen = noop, onData = noop, onChange = noop, connectTimeoutMs = CONNECT_TIMEOUT_MS, probeMs = RESUME_PROBE_MS, backoff, maxUnavailable } = o
  const env = o.env && typeof o.env === 'object' ? o.env : {}
  const setTimer = typeof o.setTimer === 'function' ? o.setTimer : (fn, ms) => setTimeout(fn, ms)
  const clearTimer = typeof o.clearTimer === 'function' ? o.clearTimer : (id) => clearTimeout(id)

  let doc = null, win = null
  let stopped = true, rc = null
  let peer = null, conn = null
  let att = 0            // 第幾次嘗試（每次 doAttempt +1；晚到的非同步結果 / 過期連線的事件靠它與物件身分判斷「已經作廢」）
  let waitOpen = 0       // 正在等 Peer 向訊號伺服器（重新）註冊完成 'open' 的那次嘗試
  let ever = false, detail = '', rx = 0
  let connTimer = null, probeTimer = null

  const cancelTimer = (id) => { if (id !== null) { try { clearTimer(id) } catch (e) { /* ignore */ } } }
  const clearConnTimer = () => { const id = connTimer; connTimer = null; cancelTimer(id) }
  const clearProbe = () => { const id = probeTimer; probeTimer = null; cancelTimer(id) }
  const visible = () => !!(!doc || doc.visibilityState !== 'hidden')
  const snapshot = () => ({ ...(rc ? rc.state() : { phase: 'idle', n: 0, unavailable: 0, reason: '' }), detail, ever })
  const emit = () => { if (stopped) return; try { onChange(snapshot()) } catch (e) { /* ignore */ } }   // stop() 之後不再通知

  function closeQuiet(c) { if (c) { try { c.close() } catch (e) { /* ignore */ } } }
  function destroyQuiet(p) { if (p) { try { p.destroy() } catch (e) { /* ignore */ } } }
  function dropPeer() { const p = peer; peer = null; destroyQuiet(p) }

  // 目前這次嘗試失敗（連線掉了 / 逾時 / peer 錯誤）：收掉連線，交給 reconnector 排下一次。已經處理過的（phase 是 waiting / paused / gaveup）直接忽略。
  function attemptFailed(kind) {
    if (stopped || !rc) return
    const ph = rc.state().phase
    if (ph !== 'connecting' && ph !== 'connected') return
    clearConnTimer(); clearProbe()
    const c = conn; conn = null
    waitOpen = 0
    closeQuiet(c)
    if (kind === 'timeout' && peer && !peer.open && !peer.disconnected) dropPeer()   // 向訊號伺服器註冊卡住的 Peer 不留著：下一次重建
    rc.failed(kind)
    if (rc.state().phase === 'gaveup') dropPeer()                                    // 放棄了：不再需要這個 Peer（釋放訊號伺服器上的 id）
  }

  function bindConn(c) {
    c.on('open', () => {
      if (stopped || conn !== c) return
      clearConnTimer()
      const again = ever
      ever = true
      rx = 0
      if (rc.opened()) { try { onOpen(c, { reconnect: again }) } catch (e) { /* 呼叫端出錯不影響連線 */ } }
    })
    c.on('data', (m) => { if (stopped || conn !== c) return; rx++; try { onData(m, c) } catch (e) { /* ignore */ } })
    c.on('close', () => { if (stopped || conn !== c) return; attemptFailed('closed') })
    // DataConnection 的 error 有些不致命（MessageToBig / NotOpenYet）；已 open 的連線真的壞了一定會接著發 close。從未 open 的連線 PeerJS 不會發 close → 只能靠 error / 逾時
    c.on('error', () => { if (stopped || conn !== c || c.open) return; attemptFailed('error') })
  }

  function connectNow(a, p) {
    if (stopped || a !== att || peer !== p) return
    let c = null
    try { c = p.connect(hostId, { reliable: true }) } catch (e) { c = null }
    if (!c) { attemptFailed('error'); return }        // 訊號斷線時 connect 會回 undefined（並發 error）
    conn = c
    bindConn(c)
  }

  function onPeerError(p, e) {
    if (stopped || peer !== p) return
    const type = e && e.type
    if (type === 'peer-unavailable') { if (!(conn && conn.open)) attemptFailed('unavailable'); return }   // 已連上時晚到的 peer-unavailable（更早一次嘗試的回音）不理
    if (FATAL_PEER_ERRORS.has(type)) { detail = errText(e); attemptFailed('fatal'); return }
    if (type === 'unavailable-id') dropPeer()             // 重新註冊時舊 id 被占走：這個 Peer 不能用了，下次重建一個新的
    if (conn && conn.open) return                          // 資料通道還活著（例如與訊號伺服器的 network 錯誤）：不去動它，真的斷了會有 close
    detail = errText(e)
    attemptFailed('error')
  }

  function bindPeer(p) {
    p.on('open', () => {
      if (stopped || peer !== p) return
      if (waitOpen && waitOpen === att) { const a = waitOpen; waitOpen = 0; connectNow(a, p) }
    })
    p.on('error', (e) => onPeerError(p, e))
    // 與訊號伺服器斷線：資料通道還開著就先別動（P2P 不需要訊號伺服器；之後連線真的斷了，下一次重試會 peer.reconnect()）；連線還在建立中 → 這次嘗試作廢
    p.on('disconnected', () => { if (stopped || peer !== p) return; if (conn && conn.open) return; attemptFailed('signal') })
    p.on('close', () => { if (peer !== p) return; peer = null; if (!stopped) attemptFailed('closed') })
  }

  // Peer 已存在且沒被銷毀 → 沿用；否則建一個新的。晚到的建立結果（已 stop / 已被更新的嘗試取代）立刻銷毀，不留下沒人管的 Peer
  function proceed(a, p) {
    if (p.disconnected) {
      waitOpen = a
      try { p.reconnect() } catch (e) { waitOpen = 0; dropPeer(); attemptFailed('error') }
      return
    }
    if (!p.open) { waitOpen = a; return }                  // 還在向訊號伺服器註冊：等 open
    connectNow(a, p)
  }

  function doAttempt() {
    const a = ++att
    clearConnTimer(); clearProbe()
    const old = conn; conn = null; waitOpen = 0
    closeQuiet(old)                                        // 舊連線先收掉（它的事件已因 conn !== c 而被忽略）
    connTimer = setTimer(() => { connTimer = null; if (!stopped && a === att) attemptFailed('timeout') }, connectTimeoutMs)
    if (peer && !peer.destroyed) { proceed(a, peer); return }
    peer = null
    let r
    try { r = makePeer() } catch (e) { detail = errText(e); attemptFailed('load'); return }
    Promise.resolve(r).then((p) => {
      if (!p) { if (!stopped && a === att) { detail = ''; attemptFailed('load') } return }
      if (stopped || a !== att) { destroyQuiet(p); return }
      peer = p
      bindPeer(p)
      proceed(a, p)
    }, (e) => { if (!stopped && a === att) { detail = errText(e); attemptFailed('load') } })
  }

  // 回到前景：立刻重試一次（paused / waiting）；連線看似還開著 → 起一個探測（見檔頭）
  function armProbe() {
    clearProbe()
    const c = conn
    if (stopped || !c || !c.open) return
    const rx0 = rx
    probeTimer = setTimer(() => { probeTimer = null; if (!stopped && conn === c && visible() && rx === rx0) attemptFailed('stale') }, probeMs)
  }
  function wake() {
    if (stopped || !rc) return
    rc.visibility(visible())
    if (visible()) armProbe()
  }
  const onVis = () => wake()

  function hook() {
    doc = env.doc !== undefined ? env.doc : (typeof document !== 'undefined' ? document : null)
    win = env.win !== undefined ? env.win : (typeof window !== 'undefined' ? window : null)
    try { if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVis) } catch (e) { /* ignore */ }
    try { if (win && typeof win.addEventListener === 'function') { win.addEventListener('online', onVis); win.addEventListener('pageshow', onVis) } } catch (e) { /* ignore */ }
  }
  function unhook() {
    try { if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVis) } catch (e) { /* ignore */ }
    try { if (win && typeof win.removeEventListener === 'function') { win.removeEventListener('online', onVis); win.removeEventListener('pageshow', onVis) } } catch (e) { /* ignore */ }
    doc = null; win = null
  }

  return {
    start() {
      if (!stopped) return false
      stopped = false; ever = false; detail = ''; rx = 0
      hook()
      rc = createReconnector({ attempt: doAttempt, onChange: emit, isVisible: visible, backoff, maxUnavailable, setTimer, clearTimer })
      rc.start()
      return true
    },
    stop() {
      if (stopped) return
      stopped = true
      att++                                                // 讓還在進行中的非同步建立作廢
      unhook()
      clearConnTimer(); clearProbe()
      const c = conn; conn = null; waitOpen = 0
      closeQuiet(c)
      dropPeer()
      const r = rc; rc = null
      if (r) r.stop()
    },
    send(m) { const c = conn; if (!c || !c.open) return false; try { c.send(m); return true } catch (e) { return false } },
    state: snapshot,
    conn: () => (conn && conn.open ? conn : null),
    isOpen: () => !!(conn && conn.open && rc && rc.state().phase === 'connected'),
    retryNow: () => { if (!stopped && rc) rc.retryNow() },
  }
}

// ---------------------------------------------------------------------------------------------
// 主畫面（host）端小工具
//   staleConns(conns, conn)   同一支手機（同一個 peer id）的舊連線：新連線 open 後要被新的取代
//   createPeerMemory(max)     peer id → 值（聲部）的有界記憶：同一支手機重連沿用原本的聲部；超過上限丟掉最舊的
// ---------------------------------------------------------------------------------------------
export function staleConns(conns, conn) {
  const pid = conn && conn.peer
  if (typeof pid !== 'string' || !pid || !Array.isArray(conns)) return []
  return conns.filter((x) => x !== conn && x && x.peer === pid)
}

export function createPeerMemory(max = PEER_MEMORY_MAX) {
  const cap = Number.isFinite(max) && max > 0 ? Math.trunc(max) : PEER_MEMORY_MAX
  const m = new Map()
  return {
    has: (id) => m.has(id),
    get: (id) => m.get(id),
    set(id, v) {
      if (typeof id !== 'string' || !id) return
      m.delete(id); m.set(id, v)
      while (m.size > cap) m.delete(m.keys().next().value)
    },
    clear: () => m.clear(),
    size: () => m.size,
  }
}
