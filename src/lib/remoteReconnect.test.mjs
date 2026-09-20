// 手機遙控頁自動重連的單元測試。執行：node --test src/lib/remoteReconnect.test.mjs
// 涵蓋：退避序列（1、2、4、8、15 秒封頂）、狀態機（背景暫停 / 前景立刻重試 / peer-unavailable 上限 / 成功歸零 / 取消 / 重複啟動 / 重複通知不重複計數）、
//   連線層（一個 Peer 重複使用、每次只留一條連線、舊連線殘留事件被忽略、訊號伺服器斷線 → reconnect、Peer 被銷毀 → 重建、逾時、stop 的完整清理、StrictMode 的 start / stop / start、
//   回到前景的死連線探測）、host 端小工具（同一支手機取代舊連線、有界的聲部記憶）。
// 假的 Peer / 連線 / document / 計時器都會檢查 this：原生函式脫離原物件呼叫會丟 Illegal invocation（瀏覽器如此、Node 不會）——寫錯的話這裡就會現形。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { illegal, makeTimers, installTimers } from './tourTestEnv.mjs'
import {
  RECONNECT_BACKOFF_MS, RECONNECT_MAX_UNAVAILABLE, CONNECT_TIMEOUT_MS, RESUME_PROBE_MS, PEER_MEMORY_MAX,
  backoffMs, createReconnector, createRemoteLink, staleConns, createPeerMemory,
} from './remoteReconnect.js'

const flush = () => new Promise((r) => setImmediate(r))
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const importsOf = (code) => [...code.matchAll(/(?:^|\n)\s*import\s+(?:[^'"\n]*?from\s+)?['"]([^'"]+)['"]/g)].map((m) => m[1])

// ---------------------------------------------------------------------------------------------
// 假物件
// ---------------------------------------------------------------------------------------------
function timerPair() {
  const timers = makeTimers()
  const st = timers.setTimeout, ct = timers.clearTimeout      // 裸函式：以 (fn, ms) 直接呼叫（this 是 undefined）——與瀏覽器的 window.setTimeout 一樣
  return { timers, setTimer: (fn, ms) => st(fn, ms), clearTimer: (id) => ct(id) }
}

function makeConnFake(host, opts) {
  const L = {}
  const c = {
    peer: host, opts, open: false, dead: false, closed: 0, sent: [],
    on(ev, f) { if (this !== c) throw illegal(); (L[ev] ||= []).push(f); return c },
    send(m) { if (this !== c) throw illegal(); if (!c.open) throw new Error('send on a connection that is not open'); c.sent.push(m) },
    close() { if (this !== c) throw illegal(); c.closed++; c.dead = true; if (c.open) { c.open = false; c.fire('close') } },   // PeerJS：只有 open 過的連線才會發 close
    fire(ev, ...a) { for (const f of [...(L[ev] || [])]) f(...a) },
    doOpen() { c.open = true; c.fire('open') },
    doData(m) { c.fire('data', m) },
    doClose() { c.open = false; c.dead = true; c.fire('close') },        // 對方 / 網路造成的關閉
    doError() { c.fire('error', new Error('conn error')) },
  }
  return c
}

let peerSeq = 0
function makePeerFake() {
  const L = {}
  const conns = []
  const p = {
    id: 'p' + (++peerSeq), open: false, disconnected: false, destroyed: false, conns, reconnects: 0, destroys: 0,
    on(ev, f) { if (this !== p) throw illegal(); (L[ev] ||= []).push(f); return p },
    connect(host, o) {
      if (this !== p) throw illegal()
      if (p.disconnected) { p.fire('error', { type: 'disconnected' }); return undefined }   // PeerJS：訊號斷線時 connect 回 undefined 並發 error
      const c = makeConnFake(host, o); conns.push(c); return c
    },
    reconnect() { if (this !== p) throw illegal(); if (p.destroyed || !p.disconnected) throw new Error('cannot reconnect'); p.disconnected = false; p.reconnects++ },
    destroy() {
      if (this !== p) throw illegal()
      if (p.destroyed) return
      p.destroys++
      if (!p.disconnected) { p.disconnected = true; p.open = false; p.fire('disconnected', p.id) }   // PeerJS：destroy 先 disconnect（發 disconnected）再關所有連線、最後發 close
      for (const c of conns) c.close()
      p.destroyed = true
      p.fire('close')
    },
    fire(ev, ...a) { for (const f of [...(L[ev] || [])]) f(...a) },
    doOpen() { p.open = true; p.fire('open', p.id) },
    doDisconnect() { p.disconnected = true; p.open = false; p.fire('disconnected', p.id) },
    doUnavailable() { p.fire('error', { type: 'peer-unavailable', message: 'Could not connect to peer host1' }) },
    live: () => conns.filter((c) => !c.dead),
    lastConn: () => conns[conns.length - 1],
  }
  return p
}

// 假 document / window：addEventListener / removeEventListener 檢查 this；count() = 目前掛著幾個監聽（洩漏檢查用）
function makeDoc(visible = true) {
  const L = new Map()
  const d = {
    visibilityState: visible ? 'visible' : 'hidden',
    addEventListener(ev, f) { if (this !== d) throw illegal(); if (!L.has(ev)) L.set(ev, new Set()); L.get(ev).add(f) },
    removeEventListener(ev, f) { if (this !== d) throw illegal(); if (L.has(ev)) L.get(ev).delete(f) },
    fire(ev) { for (const f of [...(L.get(ev) || [])]) f({ type: ev }) },
    setVisible(v) { d.visibilityState = v ? 'visible' : 'hidden'; d.fire('visibilitychange') },
    count: () => [...L.values()].reduce((a, s) => a + s.size, 0),
  }
  return d
}

function setup(over = {}) {
  const { timers, setTimer, clearTimer } = timerPair()
  const doc = makeDoc(over.visible !== false)
  const win = makeDoc()
  const peers = []
  const opens = [], datas = [], states = []
  const makePeer = over.makePeer || (() => { const p = makePeerFake(); peers.push(p); return Promise.resolve(p) })
  const link = createRemoteLink({
    hostId: 'host1', makePeer, env: { doc, win }, setTimer, clearTimer,
    onOpen: (c, info) => { opens.push({ c, ...info }) },
    onData: (m, c) => { datas.push([m, c]) },
    onChange: (s) => { states.push(s) },
    ...over.opts,
  })
  const e = {
    link, timers, doc, win, peers, opens, datas, states,
    phase: () => link.state().phase, n: () => link.state().n,
    async up() { link.start(); await flush(); peers[0].doOpen(); const c = peers[0].lastConn(); c.doOpen(); return c },   // 一路連到 connected
  }
  return e
}

// =============================================================================================
// 退避
// =============================================================================================
test('常數與 backoffMs：1、2、4、8、15 秒，之後一直是 15 秒（封頂）；壞輸入不丟例外、退回第一個', () => {
  assert.deepEqual(RECONNECT_BACKOFF_MS, [1000, 2000, 4000, 8000, 15000])
  assert.equal(RECONNECT_MAX_UNAVAILABLE, 6)
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20, 1000].map((n) => backoffMs(n)), [1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000, 15000])
  for (const bad of [0, -3, NaN, undefined, null, 'x', Infinity]) assert.doesNotThrow(() => backoffMs(bad))
  assert.equal(backoffMs(0), 1000); assert.equal(backoffMs(NaN), 1000); assert.equal(backoffMs(2.9), 2000)
  assert.equal(backoffMs(3, [5, 6]), 6, '自訂表：超過長度取最後一個')
  assert.equal(backoffMs(1, []), 1000, '空表退回預設')
  assert.ok(CONNECT_TIMEOUT_MS >= 10000 && RESUME_PROBE_MS >= 2000)
})

// =============================================================================================
// 狀態機（createReconnector）
// =============================================================================================
function rcSetup(over = {}) {
  const { timers, setTimer, clearTimer } = timerPair()
  const calls = []                 // attempt 被呼叫的次數（用 n 標記）
  const changes = []
  let visible = true
  const rc = createReconnector({
    attempt: (s) => { calls.push(s.n); if (over.attemptThrows) throw new Error('attempt boom') },
    onChange: (s) => { changes.push(s) },
    isVisible: () => visible, setTimer, clearTimer, ...over.opts,
  })
  return { rc, timers, calls, changes, setVisible: (v) => { visible = v } }
}

test('createReconnector：start 立刻嘗試一次（connecting、n=0）；重複 start 無效；opened → connected 並歸零', () => {
  const { rc, calls, timers } = rcSetup()
  assert.equal(rc.state().phase, 'idle')
  assert.equal(rc.start(), true)
  assert.equal(rc.start(), false)
  assert.deepEqual(calls, [0])
  assert.equal(rc.state().phase, 'connecting')
  assert.equal(rc.opened(), true)
  assert.deepEqual(rc.state(), { phase: 'connected', n: 0, unavailable: 0, reason: '' })
  assert.equal(timers.pending(), 0)
})

test('createReconnector：失敗後依 1、2、4、8、15、15 秒退避重試（n = 第幾次重試）；每次剛好在時間到才嘗試', () => {
  const { rc, calls, timers } = rcSetup()
  rc.start()
  const waits = [1000, 2000, 4000, 8000, 15000, 15000, 15000]
  waits.forEach((w, i) => {
    rc.failed('closed')
    assert.deepEqual([rc.state().phase, rc.state().n], ['waiting', i + 1])
    assert.equal(timers.pending(), 1)
    timers.advance(w - 1); assert.equal(calls.length, i + 1, `第 ${i + 1} 次重試不能早於 ${w}ms`)
    timers.advance(1); assert.equal(calls.length, i + 2)
    assert.deepEqual([rc.state().phase, rc.state().n], ['connecting', i + 1])
  })
  assert.deepEqual(calls, [0, 1, 2, 3, 4, 5, 6, 7])
})

test('createReconnector：成功（opened）後計數歸零——下次掉線又從 1 秒開始', () => {
  const { rc, timers } = rcSetup()
  rc.start()
  rc.failed('closed'); timers.advance(1000)
  rc.failed('closed'); timers.advance(2000)
  assert.equal(rc.state().n, 2)
  rc.opened()
  assert.equal(rc.state().n, 0)
  rc.failed('closed')
  assert.deepEqual([rc.state().phase, rc.state().n], ['waiting', 1])
  timers.advance(999); assert.equal(rc.state().phase, 'waiting')
  timers.advance(1); assert.equal(rc.state().phase, 'connecting')
})

test('createReconnector：同一次掉線的重複通知（close + error + disconnected）只算一次——n 不多跳、計時器不重複', () => {
  const { rc, timers, calls } = rcSetup()
  rc.start(); rc.opened()
  assert.equal(rc.failed('closed'), true)
  assert.equal(rc.failed('closed'), false)
  assert.equal(rc.failed('unavailable'), false)
  assert.equal(rc.failed('error'), false)
  assert.equal(rc.state().n, 1)
  assert.equal(timers.pending(), 1)
  timers.advance(1000)
  assert.deepEqual(calls, [0, 1], '只重試一次')
})

test('createReconnector：頁面在背景 → 掉線不排計時器（paused）；等待中轉背景 → 取消計時器；回到前景立刻重試一次', () => {
  const { rc, timers, calls, setVisible } = rcSetup()
  rc.start(); rc.opened()
  setVisible(false)
  rc.failed('closed')
  assert.deepEqual([rc.state().phase, rc.state().n], ['paused', 1])
  assert.equal(timers.pending(), 0)
  timers.advance(3600000); assert.deepEqual(calls, [0], '背景中永遠不重試')
  setVisible(true); rc.visibility(true)
  assert.deepEqual(calls, [0, 1], '回到前景立刻重試（不必等退避時間）')
  assert.equal(rc.state().phase, 'connecting')
  // 等待中轉背景
  rc.failed('closed')
  assert.deepEqual([rc.state().phase, rc.state().n], ['waiting', 2])
  assert.equal(timers.pending(), 1)
  setVisible(false); rc.visibility(false)
  assert.equal(rc.state().phase, 'paused'); assert.equal(timers.pending(), 0)
  timers.advance(60000); assert.equal(calls.length, 2)
  setVisible(true); rc.visibility(true)
  assert.equal(calls.length, 3)
  assert.equal(rc.state().n, 2, '回到前景的立刻重試不改變重試次數的計算')
})

test('createReconnector：等待中回到前景（沒收到 hidden 事件的環境）也立刻重試；connected / connecting 時可見性變化無動作', () => {
  const { rc, timers, calls } = rcSetup()
  rc.start(); rc.opened()
  rc.visibility(true); rc.visibility(false); rc.visibility(true)
  assert.equal(calls.length, 1, 'connected：不動')
  rc.failed('closed')
  assert.equal(rc.state().phase, 'waiting')
  rc.retryNow()
  assert.equal(calls.length, 2)
  assert.equal(timers.pending(), 0, '立刻重試時等待中的計時器被清掉')
  rc.visibility(true); rc.retryNow()
  assert.equal(calls.length, 2, 'connecting（嘗試進行中）：不會再疊一次')
})

test('createReconnector：peer-unavailable 連續 6 次 → gaveup（reason unavailable），不再排計時器；之後任何事件都無效', () => {
  const { rc, timers, calls } = rcSetup()
  rc.start()
  for (let i = 1; i <= RECONNECT_MAX_UNAVAILABLE; i++) {
    assert.equal(rc.state().phase, 'connecting')
    rc.failed('unavailable')
    if (i < RECONNECT_MAX_UNAVAILABLE) { assert.equal(rc.state().phase, 'waiting'); timers.advance(backoffMs(i)) }
  }
  assert.deepEqual([rc.state().phase, rc.state().reason, rc.state().unavailable], ['gaveup', 'unavailable', 6])
  assert.equal(timers.pending(), 0)
  assert.equal(calls.length, 6)
  rc.visibility(true); rc.retryNow(); rc.failed('closed'); rc.opened()
  timers.advance(600000)
  assert.equal(calls.length, 6)
  assert.equal(rc.state().phase, 'gaveup')
})

test('createReconnector：中間夾一次別種失敗，peer-unavailable 的連續計數重算；成功也歸零；上限可自訂', () => {
  const { rc, timers } = rcSetup()
  rc.start()
  for (let i = 0; i < 5; i++) { rc.failed('unavailable'); timers.advance(60000) }
  assert.equal(rc.state().unavailable, 5)
  rc.failed('closed'); timers.advance(60000)                    // 別種失敗：不再「連續」
  assert.equal(rc.state().unavailable, 0)
  for (let i = 0; i < 5; i++) { rc.failed('unavailable'); timers.advance(60000) }
  assert.notEqual(rc.state().phase, 'gaveup')
  rc.opened(); assert.equal(rc.state().unavailable, 0)
  const two = rcSetup({ opts: { maxUnavailable: 2 } })
  two.rc.start(); two.rc.failed('unavailable'); two.timers.advance(1000); two.rc.failed('unavailable')
  assert.equal(two.rc.state().phase, 'gaveup')
})

test("createReconnector：'fatal' / 'load' 失敗立刻放棄（不退避）並記下原因", () => {
  for (const kind of ['fatal', 'load']) {
    const { rc, timers } = rcSetup()
    rc.start(); rc.failed(kind)
    assert.deepEqual([rc.state().phase, rc.state().reason], ['gaveup', kind])
    assert.equal(timers.pending(), 0)
  }
})

test('createReconnector：stop 取消一切（計時器清掉、之後的失敗 / 成功 / 可見性都無效、不再通知）；可再 start（StrictMode）', () => {
  const { rc, timers, calls, changes } = rcSetup()
  rc.start(); rc.failed('closed')
  assert.equal(timers.pending(), 1)
  rc.stop()
  assert.equal(rc.state().phase, 'idle'); assert.equal(timers.pending(), 0)
  const n = changes.length
  rc.failed('closed'); rc.opened(); rc.visibility(true); rc.retryNow()
  timers.advance(100000)
  assert.equal(calls.length, 1); assert.equal(changes.length, n, '停止後沒有任何通知')
  rc.stop()                                                     // 重複 stop 無害
  assert.equal(rc.start(), true)
  assert.deepEqual([rc.state().phase, rc.state().n], ['connecting', 0])
  assert.deepEqual(calls, [0, 0])
})

test('createReconnector：attempt 丟例外 → 當作失敗（照常退避）；onChange 丟例外不影響狀態；isVisible 丟例外 → 當作看得到', () => {
  const t1 = rcSetup({ attemptThrows: true })
  assert.doesNotThrow(() => t1.rc.start())
  assert.deepEqual([t1.rc.state().phase, t1.rc.state().n], ['waiting', 1])
  const { timers, setTimer, clearTimer } = timerPair()
  const rc = createReconnector({ attempt: () => {}, onChange: () => { throw new Error('listener boom') }, isVisible: () => { throw new Error('vis boom') }, setTimer, clearTimer })
  assert.doesNotThrow(() => rc.start())
  rc.failed('closed')
  assert.equal(rc.state().phase, 'waiting'); assert.equal(timers.pending(), 1)
})

test('createReconnector：onChange 依序通知每個狀態變化（connecting → connected → waiting → connecting…）', () => {
  const { rc, changes, timers } = rcSetup()
  rc.start(); rc.opened(); rc.failed('closed'); timers.advance(1000)
  assert.deepEqual(changes.map((s) => s.phase), ['connecting', 'connected', 'waiting', 'connecting'])
})

test('createReconnector：預設計時器是「裸函式包一層」——換成會檢查 this 的假全域計時器也能用', () => {
  const timers = makeTimers()
  const restore = installTimers(timers)
  try {
    let n = 0
    const rc = createReconnector({ attempt: () => { n++ } })
    rc.start(); rc.failed('closed')
    assert.equal(timers.pending(), 1)
    timers.advance(1000)
    assert.equal(n, 2)
    rc.stop()
    assert.equal(timers.pending(), 0)
    // 對照組：把假計時器掛在物件上呼叫，假環境確實會丟 Illegal invocation
    const holder = { setTimeout: timers.setTimeout }
    assert.throws(() => holder.setTimeout(() => {}, 1), /Illegal invocation/)
  } finally { restore() }
})

// =============================================================================================
// 連線層（createRemoteLink）
// =============================================================================================
test('createRemoteLink：初次連線——建一個 Peer、註冊完成（open）才 peer.connect(hostId, { reliable:true })、連線 open → connected 並 onOpen({ reconnect:false })', async () => {
  const e = setup()
  assert.equal(e.link.start(), true)
  assert.equal(e.link.start(), false, '重複 start 無效')
  assert.equal(e.phase(), 'connecting')
  await flush()
  assert.equal(e.peers.length, 1)
  assert.equal(e.peers[0].conns.length, 0, 'Peer 還沒向訊號伺服器註冊完：先不連')
  e.peers[0].doOpen()
  assert.equal(e.peers[0].conns.length, 1)
  const c = e.peers[0].conns[0]
  assert.equal(c.peer, 'host1'); assert.deepEqual(c.opts, { reliable: true })
  assert.equal(e.link.isOpen(), false)
  c.doOpen()
  assert.equal(e.phase(), 'connected'); assert.equal(e.link.state().ever, true)
  assert.deepEqual(e.opens.map((o) => o.reconnect), [false])
  assert.equal(e.opens[0].c, c)
  assert.equal(e.link.isOpen(), true); assert.equal(e.link.conn(), c)
  assert.equal(e.link.send({ t: 'p', pid: 'glow', v: 0.5 }), true)
  assert.deepEqual(c.sent, [{ t: 'p', pid: 'glow', v: 0.5 }])
  assert.equal(e.timers.pending(), 0, '連上後沒有殘留的計時器（逾時已清）')
  c.doData({ t: 'sync' })
  assert.deepEqual(e.datas, [[{ t: 'sync' }, c]])
})

test('createRemoteLink：send 在連線不可用時回 false、不丟例外（含 conn.send 自己丟例外）', async () => {
  const e = setup()
  assert.equal(e.link.send({ t: 'x' }), false, '還沒連')
  const c = await e.up()
  c.send = function send() { throw new Error('send boom') }
  assert.equal(e.link.send({ t: 'x' }), false)
  c.doClose()
  assert.equal(e.link.send({ t: 'x' }), false)
  assert.equal(e.link.conn(), null); assert.equal(e.link.isOpen(), false)
})

test('createRemoteLink：連線掉了 → 1 秒後用「同一個 Peer」重連（不多建 Peer）；舊連線殘留的 close / error / data 事件不影響新連線；重連成功 onOpen({ reconnect:true })、計數歸零', async () => {
  const e = setup()
  const c1 = await e.up()
  c1.doClose()
  assert.deepEqual([e.phase(), e.n()], ['waiting', 1])
  e.timers.advance(999); assert.equal(e.peers[0].conns.length, 1)
  e.timers.advance(1)
  assert.equal(e.peers.length, 1, '沒有多建 Peer'); assert.equal(e.peers[0].conns.length, 2)
  assert.deepEqual([e.phase(), e.n()], ['connecting', 1])
  const c2 = e.peers[0].conns[1]
  c2.doOpen()
  assert.deepEqual([e.phase(), e.n()], ['connected', 0])
  assert.deepEqual(e.opens.map((o) => o.reconnect), [false, true])
  c1.fire('close'); c1.fire('error'); c1.fire('data', { t: 'stale' }); c1.fire('open')     // 舊連線遲到的事件
  assert.equal(e.phase(), 'connected'); assert.equal(e.link.conn(), c2)
  assert.equal(e.datas.length, 0, '舊連線的資料不轉發')
  assert.equal(e.opens.length, 2, '舊連線遲到的 open 不會再觸發 onOpen')
  assert.equal(e.peers[0].live().length, 1)
})

test('連續失敗的退避序列 1、2、4、8、15、15、15 秒；每次重試前先收掉上一條嘗試中的連線（同時最多一條活連線）', async () => {
  const e = setup()
  const c = await e.up()
  c.doClose()
  let conns = 1
  for (const [i, w] of [1000, 2000, 4000, 8000, 15000, 15000, 15000].entries()) {
    assert.deepEqual([e.phase(), e.n()], ['waiting', i + 1])
    e.timers.advance(w - 1); assert.equal(e.peers[0].conns.length, conns, `第 ${i + 1} 次重試不能早於 ${w}ms`)
    e.timers.advance(1); conns++
    assert.equal(e.peers[0].conns.length, conns)
    assert.equal(e.peers[0].live().length, 1, '同時最多一條活連線')
    e.peers[0].lastConn().doError()                     // 這次嘗試（連線還沒 open）失敗
  }
  assert.equal(e.peers.length, 1, '整個過程只有一個 Peer')
})

test('peer-unavailable 連續 6 次 → 放棄（gaveup / unavailable）：不再排計時器、不再建連線；每次嘗試的連線都被收掉；之後回到前景 / 網路恢復也不再重試', async () => {
  const e = setup()
  e.link.start(); await flush()
  const p = e.peers[0]
  p.doOpen()
  for (let i = 1; i <= 6; i++) {
    assert.equal(p.conns.length, i)
    p.doUnavailable()                                    // 主畫面的 host id 已不存在（主畫面重新載入）
    if (i < 6) { assert.deepEqual([e.phase(), e.n()], ['waiting', i]); e.timers.advance(backoffMs(i)) }
  }
  assert.equal(e.phase(), 'gaveup'); assert.equal(e.link.state().reason, 'unavailable')
  assert.equal(e.timers.pending(), 0)
  assert.equal(p.conns.length, 6); assert.equal(p.live().length, 0, '沒有殘留的連線')
  assert.equal(p.destroyed, true, '放棄後 Peer 也釋放掉（不佔著訊號伺服器上的 id）')
  e.timers.advance(600000); e.doc.setVisible(false); e.doc.setVisible(true); e.win.fire('online'); e.win.fire('pageshow')
  assert.equal(p.conns.length, 6)
  assert.equal(e.link.isOpen(), false)
  assert.equal(e.peers.length, 1)
})

test('peer-unavailable 中間夾一次別種失敗（連線逾時 / 錯誤）→ 連續計數重算，不會提早放棄', async () => {
  const e = setup()
  e.link.start(); await flush()
  const p = e.peers[0]; p.doOpen()
  const wait = () => e.timers.advance(backoffMs(e.n()))    // 剛好等到下一次嘗試（不多等：多等會撞上連線逾時，逾時也是「別種失敗」）
  for (let i = 1; i <= 5; i++) { p.doUnavailable(); wait() }
  assert.equal(e.link.state().unavailable, 5)
  p.lastConn().doError(); wait()                          // 別種失敗
  assert.equal(e.link.state().unavailable, 0)
  for (let i = 1; i <= 5; i++) { p.doUnavailable(); wait() }
  assert.notEqual(e.phase(), 'gaveup')
  p.doUnavailable()
  assert.equal(e.phase(), 'gaveup')
})

test('已連上時晚到的 peer-unavailable（更早一次嘗試的回音）不理；成功一次後計數歸零', async () => {
  const e = setup()
  e.link.start(); await flush()
  const p = e.peers[0]; p.doOpen()
  for (let i = 1; i <= 3; i++) { p.doUnavailable(); e.timers.advance(backoffMs(e.n())) }
  assert.equal(e.link.state().unavailable, 3)
  p.lastConn().doOpen()
  assert.equal(e.phase(), 'connected'); assert.equal(e.link.state().unavailable, 0)
  p.doUnavailable()
  assert.equal(e.phase(), 'connected', '已連上：不理')
})

test('頁面在背景：掉線後不排重試（paused）、等待中的計時器被取消；回到前景立刻重試一次', async () => {
  const e = setup()
  const c1 = await e.up()
  const p = e.peers[0]
  e.doc.setVisible(false)
  c1.doClose()
  assert.deepEqual([e.phase(), e.n()], ['paused', 1]); assert.equal(e.timers.pending(), 0)
  e.timers.advance(3600000); assert.equal(p.conns.length, 1, '背景中不重試')
  e.doc.setVisible(true)
  assert.equal(p.conns.length, 2, '回到前景立刻重試')
  assert.equal(e.phase(), 'connecting')
  p.lastConn().doError()                                   // 這次也失敗（前景）→ 排 2 秒
  assert.deepEqual([e.phase(), e.n()], ['waiting', 2]); assert.equal(e.timers.pending(), 1)
  e.doc.setVisible(false)
  assert.equal(e.phase(), 'paused'); assert.equal(e.timers.pending(), 0)
  e.timers.advance(60000); assert.equal(p.conns.length, 2)
  e.doc.setVisible(true)
  assert.equal(p.conns.length, 3)
  p.lastConn().doOpen()
  assert.equal(e.phase(), 'connected')
})

test('嘗試進行中轉背景：這次嘗試若失敗 → paused（不排計時器）；網路恢復（online）/ pageshow 也會立刻重試', async () => {
  const e = setup()
  const c1 = await e.up()
  const p = e.peers[0]
  c1.doClose(); e.timers.advance(1000)                     // 前景重試中
  assert.equal(e.phase(), 'connecting')
  e.doc.setVisible(false)
  p.lastConn().doError()
  assert.equal(e.phase(), 'paused'); assert.equal(e.timers.pending(), 0)
  e.doc.visibilityState = 'visible'; e.win.fire('online')
  assert.equal(p.conns.length, 3, 'online 事件 → 立刻重試')
  p.lastConn().doError()
  assert.equal(e.phase(), 'waiting')
  e.win.fire('pageshow')
  assert.equal(p.conns.length, 4, 'pageshow（bfcache 恢復）→ 立刻重試')
})

test('訊號伺服器斷線：資料通道還開著就不動它；連線真的斷了 → 重試時先 peer.reconnect()，等 open 再 peer.connect（同一個 Peer）', async () => {
  const e = setup()
  const c1 = await e.up()
  const p = e.peers[0]
  p.doDisconnect()
  assert.equal(e.phase(), 'connected'); assert.equal(c1.closed, 0, '資料通道還活著：不關它')
  assert.equal(e.link.send({ t: 'x' }), true)
  c1.doClose()
  assert.deepEqual([e.phase(), e.n()], ['waiting', 1])
  e.timers.advance(1000)
  assert.equal(p.reconnects, 1); assert.equal(p.conns.length, 1, '等訊號重新註冊完成才連')
  assert.equal(e.phase(), 'connecting')
  p.doOpen()
  assert.equal(p.conns.length, 2)
  p.lastConn().doOpen()
  assert.equal(e.phase(), 'connected'); assert.equal(e.peers.length, 1)
})

test('訊號斷線時連線還在建立中 → 這次嘗試立刻作廢（不等逾時）；下次重試 reconnect 後再連', async () => {
  const e = setup()
  e.link.start(); await flush()
  const p = e.peers[0]; p.doOpen()
  const c1 = p.lastConn()
  p.doDisconnect()
  assert.deepEqual([e.phase(), e.n()], ['waiting', 1]); assert.equal(c1.dead, true)
  e.timers.advance(1000)
  assert.equal(p.reconnects, 1)
  p.doOpen(); p.lastConn().doOpen()
  assert.equal(e.phase(), 'connected')
})

test('重新註冊本身失敗（reconnect 之後又斷線）→ 繼續退避重試，不會卡住或重複計數', async () => {
  const e = setup()
  const c1 = await e.up(); const p = e.peers[0]
  p.doDisconnect(); c1.doClose()
  e.timers.advance(1000); assert.equal(p.reconnects, 1)
  p.doDisconnect()                                         // reconnect 失敗：又是 disconnected
  assert.deepEqual([e.phase(), e.n()], ['waiting', 2])
  e.timers.advance(2000); assert.equal(p.reconnects, 2)
  p.doOpen(); p.lastConn().doOpen()
  assert.equal(e.phase(), 'connected')
})

test('Peer 被銷毀 → 同一次掉線只算一次；下一次嘗試重建 Peer', async () => {
  const e = setup()
  await e.up()
  e.peers[0].destroy()
  assert.deepEqual([e.phase(), e.n()], ['waiting', 1], 'disconnected + close + peer close 只算一次')
  assert.equal(e.timers.pending(), 1)
  e.timers.advance(1000); await flush()
  assert.equal(e.peers.length, 2)
  e.peers[1].doOpen(); e.peers[1].lastConn().doOpen()
  assert.equal(e.phase(), 'connected'); assert.equal(e.opens.at(-1).reconnect, true)
  assert.equal(e.peers.filter((p) => !p.destroyed).length, 1)
})

test('連線嘗試逾時（PeerJS 對從未 open 的連線不會發 close）：逾時 → 收掉連線、退避重試；Peer 已註冊就沿用', async () => {
  const e = setup()
  e.link.start(); await flush()
  const p = e.peers[0]; p.doOpen()
  const c1 = p.lastConn()
  e.timers.advance(CONNECT_TIMEOUT_MS - 1); assert.equal(e.phase(), 'connecting')
  e.timers.advance(1)
  assert.deepEqual([e.phase(), e.n()], ['waiting', 1]); assert.equal(c1.dead, true)
  assert.equal(p.destroys, 0, 'Peer 已註冊：沿用')
  e.timers.advance(1000)
  assert.equal(e.peers.length, 1); assert.equal(p.conns.length, 2)
})

test('向訊號伺服器註冊卡住（Peer 一直沒 open）→ 逾時後銷毀那個 Peer、下次重建', async () => {
  const e = setup()
  e.link.start(); await flush()
  const stuck = e.peers[0]
  e.timers.advance(CONNECT_TIMEOUT_MS)
  assert.equal(stuck.destroys, 1); assert.equal(e.phase(), 'waiting')
  e.timers.advance(1000); await flush()
  assert.equal(e.peers.length, 2)
  e.peers[1].doOpen(); e.peers[1].lastConn().doOpen()
  assert.equal(e.phase(), 'connected')
  assert.equal(e.peers.filter((p) => !p.destroyed).length, 1)
})

test('Peer 建立時的錯誤（sync 例外 / Promise reject / 回傳空）→ gaveup:load（載入失敗，不再重試）並帶原因；致命錯誤（browser-incompatible…）→ gaveup:fatal', async () => {
  const a = setup({ makePeer: () => { throw new Error('boom sync') } })
  a.link.start()
  assert.deepEqual([a.phase(), a.link.state().reason, a.link.state().detail], ['gaveup', 'load', 'boom sync'])
  const b = setup({ makePeer: () => Promise.reject(new Error('chunk failed')) })
  b.link.start(); await flush()
  assert.deepEqual([b.phase(), b.link.state().reason, b.link.state().detail], ['gaveup', 'load', 'chunk failed'])
  const c = setup({ makePeer: () => Promise.resolve(null) })
  c.link.start(); await flush()
  assert.equal(c.phase(), 'gaveup')
  assert.equal(c.timers.pending(), 0)
  const e = setup()
  e.link.start(); await flush(); e.peers[0].doOpen()
  e.peers[0].fire('error', { type: 'browser-incompatible' })
  assert.deepEqual([e.phase(), e.link.state().reason, e.link.state().detail], ['gaveup', 'fatal', 'browser-incompatible'])
  assert.equal(e.timers.pending(), 0)
})

test("unavailable-id（重新註冊時舊 id 被占走）→ 銷毀該 Peer、下次重建新的；其他 peer 錯誤（network / server-error…）在連線還活著時不動它", async () => {
  const e = setup()
  const c1 = await e.up(); const p = e.peers[0]
  p.fire('error', { type: 'network', message: 'Lost connection to server.' })
  p.fire('error', { type: 'server-error' })
  assert.equal(e.phase(), 'connected'); assert.equal(c1.closed, 0)
  c1.fire('error', new Error('MessageToBig'))              // 已 open 的連線上不致命的 error：忽略（真的壞了會有 close）
  assert.equal(e.phase(), 'connected')
  c1.doClose(); e.timers.advance(1000)
  p.doDisconnect()                                         // 連線嘗試中訊號又斷 → 排 2 秒後重試
  p.fire('error', { type: 'unavailable-id' })              // reconnect 時舊 id 被占走
  assert.equal(p.destroyed, true)
  assert.deepEqual([e.phase(), e.n()], ['waiting', 2], '同一次失敗只算一次')
  e.timers.advance(2000); await flush()
  assert.equal(e.peers.length, 2, '重建了新的 Peer')
  e.peers[1].doOpen(); e.peers[1].lastConn().doOpen()
  assert.equal(e.phase(), 'connected')
})

test('stop()：進行中的非同步建立作廢（晚到的 Peer 被銷毀）、doc / win 監聽與計時器全部移除、之後不再有任何 callback', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const made = []
  const e = setup({ makePeer: () => gate.then(() => { const p = makePeerFake(); made.push(p); return p }) })
  e.link.start()
  assert.equal(e.doc.count() + e.win.count(), 3, 'visibilitychange + online + pageshow')
  e.link.stop()
  assert.equal(e.doc.count() + e.win.count(), 0)
  const notified = e.states.length
  release(); await flush(); await flush()
  assert.equal(made.length, 1); assert.equal(made[0].destroyed, true, '晚到的 Peer 立刻銷毀，不留下沒人管的 Peer')
  assert.equal(made[0].conns.length, 0)
  assert.equal(e.timers.pending(), 0)
  e.doc.setVisible(false); e.doc.setVisible(true); e.win.fire('online')
  assert.equal(e.states.length, notified, '停止後沒有任何通知')
  e.link.stop()                                            // 重複 stop 無害
  assert.equal(e.link.state().phase, 'idle')
})

test('stop()（已連線）：關連線、銷毀 Peer、清逾時 / 探測計時器；不再回應任何事件', async () => {
  const e = setup()
  const c = await e.up()
  e.doc.setVisible(false); e.doc.setVisible(true)          // 起了一個死連線探測計時器
  assert.equal(e.timers.pending(), 1)
  e.link.stop()
  assert.equal(c.closed >= 1, true); assert.equal(e.peers[0].destroyed, true)
  assert.equal(e.timers.pending(), 0); assert.equal(e.doc.count() + e.win.count(), 0)
  const n = e.states.length, o = e.opens.length
  c.fire('close'); c.fire('data', { t: 'x' }); c.fire('open')
  e.peers[0].fire('error', { type: 'network' }); e.peers[0].fire('open')
  assert.equal(e.states.length, n); assert.equal(e.opens.length, o); assert.equal(e.datas.length, 0)
  assert.equal(e.link.send({ t: 'x' }), false)
})

test('StrictMode 的 start / stop / start：只剩一個 Peer、一條連線、一組監聽（同步連續呼叫時，第一次晚到的 Peer 也被銷毀）', async () => {
  const e = setup()
  e.link.start(); e.link.stop(); e.link.start()             // effect 跑兩次的形狀：makePeer 兩次都還在進行中
  await flush()
  assert.equal(e.peers.length, 2)
  assert.equal(e.peers.filter((p) => !p.destroyed).length, 1, '過期的那個被銷毀')
  const live = e.peers.find((p) => !p.destroyed)
  live.doOpen(); live.lastConn().doOpen()
  assert.equal(e.phase(), 'connected')
  assert.equal(e.doc.count() + e.win.count(), 3, '只有一組監聽')
  e.link.stop()
  assert.ok(e.peers.every((p) => p.destroyed))
  assert.equal(e.doc.count() + e.win.count(), 0)
  assert.equal(e.timers.pending(), 0)
  // 已連線後 stop → start：重新從頭開始（新 Peer）
  e.link.start(); await flush()
  assert.equal(e.peers.length, 3)
  assert.equal(e.link.state().ever, false, '重新 start 是全新的一次連線')
  e.link.stop()
})

test('回到前景的死連線探測：連線看似開著、卻 4 秒內沒收到主畫面的任何訊息 → 當死連線、退避重連；收到訊息就保留', async () => {
  const e = setup()
  const c = await e.up()
  e.doc.setVisible(false)
  assert.equal(e.timers.pending(), 0, '背景中不探測')
  e.doc.setVisible(true)
  assert.equal(e.timers.pending(), 1)
  e.timers.advance(RESUME_PROBE_MS - 1); assert.equal(e.phase(), 'connected')
  e.timers.advance(1)
  assert.deepEqual([e.phase(), e.n()], ['waiting', 1]); assert.equal(c.dead, true)
  e.timers.advance(1000)
  const c2 = e.peers[0].lastConn(); c2.doOpen()
  assert.equal(e.phase(), 'connected')
  e.doc.setVisible(false); e.doc.setVisible(true)
  e.timers.advance(1000); c2.doData({ t: 'sync', params: {} })          // 主畫面每秒推一次 sync
  e.timers.advance(RESUME_PROBE_MS)
  assert.equal(e.phase(), 'connected', '有收到訊息：連線是活的')
  assert.equal(c2.dead, false)
  // 網路恢復（online）也會探測
  e.win.fire('online')
  assert.equal(e.timers.pending(), 1)
  e.timers.advance(RESUME_PROBE_MS)
  assert.equal(e.phase(), 'waiting')
})

test('探測期間又進背景 → 不當死連線（背景中 JS 可能被凍結，沒訊息是正常的）', async () => {
  const e = setup()
  await e.up()
  e.doc.setVisible(false); e.doc.setVisible(true)
  e.doc.setVisible(false)
  e.timers.advance(RESUME_PROBE_MS * 3)
  assert.equal(e.phase(), 'connected')
})

test('callback 丟例外（onOpen / onData / onChange）不影響連線', async () => {
  const e = setup({ opts: { onOpen: () => { throw new Error('open boom') }, onData: () => { throw new Error('data boom') }, onChange: () => { throw new Error('change boom') } } })
  e.link.start(); await flush()
  assert.doesNotThrow(() => { e.peers[0].doOpen(); e.peers[0].lastConn().doOpen(); e.peers[0].lastConn().doData({ t: 'x' }) })
  assert.equal(e.phase(), 'connected')
})

test('peer.connect 回傳空 / 丟例外 → 當作失敗、退避重試；訊號斷線時 connect 發的 error 與回傳空不會重複計數', async () => {
  const e = setup()
  e.link.start(); await flush()
  const p = e.peers[0]
  p.disconnected = true                                    // 訊號已斷、但 Peer 的 open 事件仍被送達（競態）：connect 會回 undefined 並發 error
  p.fire('open')
  assert.deepEqual([e.phase(), e.n()], ['waiting', 1], 'error 事件與回傳空只算一次失敗')
  assert.equal(e.timers.pending(), 1, '只排一個計時器')
  const e2 = setup()
  e2.link.start(); await flush()
  const q = e2.peers[0]
  q.connect = function connect() { throw new Error('connect boom') }
  q.doOpen()
  assert.deepEqual([e2.phase(), e2.n()], ['waiting', 1])
})

test('原生函式一律以方法呼叫：假 Peer / 連線 / document 會檢查 this（對照組：脫離原物件呼叫會丟 Illegal invocation）', () => {
  const p = makePeerFake(); const f = p.connect
  assert.throws(() => f('h'), /Illegal invocation/)
  const d = makeDoc(); const add = d.addEventListener
  assert.throws(() => add('x', () => {}), /Illegal invocation/)
  const c = makeConnFake('h'); const cl = c.close
  assert.throws(() => cl(), /Illegal invocation/)
})

test('預設計時器是「裸函式包一層」：不傳 setTimer / clearTimer，換成會檢查 this 的假全域計時器也能用', async () => {
  const timers = makeTimers()
  const restore = installTimers(timers)
  try {
    const doc = makeDoc(), win = makeDoc(); const peers = []
    const link = createRemoteLink({ hostId: 'h', makePeer: () => { const p = makePeerFake(); peers.push(p); return p }, env: { doc, win } })   // makePeer 也可以直接回傳 Peer（不必是 Promise）
    link.start(); await flush()
    assert.equal(timers.pending(), 1, '連線逾時計時器')
    peers[0].doOpen(); peers[0].lastConn().doOpen()
    assert.equal(timers.pending(), 0)
    peers[0].lastConn().doClose()
    assert.equal(timers.pending(), 1)
    link.stop()
    assert.equal(timers.pending(), 0)
  } finally { restore() }
})

test('env 沒給時在 start() 當下才讀全域 document / window（import 時不碰；Node 沒有就當作看得到、不掛監聽）', async () => {
  const { timers, setTimer, clearTimer } = timerPair()
  assert.equal(typeof document, 'undefined')
  const peers = []
  const link = createRemoteLink({ hostId: 'h', makePeer: () => { const p = makePeerFake(); peers.push(p); return p }, setTimer, clearTimer })
  assert.doesNotThrow(() => link.start())
  await flush()
  peers[0].doOpen(); peers[0].lastConn().doOpen()
  peers[0].lastConn().doClose()
  assert.equal(link.state().phase, 'waiting', '沒有 document：當作看得到')
  link.stop()
  assert.equal(timers.pending(), 0)
})

// =============================================================================================
// host 端小工具
// =============================================================================================
test('staleConns：同一個 peer id 的其他連線；沒有 peer id / 不同 peer id / 壞輸入 → 空', () => {
  const a = { peer: 'x' }, b = { peer: 'x' }, c = { peer: 'y' }, d = {}
  assert.deepEqual(staleConns([a, b, c, d], b), [a])
  assert.deepEqual(staleConns([a, b, c], c), [])
  assert.deepEqual(staleConns([a, b, d], d), [], '沒有 peer id 的連線不去重')
  for (const bad of [null, undefined, 'x', 5, {}]) assert.deepEqual(staleConns(bad, a), [])
  assert.deepEqual(staleConns([a], null), [])
  assert.deepEqual(staleConns([a, null, undefined, b], b), [a])
})

test('createPeerMemory：peer id → 值；重複 set 更新並算最新；超過上限丟掉最舊的（有界）；clear 清空；空 id 不記', () => {
  assert.equal(PEER_MEMORY_MAX, 64)
  const m = createPeerMemory(3)
  m.set('a', 1); m.set('b', 2); m.set('c', 3)
  assert.deepEqual([m.has('a'), m.get('b'), m.size()], [true, 2, 3])
  m.set('a', 10)                                          // a 變成最新
  m.set('d', 4)                                           // 超過上限 → 丟掉最舊的 b
  assert.deepEqual([m.has('b'), m.get('a'), m.has('c'), m.has('d'), m.size()], [false, 10, true, true, 3])
  m.set('', 1); m.set(null, 1); m.set(undefined, 1); m.set(5, 1)
  assert.equal(m.size(), 3)
  m.clear(); assert.equal(m.size(), 0); assert.equal(m.has('a'), false)
  const big = createPeerMemory()
  for (let i = 0; i < 500; i++) big.set('p' + i, i)
  assert.equal(big.size(), PEER_MEMORY_MAX)
  assert.equal(createPeerMemory(0).size(), 0)
})

// =============================================================================================
// 輕量（遙控頁不能被拖重）
// =============================================================================================
test('遙控頁保持輕量：remoteReconnect.js / wakeLockLite.js 沒有任何 import（不碰 three / store / PeerJS 本體 / lib/wakeLock.js）', () => {
  assert.deepEqual(importsOf(src('./remoteReconnect.js')), [])
  assert.deepEqual(importsOf(src('./wakeLockLite.js')), [])
  const code = src('./remoteReconnect.js')
  assert.doesNotMatch(code, /import\s*\(/, '不動態 import（Peer 由呼叫端用 makePeer 交進來）')
  assert.doesNotMatch(code, /window\.|localStorage/, 'import 時 / 執行時都不直接碰 window / localStorage（env 可注入）')
})
