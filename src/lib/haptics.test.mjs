// 觸覺回饋（lib/haptics.js）單元測試。執行：node --test src/lib/haptics.test.mjs
// 裝置介面全部以假物件注入：假 vibrateFn、假手把（vibrationActuator.playEffect）、假時鐘與計時器。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PATTERNS, EVENT_NAMES, LEVELS, LEVEL_SCALE, LIMITS, TEST_SEQUENCE,
  validatePattern, scaleVibrate, rumbleSteps, patternMs, defaultEnabled,
  overflowDepth, dripIntervalMs, purifyScale, diffEvents, createDripAccumulator, createHaptics, attachHapticsSource, OVERFLOW_AT,
} from './haptics.js'

// ---- 假環境 ----
function makeClock() {
  let t = 1000, seq = 0
  const timers = new Map()
  return {
    now: () => t,
    setTimeoutFn: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id },
    clearTimeoutFn: (id) => { timers.delete(id) },
    advance(ms) {
      const end = t + ms
      for (;;) {
        let pick = null
        for (const [id, x] of timers) if (x.at <= end && (!pick || x.at < pick.x.at)) pick = { id, x }
        if (!pick) break
        timers.delete(pick.id); t = Math.max(t, pick.x.at); pick.x.fn()
      }
      t = end
    },
    pending: () => timers.size,
  }
}
function fakePad(over = {}) {
  const calls = [], resets = []
  const pad = {
    connected: true, index: 0, id: 'Fake Pad (Vendor: 045e)',
    vibrationActuator: { effects: ['dual-rumble'], playEffect(type, params) { calls.push({ type, params }); return Promise.resolve('complete') }, reset() { resets.push(1); return Promise.resolve('complete') } },
    ...over,
  }
  pad.calls = calls; pad.resets = resets
  return pad
}
function makeEnv(over = {}) {
  const clock = makeClock()
  const vib = []
  const store = { data: null, writes: [] }
  const env = {
    vibrateFn: (p) => { vib.push(p); return true },
    getGamepads: () => [],
    now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    userActivated: () => true, isHidden: () => false, isTouch: true, reducedMotion: false,
    storage: { get: () => store.data, set: (v) => { store.data = v; store.writes.push(v) } },
    ...over,
  }
  return { env, clock, vib, store }
}
const on = (h) => { h.setEnabled(true); return h }

// ---- 事件表 ----
test('PATTERNS：必要事件齊全，且每種事件都有手機與手把兩種定義、數值合法', () => {
  for (const n of ['whale', 'dolphin', 'turtle', 'purify', 'drip', 'overflow', 'tap', 'record', 'playStart', 'error']) assert.ok(PATTERNS[n], n)
  assert.ok(EVENT_NAMES.length >= 10)
  for (const [name, p] of Object.entries(PATTERNS)) {
    assert.deepEqual(validatePattern(p), [], name)
    assert.ok(Array.isArray(p.vibrate) && p.rumble && typeof p.rumble === 'object', name)
  }
  for (const n of TEST_SEQUENCE) assert.ok(PATTERNS[n], 'TEST_SEQUENCE ' + n)
})

test('validatePattern：抓得出壞資料', () => {
  const ok = PATTERNS.tap
  assert.ok(validatePattern({ ...ok, vibrate: [10, 20] }).length, '偶數長度（以間隔結尾）')
  assert.ok(validatePattern({ ...ok, vibrate: [] }).length)
  assert.ok(validatePattern({ ...ok, vibrate: [0] }).length, '0ms 不合法')
  assert.ok(validatePattern({ ...ok, vibrate: [10.5] }).length, '非整數')
  assert.ok(validatePattern({ ...ok, vibrate: [3000] }).length, '總長過長')
  assert.ok(validatePattern({ ...ok, rumble: { duration: 10, weak: 1.2, strong: 0 } }).length, 'magnitude > 1')
  assert.ok(validatePattern({ ...ok, rumble: { duration: 10, weak: 0, strong: 0 } }).length, '兩個 magnitude 皆 0')
  assert.ok(validatePattern({ ...ok, rumble: { duration: 100, weak: 1, strong: 0, then: [{ delay: 50, duration: 10, weak: 1, strong: 0 }] } }).length, '段落重疊')
  assert.ok(validatePattern({ ...ok, cooldown: -1 }).length)
  assert.ok(validatePattern(null).length)
})

test('事件的「觸感個性」：鯨魚長而低、水滴短而輕、海豚兩短、淨化波漸強', () => {
  const total = (p) => p.vibrate.reduce((a, b) => a + b, 0)
  assert.ok(total(PATTERNS.whale) > 500 && total(PATTERNS.whale) > total(PATTERNS.drip) * 20)
  assert.ok(PATTERNS.whale.rumble.strong > PATTERNS.whale.rumble.weak, '鯨魚：低頻（strong）為主')
  assert.ok(PATTERNS.drip.vibrate.length === 1 && PATTERNS.drip.vibrate[0] <= 15)
  assert.ok(PATTERNS.drip.rumble.weak > PATTERNS.drip.rumble.strong, '水滴：高頻輕震（weak）為主')
  assert.equal(PATTERNS.dolphin.vibrate.length, 3)                                   // 短-停-短
  assert.equal(PATTERNS.dolphin.rumble.then.length, 1)
  const ons = PATTERNS.purify.vibrate.filter((_, i) => i % 2 === 0)
  assert.deepEqual(ons, [...ons].sort((a, b) => a - b)); assert.ok(new Set(ons).size === ons.length, '淨化波：震動段一段比一段長')
  const steps = rumbleSteps(PATTERNS.purify.rumble, 1)
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i].strong > steps[i - 1].strong, '淨化波：手把 magnitude 逐段增加')
})

// ---- 縮放 ----
test('scaleVibrate：只縮放震動段、間隔不變、夾在上下限', () => {
  assert.deepEqual(scaleVibrate([100, 50, 100], 1), [100, 50, 100])
  assert.deepEqual(scaleVibrate([100, 50, 100], 1.5), [150, 50, 150])
  assert.deepEqual(scaleVibrate([100, 50, 100], 0.6), [60, 50, 60])
  assert.deepEqual(scaleVibrate([2], 1), [LIMITS.minOn])
  assert.deepEqual(scaleVibrate([5000], 1), [LIMITS.maxOn])
  assert.deepEqual(scaleVibrate([10, 20, 10], 0), [])
  assert.deepEqual(scaleVibrate(null, 1), [])
  const long = scaleVibrate(Array.from({ length: 51 }, () => 100), 1)
  assert.ok(long.reduce((a, b) => a + b, 0) <= LIMITS.maxPatternMs && long.length % 2 === 1)
})

test('rumbleSteps：magnitude 夾在 0..1、段落不重疊；強度縮放', () => {
  const base = rumbleSteps(PATTERNS.whale.rumble, 1)
  assert.deepEqual(base[0], { at: 0, duration: 700, weak: 0.08, strong: 0.9 })
  const hi = rumbleSteps(PATTERNS.whale.rumble, 2)
  assert.equal(hi[0].strong, 1); assert.ok(hi[0].weak > base[0].weak)
  const lo = rumbleSteps(PATTERNS.whale.rumble, 0.6)
  assert.ok(lo[0].strong < base[0].strong && lo[0].duration < base[0].duration)
  for (const name of EVENT_NAMES) for (const k of [0.3, 0.6, 1, 1.5, 3]) {
    const s = rumbleSteps(PATTERNS[name].rumble, k)
    s.forEach((x, i) => {
      assert.ok(x.weak >= 0 && x.weak <= 1 && x.strong >= 0 && x.strong <= 1 && x.duration >= 1, name)
      if (i) assert.ok(x.at >= s[i - 1].at + s[i - 1].duration, name + ' 不重疊 k=' + k)
    })
  }
  assert.deepEqual(rumbleSteps(PATTERNS.tap.rumble, 0), [])
})

test('patternMs：取手機總長與手把結束時間較大者', () => {
  assert.equal(patternMs({ vibrate: [100], rumble: { duration: 50, weak: 1, strong: 0 } }, 1), 100)
  assert.equal(patternMs({ vibrate: [10], rumble: { duration: 50, weak: 1, strong: 0, then: [{ delay: 80, duration: 40, weak: 1, strong: 0 }] } }, 1), 120)
})

// ---- 預設值 ----
test('defaultEnabled：觸控 + vibrate 才預設開；桌機、減少動態效果預設關', () => {
  const v = () => true
  assert.equal(defaultEnabled({ vibrateFn: v, isTouch: true, reducedMotion: false }), true)
  assert.equal(defaultEnabled({ vibrateFn: v, isTouch: false, reducedMotion: false }), false)   // 桌機 Chrome 有 vibrate 但不是觸控裝置
  assert.equal(defaultEnabled({ vibrateFn: null, isTouch: true, reducedMotion: false }), false)  // iOS Safari
  assert.equal(defaultEnabled({ vibrateFn: v, isTouch: true, reducedMotion: true }), false)
  assert.equal(defaultEnabled(null), false)
})

test('設定：預設值、持久化（只存明確設過的欄位）、壞資料回退預設', () => {
  const a = makeEnv(); const h = createHaptics(a.env)
  assert.deepEqual(h.getState(), { enabled: true, level: 'medium' })
  h.setLevel('strong'); assert.deepEqual(a.store.data, { level: 'strong' }, '只改強度時不凍結 enabled 的預設值')
  h.setEnabled(false); assert.deepEqual(a.store.data, { level: 'strong', enabled: false })
  const h2 = createHaptics(a.env)   // 重新載入
  assert.deepEqual(h2.getState(), { enabled: false, level: 'strong' })

  const desk = makeEnv({ isTouch: false }); assert.equal(createHaptics(desk.env).getState().enabled, false)
  const rm = makeEnv({ reducedMotion: true }); assert.equal(createHaptics(rm.env).getState().enabled, false)
  const bad = makeEnv(); bad.store.data = { enabled: 'yes', level: 'huge' }
  assert.deepEqual(createHaptics(bad.env).getState(), { enabled: true, level: 'medium' })
  const noStore = createHaptics({ vibrateFn: () => true }); assert.equal(noStore.getState().level, 'medium')
  const thrower = makeEnv({ storage: { get() { throw new Error('x') }, set() { throw new Error('x') } } })
  const ht = createHaptics(thrower.env); assert.doesNotThrow(() => { ht.setEnabled(false); ht.setLevel('weak') })
})

test('getState 是穩定快照（改變才換）；subscribe 會通知並可取消', () => {
  const { env } = makeEnv(); const h = createHaptics(env)
  const s0 = h.getState(); assert.equal(h.getState(), s0)
  let n = 0; const off = h.subscribe(() => n++)
  h.setLevel('medium'); assert.equal(n, 0); assert.equal(h.getState(), s0)   // 沒變 → 不通知
  h.setLevel('weak'); assert.equal(n, 1); assert.notEqual(h.getState(), s0)
  h.setEnabled(false); assert.equal(n, 2)
  off(); h.setEnabled(true); assert.equal(n, 2)
  h.setLevel('nope'); assert.equal(h.getState().level, 'weak')
})

// ---- 手機震動 ----
test('trigger（手機）：送出對應模式；強度弱 / 中 / 強縮放；per-call 力度倍率', () => {
  const a = makeEnv(); const h = on(createHaptics(a.env))
  assert.equal(h.trigger('whale'), true)
  assert.deepEqual(a.vib[0], PATTERNS.whale.vibrate)              // 中 = 原樣
  a.clock.advance(5000)
  h.setLevel('weak'); h.trigger('whale')
  assert.deepEqual(a.vib[1], scaleVibrate(PATTERNS.whale.vibrate, LEVEL_SCALE.weak)); assert.ok(a.vib[1][0] < a.vib[0][0])
  a.clock.advance(5000)
  h.setLevel('strong'); h.trigger('whale')
  assert.ok(a.vib[2][0] > a.vib[0][0])
  a.clock.advance(5000)
  h.setLevel('medium'); h.trigger('purify', 0.5)
  assert.deepEqual(a.vib[3], scaleVibrate(PATTERNS.purify.vibrate, 0.5))
  a.clock.advance(5000)
  assert.equal(h.trigger('purify', 0), false, '力度 0 = 不震')
  assert.equal(h.trigger('purify', 99), true); assert.deepEqual(a.vib[4], scaleVibrate(PATTERNS.purify.vibrate, 2), '力度上限 2')
})

test('trigger：未知事件、總開關關閉 → false 且不碰裝置；force 可略過總開關', () => {
  const a = makeEnv(); const h = createHaptics(a.env)
  assert.equal(h.trigger('nope'), false)
  h.setEnabled(false)
  assert.equal(h.trigger('whale'), false); assert.equal(a.vib.length, 0)
  assert.equal(h.trigger('whale', 1, { force: true }), true); assert.equal(a.vib.length, 1)
})

test('不支援時靜默：沒有 vibrate（iOS Safari）也沒有手把 → false，不丟錯', () => {
  const a = makeEnv({ vibrateFn: null }); const h = on(createHaptics(a.env))
  for (const n of EVENT_NAMES) assert.equal(h.trigger(n), false)
  assert.equal(h.pulse(15), false)
  assert.doesNotThrow(() => h.cancel())
  assert.deepEqual(h.caps(), { vibrate: false, touch: true, reducedMotion: false, pads: [], padCount: 0, padRumble: 0 })
  const bare = createHaptics({}); bare.setEnabled(true); assert.equal(bare.trigger('whale'), false)   // 連 env 都是空的
})

test('vibrateFn 丟錯 / 回傳 false（被瀏覽器擋）→ trigger 回傳 false 且不丟錯', () => {
  const t1 = on(createHaptics(makeEnv({ vibrateFn() { throw new Error('blocked') } }).env))
  assert.doesNotThrow(() => assert.equal(t1.trigger('whale'), false))
  const t2 = on(createHaptics(makeEnv({ vibrateFn: () => false }).env))
  assert.equal(t2.trigger('whale'), false)
})

test('使用者尚未互動（Chrome 會擋 vibrate）→ 不呼叫；分頁在背景 → 不呼叫', () => {
  const a = makeEnv({ userActivated: () => false }); const h = on(createHaptics(a.env))
  assert.equal(h.trigger('whale'), false); assert.equal(h.pulse(20), false); assert.equal(a.vib.length, 0)
  const b = makeEnv({ isHidden: () => true }); const h2 = on(createHaptics(b.env))
  assert.equal(h2.trigger('whale'), false); assert.equal(b.vib.length, 0)
})

// ---- 節流 ----
test('cooldown：同一事件在間隔內不會再觸發；不同事件互不影響；過了就可再觸發', () => {
  const a = makeEnv(); const h = on(createHaptics(a.env))
  assert.equal(h.trigger('drip'), true)
  assert.equal(h.trigger('drip'), false)
  a.clock.advance(PATTERNS.drip.cooldown - 1); assert.equal(h.trigger('drip'), false)
  a.clock.advance(1); assert.equal(h.trigger('drip'), true)
  a.clock.advance(1000)
  assert.equal(h.trigger('whale'), true)
  assert.equal(h.trigger('dolphin'), true, '鯨魚的冷卻不影響海豚（關鍵事件可打斷）')
  assert.equal(h.trigger('whale'), false)
  a.clock.advance(PATTERNS.whale.cooldown); assert.equal(h.trigger('whale'), true)
})

test('被節流的觸發不會佔用冷卻與額度', () => {
  const a = makeEnv(); const h = on(createHaptics(a.env))
  h.trigger('drip'); a.clock.advance(100)
  assert.equal(h.trigger('drip'), false)
  a.clock.advance(PATTERNS.drip.cooldown - 100)   // 距第一次剛好滿冷卻（若第二次被誤記，這裡會失敗）
  assert.equal(h.trigger('drip'), true)
})

test('全域每秒上限：非關鍵事件超過次數即被擋；關鍵事件仍可通過（到 2 倍上限）；視窗過去後恢復', () => {
  const a = makeEnv(); const h = on(createHaptics(a.env))
  let okTap = 0
  for (let i = 0; i < 30; i++) { if (h.trigger('tap')) okTap++; a.clock.advance(PATTERNS.tap.cooldown) }   // 每 60ms 一次 → 1.8 秒內想觸發 30 次
  assert.ok(okTap <= LIMITS.maxPerWindow * 2 && okTap >= LIMITS.maxPerWindow, 'tap 觸發 ' + okTap + ' 次')
  // 額度已滿時：水滴被擋、鯨魚仍可通過
  const b = makeEnv(); const h2 = on(createHaptics(b.env))
  const sec = () => b.clock.advance(0)
  for (let i = 0; i < LIMITS.maxPerWindow; i++) { h2.trigger('tap'); b.clock.advance(61) }
  assert.equal(h2.trigger('drip'), false, '額度用完，水滴被擋'); sec()
  assert.equal(h2.trigger('whale'), true, '鯨魚是關鍵事件，仍可通過')
  b.clock.advance(LIMITS.windowMs + 1)
  assert.equal(h2.trigger('drip'), true, '視窗過去後恢復')
})

test('duty 上限：一秒內累計震動太久，非關鍵事件被擋（避免持續嗡嗡）', () => {
  const a = makeEnv(); const h = on(createHaptics(a.env))
  h.trigger('whale'); a.clock.advance(PATTERNS.whale.vibrate.reduce((x, y) => x + y, 0) + 1)   // 鯨魚播完，busy 已結束但 duty 還在視窗內
  assert.ok(patternMs(PATTERNS.whale, 1) >= LIMITS.maxDutyMs)
  assert.equal(h.trigger('drip'), false, '鯨魚剛播完，水滴不該立刻接上')
  a.clock.advance(LIMITS.windowMs)
  assert.equal(h.trigger('drip'), true)
})

test('非關鍵事件不打斷進行中的事件；關鍵事件可打斷', () => {
  const a = makeEnv(); const h = on(createHaptics(a.env))
  h.trigger('whale')
  a.clock.advance(100)
  assert.equal(h.trigger('drip'), false); assert.equal(h.trigger('tap'), false); assert.equal(h.pulse(10), false)
  assert.equal(a.vib.length, 1)
  assert.equal(h.trigger('purify'), true); assert.equal(a.vib.length, 2)
})

test('水滴連發不會變成嗡嗡：以最短間隔連續 10 秒，累計震動時間遠小於 10 秒的一半', () => {
  const a = makeEnv(); const h = on(createHaptics(a.env))
  let ms = 0
  for (let i = 0; i < 1000; i++) { const before = a.vib.length; h.trigger('drip'); if (a.vib.length > before) ms += a.vib[a.vib.length - 1].reduce((x, y) => x + y, 0); a.clock.advance(10) }
  assert.ok(ms < 10000 * 0.1, '10 秒內累計 ' + ms + 'ms')
})

// ---- 舊式 pulse(ms) ----
test('pulse(ms)：與舊 haptic(ms) 等價（中強度 = 原樣毫秒），受總開關與強度影響', () => {
  const a = makeEnv(); const h = createHaptics(a.env)
  assert.equal(h.pulse(15), true); assert.equal(a.vib[0], 15)
  h.setLevel('weak'); h.pulse(15); assert.equal(a.vib[1], 9)
  h.setLevel('strong'); h.pulse(20); assert.equal(a.vib[2], 30)
  h.pulse(1); assert.equal(a.vib[3], LIMITS.minOn)
  h.setEnabled(false); assert.equal(h.pulse(15), false); assert.equal(a.vib.length, 4)
  h.setEnabled(true); assert.equal(h.pulse(NaN), false); assert.equal(h.pulse(-5), false); assert.equal(h.pulse(0), false)
  // 連續呼叫不被節流（舊行為）
  for (let i = 0; i < 20; i++) assert.equal(h.pulse(8), true)
})

// ---- 手把 ----
test('手把：dual-rumble 的 playEffect 參數正確（型別、magnitude、duration），後續段落依時間排程', () => {
  const pad = fakePad(); const a = makeEnv({ getGamepads: () => [null, pad] }); const h = on(createHaptics(a.env))
  assert.equal(h.trigger('whale'), true)
  assert.deepEqual(pad.calls, [{ type: 'dual-rumble', params: { startDelay: 0, duration: 700, weakMagnitude: 0.08, strongMagnitude: 0.9 } }])
  assert.equal(a.clock.pending(), 1, '尾韻已排程')
  a.clock.advance(719); assert.equal(pad.calls.length, 1)
  a.clock.advance(1); assert.equal(pad.calls.length, 2)
  assert.deepEqual(pad.calls[1].params, { startDelay: 0, duration: 300, weakMagnitude: 0, strongMagnitude: 0.4 })
  assert.equal(a.vib.length, 1, '手機也同時震（兩種裝置都送）')
})

test('手把：淨化波依序漸強；強度 / 力度縮放 magnitude 並夾在 1 以內', () => {
  const pad = fakePad(); const a = makeEnv({ getGamepads: () => [pad], vibrateFn: null }); const h = on(createHaptics(a.env))
  h.trigger('purify'); a.clock.advance(1000)
  const strongs = pad.calls.map((c) => c.params.strongMagnitude)
  assert.equal(pad.calls.length, 5); assert.deepEqual(strongs, [...strongs].sort((x, y) => x - y))
  pad.calls.length = 0; a.clock.advance(5000)
  h.setLevel('strong'); h.trigger('purify', 2); a.clock.advance(1000)
  for (const c of pad.calls) { assert.ok(c.params.strongMagnitude <= 1 && c.params.weakMagnitude <= 1) }
  assert.equal(pad.calls[pad.calls.length - 1].params.strongMagnitude, 1)
})

test('手把：新事件會取消舊事件尚未播的後續段落', () => {
  const pad = fakePad(); const a = makeEnv({ getGamepads: () => [pad], vibrateFn: null }); const h = on(createHaptics(a.env))
  h.trigger('whale'); a.clock.advance(100)
  h.trigger('tap', 1, { force: true })   // force：略過 busy
  assert.equal(a.clock.pending(), 0)
  a.clock.advance(2000)
  assert.equal(pad.calls.length, 2)      // 鯨魚基本段 + tap；尾韻被取消
})

test('手把：略過未連線、沒有 vibrationActuator、effects 不含 dual-rumble 的手把；多支手把都會震', () => {
  const good1 = fakePad({ index: 0 }), good2 = fakePad({ index: 1 })
  const off = fakePad({ connected: false }), none = { connected: true, id: 'No rumble pad', index: 2 }
  const wrong = fakePad({ vibrationActuator: { effects: ['trigger-rumble'], playEffect() { throw new Error('should not be called') } } })
  const a = makeEnv({ vibrateFn: null, getGamepads: () => [off, none, wrong, good1, null, good2] }); const h = on(createHaptics(a.env))
  assert.equal(h.trigger('dolphin'), true)
  assert.equal(good1.calls.length, 1); assert.equal(good2.calls.length, 1); assert.equal(off.calls.length, 0)
  const c = h.caps()
  assert.equal(c.padCount, 4); assert.equal(c.padRumble, 2)   // off 不算；none / wrong 算「偵測到但不支援」
  assert.deepEqual(c.pads.map((p) => p.rumble), [false, false, true, true])
  // 只有不支援的手把 → 靜默 false
  const b = makeEnv({ vibrateFn: null, getGamepads: () => [none] }); assert.equal(on(createHaptics(b.env)).trigger('dolphin'), false)
})

test('手把：playEffect 丟錯或 Promise 被 reject 都不會炸；getGamepads 丟錯也不會', async () => {
  const throwing = fakePad({ vibrationActuator: { playEffect() { throw new Error('boom') } } })
  const rejecting = fakePad({ vibrationActuator: { playEffect() { return Promise.reject(new Error('nope')) } } })
  const a = makeEnv({ vibrateFn: null, getGamepads: () => [throwing, rejecting] }); const h = on(createHaptics(a.env))
  assert.doesNotThrow(() => h.trigger('whale'))
  await new Promise((r) => setImmediate(r))   // 若 reject 沒被接住，這裡會變成 unhandledRejection 讓測試失敗
  const b = makeEnv({ vibrateFn: null, getGamepads: () => { throw new Error('SecurityError') } })
  assert.doesNotThrow(() => { const hb = on(createHaptics(b.env)); assert.equal(hb.trigger('whale'), false); hb.caps() })
})

test('手把中途拔除：排程的後續段落不會對已斷線的手把呼叫', () => {
  const pad = fakePad(); let pads = [pad]
  const a = makeEnv({ vibrateFn: null, getGamepads: () => pads }); const h = on(createHaptics(a.env))
  h.trigger('whale'); pads = []; pad.connected = false
  assert.doesNotThrow(() => a.clock.advance(1000)); assert.equal(pad.calls.length, 1)
})

// ---- cancel / runSequence ----
test('cancel：清掉排程、停止手機震動與手把；沒在震動時不多呼叫；關掉總開關會自動 cancel', () => {
  const pad = fakePad(); const a = makeEnv({ getGamepads: () => [pad] }); const h = on(createHaptics(a.env))
  h.cancel(); assert.equal(a.vib.length, 0, '沒在震 → 不呼叫')
  h.trigger('whale'); a.clock.advance(50)
  h.cancel()
  assert.equal(a.vib[a.vib.length - 1], 0); assert.equal(pad.resets.length, 1); assert.equal(a.clock.pending(), 0)
  a.clock.advance(2000); assert.equal(pad.calls.length, 1, '尾韻不會再播')
  a.clock.advance(3000); h.trigger('whale'); a.clock.advance(50)
  h.setEnabled(false); assert.equal(a.vib[a.vib.length - 1], 0)
})

test('runSequence：依序播放並回報進度；取消後不再繼續；force 略過總開關', () => {
  const a = makeEnv(); const h = createHaptics(a.env)
  h.setEnabled(false)
  const seen = []; let done = false
  const stop = h.runSequence(['whale', 'drip', 'dolphin'], { onStep: (n) => seen.push(n), onDone: () => { done = true } })
  assert.deepEqual(seen, ['whale']); assert.equal(a.vib.length, 1)
  a.clock.advance(5000)
  assert.deepEqual(seen, ['whale', 'drip', 'dolphin']); assert.equal(a.vib.length, 3); assert.equal(done, true)

  const b = makeEnv(); const h2 = createHaptics(b.env)
  const seen2 = []; const stop2 = h2.runSequence(['whale', 'drip', 'dolphin'], { onStep: (n) => seen2.push(n) })
  b.clock.advance(patternMs(PATTERNS.whale, 1) + 500 + 10); stop2(); b.clock.advance(10000)   // 鯨魚播完 + gap → 進到水滴，然後取消
  assert.deepEqual(seen2, ['whale', 'drip']); assert.equal(b.clock.pending(), 0)
  assert.equal(typeof stop, 'function')
  assert.doesNotThrow(() => createHaptics(makeEnv({ vibrateFn: null }).env).runSequence(TEST_SEQUENCE, {})())
})

// ---- 事件來源 ----
test('diffEvents：spawns 計數增加 → 對應事件；淨化波力度 → scale；沒變化 → 空', () => {
  const s = (o = {}) => ({ spawns: { whale: 0, dolphin: 0, turtle: 0, purify: 0, ...o.spawns }, rec: { mode: 'idle', ...o.rec }, params: { seaLevel: 0.5, ...o.params } })
  assert.deepEqual(diffEvents(s(), s()), [])
  assert.deepEqual(diffEvents(s(), s({ spawns: { whale: 1 } })), [{ name: 'whale', scale: 1 }])
  assert.deepEqual(diffEvents(s({ spawns: { dolphin: 2 } }), s({ spawns: { dolphin: 3 } })), [{ name: 'dolphin', scale: 1 }])
  assert.deepEqual(diffEvents(s(), s({ spawns: { turtle: 1 } })), [{ name: 'turtle', scale: 1 }])
  assert.deepEqual(diffEvents(s(), s({ spawns: { purify: 1 } }), { purifyV: 1 }), [{ name: 'purify', scale: 1 }])
  assert.equal(diffEvents(s(), s({ spawns: { purify: 1 } }), { purifyV: 0.2 })[0].scale, 0.6)
  assert.equal(diffEvents(s(), s({ spawns: { purify: 1 } }))[0].scale, 1, 'purifyV 缺省 = 1')
  assert.deepEqual(diffEvents(s(), s({ spawns: { whale: 1, turtle: 1 } })).map((e) => e.name), ['whale', 'turtle'])
  assert.deepEqual(diffEvents(s({ spawns: { whale: 3 } }), s({ spawns: { whale: 2 } })), [], '計數減少（重設）不觸發')
  assert.deepEqual(diffEvents(null, s()), [])
})

test('diffEvents：錄製 / 播放狀態轉換；播放中的循環與 playhead 變化不觸發', () => {
  const s = (mode, extra = {}) => ({ spawns: {}, rec: { mode, ...extra }, params: {} })
  const names = (a, b) => diffEvents(s(a), s(b)).map((e) => e.name)
  assert.deepEqual(names('idle', 'recording'), ['record'])
  assert.deepEqual(names('recording', 'idle'), ['recordStop'])
  assert.deepEqual(names('idle', 'playing'), ['playStart'])
  assert.deepEqual(names('playing', 'idle'), ['playStop'])
  assert.deepEqual(names('playing', 'playing'), [])
  assert.deepEqual(diffEvents(s('playing', { playhead: 1 }), s('playing', { playhead: 2 })), [])
})

test('diffEvents：海面「進入」溢流才觸發 overflow（已在溢流中不重複）', () => {
  const s = (lv) => ({ spawns: {}, rec: { mode: 'idle' }, params: { seaLevel: lv } })
  assert.deepEqual(diffEvents(s(0.9), s(0.98)).map((e) => e.name), ['overflow'])
  assert.deepEqual(diffEvents(s(0.98), s(0.99)), [])
  assert.deepEqual(diffEvents(s(0.98), s(0.5)), [])
  assert.deepEqual(diffEvents(s(0.97), s(0.971)).map((e) => e.name), ['overflow'], '門檻與 engine 相同（嚴格大於 0.97）')
  assert.deepEqual(diffEvents(s(0.5), s(0.97)), [])
})

test('overflowDepth / dripIntervalMs / purifyScale', () => {
  assert.equal(OVERFLOW_AT, 0.97)
  assert.equal(overflowDepth(0.97), 0); assert.equal(overflowDepth(0.5), 0); assert.equal(overflowDepth(1), 1); assert.equal(overflowDepth(2), 1)
  assert.ok(Math.abs(overflowDepth(0.985) - 0.5) < 1e-9); assert.equal(overflowDepth(undefined), 0); assert.equal(overflowDepth(NaN), 0)
  assert.equal(Math.round(dripIntervalMs(0)), 2500)
  assert.ok(dripIntervalMs(1) < dripIntervalMs(0.5) && dripIntervalMs(0.5) < dripIntervalMs(0))
  assert.ok(dripIntervalMs(1) >= PATTERNS.drip.cooldown, '最快的滴水間隔不低於水滴冷卻，不會被自己節流')
  assert.equal(purifyScale(1), 1); assert.equal(purifyScale(0), 0.5); assert.equal(purifyScale(undefined), 1)
})

test('createDripAccumulator：深度 0 不滴；固定節奏；深度越大越快；大 dt 不會一次補滴很多下', () => {
  const acc = createDripAccumulator()
  assert.equal(acc.tick(1000), false)
  acc.setDepth(0)
  for (let i = 0; i < 100; i++) assert.equal(acc.tick(150), false)
  const count = (depth, ms) => { const a = createDripAccumulator(); a.setDepth(depth); let n = 0; for (let t = 0; t < ms; t += 100) if (a.tick(100)) n++; return n }
  const slow = count(0.01, 20000), fast = count(1, 20000)
  assert.ok(fast > slow && slow >= 7 && slow <= 9, '淺：每 2.5 秒一滴 → 20 秒約 8 滴（' + slow + '）')
  assert.ok(fast >= 30 && fast <= 40, '深：每 0.55 秒一滴 → 20 秒約 36 滴（' + fast + '）')
  const a = createDripAccumulator(); a.setDepth(1)
  assert.equal(a.tick(60000), false, '單次 dt 上限 500ms（分頁凍結回來不會補滴）')
  assert.equal(a.tick(60000), true); assert.equal(a.tick(0), false, '一次 tick 最多一滴')
  a.setDepth(0); assert.equal(a.tick(5000), false); assert.equal(a.depth, 0)
})

test('LEVELS / LEVEL_SCALE：弱 < 中 < 強', () => {
  assert.deepEqual(LEVELS, ['weak', 'medium', 'strong'])
  assert.ok(LEVEL_SCALE.weak < LEVEL_SCALE.medium && LEVEL_SCALE.medium < LEVEL_SCALE.strong); assert.equal(LEVEL_SCALE.medium, 1)
})

// ---- store → 觸覺（attachHapticsSource，HapticsService 的核心）----
const fakeStore = (init) => {
  let state = init; const subs = new Set()
  return {
    getState: () => state, subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn) },
    set(patch) { const prev = state; state = { ...state, ...patch }; for (const f of [...subs]) f(state, prev) },
    get subs() { return subs.size },
  }
}
const baseState = (extra = {}) => ({ spawns: { whale: 0, dolphin: 0, turtle: 0, purify: 0 }, rec: { mode: 'idle', playhead: 0 }, params: { seaLevel: 0.5, spin: 0.3 }, ...extra })
function attach(over = {}, envOver = {}, initial = baseState()) {
  const a = makeEnv(envOver); const h = on(createHaptics(a.env))
  const store = fakeStore(initial)
  const setIntervalFn = (fn, ms) => { const o = { stopped: false, id: null }; const loop = () => { if (o.stopped) return; fn(); if (!o.stopped) o.id = a.clock.setTimeoutFn(loop, ms) }; o.id = a.clock.setTimeoutFn(loop, ms); return o }
  const clearIntervalFn = (o) => { o.stopped = true; a.clock.clearTimeoutFn(o.id) }
  const dispose = attachHapticsSource({ store, haptics: h, setIntervalFn, clearIntervalFn, now: a.clock.now, isHidden: () => false, ...over })
  return { ...a, h, store, dispose }
}

test('attachHapticsSource：spawns 增加 → 對應事件的震動模式；錄製 / 播放轉換 → 對應節奏', () => {
  const x = attach()
  x.store.set({ spawns: { ...x.store.getState().spawns, whale: 1 } }); assert.deepEqual(x.vib.at(-1), PATTERNS.whale.vibrate)
  x.clock.advance(3000)
  x.store.set({ spawns: { ...x.store.getState().spawns, dolphin: 1 } }); assert.deepEqual(x.vib.at(-1), PATTERNS.dolphin.vibrate)
  x.clock.advance(3000)
  x.store.set({ spawns: { ...x.store.getState().spawns, turtle: 1 } }); assert.deepEqual(x.vib.at(-1), PATTERNS.turtle.vibrate)
  x.clock.advance(3000)
  x.store.set({ rec: { mode: 'recording', playhead: 0 } }); assert.deepEqual(x.vib.at(-1), PATTERNS.record.vibrate)
  x.clock.advance(3000)
  x.store.set({ rec: { mode: 'idle', playhead: 4 } }); assert.deepEqual(x.vib.at(-1), PATTERNS.recordStop.vibrate)
  x.clock.advance(3000)
  x.store.set({ rec: { mode: 'playing', playhead: 0 } }); assert.deepEqual(x.vib.at(-1), PATTERNS.playStart.vibrate)
  const n = x.vib.length
  x.store.set({ rec: { mode: 'playing', playhead: 0.5 } }); assert.equal(x.vib.length, n, '播放中 playhead 走動不觸發')
})

test('attachHapticsSource：淨化波力度（purifyMeta.v）→ 強度倍率；與無關參數變動快速略過', () => {
  const x = attach({ getPurifyV: () => 0.2 })
  x.store.set({ spawns: { ...x.store.getState().spawns, purify: 1 } })
  assert.deepEqual(x.vib.at(-1), scaleVibrate(PATTERNS.purify.vibrate, purifyScale(0.2)))
  const calls = []; const orig = x.h.trigger; x.h.trigger = (...a) => { calls.push(a); return orig(...a) }
  for (let i = 0; i < 100; i++) x.store.set({ params: { ...x.store.getState().params, spin: i / 100 }, rec: { ...x.store.getState().rec, playhead: i } })
  assert.equal(calls.length, 0)
})

test('attachHapticsSource：進入溢流 → overflow 起始震 + 固定節奏滴水；離開後計時器消失', () => {
  const x = attach()
  x.store.set({ params: { seaLevel: 0.99 } })
  assert.deepEqual(x.vib[0], PATTERNS.overflow.vibrate)
  assert.equal(x.clock.pending(), 1, '只有一個計時器')
  x.clock.advance(6000)
  const drips = x.vib.slice(1)
  assert.ok(drips.length >= 6 && drips.length <= 9, '深度 0.67 約每 0.75 秒一滴 → 6 秒 ' + drips.length + ' 滴')
  assert.ok(drips.every((v) => v.length === 1 && v[0] <= 15), '水滴短而輕')
  x.store.set({ params: { seaLevel: 0.5 } })
  assert.equal(x.clock.pending(), 0); const n = x.vib.length
  x.clock.advance(10000); assert.equal(x.vib.length, n)
})

test('attachHapticsSource：越滿滴得越快；掛載時已在溢流 → 直接滴水、不補 overflow 起始震', () => {
  const dripsIn = (lv) => { const x = attach({}, {}, baseState({ params: { seaLevel: lv } })); x.clock.advance(10000); return x.vib.length }
  assert.ok(dripsIn(1) > dripsIn(0.975), '滿 > 剛溢出')
  const y = attach({}, {}, baseState({ params: { seaLevel: 0.99 } })); y.clock.advance(3000)
  assert.ok(y.vib.length > 0 && y.vib.every((v) => v.length === 1), '只有水滴，沒有 overflow 模式')
})

test('attachHapticsSource：總開關關閉時水滴不震、重新開啟後恢復；分頁在背景時不震', () => {
  const x = attach({}, {}, baseState({ params: { seaLevel: 1 } }))
  x.h.setEnabled(false); x.clock.advance(5000); assert.equal(x.vib.filter((v) => v.length === 1 && v[0] < 20).length, 0)
  x.h.setEnabled(true); x.clock.advance(5000); assert.ok(x.vib.length > 0)
  let hid = true; const y = attach({ isHidden: () => hid }, { isHidden: () => hid }, baseState({ params: { seaLevel: 1 } }))
  y.clock.advance(5000); assert.equal(y.vib.length, 0)
  hid = false; y.clock.advance(5000); assert.ok(y.vib.length > 0)
})

test('attachHapticsSource：dispose → 取消訂閱、清計時器、停止進行中的震動；之後事件不再觸發', () => {
  const x = attach({}, {}, baseState({ params: { seaLevel: 1 } }))
  assert.equal(x.store.subs, 1); assert.equal(x.clock.pending(), 1)
  x.store.set({ spawns: { whale: 1, dolphin: 0, turtle: 0, purify: 0 } })   // 鯨魚進行中
  x.clock.advance(50)
  x.dispose()
  assert.equal(x.store.subs, 0); assert.equal(x.clock.pending(), 0)
  assert.equal(x.vib.at(-1), 0, '進行中的震動被停止')
  const n = x.vib.length
  x.store.set({ spawns: { whale: 2, dolphin: 0, turtle: 0, purify: 0 } }); x.clock.advance(10000)
  assert.equal(x.vib.length, n)
})

test('attachHapticsSource：沒有任何震動裝置（iOS）時整條路徑靜默、不丟錯', () => {
  const x = attach({}, { vibrateFn: null })
  assert.doesNotThrow(() => {
    x.store.set({ spawns: { whale: 1, dolphin: 1, turtle: 1, purify: 1 }, rec: { mode: 'recording', playhead: 0 }, params: { seaLevel: 1 } })
    x.clock.advance(5000); x.dispose()
  })
})
