// 英文字典載入狀態機 / 逾時 / 語系切換協調器（src/i18n/loader.js，純函式模組）驗收：node --test src/i18n/loader.test.mjs
// 全部用假的載入函式與「會檢查 this 的假計時器」——瀏覽器的原生 setTimeout 被掛到別的物件上呼叫會丟 Illegal invocation，Node 不會；假計時器要抓的就是這種寫法。
import test from 'node:test'
import assert from 'node:assert/strict'
import { LOAD_STATE, LOAD_TIMEOUT_MESSAGE, createLoader, raceTimeout, createLocaleSwitcher, defaultTimers, prefetchWhenIdle } from './loader.js'

const tick = () => new Promise((r) => setImmediate(r))          // 讓所有已排的 microtask / promise 回呼跑完
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

// 假計時器：只有「以自己為 this」呼叫才行（保留 this）；advance 手動推進時間；pending = 尚未觸發也沒被清掉的計時器數（抓洩漏）
function fakeTimers() {
  let now = 0, seq = 0
  const q = new Map()
  const self = {
    setTimeout(fn, ms) { if (this !== self) throw new TypeError('Illegal invocation'); const id = ++seq; q.set(id, { at: now + ms, fn }); return id },
    clearTimeout(id) { if (this !== self) throw new TypeError('Illegal invocation'); q.delete(id) },
    advance(ms) { now += ms; for (const [id, t] of [...q].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now && q.has(id)) { q.delete(id); t.fn() } },
    get pending() { return q.size },
  }
  return self
}

// ---------------------------------------------------------------------------------------------
// createLoader：狀態機
// ---------------------------------------------------------------------------------------------
test('createLoader：沒有載入函式 = 無需載入（Node 的預設）：一開始就是 ready，load() 立刻 resolve', async () => {
  const l = createLoader()
  assert.equal(l.getState(), LOAD_STATE.READY); assert.equal(l.isReady(), true); assert.equal(l.isLoading(), false)
  await l.load()
  assert.equal(createLoader({ load: null }).isReady(), true)
  assert.equal(createLoader({ load: 'not a function' }).isReady(), true, '不是函式也視為沒有載入器')
})

test('createLoader：idle → loading → ready；載入中共用同一個 promise（只載一次）；成功後快取（不再載入）；onReady 只呼叫一次', async () => {
  const d = deferred(); let calls = 0; const ready = []
  const l = createLoader({ load: () => { calls += 1; return d.promise }, onReady: (v) => ready.push(v) })
  assert.equal(l.getState(), LOAD_STATE.IDLE); assert.equal(l.isReady(), false)
  const p1 = l.load(), p2 = l.load(), p3 = l.load()
  assert.equal(l.getState(), LOAD_STATE.LOADING); assert.equal(l.isLoading(), true)
  assert.equal(p1, p2, '載入中重複呼叫 → 同一個 promise'); assert.equal(p2, p3)
  assert.equal(calls, 1, '載入函式只跑一次')
  d.resolve({ hello: 1 })
  assert.deepEqual(await p1, { hello: 1 })
  assert.equal(l.getState(), LOAD_STATE.READY); assert.equal(l.isReady(), true); assert.deepEqual(l.getValue(), { hello: 1 })
  assert.deepEqual(await l.load(), { hello: 1 }, 'ready 之後 load() 直接給快取值')
  assert.equal(calls, 1, '成功後快取：不再呼叫載入函式')
  assert.deepEqual(ready, [{ hello: 1 }], 'onReady 只呼叫一次')
})

test('createLoader：失敗 → promise reject、state = failed、可重試（重試才會再呼叫載入函式）；重試成功後快取', async () => {
  let calls = 0; const errors = []; let ready = 0
  const plan = [() => Promise.reject(new Error('net down')), () => Promise.reject(new Error('still down')), () => Promise.resolve('ok')]
  const l = createLoader({ load: () => plan[calls++](), onError: (e) => errors.push(e.message), onReady: () => { ready += 1 } })
  await assert.rejects(l.load(), /net down/)
  assert.equal(l.getState(), LOAD_STATE.FAILED); assert.equal(l.isReady(), false); assert.equal(l.getError().message, 'net down'); assert.equal(l.isLoading(), false)
  const p = l.load()                                          // 失敗後再呼叫 = 重試（不是回傳舊的失敗 promise）
  assert.equal(l.getState(), LOAD_STATE.LOADING); assert.equal(l.getError(), null, '重試開始就清掉舊錯誤')
  await assert.rejects(p, /still down/)
  assert.equal(calls, 2)
  assert.equal(await l.load(), 'ok'); assert.equal(calls, 3)
  assert.equal(l.getState(), LOAD_STATE.READY); assert.equal(ready, 1)
  await l.load(); assert.equal(calls, 3, '成功後不再載入')
  assert.deepEqual(errors, ['net down', 'still down'], 'onError 每次失敗各一次')
})

test('createLoader：載入函式同步丟例外、回傳非 promise 的值、onReady / onError 自己丟例外——都不會讓狀態機壞掉', async () => {
  const a = createLoader({ load: () => { throw new Error('sync boom') } })
  await assert.rejects(a.load(), /sync boom/); assert.equal(a.getState(), LOAD_STATE.FAILED)
  const b = createLoader({ load: () => 42 })
  assert.equal(await b.load(), 42); assert.equal(b.isReady(), true)
  const c = createLoader({ load: () => Promise.resolve(1), onReady: () => { throw new Error('cb') } })
  assert.equal(await c.load(), 1); assert.equal(c.isReady(), true, 'onReady 出錯不影響結果')
  const d = createLoader({ load: () => Promise.reject(new Error('x')), onError: () => { throw new Error('cb') } })
  await assert.rejects(d.load(), /x/); assert.equal(d.getState(), LOAD_STATE.FAILED)
})

test('createLoader：失敗後同時多個呼叫者共用「重試」那一次；沒人處理的舊 promise 不會變成 unhandled rejection（呼叫端自己 catch）', async () => {
  let calls = 0
  const d1 = deferred(), d2 = deferred()
  const l = createLoader({ load: () => (++calls === 1 ? d1.promise : d2.promise) })
  const p1 = l.load(); const p1b = l.load()
  d1.reject(new Error('e1'))
  await assert.rejects(p1, /e1/); await assert.rejects(p1b, /e1/)
  const r1 = l.load(), r2 = l.load()
  assert.equal(r1, r2); assert.equal(calls, 2)
  d2.resolve('done'); assert.equal(await r1, 'done')
})

// ---- 看門狗（單次嘗試逾時）----
test('createLoader：單次嘗試逾時（網路卡住）→ 判定失敗、可重試；計時器成功 / 失敗 / 逾時後都清掉（無洩漏）', async () => {
  const tm = fakeTimers(); let calls = 0; const ds = [deferred(), deferred(), deferred()]
  const l = createLoader({ load: () => ds[calls++].promise, attemptTimeoutMs: 1000, timers: tm })
  const p1 = l.load(); assert.equal(tm.pending, 1, '一次嘗試 = 一個看門狗計時器')
  tm.advance(999); assert.equal(l.isLoading(), true)
  tm.advance(1)
  await assert.rejects(p1, /timeout/); assert.equal(l.getState(), LOAD_STATE.FAILED); assert.equal(tm.pending, 0)
  const p2 = l.load(); assert.equal(calls, 2, '逾時後重試會另起新的一次'); assert.equal(l.isLoading(), true)
  ds[1].resolve('v2'); assert.equal(await p2, 'v2'); assert.equal(tm.pending, 0, '成功 → 看門狗清掉'); assert.equal(l.isReady(), true)
  const l2 = createLoader({ load: () => Promise.reject(new Error('bad')), attemptTimeoutMs: 1000, timers: tm })
  await assert.rejects(l2.load(), /bad/); assert.equal(tm.pending, 0, '失敗 → 看門狗清掉')
})

test('createLoader：被判定逾時的舊嘗試若晚到成功，仍然接受（state → ready、onReady 一次）；新一輪重試的結果不會重複觸發', async () => {
  const tm = fakeTimers(); const ds = [deferred(), deferred()]; let calls = 0; const ready = []
  const l = createLoader({ load: () => ds[calls++].promise, attemptTimeoutMs: 500, timers: tm, onReady: (v) => ready.push(v) })
  const p1 = l.load(); tm.advance(500); await assert.rejects(p1, /timeout/)
  const p2 = l.load()                                          // 重試進行中……
  ds[0].resolve('late-1')                                      // ……舊嘗試晚到成功
  await tick()
  assert.equal(l.isReady(), true); assert.equal(l.getValue(), 'late-1')
  assert.equal(await l.load(), 'late-1', 'ready 之後直接給快取')
  ds[1].resolve('second'); await p2
  assert.deepEqual(ready, ['late-1'], 'onReady 只有一次')
  assert.equal(l.getValue(), 'late-1')
})

test('createLoader：attemptTimeoutMs 不是有限正數 → 不設看門狗（不建立計時器）', async () => {
  for (const ms of [0, -5, NaN, Infinity, undefined, null, '100']) {
    const tm = fakeTimers(); const d = deferred()
    const l = createLoader({ load: () => d.promise, attemptTimeoutMs: ms, timers: tm })
    const p = l.load(); assert.equal(tm.pending, 0, String(ms)); d.resolve(1); await p
  }
})

// ---------------------------------------------------------------------------------------------
// raceTimeout
// ---------------------------------------------------------------------------------------------
test('raceTimeout：先完成 → { ok, value }；先失敗 → { error }；逾時 → { timeout }；永遠 resolve；計時器一定清掉', async () => {
  const tm = fakeTimers()
  const ok = raceTimeout(Promise.resolve('v'), 100, tm)
  assert.deepEqual(await ok, { status: 'ok', value: 'v' }); assert.equal(tm.pending, 0)
  const err = new Error('nope')
  const bad = raceTimeout(Promise.reject(err), 100, tm)
  const r = await bad; assert.equal(r.status, 'error'); assert.equal(r.error, err); assert.equal(tm.pending, 0)
  const d = deferred()
  const slow = raceTimeout(d.promise, 100, tm); assert.equal(tm.pending, 1)
  tm.advance(100)
  assert.deepEqual(await slow, { status: 'timeout' }); assert.equal(tm.pending, 0)
  d.resolve('too late'); await tick()                            // 逾時後原 promise 才完成：不影響已回傳的結果、不丟例外
})

test('raceTimeout：ms 不是有限正數 → 一直等（不設計時器）；原 promise 是非 promise 值也行', async () => {
  const tm = fakeTimers(); const d = deferred()
  const p = raceTimeout(d.promise, Infinity, tm); assert.equal(tm.pending, 0)
  d.resolve(7); assert.deepEqual(await p, { status: 'ok', value: 7 })
  assert.deepEqual(await raceTimeout(5, undefined, tm), { status: 'ok', value: 5 })
})

test('計時器保留 this：注入物件的 setTimeout / clearTimeout 一律在該物件上呼叫（假計時器會檢查 this）；預設計時器每次呼叫才讀 globalThis', async () => {
  const tm = fakeTimers()
  const d = deferred(); const p = raceTimeout(d.promise, 50, tm); tm.advance(50); assert.equal((await p).status, 'timeout')
  // 預設：把 globalThis.setTimeout / clearTimeout 換成會檢查 this 的版本，跑一遍
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout
  let sets = 0, clears = 0
  globalThis.setTimeout = function (fn, ms) { if (this !== globalThis) throw new TypeError('Illegal invocation'); sets += 1; return realSet.call(globalThis, fn, ms) }
  globalThis.clearTimeout = function (id) { if (this !== globalThis) throw new TypeError('Illegal invocation'); clears += 1; return realClear.call(globalThis, id) }
  try {
    assert.equal((await raceTimeout(new Promise(() => {}), 5)).status, 'timeout')
    assert.equal((await raceTimeout(Promise.resolve(1), 5000)).status, 'ok')
    const l = createLoader({ load: () => Promise.resolve(1), attemptTimeoutMs: 5000 }); await l.load()
    assert.ok(sets >= 3 && clears >= 2, `sets=${sets} clears=${clears}`)
    defaultTimers.setTimeout(() => {}, 0)                                        // 也可以直接呼叫（不需要 this）
  } finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear }
})

// ---------------------------------------------------------------------------------------------
// createLocaleSwitcher：setLocale 的協調
// ---------------------------------------------------------------------------------------------
// 假環境：locale 變數 + applied 紀錄 + 可控的英文載入器
function env({ ready = false, initialDesired, loadImpl } = {}) {
  const e = { locale: 'zh', applied: [], busy: [], errors: [], loads: 0 }
  e.loader = createLoader({ load: ready ? null : () => { e.loads += 1; return loadImpl ? loadImpl(e.loads) : Promise.resolve() } })
  e.sw = createLocaleSwitcher({
    getLocale: () => e.locale,
    applyLocale: (loc, opts) => { e.applied.push([loc, opts]); e.locale = loc },
    english: e.loader,
    initialDesired,
    onBusy: (b) => e.busy.push(b),
    onError: (err) => e.errors.push(err),
  })
  return e
}

test('switcher：字典已就緒（或切回 zh）→ 同步套用（呼叫回來時 getLocale() 已經是新語系），不載入、不忙碌', async () => {
  const e = env({ ready: true })
  const p = e.sw.request('en')
  assert.equal(e.locale, 'en', '同步生效'); assert.deepEqual(e.applied, [['en', undefined]])
  assert.equal(await p, 'en')
  e.sw.request('zh'); assert.equal(e.locale, 'zh')
  assert.deepEqual(e.busy, []); assert.equal(e.loads, 0)
  // 切回 zh 永遠不需要字典（即使字典沒載入）
  const e2 = env(); e2.locale = 'en'; e2.sw.request('zh'); assert.equal(e2.locale, 'zh'); assert.equal(e2.loads, 0)
})

test('switcher：字典未載入時按 EN → 先載入，載完才真的切；期間 locale 維持原樣、忙碌旗標開關各一次；回傳的 promise 給切換後的語系', async () => {
  const d = deferred(); const e = env({ loadImpl: () => d.promise })
  const p = e.sw.request('en')
  assert.equal(e.locale, 'zh', '載入完成前不切換'); assert.deepEqual(e.applied, []); assert.deepEqual(e.busy, [true]); assert.equal(e.sw.isPending(), true)
  await tick(); assert.equal(e.locale, 'zh')
  d.resolve()
  assert.equal(await p, 'en'); assert.equal(e.locale, 'en'); assert.deepEqual(e.applied, [['en', undefined]])
  assert.deepEqual(e.busy, [true, false]); assert.equal(e.sw.isPending(), false); assert.equal(e.loads, 1)
  assert.deepEqual(e.errors, [])
})

test('switcher：載入中連按（多次 request）→ 共用同一次載入、只套用一次；忙碌旗標等最後一個完成才關', async () => {
  const d = deferred(); const e = env({ loadImpl: () => d.promise })
  const ps = [e.sw.request('en'), e.sw.request('en'), e.sw.request('en')]
  assert.equal(e.loads, 1, '共用同一個載入'); assert.deepEqual(e.busy, [true])
  d.resolve()
  const out = await Promise.all(ps)
  assert.deepEqual(out, ['en', 'en', 'en']); assert.equal(e.applied.length, 1, '只套用一次'); assert.deepEqual(e.busy, [true, false])
})

test('switcher：載入失敗 → 維持原語系、不丟例外（promise 仍 resolve 成目前語系）、onError 一次、忙碌旗標關閉；再要求一次會重試並成功', async () => {
  const e = env({ loadImpl: (n) => (n === 1 ? Promise.reject(new Error('offline')) : Promise.resolve()) })
  const r1 = await e.sw.request('en')
  assert.equal(r1, 'zh'); assert.equal(e.locale, 'zh'); assert.equal(e.applied.length, 0)
  assert.equal(e.errors.length, 1); assert.match(e.errors[0].message, /offline/); assert.deepEqual(e.busy, [true, false])
  assert.equal(e.sw.getDesired(), 'zh', '失敗後「想要的」退回目前語系（之後字典就算自己載入完成也不會突然切換）')
  const r2 = await e.sw.request('en')
  assert.equal(r2, 'en'); assert.equal(e.locale, 'en'); assert.equal(e.loads, 2, '重試 = 再載入一次'); assert.equal(e.errors.length, 1)
})

test('switcher：等字典期間又要求 zh（取消）→ 字典到了也不切 en；已經是 zh 時 request(zh) 仍能取消還在等的 en', async () => {
  const d = deferred(); const e = env({ loadImpl: () => d.promise })
  const p = e.sw.request('en')
  e.sw.request('zh')                                           // 目前就是 zh：no-op 套用，但取消「想要 en」
  assert.equal(e.sw.getDesired(), 'zh'); assert.equal(e.applied.length, 0)
  d.resolve()
  assert.equal(await p, 'zh'); assert.equal(e.locale, 'zh'); assert.equal(e.applied.length, 0)
  assert.equal(e.loader.isReady(), true, '字典仍然載入完成並快取（下次按 EN 是同步的）')
  assert.equal(await e.sw.request('en'), 'en'); assert.equal(e.applied.length, 1); assert.equal(e.loads, 1)
})

test('switcher：不合法的語系被忽略（不改 desired、不載入）；已經是目前語系 → no-op（不重複套用）', async () => {
  const e = env({ ready: true })
  for (const bad of ['fr', '', null, undefined, 'EN', 5, {}]) assert.equal(await e.sw.request(bad), 'zh')
  assert.equal(e.sw.getDesired(), 'zh'); assert.equal(e.applied.length, 0)
  e.sw.request('zh'); assert.equal(e.applied.length, 0, '已經是 zh')
  e.sw.request('en'); e.sw.request('en'); assert.equal(e.applied.length, 1)
})

test('switcher：套用時丟例外（例如訂閱者出錯）→ 記到 onError、忙碌旗標仍關閉、promise 仍 resolve', async () => {
  const d = deferred()
  const errors = [], busy = []
  const loader = createLoader({ load: () => d.promise })
  const sw = createLocaleSwitcher({ getLocale: () => 'zh', applyLocale: () => { throw new Error('subscriber bug') }, english: loader, onBusy: (b) => busy.push(b), onError: (x) => errors.push(x.message) })
  const p = sw.request('en'); d.resolve()
  assert.equal(await p, 'zh'); assert.deepEqual(errors, ['subscriber bug']); assert.deepEqual(busy, [true, false])
})

test('switcher：opts（例如 { persist: false }）原樣轉交給 applyLocale；onBusy 自己丟例外不影響切換', async () => {
  const e = env({ ready: true }); e.sw.request('en', { persist: false })
  assert.deepEqual(e.applied, [['en', { persist: false }]])
  const d = deferred(); const loader = createLoader({ load: () => d.promise }); let loc = 'zh'
  const sw = createLocaleSwitcher({ getLocale: () => loc, applyLocale: (l) => { loc = l }, english: loader, onBusy: () => { throw new Error('ui') } })
  const p = sw.request('en'); d.resolve(); assert.equal(await p, 'en')
})

// ---- 啟動（boot）----
test('boot：想要的就是目前語系（zh）→ skip，完全不載入', async () => {
  const e = env({ loadImpl: () => deferred().promise })
  assert.deepEqual(await e.sw.boot({ timeoutMs: 8000, timers: fakeTimers() }), { status: 'skip', locale: 'zh' }); assert.equal(e.loads, 0)
})

test('boot：偵測到 en 且字典未就緒 → 載入並等它；套用時 persist: false（偵測到的不算使用者手動選擇：不寫偏好）；就緒後 status = ready；計時器清掉', async () => {
  const tm = fakeTimers(); const d = deferred()
  const e = env({ initialDesired: 'en', loadImpl: () => d.promise })
  assert.equal(e.locale, 'zh', '字典就緒前生效語系是 zh')
  const p = e.sw.boot({ timeoutMs: 8000, timers: tm })
  assert.equal(e.locale, 'zh'); assert.equal(tm.pending, 1)
  d.resolve()
  assert.deepEqual(await p, { status: 'ready', locale: 'en' })
  assert.deepEqual(e.applied, [['en', { persist: false }]]); assert.equal(tm.pending, 0)
})

test('boot：逾時 → status = timeout（呼叫端先以中文 render）；字典之後才到 → 自動切到 en（只套用一次）', async () => {
  const tm = fakeTimers(); const d = deferred()
  const e = env({ initialDesired: 'en', loadImpl: () => d.promise })
  const p = e.sw.boot({ timeoutMs: 8000, timers: tm })
  tm.advance(8000)
  assert.deepEqual(await p, { status: 'timeout', locale: 'zh' }); assert.equal(e.locale, 'zh'); assert.equal(e.sw.isPending(), true, '載入還在背景進行')
  d.resolve(); await tick()
  assert.equal(e.locale, 'en', '晚到的字典自動生效'); assert.deepEqual(e.applied, [['en', { persist: false }]]); assert.equal(e.sw.isPending(), false)
})

test('boot：載入失敗 → status = failed、維持 zh（不白屏、不丟例外）；使用者之後按 EN 可以重試', async () => {
  const e = env({ initialDesired: 'en', loadImpl: (n) => (n === 1 ? Promise.reject(new Error('404')) : Promise.resolve()) })
  assert.deepEqual(await e.sw.boot({ timeoutMs: 8000, timers: fakeTimers() }), { status: 'failed', locale: 'zh' })
  assert.equal(e.errors.length, 1)
  assert.equal(await e.sw.request('en'), 'en')
})

test('boot：等字典期間使用者選了 zh → 字典到了不切 en（想要的以最後一次為準）', async () => {
  const tm = fakeTimers(); const d = deferred()
  const e = env({ initialDesired: 'en', loadImpl: () => d.promise })
  const p = e.sw.boot({ timeoutMs: 8000, timers: tm })
  e.sw.request('zh'); d.resolve()
  const r = await p
  assert.equal(e.locale, 'zh'); assert.equal(e.applied.length, 0); assert.equal(r.locale, 'zh')
})

test('boot：字典已就緒（例如同一頁重複啟動、或已預載）→ 同步套用 en、status = ready', async () => {
  const e = env({ ready: true, initialDesired: 'en' })
  assert.deepEqual(await e.sw.boot({ timeoutMs: 8000, timers: fakeTimers() }), { status: 'ready', locale: 'en' })
})

// ---------------------------------------------------------------------------------------------
// LOAD_TIMEOUT_MESSAGE / prefetchWhenIdle
// ---------------------------------------------------------------------------------------------
test('看門狗逾時 reject 的錯誤訊息是 LOAD_TIMEOUT_MESSAGE（呼叫端據此分辨「逾時：再試就好」與「硬失敗：要整頁重新載入」）；硬失敗保留原本的錯誤', async () => {
  const tm = fakeTimers(); const d = deferred()
  const l = createLoader({ load: () => d.promise, attemptTimeoutMs: 1000, timers: tm })
  const p = l.load(); const caught = p.catch((e) => e)
  tm.advance(1000)
  const err = await caught
  assert.equal(err.message, LOAD_TIMEOUT_MESSAGE); assert.equal(LOAD_TIMEOUT_MESSAGE, 'load timeout')
  const hard = createLoader({ load: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')), attemptTimeoutMs: 1000, timers: fakeTimers() })
  const e2 = await hard.load().catch((e) => e); assert.notEqual(e2.message, LOAD_TIMEOUT_MESSAGE); assert.match(e2.message, /dynamically imported/)
})

test('prefetchWhenIdle：字典未就緒 + 有 idle 排程 → 排一個閒置回呼、回傳 true；回呼執行時才載入（不是排程當下）；載入失敗靜默（不 reject、不外洩）', async () => {
  let loads = 0, idles = []
  const english = { isReady: () => false, load: () => { loads += 1; return Promise.reject(new Error('offline')) } }
  const r = prefetchWhenIdle({ english, idle: (fn) => idles.push(fn) })
  assert.equal(r, true); assert.equal(loads, 0, '排程當下不載入'); assert.equal(idles.length, 1)
  assert.doesNotThrow(() => idles[0]()); await tick()
  assert.equal(loads, 1, '閒置時才載入'); // 失敗被吞掉：沒有 unhandled rejection（node 會讓測試程序失敗）
  // 成功
  let ready = false
  const ok = { isReady: () => ready, load: () => { loads += 1; ready = true; return Promise.resolve() } }
  const idle2 = []; prefetchWhenIdle({ english: ok, idle: (fn) => idle2.push(fn) }); idle2[0](); await tick()
  assert.equal(loads, 2); assert.equal(ready, true)
})

test('prefetchWhenIdle：已就緒 / 省流量（saveData）/ 沒有 idle / 缺 english → 不排程（false）；回呼執行時已經就緒 / 已離線 → 不載入；環境函式丟例外不外洩', async () => {
  let loads = 0; const idles = []
  const mk = (ready = false) => ({ isReady: () => ready, load: () => { loads += 1; return Promise.resolve() } })
  assert.equal(prefetchWhenIdle({ english: mk(true), idle: (f) => idles.push(f) }), false)
  assert.equal(prefetchWhenIdle({ english: mk(), idle: (f) => idles.push(f), saveData: () => true }), false, '省流量模式：不預抓')
  assert.equal(prefetchWhenIdle({ english: mk() }), false, '沒有 idle')
  assert.equal(prefetchWhenIdle({ english: mk(), idle: 'x' }), false)
  for (const bad of [undefined, null, {}, { isReady: () => false }, { load() {} }]) assert.equal(prefetchWhenIdle({ english: bad, idle: (f) => idles.push(f) }), false)
  assert.equal(prefetchWhenIdle(), false); assert.equal(prefetchWhenIdle(null), false)
  assert.equal(idles.length, 0, '上面都沒排程')
  // saveData 丟例外 → 當作不是省流量（照抓）；online 丟例外 → 當作不知道（照抓）
  const a = []; assert.equal(prefetchWhenIdle({ english: mk(), idle: (f) => a.push(f), saveData: () => { throw new Error('x') }, online: () => { throw new Error('y') } }), true); a[0](); await tick(); assert.equal(loads, 1)
  // 執行時：離線 → 不載入；online 回 undefined（不知道）→ 載入
  loads = 0; const b = []; let on = true
  prefetchWhenIdle({ english: mk(), idle: (f) => b.push(f), online: () => on }); on = false; b[0](); await tick(); assert.equal(loads, 0, '排程後才離線：不載入')
  const c = []; prefetchWhenIdle({ english: mk(), idle: (f) => c.push(f), online: () => undefined }); c[0](); await tick(); assert.equal(loads, 1)
  // 回呼執行時已就緒（例如使用者先按了 EN）：不重複載入
  loads = 0; let ready = false; const d2 = []; prefetchWhenIdle({ english: { isReady: () => ready, load: () => { loads += 1; return Promise.resolve() } }, idle: (f) => d2.push(f) }); ready = true; d2[0](); await tick(); assert.equal(loads, 0)
  // idle 排程本身丟例外 → 不外洩、回傳 false
  assert.equal(prefetchWhenIdle({ english: mk(), idle: () => { throw new Error('no idle') } }), false)
})
