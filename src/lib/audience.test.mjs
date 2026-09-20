import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROTO_V, PING_MS, MAX_MISSED, HELLO_MS, PROBE_AFTER_MS, HOST_LOST_MS, PAD_MIRROR,
  isMsg, createHost, createAudience, createCoreSlices, createStatusStore, tapPush, pickGovOptionId,
  buildAudienceUrl, pickAudienceScreen, popupFeatures, requestScreens, planAudienceOpen, queryWindowPermission, readScreenInfo,
} from './audience.js'

// ───────────── 測試替身：假 channel 匯流排 / 假時鐘 / 假切片 / 假 store ─────────────
function makeBus() {
  const chs = []
  return {
    create() {
      const ch = {
        onmessage: null, closed: false, sent: [],
        postMessage(m) {
          if (ch.closed) throw new Error('closed')
          ch.sent.push(m)
          const data = structuredClone(m)              // 與真 BroadcastChannel 一樣：結構化複製、不回送給自己
          for (const o of chs) if (o !== ch && !o.closed && typeof o.onmessage === 'function') o.onmessage({ data })
        },
        close() { ch.closed = true },
      }
      chs.push(ch)
      return ch
    },
  }
}
function makeClock() {
  let now = 0, id = 0
  const timers = new Map()
  return {
    now: () => now,
    timers: {
      setTimeout: (fn, ms) => { const i = ++id; timers.set(i, { fn, at: now + ms, ms, iv: false }); return i },
      clearTimeout: (i) => { timers.delete(i) },
      setInterval: (fn, ms) => { const i = ++id; timers.set(i, { fn, at: now + ms, ms, iv: true }); return i },
      clearInterval: (i) => { timers.delete(i) },
    },
    advance(ms) {
      const end = now + ms
      for (;;) {
        let next = null
        for (const [i, t] of timers) if (t.at <= end && (!next || t.at < next.t.at)) next = { i, t }
        if (!next) break
        now = next.t.at
        if (next.t.iv) next.t.at += next.t.ms; else timers.delete(next.i)
        next.t.fn()
      }
      now = end
    },
    pending: () => timers.size,
  }
}
function makeSlice(initial, extra = {}) {
  let value = initial
  const cbs = new Set()
  const s = {
    subCount: 0, applied: [],
    get: () => value,
    apply(v, meta) { s.applied.push([v, meta]) },
    subscribe(cb) { cbs.add(cb); s.subCount++; return () => { cbs.delete(cb); s.subCount-- } },
    set(v) { value = v; for (const f of [...cbs]) f() },
    ...extra,
  }
  return s
}
// 假 zustand：getState / setState / subscribe(listener(state, prev))
function makeStore(init = {}) {
  let s = {
    params: { a: 0.5, b: 0.2 }, rec: { mode: 'idle', playhead: 0, duration: 0, speed: 1, loop: false, count: 0 },
    spawns: { whale: 0, dolphin: 0, turtle: 0, purify: 0 }, overlays: { board: true, hud: true, qr: true },
    govOptionId: null, surveyMonth: null, calls: [], ...init,
  }
  const subs = new Set()
  const store = {
    getState: () => s,
    setState(p) { const patch = typeof p === 'function' ? p(s) : p; const prev = s; s = { ...s, ...patch }; for (const f of [...subs]) f(s, prev) },
    subscribe(f) { subs.add(f); return () => { subs.delete(f) } },
  }
  s.applyParams = (partial) => { s.calls.push('applyParams'); store.setState((st) => ({ params: { ...st.params, ...partial } })) }
  s.input = () => { s.calls.push('input') }
  s.setOverlay = () => { s.calls.push('setOverlay') }
  return store
}
const SERIES_KEYS = ['active', 'kind', 'name', 'label', 'unit', 'date', 'step', 'points', 'target', 'extra', 'lunar', 'lunarLabel', 'range', 'events']
const makeSeriesMeta = () => ({ active: false, kind: '', name: '', label: '', unit: '', date: '', step: 1.1, points: [], target: '', extra: {}, lunar: '', lunarLabel: '', range: '', events: [] })

// 主視窗端（原始 channel 當「觀眾」）：收集收到的訊息
function rawAudience(bus, id, { pong = false } = {}) {
  const ch = bus.create()
  const inbox = []
  ch.onmessage = (e) => {
    inbox.push(e.data)
    if (pong && e.data.type === 'ping') ch.postMessage({ v: PROTO_V, type: 'pong', id, host: e.data.host })
  }
  const hello = () => ch.postMessage({ v: PROTO_V, type: 'hello', id })
  const bye = () => ch.postMessage({ v: PROTO_V, type: 'bye', id })
  const of = (type) => inbox.filter((m) => m.type === type)
  return { ch, inbox, hello, bye, of, id }
}
function setupHost(slicesObj, extra = {}) {
  const bus = makeBus(), clock = makeClock()
  const registry = new Map(Object.entries(slicesObj))
  const hostCh = bus.create()
  const changes = []
  const host = createHost({ channel: hostCh, listSlices: () => [...registry], now: clock.now, timers: clock.timers, hostId: 'H1', onChange: (s) => changes.push(s), ...extra })
  return { bus, clock, registry, hostCh, host, changes }
}

// ───────────── 協定：訊息驗證 ─────────────
test('isMsg：版本相符且有 type 才算；版本不符 / 非物件 / 缺 type 一律不算', () => {
  assert.equal(isMsg({ v: PROTO_V, type: 'hello' }), true)
  assert.equal(isMsg({ v: PROTO_V + 1, type: 'hello' }), false)
  assert.equal(isMsg({ type: 'hello' }), false)
  assert.equal(isMsg({ v: PROTO_V }), false)
  assert.equal(isMsg(null), false)
  assert.equal(isMsg('hello'), false)
})

// ───────────── host ─────────────
test('host：沒有觀眾視窗時零成本（不訂閱、沒有計時器、不送任何訊息）', () => {
  const a = makeSlice(1)
  const { clock, hostCh, host } = setupHost({ a })
  clock.advance(60000)
  assert.equal(a.subCount, 0)
  assert.equal(clock.pending(), 0)
  assert.equal(hostCh.sent.length, 0)
  assert.equal(host.count(), 0)
  assert.equal(host.isActive(), false)
})

test('host：hello → 啟動訂閱與 ping、回完整快照（含所有切片，跳過 snapshot:false）', () => {
  const a = makeSlice({ x: 1 }), b = makeSlice('zh'), ev = makeSlice([1], { snapshot: false, dedupe: false })
  const { bus, clock, host, changes } = setupHost({ a, b, ev })
  const aud = rawAudience(bus, 'a1')
  aud.hello()
  assert.equal(host.count(), 1)
  assert.equal(host.isActive(), true)
  assert.equal(a.subCount, 1); assert.equal(b.subCount, 1); assert.equal(ev.subCount, 1)
  assert.equal(clock.pending(), 1)                               // 只有 ping 計時器
  const snap = aud.of('snapshot')
  assert.equal(snap.length, 1)
  assert.equal(snap[0].v, PROTO_V); assert.equal(snap[0].host, 'H1')
  assert.deepEqual(snap[0].slices, { a: { x: 1 }, b: 'zh' })       // 事件型切片不進快照
  assert.deepEqual(changes.at(-1), { count: 1, active: true })
})

test('host：增量節流——領先緣立即送、之後同一段時間內只補送「最新值」一次、內容沒變不送', () => {
  const a = makeSlice(0, { hz: 10 })                              // 每 100ms 最多一次
  const { bus, clock } = setupHost({ a })
  const aud = rawAudience(bus, 'a1'); aud.hello()
  const slices = () => aud.of('slice').map((m) => m.value)
  a.set(1)
  assert.deepEqual(slices(), [1])                                 // 領先緣：立刻送
  clock.advance(10); a.set(2); clock.advance(10); a.set(3)
  assert.deepEqual(slices(), [1])                                 // 節流中：先不送
  clock.advance(80)
  assert.deepEqual(slices(), [1, 3])                              // 尾端補送最新值，2 被吃掉
  a.set(3); clock.advance(300)
  assert.deepEqual(slices(), [1, 3])                              // 內容相同 → 不送
  clock.advance(200); a.set(4)
  assert.deepEqual(slices(), [1, 3, 4])                           // 過了一段時間 → 又是領先緣立即送
})

test('host：頻率上限依各切片的 hz（30Hz 比 10Hz 密）', () => {
  const fast = makeSlice(0, { hz: 30 }), slow = makeSlice(0, { hz: 10 })
  const { bus, clock } = setupHost({ fast, slow })
  const aud = rawAudience(bus, 'a1'); aud.hello()
  for (let i = 1; i <= 30; i++) { clock.advance(10); fast.set(i); slow.set(i) }   // 300ms 內每 10ms 變一次
  const count = (k) => aud.of('slice').filter((m) => m.key === k).length
  assert.ok(count('fast') >= 8 && count('fast') <= 11, 'fast=' + count('fast'))
  assert.ok(count('slow') >= 3 && count('slow') <= 4, 'slow=' + count('slow'))
})

test('host：事件型切片（dedupe:false）每次都送、get() 回傳 undefined 就不送', () => {
  const queue = []
  const pad = makeSlice(undefined, { hz: 30, dedupe: false, snapshot: false, get: () => (queue.length ? queue.splice(0) : undefined) })
  const { bus, clock } = setupHost({ pad })
  const aud = rawAudience(bus, 'a1'); aud.hello()
  queue.push({ ev: 1 }); pad.set()
  clock.advance(100)
  queue.push({ ev: 1 }); pad.set()                                // 內容和上一次完全相同，仍要送
  clock.advance(100)
  pad.set(); clock.advance(100)                                   // 空的：不送
  assert.deepEqual(aud.of('slice').map((m) => m.value), [[{ ev: 1 }], [{ ev: 1 }]])
})

test('host：版本不符 / 格式錯誤 / 別的主視窗的訊息一律忽略', () => {
  const a = makeSlice(1)
  const { bus, host } = setupHost({ a })
  const raw = bus.create()
  raw.postMessage({ v: PROTO_V + 1, type: 'hello', id: 'x' })          // 版本不符
  raw.postMessage({ v: PROTO_V, type: 'hello' })                        // 沒有 id
  raw.postMessage({ v: PROTO_V, type: 'hello', id: '' })                // 空 id
  raw.postMessage({ v: PROTO_V, type: 'hello', id: 'y'.repeat(200) })   // 超長 id
  raw.postMessage({ v: PROTO_V, type: 'hello', id: 'z', host: 'OTHER' })// 指名別的主視窗
  raw.postMessage({ v: PROTO_V, type: 'wat', id: 'w' })                 // 未知類型
  raw.postMessage('hello'); raw.postMessage(null); raw.postMessage(42)
  assert.equal(host.count(), 0)
  assert.equal(a.subCount, 0)
})

test('host：多個觀眾視窗——各自計數、快照對 hello 重送、最後一個離開才收掉訂閱與計時器', () => {
  const a = makeSlice(1)
  const { bus, clock, host, changes } = setupHost({ a })
  const a1 = rawAudience(bus, 'a1'), a2 = rawAudience(bus, 'a2')
  a1.hello(); a2.hello()
  assert.equal(host.count(), 2)
  assert.equal(a.subCount, 1)                                     // 訂閱只有一份，不隨觀眾數增加
  a1.hello()                                                       // 同一個觀眾重複 hello（重新要快照）不會重複計數
  assert.equal(host.count(), 2)
  assert.ok(a2.of('snapshot').length >= 2)                         // 廣播：另一個觀眾也收得到快照（重複無害）
  a1.bye()
  assert.equal(host.count(), 1); assert.equal(host.isActive(), true); assert.equal(a.subCount, 1)
  a2.bye()
  assert.equal(host.count(), 0); assert.equal(host.isActive(), false)
  assert.equal(a.subCount, 0); assert.equal(clock.pending(), 0)
  assert.deepEqual(changes.at(-1), { count: 0, active: false })
})

test('host：斷線偵測——回 pong 的觀眾留著，連續 MAX_MISSED 次 ping 沒回的觀眾被踢掉（回報 count）', () => {
  const a = makeSlice(1)
  const { bus, clock, host } = setupHost({ a })
  const alive = rawAudience(bus, 'alive', { pong: true }), dead = rawAudience(bus, 'dead')
  alive.hello(); dead.hello()
  assert.equal(host.count(), 2)
  clock.advance(PING_MS * MAX_MISSED)
  assert.equal(host.count(), 2)                                   // 還沒到門檻
  clock.advance(PING_MS)
  assert.equal(host.count(), 1)                                   // dead 被踢
  assert.ok(alive.of('ping').length >= MAX_MISSED)
  assert.equal(host.isActive(), true)
  clock.advance(PING_MS * 20)
  assert.equal(host.count(), 1)                                   // alive 一直活著
})

test('host：所有觀眾都斷線 → 自動收掉訂閱與計時器（沒人連時零成本）', () => {
  const a = makeSlice(1)
  const { bus, clock, host } = setupHost({ a })
  const dead = rawAudience(bus, 'dead'); dead.hello()
  clock.advance(PING_MS * (MAX_MISSED + 2))
  assert.equal(host.count(), 0); assert.equal(host.isActive(), false)
  assert.equal(a.subCount, 0); assert.equal(clock.pending(), 0)
})

test('host：未知 id 的 pong（例如主視窗重整後，觀眾還在回應）當成 hello——登記並回快照', () => {
  const a = makeSlice(7)
  const { bus, host } = setupHost({ a })
  const raw = rawAudience(bus, 'ghost')
  raw.ch.postMessage({ v: PROTO_V, type: 'pong', id: 'ghost' })
  assert.equal(host.count(), 1)
  assert.deepEqual(raw.of('snapshot')[0].slices, { a: 7 })
})

test('host：任意切片——啟動後才註冊的切片在下一次探測被接上並送出目前值；移除的切片被取消訂閱', () => {
  const a = makeSlice(1)
  const { bus, clock, registry, host } = setupHost({ a })
  const aud = rawAudience(bus, 'a1', { pong: true }); aud.hello()
  const late = makeSlice('L', { hz: 20 })
  registry.set('late', late)
  assert.equal(late.subCount, 0)
  clock.advance(PING_MS)
  assert.equal(late.subCount, 1)
  assert.deepEqual(aud.of('slice').filter((m) => m.key === 'late').map((m) => m.value), ['L'])
  late.set('L2')
  clock.advance(60)                                               // 剛送過 → 節流 50ms 後補送
  assert.equal(aud.of('slice').filter((m) => m.key === 'late').at(-1).value, 'L2')
  registry.delete('a')
  clock.advance(PING_MS)
  assert.equal(a.subCount, 0)                                     // 已從註冊表移除 → 拆掉
  const late2 = makeSlice('N')                                    // 同一個 key 換成新的切片物件 → 換訂閱
  registry.set('late', late2)
  clock.advance(PING_MS)
  assert.equal(late.subCount, 0); assert.equal(late2.subCount, 1)
  assert.equal(host.count(), 1)
  // 新觀眾中途加入：快照含所有目前切片
  const a3 = rawAudience(bus, 'a3'); a3.hello()
  assert.deepEqual(a3.of('snapshot')[0].slices, { late: 'N' })
})

test('host：沒有 subscribe 的切片改以 hz 輪詢 get()，內容沒變不送', () => {
  let v = 1
  const poll = { hz: 10, get: () => v, apply() {} }                // 沒有 subscribe
  const { bus, clock } = setupHost({ poll })
  const aud = rawAudience(bus, 'a1', { pong: true }); aud.hello()
  clock.advance(500)
  assert.equal(aud.of('slice').length, 0)                         // 快照已含 1 → 沒變不送
  v = 2; clock.advance(150)
  assert.deepEqual(aud.of('slice').map((m) => m.value), [2])
  clock.advance(1000)
  assert.equal(aud.of('slice').length, 1)
})

test('host：get() 丟例外的壞切片不影響其他切片', () => {
  const bad = makeSlice(0, { get: () => { throw new Error('boom') } })
  const good = makeSlice('ok')
  const { bus } = setupHost({ bad, good })
  const aud = rawAudience(bus, 'a1'); aud.hello()
  assert.deepEqual(aud.of('snapshot')[0].slices, { good: 'ok' })
  bad.set(1); good.set('ok2')
  assert.equal(aud.of('slice').filter((m) => m.key === 'good').at(-1).value, 'ok2')
})

test('host：closeAudiences 廣播 close；destroy 收乾淨（訂閱 / 計時器 / channel）', () => {
  const a = makeSlice(1)
  const { bus, clock, host, hostCh } = setupHost({ a })
  const aud = rawAudience(bus, 'a1'); aud.hello()
  host.closeAudiences()
  assert.equal(aud.of('close').length, 1)
  host.destroy()
  assert.equal(a.subCount, 0); assert.equal(clock.pending(), 0); assert.equal(hostCh.closed, true)
  aud.hello()                                                     // 已銷毀：不再回應
  assert.equal(host.count(), 0)
})

// ───────────── audience ─────────────
function setupAudience(opts = {}) {
  const bus = makeBus(), clock = makeClock()
  const applied = [], statuses = [], closes = []
  const ch = bus.create()
  const peer = bus.create()                                       // 模擬主視窗端的原始 channel
  const peerInbox = []
  peer.onmessage = (e) => peerInbox.push(e.data)
  const aud = createAudience({
    channel: ch, id: 'A1', now: clock.now, timers: clock.timers,
    apply: (key, value, meta) => { applied.push([key, value, meta]) },
    onStatus: (s) => statuses.push(s.state), onClose: () => closes.push(1), ...opts,
  })
  const fromHost = (m, host = 'H1') => peer.postMessage({ v: PROTO_V, host, ...m })
  return { bus, clock, aud, applied, statuses, closes, peer, peerInbox, fromHost, ch }
}

test('audience：收到第一個快照前為 waiting，每秒喊一次 hello（主視窗可能還沒載入完）', () => {
  const { aud, clock, peerInbox } = setupAudience()
  aud.start()
  assert.equal(aud.getStatus().state, 'waiting')
  assert.equal(peerInbox.filter((m) => m.type === 'hello').length, 1)
  clock.advance(HELLO_MS * 3)
  assert.equal(peerInbox.filter((m) => m.type === 'hello').length, 4)
  assert.equal(peerInbox[0].id, 'A1'); assert.equal(peerInbox[0].v, PROTO_V); assert.ok(!('host' in peerInbox[0]))
})

test('audience：快照依序套用（meta.snapshot=true）→ live；之後的 slice 增量套用（snapshot=false）', () => {
  const { aud, applied, statuses, fromHost, clock, peerInbox } = setupAudience()
  aud.start()
  fromHost({ type: 'snapshot', slices: { params: { a: 1 }, series: { active: false }, rec: { mode: 'idle' } } })
  assert.deepEqual(applied.map((x) => x[0]), ['params', 'series', 'rec'])
  assert.ok(applied.every((x) => x[2].snapshot === true))
  assert.equal(aud.getStatus().state, 'live'); assert.equal(aud.getStatus().hostId, 'H1')
  fromHost({ type: 'slice', key: 'params', value: { a: 2 } })
  assert.deepEqual(applied.at(-1), ['params', { a: 2 }, { snapshot: false }])
  assert.deepEqual(statuses, ['live'])
  clock.advance(HELLO_MS * 2)                                     // 已同步且主視窗沒沉默 → 不再 hello
  assert.equal(peerInbox.filter((m) => m.type === 'hello').length, 1)
})

test('audience：版本不符、沒有 host 欄位（觀眾之間互傳）、未同步就來的 slice 一律忽略', () => {
  const { aud, applied, peer, fromHost } = setupAudience()
  aud.start()
  peer.postMessage({ v: PROTO_V + 1, host: 'H1', type: 'snapshot', slices: { params: 1 } })
  peer.postMessage({ v: PROTO_V, type: 'snapshot', slices: { params: 1 } })                 // 沒有 host
  peer.postMessage({ v: PROTO_V, id: 'A2', type: 'hello' })                                  // 別的觀眾
  peer.postMessage({ v: PROTO_V, id: 'A2', host: 'H1', type: 'pong' })
  fromHost({ type: 'slice', key: 'params', value: 1 })                                       // 還沒收到快照
  assert.equal(applied.length, 0)
  assert.equal(aud.getStatus().state, 'waiting')
})

test('audience：收到 ping 回 pong（帶 host id）；不是自己鎖定的主視窗的 ping 不理', () => {
  const { aud, fromHost, peerInbox } = setupAudience()
  aud.start()
  fromHost({ type: 'snapshot', slices: {} })
  fromHost({ type: 'ping', n: 1 })
  const pong = peerInbox.filter((m) => m.type === 'pong')
  assert.equal(pong.length, 1); assert.equal(pong[0].id, 'A1'); assert.equal(pong[0].host, 'H1')
  fromHost({ type: 'ping', n: 1 }, 'H2')
  assert.equal(peerInbox.filter((m) => m.type === 'pong').length, 1)
})

test('audience：主視窗沉默 → 3 秒重新 hello（不鎖定）、5 秒顯示 lost；新主視窗的快照 → 換鎖、重新 live（主視窗重整能自我修復）', () => {
  const { aud, clock, applied, statuses, fromHost, peerInbox } = setupAudience()
  aud.start()
  fromHost({ type: 'snapshot', slices: { params: { a: 1 } } })
  const hellos = () => peerInbox.filter((m) => m.type === 'hello')
  assert.equal(hellos().length, 1)
  clock.advance(PROBE_AFTER_MS - 500)
  assert.equal(hellos().length, 1)
  clock.advance(1500)                                              // 沉默 > 3s
  assert.ok(hellos().length >= 2)
  assert.ok(!('host' in hellos().at(-1)), '探測用 hello 不帶 host（誰都可以回）')
  assert.equal(aud.getStatus().state, 'live')                      // 還沒到 5 秒
  clock.advance(HOST_LOST_MS - PROBE_AFTER_MS + 1000)
  assert.equal(aud.getStatus().state, 'lost')
  fromHost({ type: 'snapshot', slices: { params: { a: 9 } } }, 'H2')   // 主視窗重整後 id 變了
  assert.equal(aud.getStatus().state, 'live'); assert.equal(aud.getStatus().hostId, 'H2')
  assert.deepEqual(applied.at(-1), ['params', { a: 9 }, { snapshot: true }])
  assert.deepEqual(statuses, ['live', 'lost', 'live'])
})

test('audience：鎖定第一個主視窗——別的主視窗的快照 / 增量 / close 被忽略', () => {
  const { aud, applied, fromHost, closes } = setupAudience()
  aud.start()
  fromHost({ type: 'snapshot', slices: { params: 1 } }, 'H1')
  fromHost({ type: 'snapshot', slices: { params: 2 } }, 'H2')
  fromHost({ type: 'slice', key: 'params', value: 3 }, 'H2')
  fromHost({ type: 'close' }, 'H2')
  assert.deepEqual(applied.map((x) => x[1]), [1])
  assert.equal(closes.length, 0)
  fromHost({ type: 'close' }, 'H1')
  assert.equal(closes.length, 1)
})

test('audience：一個切片 apply 丟例外，不影響同一份快照裡的其他切片', () => {
  const seen = []
  const { aud, fromHost } = setupAudience({ apply: (key, value) => { if (key === 'bad') throw new Error('boom'); seen.push(key) } })
  aud.start()
  fromHost({ type: 'snapshot', slices: { a: 1, bad: 2, c: 3 } })
  assert.deepEqual(seen, ['a', 'c'])
  assert.equal(aud.getStatus().state, 'live')
})

test('audience：stop → 送 bye、關 channel、清計時器，之後不再處理訊息', () => {
  const { aud, clock, peerInbox, fromHost, applied, ch } = setupAudience()
  aud.start()
  aud.stop()
  assert.equal(peerInbox.filter((m) => m.type === 'bye').length, 1)
  assert.equal(ch.closed, true); assert.equal(clock.pending(), 0)
  fromHost({ type: 'snapshot', slices: { a: 1 } })
  assert.equal(applied.length, 0)
  aud.stop()                                                      // 重複 stop 無害
  assert.equal(peerInbox.filter((m) => m.type === 'bye').length, 1)
})

// ───────────── 主視窗 + 觀眾視窗（假 channel 全流程）─────────────
test('全流程：多觀眾視窗、中途載入補快照、主視窗重整自我修復、事件型切片不補放', () => {
  const bus = makeBus(), clock = makeClock()
  const hostStore = makeStore(), hostSeries = makeSeriesMeta(), hostPad = []
  const hostSlices = createCoreSlices({ store: hostStore, seriesMeta: hostSeries, purifyMeta: { v: 1 }, padEvents: hostPad, locale: { get: () => 'zh', set() {}, subscribe: () => () => {} } })
  const registry = () => hostSlices
  const mkHost = (id) => createHost({ channel: bus.create(), listSlices: registry, now: clock.now, timers: clock.timers, hostId: id })
  const mkAud = (id) => {
    const store = makeStore({ params: { a: 0, b: 0 } }), seriesMeta = makeSeriesMeta(), padEvents = []
    const slices = new Map(createCoreSlices({ store, seriesMeta, purifyMeta: { v: 1 }, padEvents, locale: { get: () => 'zh', set() {}, subscribe: () => () => {} } }))
    const aud = createAudience({ channel: bus.create(), id, now: clock.now, timers: clock.timers, apply: (k, v, m) => { const s = slices.get(k); if (s) s.apply(v, m) } })
    return { store, seriesMeta, padEvents, aud }
  }
  let host = mkHost('H1')
  const A = mkAud('A1'); A.aud.start()
  assert.equal(host.count(), 1)
  assert.deepEqual(A.store.getState().params, { a: 0.5, b: 0.2 })   // 快照套用了主視窗的參數
  hostStore.getState().applyParams({ a: 0.9 })
  assert.equal(A.store.getState().params.a, 0.9)                    // 增量
  const B = mkAud('B1'); B.aud.start()                              // 中途載入的第二個觀眾視窗
  assert.equal(host.count(), 2)
  assert.equal(B.store.getState().params.a, 0.9)
  hostStore.getState().applyParams({ b: 0.7 }); clock.advance(100)
  assert.equal(A.store.getState().params.b, 0.7); assert.equal(B.store.getState().params.b, 0.7)
  // 主視窗「重整」：舊 host 直接消失（沒送 bye），新 host（新 id）出現，觀眾 3 秒內重新 hello → 補快照
  host.destroy()
  host = mkHost('H2')
  hostStore.setState({ params: { a: 0.1, b: 0.1 } })
  clock.advance(PROBE_AFTER_MS + HELLO_MS)
  assert.equal(host.count(), 2)
  assert.deepEqual(A.store.getState().params, { a: 0.1, b: 0.1 })
  assert.equal(A.aud.getStatus().hostId, 'H2')
  A.aud.stop(); B.aud.stop(); host.destroy()
})

// ───────────── 核心切片 ─────────────
const noLocale = { get: () => 'zh', set() {}, subscribe: () => () => {} }
const coreOf = (deps) => new Map(createCoreSlices({ locale: noLocale, purifyMeta: { v: 1 }, seriesMeta: makeSeriesMeta(), ...deps }))

test('核心切片：註冊順序（series 先於 rec）與 key 集合', () => {
  const keys = createCoreSlices({ store: makeStore(), seriesMeta: makeSeriesMeta(), purifyMeta: { v: 1 }, padEvents: [], locale: noLocale }).map((e) => e[0])
  assert.deepEqual(keys, ['locale', 'overlays', 'gov', 'params', 'series', 'rec', 'spawns', 'pad'])
  assert.ok(keys.indexOf('series') < keys.indexOf('rec'))
  const noPad = createCoreSlices({ store: makeStore(), seriesMeta: makeSeriesMeta(), locale: noLocale }).map((e) => e[0])
  assert.ok(!noPad.includes('pad'))
})

test('params 切片：get 是 JSON 純值；apply 走 applyParams（不走 input）；subscribe 只在 params 換了才通知', () => {
  const store = makeStore()
  const p = coreOf({ store }).get('params')
  assert.deepEqual(JSON.parse(JSON.stringify(p.get())), { a: 0.5, b: 0.2 })
  assert.equal(p.hz, 30)
  p.apply({ a: 0.8 })
  assert.deepEqual(store.getState().calls, ['applyParams'])       // 沒呼叫 input（否則會寫進錄製、觸發 soft-takeover）
  assert.equal(store.getState().params.a, 0.8)
  let n = 0
  const off = p.subscribe(() => { n++ })
  store.setState({ rec: { ...store.getState().rec, playhead: 1 } })    // 別的欄位變了
  assert.equal(n, 0)
  store.setState({ params: { a: 1, b: 1 } })
  assert.equal(n, 1)
  off(); store.setState({ params: { a: 0, b: 0 } })
  assert.equal(n, 1)
  p.apply(null); p.apply('x')                                        // 壞資料不丟例外
})

test('gov 切片：只同步選項 id 與月份；不合法的值忽略；不呼叫 applyGov', () => {
  const store = makeStore({ govOptionId: 'feitsui', surveyMonth: 3 })
  const g = coreOf({ store }).get('gov')
  assert.deepEqual(g.get(), { id: 'feitsui', month: 3 })
  g.apply({ id: 'hualien-tide', month: null })
  assert.equal(store.getState().govOptionId, 'hualien-tide'); assert.equal(store.getState().surveyMonth, null)
  g.apply({ id: 42, month: 99 })
  assert.equal(store.getState().govOptionId, 'hualien-tide'); assert.equal(store.getState().surveyMonth, null)
  g.apply({ id: null, month: 11 })                                   // 主視窗還沒載入資料（id 為 null）不覆蓋觀眾端已有的選項
  assert.equal(store.getState().govOptionId, 'hualien-tide'); assert.equal(store.getState().surveyMonth, 11)
  assert.deepEqual(store.getState().calls, [])
})

test('overlays 切片：直接 setState，不走 setOverlay（它會寫兩個視窗共用的 localStorage）', () => {
  const store = makeStore()
  const o = coreOf({ store }).get('overlays')
  o.apply({ board: false, hud: true, qr: 0 })
  assert.deepEqual(store.getState().overlays, { board: false, hud: true, qr: false })
  assert.deepEqual(store.getState().calls, [])
  assert.deepEqual(o.get(), { board: false, hud: true, qr: false })
})

test('locale 切片：只接受 zh / en', () => {
  const set = []
  const l = new Map(createCoreSlices({ store: makeStore(), seriesMeta: makeSeriesMeta(), locale: { get: () => 'en', set: (v) => set.push(v), subscribe: () => () => {} } })).get('locale')
  assert.equal(l.get(), 'en')
  l.apply('zh'); l.apply('fr'); l.apply(null); l.apply('en')
  assert.deepEqual(set, ['zh', 'en'])
})

test('series 切片：播放中整份 seriesMeta 可經 JSON 往返；沒在播只送 {active:false}；缺的欄位還原成空值', () => {
  const host = makeSeriesMeta()
  const hostSlice = coreOf({ store: makeStore(), seriesMeta: host }).get('series')
  assert.deepEqual(hostSlice.get(), { active: false })
  Object.assign(host, { active: true, kind: 'tide', name: '花蓮', label: '潮位', unit: 'cm', date: '2026-09-20', step: 1.1, points: [{ h: 0, v: 10 }, { h: 1, v: 30 }], extra: { lunar: 'x', days: [1, 2] }, lunar: 'x' })
  const wire = JSON.parse(JSON.stringify(hostSlice.get()))
  const aud = makeSeriesMeta(); aud.events = [{ stale: true }]; aud.range = 'stale'
  const audSlice = coreOf({ store: makeStore(), seriesMeta: aud }).get('series')
  audSlice.apply(wire)
  for (const k of SERIES_KEYS) assert.deepEqual(aud[k], host[k], k)
  assert.deepEqual(aud.events, []); assert.equal(aud.range, '')
  audSlice.apply({ active: false })
  assert.equal(aud.active, false)
  audSlice.apply({ active: true, points: 'nope' })                    // 壞資料 → 視為沒在播
  assert.equal(aud.active, false)
})

test('series 切片：seriesMeta 之後新增的欄位也會被帶過去；__proto__ 之類的危險 key 不會被套用', () => {
  const host = makeSeriesMeta()
  Object.assign(host, { active: true, points: [{ v: 1 }], gaps: [[2007, 2013]] })
  const wire = JSON.parse(JSON.stringify(coreOf({ store: makeStore(), seriesMeta: host }).get('series').get()))
  const aud = makeSeriesMeta()
  coreOf({ store: makeStore(), seriesMeta: aud }).get('series').apply(JSON.parse('{"active":true,"points":[],"gaps":[[2007,2013]],"__proto__":{"polluted":1},"constructor":"x"}'))
  assert.deepEqual(aud.gaps, wire.gaps)
  assert.equal(aud.polluted, undefined); assert.equal({}.polluted, undefined)
  assert.equal(typeof aud.constructor, 'function')
})

test('series 切片：訂閱時機是 rec 的 mode / duration 變化（seriesMeta 是可變物件，不會觸發 store）', () => {
  const store = makeStore()
  const s = coreOf({ store }).get('series')
  let n = 0
  s.subscribe(() => { n++ })
  store.setState({ params: { a: 1, b: 1 } }); assert.equal(n, 0)
  store.setState((st) => ({ rec: { ...st.rec, playhead: 5 } })); assert.equal(n, 0)    // 播放進度不觸發
  store.setState((st) => ({ rec: { ...st.rec, duration: 26 } })); assert.equal(n, 1)
  store.setState((st) => ({ rec: { ...st.rec, mode: 'playing' } })); assert.equal(n, 2)
})

test('rec 切片：播放中送 playhead；非播放固定 0（錄製中每幀都變、送了也沒用）；apply 只顯示不驅動', () => {
  const store = makeStore({ rec: { mode: 'playing', playhead: 3.14159, duration: 26.4, speed: 2, loop: true, count: 9, playIndex: 4 } })
  const r = coreOf({ store }).get('rec')
  assert.deepEqual(r.get(), { mode: 'playing', playhead: 3.142, speed: 2, loop: true, duration: 26.4 })
  store.setState((st) => ({ rec: { ...st.rec, mode: 'recording', playhead: 1 } }))
  const a = JSON.stringify(r.get())
  store.setState((st) => ({ rec: { ...st.rec, playhead: 2 } }))
  assert.equal(JSON.stringify(r.get()), a)                            // 錄製中 playhead 變了，送出內容不變 → 去重生效
  const aud = makeStore()
  const ar = coreOf({ store: aud }).get('rec')
  ar.apply({ mode: 'playing', playhead: 5.5, speed: 0, loop: 1, duration: 10, evil: true })
  assert.deepEqual(aud.getState().rec, { mode: 'playing', playhead: 5.5, speed: 1, loop: true, duration: 10, count: 0 })
  ar.apply({ mode: 'weird' }); assert.equal(aud.getState().rec.mode, 'idle')
})

test('spawns 切片：快照只當基準（中途連上不補放過去的訪客）；之後只加「增量」；主視窗重整（計數歸零）只重設基準；pv 帶淨化力度', () => {
  const host = makeStore({ spawns: { whale: 5, dolphin: 2, turtle: 0, purify: 3 } })
  const purifyHost = { v: 0.6 }
  const hs = coreOf({ store: host, purifyMeta: purifyHost }).get('spawns')
  assert.deepEqual(hs.get(), { whale: 5, dolphin: 2, turtle: 0, purify: 3, pv: 0.6 })
  const aud = makeStore(); const purifyAud = { v: 1 }
  const as = coreOf({ store: aud, purifyMeta: purifyAud }).get('spawns')
  as.apply(hs.get(), { snapshot: true })
  assert.deepEqual(aud.getState().spawns, { whale: 0, dolphin: 0, turtle: 0, purify: 0 })   // 沒有補放
  as.apply({ whale: 6, dolphin: 2, turtle: 0, purify: 4, pv: 0.9 }, { snapshot: false })
  assert.deepEqual(aud.getState().spawns, { whale: 1, dolphin: 0, turtle: 0, purify: 1 })
  assert.equal(purifyAud.v, 0.9)
  as.apply({ whale: 6, dolphin: 2, turtle: 0, purify: 4, pv: 0.9 }, { snapshot: false })    // 同樣的值不再增加
  assert.equal(aud.getState().spawns.whale, 1)
  as.apply({ whale: 0, dolphin: 0, turtle: 0, purify: 0, pv: 1 }, { snapshot: true })       // 主視窗重整：新快照
  as.apply({ whale: 1, dolphin: 0, turtle: 0, purify: 0, pv: 1 }, { snapshot: false })
  assert.equal(aud.getState().spawns.whale, 2)
  as.apply({ whale: 0, dolphin: 0, turtle: 0, purify: 0, pv: 5 })                            // 計數變小（沒收到快照的重整）：不倒退，只重設基準；pv 被夾在 0.2..1
  assert.equal(aud.getState().spawns.whale, 2)
  assert.equal(purifyAud.v, 1)
})

test('pad 切片：只收「純視覺」事件（5~10 由 spawns / params 同步）；get 取走並清空、空的回 undefined；apply 限長 40', () => {
  const padEvents = []
  const store = makeStore()
  const pad = coreOf({ store, padEvents }).get('pad')
  assert.equal(pad.dedupe, false); assert.equal(pad.snapshot, false)
  let n = 0
  const off = pad.subscribe(() => { n++ })
  padEvents.push({ ev: 2, bank: 1, vel: 0.5 }, { ev: 6, bank: 0, vel: 1 }, { ev: 15, bank: 3, vel: 0.123456 })
  assert.equal(n, 1)
  assert.equal(padEvents.length, 3)                                    // 原本的 push 行為不受影響
  padEvents.push({ ev: 6 }, { ev: 8 }, { ev: 9 }, { ev: 10 })          // 全是不鏡像的事件
  assert.equal(n, 1)
  assert.deepEqual(pad.get(), [{ ev: 2, bank: 1, vel: 0.5 }, { ev: 15, bank: 3, vel: 0.123 }])
  assert.equal(pad.get(), undefined)
  for (const e of [0, 1, 2, 3, 4, 11, 12, 13, 14, 15]) assert.ok(PAD_MIRROR.has(e))
  for (const e of [5, 6, 7, 8, 9, 10]) assert.ok(!PAD_MIRROR.has(e))
  off()
  padEvents.push({ ev: 2 }); assert.equal(n, 1)                        // 取消訂閱後不再收集
  assert.equal(Object.prototype.hasOwnProperty.call(padEvents, 'push'), false)   // push 還原（不留自己的屬性）
  // 觀眾端 apply
  const audPad = []
  const ap = coreOf({ store: makeStore(), padEvents: audPad }).get('pad')
  ap.apply([{ ev: 18, bank: 9, vel: 7 }, { ev: 'x' }, null, { ev: 3 }])
  assert.deepEqual(audPad, [{ ev: 2, bank: 3, vel: 1 }, { ev: 3, bank: 0, vel: 0.7 }])
  ap.apply(Array.from({ length: 200 }, () => ({ ev: 1 })))
  assert.ok(audPad.length <= 40)
})

test('tapPush：通知後照常 push；還原後恢復；被別人再包一層時只轉為直通（不破壞外層）', () => {
  const arr = []
  const seen = []
  const off = tapPush(arr, (items) => seen.push(items))
  assert.equal(arr.push(1, 2), 2); assert.deepEqual([...arr], [1, 2]); assert.deepEqual(seen, [[1, 2]])
  const off2 = tapPush(arr, () => {})                                  // 別人再包一層
  off()                                                                 // 我先還原：不能把別人的包裝拿掉
  arr.push(3)
  assert.deepEqual(seen, [[1, 2]])                                      // 我已停用
  assert.deepEqual([...arr], [1, 2, 3])
  off2()
  const arr2 = []
  const bad = tapPush(arr2, () => { throw new Error('x') })
  arr2.push(1); assert.deepEqual([...arr2], [1])                        // 通知函式丟例外不影響 push
  bad()
})

// ───────────── 狀態小倉庫 ─────────────
test('createStatusStore：值變了才通知；可取消訂閱', () => {
  const s = createStatusStore({ count: 0, active: false })
  let n = 0
  const off = s.subscribe(() => { n++ })
  s.set({ count: 0 }); assert.equal(n, 0)
  s.set({ count: 2, active: true }); assert.equal(n, 1)
  assert.deepEqual(s.get(), { count: 2, active: true })
  off(); s.set({ count: 3 }); assert.equal(n, 1)
})

// ───────────── 開視窗 / 螢幕偵測 ─────────────
const SCREEN_LAPTOP = { label: 'Built-in', left: 0, top: 0, width: 1440, height: 900, availLeft: 0, availTop: 25, availWidth: 1440, availHeight: 875, isPrimary: true, isInternal: true }
const SCREEN_PROJ = { label: 'Projector', left: 1440, top: 0, width: 1920, height: 1080, availLeft: 1440, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: false, isInternal: false }
const SCREEN_MON = { label: 'Monitor', left: -1920, top: 0, width: 1920, height: 1080, availLeft: -1920, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: false, isInternal: true }

test('pickAudienceScreen：挑不是目前視窗所在的螢幕；優先外接、其次非主要；只有一個螢幕 → null', () => {
  assert.equal(pickAudienceScreen({ screens: [SCREEN_LAPTOP, SCREEN_PROJ], currentScreen: SCREEN_LAPTOP }), SCREEN_PROJ)
  assert.equal(pickAudienceScreen({ screens: [SCREEN_LAPTOP, SCREEN_MON, SCREEN_PROJ], currentScreen: SCREEN_LAPTOP }), SCREEN_PROJ)   // 外接優先
  assert.equal(pickAudienceScreen({ screens: [SCREEN_LAPTOP, SCREEN_MON], currentScreen: SCREEN_LAPTOP }), SCREEN_MON)
  assert.equal(pickAudienceScreen({ screens: [SCREEN_LAPTOP, SCREEN_PROJ], currentScreen: SCREEN_PROJ }), SCREEN_LAPTOP)              // 控制台在投影機上 → 觀眾視窗放另一個
  assert.equal(pickAudienceScreen({ screens: [SCREEN_LAPTOP, SCREEN_PROJ], currentScreen: { ...SCREEN_PROJ } }), SCREEN_LAPTOP)      // currentScreen 是不同物件但幾何相同
  assert.equal(pickAudienceScreen({ screens: [SCREEN_LAPTOP], currentScreen: SCREEN_LAPTOP }), null)
  assert.equal(pickAudienceScreen({ screens: [], currentScreen: null }), null)
  assert.equal(pickAudienceScreen(null), null)
  assert.equal(pickAudienceScreen({ screens: [SCREEN_LAPTOP, SCREEN_PROJ] }), SCREEN_PROJ)                                             // 沒給 currentScreen
})

test('popupFeatures：有螢幕 → 放在該螢幕可用區域；沒有 → 一般彈出視窗尺寸', () => {
  assert.equal(popupFeatures(SCREEN_PROJ), 'popup,left=1440,top=0,width=1920,height=1080')
  assert.equal(popupFeatures(SCREEN_MON), 'popup,left=-1920,top=0,width=1920,height=1080')
  assert.equal(popupFeatures({ left: 10.4, top: 20.6, width: 800.2, height: 600 }), 'popup,left=10,top=21,width=800,height=600')   // 沒有 avail* 就用完整範圍
  assert.equal(popupFeatures(null), 'popup,width=1280,height=720')
})

test('requestScreens：不支援 / 被拒絕 / 其他錯誤 / 成功', async () => {
  assert.deepEqual(await requestScreens({}), { details: null, reason: 'unsupported' })
  assert.deepEqual(await requestScreens(null), { details: null, reason: 'unsupported' })
  const denied = { getScreenDetails: async () => { const e = new Error('no'); e.name = 'NotAllowedError'; throw e } }
  assert.deepEqual(await requestScreens(denied), { details: null, reason: 'denied' })
  const weird = { getScreenDetails: async () => { throw new Error('x') } }
  assert.deepEqual(await requestScreens(weird), { details: null, reason: 'error' })
  const details = { screens: [SCREEN_LAPTOP, SCREEN_PROJ], currentScreen: SCREEN_LAPTOP }
  assert.deepEqual(await requestScreens({ getScreenDetails: async () => details }), { details, reason: null })
})

test('planAudienceOpen：placed / single / 各種降級原因都給一般視窗 features', () => {
  const two = { details: { screens: [SCREEN_LAPTOP, SCREEN_PROJ], currentScreen: SCREEN_LAPTOP }, reason: null }
  const plan = planAudienceOpen(two)
  assert.equal(plan.placed, true); assert.equal(plan.screen, SCREEN_PROJ); assert.equal(plan.screens, 2)
  assert.equal(plan.features, 'popup,left=1440,top=0,width=1920,height=1080')
  const one = planAudienceOpen({ details: { screens: [SCREEN_LAPTOP], currentScreen: SCREEN_LAPTOP }, reason: null })
  assert.deepEqual([one.placed, one.reason, one.features], [false, 'single', 'popup,width=1280,height=720'])
  assert.equal(planAudienceOpen({ details: null, reason: 'denied' }).reason, 'denied')
  assert.equal(planAudienceOpen({ details: null, reason: 'unsupported' }).reason, 'unsupported')
  assert.equal(planAudienceOpen({ details: null, reason: 'error' }).placed, false)
  assert.equal(planAudienceOpen(null).reason, 'unsupported')
})

test('queryWindowPermission / readScreenInfo：先試新名稱再試舊名稱；已授權才有精確螢幕數，否則用 screen.isExtended', async () => {
  const perms = (states) => ({ navigator: { permissions: { query: async ({ name }) => { if (!(name in states)) throw new TypeError('bad name'); return { state: states[name] } } } } })
  assert.equal(await queryWindowPermission({}), 'unknown')
  assert.equal(await queryWindowPermission(perms({ 'window-management': 'prompt' })), 'prompt')
  assert.equal(await queryWindowPermission(perms({ 'window-placement': 'granted' })), 'granted')     // 舊版 Chrome
  assert.equal(await queryWindowPermission(perms({})), 'unknown')

  const details = { screens: [SCREEN_LAPTOP, SCREEN_PROJ], currentScreen: SCREEN_LAPTOP }
  const granted = { ...perms({ 'window-management': 'granted' }), getScreenDetails: async () => details, screen: { isExtended: true } }
  assert.deepEqual(await readScreenInfo(granted), { count: 2, extended: true, canPlace: true, permission: 'granted' })
  const prompt = { ...perms({ 'window-management': 'prompt' }), getScreenDetails: async () => { throw new Error('should not be called') }, screen: { isExtended: true } }
  assert.deepEqual(await readScreenInfo(prompt), { count: null, extended: true, canPlace: true, permission: 'prompt' })   // 不會跳權限提示
  assert.deepEqual(await readScreenInfo({ screen: { isExtended: false } }), { count: null, extended: false, canPlace: false, permission: 'unknown' })   // Safari / Firefox 沒有 getScreenDetails
  assert.deepEqual(await readScreenInfo({}), { count: null, extended: null, canPlace: false, permission: 'unknown' })
})

test('buildAudienceUrl / pickGovOptionId', () => {
  assert.equal(buildAudienceUrl({ origin: 'https://midisea.shyetech.com', pathname: '/' }), 'https://midisea.shyetech.com/?audience=1')
  assert.equal(buildAudienceUrl({ origin: 'http://localhost:5173', pathname: '/index.html' }), 'http://localhost:5173/index.html?audience=1')
  const gov = { defaultOption: 'feitsui', options: [{ id: 'feitsui' }, { id: 'hualien-tide' }] }
  assert.equal(pickGovOptionId(gov, 'hualien-tide'), 'hualien-tide')     // 主視窗已送來的選項優先
  assert.equal(pickGovOptionId(gov, 'gone'), 'feitsui')                  // 資料裡沒有 → 預設
  assert.equal(pickGovOptionId(gov, null), 'feitsui')
  assert.equal(pickGovOptionId({ options: [{ id: 'a' }] }, null), 'a')
  assert.equal(pickGovOptionId(null, 'x'), null)
})

// ───────────── 與真實 store 對接（形狀 / 觸發時機）─────────────
test('真實 store：核心切片的 get 全是 JSON 純值，spawn / purify / 資料播放 / 停止都會觸發對應切片', async () => {
  const { useStore, seriesMeta } = await import('../store/useStore.js')
  const { purifyMeta, padEvents } = await import('../store/events.js')
  const slices = new Map(createCoreSlices({ store: useStore, seriesMeta, purifyMeta, padEvents, locale: noLocale }))
  for (const [k, sl] of slices) { const v = sl.get(); if (v !== undefined) assert.deepEqual(JSON.parse(JSON.stringify(v)), v, k) }
  const hits = { spawns: 0, series: 0, rec: 0, params: 0, overlays: 0 }
  const offs = Object.keys(hits).map((k) => slices.get(k).subscribe(() => { hits[k]++ }))
  const st = useStore.getState()
  st.spawnWhale()
  assert.equal(hits.spawns, 1)
  assert.equal(slices.get('spawns').get().whale, 1)
  st.purify(0.5)
  assert.equal(slices.get('spawns').get().pv, 0.5); assert.equal(slices.get('spawns').get().purify, 1)
  st.setParam('hue', 0.31)
  assert.ok(hits.params >= 1)
  const spec = { kind: 'tide', name: 'T', label: 'L', unit: 'cm', date: '2026-01-01', step: 1.1, target: 'seaLevel', points: [{ h: 0, v: 1 }, { h: 1, v: 5 }, { h: 2, v: 3 }], stats: { min: 1, max: 5, mean: 3 }, extra: { lunar: '', lunarLabel: '', range: '', events: [] } }
  assert.equal(st.playSeries(spec), true)
  assert.ok(hits.series >= 1); assert.ok(hits.rec >= 1)
  const wire = JSON.parse(JSON.stringify(slices.get('series').get()))
  assert.equal(wire.active, true); assert.equal(wire.points.length, 3); assert.equal(wire.kind, 'tide')
  assert.equal(slices.get('rec').get().mode, 'playing')
  assert.equal(slices.get('rec').get().duration, 3 * 1.1)
  st.stopPlayback()
  assert.deepEqual(slices.get('series').get(), { active: false })
  assert.equal(slices.get('rec').get().mode, 'idle')
  // 觀眾端套用（同一個 store 上驗證 apply 的形狀相容）：不會寫進錄製、也不會觸發 soft-takeover 相關狀態
  slices.get('params').apply({ hue: 0.9, notAParam: 3 })
  assert.equal(useStore.getState().params.hue, 0.9)
  assert.equal('notAParam' in useStore.getState().params, false)
  slices.get('rec').apply({ mode: 'playing', playhead: 2, speed: 1, loop: false, duration: 5 })
  assert.equal(useStore.getState().rec.mode, 'playing'); assert.equal(useStore.getState().rec.playhead, 2)
  slices.get('overlays').apply({ board: false, hud: true, qr: true })
  assert.equal(useStore.getState().overlays.board, false)
  offs.forEach((f) => f())
})

// ───────────── 真的 BroadcastChannel（Node 內建）往返 ─────────────
test('真實 BroadcastChannel：hello → 快照 → 增量 → bye（主視窗 / 觀眾視窗兩個 channel 物件）', async (t) => {
  if (typeof BroadcastChannel === 'undefined') return t.skip('no BroadcastChannel')
  const name = 'midisea-audience-test-' + Math.random().toString(36).slice(2)
  const hostStore = makeStore(), audStore = makeStore({ params: { a: 0, b: 0 } })
  const mk = (store) => new Map(createCoreSlices({ store, seriesMeta: makeSeriesMeta(), purifyMeta: { v: 1 }, locale: noLocale }))
  const hostSlices = mk(hostStore), audSlices = mk(audStore)
  const host = createHost({ channel: new BroadcastChannel(name), listSlices: () => [...hostSlices], hostId: 'HR' })
  const aud = createAudience({ channel: new BroadcastChannel(name), id: 'AR', apply: (k, v, m) => { const s = audSlices.get(k); if (s) s.apply(v, m) } })
  const until = async (fn, ms = 2000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)) } }
  try {
    aud.start()
    await until(() => host.count() === 1 && aud.getStatus().state === 'live')
    assert.deepEqual(audStore.getState().params, { a: 0.5, b: 0.2 })
    hostStore.getState().applyParams({ a: 0.75 })
    await until(() => audStore.getState().params.a === 0.75)
    aud.stop()
    await until(() => host.count() === 0)
    assert.equal(host.isActive(), false)
  } finally {
    aud.stop(); host.destroy()
  }
})

// ───────────── 回歸：瀏覽器的計時器不能被當成物件方法呼叫 ─────────────
// 瀏覽器的 setTimeout / setInterval 要求 this 是 window（或 undefined）；把它們存成 { setInterval: globalThis.setInterval } 再 T.setInterval() 呼叫，
// 會丟 TypeError: Illegal invocation，整個觀眾視窗掛掉。Node 不檢查 this，所以這裡把全域計時器換成「會檢查 this」的版本再跑一次預設路徑。
test('預設計時器在瀏覽器的 this 規則下可用（回歸：Illegal invocation）', async (t) => {
  if (typeof BroadcastChannel === 'undefined') return t.skip('no BroadcastChannel')
  const names = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
  const saved = Object.fromEntries(names.map((n) => [n, globalThis[n]]))
  for (const n of names) {
    const orig = saved[n]
    globalThis[n] = function strictThis(...a) {
      if (this !== undefined && this !== globalThis) throw new TypeError(`Illegal invocation: ${n}`)
      return orig(...a)
    }
  }
  const name = 'midisea-audience-strict-' + Math.random().toString(36).slice(2)
  let host, aud
  try {
    // 要在「換掉全域計時器之後」才載入一份新的模組：模組載入時就把 setInterval 存進物件的舊寫法，才會抓到被換過的（會檢查 this 的）版本
    const fresh = await import('./audience.js?strict=' + Math.random().toString(36).slice(2))
    host = fresh.createHost({ channel: new BroadcastChannel(name), listSlices: () => [], hostId: 'HS' })
    aud = fresh.createAudience({ channel: new BroadcastChannel(name), id: 'AS', apply() {} })
    aud.start()                                   // 會呼叫 T.setInterval（hello 重試）
    await new Promise((r) => saved.setTimeout(r, 80))
    aud.stop()
  } finally {
    for (const n of names) globalThis[n] = saved[n]
    if (aud) aud.stop()
    if (host) host.destroy()
  }
})
