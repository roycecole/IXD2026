// WebXR 桌面放置的純邏輯測試（node:test）：特徵偵測、放置數學、hit-test 追蹤、狀態機。
// navigator.xr / session / 計時器 / 時鐘全部用假物件注入；真機行為（實際的 hit-test、渲染）無法在這裡驗證，見回報的 manualVerification。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  XR_PLACE, isActiveStatus, xrMaybeSupported, detectXrAr, buildSessionInit, classifyXrError, pickReferenceSpaceType,
  xrScaleFor, isHorizontalHit, facingYaw, computePlacement, createHitTracker, overlayHint, endNotice,
  createXrController, getXrController,
} from './xr.js'

const SHELL = 2.02

// ---- 假物件 ----
function makeClock() {
  let t = 0, id = 0
  const timers = new Map()
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const k = ++id; timers.set(k, { at: t + ms, fn }); return k },
    clearTimeout: (k) => { timers.delete(k) },
    pending: () => timers.size,
    advance(ms) {
      t += ms
      for (const [k, v] of [...timers]) if (v.at <= t) { timers.delete(k); v.fn() }
    },
  }
}
function fakeSession(opts = {}) {
  const ls = new Map()
  const s = {
    enabledFeatures: opts.features,
    endCalls: 0,
    addEventListener(type, f) { if (!ls.has(type)) ls.set(type, new Set()); ls.get(type).add(f) },
    removeEventListener(type, f) { if (ls.has(type)) ls.get(type).delete(f) },
    listenerCount: (type) => (ls.has(type) ? ls.get(type).size : 0),
    fireEnd() { for (const f of [...(ls.get('end') || [])]) f({ type: 'end' }) },
    async end() {
      s.endCalls++
      if (opts.endHangs) return new Promise(() => {})
      if (opts.endRejects) throw Object.assign(new Error('already ended'), { name: 'InvalidStateError' })
      s.fireEnd()
    },
  }
  return s
}
const xrError = (name, message = name) => Object.assign(new Error(message), { name })
function fakeNav({ supported, session, reject, deferred } = {}) {
  const xr = {
    calls: [],
    isSessionSupported: async (mode) => { xr.asked = mode; if (supported instanceof Error) throw supported; return supported },
    requestSession(mode, init) {
      xr.calls.push([mode, init])
      if (deferred) return new Promise((resolve, reject2) => { deferred.resolve = resolve; deferred.reject = reject2 })
      return reject ? Promise.reject(reject) : Promise.resolve(session)
    },
  }
  return { xr }
}
// 矩陣（column-major）：平移到 (x,y,z)；up = Y 軸方向（預設朝上 = 水平面）
const mat = (x, y, z, up = [0, 1, 0]) => [1, 0, 0, 0, up[0], up[1], up[2], 0, 0, 0, 1, 0, x, y, z, 1]
const HIT = mat(1, 0.7, -2)
const make = (nav, clk = makeClock(), extra = {}) => {
  const c = createXrController({ nav: () => nav, now: clk.now, setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout, ...extra })
  return { c, clk }
}
const tick = () => new Promise((r) => setImmediate(r))

// ---------- 特徵偵測 ----------
test('detect：沒有 navigator / 沒有 xr / xr 沒有 isSessionSupported → 不支援（iOS Safari 就是沒有 xr）', async () => {
  assert.equal(xrMaybeSupported(undefined), false)
  assert.equal(xrMaybeSupported({}), false)
  assert.equal(xrMaybeSupported({ xr: {} }), false)
  assert.equal(xrMaybeSupported({ xr: { isSessionSupported() {} } }), true)
  assert.equal(await detectXrAr({}), false)
  assert.equal(await detectXrAr({ xr: {} }), false)
})

test('detect：只問 immersive-ar，回傳 true 才算支援；false / 例外 / 非 true 的值都是不支援', async () => {
  const yes = fakeNav({ supported: true })
  assert.equal(await detectXrAr(yes), true)
  assert.equal(yes.xr.asked, 'immersive-ar')
  assert.equal(await detectXrAr(fakeNav({ supported: false })), false)
  assert.equal(await detectXrAr(fakeNav({ supported: new Error('SecurityError') })), false)
  assert.equal(await detectXrAr(fakeNav({ supported: 'yes' })), false)
})

test('detect：isSessionSupported 一直沒回應 → 逾時當作不支援，且計時器被清掉', async () => {
  const clk = makeClock()
  const nav = { xr: { isSessionSupported: () => new Promise(() => {}) } }
  const p = detectXrAr(nav, { setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout, timeoutMs: 1000 })
  await tick()
  clk.advance(1001)
  assert.equal(await p, false)
  assert.equal(clk.pending(), 0)
})

test('detect：正常回應後也會清掉逾時計時器（不留常駐計時器）', async () => {
  const clk = makeClock()
  assert.equal(await detectXrAr(fakeNav({ supported: true }), { setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout }), true)
  assert.equal(clk.pending(), 0)
})

// ---------- session 參數 / 錯誤 / 參考空間 ----------
test('buildSessionInit：必要 hit-test，選用 dom-overlay / local-floor；有 root 才帶 domOverlay', () => {
  const root = { id: 'overlay' }
  assert.deepEqual(buildSessionInit(root), { requiredFeatures: ['hit-test'], optionalFeatures: ['dom-overlay', 'local-floor'], domOverlay: { root } })
  const bare = buildSessionInit(null)
  assert.deepEqual(bare, { requiredFeatures: ['hit-test'], optionalFeatures: ['dom-overlay', 'local-floor'] })
  assert.ok(!('domOverlay' in bare))
})

test('classifyXrError：權限 / 不支援 / 非 HTTPS / 占用 / 其他', () => {
  assert.equal(classifyXrError(xrError('NotAllowedError')).code, 'permission')
  assert.equal(classifyXrError(xrError('NotSupportedError')).code, 'unsupported')
  assert.equal(classifyXrError(xrError('SecurityError')).code, 'insecure')
  assert.equal(classifyXrError(xrError('InvalidStateError')).code, 'busy')
  assert.equal(classifyXrError(xrError('WeirdError', 'boom')).code, 'unknown')
  assert.equal(classifyXrError(xrError('WeirdError', 'boom')).detail, 'boom')
  assert.equal(classifyXrError(null).code, 'unknown')
  assert.equal(classifyXrError({ name: 'X', message: 'x'.repeat(500) }).detail.length, 120)
})

test('pickReferenceSpaceType：session 有啟用 local-floor 才用，否則 local', () => {
  assert.equal(pickReferenceSpaceType({ enabledFeatures: ['hit-test', 'local-floor'] }), 'local-floor')
  assert.equal(pickReferenceSpaceType({ enabledFeatures: ['hit-test'] }), 'local')
  assert.equal(pickReferenceSpaceType({}), 'local')
  assert.equal(pickReferenceSpaceType(null), 'local')
})

// ---------- 放置數學 ----------
test('xrScaleFor：縮放係數 = 目標半徑 / 球殼半徑；直徑約 28 cm（在 25~30 cm 之內）', () => {
  assert.ok(Math.abs(xrScaleFor(0.14, SHELL) - 0.14 / SHELL) < 1e-12)
  assert.ok(Math.abs(xrScaleFor(XR_PLACE.radiusM, SHELL) * SHELL * 2 - 0.28) < 1e-12)
  assert.ok(XR_PLACE.radiusM * 2 >= 0.25 && XR_PLACE.radiusM * 2 <= 0.30)
  assert.equal(xrScaleFor(0.14, 0), 1)          // 壞輸入不產生 Infinity / NaN
  assert.equal(xrScaleFor(-1, SHELL), 1)
})

test('isHorizontalHit：桌面 / 地板（法線朝上）算，牆面 / 倒吊 / 過斜不算', () => {
  assert.equal(isHorizontalHit(mat(0, 0, 0)), true)
  assert.equal(isHorizontalHit(mat(0, 0, 0, [0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)])), true)      // 傾 30°
  assert.equal(isHorizontalHit(mat(0, 0, 0, [0, Math.cos(Math.PI / 4), Math.sin(Math.PI / 4)])), false)     // 傾 45°
  assert.equal(isHorizontalHit(mat(0, 0, 0, [0, 0, 1])), false)                                              // 牆
  assert.equal(isHorizontalHit(mat(0, 0, 0, [0, -1, 0])), false)                                             // 天花板
  assert.equal(isHorizontalHit(mat(0, 0, 0, [0, 0, 0])), false)                                              // 退化
  assert.equal(isHorizontalHit(null), false)
  assert.equal(isHorizontalHit([1, 2, 3]), false)
})

test('facingYaw：+Z 面向觀看者（四個方位）；觀看者幾乎在正上方 → 0', () => {
  assert.equal(facingYaw(0, 0, 0, 5), 0)                          // 觀看者在 +Z → 不轉
  assert.ok(Math.abs(facingYaw(0, 0, 5, 0) - Math.PI / 2) < 1e-12)  // 在 +X
  assert.ok(Math.abs(facingYaw(0, 0, -5, 0) + Math.PI / 2) < 1e-12)  // 在 -X
  assert.ok(Math.abs(Math.abs(facingYaw(0, 0, 0, -5)) - Math.PI) < 1e-12)  // 在 -Z（背面）
  assert.equal(facingYaw(1, 1, 1.005, 1.005), 0)
})

test('computePlacement：球心在命中點正上方、球殼底離桌面 hoverM、面向觀看者、縮放正確', () => {
  const p = computePlacement(HIT, [1, 1.4, 0], SHELL)
  assert.ok(p)
  assert.equal(p.position[0], 1); assert.equal(p.position[2], -2)
  assert.ok(Math.abs(p.position[1] - (0.7 + XR_PLACE.hoverM + XR_PLACE.radiusM)) < 1e-9)
  assert.ok(Math.abs(p.position[1] - SHELL * p.scale - XR_PLACE.hoverM - 0.7) < 1e-9)   // 球殼底 = 桌面 + hover
  assert.ok(Math.abs(p.scale - XR_PLACE.radiusM / SHELL) < 1e-12)
  assert.equal(p.yaw, 0)                                                                 // 觀看者在球的 +Z 側
  assert.equal(p.hit.length, 16)
  assert.ok(Math.abs(computePlacement(HIT, [3, 1, -2], SHELL).yaw - Math.PI / 2) < 1e-12)
  assert.equal(computePlacement(HIT, null, SHELL).yaw, 0)                                // 沒有觀看者位置 → 不轉
  assert.equal(computePlacement(HIT, [NaN, 0, NaN], SHELL).yaw, 0)
})

test('computePlacement：傾斜的命中面仍鉛直擺放；無效輸入（牆面 / NaN / 太短）→ null', () => {
  const tilted = mat(0, 1, 0, [0, Math.cos(0.3), Math.sin(0.3)])
  const p = computePlacement(tilted, [0, 1, 2], SHELL)
  assert.ok(p && p.position[0] === 0 && p.position[2] === 0)                            // 只往 +Y 抬，不沿法線偏移
  assert.equal(computePlacement(mat(0, 0, 0, [0, 0, 1]), null, SHELL), null)
  assert.equal(computePlacement(mat(NaN, 0, 0), null, SHELL), null)
  assert.equal(computePlacement([1, 2, 3], null, SHELL), null)
  assert.equal(computePlacement(null, null, SHELL), null)
})

// ---------- hit-test 追蹤 ----------
test('createHitTracker：命中立刻找到；連續 lostFrames 幀沒命中才遺失；中間命中會重新計數', () => {
  const t = createHitTracker(3)
  assert.equal(t.found, false)
  assert.deepEqual(t.update(true), { found: true, changed: true })
  assert.deepEqual(t.update(true), { found: true, changed: false })
  assert.deepEqual(t.update(false), { found: true, changed: false })
  assert.deepEqual(t.update(false), { found: true, changed: false })
  assert.deepEqual(t.update(true), { found: true, changed: false })       // 中間命中 → 重新計數
  assert.deepEqual(t.update(false), { found: true, changed: false })
  assert.deepEqual(t.update(false), { found: true, changed: false })
  assert.deepEqual(t.update(false), { found: false, changed: true })
  assert.deepEqual(t.update(false), { found: false, changed: false })
  assert.deepEqual(t.update(true), { found: true, changed: true })       // 找回來
  t.reset()
  assert.equal(t.found, false)
})

// ---------- 畫面用的純函式 ----------
test('overlayHint / endNotice：只回 code', () => {
  assert.equal(overlayHint({ status: 'idle' }), null)
  assert.equal(overlayHint({ status: 'requesting' }), 'starting')
  assert.equal(overlayHint({ status: 'placing', tracking: true, hit: false }), 'find')
  assert.equal(overlayHint({ status: 'placing', tracking: false, hit: true }), 'find')
  assert.equal(overlayHint({ status: 'placing', tracking: true, hit: true }), 'tap')
  assert.equal(overlayHint({ status: 'placed', tracking: true }), null)
  assert.equal(overlayHint({ status: 'placed', tracking: false }), 'find')      // 追蹤遺失：移動手機找平面
  assert.equal(overlayHint({ status: 'ended' }), null)
  assert.equal(overlayHint(null), null)
  assert.equal(endNotice({ status: 'placing' }), null)
  assert.deepEqual(endNotice({ status: 'ended', reason: 'user' }), { code: 'exited', detail: '' })
  assert.deepEqual(endNotice({ status: 'ended', reason: 'system' }), { code: 'interrupted', detail: '' })
  assert.deepEqual(endNotice({ status: 'ended', reason: 'error', error: { code: 'permission', detail: 'x' } }), { code: 'permission', detail: 'x' })
  assert.deepEqual(endNotice({ status: 'ended', reason: 'error', error: null }), { code: 'unknown', detail: '' })
})

test('isActiveStatus', () => {
  for (const s of ['requesting', 'placing', 'placed']) assert.equal(isActiveStatus(s), true)
  for (const s of ['idle', 'ended', undefined]) assert.equal(isActiveStatus(s), false)
})

// ---------- 狀態機 ----------
test('狀態機：idle → requesting → placing → placed → ended（使用者退出），依序通知訂閱者', async () => {
  const s = fakeSession({ features: ['hit-test', 'local-floor'] })
  const { c, clk } = make(fakeNav({ session: s }))
  const seen = []
  c.subscribe((st) => seen.push(st.status))
  assert.equal(c.getState().status, 'idle')

  const root = { id: 'root' }
  const p = c.start({ root })
  assert.equal(c.getState().status, 'requesting')                    // 同步進入 requesting
  assert.equal(await p, true)
  assert.equal(c.getState().session, s)
  assert.equal(s.listenerCount('end'), 1)
  assert.equal(c.isActive(), true)

  assert.equal(c.place(HIT, [1, 1, 0], SHELL), false)                // 還沒 ready
  assert.equal(c.ready(), true)
  assert.equal(c.getState().status, 'placing')
  assert.equal(c.ready(), false)                                     // 重複 ready 無效
  assert.equal(c.place(HIT, [1, 1, 0], SHELL), false)                // 沒有命中
  assert.equal(c.setHit(true), true)
  assert.equal(c.setHit(true), false)                                // 沒變化不通知
  assert.equal(c.place(HIT, [1, 1, 0], SHELL), false)                // 剛進入放置：guard 內忽略點擊
  clk.advance(XR_PLACE.guardMs + 1)
  assert.equal(c.place(mat(0, 0, 0, [0, 0, 1]), [1, 1, 0], SHELL), false)   // 牆面不放
  assert.equal(c.getState().status, 'placing')
  assert.equal(c.place(HIT, [1, 1, 0], SHELL), true)
  const st = c.getState()
  assert.equal(st.status, 'placed')
  assert.ok(st.placement && Math.abs(st.placement.scale - 0.14 / SHELL) < 1e-12)
  assert.equal(c.place(HIT, [1, 1, 0], SHELL), false)                // 已放置：不能再放

  assert.equal(c.exit(), true)
  await tick()
  assert.equal(s.endCalls, 1)
  assert.equal(c.getState().status, 'ended')
  assert.equal(c.getState().reason, 'user')
  assert.equal(c.getState().session, null)
  assert.equal(c.getState().placement, null)
  assert.equal(s.listenerCount('end'), 0)                            // 監聽已拆
  assert.equal(clk.pending(), 0)                                     // 沒有殘留計時器
  assert.deepEqual([...new Set(seen)], ['requesting', 'placing', 'placed', 'ended'])
})

test('狀態機：requestSession 的參數（immersive-ar + 必要 / 選用功能 + domOverlay.root）', async () => {
  const nav = fakeNav({ session: fakeSession() })
  const { c } = make(nav)
  const root = { id: 'root' }
  await c.start({ root })
  assert.equal(nav.xr.calls.length, 1)
  assert.equal(nav.xr.calls[0][0], 'immersive-ar')
  assert.deepEqual(nav.xr.calls[0][1].requiredFeatures, ['hit-test'])
  assert.deepEqual(nav.xr.calls[0][1].optionalFeatures, ['dom-overlay', 'local-floor'])
  assert.equal(nav.xr.calls[0][1].domOverlay.root, root)
})

test('狀態機：重新放置 → 回到 placing，guard 內的點擊被忽略（避免按鈕那一下同時被當成放置），之後可再放', async () => {
  const { c, clk } = make(fakeNav({ session: fakeSession() }))
  await c.start(); c.ready(); c.setHit(true); c.setTracking(true)
  clk.advance(XR_PLACE.guardMs + 1)
  assert.equal(c.place(HIT, [1, 1, 0], SHELL), true)
  assert.equal(c.replace(), true)
  assert.equal(c.getState().status, 'placing')
  assert.equal(c.getState().placement, null)
  assert.equal(c.replace(), false)                                   // 不在 placed
  assert.equal(c.place(mat(2, 0.5, 0), [1, 1, 0], SHELL), false)     // guard 內
  clk.advance(XR_PLACE.guardMs + 1)
  assert.equal(c.place(mat(2, 0.5, 0), [1, 1, 0], SHELL), true)
  assert.equal(c.getState().placement.position[0], 2)
})

test('狀態機：追蹤 / 命中旗標只在放置階段有效，且沒變化不通知', async () => {
  const { c } = make(fakeNav({ session: fakeSession() }))
  const n = []
  c.subscribe(() => n.push(1))
  assert.equal(c.setTracking(true), false)                           // idle
  await c.start()
  assert.equal(c.setTracking(true), false)                           // requesting
  assert.equal(c.setHit(true), false)
  c.ready()
  const before = n.length
  assert.equal(c.setTracking(true), true)
  assert.equal(c.setTracking(true), false)
  assert.equal(c.setTracking(false), true)
  assert.equal(n.length, before + 2)
})

test('狀態機：系統中斷（session 自己 end）→ ended / system，並可再次進入', async () => {
  const s1 = fakeSession(), s2 = fakeSession()
  const sessions = [s1, s2]
  const nav = { xr: { requestSession: async () => sessions.shift() } }
  const { c } = make(nav)
  await c.start(); c.ready()
  s1.fireEnd()                                                       // 使用者按了系統返回 / 切到別的 app
  assert.equal(c.getState().status, 'ended')
  assert.equal(c.getState().reason, 'system')
  assert.deepEqual(endNotice(c.getState()), { code: 'interrupted', detail: '' })
  assert.equal(s1.endCalls, 0)                                       // 已經結束，不重複呼叫 end()
  assert.equal(await c.start(), true)                                // 再次進入
  assert.equal(c.getState().status, 'requesting')
  assert.equal(c.getState().reason, null)
  assert.equal(c.getState().session, s2)
})

test('狀態機：重複進入 / 退出 3 輪，每輪都乾淨（沒有殘留監聽 / 計時器 / 狀態）', async () => {
  const made = []
  const nav = { xr: { requestSession: async () => { const s = fakeSession(); made.push(s); return s } } }
  const { c, clk } = make(nav)
  for (let i = 0; i < 3; i++) {
    assert.equal(await c.start(), true)
    assert.equal(await c.start(), false)                             // 進行中再按：忽略，不會多開 session
    assert.equal(made.length, i + 1)
    c.ready(); c.setTracking(true); c.setHit(true)
    clk.advance(XR_PLACE.guardMs + 1)
    assert.equal(c.place(HIT, null, SHELL), true)
    c.exit()
    await tick()
    assert.equal(c.getState().status, 'ended')
    assert.equal(c.getState().reason, 'user')
    assert.equal(made[i].listenerCount('end'), 0)
    assert.equal(made[i].endCalls, 1)
    assert.equal(clk.pending(), 0)
  }
})

test('錯誤退場：權限被拒 / 裝置不支援 hit-test / 非 HTTPS / 占用 → ended / error，並帶 code', async () => {
  for (const [name, code] of [['NotAllowedError', 'permission'], ['NotSupportedError', 'unsupported'], ['SecurityError', 'insecure'], ['InvalidStateError', 'busy'], ['Boom', 'unknown']]) {
    const { c } = make(fakeNav({ reject: xrError(name, 'msg-' + name) }))
    assert.equal(await c.start(), false)
    const st = c.getState()
    assert.equal(st.status, 'ended', name)
    assert.equal(st.reason, 'error')
    assert.equal(st.error.code, code)
    assert.equal(st.session, null)
    assert.equal(c.isActive(), false)
    assert.equal(endNotice(st).code, code)
  }
})

test('錯誤退場：沒有 navigator.xr → unsupported；之後仍可再試', async () => {
  const { c } = make({})
  assert.equal(await c.start(), false)
  assert.equal(c.getState().status, 'ended')
  assert.equal(c.getState().error.code, 'unsupported')
  const { c: c2 } = make(undefined)
  assert.equal(await c2.start(), false)
  assert.equal(c2.getState().error.code, 'unsupported')
})

test('錯誤退場：被拒之後可以再進入（成功）', async () => {
  let n = 0
  const nav = { xr: { requestSession: () => (n++ === 0 ? Promise.reject(xrError('NotAllowedError')) : Promise.resolve(fakeSession())) } }
  const { c } = make(nav)
  assert.equal(await c.start(), false)
  assert.equal(c.getState().error.code, 'permission')
  assert.equal(await c.start(), true)
  assert.equal(c.getState().status, 'requesting')
  assert.equal(c.getState().error, null)
})

test('錯誤退場：接上渲染後出錯（fail）→ ended / error，主動結束 session，監聽全拆', async () => {
  const s = fakeSession()
  const { c, clk } = make(fakeNav({ session: s }))
  await c.start(); c.ready(); c.setHit(true)
  assert.equal(c.fail('render', 'gl boom'), true)
  await tick()
  const st = c.getState()
  assert.equal(st.status, 'ended')
  assert.equal(st.reason, 'error')
  assert.deepEqual(st.error, { code: 'render', detail: 'gl boom' })
  assert.equal(s.endCalls, 1)
  assert.equal(s.listenerCount('end'), 0)
  assert.equal(c.fail('again'), false)                               // 冪等
  assert.equal(clk.pending(), 0)
})

test('錯誤退場：session.end() 本身丟例外也不會炸（安全結束）', async () => {
  const s = fakeSession({ endRejects: true })
  const { c } = make(fakeNav({ session: s }))
  await c.start(); c.ready()
  assert.doesNotThrow(() => c.fail('frame', 'x'))
  await tick()
  assert.equal(c.getState().status, 'ended')
})

test('逾時：拿到 session 後 readyTimeoutMs 內沒接上渲染 → 退場（timeout），session 被結束', async () => {
  const s = fakeSession()
  const { c, clk } = make(fakeNav({ session: s }))
  await c.start()
  clk.advance(XR_PLACE.readyTimeoutMs - 1)
  assert.equal(c.getState().status, 'requesting')
  clk.advance(2)
  assert.equal(c.getState().status, 'ended')
  assert.equal(c.getState().error.code, 'timeout')
  assert.equal(s.endCalls, 1)
})

test('逾時：ready() 之後不再觸發逾時', async () => {
  const { c, clk } = make(fakeNav({ session: fakeSession() }))
  await c.start(); c.ready()
  assert.equal(clk.pending(), 0)
  clk.advance(XR_PLACE.readyTimeoutMs * 3)
  assert.equal(c.getState().status, 'placing')
})

test('取消：等待 session 期間按退出 → 立刻 ended / user；晚到的 session 立刻被結束，不會偷偷進入 AR', async () => {
  const deferred = {}
  const s = fakeSession()
  const { c } = make(fakeNav({ deferred }))
  const p = c.start()
  assert.equal(c.getState().status, 'requesting')
  assert.equal(c.exit(), true)
  assert.equal(c.getState().status, 'ended')
  assert.equal(c.getState().reason, 'user')
  deferred.resolve(s)
  assert.equal(await p, false)
  assert.equal(s.endCalls, 1)
  assert.equal(c.getState().status, 'ended')
})

test('取消：等待期間 requestSession 被拒（使用者在權限提示按了拒絕）而狀態已被取消 → 不覆蓋成錯誤', async () => {
  const deferred = {}
  const { c } = make(fakeNav({ deferred }))
  const p = c.start()
  c.exit()
  deferred.reject(xrError('NotAllowedError'))
  assert.equal(await p, false)
  assert.equal(c.getState().reason, 'user')
})

test('取消：舊的請求晚到，但已經開了新的一輪 → 舊 session 被結束，新一輪不受影響', async () => {
  const d1 = {}, d2 = {}
  const ds = [d1, d2]
  let i = 0
  const nav = { xr: { requestSession: () => new Promise((resolve, reject) => { const d = ds[i++]; d.resolve = resolve; d.reject = reject }) } }
  const { c } = make(nav)
  const p1 = c.start()
  c.exit()                                                           // 第一輪取消
  const p2 = c.start()                                               // 立刻開第二輪
  const s1 = fakeSession(), s2 = fakeSession()
  d1.resolve(s1)
  assert.equal(await p1, false)
  assert.equal(s1.endCalls, 1)
  d2.resolve(s2)
  assert.equal(await p2, true)
  assert.equal(c.getState().session, s2)
  assert.equal(s2.endCalls, 0)
})

test('退出：session.end() 沒有回應 → 保險計時器到了仍然退場，畫面不會卡在 AR', async () => {
  const s = fakeSession({ endHangs: true })
  const { c, clk } = make(fakeNav({ session: s }))
  await c.start(); c.ready()
  c.exit()
  await tick()
  assert.equal(c.getState().status, 'placing')
  clk.advance(3000)
  assert.equal(c.getState().status, 'ended')
  assert.equal(c.getState().reason, 'user')
  assert.equal(s.listenerCount('end'), 0)
})

test('退出：非進行中呼叫 exit / replace / fail 都是無害的 no-op', async () => {
  const { c } = make(fakeNav({ session: fakeSession() }))
  assert.equal(c.exit(), false)
  assert.equal(c.replace(), false)
  assert.equal(c.fail('x'), false)
  assert.equal(c.getState().status, 'idle')
})

test('dismiss：ended 之後清掉說明回到 idle；訂閱者例外不會拖垮狀態機；取消訂閱後不再通知', async () => {
  const { c } = make(fakeNav({ reject: xrError('NotAllowedError') }))
  let calls = 0
  const off = c.subscribe(() => { calls++; throw new Error('subscriber boom') })
  await c.start()
  assert.equal(c.getState().status, 'ended')
  assert.ok(calls >= 2)
  c.dismiss()
  assert.equal(c.getState().status, 'idle')
  assert.equal(c.getState().error, null)
  off()
  const n = calls
  await c.start()
  assert.equal(calls, n)
})

test('getXrController：整頁同一個實例；沒有 WebXR 的環境（node / iOS）start 只會得到 unsupported，不丟例外', async () => {
  assert.equal(getXrController(), getXrController())
  const st0 = getXrController().getState()
  assert.equal(st0.status, 'idle')
  if (!(globalThis.navigator && globalThis.navigator.xr)) {
    assert.equal(await getXrController().start(), false)
    assert.equal(getXrController().getState().error.code, 'unsupported')
    getXrController().dismiss()
  }
})
