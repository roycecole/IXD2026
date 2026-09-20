// 展場防呆單元測試：lib/resilience.js（純邏輯 + 可注入環境的執行層）、ErrorBoundary.jsx（生命週期 + SSR 標記）、
// services/ResilienceService.jsx（閒置狀態 / 只換資料）、ui/devices/OpsSection.jsx（SSR 標記）。
// 執行：node --test src/lib/resilience.test.mjs
// 計時器 / rAF / fetch / document / location / 儲存 / 時鐘全部是假的，由 env.advance() 推進虛擬時間。
// .jsx 用 esbuild 打成一個暫存 .mjs 再載入（i18n 與 resilience.js 保持外部模組，讓測試與被測元件共用同一份實例；store 等以 stub 取代）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { build } from 'esbuild'
import * as R from './resilience.js'
import { registerEn, setLocale, translate } from '../i18n/index.js'
import enResilience from '../i18n/en/resilience.js'

registerEn(enResilience)
const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '..')
const flush = () => new Promise((r) => setImmediate(r))   // 讓 promise 鏈跑完（setImmediate 不受假計時器影響）
const T0 = 1_700_000_000_000

// ───────────────────────────── 假環境 ─────────────────────────────
function memStorage(initial) {
  let data = initial === undefined ? null : JSON.parse(JSON.stringify(initial))
  return {
    get data() { return data },
    load: () => (data === null ? [] : JSON.parse(JSON.stringify(data))),
    save: (l) => { data = JSON.parse(JSON.stringify(l)) },   // 經過序列化：和 localStorage 一樣不保留參照
    clear: () => { data = null },
  }
}

function makeCanvas(engine = true) {
  const L = new Map()
  return {
    getAttribute: (k) => (k === 'data-engine' && engine ? 'three.js r169' : null),
    addEventListener(type, fn) { if (!L.has(type)) L.set(type, new Set()); L.get(type).add(fn) },
    removeEventListener(type, fn) { if (L.has(type)) L.get(type).delete(fn) },
    emit(type) {
      const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
      for (const fn of [...(L.get(type) || [])]) fn(ev)
      return ev
    },
    count: () => [...L.values()].reduce((n, s) => n + s.size, 0),
  }
}

function makeEnv({ visible = true, start = T0 } = {}) {
  let t = start
  const timers = new Map(); let seq = 0
  const docL = new Map()
  const rafs = new Map(); let rseq = 0
  const reloads = [], fetches = []
  const canvases = []
  let lastRaf = start
  const doc = {
    visibilityState: visible ? 'visible' : 'hidden',
    addEventListener(type, fn) { if (!docL.has(type)) docL.set(type, new Set()); docL.get(type).add(fn) },
    removeEventListener(type, fn) { if (docL.has(type)) docL.get(type).delete(fn) },
    emit(type) { for (const fn of [...(docL.get(type) || [])]) fn({}) },
    querySelectorAll: () => canvases.slice(),
  }
  const idle = { idleMs: 0, recMode: 'idle', tourRunning: false, tourAuto: false, modalOpen: false }
  const env = {
    doc, canvases, reloads, fetches, idle,
    baseUrl: '/', search: '', hash: '',
    now: () => t,
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: t + ms, ms, iv: false }); return id },
    clearTimeout(id) { timers.delete(id) },
    setInterval(fn, ms) { const id = ++seq; timers.set(id, { fn, at: t + ms, ms, iv: true }); return id },
    clearInterval(id) { timers.delete(id) },
    raf(cb) { const id = ++rseq; rafs.set(id, cb); return id },
    caf(id) { rafs.delete(id) },
    fetch(url, init) { fetches.push({ url, init }); return Promise.resolve().then(() => env.respond(url, init)) },
    respond: () => { throw new Error('offline') },
    reload() { reloads.push(t) },
    idleState: () => ({ ...idle }),
    rafOn: true, rafEveryMs: 100,
    // 推進虛擬時間：每步先跑到期的計時器，再（分頁可見且 rafOn）呼叫 rAF 回呼（每 rafEveryMs 一次）
    advance(ms, stepMs = 100) {
      const end = t + ms
      while (t < end) {
        t = Math.min(end, t + stepMs)
        for (const [id, x] of [...timers]) {
          if (!timers.has(id) || x.at > t) continue
          x.fn()
          if (!timers.has(id)) continue
          if (x.iv) { x.at += x.ms; if (x.at <= t) x.at = t + x.ms }   // 和瀏覽器一樣：錯過的間隔不補跑，只跑一次再重新排
          else timers.delete(id)
        }
        if (env.rafOn && doc.visibilityState === 'visible' && t - lastRaf >= env.rafEveryMs) {
          lastRaf = t
          const cbs = [...rafs]; rafs.clear()
          for (const [, cb] of cbs) cb(t)
        }
      }
    },
    jump(ms) { t += ms },   // 時間流逝但什麼都沒跑（主執行緒被長時間占住）
    counts() { return { timers: timers.size, rafs: rafs.size, doc: [...docL.values()].reduce((n, s) => n + s.size, 0), canvas: canvases.reduce((n, c) => n + c.count(), 0) } },
  }
  return env
}

// 一組常用的：env + status + crashLog + config + reloader
function setup(search = '', over = {}) {
  const env = over.env || makeEnv()
  env.search = search
  const status = R.createStatusStore(R.initialStatus(env.now()))
  const mem = memStorage()
  const log = R.createCrashLog({ storage: mem, now: env.now, boot: 'B0' })
  const cfg = R.resolveConfig({ search, hash: over.hash || '', buildId: over.buildId === undefined ? 'b1' : over.buildId })
  const reloader = R.createReloader({ env, status, crashLog: log, cfg })
  const getIdle = () => R.evaluateIdle(env.idleState(), { kiosk: cfg.kiosk })
  return { env, status, mem, log, cfg, reloader, getIdle }
}
const jsonRes = (body, ok = true) => ({ ok, json: async () => body })

// ───────────────────────────── 設定 ─────────────────────────────
test('resolveConfig：一般模式 → 看門狗關、版本 10 分鐘、資料 3 小時（頁面可見時）', () => {
  const c = R.resolveConfig({ search: '', buildId: 'b1' })
  assert.equal(c.mode, 'main'); assert.equal(c.kiosk, false)
  assert.deepEqual(c.watchdog, { on: false, reason: 'default' })
  assert.deepEqual(c.version, { check: true, auto: true, reason: 'idle', everyMs: 10 * 60 * 1000 })
  assert.deepEqual(c.data, { everyMs: 3 * 60 * 60 * 1000, visibleOnly: true })
  assert.equal(c.reloadHour, null)
})

test('resolveConfig：?kiosk → 看門狗開、版本 5 分鐘、資料 30 分鐘（不限可見）；?watchdog=0 覆蓋；?watchdog=1 一般模式也開', () => {
  const k = R.resolveConfig({ search: '?kiosk=1', buildId: 'b1' })
  assert.deepEqual(k.watchdog, { on: true, reason: 'kiosk' })
  assert.equal(k.version.everyMs, 5 * 60 * 1000); assert.equal(k.version.reason, 'kiosk')
  assert.deepEqual(k.data, { everyMs: 30 * 60 * 1000, visibleOnly: false })
  assert.deepEqual(R.resolveConfig({ search: '?kiosk=1&watchdog=0', buildId: 'b1' }).watchdog, { on: false, reason: 'flag-off' })
  assert.deepEqual(R.resolveConfig({ search: '?watchdog=0', buildId: 'b1' }).watchdog, { on: false, reason: 'flag-off' })
  assert.deepEqual(R.resolveConfig({ search: '?watchdog=1', buildId: 'b1' }).watchdog, { on: true, reason: 'flag' })
  assert.deepEqual(R.resolveConfig({ search: '?kiosk=0', buildId: 'b1' }).watchdog, { on: false, reason: 'default' }, '?kiosk=0 明確關閉不算展場')
  // 觀眾視窗（投影機）整天開著、卡死了沒人發現 → 預設就開；?watchdog=0 仍可關
  assert.deepEqual(R.resolveConfig({ search: '?audience=1', buildId: 'b1' }).watchdog, { on: true, reason: 'audience' })
  assert.deepEqual(R.resolveConfig({ search: '?audience=1&watchdog=0', buildId: 'b1' }).watchdog, { on: false, reason: 'flag-off' })
})

test('resolveConfig：dev 建置不做版本檢查；?autoupdate=0 只記錄不自動重載', () => {
  assert.deepEqual(R.resolveConfig({ search: '', buildId: 'dev' }).version, { check: false, auto: false, reason: 'dev', everyMs: 600000 })
  assert.deepEqual(R.resolveConfig({ search: '', buildId: '' }).version.check, false)
  const off = R.resolveConfig({ search: '?autoupdate=0', buildId: 'b1' }).version
  assert.equal(off.check, true); assert.equal(off.auto, false); assert.equal(off.reason, 'flag-off')
})

test('resolveMode：遙控頁 > 診斷頁 > 觀眾視窗 > 主畫面（與 main.jsx 的路由同序）', () => {
  assert.equal(R.resolveMode('?audience=1', '#remote=abc'), 'remote')
  assert.equal(R.resolveMode('?audience=1&diagnostics=1', ''), 'diagnostics')
  assert.equal(R.resolveMode('?audience=1', ''), 'audience')
  assert.equal(R.resolveMode('?audience=0', ''), 'main')
  assert.equal(R.resolveMode('', ''), 'main')
})

test('parseReloadHour / nextReloadAt：只收 0–23 的整數；下一次本地整點嚴格晚於現在', () => {
  assert.equal(R.parseReloadHour('?reload=3'), 3)
  assert.equal(R.parseReloadHour('?reload=03'), 3)
  assert.equal(R.parseReloadHour('?reload=0'), 0)
  assert.equal(R.parseReloadHour('?reload=23'), 23)
  for (const bad of ['?reload=24', '?reload=-1', '?reload=x', '?reload=', '?reload=3.5', '', '?kiosk=1']) assert.equal(R.parseReloadHour(bad), null, bad)
  const at = (h, m = 0, s = 0, day = 20) => new Date(2026, 8, day, h, m, s).getTime()
  assert.equal(R.nextReloadAt(3, at(2, 59)), at(3), '還沒到 → 今天')
  assert.equal(R.nextReloadAt(3, at(3, 0, 0)), at(3, 0, 0, 21), '剛好整點 → 明天（重載後的新頁面不會連環重載）')
  assert.equal(R.nextReloadAt(3, at(3, 0, 5)), at(3, 0, 0, 21))
  assert.equal(R.nextReloadAt(0, at(23, 59)), at(0, 0, 0, 21))
})

test('flagSummary：只留已知旗標與短值，不記分享參數 / 遙控 host id', () => {
  assert.equal(R.flagSummary('?kiosk=1&s=abcdefabcdefabcdef&lang=en', ''), 'kiosk=1 lang=en')
  assert.equal(R.flagSummary('?audience', ''), 'audience')
  assert.equal(R.flagSummary('', '#remote=SECRET'), 'remote')
  assert.equal(R.flagSummary('?watchdog=1&reload=3&x=1', ''), 'watchdog=1 reload=3')
})

// ───────────────────────────── 崩潰紀錄 ─────────────────────────────
test('errorInfo / crashSignature：stack 只留前 300 字；非 Error 也能整理；簽章與種類、訊息、stack 有關', () => {
  const e = new Error('boom'); e.stack = 'Error: boom\n' + 'x'.repeat(1000)
  const i = R.errorInfo(e)
  assert.equal(i.message, 'boom'); assert.equal(i.stack.length, 300)
  assert.equal(R.errorInfo(new TypeError('bad')).message, 'TypeError: bad', '非 Error 型別把名稱放進訊息')
  assert.deepEqual(R.errorInfo('oops'), { name: '', message: 'oops', stack: '' })
  assert.equal(R.errorInfo(null).message, '')
  assert.equal(R.errorInfo({ toString() { throw new Error('x') } }).message.length >= 0, true, '連 toString 都會丟例外的物件也不能讓記錄本身出錯')
  assert.equal(R.errorInfo('a'.repeat(1000)).message.length, 300)
  assert.notEqual(R.crashSignature('render', 'a', 's'), R.crashSignature('error', 'a', 's'))
  assert.notEqual(R.crashSignature('render', 'a', 's'), R.crashSignature('render', 'b', 's'))
  assert.equal(R.crashSignature('render', 'a', 's'), R.crashSignature('render', 'a', 's'))
})

test('崩潰紀錄：欄位齊全（時間 / 訊息 / stack 前 300 字 / build id / 網址旗標）', () => {
  const mem = memStorage(); const env = makeEnv()
  const log = R.createCrashLog({ storage: mem, now: env.now, boot: 'B1' })
  const e = new Error('boom'); e.stack = 'Error: boom\n' + 'y'.repeat(900)
  const r = log.add({ kind: 'render', error: e, build: 'b-123', flags: 'kiosk=1' })
  assert.equal(r.isNew, true)
  const [x] = log.list()
  assert.equal(x.t, T0); assert.equal(x.kind, 'render'); assert.equal(x.msg, 'boom'); assert.equal(x.stack.length, 300)
  assert.equal(x.build, 'b-123'); assert.equal(x.flags, 'kiosk=1'); assert.equal(x.n, 1); assert.equal(x.fatal, true)
  assert.equal(mem.data.length, 1, '有寫進儲存')
})

test('崩潰紀錄：環狀最近 20 筆（新的擠掉舊的）', () => {
  const env = makeEnv(); const log = R.createCrashLog({ storage: memStorage(), now: env.now, boot: 'B' })
  for (let i = 0; i < 27; i++) { log.add({ kind: 'render', message: `err ${i}`, stack: '' }); env.advance(3000) }
  const l = log.list()
  assert.equal(l.length, 20)
  assert.equal(l[0].msg, 'err 7'); assert.equal(l[19].msg, 'err 26')
})

test('崩潰紀錄去重：同一次載入、同一個錯誤合併成一筆（StrictMode 雙呼叫 / 每幀重複丟出的錯誤不洗掉環狀紀錄）', () => {
  const env = makeEnv(); const mem = memStorage()
  const log = R.createCrashLog({ storage: mem, now: env.now, boot: 'B', flushMs: 2000 })
  const err = new Error('same')
  assert.equal(log.add({ kind: 'render', error: err }).isNew, true)
  const second = log.add({ kind: 'render', error: err })                    // StrictMode 的第二次 componentDidCatch
  assert.equal(second.coalesced, true); assert.equal(second.entry, null)
  assert.equal(log.list().length, 1)
  // 每 16ms 丟一次的錯誤：合併，且最多每 2 秒寫一次儲存
  let writes = 0; const save = mem.save; mem.save = (l) => { writes++; save(l) }
  for (let i = 0; i < 600; i++) { log.add({ kind: 'error', message: 'frame error', stack: 'at loop' }); env.advance(16) }
  assert.equal(log.list().filter((e) => e.msg === 'frame error').length, 1)
  assert.ok(writes <= 8, `寫入次數 ${writes}`)
  log.flush()
  const fe = log.list().find((e) => e.msg === 'frame error')
  assert.equal(fe.n, 600, '合併的次數在 flush 後補齊')
  assert.equal(log.list().length, 2, '兩種錯誤，兩筆')
})

test('崩潰紀錄去重只限「同一次載入」：重新載入後（新的 boot）同樣的錯誤是新的一筆', () => {
  const env = makeEnv(); const mem = memStorage()
  const a = R.createCrashLog({ storage: mem, now: env.now, boot: 'BOOT-A' })
  a.add({ kind: 'render', message: 'x', stack: 's' })
  env.advance(6000)
  const b = R.createCrashLog({ storage: mem, now: env.now, boot: 'BOOT-B' })
  assert.equal(b.add({ kind: 'render', message: 'x', stack: 's' }).isNew, true)
  assert.equal(b.list().length, 2)
})

test('崩潰紀錄：先讀後寫（兩個視窗共用儲存不互相覆蓋）、壞資料被清乾淨、儲存丟例外不影響頁面、clear', () => {
  const env = makeEnv(); const mem = memStorage()
  const w1 = R.createCrashLog({ storage: mem, now: env.now, boot: 'W1' })
  const w2 = R.createCrashLog({ storage: mem, now: env.now, boot: 'W2' })
  w1.add({ kind: 'render', message: 'from main', stack: '' })
  w2.add({ kind: 'webgl', message: 'from audience', stack: '' })
  assert.deepEqual(w1.list().map((e) => e.msg), ['from main', 'from audience'])
  // 壞資料
  const bad = memStorage([null, 3, 'x', { t: 'nope' }, { t: 5, kind: 'render', msg: 'ok', n: -4 }, { t: 6, kind: 'error', msg: 'm'.repeat(999), stack: 's'.repeat(999) }])
  const l = R.createCrashLog({ storage: bad, now: env.now }).list()
  assert.equal(l.length, 2); assert.equal(l[0].n, 1); assert.equal(l[1].msg.length, 300); assert.equal(l[1].stack.length, 300); assert.equal(l[1].fatal, false)
  assert.deepEqual(R.createCrashLog({ storage: { load: () => 'garbage', save() {}, clear() {} } }).list(), [])
  // 儲存丟例外（隱私模式 / 額滿）
  const boom = { load() { throw new Error('denied') }, save() { throw new Error('quota') }, clear() { throw new Error('denied') } }
  const safeLog = R.createCrashLog({ storage: boom, now: env.now })
  assert.doesNotThrow(() => { safeLog.add({ kind: 'render', message: 'x' }); safeLog.list(); safeLog.flush(); safeLog.clear() })
  // clear
  w1.clear(); assert.deepEqual(w1.list(), []); assert.equal(mem.data, null)
})

test('summarizeCrashes：總筆數不含資訊性的 reload；近 10 分鐘的造成重載次數', () => {
  const now = T0
  const s = R.summarizeCrashes([{ t: now - 20 * 60000, fatal: true, kind: 'render' }, { t: now - 1000, fatal: true, kind: 'webgl' }, { t: now - 500, fatal: false, kind: 'error' }, { t: now - 100, fatal: false, kind: 'reload' }], now)
  assert.deepEqual(s, { total: 3, fatal10: 1 })
})

// ───────────────────────────── 退避 + 熔斷 ─────────────────────────────
const F = (t) => ({ t, fatal: true, kind: 'render' })
test('planAutoReload：第 1 次 5 秒；1 分鐘內第 2 次 15 秒、第 3 次 60 秒', () => {
  const now = T0
  assert.deepEqual(R.planAutoReload([F(now)], now), { stop: false, delayMs: 5000, count1: 1, count10: 1 })
  assert.equal(R.planAutoReload([F(now - 30000), F(now)], now).delayMs, 15000)
  assert.equal(R.planAutoReload([F(now - 50000), F(now - 20000), F(now)], now).delayMs, 60000)
})

test('planAutoReload：10 分鐘內第 4 次仍等 60 秒；累積 5 次 → 停止自動重載', () => {
  const now = T0
  assert.equal(R.planAutoReload([F(now - 400000), F(now - 300000), F(now - 200000), F(now)], now).delayMs, 60000, '第 4 次（時間分散）也是最慢的一級')
  const five = [F(now - 500000), F(now - 400000), F(now - 300000), F(now - 200000), F(now)]
  const p = R.planAutoReload(five, now)
  assert.equal(p.stop, true); assert.equal(p.delayMs, null); assert.equal(p.count10, 5)
  assert.equal(R.planAutoReload([...five, F(now)], now).stop, true, '超過 5 次一樣停止')
})

test('planAutoReload：同一瞬間記下的多筆致命事件算一次事故（React 一次 render 多個元件同時丟錯）', () => {
  const now = Date.now(), F = (t) => ({ t, fatal: true })
  // 兩個元件在同一個任務裡各丟一次錯 → 各呼叫一次邊界 → 兩筆同時間的 fatal：只能算 1 次（5 秒），不是 2 次（15 秒）
  assert.deepEqual(R.planAutoReload([F(now), F(now)], now), { stop: false, delayMs: 5000, count1: 1, count10: 1 })
  assert.equal(R.planAutoReload([F(now - 100), F(now - 60), F(now)], now).count10, 1)
  // 真正相隔 1 秒以上的仍是兩次事故
  assert.equal(R.planAutoReload([F(now - 1000), F(now)], now).delayMs, 15000)
  // 熔斷不被稀釋也不被提早：3 次真的崩潰（每次雙筆）不會停手，第 5 次才停
  const dbl = (t) => [F(t), F(t)]
  assert.equal(R.planAutoReload([...dbl(now - 400000), ...dbl(now - 300000), ...dbl(now)], now).stop, false)
  assert.equal(R.planAutoReload([...dbl(now - 500000), ...dbl(now - 400000), ...dbl(now - 300000), ...dbl(now - 200000), ...dbl(now)], now).stop, true)
})

test('planAutoReload：超過 10 分鐘的舊崩潰不算；只算會重載的（fatal）；壞輸入不丟例外', () => {
  const now = T0
  const old = [F(now - 600001), F(now - 700000), F(now - 800000), F(now - 900000)]
  assert.equal(R.planAutoReload([...old, F(now)], now).stop, false, '4 筆已超過 10 分鐘 → 只剩 1 筆')
  assert.equal(R.planAutoReload([...old, F(now)], now).delayMs, 5000)
  assert.equal(R.planAutoReload([F(now - 600000), F(now - 3000), F(now - 2000), F(now - 1000), F(now)], now).stop, true, '剛好 10 分鐘（含）仍算')
  const noisy = [{ t: now, fatal: false, kind: 'error' }, { t: now, fatal: false, kind: 'error' }, { t: now, fatal: false, kind: 'reload' }, { t: now, fatal: false, kind: 'error' }, { t: now, fatal: false, kind: 'rejection' }]
  assert.equal(R.planAutoReload([...noisy, F(now)], now).delayMs, 5000, '非致命事件不推進退避、不觸發熔斷')
  assert.equal(R.planAutoReload([F(now - 65000), F(now)], now).delayMs, 5000, '超過 1 分鐘的不算「1 分鐘內」')
  assert.doesNotThrow(() => { R.planAutoReload(null, now); R.planAutoReload([null, {}, { t: 'x', fatal: true }], now) })
})

test('reloadDelayFor：畫面錯誤用倒數；WebGL / 看門狗第一次直接重載，反覆發生才退避；熔斷 → null', () => {
  const p1 = { stop: false, delayMs: 5000, count1: 1, count10: 1 }, p2 = { stop: false, delayMs: 15000, count1: 2, count10: 2 }
  assert.equal(R.reloadDelayFor('render', p1), 5000)
  assert.equal(R.reloadDelayFor('webgl', p1), 0)
  assert.equal(R.reloadDelayFor('watchdog', p1), 0)
  assert.equal(R.reloadDelayFor('webgl', p2), 15000)
  assert.equal(R.reloadDelayFor('webgl', { stop: false, delayMs: 60000, count1: 1, count10: 4 }), 60000, '10 分鐘內第 4 次（時間分散）也要等')
  assert.equal(R.reloadDelayFor('webgl', { stop: false, delayMs: 5000, count1: 1, count10: 2 }), 0)
  assert.equal(R.reloadDelayFor('render', { stop: true }), null)
  assert.equal(R.reloadDelayFor('render', null), null)
})

// ───────────────────────────── 看門狗 ─────────────────────────────
test('watchdogVerdict：未啟用 / 不可見 / 卡死 / 正常；從「變可見」起算；門檻是嚴格大於', () => {
  const base = { enabled: true, visible: true, now: 100000, lastFrameAt: 95000, visibleSince: 0, stallMs: 10000 }
  assert.equal(R.watchdogVerdict({ ...base, enabled: false, lastFrameAt: 0 }), 'off')
  assert.equal(R.watchdogVerdict({ ...base, visible: false, lastFrameAt: 0 }), 'hidden')
  assert.equal(R.watchdogVerdict(base), 'ok')
  assert.equal(R.watchdogVerdict({ ...base, lastFrameAt: 90000 }), 'ok', '剛好 10 秒 → 還不算')
  assert.equal(R.watchdogVerdict({ ...base, lastFrameAt: 89999 }), 'stalled')
  assert.equal(R.watchdogVerdict({ ...base, lastFrameAt: 50000, visibleSince: 99000 }), 'ok', '背景很久、剛切回來：從變可見起算，不誤判')
  assert.equal(R.watchdogVerdict({ ...base, lastFrameAt: 1000, visibleSince: 50000 }), 'stalled')
  assert.equal(R.watchdogVerdict({ ...base, lastFrameAt: undefined, visibleSince: undefined }), 'stalled', '從來沒有幀 → 卡死')
})

test('看門狗：正常幀不誤判；內嵌預覽面板的 1fps（慢但不為零）也不誤判', () => {
  for (const every of [16, 100, 1000, 3000]) {
    const env = makeEnv(); env.rafEveryMs = every
    const status = R.createStatusStore(R.initialStatus()); let stalls = 0
    const wd = R.createWatchdog({ env, status, onStall: () => stalls++ })
    env.advance(120000)
    assert.equal(stalls, 0, `${every}ms 一幀`)
    wd.stop()
  }
})

test('看門狗：可見卻超過 10 秒沒有 rAF → 判定卡死，只動作一次；不到 10 秒不動作', () => {
  const env = makeEnv(); const status = R.createStatusStore(R.initialStatus()); const calls = []
  const wd = R.createWatchdog({ env, status, onStall: (x) => calls.push(x) })
  env.advance(3000)
  env.rafOn = false                      // rAF 停了（GPU 卡死 / 渲染程序卡住）
  env.advance(9000)
  assert.equal(calls.length, 0, '9 秒 → 還沒到門檻')
  env.advance(7000)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].stalledMs > 10000)
  assert.equal(status.get().watchdog.stalled, true)
  env.advance(60000)
  assert.equal(calls.length, 1, '只動作一次（之後由重載器接手）')
  wd.stop()
})

test('看門狗：分頁不可見時不判定；切回可見後從那一刻起算', () => {
  const env = makeEnv(); const status = R.createStatusStore(R.initialStatus()); let stalls = 0
  const wd = R.createWatchdog({ env, status, onStall: () => stalls++ })
  env.advance(2000)
  env.doc.visibilityState = 'hidden'; env.doc.emit('visibilitychange')
  env.advance(10 * 60 * 1000)            // 背景 10 分鐘：瀏覽器停 rAF
  assert.equal(stalls, 0)
  env.doc.visibilityState = 'visible'; env.doc.emit('visibilitychange')
  env.advance(1000)                      // 切回來，rAF 恢復
  assert.equal(stalls, 0)
  env.advance(30000)
  assert.equal(stalls, 0)
  // 切回可見後 rAF 一直沒恢復 → 才算卡死
  env.doc.visibilityState = 'hidden'; env.doc.emit('visibilitychange'); env.advance(5000)
  env.doc.visibilityState = 'visible'; env.doc.emit('visibilitychange'); env.rafOn = false
  env.advance(9000); assert.equal(stalls, 0)
  env.advance(8000); assert.equal(stalls, 1)
  wd.stop()
})

test('看門狗：主執行緒被長時間占住後計時器先於 rAF 回來 → 連續 2 次才動作，不誤判', () => {
  const env = makeEnv(); const status = R.createStatusStore(R.initialStatus()); let stalls = 0
  const wd = R.createWatchdog({ env, status, onStall: () => stalls++ })
  env.advance(5000)
  env.jump(60000)                        // 卡了一分鐘（計時器與 rAF 都沒跑）
  env.advance(200)                       // 恢復：同一步裡計時器先跑（第 1 次 stalled）、rAF 隨後回來
  env.advance(10000)
  assert.equal(stalls, 0)
  wd.stop()
})

test('看門狗：stop 清掉 rAF / 計時器 / 監聽；沒有 rAF 的環境功能偵測後略過', () => {
  const env = makeEnv(); const status = R.createStatusStore(R.initialStatus())
  const wd = R.createWatchdog({ env, status, onStall() {} })
  assert.ok(env.counts().rafs === 1 && env.counts().timers === 1 && env.counts().doc === 1)
  wd.stop(); wd.stop()
  assert.deepEqual(env.counts(), { timers: 0, rafs: 0, doc: 0, canvas: 0 })
  const noRaf = makeEnv(); noRaf.raf = null
  const w2 = R.createWatchdog({ env: noRaf, status, onStall() {} })
  assert.equal(w2.supported, false); assert.equal(noRaf.counts().timers, 0)
  assert.equal(R.createWatchdog({ env: { ...noRaf, doc: null }, status, onStall() {} }).supported, false)
})

// ───────────────────────────── WebGL context 遺失 ─────────────────────────────
test('WebGL：遺失 → preventDefault、狀態 lost；4 秒內沒 restore → 放棄（重新載入）', () => {
  const env = makeEnv(); const status = R.createStatusStore(R.initialStatus()); let gaveUp = 0
  const c = makeCanvas(); env.canvases.push(c)
  const g = R.createGlGuard({ env, status, onGiveUp: () => gaveUp++ })
  const ev = c.emit('webglcontextlost')
  assert.equal(ev.defaultPrevented, true, '要 preventDefault，瀏覽器才有機會 restore')
  assert.equal(status.get().gl.state, 'lost')
  env.advance(3900); assert.equal(gaveUp, 0)
  env.advance(200); assert.equal(gaveUp, 1)
  assert.equal(status.get().gl.state, 'reloading')
  g.stop()
})

test('WebGL：4 秒內 restore → 不重載，顯示「已恢復」；之後再遺失又重新計時', () => {
  const env = makeEnv(); const status = R.createStatusStore(R.initialStatus()); let gaveUp = 0
  const c = makeCanvas(); env.canvases.push(c)
  const g = R.createGlGuard({ env, status, onGiveUp: () => gaveUp++ })
  c.emit('webglcontextlost'); env.advance(2500); c.emit('webglcontextrestored')
  assert.equal(status.get().gl.state, 'restored')
  env.advance(10000); assert.equal(gaveUp, 0)
  c.emit('webglcontextlost'); env.advance(4100); assert.equal(gaveUp, 1)
  g.stop()
})

test('WebGL：分頁在背景時遺失 → 不在背景重載，回到前景後再給 4 秒（瀏覽器回收記憶體時很常見）；回到前景就 restore 則不重載', () => {
  const env = makeEnv(); const status = R.createStatusStore(R.initialStatus()); let gaveUp = 0
  const c = makeCanvas(); env.canvases.push(c)
  const g = R.createGlGuard({ env, status, onGiveUp: () => gaveUp++ })
  env.doc.visibilityState = 'hidden'; env.doc.emit('visibilitychange')
  c.emit('webglcontextlost'); env.advance(60000)
  assert.equal(gaveUp, 0, '背景：不重載')
  env.doc.visibilityState = 'visible'; env.doc.emit('visibilitychange')
  env.advance(3900); assert.equal(gaveUp, 0)
  env.advance(200); assert.equal(gaveUp, 1, '回到前景 4 秒仍沒恢復 → 重載')
  g.stop()
  const e2 = makeEnv(); const s2 = R.createStatusStore(R.initialStatus()); let n = 0
  const c2 = makeCanvas(); e2.canvases.push(c2)
  const g2 = R.createGlGuard({ env: e2, status: s2, onGiveUp: () => n++ })
  e2.doc.visibilityState = 'hidden'; e2.doc.emit('visibilitychange'); c2.emit('webglcontextlost'); e2.advance(10000)
  e2.doc.visibilityState = 'visible'; e2.doc.emit('visibilitychange'); e2.advance(1000); c2.emit('webglcontextrestored'); e2.advance(30000)
  assert.equal(n, 0); assert.equal(s2.get().gl.state, 'restored')
  g2.stop(); assert.deepEqual(e2.counts(), { timers: 0, rafs: 0, doc: 0, canvas: 0 })
})

test('WebGL：canvas 非同步出現 / 被換掉 → 重新綁定；優先 data-engine 的 canvas（QR 的 2D canvas 不算）；換掉時清掉舊 canvas 的遺失狀態', () => {
  const env = makeEnv(); const status = R.createStatusStore(R.initialStatus()); let gaveUp = 0
  const g = R.createGlGuard({ env, status, onGiveUp: () => gaveUp++ })
  assert.equal(g.current(), null, '一開始還沒有 canvas')
  const qr = makeCanvas(false); env.canvases.push(qr); env.advance(2000)
  assert.equal(g.current(), qr, '只有 2D canvas 時退而求其次（之後有更好的會換）')
  const gl1 = makeCanvas(true); env.canvases.unshift(qr); env.canvases.push(gl1); env.advance(2000)
  assert.equal(g.current(), gl1, '有 data-engine 的優先')
  assert.equal(qr.count(), 0, '舊的已解除監聽')
  gl1.emit('webglcontextlost')
  const gl2 = makeCanvas(true); env.canvases.length = 0; env.canvases.push(gl2); env.advance(2000)   // 場景被重新掛載：新 canvas = 新 context
  assert.equal(g.current(), gl2); assert.equal(gl1.count(), 0)
  assert.equal(status.get().gl.state, 'idle')
  env.advance(10000); assert.equal(gaveUp, 0, '舊 canvas 的遺失計時已取消')
  g.stop()
  assert.equal(gl2.count(), 0); assert.deepEqual(env.counts(), { timers: 0, rafs: 0, doc: 0, canvas: 0 })
})

test('WebGL：沒有 document 或不支援 querySelectorAll → 略過，不丟例外', () => {
  const env = makeEnv(); const status = R.createStatusStore(R.initialStatus())
  assert.equal(R.createGlGuard({ env: { ...env, doc: null }, status, onGiveUp() {} }).supported, false)
  assert.equal(R.createGlGuard({ env: { ...env, doc: {} }, status, onGiveUp() {} }).supported, false)
})

// ───────────────────────────── 版本 / 資料 比較 ─────────────────────────────
test('compareVersion：same / new / unknown / skip（dev）', () => {
  assert.equal(R.compareVersion('b1', { id: 'b1', builtAt: 'x' }), 'same')
  assert.equal(R.compareVersion('b1', { id: 'b2' }), 'new')
  assert.equal(R.compareVersion('b1', {}), 'unknown')
  assert.equal(R.compareVersion('b1', null), 'unknown')
  assert.equal(R.compareVersion('b1', { id: '' }), 'unknown')
  assert.equal(R.compareVersion('b1', { id: 123 }), 'unknown')
  assert.equal(R.compareVersion('b1', { id: 'x'.repeat(81) }), 'unknown')
  assert.equal(R.compareVersion('dev', { id: 'b2' }), 'skip')
  assert.equal(R.compareVersion('', { id: 'b2' }), 'skip')
  assert.deepEqual(R.parseVersion({ id: ' b1 ', builtAt: '2026-01-01T00:00:00Z' }), { id: 'b1', builtAt: '2026-01-01T00:00:00Z' })
})

test('compareData：遠端較新 / 相同 / 較舊 / 沒有可用時間戳；本機沒有時間戳 → 遠端較新', () => {
  assert.equal(R.compareData('2026-09-20T20:00', '2026-09-20T21:00'), 'newer')
  assert.equal(R.compareData('2026-09-20T20:00', '2026-09-20T20:00'), 'same')
  assert.equal(R.compareData('2026-09-20T20:00', '2026-09-20T19:59'), 'older')
  assert.equal(R.compareData('2026-09-20T20:00', undefined), 'unknown')
  assert.equal(R.compareData('2026-09-20T20:00', ''), 'unknown')
  assert.equal(R.compareData('2026-09-20T20:00', 'not a date'), 'unknown')
  assert.equal(R.compareData(null, '2026-09-20T20:00'), 'newer')
  assert.equal(R.compareData(undefined, '2026-09-20T20:00'), 'newer')
  assert.equal(R.compareData('2026-09-20T20:00', '2026-09-21T00:00'), 'newer', '跨日')
  assert.equal(R.compareData('2026-09-20T20:00', '2026-09-20T20:00:30'), 'newer', '秒的差異')
})

test('isValidOcean / pickOptionId：有 params 或非空 options 才算；換資料時保留目前的海況選項', () => {
  assert.equal(R.isValidOcean({ params: {} }), true)
  assert.equal(R.isValidOcean({ options: [{ id: 'a' }] }), true)
  for (const bad of [null, undefined, 3, 'x', {}, { options: [] }, []]) assert.equal(R.isValidOcean(bad), false, String(bad))
  const gov = { defaultOption: 'feitsui', options: [{ id: 'feitsui' }, { id: 'zengwen' }] }
  assert.equal(R.pickOptionId(gov, 'zengwen'), 'zengwen', '使用者選的還在 → 保留')
  assert.equal(R.pickOptionId(gov, 'gone'), 'feitsui', '選的不見了 → 資料預設')
  assert.equal(R.pickOptionId(gov, null), 'feitsui')
  assert.equal(R.pickOptionId({ options: [{ id: 'z' }] }, 'q'), 'z')
  assert.equal(R.pickOptionId({}, 'q'), null); assert.equal(R.pickOptionId(null, 'q'), null)
})

// ───────────────────────────── 閒置判斷 ─────────────────────────────
test('evaluateIdle：無人操作 ≥ 60 秒且沒有錄製 / 播放 / 導覽 / 彈窗才算閒置（依序回報原因）', () => {
  const ok = { idleMs: 61000, recMode: 'idle', tourRunning: false, tourAuto: false, modalOpen: false }
  assert.deepEqual(R.evaluateIdle(ok), { idle: true, reason: '' })
  assert.deepEqual(R.evaluateIdle({ ...ok, idleMs: 60000 }), { idle: true, reason: '' }, '剛好 60 秒')
  assert.deepEqual(R.evaluateIdle({ ...ok, idleMs: 59999 }), { idle: false, reason: 'active' })
  assert.deepEqual(R.evaluateIdle({ ...ok, modalOpen: true }), { idle: false, reason: 'modal' })
  assert.deepEqual(R.evaluateIdle({ ...ok, recMode: 'recording' }), { idle: false, reason: 'recording' })
  assert.deepEqual(R.evaluateIdle({ ...ok, recMode: 'playing' }), { idle: false, reason: 'playing' })
  assert.deepEqual(R.evaluateIdle({ ...ok, tourRunning: true }), { idle: false, reason: 'tour' })
  assert.deepEqual(R.evaluateIdle({ ...ok, tourRunning: true, recMode: 'playing' }), { idle: false, reason: 'tour' })
  assert.deepEqual(R.evaluateIdle({ ...ok, modalOpen: true, idleMs: 1 }), { idle: false, reason: 'modal' }, '彈窗優先')
  assert.equal(R.evaluateIdle({}).idle, false); assert.equal(R.evaluateIdle(null).idle, false); assert.equal(R.evaluateIdle(undefined).reason, 'active')
  assert.equal(R.evaluateIdle({ idleMs: Infinity }).idle, true, '觀眾視窗沒有人為輸入 → 永遠閒置')
  assert.equal(R.evaluateIdle(R.DEFAULT_IDLE_STATE).idle, true)
})

test('evaluateIdle：展場（或閒置自動啟動的導覽）本來就是沒人時的常態 → 導覽 / 播放不算忙，但錄製、彈窗、有人操作仍算', () => {
  const ok = { idleMs: 61000, recMode: 'playing', tourRunning: true, tourAuto: false, modalOpen: false }
  assert.equal(R.evaluateIdle(ok, { kiosk: true }).idle, true)
  assert.equal(R.evaluateIdle({ ...ok, tourAuto: true }, { kiosk: false }).idle, true, '自動導覽（閒置啟動）即使非展場也算')
  assert.equal(R.evaluateIdle(ok, { kiosk: false }).idle, false, '手動導覽 + 非展場 → 忙')
  assert.equal(R.evaluateIdle({ ...ok, recMode: 'recording' }, { kiosk: true }).reason, 'recording')
  assert.equal(R.evaluateIdle({ ...ok, modalOpen: true }, { kiosk: true }).reason, 'modal')
  assert.equal(R.evaluateIdle({ ...ok, idleMs: 5000 }, { kiosk: true }).reason, 'active')
  assert.equal(R.evaluateIdle({ ...ok, tourRunning: false }, { kiosk: true }).idle, false, '展場但是使用者自己的播放（沒有導覽）→ 忙')
})

// ───────────────────────────── 重載器 ─────────────────────────────
test('重載器：第一次 WebGL / 看門狗異常立刻重載並記錄；反覆發生套退避；10 分鐘 5 次熔斷（不再重載、halted）', () => {
  const s = setup('?kiosk=1')
  const r1 = s.reloader.crash('webgl', new Error('lost'))
  assert.equal(r1.ok, true); assert.equal(s.env.reloads.length, 1, '第一次：直接重載')
  assert.equal(s.log.list()[0].kind, 'webgl'); assert.equal(s.log.list()[0].build, 'b1'); assert.equal(s.log.list()[0].flags, 'kiosk=1')
  assert.equal(s.status.get().crashRev, 1)
  // 新的頁面載入（新的重載器 / boot），30 秒後再次異常 → 15 秒後才重載
  const mk = (boot) => R.createReloader({ env: s.env, status: s.status, crashLog: R.createCrashLog({ storage: s.mem, now: s.env.now, boot }), cfg: s.cfg })
  s.env.advance(30000)
  const rl2 = mk('B2'); const r2 = rl2.crash('watchdog', new Error('stall'))
  assert.equal(r2.delayMs, 15000); assert.equal(s.env.reloads.length, 1)
  s.env.advance(14900); assert.equal(s.env.reloads.length, 1)
  s.env.advance(200); assert.equal(s.env.reloads.length, 2)
  // 第 3、4、5 次（都在 10 分鐘內）
  s.env.advance(10000); const r3 = mk('B3').crash('webgl', new Error('lost 3')); assert.equal(r3.delayMs, 60000)
  s.env.advance(70000); const r4 = mk('B4').crash('webgl', new Error('lost 4')); assert.equal(r4.delayMs, 60000)
  s.env.advance(70000)
  const before = s.env.reloads.length
  const r5 = mk('B5').crash('webgl', new Error('lost 5'))
  assert.equal(r5.ok, false); assert.equal(r5.halted, true)
  assert.equal(s.status.get().halted, true)
  s.env.advance(5 * 60000); assert.equal(s.env.reloads.length, before, '熔斷後不再自動重載')
})

test('重載器：單次飛行（已排定 / 已重載就不再排）；cancel 取消排定；soft 重載寫資訊性紀錄、不受熔斷影響', () => {
  const s = setup('')
  s.reloader.crash('webgl', new Error('a'))         // 第 1 次：立即重載（fired）
  assert.equal(s.reloader.crash('webgl', new Error('b')).already, true)
  assert.equal(s.env.reloads.length, 1)
  const s2 = setup('')
  s2.log.add({ kind: 'webgl', message: 'x', stack: '1' }); s2.env.advance(1000); s2.log.add({ kind: 'webgl', message: 'y', stack: '2' })   // 已有 2 筆 → 這次要等
  const r = s2.reloader.crash('webgl', new Error('z')); assert.ok(r.delayMs > 0)
  assert.equal(s2.reloader.pending(), true); assert.equal(s2.status.get().reloading.reason, 'webgl')
  s2.reloader.cancel(); assert.equal(s2.reloader.pending(), false); assert.equal(s2.status.get().reloading, null)
  s2.env.advance(120000); assert.equal(s2.env.reloads.length, 0)
  // soft
  const s3 = setup('')
  for (let i = 0; i < 6; i++) { s3.log.add({ kind: 'render', message: 'e' + i, stack: '' }); s3.env.advance(1000) } // 相隔 1 秒 = 6 次各自獨立的事故（同一瞬間的會併成一次）
  assert.equal(s3.reloader.soft('version'), true); assert.equal(s3.env.reloads.length, 1, '一般重載不看熔斷')
  assert.equal(s3.reloader.soft('daily'), false, '已重載就不再重複')
  const last = s3.log.list().at(-1)
  assert.equal(last.kind, 'reload'); assert.equal(last.msg, 'version'); assert.equal(last.fatal, false)
  assert.equal(R.planAutoReload(s3.log.list(), s3.env.now()).count10, 6, 'reload 事件不算進熔斷')
})

// ───────────────────────────── 版本檢查 ─────────────────────────────
test('版本檢查：每 10 分鐘（展場 5 分鐘）以 fetch(/version.json, {cache:no-store}) 比對', async () => {
  for (const [search, every] of [['', 600000], ['?kiosk=1', 300000]]) {
    const s = setup(search)
    s.env.respond = () => jsonRes({ id: 'b1' })
    const vc = R.createVersionChecker({ env: s.env, status: s.status, cfg: s.cfg, reloader: s.reloader, getIdle: s.getIdle })
    s.env.advance(every - 1000); await flush(); assert.equal(s.env.fetches.length, 0, search)
    s.env.advance(1000); await flush()
    assert.equal(s.env.fetches.length, 1, search)
    assert.deepEqual(s.env.fetches[0], { url: '/version.json', init: { cache: 'no-store' } })
    assert.equal(s.status.get().version.state, 'same'); assert.equal(s.status.get().version.checkedAt, s.env.now())
    assert.equal(s.env.reloads.length, 0)
    s.env.advance(every); await flush(); assert.equal(s.env.fetches.length, 2)
    vc.stop(); assert.deepEqual(s.env.counts(), { timers: 0, rafs: 0, doc: 0, canvas: 0 })
  }
})

test('版本檢查：有新版 + 閒置 → 重新載入（寫資訊性紀錄）', async () => {
  const s = setup('')
  s.env.idle.idleMs = 120000
  s.env.respond = () => jsonRes({ id: 'b2', builtAt: 'x' })
  const vc = R.createVersionChecker({ env: s.env, status: s.status, cfg: s.cfg, reloader: s.reloader, getIdle: s.getIdle })
  await vc.check(); await flush()
  assert.equal(s.env.reloads.length, 1)
  assert.equal(s.status.get().version.state, 'new'); assert.equal(s.status.get().version.remoteId, 'b2')
  assert.equal(s.log.list().at(-1).kind, 'reload')
  vc.stop()
})

test('版本檢查：有新版但忙碌 → 不打擾，只在維運狀態記錄；每 15 秒再看，一閒置就重載', async () => {
  const s = setup('')
  s.env.respond = () => jsonRes({ id: 'b2' })
  const vc = R.createVersionChecker({ env: s.env, status: s.status, cfg: s.cfg, reloader: s.reloader, getIdle: s.getIdle })
  s.env.idle.idleMs = 5000
  await vc.check(); await flush()
  assert.equal(s.env.reloads.length, 0)
  assert.equal(s.status.get().version.state, 'new'); assert.equal(s.status.get().version.deferred, 'active')
  s.env.idle.idleMs = 20000; s.env.advance(60000); assert.equal(s.env.reloads.length, 0, '仍有人在操作（<60 秒）')
  s.env.idle.modalOpen = true; s.env.idle.idleMs = 90000; s.env.advance(30000)
  assert.equal(s.env.reloads.length, 0, '彈窗開著'); assert.equal(s.status.get().version.deferred, 'modal')
  s.env.idle.modalOpen = false; s.env.advance(15000)
  assert.equal(s.env.reloads.length, 1)
  vc.stop()
})

test('版本檢查：忙碌的種類——錄製 / 播放 / 導覽都延後；展場的自動導覽與播放不算忙', async () => {
  const cases = [
    ['', { recMode: 'recording', idleMs: 99999 }, false], ['', { recMode: 'playing', idleMs: 99999 }, false], ['', { tourRunning: true, idleMs: 99999 }, false],
    ['?kiosk=1', { tourRunning: true, recMode: 'playing', idleMs: 99999 }, true], ['?kiosk=1', { recMode: 'recording', idleMs: 99999 }, false], ['?kiosk=1', { idleMs: 1000 }, false],
  ]
  for (const [search, idle, expectReload] of cases) {
    const s = setup(search); Object.assign(s.env.idle, idle)
    s.env.respond = () => jsonRes({ id: 'b2' })
    const vc = R.createVersionChecker({ env: s.env, status: s.status, cfg: s.cfg, reloader: s.reloader, getIdle: s.getIdle })
    await vc.check(); await flush()
    assert.equal(s.env.reloads.length === 1, expectReload, `${search} ${JSON.stringify(idle)}`)
    vc.stop()
  }
})

test('版本檢查：?autoupdate=0 → 有新版只記錄，不論多閒置都不重載', async () => {
  const s = setup('?autoupdate=0'); s.env.idle.idleMs = 1e9
  s.env.respond = () => jsonRes({ id: 'b2' })
  const vc = R.createVersionChecker({ env: s.env, status: s.status, cfg: s.cfg, reloader: s.reloader, getIdle: s.getIdle })
  await vc.check(); s.env.advance(10 * 60000); await flush()
  assert.equal(s.env.reloads.length, 0); assert.equal(s.status.get().version.state, 'new')
  vc.stop()
})

test('版本檢查：fetch 失敗 / 非 200 / 非 JSON / 內容無效 → 靜默略過（不丟例外、不重載），之後再試', async () => {
  const s = setup(''); s.env.idle.idleMs = 1e9
  const vc = R.createVersionChecker({ env: s.env, status: s.status, cfg: s.cfg, reloader: s.reloader, getIdle: s.getIdle })
  const bodies = [() => { throw new Error('offline') }, () => jsonRes({}, false), () => ({ ok: true, json: async () => { throw new SyntaxError('<!doctype') } }), () => jsonRes({ nope: 1 }), () => jsonRes(null), () => null]
  for (const b of bodies) {
    s.env.respond = b
    await assert.doesNotReject(vc.check())
    assert.equal(s.status.get().version.state, 'error')
    assert.equal(s.env.reloads.length, 0)
  }
  s.env.respond = () => jsonRes({ id: 'b1' }); await vc.check()
  assert.equal(s.status.get().version.state, 'same', '恢復連線後正常')
  vc.stop()
})

test('版本檢查：已知有新版時，之後離線失敗不蓋掉「有新版」；stop 之後回來的結果不生效', async () => {
  const s = setup(''); s.env.idle.idleMs = 5000
  s.env.respond = () => jsonRes({ id: 'b2' })
  const vc = R.createVersionChecker({ env: s.env, status: s.status, cfg: s.cfg, reloader: s.reloader, getIdle: s.getIdle })
  await vc.check()
  s.env.respond = () => { throw new Error('offline') }; await vc.check()
  assert.equal(s.status.get().version.state, 'new')
  // stop 後才回來
  const s2 = setup(''); s2.env.idle.idleMs = 1e9
  let release; s2.env.respond = () => new Promise((res) => { release = () => res(jsonRes({ id: 'b2' })) })
  const v2 = R.createVersionChecker({ env: s2.env, status: s2.status, cfg: s2.cfg, reloader: s2.reloader, getIdle: s2.getIdle })
  const p = v2.check(); await flush(); v2.stop(); release(); await p; await flush()
  assert.equal(s2.env.reloads.length, 0); assert.equal(s2.status.get().version.state, 'idle')
  vc.stop()
})

// ───────────────────────────── 資料更新 ─────────────────────────────
function dataSetup(search = '', local = '2026-09-20T20:00') {
  const s = setup(search)
  const applied = [], logged = []
  s.env.getLocalFetchedAt = () => local
  s.env.applyData = (d) => { applied.push(d); local = d.fetchedAt }
  s.env.onDataApplied = (d) => logged.push(d.fetchedAt)
  s.env.idle.idleMs = 120000
  const dr = R.createDataRefresher({ env: s.env, status: s.status, cfg: s.cfg, getIdle: s.getIdle })
  return { ...s, dr, applied, logged, setLocal: (v) => { local = v } }
}
const oceanAt = (at) => ({ fetchedAt: at, defaultOption: 'a', options: [{ id: 'a' }] })

test('資料更新：每 30 分鐘（展場）/ 3 小時（一般）以 fetch(/data/ocean.json, {cache:no-store}) 重抓；較新且閒置 → 套用並通知', async () => {
  for (const [search, every] of [['?kiosk=1', 30 * 60000], ['', 3 * 3600000]]) {
    const s = dataSetup(search)
    s.env.respond = () => jsonRes(oceanAt('2026-09-20T21:00'))
    s.env.advance(every - 1000); await flush(); assert.equal(s.env.fetches.length, 0, search)
    s.env.advance(1000); await flush()
    assert.deepEqual(s.env.fetches[0], { url: '/data/ocean.json', init: { cache: 'no-store' } })
    assert.equal(s.applied.length, 1, search); assert.deepEqual(s.logged, ['2026-09-20T21:00'])
    assert.equal(s.status.get().data.state, 'applied'); assert.equal(s.status.get().data.remoteFetchedAt, '2026-09-20T21:00')
    s.dr.stop(); assert.deepEqual(s.env.counts(), { timers: 0, rafs: 0, doc: 0, canvas: 0 })
  }
})

test('資料更新：fetchedAt 相同 / 較舊 / 沒有時間戳 / 內容無效 → 不套用', async () => {
  const s = dataSetup()
  for (const [body, expect] of [[oceanAt('2026-09-20T20:00'), 'same'], [oceanAt('2026-09-20T18:00'), 'same'], [{ options: [{ id: 'a' }] }, 'error'], [{ fetchedAt: '2026-09-21T00:00' }, 'error'], [null, 'error']]) {
    s.env.respond = () => jsonRes(body)
    await s.dr.check()
    assert.equal(s.applied.length, 0, JSON.stringify(body))
    assert.equal(s.status.get().data.state, expect, JSON.stringify(body))
  }
  s.dr.stop()
})

test('資料更新：忙碌（有人操作 / 錄製 / 資料播放 / 手動導覽 / 彈窗）時排到閒置再套；一閒置（15 秒內）就套一次', async () => {
  const busyStates = [{ idleMs: 3000 }, { recMode: 'recording' }, { recMode: 'playing' }, { tourRunning: true }, { modalOpen: true }]
  for (const bs of busyStates) {
    const s = dataSetup('')
    s.env.respond = () => jsonRes(oceanAt('2026-09-20T21:00'))
    Object.assign(s.env.idle, bs)
    await s.dr.check(); await flush()
    assert.equal(s.applied.length, 0, JSON.stringify(bs))
    assert.equal(s.status.get().data.state, 'pending'); assert.ok(s.status.get().data.deferred)
    s.env.advance(120000); assert.equal(s.applied.length, 0, '一直忙 → 一直等')
    Object.assign(s.env.idle, { idleMs: 200000, recMode: 'idle', tourRunning: false, modalOpen: false })
    s.env.advance(15000)
    assert.equal(s.applied.length, 1, JSON.stringify(bs)); assert.equal(s.status.get().data.state, 'applied')
    s.env.advance(120000); assert.equal(s.applied.length, 1, '只套一次')
    s.dr.stop()
  }
})

test('資料更新：展場的自動導覽 / 播放中可以套用（否則展場永遠等不到閒置）；使用者自己的錄製不行', async () => {
  const a = dataSetup('?kiosk=1')
  a.env.respond = () => jsonRes(oceanAt('2026-09-20T21:00'))
  Object.assign(a.env.idle, { tourRunning: true, recMode: 'playing' })
  await a.dr.check(); await flush()
  assert.equal(a.applied.length, 1)
  const b = dataSetup('?kiosk=1'); b.env.respond = () => jsonRes(oceanAt('2026-09-20T21:00')); b.env.idle.recMode = 'recording'
  await b.dr.check(); await flush(); assert.equal(b.applied.length, 0)
  a.dr.stop(); b.dr.stop()
})

test('資料更新：等閒置期間又抓到更新的一版 → 套最新的；等待期間遠端變成與本機相同 → 放棄', async () => {
  const s = dataSetup('')
  s.env.idle.idleMs = 1000
  s.env.respond = () => jsonRes(oceanAt('2026-09-20T21:00')); await s.dr.check()
  s.env.respond = () => jsonRes(oceanAt('2026-09-20T22:00')); await s.dr.check()
  s.env.idle.idleMs = 999999; s.env.advance(15000)
  assert.deepEqual(s.applied.map((d) => d.fetchedAt), ['2026-09-20T22:00'])
  const t = dataSetup(''); t.env.idle.idleMs = 1000
  t.env.respond = () => jsonRes(oceanAt('2026-09-20T21:00')); await t.dr.check()
  t.setLocal('2026-09-20T21:00')                 // 別處已經換成這一版
  t.env.respond = () => jsonRes(oceanAt('2026-09-20T21:00')); await t.dr.check()
  t.env.idle.idleMs = 999999; t.env.advance(60000); assert.equal(t.applied.length, 0)
  s.dr.stop(); t.dr.stop()
})

test('資料更新：失敗（離線 / 非 200 / 非 JSON）靜默、下次再試；套用時丟例外不影響頁面且之後可重試', async () => {
  const s = dataSetup('?kiosk=1')
  for (const b of [() => { throw new Error('offline') }, () => jsonRes({}, false), () => ({ ok: true, json: async () => { throw new SyntaxError('x') } })]) {
    s.env.respond = b; await assert.doesNotReject(s.dr.check()); assert.equal(s.status.get().data.state, 'error'); assert.equal(s.applied.length, 0)
  }
  s.env.respond = () => jsonRes(oceanAt('2026-09-20T21:00'))
  s.env.applyData = () => { throw new Error('store broke') }
  await assert.doesNotReject(s.dr.check()); assert.equal(s.status.get().data.state, 'error')
  s.env.applyData = (d) => s.applied.push(d)
  await s.dr.check(); await flush(); assert.equal(s.applied.length, 1)
  s.dr.stop()
})

test('資料更新：一般模式頁面不可見時不抓（延後），可見時補抓一次；展場不受可見性限制；重疊的檢查只跑一次', async () => {
  const s = dataSetup('')
  s.env.respond = () => jsonRes(oceanAt('2026-09-20T21:00'))
  s.env.doc.visibilityState = 'hidden'
  s.env.advance(3 * 3600000 + 1000); await flush()
  assert.equal(s.env.fetches.length, 0, '背景不抓')
  s.env.doc.visibilityState = 'visible'; s.env.doc.emit('visibilitychange'); await flush()
  assert.equal(s.env.fetches.length, 1, '回到可見 → 補抓')
  s.env.doc.emit('visibilitychange'); await flush(); assert.equal(s.env.fetches.length, 1, '沒有欠的就不重抓')
  s.dr.stop()
  const k = dataSetup('?kiosk=1'); k.env.respond = () => jsonRes(oceanAt('2026-09-20T21:00'))
  k.env.doc.visibilityState = 'hidden'; k.env.advance(30 * 60000 + 1000); await flush()
  assert.equal(k.env.fetches.length, 1, '展場：不限可見'); k.dr.stop()
  const o = dataSetup(''); let release; o.env.respond = () => new Promise((r) => { release = () => r(jsonRes(oceanAt('2026-09-20T21:00'))) })
  const p1 = o.dr.check(); const p2 = o.dr.check(); await flush()
  assert.equal(o.env.fetches.length, 1, '進行中再要求檢查 → 合併'); release(); await p1; await p2; o.dr.stop()
})

// ───────────────────────────── ?reload=HH ─────────────────────────────
test('每日重載：到點且閒置才重載一次；忙碌就等；新載入的頁面排到明天', () => {
  const env = makeEnv({ start: new Date(2026, 8, 20, 2, 58, 0).getTime() })
  const s = setup('?reload=3', { env })
  const d = R.createDailyReload({ env, status: s.status, hour: 3, reloader: s.reloader, getIdle: s.getIdle })
  assert.equal(s.status.get().daily.hour, 3); assert.equal(s.status.get().daily.at, new Date(2026, 8, 20, 3, 0, 0).getTime())
  env.idle.idleMs = 5000
  env.advance(5 * 60000); assert.equal(env.reloads.length, 0, '到點但有人在操作 → 等')
  env.idle.idleMs = 500000
  env.advance(30000); assert.equal(env.reloads.length, 1, '一閒置就重載')
  assert.equal(s.log.list().at(-1).msg, 'daily')
  env.advance(10 * 60000); assert.equal(env.reloads.length, 1, '只重載一次')
  d.stop()
  // 重載後的新頁面：現在是 03:05 → 目標是明天
  const env2 = makeEnv({ start: new Date(2026, 8, 20, 3, 5, 0).getTime() }); const s2 = setup('?reload=3', { env: env2 })
  const d2 = R.createDailyReload({ env: env2, status: s2.status, hour: 3, reloader: s2.reloader, getIdle: s2.getIdle })
  env2.idle.idleMs = 1e9; env2.advance(60 * 60000); assert.equal(env2.reloads.length, 0, '不會連環重載')
  assert.equal(s2.status.get().daily.at, new Date(2026, 8, 21, 3, 0, 0).getTime())
  d2.stop()
})

// ───────────────────────────── 全域錯誤只記錄 ─────────────────────────────
function makeWin() {
  const L = new Map()
  return {
    addEventListener(t, f) { if (!L.has(t)) L.set(t, new Set()); L.get(t).add(f) },
    removeEventListener(t, f) { if (L.has(t)) L.get(t).delete(f) },
    emit(t, ev) { for (const f of [...(L.get(t) || [])]) f(ev) },
    count: () => [...L.values()].reduce((n, s) => n + s.size, 0),
  }
}
test('installErrorCapture：error / unhandledrejection 只記錄（不重載）；ResizeObserver 良性錯誤略過；重複的合併；解除後不再收', () => {
  const env = makeEnv(); const win = makeWin(); const status = R.createStatusStore(R.initialStatus()); const log = R.createCrashLog({ storage: memStorage(), now: env.now, boot: 'B' })
  const off = R.installErrorCapture({ win, crashLog: log, status, cfg: { buildId: 'b9', flags: 'kiosk=1' } })
  assert.equal(win.count(), 3)
  win.emit('error', { message: 'x is not a function', error: new TypeError('x is not a function') })
  win.emit('error', { message: 'ResizeObserver loop completed with undelivered notifications.' })
  win.emit('error', { message: 'Script error.', filename: 'https://cdn.example/a.js', lineno: 7 })
  win.emit('unhandledrejection', { reason: new Error('nope') })
  win.emit('unhandledrejection', { reason: 'plain string' })
  win.emit('unhandledrejection', {})
  const l = log.list()
  assert.deepEqual(l.map((e) => e.kind), ['error', 'error', 'rejection', 'rejection', 'rejection'])
  assert.ok(l.every((e) => e.fatal === false && e.build === 'b9' && e.flags === 'kiosk=1'))
  assert.match(l[1].msg, /Script error\. @https:\/\/cdn\.example\/a\.js:7/)
  assert.equal(env.reloads.length, 0)
  assert.equal(R.planAutoReload(l, env.now()).count10, 0, '只記錄的事件不計入熔斷')
  assert.equal(status.get().crashRev, 5)
  for (let i = 0; i < 300; i++) win.emit('error', { message: 'again', error: new Error('again') })
  assert.equal(log.list().length, 6, '重複的錯誤合併，不洗掉環狀紀錄')
  win.emit('pagehide', {})   // flush 不丟例外
  off(); assert.equal(win.count(), 0)
  win.emit('error', { message: 'late' }); assert.equal(log.list().length, 6)
  assert.equal(R.installErrorCapture({ win: null, crashLog: log })(), undefined, '沒有 window → 空操作')
  assert.doesNotThrow(() => { const w = makeWin(); R.installErrorCapture({ win: w, crashLog: { add() { throw new Error('storage dead') }, flush() { throw new Error('x') } } }); w.emit('error', { message: 'm' }); w.emit('pagehide', {}) })
})

// ───────────────────────────── 組裝 ─────────────────────────────
function startWith(search, { hash = '', buildId = 'b1', withData = true, env = makeEnv() } = {}) {
  env.search = search; env.hash = hash
  const fetched = []
  env.respond = (url) => { fetched.push(url); return url.endsWith('version.json') ? jsonRes({ id: buildId }) : jsonRes(oceanAt('2026-09-20T20:00')) }
  const status = R.createStatusStore(R.initialStatus(env.now()))
  const crashLog = R.createCrashLog({ storage: memStorage(), now: env.now, boot: 'B' })
  const over = { ...env }
  if (withData) Object.assign(over, { getLocalFetchedAt: () => '2026-09-20T20:00', applyData() {} })
  const h = R.startGuards({ env: over, status, crashLog, buildId })
  return { env, h, status, crashLog, fetched }
}
test('startGuards：一般模式 → WebGL 復原 + 版本檢查 + 資料更新；沒有看門狗（不掛 rAF）', () => {
  const { env, h, status } = startWith('')
  assert.equal(env.counts().rafs, 0)
  assert.equal(env.counts().timers, 3, 'gl 掃描 + 版本輪詢 + 資料輪詢')
  assert.deepEqual(status.get().watchdog, { on: false, supported: true, reason: 'default', stalled: false })
  assert.equal(status.get().config.mode, 'main'); assert.equal(R.guardControls.current, h)
  h.stop(); assert.deepEqual(env.counts(), { timers: 0, rafs: 0, doc: 0, canvas: 0 }); assert.equal(R.guardControls.current, null)
})

test('startGuards：?kiosk → 看門狗啟用；?watchdog=1 一般模式也啟用；?watchdog=0 關閉（即使展場）', () => {
  const a = startWith('?kiosk=1'); assert.equal(a.env.counts().rafs, 1); assert.equal(a.status.get().watchdog.on, true); assert.equal(a.status.get().watchdog.reason, 'kiosk'); a.h.stop()
  const b = startWith('?watchdog=1'); assert.equal(b.env.counts().rafs, 1); assert.equal(b.status.get().watchdog.reason, 'flag'); b.h.stop()
  const c = startWith('?kiosk=1&watchdog=0'); assert.equal(c.env.counts().rafs, 0); assert.equal(c.status.get().watchdog.on, false); c.h.stop()
  for (const x of [a, b, c]) assert.deepEqual(x.env.counts(), { timers: 0, rafs: 0, doc: 0, canvas: 0 })
})

test('startGuards：展場模式看門狗真的會在 rAF 停止後重載；一般模式同樣情況不會', () => {
  const k = startWith('?kiosk=1'); k.env.advance(2000); k.env.rafOn = false; k.env.advance(20000)
  assert.equal(k.env.reloads.length, 1); assert.equal(k.crashLog.list().at(-1).kind, 'watchdog'); assert.equal(k.status.get().reloading.reason, 'watchdog'); k.h.stop()
  const n = startWith(''); n.env.advance(2000); n.env.rafOn = false; n.env.advance(600000)
  assert.equal(n.env.reloads.length, 0); n.h.stop()
})

test('startGuards：WebGL 遺失 4 秒沒恢復 → 重載並記錄；有恢復 → 不重載', () => {
  const a = startWith(''); const c = makeCanvas(); a.env.canvases.push(c); a.env.advance(2000)
  c.emit('webglcontextlost'); a.env.advance(4100)
  assert.equal(a.env.reloads.length, 1); assert.equal(a.crashLog.list()[0].kind, 'webgl'); a.h.stop()
  const b = startWith(''); const c2 = makeCanvas(); b.env.canvases.push(c2); b.env.advance(2000)
  c2.emit('webglcontextlost'); b.env.advance(1000); c2.emit('webglcontextrestored'); b.env.advance(20000)
  assert.equal(b.env.reloads.length, 0); b.h.stop()
})

test('startGuards：觀眾視窗 → 沒有資料更新（它跟著主視窗），永遠閒置所以有新版就重載；遙控頁 / 診斷頁什麼都不做', async () => {
  const a = startWith('?audience=1')
  assert.equal(a.env.counts().timers, 3, 'gl 掃描 + 版本輪詢 + 看門狗檢查（投影機整天開著）；沒有資料輪詢'); assert.equal(a.status.get().data.state, 'off'); assert.equal(a.status.get().watchdog.on, true); a.h.stop()
  const env = makeEnv(); env.search = '?audience=1'
  env.idleState = () => R.DEFAULT_IDLE_STATE   // 觀眾視窗沒有人為輸入：預設環境的閒置狀態永遠是閒置
  env.respond = (u) => jsonRes(u.endsWith('version.json') ? { id: 'NEW' } : {})
  const s = R.createStatusStore(R.initialStatus())
  const h = R.startGuards({ env: { ...env }, status: s, crashLog: R.createCrashLog({ storage: memStorage(), now: env.now, boot: 'B' }), buildId: 'b1' })
  await h.checkNow(); await flush(); assert.equal(env.reloads.length, 1); h.stop()
  for (const [search, hash] of [['', '#remote=abc'], ['?diagnostics=1', '']]) {
    const x = startWith(search, { hash }); assert.deepEqual(x.env.counts(), { timers: 0, rafs: 0, doc: 0, canvas: 0 }, search + hash); x.h.stop()
  }
})

test('startGuards：dev 建置不做版本檢查；?reload=HH 才有每日重載；沒有 fetch 的環境功能偵測後略過', () => {
  const d = startWith('', { buildId: 'dev' }); assert.equal(d.status.get().version.state, 'off'); assert.equal(d.env.counts().timers, 2); d.h.stop()
  const r = startWith('?reload=4'); assert.equal(r.env.counts().timers, 4); assert.equal(r.status.get().daily.hour, 4); r.h.stop()
  const env = makeEnv(); env.fetch = null
  const h = R.startGuards({ env: { ...env }, status: R.createStatusStore(R.initialStatus()), crashLog: R.createCrashLog({ storage: memStorage(), now: env.now }), buildId: 'b1' })
  assert.equal(env.counts().timers, 1, '只剩 gl 掃描'); h.stop()
})

test('startGuards：可重複啟動 / 停止（StrictMode 雙掛載），不殘留計時器 / 監聽 / rAF / 排定的重載；stop 可重複呼叫', () => {
  const env = makeEnv()
  for (let i = 0; i < 3; i++) {
    const x = startWith('?kiosk=1&reload=3', { env })
    const c = makeCanvas(); env.canvases.push(c); env.advance(2000)
    c.emit('webglcontextlost')            // 停止時已經排了「4 秒後重載」
    x.h.stop(); x.h.stop()
    env.canvases.length = 0
    assert.deepEqual(env.counts(), { timers: 0, rafs: 0, doc: 0, canvas: 0 }, `第 ${i + 1} 輪`)
  }
  env.advance(60000); assert.equal(env.reloads.length, 0, '停止後不會再重載')
})

test('startGuards：checkNow 立即跑版本與資料檢查（維運面板的「立即檢查更新」）', async () => {
  const x = startWith('?kiosk=1')
  await x.h.checkNow(); await flush()
  assert.deepEqual(x.fetched.sort(), ['/data/ocean.json', '/version.json'])
  assert.equal(x.status.get().version.state, 'same'); assert.equal(x.status.get().data.state, 'same')
  x.h.stop()
})

// ───────────────────────────── 回歸：瀏覽器的原生函式不能脫離原物件呼叫 ─────────────────────────────
// 瀏覽器的 setTimeout / setInterval / fetch / requestAnimationFrame / location.reload / addEventListener 要求 this 是原物件（或 window / undefined）；
// 存成 { setInterval: globalThis.setInterval } 再以 env.setInterval() 呼叫會丟 TypeError: Illegal invocation（Node 不檢查 this）。
// 這裡把全域換成「會檢查 this」的版本、再載入一份新的模組實例，跑預設路徑（不注入任何環境）。
function installStrictGlobals() {
  const saved = {}
  const names = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame', 'document', 'window', 'location']
  for (const n of names) saved[n] = Object.getOwnPropertyDescriptor(globalThis, n)
  const orig = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }
  const strict = (n, impl) => { globalThis[n] = function strictThis(...a) { if (this !== undefined && this !== globalThis) throw new TypeError(`Illegal invocation: ${n}`); return impl(...a) } }
  for (const n of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']) strict(n, (...a) => orig[n](...a))
  const fetched = []
  strict('fetch', async (url, init) => { fetched.push([url, init]); return jsonRes(String(url).endsWith('version.json') ? { id: 'b-old' } : { fetchedAt: '2026-09-21T00:00', options: [{ id: 'a' }] }) })
  strict('requestAnimationFrame', (cb) => orig.setTimeout(() => cb(performance.now()), 5))
  strict('cancelAnimationFrame', (id) => orig.clearTimeout(id))
  const guard = (obj, name) => (obj[name] = function (...a) { if (this !== obj) throw new TypeError(`Illegal invocation: ${name}`); return obj[`_${name}`](...a) })
  const mkTarget = () => { const L = new Map(); const o = { L, _addEventListener(t, f) { if (!L.has(t)) L.set(t, new Set()); L.get(t).add(f) }, _removeEventListener(t, f) { L.has(t) && L.get(t).delete(f) } }; guard(o, 'addEventListener'); guard(o, 'removeEventListener'); return o }
  const doc = Object.assign(mkTarget(), { visibilityState: 'visible', _querySelectorAll() { return [] } }); guard(doc, 'querySelectorAll')
  const win = mkTarget()
  const loc = { search: '?kiosk=1&reload=3', hash: '', reloads: 0, _reload() { loc.reloads++ } }; guard(loc, 'reload')
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'location', { value: loc, configurable: true, writable: true })
  return {
    doc, win, loc, fetched, orig,
    restore() { for (const n of names) { if (saved[n]) Object.defineProperty(globalThis, n, saved[n]); else delete globalThis[n] } },
  }
}

test('預設環境路徑在瀏覽器的 this 規則下可用（回歸：Illegal invocation）', async () => {
  const g = installStrictGlobals()
  let h, off
  try {
    const fresh = await import('./resilience.js?strict=' + Math.random().toString(36).slice(2))   // 換掉全域之後才載入新的模組實例
    const status = fresh.createStatusStore(fresh.initialStatus())
    const crashLog = fresh.createCrashLog({ storage: memStorage() })
    off = fresh.installErrorCapture({ win: globalThis.window, crashLog, status })
    let applied = 0
    h = fresh.startGuards({ buildId: 'b-1', status, crashLog, env: { getLocalFetchedAt: () => '2026-09-20T00:00', applyData: () => { applied++ } } })
    assert.equal(h.config.kiosk, true)
    assert.equal(h.config.watchdog.on, true, '?kiosk=1 → 看門狗啟用（走預設的 rAF）')
    await new Promise((r) => g.orig.setTimeout(r, 30))                       // 讓預設的 rAF 迴圈跑幾幀
    await h.checkNow()                                                        // 預設的 fetch
    assert.deepEqual(g.fetched.map((x) => x[0]).sort(), ['/data/ocean.json', '/version.json'])
    assert.deepEqual(g.fetched[0][1], { cache: 'no-store' })
    assert.equal(applied, 1, '預設閒置狀態 → 立刻套用資料')
    assert.equal(status.get().version.state, 'new')
    assert.equal(g.loc.reloads, 1, '新版 + 閒置 → 走預設的 location.reload')
    h.stop(); h = null
    off(); off = null
    // 異常重載路徑（預設的 setTimeout / reload）
    const h2 = fresh.startGuards({ buildId: 'b-1', status: fresh.createStatusStore(fresh.initialStatus()), crashLog, env: {} })
    h2.reloader.crash('watchdog', new Error('stall'))
    assert.equal(g.loc.reloads, 2)
    h2.stop()
  } finally {
    if (h) h.stop()
    if (off) off()
    g.restore()
  }
})

// ───────────────────────────── .jsx：esbuild 打包後載入 ─────────────────────────────
const CACHE_DIR = resolve(SRC, '..', 'node_modules', '.cache', 'midisea-resilience-test')
async function bundleJsx(entry, stubs = {}, { fresh = '' } = {}) {   // fresh：讓被測元件載入「另一份」resilience.js 實例（?query），測試自己 import 同一個 URL 就能操作它的狀態
  const shared = /[\\/](i18n[\\/]index\.js|lib[\\/]resilience\.js)$/
  const result = await build({
    entryPoints: [resolve(SRC, entry)], bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', packages: 'external',
    loader: { '.css': 'empty' },
    plugins: [{
      name: 'test-shims',
      setup(b) {
        b.onResolve({ filter: /.*/ }, (a) => {
          if (!a.path.startsWith('.')) return undefined
          const abs = resolve(a.resolveDir, a.path)
          for (const k of Object.keys(stubs)) if (abs.endsWith(k)) return { path: k, namespace: 'stub' }
          if (shared.test(abs)) return { path: pathToFileURL(abs).href + (fresh && /resilience\.js$/.test(abs) ? '?' + fresh : ''), external: true }
          return undefined
        })
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubs[a.path], loader: 'js' }))
      },
    }],
  })
  mkdirSync(CACHE_DIR, { recursive: true })
  const file = join(CACHE_DIR, `${entry.replace(/[^\w]/g, '_')}.${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(file, result.outputFiles[0].text)
  return import(pathToFileURL(file).href)
}

const React = (await import('react')).default
const { renderToStaticMarkup } = await import('react-dom/server')

function fakeTimers() {
  const m = new Map(); let seq = 0
  return { m, setInterval: (fn, ms) => { m.set(++seq, { fn, ms }); return seq }, clearInterval: (id) => { m.delete(id) } }
}
function ebSetup(EB, { storage = memStorage(), now = { v: T0 } } = {}) {
  const log = R.createCrashLog({ storage, now: () => now.v, boot: 'BOOT' })
  const timers = fakeTimers(); const reloads = []; const win = makeWin()
  const deps = { log, now: () => now.v, reload: () => reloads.push(now.v), setInterval: timers.setInterval, clearInterval: timers.clearInterval, buildId: 'b-test', flags: 'kiosk=1', win, search: '?kiosk=1', hash: '' }
  const b = new EB({ children: null, deps })
  b.setState = (p) => { b.state = { ...b.state, ...(typeof p === 'function' ? p(b.state) : p) } }
  const crash = (err) => { b.state = { ...b.state, ...EB.getDerivedStateFromError(err) }; b.componentDidCatch(err, { componentStack: '' }); b.componentDidUpdate() }
  const tick = (ms) => { now.v += ms; for (const x of [...timers.m.values()]) x.fn() }
  return { b, log, timers, reloads, win, deps, now, crash, tick, storage }
}

test('ErrorBoundary：getDerivedStateFromError 進入錯誤狀態（throw null 也是，避免無限重試）', async () => {
  const EB = (await bundleJsx('ErrorBoundary.jsx')).default
  const e = new Error('boom')
  assert.deepEqual(EB.getDerivedStateFromError(e), { error: e })
  assert.ok(EB.getDerivedStateFromError(null).error instanceof Error)
  assert.ok(EB.getDerivedStateFromError(undefined).error instanceof Error)
  assert.equal(EB.getDerivedStateFromError('str').error, 'str')
})

test('ErrorBoundary：componentDidCatch 記錄（時間 / 訊息 / stack 前 300 字 / build id / 網址旗標）並排定 5 秒倒數；StrictMode 雙呼叫只記一筆', async () => {
  const EB = (await bundleJsx('ErrorBoundary.jsx')).default
  const s = ebSetup(EB)
  const err = new Error('render boom'); err.stack = 'Error: render boom\n' + 'z'.repeat(800)
  s.crash(err)
  s.b.componentDidCatch(err, { componentStack: '' })   // StrictMode 的第二次
  const l = s.log.list()
  assert.equal(l.length, 1)
  assert.equal(l[0].kind, 'render'); assert.equal(l[0].msg, 'render boom'); assert.equal(l[0].stack.length, 300)
  assert.equal(l[0].build, 'b-test'); assert.equal(l[0].flags, 'kiosk=1'); assert.equal(l[0].t, T0)
  assert.equal(s.b.state.plan.delayMs, 5000); assert.equal(s.b.state.deadline, T0 + 5000); assert.equal(s.b.state.left, 5000)
  assert.equal(s.timers.m.size, 1, '倒數計時器只有一個')
  s.b.componentDidUpdate(); assert.equal(s.timers.m.size, 1, '重複 update 不會多開計時器')
})

test('ErrorBoundary：倒數到 0 自動重新載入一次；「立即重新載入」立刻重載並停掉倒數；卸載清乾淨', async () => {
  const EB = (await bundleJsx('ErrorBoundary.jsx')).default
  const a = ebSetup(EB); a.crash(new Error('a'))
  a.tick(4000); assert.equal(a.reloads.length, 0); assert.equal(a.b.state.left, 1000)
  a.tick(1000); assert.equal(a.reloads.length, 1); assert.equal(a.timers.m.size, 0)
  a.tick(10000); assert.equal(a.reloads.length, 1, '不會重複重載')
  const b = ebSetup(EB); b.crash(new Error('b')); b.b.reloadNow()
  assert.equal(b.reloads.length, 1); assert.equal(b.timers.m.size, 0)
  const c = ebSetup(EB); c.crash(new Error('c')); c.b.componentWillUnmount()
  assert.equal(c.timers.m.size, 0); c.tick(60000); assert.equal(c.reloads.length, 0)
})

test('ErrorBoundary：退避 5 → 15 → 60 秒，10 分鐘內第 5 次停止自動重載並改請人工處理', async () => {
  const EB = (await bundleJsx('ErrorBoundary.jsx')).default
  const s = ebSetup(EB)
  const delays = []
  for (let i = 0; i < 4; i++) {
    s.crash(new Error('crash ' + i)); delays.push(s.b.state.plan.delayMs)
    s.b.componentWillUnmount()            // 模擬「重新載入」：舊頁面的計時器不再存在，新頁面沿用儲存裡的紀錄
    s.b.timer = null
    s.now.v += (i === 0 ? 6000 : i === 1 ? 16000 : 61000)
  }
  assert.deepEqual(delays, [5000, 15000, 60000, 60000])
  s.crash(new Error('crash 5'))
  assert.equal(s.b.state.plan.stop, true); assert.equal(s.timers.m.size, 0, '不再倒數'); assert.equal(s.b.state.deadline, 0)
  s.now.v += 10 * 60000; assert.equal(s.reloads.length, 0)
  // 標記：請人工處理 + 手動按鈕，沒有倒數數字
  const html = renderToStaticMarkup(s.b.render())
  assert.match(html, /發生錯誤，請人工處理/); assert.match(html, /已停止自動重新載入/); assert.match(html, /重新載入/); assert.doesNotMatch(html, /立即重新載入/); assert.doesNotMatch(html, /res-crash-count/)
})

test('ErrorBoundary：復原畫面標記——說明 + 倒數 + 立即重新載入鈕 + 可摺疊的錯誤摘要 + build id；英文語系', async () => {
  const mod = await bundleJsx('ErrorBoundary.jsx'); const EB = mod.default
  const s = ebSetup(EB)
  const err = new TypeError('Cannot read properties of undefined'); err.stack = 'TypeError: x\n    at Foo (foo.js:1:1)'
  s.crash(err); s.tick(1500)
  let html = renderToStaticMarkup(s.b.render())
  assert.match(html, /role="alert"/); assert.match(html, /發生錯誤，4 秒後自動重新載入/); assert.match(html, /res-crash-count[^>]*>4</)
  assert.match(html, /立即重新載入/); assert.match(html, /<details[^>]*>\s*<summary>錯誤摘要<\/summary>/); assert.match(html, /TypeError: Cannot read properties of undefined/); assert.match(html, /at Foo/); assert.match(html, /build b-test/)
  setLocale('en')
  try {
    html = renderToStaticMarkup(s.b.render())
    assert.match(html, /Something went wrong\. Reloading in 4 s/); assert.match(html, /Reload now/); assert.match(html, /Error details/); assert.doesNotMatch(html, /[㐀-鿿]/)
  } finally { setLocale('zh') }
  // 正常狀態：渲染 children（外加提示元件，沒有事件時什麼都不顯示）
  const ok = new EB({ children: React.createElement('main', null, 'hello') })
  assert.equal(renderToStaticMarkup(ok.render()), '<main>hello</main>')
})

test('ErrorBoundary：掛載時掛 window error / unhandledrejection 只記錄（不重載）；卸載解除；StrictMode 重複掛載不重複記', async () => {
  const EB = (await bundleJsx('ErrorBoundary.jsx')).default
  const s = ebSetup(EB)
  s.b.componentDidMount(); s.b.componentWillUnmount(); s.b.componentDidMount()     // StrictMode：mount → unmount → mount
  assert.equal(s.win.count(), 3)
  s.win.emit('error', { message: 'late error', error: new Error('late error') })
  s.win.emit('unhandledrejection', { reason: new Error('rejected') })
  assert.deepEqual(s.log.list().map((e) => e.kind), ['error', 'rejection'])
  assert.equal(s.reloads.length, 0); assert.equal(s.timers.m.size, 0)
  s.b.componentWillUnmount(); assert.equal(s.win.count(), 0)
})

test('ErrorBoundary：儲存壞掉（隱私模式）時仍然進入復原畫面並用第 1 次退避倒數', async () => {
  const EB = (await bundleJsx('ErrorBoundary.jsx')).default
  const boom = { load() { throw new Error('denied') }, save() { throw new Error('denied') }, clear() {} }
  const s = ebSetup(EB, { storage: boom })
  s.crash(new Error('x'))
  assert.equal(s.b.state.plan.delayMs, 5000); assert.equal(s.timers.m.size, 1)
  s.tick(5000); assert.equal(s.reloads.length, 1)
})

test('GuardNotice：WebGL 遺失 / 已恢復、即將重新載入、熔斷（含手動按鈕）；沒事時什麼都不顯示', async () => {
  const { GuardNotice } = await bundleJsx('ErrorBoundary.jsx')
  const html = () => renderToStaticMarkup(React.createElement(GuardNotice))
  const base = R.initialStatus()
  R.opsStatus.set({ ...base })
  assert.equal(html(), '')
  R.opsStatus.set({ gl: { state: 'lost', at: 1 } }); assert.match(html(), /顯示引擎暫時中斷，嘗試恢復中/); assert.match(html(), /res-notice warn/)
  R.opsStatus.set({ gl: { state: 'restored', at: 2 } }); assert.match(html(), /顯示引擎已恢復/); assert.doesNotMatch(html(), /res-notice warn/)
  R.opsStatus.set({ gl: { state: 'reloading', at: 3 }, reloading: { reason: 'webgl', at: 3 } }); assert.match(html(), /偵測到異常（顯示引擎中斷），即將重新載入/)
  R.opsStatus.set({ reloading: { reason: 'watchdog', at: 3 } }); assert.match(html(), /偵測到異常（畫面停止更新）/)
  R.opsStatus.set({ reloading: { reason: 'version', at: 3 }, gl: { state: 'idle', at: 0 } }); assert.equal(html(), '', '一般重載（新版 / 每日）不顯示提示')
  R.opsStatus.set({ halted: true }); assert.match(html(), /已停止自動重新載入/); assert.match(html(), /<button[^>]*>重新載入<\/button>/)
  // 英文：SSR 時 zustand 用初始語系（zh），所以這裡直接驗證字典（i18n 測試也保證每個 key 都有英文）
  assert.equal(translate('en', '偵測到異常（{why}），即將重新載入…', { why: translate('en', '顯示引擎中斷') }), 'Problem detected (graphics engine interrupted), reloading soon…')
  assert.equal(translate('en', '顯示引擎已恢復'), 'Graphics engine recovered')
  R.opsStatus.set({ ...base })
})

test('ErrorBoundary：預設環境（不注入計時器 / reload）在瀏覽器的 this 規則下可用（回歸：Illegal invocation）', async () => {
  const g = installStrictGlobals()
  try {
    const EB = (await bundleJsx('ErrorBoundary.jsx')).default          // 換掉全域之後才載入
    const log = R.createCrashLog({ storage: memStorage(), boot: 'S' })
    const b = new EB({ children: null, deps: { log } })                // 只注入儲存：計時器 / reload / now 走預設
    b.setState = (p) => { b.state = { ...b.state, ...p } }
    b.state = { ...b.state, ...EB.getDerivedStateFromError(new Error('strict')) }
    b.componentDidCatch(new Error('strict'), {}); b.componentDidUpdate()
    assert.ok(b.timer !== null, '預設的 setInterval 建立成功')
    b.componentWillUnmount(); assert.equal(b.timer, null)
    b.state.plan = { stop: false, delayMs: 0 }
    b.reloadNow(); assert.equal(g.loc.reloads, 1, '預設的 location.reload')
  } finally { g.restore() }
})

test('ResilienceService：閒置狀態讀 activity / store.rec / 導覽 / 彈窗；資料更新只換 gov、保留海況選項、不碰參數', async () => {
  const STUBS = {
    'store/useStore.js': `const s = globalThis.__fake; export const useStore = { getState: () => s.store, setState: (p) => { s.sets.push(p); Object.assign(s.store, p) } }`,
    'store/activity.js': `export const activity = globalThis.__fake.activity`,
    'lib/tour.js': `export const useTourStore = { getState: () => globalThis.__fake.tour }`,
    'services/tourCore.js': `export const tourRunner = { current: () => globalThis.__fake.runnerCur() }`,
    'tourCore.js': `export const tourRunner = { current: () => globalThis.__fake.runnerCur() }`,
  }
  const calls = []
  globalThis.__fake = {   // stub 模組在載入時就會讀它：要先於 bundleJsx 的 import
    sets: [], store: { rec: { mode: 'idle' }, govOptionId: 'zengwen', params: { seaLevel: 0.3 }, gov: { fetchedAt: '2026-09-20T20:00' }, applyGov() { calls.push('applyGov') }, applyParams() { calls.push('applyParams') }, setGov() { calls.push('setGov') } },
    activity: { last: 0 }, tour: { running: false }, runnerCur: () => null,
  }
  const mod = await bundleJsx('services/ResilienceService.jsx', STUBS)
  const g = globalThis
  const hadDoc = Object.getOwnPropertyDescriptor(g, 'document')
  try {
    Object.defineProperty(g, 'document', { value: { querySelector: (q) => (q === '.modal-backdrop' && g.__fake.modal ? {} : null) }, configurable: true, writable: true })
    const now = performance.now()
    g.__fake.activity.last = now - 90000
    let st = mod.readIdleState()
    assert.ok(st.idleMs >= 90000 && st.idleMs < 95000, String(st.idleMs))
    assert.deepEqual({ ...st, idleMs: 0 }, { idleMs: 0, recMode: 'idle', tourRunning: false, tourAuto: false, modalOpen: false })
    g.__fake.store.rec.mode = 'playing'; g.__fake.tour.running = true; g.__fake.runnerCur = () => ({ auto: true }); g.__fake.modal = true
    st = mod.readIdleState()
    assert.equal(st.recMode, 'playing'); assert.equal(st.tourRunning, true); assert.equal(st.tourAuto, true); assert.equal(st.modalOpen, true)
    g.__fake.runnerCur = () => { throw new Error('tour api changed') }
    assert.equal(mod.readIdleState().tourAuto, false, '導覽執行器介面改了 → 退回保守判斷，不丟例外')
    // 只換資料
    const next = { fetchedAt: '2026-09-21T00:00', defaultOption: 'feitsui', options: [{ id: 'feitsui' }, { id: 'zengwen' }] }
    mod.applyGovData(next)
    assert.deepEqual(g.__fake.sets, [{ gov: next, govOptionId: 'zengwen' }], '保留使用者選的海況選項')
    assert.deepEqual(calls, [], '不呼叫 applyGov / applyParams / setGov（不動海況與參數）')
    assert.equal(g.__fake.store.params.seaLevel, 0.3)
    mod.applyGovData({ fetchedAt: 'x', defaultOption: 'feitsui', options: [{ id: 'feitsui' }] })
    assert.equal(g.__fake.sets.at(-1).govOptionId, 'feitsui', '選的海況在新資料裡不見了 → 用預設')
  } finally {
    if (hadDoc) Object.defineProperty(g, 'document', hadDoc); else delete g.document
    delete g.__fake
  }
})

test('OpsSection：顯示 build id / 載入時間 / 資料時間 / 檢查結果 / 崩潰紀錄 / 啟用的防呆（正式建置的 build id）', async () => {
  const g = globalThis
  g.__BUILD_ID__ = 'b-ops-test'   // vite define 的替身：新載入的 resilience.js 實例會讀到它（正式建置）
  const FRESH = 'ops=' + Math.random().toString(36).slice(2)
  const STUBS = { 'store/useStore.js': `export const useStore = (sel) => sel(globalThis.__fakeStore)` }
  const RF = await import('./resilience.js?' + FRESH)
  const OpsSection = (await bundleJsx('ui/devices/OpsSection.jsx', STUBS, { fresh: FRESH })).default
  g.__fakeStore = { gov: { fetchedAt: '2026-09-20T20:00' } }
  const lsMap = new Map()   // 預設崩潰紀錄儲存走 localStorage（Node 沒有 / 有但要旗標）：用假的
  const hadLS = Object.getOwnPropertyDescriptor(g, 'localStorage')
  Object.defineProperty(g, 'localStorage', { value: { getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null), setItem: (k, v) => lsMap.set(k, String(v)), removeItem: (k) => lsMap.delete(k) }, configurable: true, writable: true })
  const hadLoc = Object.getOwnPropertyDescriptor(g, 'location')
  const setLoc = (search) => Object.defineProperty(g, 'location', { value: { search, hash: '', reload() {} }, configurable: true, writable: true })
  const html = () => renderToStaticMarkup(React.createElement(OpsSection))
  try {
    assert.equal(RF.BUILD_ID, 'b-ops-test')
    setLoc('')
    RF.opsStatus.set({ ...RF.initialStatus(), bootAt: T0 })
    let h = html()
    assert.match(h, /維運/); assert.match(h, /b-ops-test/); assert.match(h, /2026-09-20T20:00/); assert.match(h, /尚未檢查/); assert.match(h, /沒有崩潰紀錄/)
    assert.match(h, /未啟用（一般模式；加上 \?watchdog=1 開啟）/); assert.match(h, /未設定（網址加 \?reload=0–23）/); assert.match(h, /每 3 小時（頁面可見時）/); assert.match(h, /生效（閒置 60 秒/)
    assert.match(h, /立即重新載入/); assert.match(h, /立即檢查更新/); assert.match(h, /清除崩潰紀錄/)
    setLoc('?kiosk=1&reload=3')
    RF.opsStatus.set({ version: { state: 'new', checkedAt: T0, remoteId: 'NEW-ID', deferred: 'active' }, data: { state: 'pending', checkedAt: T0, remoteFetchedAt: '2026-09-21T00:00', appliedAt: 0, deferred: 'tour' }, halted: true })
    h = html()
    assert.match(h, /啟用（展場模式 \?kiosk）/); assert.match(h, /有新版（NEW-ID）/); assert.match(h, /等閒置再重新載入（有人操作中）/); assert.match(h, /有新資料（2026-09-21T00:00）/); assert.match(h, /等閒置再套用（導覽中）/)
    assert.match(h, /每天 03:00（閒置時）/); assert.match(h, /已停止自動重新載入/); assert.match(h, /無人操作 60 秒後套用/); assert.match(h, /每 30 分鐘/)
    RF.opsStatus.set({ version: { state: 'same', checkedAt: T0, remoteId: 'b-ops-test', deferred: '' }, data: { state: 'applied', checkedAt: T0, remoteFetchedAt: '2026-09-21T00:00', appliedAt: T0, deferred: '' } })
    h = html(); assert.match(h, /已是最新/); assert.match(h, /已更新到 2026-09-21T00:00/)
    RF.opsStatus.set({ version: { state: 'error', checkedAt: T0, remoteId: '', deferred: '' } })
    assert.match(html(), /檢查失敗（離線？之後會再試）/)
    setLoc('?watchdog=0&autoupdate=0')
    h = html(); assert.match(h, /已用 \?watchdog=0 關閉/); assert.match(h, /已關閉（\?autoupdate=0）/)
    // 崩潰紀錄：最近 5 筆、可展開；次數
    const l2 = RF.createCrashLog({ boot: 'X' })
    for (let i = 0; i < 7; i++) l2.add({ kind: i === 6 ? 'webgl' : 'error', message: 'msg ' + i, stack: 'at f' + i, build: 'b1', flags: 'kiosk=1' })
    l2.add({ kind: 'reload', message: 'daily' })
    RF.opsStatus.set({ crashRev: RF.opsStatus.get().crashRev + 1 })
    setLoc('')
    h = html()
    assert.match(h, /共 7 筆 · 近 10 分鐘重新載入 1 次/); assert.match(h, /最近 5 筆紀錄/); assert.match(h, /顯示引擎失效/); assert.match(h, /自動重新載入 · 每日重載/); assert.match(h, /msg 6/); assert.match(h, /at f6/); assert.match(h, /build b1 · kiosk=1/); assert.doesNotMatch(h, /msg 1[^0-9]/)
  } finally {
    if (hadLoc) Object.defineProperty(g, 'location', hadLoc); else delete g.location
    if (hadLS) Object.defineProperty(g, 'localStorage', hadLS); else delete g.localStorage
    delete g.__fakeStore; delete g.__BUILD_ID__
  }
})

test.after(() => { try { rmSync(CACHE_DIR, { recursive: true, force: true }) } catch (e) { /* ignore */ } })
