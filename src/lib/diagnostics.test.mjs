// 裝置診斷（lib/diagnostics.js + lib/diagnosticsSummary.js）單元測試。執行：node --test src/lib/diagnostics.test.mjs
// 環境全部以「會檢查 this 的假物件」注入：瀏覽器對「脫離物件的原生函式」會丟 TypeError: Illegal invocation，Node 不會，
// 所以每個假物件的方法在 this 不對時一律丟例外——若實作把原生函式存成變數再呼叫，這裡會立刻失敗。
// 時間用假時鐘（makeClock）推進；非同步流程用 adv() 一邊推進時間一邊讓 microtask 跑完。
import test from 'node:test'
import assert from 'node:assert/strict'
import * as D from './diagnostics.js'
import { readFileSync } from 'node:fs'
import { DIAG_LS_KEY, loadSummary, saveSummary, sanitizeSummary, formatWhen, formatSummaryLine, diagnosticsHref } from './diagnosticsSummary.js'
import { registerEn, setLocale, t } from '../i18n/index.js'
import en from '../i18n/en/diagnostics.js'
import en2 from '../i18n/en/diagnostics2.js'

// ───────────────────────────── 測試工具 ─────────────────────────────
// 把物件裡的函式包成「this 必須是這個物件」；巢狀的一般物件遞迴處理。大寫開頭的屬性（PointerEvent、SpeechRecognition…）是建構子，不包。
function strict(obj, label = 'obj') {
  for (const k of Object.keys(obj)) {
    const v = obj[k]
    if (typeof v === 'function') {
      if (v.__strict || /^[A-Z]/.test(k)) continue
      const w = function (...a) { if (this !== obj) throw new TypeError(`Illegal invocation: ${label}.${k}`); return v.apply(obj, a) }
      w.__strict = true
      obj[k] = w
    } else if (v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype) strict(v, `${label}.${k}`)
  }
  return obj
}
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)) }

function makeClock() {
  let t = 1000, seq = 0
  const timers = new Map()
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + Math.max(0, ms), fn }); return id },
    clearTimeout: (id) => { timers.delete(id) },
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
// 推進假時間並讓 promise 鏈跑完（每一步先 settle 再推進）
async function adv(clock, ms, step = 20) {
  await settle()
  for (let done = 0; done < ms; done += step) { clock.advance(Math.min(step, ms - done)); await settle() }
}

const makeEnv = (over = {}, clock = makeClock()) => ({
  env: { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, randomId: () => 'abc', ...over },
  clock,
})

function fakeRaf(clock, ms) {
  let seq = 0
  const live = new Map()
  return {
    raf: (cb) => { const id = ++seq; live.set(id, clock.setTimeout(() => { live.delete(id); cb(clock.now()) }, ms)); return id },
    cancelRaf: (id) => { const h = live.get(id); if (h != null) clock.clearTimeout(h); live.delete(id) },
    live,
  }
}

function fakeBC({ deliver = true, throwOnCreate = false } = {}) {
  const chans = []
  return {
    chans,
    make(name) {
      if (throwOnCreate) throw new Error('cannot create')
      const ch = {
        name, closed: false, onmessage: null,
        postMessage(data) { if (!deliver) return; for (const o of chans) if (o !== ch && o.name === name && !o.closed && typeof o.onmessage === 'function') { const f = o.onmessage; Promise.resolve().then(() => f.call(o, { data })) } },
        close() { ch.closed = true },
      }
      strict(ch, 'BroadcastChannel'); chans.push(ch); return ch
    },
  }
}

function fakeGl(o = {}) {
  const { renderer = 'ANGLE (Apple, Apple M1, OpenGL 4.1)', vendor = 'Google Inc. (Apple)', maxTex = 16384, aa = true } = o
  const gl = {
    lost: 0, RENDERER: 1, VENDOR: 2, MAX_TEXTURE_SIZE: 3,
    getExtension(n) {
      if (n === 'WEBGL_debug_renderer_info') return { UNMASKED_RENDERER_WEBGL: 11, UNMASKED_VENDOR_WEBGL: 12 }
      if (n === 'WEBGL_lose_context') return { loseContext() { gl.lost++ } }
      return null
    },
    getParameter(p) { return { 11: renderer, 12: vendor, 3: maxTex, 1: 'WebKit WebGL', 2: 'WebKit' }[p] },
    getContextAttributes() { return { antialias: aa } },
  }
  return strict(gl, 'gl')
}
const fakeDocGl = (ctxs) => strict({
  hidden: false, visibilityState: 'visible',
  createElement(tag) {
    if (tag !== 'canvas') return {}
    return strict({ getContext(type) { const c = ctxs[type]; if (c instanceof Error) throw c; return c || null } }, 'canvas')
  },
}, 'document')

function fakeStorage() {
  const data = {}
  return strict({
    data,
    setItem(k, v) { data[k] = String(v) },
    getItem(k) { return k in data ? data[k] : null },
    removeItem(k) { delete data[k] },
  }, 'localStorage')
}

function fakeTrack(kind, o = {}) {
  const tr = {
    kind, label: o.label ?? "Alice's iPhone Camera", readyState: 'live', stopped: 0, muted: false, onended: null,
    stop() { tr.stopped++; tr.readyState = 'ended' },
    getSettings() { return o.settings ?? (kind === 'video' ? { width: 1280, height: 720, frameRate: 30, facingMode: 'user' } : { sampleRate: 48000 }) },
  }
  return strict(tr, 'track')
}
function fakeStream(kinds = ['video'], o = {}) {
  const tracks = kinds.map((k) => fakeTrack(k, o))
  return strict({
    tracks,
    getTracks() { return tracks },
    getVideoTracks() { return tracks.filter((t) => t.kind === 'video') },
    getAudioTracks() { return tracks.filter((t) => t.kind === 'audio') },
  }, 'stream')
}
// mode：ok | hang | late（呼叫 resolveLate() 才交出串流）| 其他 = 以該字串當 error.name reject
function fakeMedia({ mode = 'ok', kinds, log, settings } = {}) {
  const md = {
    calls: [], streams: [], resolveLate: null,
    getUserMedia(c) {
      md.calls.push(c)
      if (log) log.push('gum')
      const make = () => { const s = fakeStream(kinds || (c.video ? ['video'] : ['audio']), { settings }); md.streams.push(s); return s }
      if (mode === 'ok') return Promise.resolve(make())
      if (mode === 'hang') return new Promise(() => {})
      if (mode === 'late') return new Promise((res) => { md.resolveLate = () => res(make()) })
      const e = new Error(mode); e.name = mode; return Promise.reject(e)
    },
  }
  return strict(md, 'mediaDevices')
}
function fakeVideo(clock, ms = 33) {
  let seq = 0
  const live = new Map()
  const v = {
    srcObject: null, muted: false, played: 0, paused: 0,
    play() { v.played++; return Promise.resolve() },
    pause() { v.paused++ },
    requestVideoFrameCallback(cb) { const id = ++seq; live.set(id, clock.setTimeout(() => { live.delete(id); cb(clock.now(), {}) }, ms)); return id },
    cancelVideoFrameCallback(id) { const h = live.get(id); if (h != null) clock.clearTimeout(h); live.delete(id) },
    live,
  }
  return strict(v, 'video')
}
function fakeWin(extra = {}) {
  const ls = new Map()
  const w = {
    isSecureContext: true, added: [], removed: [],
    addEventListener(t, f) { if (!ls.has(t)) ls.set(t, new Set()); ls.get(t).add(f); w.added.push(t) },
    removeEventListener(t, f) { const s = ls.get(t); if (s) s.delete(f); w.removed.push(t) },
    dispatch(t, ev) { for (const f of [...(ls.get(t) || [])]) f(ev) },
    listenerCount() { let n = 0; for (const s of ls.values()) n += s.size; return n },
    ...extra,
  }
  return strict(w, 'window')
}
const collect = () => {
  const seen = { results: [], updates: [], running: [] }
  return { seen, hooks: { onResult: (r) => seen.results.push(r), onUpdate: (u) => seen.updates.push(u), onRunning: (v) => seen.running.push(v) } }
}
const runId = (id, env, opts) => D.runCheck(D.getCheck(id), env, opts)
const SPEC_AUTO = ['env-ua', 'env-screen', 'env-secure', 'env-locale', 'env-network', 'env-hardware', 'env-storage', 'gl', 'fps', 'ls', 'bc', 'sw', 'share', 'clipboard', 'fs-api', 'wakelock', 'recorder', 'midi-api', 'ble-api', 'xr-api', 'speech-api', 'gamepad-api', 'vibrate-api', 'pointer-api', 'screens-api']
const SPEC_INTER = ['cam', 'mic', 'speech', 'narration', 'watchdog', 'gesture', 'midi', 'gamepad', 'rumble', 'pointer', 'vibrate', 'orient', 'screens', 'popup', 'fullscreen']   // 前 12 項是原本的；narration / watchdog / gesture 是真機驗證日新增的三項

// 「全功能」的假瀏覽器：每個 API 都存在且正常
function fullEnv(over = {}) {
  const clock = over.clock || makeClock()
  const raf = fakeRaf(clock, over.rafMs ?? 16)
  const bc = fakeBC()
  const sentinels = []
  const xrCalls = []
  const nav = strict({
    userAgent: 'FakeUA/1.0 (Test)', platform: 'MacIntel', language: 'zh-TW', languages: ['zh-TW', 'en'], onLine: true, hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 5,
    connection: { effectiveType: '4g', downlink: 10, rtt: 50, saveData: false },
    storage: { estimate() { return Promise.resolve({ usage: 5e6, quota: 2e9 }) }, persisted() { return Promise.resolve(true) } },
    serviceWorker: { controller: {}, getRegistration() { return Promise.resolve({ active: {} }) } },
    share() {}, canShare(d) { return !!(d && d.files) },
    clipboard: { writeText() { return Promise.resolve() }, write() { return Promise.resolve() } },
    permissions: { query() { return Promise.resolve({ state: 'granted' }) } },
    wakeLock: { request() { const s = { released: false, release() { s.released = true; return Promise.resolve() } }; strict(s); sentinels.push(s); return Promise.resolve(s) } },
    requestMIDIAccess() { return Promise.resolve({}) },
    bluetooth: { getAvailability() { return Promise.resolve(true) } },
    xr: { isSessionSupported(m) { xrCalls.push(m); return Promise.resolve(true) }, requestSession() { throw new Error('診斷不可以開啟 AR 工作階段') } },
    getGamepads() { return [] },
    vibrate() { return true },
    ...over.nav,
  }, 'navigator')
  const win = strict({
    isSecureContext: true,
    location: { href: 'https://midisea.shyetech.com/?diagnostics=1#remote=abc123', protocol: 'https:' },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, orientation: { type: 'landscape-primary' }, isExtended: true },
    devicePixelRatio: 2, innerWidth: 1200, innerHeight: 800,
    PointerEvent: function PointerEvent() {}, ClipboardItem: function ClipboardItem() {}, SpeechRecognition: function SpeechRecognition() {},
    matchMedia(q) { return { matches: /coarse/.test(q) } },
    getScreenDetails() { return Promise.resolve({ screens: [] }) },
    ...over.win,
  }, 'window')
  const doc = over.doc || strict({
    hidden: false, visibilityState: 'visible', fullscreenEnabled: true, fullscreenElement: null,
    documentElement: { requestFullscreen() { return Promise.resolve() } },
    createElement(tag) { return tag === 'canvas' ? strict({ getContext(type) { return type === 'webgl2' ? fakeGl() : null } }) : {} },
  }, 'document')
  function MediaRecorder() {}
  MediaRecorder.isTypeSupported = function (t) { if (this !== MediaRecorder) throw new TypeError('Illegal invocation: MediaRecorder.isTypeSupported'); return /^video\/webm|^audio\/webm/.test(t) }
  const store = fakeStorage()
  const intl = strict({ DateTimeFormat() { return { resolvedOptions() { return { timeZone: 'Asia/Taipei' } } } } }, 'Intl')
  const env = {
    nav, win, doc, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    raf: raf.raf, cancelRaf: raf.cancelRaf, createChannel: (name) => bc.make(name),
    MediaRecorder, AudioContext: null, Intl: intl, makeFile: () => ({ name: 'x.png', type: 'image/png' }),
    getStorage: () => store, randomId: () => 'abc',
    ...over.env,
  }
  return { env, clock, raf, bc, nav, win, doc, store, sentinels, xrCalls, MediaRecorder }
}

// ───────────────────────────── 基礎：結果、訊息、總覽 ─────────────────────────────
test('註冊表：id 不重複、群組存在、規格列的自動 / 互動檢查都在、每項都有中文標題', () => {
  const checks = D.getChecks(), groups = new Set(D.getGroups().map((g) => g.id))
  assert.equal(new Set(checks.map((c) => c.id)).size, checks.length)
  for (const c of checks) {
    assert.ok(groups.has(c.group), c.id + ' 的群組存在')
    assert.ok(/[㐀-鿿]/.test(c.title), c.id + ' 標題要有中文（才能翻譯）')
    if (c.kind === 'auto') assert.equal(typeof c.run, 'function', c.id)
    else assert.ok(typeof c.body === 'function' || c.custom === 'pointer', c.id)
  }
  assert.deepEqual(D.getAutoChecks().map((c) => c.id), SPEC_AUTO)
  assert.deepEqual(D.getInteractiveChecks().map((c) => c.id).sort(), [...SPEC_INTER].sort())
  assert.equal(D.getCheck('nope'), null)
  assert.deepEqual(D.STATUSES, ['pass', 'fail', 'unsupported', 'needs-action', 'skipped', 'info'])
})

test('makeResult：規格欄位 { id, group, status, detail, ms }；壞狀態 → fail；毫秒四捨五入', () => {
  const c = { id: 'x', group: 'env' }
  assert.deepEqual(D.makeResult(c, { status: 'pass', msg: 'hi', ms: 12.6, data: { a: 1 } }, 5), { id: 'x', group: 'env', status: 'pass', detail: 'hi', ms: 13, data: { a: 1 } })
  assert.deepEqual(Object.keys(D.makeResult(c, { status: 'info', msg: 'x' }, 1)).sort(), ['detail', 'group', 'id', 'ms', 'status'])
  assert.equal(D.makeResult(c, { status: 'weird' }, 0).status, 'fail')
  assert.equal(D.makeResult(c, null, 0).status, 'fail')
  const r = D.makeResult(c, { status: 'info', msg: { key: '平台 {platform}；UA：{ua}', params: { platform: 'P', ua: 'U' } } }, 3)
  assert.equal(r.detail, '平台 P；UA：U'); assert.ok(r.msg && r.ms === 3)
  assert.equal(D.renderDetail(r), r.detail); assert.equal(D.renderDetail(null), '')
})

test('fmtMsg：字串 / 訊息 / 巢狀訊息 / 陣列（空值略過）；切換語系後用同一份訊息重新翻譯', () => {
  assert.equal(D.fmtMsg('plain'), 'plain'); assert.equal(D.fmtMsg(null), '')
  assert.equal(D.fmtMsg({ key: '{a}-{b}', params: { a: 1, b: { key: '螢幕 {n}', params: { n: 2 } } } }), '1-螢幕 2')
  assert.equal(D.fmtMsg(['x', null, { key: 'y' }, ['z']]), 'x · y · z')
  registerEn(en); registerEn(en2); setLocale('en')
  try {
    assert.equal(D.fmtMsg({ key: '螢幕 {n}', params: { n: 2 } }), 'Screen 2')
    assert.equal(D.statusKey('needs-action'), '待操作')
    const r = D.makeResult({ id: 'a', group: 'env' }, { status: 'pass', msg: { key: '寫入、讀回、刪除都成功' } }, 0)
    assert.equal(D.renderDetail(r), 'Write, read back and delete all succeeded')
  } finally { setLocale('zh') }
  assert.equal(D.renderDetail(D.makeResult({ id: 'a', group: 'env' }, { status: 'pass', msg: { key: '寫入、讀回、刪除都成功' } }, 0)), '寫入、讀回、刪除都成功')
})

test('summarize：通過（含資訊）/ 失敗 / 不支援 / 尚未測（沒執行、待操作、已略過）', () => {
  const checks = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({ id }))
  const results = { a: { status: 'pass' }, b: { status: 'info' }, c: { status: 'fail' }, d: { status: 'unsupported' }, e: { status: 'needs-action' }, f: { status: 'skipped' } }
  assert.deepEqual(D.summarize(checks, results), { total: 7, pass: 2, fail: 1, unsupported: 1, pending: 3 })
  assert.deepEqual(D.summarize(checks, {}), { total: 7, pass: 0, fail: 0, unsupported: 0, pending: 7 })
  assert.deepEqual(D.summarize([], null), { total: 0, pass: 0, fail: 0, unsupported: 0, pending: 0 })
  for (const s of D.STATUSES) assert.ok(/[㐀-鿿]/.test(D.statusKey(s)), s + ' 有中文標籤')
  assert.equal(D.statusKey('not-run'), '尚未測')
})

// ───────────────────────────── 自動檢查 ─────────────────────────────
test('快速檢查（全功能環境）：25 項都有結果、狀態合法、全部正常、沒有殘留計時器', async () => {
  const x = fullEnv()
  const starts = [], got = []
  const p = D.runAutoChecks(x.env, { onStart: (c) => starts.push(c.id), onResult: (r) => got.push(r.id) })
  await adv(x.clock, 8000, 50)
  const out = await p
  assert.equal(out.length, 25); assert.deepEqual(starts, SPEC_AUTO); assert.deepEqual(got, SPEC_AUTO)
  for (const r of out) {
    assert.ok(D.STATUSES.includes(r.status), r.id); assert.equal(typeof r.detail, 'string'); assert.ok(r.detail.length > 0, r.id + ' 有說明')
    assert.equal(typeof r.ms, 'number'); assert.ok(r.group)
  }
  const by = Object.fromEntries(out.map((r) => [r.id, r]))
  for (const id of ['env-secure', 'env-network', 'gl', 'fps', 'ls', 'bc', 'sw', 'share', 'clipboard', 'fs-api', 'wakelock', 'recorder', 'midi-api', 'ble-api', 'xr-api', 'speech-api', 'gamepad-api', 'vibrate-api', 'pointer-api', 'screens-api']) assert.equal(by[id].status, 'pass', id + ' ' + by[id].detail)
  for (const id of ['env-ua', 'env-screen', 'env-locale', 'env-hardware', 'env-storage']) assert.equal(by[id].status, 'info', id)
  assert.match(by['env-ua'].detail, /MacIntel/); assert.match(by['env-ua'].detail, /FakeUA/)
  assert.match(by['env-screen'].detail, /1920×1080/); assert.match(by['env-screen'].detail, /1200×800/); assert.equal(by['env-screen'].data.dpr, 2)
  assert.match(by['env-locale'].detail, /Asia\/Taipei/); assert.match(by['env-network'].detail, /4g/); assert.match(by['env-hardware'].detail, /8/)
  assert.match(by['env-storage'].detail, /5 MB/); assert.match(by['env-storage'].detail, /2 GB/); assert.equal(by['env-storage'].data.persisted, true)
  assert.deepEqual(x.xrCalls, ['immersive-ar'], 'XR 只查 isSessionSupported（xr 假物件在 requestSession 會丟例外）')
  assert.equal(x.clock.pending(), 0, '沒有殘留計時器')
  assert.equal(x.raf.live.size, 0, '沒有殘留 rAF')
  assert.ok(x.bc.chans.every((c) => c.closed && c.onmessage === null), 'BroadcastChannel 都關了')
  assert.ok(x.sentinels.every((s) => s.released), 'Wake Lock 都釋放了')
  assert.equal(Object.keys(x.store.data).length, 0, 'localStorage 探測用的鍵已清掉')
})

test('快速檢查：空環境、全部 API 都會丟例外的環境、Node 預設環境——都不丟例外，每項仍有合法結果', async () => {
  const empty = await D.runAutoChecks({})
  assert.equal(empty.length, 25); for (const r of empty) assert.ok(D.STATUSES.includes(r.status), r.id)
  assert.equal(empty.find((r) => r.id === 'gl').status, 'fail'); assert.equal(empty.find((r) => r.id === 'bc').status, 'unsupported'); assert.equal(empty.find((r) => r.id === 'fps').status, 'unsupported')

  const boom = new Proxy({}, { get() { throw new Error('boom') } })
  const clock = makeClock()
  const hostile = await D.runAutoChecks({ nav: boom, win: boom, doc: boom, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, raf: () => { throw new Error('raf boom') }, createChannel: () => { throw new Error('bc boom') }, getStorage: () => { throw new Error('ls boom') } })
  assert.equal(hostile.length, 25)
  for (const r of hostile) { assert.ok(D.STATUSES.includes(r.status), r.id); assert.equal(typeof r.detail, 'string') }
  assert.ok(hostile.filter((r) => r.status === 'fail').length >= 15, '大多數檢查把例外變成 fail：' + hostile.filter((r) => r.status === 'fail').length)
  assert.match(hostile.find((r) => r.id === 'env-ua').detail, /boom/)

  const node = await D.runAutoChecks(D.browserEnv({}), { checks: D.getAutoChecks().filter((c) => c.id !== 'fps') })
  for (const r of node) assert.ok(D.STATUSES.includes(r.status), r.id)
  const real = await D.runAutoChecks(D.browserEnv(), { checks: D.getAutoChecks().filter((c) => c.id !== 'fps' && c.id !== 'ls') })   // Node 全域：沒有 window / document（略過 ls：Node 25 存取 globalThis.localStorage 會印警告）
  for (const r of real) assert.ok(D.STATUSES.includes(r.status), r.id)
})

test('runCheck：卡住的檢查在保險逾時後變成 fail 並通知它放掉資源；例外變成 fail；取消時停止後續', async () => {
  const clock = makeClock(); const { env } = makeEnv({}, clock)
  let cleaned = 0
  const hung = { id: 'x', group: 'env', kind: 'auto', title: 'x', run: (e, ctx) => { ctx.cancel.onCancel(() => cleaned++); return new Promise(() => {}) } }
  const p = D.runCheck(hung, env)
  await adv(clock, 9000, 500)
  const r = await p
  assert.equal(r.status, 'fail'); assert.match(r.detail, /逾時/); assert.equal(cleaned, 1); assert.equal(clock.pending(), 0)
  const bad = { id: 'y', group: 'env', kind: 'auto', title: 'y', run: () => { throw new RangeError('壞了') } }
  const r2 = await D.runCheck(bad, env)
  assert.equal(r2.status, 'fail'); assert.match(r2.detail, /RangeError/)
  const cancel = D.createCancel(); const ran = []
  const mk = (id) => ({ id, group: 'env', kind: 'auto', title: id, run: () => { ran.push(id); if (id === 'b') cancel.cancel(); return { status: 'pass', msg: 'ok' } } })
  const out = await D.runAutoChecks(env, { checks: [mk('a'), mk('b'), mk('c')], cancel })
  assert.deepEqual(ran, ['a', 'b']); assert.equal(out.length, 2)
})

test('環境：離線 → fail；非安全環境 → fail；沒有 navigator → fail；缺欄位不丟例外', async () => {
  const off = fullEnv({ nav: { onLine: false } })
  const r = await runId('env-network', off.env); assert.equal(r.status, 'fail'); assert.match(r.detail, /離線/)
  const insecure = fullEnv({ win: { isSecureContext: false, location: { href: 'http://192.168.0.5/', protocol: 'http:' } } })
  const s = await runId('env-secure', insecure.env); assert.equal(s.status, 'fail'); assert.match(s.detail, /http:/); assert.equal(s.data.secure, false)
  assert.equal((await runId('env-ua', { nav: null })).status, 'fail')
  assert.equal((await runId('env-storage', { nav: {} })).status, 'unsupported')
  assert.equal((await runId('env-network', { nav: {} })).status, 'info')
})

test('WebGL：WebGL2 → pass 並釋放 context；只有 WebGL1 / 軟體繪圖 / 建立失敗 → fail', async () => {
  const gl2 = fakeGl()
  const ok = await runId('gl', { doc: fakeDocGl({ webgl2: gl2 }) })
  assert.equal(ok.status, 'pass'); assert.equal(ok.data.version, 2); assert.equal(ok.data.maxTextureSize, 16384); assert.equal(ok.data.antialias, true)
  assert.match(ok.detail, /Apple M1/); assert.equal(gl2.lost, 1, 'WEBGL_lose_context 被呼叫（釋放 GPU 資源）')
  const gl1 = fakeGl({ aa: false })
  const one = await runId('gl', { doc: fakeDocGl({ webgl: gl1 }) })
  assert.equal(one.status, 'fail'); assert.equal(one.data.version, 1); assert.match(one.detail, /WebGL 2/); assert.equal(gl1.lost, 1)
  const soft = await runId('gl', { doc: fakeDocGl({ webgl2: fakeGl({ renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))' }) }) })
  assert.equal(soft.status, 'fail'); assert.equal(soft.data.software, true)
  assert.equal((await runId('gl', { doc: fakeDocGl({}) })).status, 'fail')
  assert.equal((await runId('gl', { doc: fakeDocGl({ webgl2: new Error('lost'), webgl: new Error('lost') }) })).status, 'fail')
  assert.equal((await runId('gl', {})).status, 'fail')
})

test('FPS：60fps → pass（平均 / 最低）；20fps → fail；卡住 → 逾時 fail 並取消 rAF；背景分頁 skipped；沒有 rAF unsupported；取消 → skipped', async () => {
  const good = fullEnv(); let p = runId('fps', good.env)
  await adv(good.clock, 3000, 16)
  let r = await p
  assert.equal(r.status, 'pass'); assert.ok(r.data.avg > 60 && r.data.avg < 65, 'avg ' + r.data.avg); assert.ok(r.data.min > 60, 'min ' + r.data.min)
  assert.match(r.detail, /平均 62\.5 FPS，最低 62\.5 FPS/); assert.equal(good.clock.pending(), 0)

  const slow = fullEnv({ rafMs: 50 }); p = runId('fps', slow.env)
  await adv(slow.clock, 3000, 50); r = await p
  assert.equal(r.status, 'fail'); assert.equal(r.data.avg, 20); assert.match(r.detail, /低於 45 FPS/)

  const clock = makeClock(); const cancelled = []; let n = 0
  const stuck = fullEnv({ clock, env: { raf: () => ++n, cancelRaf: (id) => cancelled.push(id) } })
  p = runId('fps', stuck.env); await adv(clock, 5000, 100); r = await p
  assert.equal(r.status, 'fail'); assert.match(r.detail, /沒有畫面幀/); assert.deepEqual(cancelled, [1], '逾時要取消還在排的 rAF'); assert.equal(clock.pending(), 0)

  assert.equal((await runId('fps', fullEnv({ doc: strict({ hidden: true }) }).env)).status, 'skipped')
  assert.equal((await runId('fps', { now: makeClock().now })).status, 'unsupported')

  const c2 = fullEnv(); const cancel = D.createCancel(); p = runId('fps', c2.env, { cancel })
  await adv(c2.clock, 100, 16); cancel.cancel(); r = await p
  assert.equal(r.status, 'skipped'); assert.equal(c2.clock.pending(), 0); assert.equal(c2.raf.live.size, 0)
})

test('localStorage：pass；拒絕存取 / 額度滿 / 讀回不一致 → fail；沒有 → unsupported；探測用的鍵一律清掉', async () => {
  const ok = fullEnv(); assert.equal((await runId('ls', ok.env)).status, 'pass'); assert.deepEqual(ok.store.data, {})
  const denied = await runId('ls', { getStorage: () => { const e = new Error('denied'); e.name = 'SecurityError'; throw e } })
  assert.equal(denied.status, 'fail'); assert.match(denied.detail, /SecurityError/)
  const removed = []
  const full = await runId('ls', { getStorage: () => strict({ setItem() { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e }, getItem() { return null }, removeItem(k) { removed.push(k) } }) })
  assert.equal(full.status, 'fail'); assert.match(full.detail, /QuotaExceededError/); assert.deepEqual(removed, ['ixd2026.diag-probe'])
  const mismatch = await runId('ls', { getStorage: () => strict({ setItem() {}, getItem() { return 'other' }, removeItem() {} }) })
  assert.equal(mismatch.status, 'fail')
  assert.equal((await runId('ls', { getStorage: () => null })).status, 'unsupported'); assert.equal((await runId('ls', {})).status, 'unsupported')
})

test('BroadcastChannel：兩個 channel 往返 pass 並都關閉；沒訊息 → 逾時 fail 也都關閉；建立失敗 → fail；沒有 → unsupported', async () => {
  const good = fullEnv(); const r = await runId('bc', good.env)
  assert.equal(r.status, 'pass'); assert.equal(good.bc.chans.length, 2); assert.ok(good.bc.chans.every((c) => c.closed && c.onmessage === null)); assert.equal(good.clock.pending(), 0)

  const clock = makeClock(); const bc = fakeBC({ deliver: false })
  const x = fullEnv({ clock, env: { createChannel: (n) => bc.make(n) } })
  const p = runId('bc', x.env); await adv(clock, 2000, 100); const t = await p
  assert.equal(t.status, 'fail'); assert.match(t.detail, /1500 ms/); assert.ok(bc.chans.every((c) => c.closed)); assert.equal(clock.pending(), 0)

  const thrower = fakeBC({ throwOnCreate: true })
  assert.equal((await runId('bc', fullEnv({ env: { createChannel: (n) => thrower.make(n) } }).env)).status, 'fail')
  assert.equal((await runId('bc', { now: makeClock().now })).status, 'unsupported')
})

test('Service Worker：已啟用 pass；未註冊 / 安裝中 → needs-action；沒有 → unsupported；查詢逾時 / 例外 → fail', async () => {
  const sw = (o) => fullEnv({ nav: { serviceWorker: o } }).env
  const on = await runId('sw', sw({ controller: {}, getRegistration() { return Promise.resolve({ active: {} }) } })); assert.equal(on.status, 'pass'); assert.equal(on.data.controlled, true)
  const idle = await runId('sw', sw({ controller: null, getRegistration() { return Promise.resolve({ active: {} }) } })); assert.equal(idle.status, 'pass'); assert.equal(idle.data.controlled, false); assert.match(idle.detail, /重新整理/)
  assert.equal((await runId('sw', sw({ getRegistration() { return Promise.resolve(undefined) } }))).status, 'needs-action')
  const inst = await runId('sw', sw({ getRegistration() { return Promise.resolve({ installing: {} }) } })); assert.equal(inst.status, 'needs-action'); assert.equal(inst.data.state, 'installing')
  assert.equal((await runId('sw', { nav: {} })).status, 'unsupported')
  assert.equal((await runId('sw', sw({ getRegistration() { return Promise.reject(new Error('sw broke')) } }))).status, 'fail')
  const clock = makeClock(); const p = runId('sw', fullEnv({ clock, nav: { serviceWorker: { getRegistration() { return new Promise(() => {}) } } } }).env)
  await adv(clock, 9000, 500); assert.equal((await p).status, 'fail'); assert.equal(clock.pending(), 0)
})

test('Web Share / 剪貼簿 / 全螢幕 API：各種能力組合', async () => {
  assert.equal((await runId('share', fullEnv().env)).status, 'pass')
  const noFiles = await runId('share', fullEnv({ nav: { canShare() { return false } } }).env); assert.equal(noFiles.status, 'unsupported'); assert.equal(noFiles.data.share, true)
  assert.equal((await runId('share', fullEnv({ nav: { canShare() { throw new Error('x') } } }).env)).status, 'unsupported')
  assert.equal((await runId('share', { nav: {} })).status, 'unsupported')

  const cb = await runId('clipboard', fullEnv().env); assert.equal(cb.status, 'pass'); assert.equal(cb.data.image, true); assert.equal(cb.data.permission, 'granted')
  assert.equal((await runId('clipboard', fullEnv({ nav: { permissions: { query() { return Promise.resolve({ state: 'denied' }) } } } }).env)).status, 'fail')
  assert.equal((await runId('clipboard', fullEnv({ nav: { permissions: { query() { return Promise.reject(new TypeError('firefox')) } } } }).env)).status, 'pass', '查權限失敗不等於不能寫')
  assert.equal((await runId('clipboard', fullEnv({ nav: { clipboard: undefined } }).env)).status, 'unsupported')

  assert.equal((await runId('fs-api', fullEnv().env)).status, 'pass')
  assert.equal((await runId('fs-api', fullEnv({ doc: strict({ fullscreenEnabled: false, documentElement: { requestFullscreen() {} } }) }).env)).status, 'fail')
  assert.equal((await runId('fs-api', fullEnv({ doc: strict({ documentElement: {} }) }).env)).status, 'unsupported')
  assert.equal((await runId('fs-api', fullEnv({ doc: strict({ webkitFullscreenEnabled: true, documentElement: { webkitRequestFullscreen() {} } }) }).env)).status, 'pass')
})

test('Wake Lock：請求後立刻釋放；拒絕 → fail；卡住 → 逾時 fail，遲到的鎖也會被釋放；背景 skipped；沒有 unsupported', async () => {
  const ok = fullEnv(); const r = await runId('wakelock', ok.env)
  assert.equal(r.status, 'pass'); assert.equal(ok.sentinels.length, 1); assert.equal(ok.sentinels[0].released, true)

  const deny = fullEnv({ nav: { wakeLock: { request() { const e = new Error('no'); e.name = 'NotAllowedError'; return Promise.reject(e) } } } })
  const d = await runId('wakelock', deny.env); assert.equal(d.status, 'fail'); assert.match(d.detail, /NotAllowedError/)

  const clock = makeClock(); let resolveLate; const late = { released: false, release() { late.released = true; return Promise.resolve() } }; strict(late)
  const hang = fullEnv({ clock, nav: { wakeLock: { request() { return new Promise((res) => { resolveLate = () => res(late) }) } } } })
  const p = runId('wakelock', hang.env); await adv(clock, 4000, 200)
  const t = await p; assert.equal(t.status, 'fail'); assert.match(t.detail, /3 秒/)
  resolveLate(); await settle(); assert.equal(late.released, true, '逾時後才拿到的鎖立刻釋放'); assert.equal(clock.pending(), 0)

  assert.equal((await runId('wakelock', fullEnv({ doc: strict({ hidden: true, visibilityState: 'hidden' }) }).env)).status, 'skipped')
  assert.equal((await runId('wakelock', { nav: {} })).status, 'unsupported')
})

test('MediaRecorder：列出 mp4 / webm 支援；沒有 MediaRecorder → unsupported；全部不支援 → fail；isTypeSupported 丟例外算不支援', async () => {
  const r = await runId('recorder', fullEnv().env)
  assert.equal(r.status, 'pass'); assert.equal(r.data.webm, true); assert.equal(r.data.mp4, false); assert.ok(r.data.supported.includes('video/webm;codecs=vp9')); assert.ok(r.data.unsupported.includes('video/mp4'))
  assert.match(r.detail, /mp4：格式不可用；webm：格式可用/)
  function MR() {} MR.isTypeSupported = function (t) { if (this !== MR) throw new TypeError('Illegal'); return t.startsWith('video/mp4') }
  const mp4 = await runId('recorder', { MediaRecorder: MR }); assert.equal(mp4.status, 'pass'); assert.equal(mp4.data.mp4, true); assert.equal(mp4.data.webm, false)
  function MRn() {} MRn.isTypeSupported = function () { return false }
  assert.equal((await runId('recorder', { MediaRecorder: MRn })).status, 'fail')
  function MRt() {} MRt.isTypeSupported = function () { throw new Error('x') }
  assert.equal((await runId('recorder', { MediaRecorder: MRt })).status, 'fail')
  assert.equal((await runId('recorder', {})).status, 'unsupported')
})

test('裝置 API 偵測：MIDI / 藍牙 / WebXR / 語音 / 手把 / 震動 / PointerEvent / getScreenDetails——存在 → pass，不存在 → unsupported，出錯 → fail', async () => {
  const bare = { nav: {}, win: {} }
  for (const id of ['midi-api', 'ble-api', 'xr-api', 'speech-api', 'gamepad-api', 'vibrate-api', 'pointer-api', 'screens-api']) {
    assert.equal((await runId(id, fullEnv().env)).status, 'pass', id + ' 存在')
    assert.equal((await runId(id, bare)).status, 'unsupported', id + ' 不存在')
  }
  assert.equal((await runId('ble-api', fullEnv({ nav: { bluetooth: { getAvailability() { return Promise.resolve(false) } } } }).env)).status, 'fail')
  assert.equal((await runId('ble-api', fullEnv({ nav: { bluetooth: {} } }).env)).status, 'pass')
  const xrFalse = await runId('xr-api', fullEnv({ nav: { xr: { isSessionSupported() { return Promise.resolve(false) } } } }).env); assert.equal(xrFalse.status, 'unsupported')
  assert.equal((await runId('xr-api', fullEnv({ nav: { xr: { isSessionSupported() { return Promise.reject(new Error('SecurityError')) } } } }).env)).status, 'fail')
  const clock = makeClock(); const xp = runId('xr-api', fullEnv({ clock, nav: { xr: { isSessionSupported() { return new Promise(() => {}) } } } }).env)
  await adv(clock, 5000, 250); const xt = await xp; assert.equal(xt.status, 'fail'); assert.match(xt.detail, /4 秒/); assert.equal(clock.pending(), 0)
  assert.equal((await runId('speech-api', fullEnv({ win: { SpeechRecognition: undefined, webkitSpeechRecognition: function W() {} } }).env)).status, 'pass', 'webkit 前綴')
  const gp = await runId('gamepad-api', fullEnv({ nav: { getGamepads() { return [null, { connected: true }, { connected: false }] } } }).env); assert.equal(gp.status, 'pass'); assert.equal(gp.data.connected, 1)
  assert.equal((await runId('gamepad-api', fullEnv({ nav: { getGamepads() { throw new Error('SecurityError') } } }).env)).status, 'fail')
  const ptr = await runId('pointer-api', fullEnv().env); assert.equal(ptr.data.maxTouchPoints, 5); assert.equal(ptr.data.coarse, true)
  const scr = await runId('screens-api', fullEnv().env); assert.equal(scr.data.isExtended, true)
})

// ───────────────────────────── 互動檢查：探測器生命週期 ─────────────────────────────
test('createProbe：未知 id 丟例外；重複 start 回傳同一個 promise；未執行時 stop 無害；stop 後立刻重啟是全新一輪（舊輪的結果不會蓋過新輪）', async () => {
  const clock = makeClock(); const vibs = []
  const nav = strict({ vibrate(p) { vibs.push(p); return true } })
  const { env } = makeEnv({ nav }, clock)
  assert.throws(() => D.createProbe('nope', env), /unknown probe/)
  assert.throws(() => D.createProbe('env-ua', env), /unknown probe/, '自動檢查不是探測器')
  const { seen, hooks } = collect()
  const probe = D.createProbe('vibrate', env, hooks)
  assert.doesNotThrow(() => probe.stop())
  const p1 = probe.start(); assert.equal(probe.start(), p1); assert.equal(probe.running, true)
  await settle(); assert.equal(seen.results[0].status, 'needs-action')
  probe.stop(); assert.equal(vibs.at(-1), 0, '中途停止 → vibrate(0)'); assert.equal(probe.running, false)
  const p2 = probe.start(); assert.notEqual(p1, p2)
  await settle()
  assert.equal((await p1).status, 'skipped')
  assert.ok(!seen.results.some((r) => r.status === 'skipped'), '舊一輪收尾的結果不會送進 onResult')
  await adv(clock, 1100, 50); await p2
  assert.equal(seen.results.at(-1).status, 'needs-action'); assert.equal(probe.running, false); assert.equal(clock.pending(), 0)
  probe.destroy(); const n = seen.results.length; const pd = probe.start(); await adv(clock, 1100, 50); await pd; assert.equal(seen.results.length, n, 'destroy 之後不再呼叫掛勾')
  const bad = D.createProbe('vibrate', env, { onResult() { throw new Error('hook 壞了') }, onRunning() { throw new Error('hook 壞了') } })
  const pb = bad.start(); await adv(clock, 1100, 50)
  assert.equal((await pb).status, 'needs-action', '掛勾丟例外不影響探測'); assert.equal(clock.pending(), 0)
})

test('createProbe：body 丟例外 → fail 結果；所有資源仍被清掉', async () => {
  const boom = new Proxy({}, { get() { throw new Error('boom') } })
  const { env } = makeEnv({ nav: boom, win: boom, doc: boom })
  for (const id of ['cam', 'mic', 'speech', 'midi', 'gamepad', 'rumble', 'vibrate', 'orient', 'screens', 'popup', 'fullscreen']) {
    const r = await D.createProbe(id, env).start()
    assert.equal(r.status, 'fail', id); assert.match(r.detail, /boom/, id)
  }
})

// ───────────────────────────── 相機 ─────────────────────────────
function camSetup(o = {}) {
  const clock = makeClock()
  const md = fakeMedia(o.md)
  const video = fakeVideo(clock)
  const { seen, hooks } = collect()
  seen.attached = 0; seen.detached = 0
  const win = fakeWin({ isSecureContext: o.secure !== false })
  const nav = o.noMedia ? strict({}) : strict({ mediaDevices: md })
  const { env } = makeEnv({ nav, win }, clock)
  const probe = D.createProbe('cam', env, {
    ...hooks, facing: o.facing || 'user',
    attach: o.attach || (async (s) => { seen.attached++; video.srcObject = s; return video }),
    detach: () => { seen.detached++ },
  })
  return { clock, md, video, seen, probe, env }
}

test('相機：取得影像 → 解析度 / 實測 FPS；預覽時間到 → 停掉所有 track、放掉預覽、沒有殘留計時器', async () => {
  const x = camSetup()
  const p = x.probe.start()
  assert.equal(x.probe.running, true)
  await adv(x.clock, 2500, 33)
  const first = x.seen.results[0]
  assert.equal(first.status, 'pass'); assert.equal(first.data.width, 1280); assert.equal(first.data.height, 720); assert.equal(first.data.facingMode, 'user')
  assert.ok(first.data.fps > 28 && first.data.fps < 32, 'fps ' + first.data.fps); assert.match(first.detail, /1280×720/); assert.match(first.detail, /實測/)
  assert.deepEqual(x.md.calls[0].video.facingMode, { ideal: 'user' }); assert.equal(x.md.calls[0].audio, false)
  assert.ok(x.md.streams[0].tracks.every((t) => t.stopped === 0), '預覽中不停'); assert.equal(x.seen.attached, 1)
  await adv(x.clock, 31000, 500)
  const final = await p
  assert.equal(final.status, 'pass'); assert.ok(x.md.streams[0].tracks.every((t) => t.stopped === 1), '結束一定停掉 track')
  assert.equal(x.seen.detached, 1); assert.deepEqual(x.seen.running, [true, false]); assert.equal(x.probe.running, false)
  assert.equal(x.clock.pending(), 0); assert.equal(x.video.live.size, 0)
  assert.ok(!JSON.stringify(x.seen.results).includes('Alice'), '結果不含裝置名稱')
})

test('相機：stop() 同步放掉 track（不等非同步收尾）；getUserMedia 還沒回來就 stop → 遲到的串流立刻被停掉', async () => {
  const a = camSetup(); const pa = a.probe.start(); await adv(a.clock, 2500, 33)
  a.probe.stop()
  assert.ok(a.md.streams[0].tracks.every((t) => t.stopped === 1), '同步停止（頁面卸載 / pagehide 的當下就要放掉）'); assert.equal(a.seen.detached, 1)
  assert.equal((await pa).status, 'pass', '量到的結果保留'); assert.equal(a.clock.pending(), 0)

  const b = camSetup({ md: { mode: 'late' } }); const pb = b.probe.start(); await settle(); b.probe.stop()
  assert.deepEqual(b.seen.running, [true, false], '按停止後畫面立刻回到「未執行」，不必等權限提示逾時')
  await settle(); assert.equal(b.clock.pending(), 0, '等權限提示的逾時計時器也一併清掉（不是 30 秒後才消失）')
  assert.equal((await pb).status, 'skipped', '不必等 30 秒逾時；也不會被誤報成「逾時失敗」')
  b.md.resolveLate(); await settle()
  assert.equal(b.md.streams.length, 1); assert.ok(b.md.streams[0].tracks.every((t) => t.stopped === 1), '之後才到的串流立刻停掉'); assert.equal(b.seen.attached, 0)
  assert.deepEqual(b.seen.running, [true, false]); assert.ok(!b.seen.results.some((r) => r.status === 'fail'))

  // attach 卡住時按停止：預覽仍會被放掉、track 也停掉
  const hangAttach = camSetup({ attach: () => new Promise(() => {}) }); const pha = hangAttach.probe.start(); await settle()
  hangAttach.probe.stop(); assert.ok(hangAttach.md.streams[0].tracks.every((t) => t.stopped === 1)); assert.equal(hangAttach.seen.detached, 1); assert.equal((await pha).status, 'skipped'); assert.equal(hangAttach.clock.pending(), 0)
  const slowAttach = camSetup({ attach: () => new Promise(() => {}) }); const psa = slowAttach.probe.start(); await adv(slowAttach.clock, 6000, 250)
  assert.equal(slowAttach.seen.results[0].status, 'pass', '預覽元素 5 秒沒回應也不會拖住：改用標稱幀率'); assert.equal(slowAttach.seen.results[0].data.fps, null); slowAttach.probe.stop(); await psa; assert.equal(slowAttach.clock.pending(), 0)

  const c = camSetup(); const pc = c.probe.start(); await settle(); c.probe.stop(); c.probe.stop()   // 剛取得串流、還在 attach / 量測前就停
  await pc; assert.ok(c.md.streams.every((s) => s.tracks.every((t) => t.stopped >= 1)))
})

test('相機：權限被拒 / 找不到 / 被占用 / 規格不符 / 安全性 / 其他 → fail 且不留 track；逾時 fail，之後才到的串流也被停掉；沒有 getUserMedia → unsupported', async () => {
  const cases = [['NotAllowedError', /權限被拒絕/], ['PermissionDeniedError', /權限被拒絕/], ['NotFoundError', /找不到/], ['NotReadableError', /占用/], ['OverconstrainedError', /規格/], ['SecurityError', /https/], ['AbortError', /中止/], ['TypeError', /https/], ['WeirdError', /WeirdError/]]
  for (const [name, re] of cases) {
    const x = camSetup({ md: { mode: name } }); const r = await x.probe.start()
    assert.equal(r.status, 'fail', name); assert.match(r.detail, re, name); assert.equal(r.data.error, name); assert.equal(x.md.streams.length, 0); assert.equal(x.seen.attached, 0); assert.equal(x.clock.pending(), 0)
  }
  assert.equal(D.classifyMediaError({ name: 'NotAllowedError' }), 'denied'); assert.equal(D.classifyMediaError(null), 'error')

  const hang = camSetup({ md: { mode: 'late' } }); const p = hang.probe.start(); await adv(hang.clock, 31000, 1000)
  const t = await p; assert.equal(t.status, 'fail'); assert.match(t.detail, /30 秒/)
  hang.md.resolveLate(); await settle(); assert.ok(hang.md.streams[0].tracks.every((tr) => tr.stopped === 1), '逾時後才到的串流也停掉'); assert.equal(hang.clock.pending(), 0)

  const un = await camSetup({ noMedia: true }).probe.start(); assert.equal(un.status, 'unsupported'); assert.match(un.detail, /getUserMedia/)
  const ins = await camSetup({ noMedia: true, secure: false }).probe.start(); assert.equal(ins.status, 'unsupported'); assert.match(ins.detail, /https/)
})

test('相機：串流沒有視訊軌 → fail 並停掉；attach 失敗仍可用標稱幀率；沒有 rVFC 時退回 getVideoPlaybackQuality；後鏡頭選項傳進 constraints', async () => {
  const none = camSetup({ md: { kinds: [] } }); const r = await none.probe.start(); assert.equal(r.status, 'fail'); assert.match(r.detail, /視訊軌/)
  const noAttach = camSetup({ attach: async () => { throw new Error('no video element') } }); const p = noAttach.probe.start(); await adv(noAttach.clock, 100, 20)
  assert.equal(noAttach.seen.results[0].data.fps, null); assert.equal(noAttach.seen.results[0].data.nominalFps, 30); assert.match(noAttach.seen.results[0].detail, /標稱 30/)
  noAttach.probe.stop(); await p

  let frames = 0
  const q = camSetup({ attach: async () => strict({ getVideoPlaybackQuality() { return { totalVideoFrames: frames } } }) })
  const pq = q.probe.start(); await settle(); frames = 45; await adv(q.clock, 1600, 100)
  assert.equal(q.seen.results[0].data.fps, 30); q.probe.stop(); await pq

  const env = camSetup({ facing: 'environment' }); const pe = env.probe.start(); await settle()
  assert.deepEqual(env.md.calls[0].video.facingMode, { ideal: 'environment' }); env.probe.stop(); await pe
})

test('相機：中途被拔除（track ended）會通知畫面；停止時拿掉 onended', async () => {
  const x = camSetup(); const p = x.probe.start(); await adv(x.clock, 2500, 33)
  const track = x.md.streams[0].tracks[0]; track.onended()
  assert.ok(x.seen.updates.some((u) => u.ended === true))
  x.probe.stop(); assert.equal(track.onended, null); await p
})

// ───────────────────────────── 麥克風 ─────────────────────────────
function fakeAudioContext(getAmp, log) {
  const created = []
  function FakeAC() {
    const ctx = this
    ctx.state = 'suspended'; ctx.resumed = 0; ctx.closed = 0; ctx.disconnected = 0
    ctx.resume = () => { ctx.resumed++; ctx.state = 'running'; return Promise.resolve() }
    ctx.close = () => { ctx.closed++; return Promise.resolve() }
    ctx.createAnalyser = () => strict({ fftSize: 0, getByteTimeDomainData(buf) { const a = getAmp(); for (let i = 0; i < buf.length; i++) buf[i] = 128 + (i % 2 ? 1 : -1) * Math.round(a * 128) } })
    ctx.createMediaStreamSource = () => strict({ connect() {}, disconnect() { ctx.disconnected++ } })
    if (log) log.push('ctx')
    created.push(ctx)
    return strict(ctx, 'AudioContext')
  }
  FakeAC.created = created
  return FakeAC
}
function micSetup(o = {}) {
  const clock = makeClock(); const log = []
  const md = fakeMedia({ ...o.md, log })
  const amp = { v: o.amp ?? 0.25 }
  const AC = o.noAC ? null : fakeAudioContext(() => amp.v, log)
  const { seen, hooks } = collect()
  const { env } = makeEnv({ nav: o.noMedia ? strict({}) : strict({ mediaDevices: md }), win: fakeWin(), AudioContext: AC }, clock)
  return { clock, md, AC, seen, log, amp, probe: D.createProbe('mic', env, hooks) }
}

test('麥克風：AudioContext 在第一個 await 之前同步建立（Safari 手勢）；3 秒音量條；有聲音 → pass；結束停 track、關 context', async () => {
  const x = micSetup()
  const p = x.probe.start()
  assert.deepEqual(x.log, ['ctx', 'gum'], '同一個點擊事件內先建 AudioContext 再要麥克風'); assert.equal(x.AC.created[0].resumed, 1)
  await adv(x.clock, 3500, 50)
  const r = await p
  assert.equal(r.status, 'pass'); assert.equal(r.data.peakPct, 75); assert.equal(r.data.samples, 30); assert.match(r.detail, /75%/)
  assert.equal(x.seen.updates.length, 30); assert.equal(x.seen.updates[0].level, 0.75); assert.ok(x.seen.updates.at(-1).elapsedMs === 3000)
  assert.ok(x.md.streams[0].tracks.every((t) => t.stopped === 1), '停掉 track'); assert.equal(x.AC.created[0].closed, 1); assert.equal(x.AC.created[0].disconnected, 1)
  assert.equal(x.clock.pending(), 0); assert.deepEqual(x.seen.running, [true, false])
})

test('麥克風：安靜 → needs-action；權限被拒 → fail 且 context 仍關閉；沒有 AudioContext → 仍 pass（無音量條）；stop() 同步放掉；沒有 getUserMedia → unsupported', async () => {
  const quiet = micSetup({ amp: 0 }); const pq = quiet.probe.start(); await adv(quiet.clock, 3500, 50); const q = await pq
  assert.equal(q.status, 'needs-action'); assert.match(q.detail, /幾乎沒收到聲音/)

  const denied = micSetup({ md: { mode: 'NotAllowedError' } }); const d = await denied.probe.start()
  assert.equal(d.status, 'fail'); assert.match(d.detail, /麥克風裝置/); assert.equal(denied.AC.created[0].closed, 1)

  const noAC = micSetup({ noAC: true }); const n = await noAC.probe.start(); assert.equal(n.status, 'pass'); assert.match(n.detail, /AudioContext/); assert.ok(noAC.md.streams[0].tracks.every((t) => t.stopped === 1))

  const mid = micSetup(); const pm = mid.probe.start(); await adv(mid.clock, 1000, 50)
  mid.probe.stop()
  assert.ok(mid.md.streams[0].tracks.every((t) => t.stopped === 1)); assert.equal(mid.AC.created[0].closed, 1)
  const partial = await pm; assert.equal(partial.status, 'pass', '停止時用已取樣的資料判斷'); assert.equal(mid.clock.pending(), 0)

  const un = micSetup({ noMedia: true }); assert.equal((await un.probe.start()).status, 'unsupported')
  assert.equal(D.rmsOfBytes(new Uint8Array(64).fill(128)), 0); assert.equal(D.rmsOfBytes(null), 0); assert.ok(D.rmsOfBytes(Uint8Array.from([0, 255, 0, 255])) > 0.9)
})

// ───────────────────────────── 語音辨識 ─────────────────────────────
function fakeSpeech(clock, script) {
  const instances = []
  function SpeechRecognition() {
    const rec = this
    rec.lang = ''; rec.started = 0; rec.stopped = 0; rec.aborted = 0
    rec.start = function () { rec.started++; if (script.throwOnStart) throw Object.assign(new Error('already started'), { name: 'InvalidStateError' }); script.onStart && script.onStart(rec, clock) }
    rec.stop = function () { rec.stopped++; script.onStop && script.onStop(rec, clock) }
    rec.abort = function () { rec.aborted++ }
    instances.push(rec)
    return strict(rec, 'SpeechRecognition')
  }
  SpeechRecognition.instances = instances
  return SpeechRecognition
}
function speechSetup(script, o = {}) {
  const clock = makeClock()
  const SR = fakeSpeech(clock, script)
  const { seen, hooks } = collect()
  const { env } = makeEnv({ win: fakeWin({ SpeechRecognition: o.absent ? undefined : SR }), nav: strict({}) }, clock)
  return { clock, SR, seen, probe: D.createProbe('speech', env, { ...hooks, lang: o.lang || 'zh-TW' }) }
}
const result = (text) => ({ results: [[{ transcript: text }]] })

test('語音：辨識到文字 → pass，報告只留字數（不留內容）；5 秒後 stop()；結束 abort 並拔掉 handler', async () => {
  const x = speechSetup({
    onStart(rec, clock) { clock.setTimeout(() => rec.onstart && rec.onstart(), 10); clock.setTimeout(() => rec.onresult && rec.onresult(result('my secret phone 0912345678')), 500) },
    onStop(rec, clock) { clock.setTimeout(() => rec.onend && rec.onend(), 50) },
  })
  const p = x.probe.start(); await adv(x.clock, 5400, 50)
  const r = await p
  const rec = x.SR.instances[0]
  assert.equal(r.status, 'pass'); assert.equal(r.data.chars, 23); assert.equal(r.data.lang, 'zh-TW'); assert.equal(r.data.error, null)
  assert.ok(!JSON.stringify(r).includes('secret') && !JSON.stringify(r).includes('0912'), '結果不含辨識文字')
  assert.ok(x.seen.updates.some((u) => u.text === 'my secret phone 0912345678'), '畫面即時顯示辨識文字（只在畫面上，不進報告）')
  assert.equal(rec.lang, 'zh-TW'); assert.equal(rec.started, 1); assert.equal(rec.stopped, 1); assert.ok(rec.aborted >= 1, '結束一定 abort')
  assert.equal(rec.onresult, null); assert.equal(rec.onend, null); assert.equal(rec.onerror, null); assert.equal(x.clock.pending(), 0)
})

test('語音：沒說話 → needs-action；各種錯誤碼 → fail（含錯誤碼）；不支援 → unsupported；start 丟例外 → fail；一直沒開始 → 逾時 fail', async () => {
  const errs = [['not-allowed', /權限被拒絕/], ['service-not-allowed', /權限被拒絕/], ['audio-capture', /麥克風/], ['network', /雲端/], ['language-not-supported', /語言/], ['some-new-code', /some-new-code/]]
  for (const [code, re] of errs) {
    const x = speechSetup({ onStart(rec, clock) { clock.setTimeout(() => { rec.onerror({ error: code }); rec.onend() }, 20) } })
    const p = x.probe.start(); await adv(x.clock, 1500, 50); const r = await p
    assert.equal(r.status, 'fail', code); assert.match(r.detail, re, code); assert.match(r.detail, new RegExp(code)); assert.equal(r.data.error, code); assert.ok(x.SR.instances[0].aborted >= 1); assert.equal(x.clock.pending(), 0)
  }
  const quiet = speechSetup({ onStart(rec, clock) { clock.setTimeout(() => rec.onstart(), 10) }, onStop(rec, clock) { clock.setTimeout(() => { rec.onerror({ error: 'no-speech' }); rec.onend() }, 20) } })
  const pq = quiet.probe.start(); await adv(quiet.clock, 5500, 50); const q = await pq
  assert.equal(q.status, 'needs-action'); assert.equal(q.data.chars, 0)

  assert.equal((await speechSetup({}, { absent: true }).probe.start()).status, 'unsupported')
  const thrower = speechSetup({ throwOnStart: true }); const t = await thrower.probe.start(); assert.equal(t.status, 'fail'); assert.match(t.detail, /InvalidStateError/); assert.ok(thrower.SR.instances[0].aborted >= 1)
  const never = speechSetup({}); const pn = never.probe.start(); await adv(never.clock, 21000, 500); const n = await pn
  assert.equal(n.status, 'fail'); assert.match(n.detail, /20 秒/); assert.equal(never.clock.pending(), 0)
})

test('語音：stop() 同步 abort 並拔掉 handler，遲到的事件不會再改任何東西；辨識語言由選項決定', async () => {
  const x = speechSetup({ onStart(rec, clock) { clock.setTimeout(() => rec.onstart(), 10) } }, { lang: 'en-US' })
  const p = x.probe.start(); await adv(x.clock, 200, 20)
  const rec = x.SR.instances[0]; assert.equal(rec.lang, 'en-US')
  x.probe.stop(); assert.ok(rec.aborted >= 1); assert.equal(rec.onresult, null); assert.equal(rec.onstart, null)
  const before = x.seen.updates.length
  assert.equal((await p).status, 'skipped'); assert.equal(x.seen.updates.length, before); assert.equal(x.clock.pending(), 0)
})

// ───────────────────────────── Web MIDI ─────────────────────────────
function fakeMidi({ inputs = [], outputs = [], mode = 'ok' } = {}) {
  const mk = (list) => new Map(list.map((p, i) => [String(i), { manufacturer: '', state: 'connected', onmidimessage: null, ...p }]))
  const access = { inputs: mk(inputs), outputs: mk(outputs), onstatechange: null }
  const nav = strict({
    calls: [],
    requestMIDIAccess(o) { nav.calls.push(o); if (mode === 'hang') return new Promise(() => {}); if (mode !== 'ok') { const e = new Error(mode); e.name = mode; return Promise.reject(e) } return Promise.resolve(access) },
  })
  return { nav, access }
}
function midiSetup(o = {}) {
  const clock = makeClock(); const m = fakeMidi(o); const { seen, hooks } = collect()
  const { env } = makeEnv({ nav: o.noApi ? strict({}) : m.nav, win: fakeWin() }, clock)
  return { clock, ...m, seen, probe: D.createProbe('midi', env, hooks) }
}

test('MIDI：列出輸入 / 輸出裝置；收訊息計數（節流、忽略時脈類即時訊息）；裝置熱插拔即時更新；stop 拔掉所有 handler', async () => {
  const x = midiSetup({ inputs: [{ name: 'nanoKONTROL2', manufacturer: 'KORG' }], outputs: [{ name: 'nanoKONTROL2' }] })
  const p = x.probe.start(); await settle()
  assert.deepEqual(x.nav.calls, [{ sysex: false }], '不要 sysex 權限')
  let r = x.seen.results.at(-1); assert.equal(r.status, 'pass'); assert.deepEqual(r.data.inputs, ['nanoKONTROL2']); assert.match(r.detail, /輸入 1 個、輸出 1 個：nanoKONTROL2/)
  assert.equal(x.seen.updates.at(-1).inputs[0].manufacturer, 'KORG')
  const port = [...x.access.inputs.values()][0]
  port.onmidimessage({ data: [0xb0, 7, 64] }); await settle()
  assert.equal(x.seen.results.at(-1).data.messages, 1); assert.match(x.seen.results.at(-1).detail, /已收到 1 則訊息/); assert.equal(x.seen.updates.at(-1).last, 'CC 1:7=64')
  port.onmidimessage({ data: [0xf8] }); port.onmidimessage({ data: [0xfe] }); port.onmidimessage({ data: [0x90, 60, 100] }); port.onmidimessage({ data: [0x80, 60, 0] })
  await adv(x.clock, 200, 20); assert.equal(x.seen.results.at(-1).data.messages, 3, '時脈 / active sensing 不算，其餘節流後合併'); assert.equal(x.seen.updates.at(-1).last, 'Note Off 1:60')
  x.access.inputs.set('9', { name: 'nanoPAD2', manufacturer: 'KORG', state: 'connected', onmidimessage: null }); x.access.onstatechange()
  await adv(x.clock, 200, 20); assert.equal(typeof x.access.inputs.get('9').onmidimessage, 'function', '新接上的裝置也被監聽'); assert.deepEqual(x.seen.results.at(-1).data.inputs, ['nanoKONTROL2', 'nanoPAD2'])
  x.probe.stop()
  assert.equal(x.access.onstatechange, null); assert.ok([...x.access.inputs.values()].every((i) => i.onmidimessage === null)); assert.equal(x.clock.pending(), 0)
  assert.equal((await p).status, 'pass')
})

test('MIDI：沒有裝置 → needs-action；權限被拒 → fail；逾時 fail；沒有 API → unsupported', async () => {
  const none = midiSetup(); const pn = none.probe.start(); await settle(); assert.equal(none.seen.results.at(-1).status, 'needs-action'); none.probe.stop(); await pn
  for (const name of ['SecurityError', 'NotAllowedError']) { const d = midiSetup({ mode: name }); const r = await d.probe.start(); assert.equal(r.status, 'fail'); assert.match(r.detail, /MIDI 權限被拒絕/) }
  const other = midiSetup({ mode: 'InvalidStateError' }); assert.match((await other.probe.start()).detail, /InvalidStateError/)
  const hang = midiSetup({ mode: 'hang' }); const ph = hang.probe.start(); await adv(hang.clock, 31000, 1000); const t = await ph; assert.equal(t.status, 'fail'); assert.match(t.detail, /30 秒/); assert.equal(hang.clock.pending(), 0)
  assert.equal((await midiSetup({ noApi: true }).probe.start()).status, 'unsupported')
})

// ───────────────────────────── 手把 ─────────────────────────────
function fakePad(o = {}) {
  const calls = [], resets = []
  const pad = {
    index: 0, id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 02fd)', mapping: 'standard', connected: true,
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0],
    vibrationActuator: { calls, resets, playEffect(type, params) { calls.push({ type, params }); return Promise.resolve(o.effect ?? 'complete') }, reset() { resets.push(1); return Promise.resolve() } },
    ...o.over,
  }
  if (pad.vibrationActuator) strict(pad.vibrationActuator, 'vibrationActuator')
  return pad
}
function padSetup(getPads, id = 'gamepad') {
  const clock = makeClock(); const win = fakeWin(); const { seen, hooks } = collect()
  const { env } = makeEnv({ nav: strict({ getGamepads: () => getPads() }), win }, clock)
  return { clock, win, seen, probe: D.createProbe(id, env, hooks) }
}

test('手把：沒有手把 → needs-action；接上後（事件 + 輪詢）列出 buttons / axes 即時值；按鍵 → 有輸入；stop 停輪詢並拔監聽', async () => {
  let pads = [null, null]
  const x = padSetup(() => pads)
  const p = x.probe.start(); await adv(x.clock, 200, 40)
  assert.equal(x.seen.results.at(-1).status, 'needs-action')
  const pad = fakePad(); pads = [pad, null]
  x.win.dispatch('gamepadconnected', { gamepad: pad }); await settle()
  let r = x.seen.results.at(-1); assert.equal(r.status, 'pass'); assert.equal(r.data.count, 1); assert.equal(r.data.pads[0].buttons, 17); assert.equal(r.data.pads[0].axes, 4); assert.equal(r.data.pads[0].rumble, true); assert.match(r.detail, /Xbox/); assert.match(r.detail, /還沒收到按鍵輸入/)
  await adv(x.clock, 200, 40)
  const live = x.seen.updates.at(-1).pads[0]; assert.equal(live.buttons.length, 17); assert.equal(live.axes.length, 4); assert.equal(live.buttons[0].pressed, false)
  const n0 = x.seen.updates.length; await adv(x.clock, 1000, 40); assert.equal(x.seen.updates.length, n0, '數值沒變就不通知畫面重繪')
  pad.buttons[0] = { pressed: true, value: 1 }; pad.axes[1] = -0.8
  await adv(x.clock, 300, 40)
  r = x.seen.results.at(-1); assert.match(r.detail, /已收到按鍵或搖桿輸入/); assert.equal(x.seen.updates.at(-1).pads[0].buttons[0].pressed, true); assert.equal(x.seen.updates.at(-1).pads[0].axes[1], -0.8)
  x.probe.stop()
  assert.equal(x.clock.pending(), 0, '輪詢停了'); assert.equal(x.win.listenerCount(), 0, '事件監聽拔掉了'); assert.equal((await p).status, 'pass')
})

test('手把：getGamepads 丟例外 → fail 並結束；斷線後結果回到 needs-action', async () => {
  const bad = padSetup(() => { throw new Error('SecurityError') }); const r = await bad.probe.start(); assert.equal(r.status, 'fail'); assert.equal(bad.win.listenerCount(), 0); assert.equal(bad.clock.pending(), 0)
  let pads = [fakePad()]; const x = padSetup(() => pads); const p = x.probe.start(); await adv(x.clock, 200, 40); assert.equal(x.seen.results.at(-1).status, 'pass')
  pads = [Object.assign(fakePad(), { connected: false })]; await adv(x.clock, 200, 40); assert.equal(x.seen.results.at(-1).status, 'needs-action'); x.probe.stop(); await p
  assert.equal((await D.createProbe('gamepad', makeEnv({ nav: strict({}) }).env).start()).status, 'unsupported')
})

test('手把震動：complete → pass；preempted → fail；沒有 actuator → unsupported；沒有手把 → needs-action；例外 / 逾時 → fail；Firefox hapticActuators 備援', async () => {
  const ok = fakePad(); const x = padSetup(() => [ok], 'rumble'); const r = await x.probe.start()
  assert.equal(r.status, 'pass'); assert.equal(r.data.actuator, true); assert.deepEqual(ok.vibrationActuator.calls[0], { type: 'dual-rumble', params: { startDelay: 0, duration: 400, weakMagnitude: 0.6, strongMagnitude: 0.6 } }); assert.equal(ok.vibrationActuator.resets.length, 1, '結束 reset actuator')
  const pre = padSetup(() => [fakePad({ effect: 'preempted' })], 'rumble'); const pr = await pre.probe.start(); assert.equal(pr.status, 'fail'); assert.match(pr.detail, /preempted/)
  const none = padSetup(() => [fakePad({ over: { vibrationActuator: undefined } })], 'rumble'); const n = await none.probe.start(); assert.equal(n.status, 'unsupported'); assert.equal(n.data.actuator, false)
  assert.equal((await padSetup(() => [], 'rumble').probe.start()).status, 'needs-action')
  const boom = fakePad(); boom.vibrationActuator.playEffect = function () { throw new Error('boom') }
  assert.equal((await padSetup(() => [boom], 'rumble').probe.start()).status, 'fail')
  const hangPad = fakePad(); hangPad.vibrationActuator.playEffect = function () { return new Promise(() => {}) }
  const h = padSetup(() => [hangPad], 'rumble'); const ph = h.probe.start(); await adv(h.clock, 3500, 250); assert.equal((await ph).status, 'fail'); assert.equal(h.clock.pending(), 0)
  const pulses = []; const fx = fakePad({ over: { vibrationActuator: undefined, hapticActuators: [{ pulse(v, d) { pulses.push([v, d]); return Promise.resolve(true) } }] } })
  assert.equal((await padSetup(() => [fx], 'rumble').probe.start()).status, 'pass'); assert.deepEqual(pulses, [[0.6, 400]])
  assert.equal((await D.createProbe('rumble', makeEnv({ nav: strict({}) }).env).start()).status, 'unsupported')
})

// ───────────────────────────── 手機震動 / 使用者判斷 ─────────────────────────────
test('手機震動：送出節奏 → 待操作（vibrate 回傳 true 只代表已送出）；使用者回答是 → pass、否 → fail；被擋 → fail；沒有 → unsupported', async () => {
  const clock = makeClock(); const vibs = []
  const { env } = makeEnv({ nav: strict({ vibrate(p) { vibs.push(p); return true } }) }, clock)
  const { seen, hooks } = collect(); const probe = D.createProbe('vibrate', env, hooks)
  const p = probe.start(); assert.deepEqual(vibs[0], [200, 100, 200, 100, 400], '在點擊事件內同步送出')
  await adv(clock, 1100, 50); const r = await p
  assert.equal(r.status, 'needs-action'); assert.equal(r.data.sent, true); assert.equal(seen.results[0].status, 'needs-action', '震動進行中就可以回答')
  const chk = D.getCheck('vibrate')
  const yes = D.applyVerdict(chk, r, 'ok'); assert.equal(yes.status, 'pass'); assert.equal(yes.verdict, 'ok'); assert.match(yes.detail, /使用者確認：有感覺到震動/)
  const no = D.applyVerdict(chk, r, 'bad'); assert.equal(no.status, 'fail'); assert.equal(no.verdict, 'bad'); assert.match(no.detail, /沒有感覺到震動/)
  assert.equal(D.applyVerdict(chk, r, null), r); assert.equal(D.applyVerdict(chk, r, 'maybe'), r); assert.equal(D.applyVerdict(D.getCheck('rumble'), r, 'ok'), r, '沒有判斷按鈕的檢查不套用')
  const un = { ...r, status: 'unsupported' }; assert.equal(D.applyVerdict(chk, un, 'ok').status, 'unsupported', '技術上不支援時，使用者的判斷不能把它變成通過')
  assert.equal(clock.pending(), 0)

  const blocked = makeEnv({ nav: strict({ vibrate() { return false } }) }).env; const b = await D.createProbe('vibrate', blocked).start(); assert.equal(b.status, 'fail'); assert.match(b.detail, /false/)
  const thrower = makeEnv({ nav: strict({ vibrate() { throw new Error('x') } }) }).env; assert.equal((await D.createProbe('vibrate', thrower).start()).status, 'fail')
  assert.equal((await D.createProbe('vibrate', makeEnv({ nav: strict({}) }).env).start()).status, 'unsupported')
})

test('相機 / 全螢幕的「正常 / 不正常」：正常維持通過並附註記；不正常 → 失敗；判斷存在報告的 verdict 欄位', () => {
  const cam = D.getCheck('cam'), r = D.makeResult(cam, { status: 'pass', msg: 'x' }, 5)
  assert.equal(D.applyVerdict(cam, r, 'ok').status, 'pass'); assert.match(D.applyVerdict(cam, r, 'ok').detail, /畫面正常/)
  const bad = D.applyVerdict(cam, r, 'bad'); assert.equal(bad.status, 'fail'); assert.equal(bad.verdict, 'bad'); assert.match(bad.detail, /畫面不正常/)
  assert.equal(D.applyVerdict(D.getCheck('fullscreen'), D.makeResult(D.getCheck('fullscreen'), { status: 'pass', msg: 'x' }, 0), 'bad').status, 'fail')
  assert.equal(D.applyVerdict(cam, undefined, 'ok'), undefined)
  assert.ok(D.getCheck('vibrate').verdict.required && !cam.verdict.required)
  const rep = D.buildReport({ results: { cam: bad } }); assert.equal(rep.json.results.find((x) => x.id === 'cam').verdict, 'bad')
})

// ───────────────────────────── 觸控筆與觸控 ─────────────────────────────
test('觸控筆與觸控：tracker 記錄類型 / 壓力 / 傾斜 / 指數；只有偵測到 pen 才 pass；reset 歸零', () => {
  const tr = D.createPointerTracker()
  assert.equal(D.pointerOutcome(tr.snapshot()).status, 'needs-action'); assert.match(D.fmtMsg(D.pointerOutcome(tr.snapshot()).msg), /還沒收到任何輸入/)
  tr.handle('move', { pointerId: 1, pointerType: 'mouse', pressure: 0 })
  tr.handle('down', { pointerId: 2, pointerType: 'touch', pressure: 0.5, width: 20, height: 22 }); tr.handle('down', { pointerId: 3, pointerType: 'touch', pressure: 0.5 }); tr.handle('up', { pointerId: 2, pointerType: 'touch' })
  let o = D.pointerOutcome(tr.snapshot())
  assert.equal(o.status, 'needs-action'); assert.equal(o.data.maxTouches, 2); assert.equal(o.data.pen, false); assert.match(D.fmtMsg(o.msg), /滑鼠輸入 · 觸控輸入（最多 2 指）/)
  assert.deepEqual(tr.snapshot().last, { pointerType: 'touch', pressure: null, tiltX: null, tiltY: null, width: null, height: null })
  tr.handle('move', { pointerId: 9, pointerType: 'pen', pressure: 0.1, tiltX: 20, tiltY: -5, width: 1, height: 1 })
  tr.handle('move', { pointerId: 9, pointerType: 'pen', pressure: 0.4, tiltX: 20, tiltY: -5 }); tr.handle('move', { pointerId: 9, pointerType: 'pen', pressure: 0.71 })
  o = D.pointerOutcome(tr.snapshot())
  assert.equal(o.status, 'pass'); assert.equal(o.data.pen, true); assert.equal(o.data.penPressureMax, 0.71); assert.equal(o.data.penPressureVaries, true); assert.equal(o.data.penTilt, true); assert.match(D.fmtMsg(o.msg), /偵測到觸控筆/)
  tr.handle('cancel', { pointerId: 9, pointerType: 'pen' }); assert.equal(tr.snapshot().active, 2, '滑鼠 hover 與另一指仍在')
  assert.doesNotThrow(() => tr.handle('move', null)); assert.doesNotThrow(() => tr.handle('move', { pointerId: 5, pointerType: 'stylus?' }))
  tr.reset(); assert.equal(D.pointerOutcome(tr.snapshot()).status, 'needs-action'); assert.equal(tr.snapshot().last, null)
  const flat = D.createPointerTracker(); flat.handle('move', { pointerId: 1, pointerType: 'pen', pressure: 0.5, tiltX: 0, tiltY: 0 })
  const fo = D.pointerOutcome(flat.snapshot()); assert.equal(fo.status, 'pass'); assert.equal(fo.data.penTilt, false); assert.equal(fo.data.penPressureVaries, false)
})

// ───────────────────────────── 螢幕 / 彈出視窗 ─────────────────────────────
test('螢幕清單：2 個 → pass；只有 1 個 → needs-action；權限被拒 / 逾時 → fail；沒有 API → unsupported；報告不含螢幕名稱', async () => {
  const two = { screens: [{ width: 1920, height: 1080, isPrimary: true, isInternal: true, devicePixelRatio: 2, label: 'Built-in Retina (Alice)' }, { width: 3840, height: 2160, isPrimary: false, isInternal: false, devicePixelRatio: 1, label: "Alice's EPSON" }] }
  const mk = (getScreenDetails) => makeEnv({ win: fakeWin({ getScreenDetails }) })
  const a = mk(() => Promise.resolve(two)); const { seen, hooks } = collect()
  const r = await D.createProbe('screens', a.env, hooks).start()
  assert.equal(r.status, 'pass'); assert.equal(r.data.count, 2); assert.equal(r.data.screens[1].internal, false); assert.match(r.detail, /偵測到 2 個螢幕：1920×1080（主要顯示器） · 3840×2160（外接顯示器）/)
  assert.equal(seen.updates[0].screens.length, 2); assert.ok(!JSON.stringify(r).includes('Alice'), '不含螢幕 label')
  const one = await D.createProbe('screens', mk(() => Promise.resolve({ screens: [two.screens[0]] })).env).start(); assert.equal(one.status, 'needs-action'); assert.match(one.detail, /只偵測到 1 個螢幕/)
  const den = await D.createProbe('screens', mk(() => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }))).env).start(); assert.equal(den.status, 'fail'); assert.match(den.detail, /視窗管理/)
  assert.equal((await D.createProbe('screens', mk(() => Promise.reject(new Error('weird'))).env).start()).status, 'fail')
  assert.equal((await D.createProbe('screens', mk(() => Promise.resolve({ screens: [] })).env).start()).status, 'fail')
  const clock = makeClock(); const h = makeEnv({ win: fakeWin({ getScreenDetails: () => new Promise(() => {}) }) }, clock); const p = D.createProbe('screens', h.env).start(); await adv(clock, 31000, 1000)
  assert.equal((await p).status, 'fail'); assert.equal(clock.pending(), 0)
  assert.equal((await D.createProbe('screens', makeEnv({ win: fakeWin() }).env).start()).status, 'unsupported')
})

test('彈出視窗：可開啟 → pass 並立刻關閉；被封鎖（回傳 null）→ fail；丟例外 → fail；沒有 window.open → unsupported', async () => {
  const opened = []
  const w = fakeWin({ open(url, name, features) { const child = strict({ closed: false, close() { child.closed = true } }); opened.push({ url, name, features, child }); return child } })
  const r = await D.createProbe('popup', makeEnv({ win: w }).env).start()
  assert.equal(r.status, 'pass'); assert.equal(opened.length, 1); assert.equal(opened[0].child.closed, true); assert.equal(opened[0].url, 'about:blank'); assert.match(opened[0].features, /popup/)
  const blocked = await D.createProbe('popup', makeEnv({ win: fakeWin({ open() { return null } }) }).env).start(); assert.equal(blocked.status, 'fail'); assert.equal(blocked.data.blocked, true)
  assert.equal((await D.createProbe('popup', makeEnv({ win: fakeWin({ open() { throw new Error('x') } }) }).env).start()).status, 'fail')
  assert.equal((await D.createProbe('popup', makeEnv({ win: fakeWin() }).env).start()).status, 'unsupported')
})

// ───────────────────────────── 方向 / 動作感測器 ─────────────────────────────
function iosCtor(name, log, answer = 'granted') {
  const C = function () {}
  Object.defineProperty(C, 'name', { value: name })
  C.requestPermission = function () { if (this !== C) throw new TypeError('Illegal invocation: ' + name + '.requestPermission'); log.push(name); return typeof answer === 'function' ? answer() : Promise.resolve(answer) }
  return C
}
function orientSetup(o = {}) {
  const clock = makeClock(); const log = []
  const win = fakeWin({ DeviceOrientationEvent: o.noEvents ? undefined : (o.ios ? iosCtor('DeviceOrientationEvent', log, o.answer) : function DeviceOrientationEvent() {}), DeviceMotionEvent: o.noEvents ? undefined : (o.ios ? iosCtor('DeviceMotionEvent', log, o.answer) : function DeviceMotionEvent() {}) })
  const { seen, hooks } = collect()
  const { env } = makeEnv({ win }, clock)
  return { clock, win, log, seen, probe: D.createProbe('orient', env, hooks) }
}

test('方向 / 動作感測器：iOS 的 requestPermission 在點擊內同步呼叫；有數值 → pass 並持續回報；stop 拔掉監聽', async () => {
  const x = orientSetup({ ios: true })
  const p = x.probe.start()
  assert.deepEqual(x.log, ['DeviceOrientationEvent', 'DeviceMotionEvent'], '第一個 await 之前就要請求權限（iOS 只認手勢內的呼叫）')
  await settle(); assert.equal(x.win.listenerCount(), 2)
  x.win.dispatch('deviceorientation', { alpha: 10, beta: 20.5, gamma: -30 }); x.win.dispatch('devicemotion', { accelerationIncludingGravity: { x: 0.1, y: 9.8, z: 0.2 } }); await settle()
  const r = x.seen.results.at(-1)
  assert.equal(r.status, 'pass'); assert.equal(r.data.orientation, true); assert.equal(r.data.motion, true); assert.match(r.detail, /方向 感測器有數值/)
  assert.deepEqual(x.seen.updates.find((u) => u.orient).orient, { alpha: 10, beta: 20.5, gamma: -30 })
  await adv(x.clock, 150, 50); assert.deepEqual(x.seen.updates.find((u) => u.motion).motion, { x: 0.1, y: 9.8, z: 0.2 }, '高頻事件節流合併後才送出')
  x.probe.stop(); assert.equal(x.win.listenerCount(), 0); assert.equal((await p).status, 'pass'); assert.equal(x.clock.pending(), 0)
})

test('方向 / 動作感測器：權限被拒 → fail；requestPermission 丟例外 → fail；只有空值事件 → unsupported；完全沒事件 → fail；沒有 API → unsupported', async () => {
  const denied = orientSetup({ ios: true, answer: 'denied' }); const d = await denied.probe.start(); assert.equal(d.status, 'fail'); assert.equal(d.data.permission, 'denied'); assert.equal(denied.win.listenerCount(), 0)
  const err = orientSetup({ ios: true, answer: () => Promise.reject(Object.assign(new Error('needs gesture'), { name: 'NotAllowedError' })) }); const e = await err.probe.start(); assert.equal(e.status, 'fail'); assert.match(e.detail, /NotAllowedError/)
  const nulls = orientSetup(); const pn = nulls.probe.start(); await settle(); nulls.win.dispatch('deviceorientation', { alpha: null, beta: null, gamma: null }); await adv(nulls.clock, 3200, 100)
  const n = await pn; assert.equal(n.status, 'unsupported'); assert.match(n.detail, /沒有數值/); assert.equal(nulls.win.listenerCount(), 0)
  const silent = orientSetup(); const ps = silent.probe.start(); await adv(silent.clock, 3200, 100); const s = await ps; assert.equal(s.status, 'fail'); assert.match(s.detail, /3 秒/)
  assert.equal((await orientSetup({ noEvents: true }).probe.start()).status, 'unsupported')
  const cancelled = orientSetup(); const pc = cancelled.probe.start(); await settle(); cancelled.probe.stop(); assert.equal(cancelled.win.listenerCount(), 0); assert.equal((await pc).status, 'skipped')
})

// ───────────────────────────── 全螢幕 ─────────────────────────────
function fsDoc(o = {}) {
  const ls = new Map()
  const fire = () => { for (const f of [...(ls.get('fullscreenchange') || [])]) f() }
  const doc = {
    fullscreenEnabled: o.enabled !== false, fullscreenElement: o.already ? {} : null, exits: 0,
    addEventListener(t, f) { if (!ls.has(t)) ls.set(t, new Set()); ls.get(t).add(f) },
    removeEventListener(t, f) { const s = ls.get(t); if (s) s.delete(f) },
    exitFullscreen() { doc.exits++; doc.fullscreenElement = null; fire(); return Promise.resolve() },
    listenerCount() { let n = 0; for (const s of ls.values()) n += s.size; return n },
    documentElement: {
      requestFullscreen() {
        if (o.reject) return Promise.reject(Object.assign(new Error('Permissions check failed'), { name: 'TypeError' }))
        if (!o.never) { doc.fullscreenElement = doc.documentElement; fire() }
        return Promise.resolve()
      },
    },
  }
  return strict(doc, 'document')
}
function fsSetup(o = {}) {
  const clock = makeClock(); const doc = o.noApi ? strict({ documentElement: {} }) : fsDoc(o); const { seen, hooks } = collect()
  const { env } = makeEnv({ doc }, clock)
  return { clock, doc, seen, probe: D.createProbe('fullscreen', env, hooks) }
}

test('全螢幕：進入 → 停留 → 離開都成功 → pass；監聽都拔掉', async () => {
  const x = fsSetup(); const p = x.probe.start(); await settle()
  assert.ok(x.doc.fullscreenElement, '已進入'); assert.ok(x.seen.updates.some((u) => u.fullscreen === true))
  await adv(x.clock, 1500, 50)
  const r = await p; assert.equal(r.status, 'pass'); assert.equal(x.doc.fullscreenElement, null); assert.equal(x.doc.exits, 1); assert.equal(x.doc.listenerCount(), 0); assert.equal(x.clock.pending(), 0)
  assert.ok(x.seen.updates.some((u) => u.fullscreen === false))
})

test('全螢幕：停留中按停止 / 離開頁面 → 立刻退出全螢幕；被拒 / 沒進入 → fail；已在全螢幕 → needs-action；政策停用 / 沒有 API', async () => {
  const x = fsSetup(); const p = x.probe.start(); await adv(x.clock, 300, 50)
  assert.ok(x.doc.fullscreenElement); x.probe.stop()
  assert.equal(x.doc.fullscreenElement, null, '同步退出全螢幕'); assert.equal(x.doc.listenerCount(), 0); assert.equal((await p).status, 'skipped'); assert.equal(x.clock.pending(), 0)

  const rej = await fsSetup({ reject: true }).probe.start(); assert.equal(rej.status, 'fail'); assert.match(rej.detail, /TypeError/)
  const never = fsSetup({ never: true }); const pn = never.probe.start(); await adv(never.clock, 3500, 100); const n = await pn
  assert.equal(n.status, 'fail'); assert.match(n.detail, /沒有進入全螢幕/); assert.equal(never.doc.listenerCount(), 0); assert.equal(never.clock.pending(), 0)
  assert.equal((await fsSetup({ already: true }).probe.start()).status, 'needs-action')
  assert.equal((await fsSetup({ enabled: false }).probe.start()).status, 'fail')
  assert.equal((await fsSetup({ noApi: true }).probe.start()).status, 'unsupported')
})

// ───────────────────────────── 報告 ─────────────────────────────
test('collectMeta：時間 / 網址（去掉 #hash）/ UA / 螢幕；不含 IP 與連線碼', async () => {
  const x = fullEnv(); const now = Date.UTC(2026, 8, 20, 6, 30, 0)
  const m = D.collectMeta(x.env, now)
  assert.equal(m.generatedAt, '2026-09-20T06:30:00.000Z'); assert.equal(m.url, 'https://midisea.shyetech.com/?diagnostics=1'); assert.ok(!m.url.includes('remote'))
  assert.equal(m.userAgent, 'FakeUA/1.0 (Test)'); assert.equal(m.timeZone, 'Asia/Taipei'); assert.equal(m.screen.width, 1920); assert.equal(m.screen.dpr, 2)
  assert.doesNotThrow(() => D.collectMeta({}, now)); assert.equal(D.collectMeta({}, now).url, '')
})

test('報告：Markdown 表格 + JSON；規格欄位齊全；沒跑的項目標示尚未測；表格內的 | 與換行被跳脫', async () => {
  const x = fullEnv(); const p = D.runAutoChecks(x.env); await adv(x.clock, 8000, 50); const out = await p
  const results = Object.fromEntries(out.map((r) => [r.id, r]))
  results.ls = { ...results.ls, detail: 'a|b\nc', msg: undefined }
  const rep = D.buildReport({ results, meta: D.collectMeta(x.env, Date.UTC(2026, 8, 20)) })
  assert.equal(rep.json.results.length, D.getChecks().length); assert.equal(rep.json.summary.total, 40)
  assert.equal(rep.json.summary.pass + rep.json.summary.fail + rep.json.summary.unsupported + rep.json.summary.pending, 40)
  assert.equal(rep.json.summary.pass, 25); assert.equal(rep.json.summary.pending, 15)
  const row = rep.json.results.find((r) => r.id === 'gl'); assert.deepEqual(Object.keys(row).slice(0, 6), ['id', 'group', 'title', 'status', 'detail', 'ms']); assert.equal(row.status, 'pass'); assert.equal(row.title, 'WebGL 圖形')
  assert.equal(rep.json.results.find((r) => r.id === 'cam').status, 'not-run'); assert.equal(rep.json.results.find((r) => r.id === 'cam').ms, null)
  for (const k of ['app', 'version', 'generatedAt', 'url', 'userAgent', 'screen', 'summary', 'results', 'locale']) assert.ok(k in rep.json, k)
  const lines = rep.markdown.split('\n')
  assert.equal(lines[0], '# MidiSea 裝置診斷報告'); assert.ok(lines.some((l) => l === '| 群組 | 項目 | 狀態 | 詳情 | 耗時 (ms) |')); assert.ok(lines.some((l) => l === '| --- | --- | --- | --- | ---: |'))
  assert.ok(lines.some((l) => /^- 產生時間：2026-09-20T00:00:00\.000Z$/.test(l))); assert.ok(lines.some((l) => /^- 摘要：通過 25、失敗 0、不支援 0、尚未測 15（共 40 項）$/.test(l)))
  assert.equal(lines.filter((l) => l.startsWith('| ')).length, 40 + 2, '每項一列 + 表頭 + 分隔線')
  const lsRow = lines.find((l) => l.includes('localStorage 讀寫')); assert.match(lsRow, /a\\\|b c/); assert.match(lines.find((l) => l.includes('相機（視訊預覽）')), /尚未測/)
  const m = rep.text.match(/```json\n([\s\S]*)\n```\n$/); assert.ok(m, '文字尾端有 JSON 區塊'); assert.deepEqual(JSON.parse(m[1]), JSON.parse(JSON.stringify(rep.json)))
  assert.ok(rep.text.startsWith(rep.markdown))
})

test('報告：不含個資 / IP / 影像 / 音訊——相機與螢幕名稱、語音文字、連線碼都不會出現', async () => {
  const cam = camSetup(); const pc = cam.probe.start(); await adv(cam.clock, 2500, 33); cam.probe.stop(); const camR = await pc
  const sp = speechSetup({ onStart(rec, clock) { clock.setTimeout(() => rec.onstart(), 10); clock.setTimeout(() => rec.onresult(result('call me at 0912345678 or alice@example.com')), 300) }, onStop(rec, clock) { clock.setTimeout(() => rec.onend(), 30) } })
  const ps = sp.probe.start(); await adv(sp.clock, 5400, 50); const spR = await ps
  const scr = await D.createProbe('screens', makeEnv({ win: fakeWin({ getScreenDetails: () => Promise.resolve({ screens: [{ width: 1, height: 1, label: 'Alice-MacBook display', isPrimary: true }, { width: 2, height: 2, label: "Bob's TV", isPrimary: false }] }) }) }).env).start()
  const meta = D.collectMeta(fullEnv().env, 0)
  const rep = D.buildReport({ results: { cam: camR, speech: spR, screens: scr }, meta })
  for (const secret of ['Alice', 'Bob', '0912345678', 'alice@example', 'remote=', 'abc123', '192.168']) assert.ok(!rep.text.includes(secret), '報告不該包含：' + secret)
  const chars = Array.from('call me at 0912345678 or alice@example.com'.replace(/\s+/g, '')).length
  assert.ok(rep.text.includes('"chars": ' + chars)); assert.equal(rep.json.results.find((r) => r.id === 'speech').data.chars, chars)
})

test('報告的隱私範圍（README 與實作一致）：Web MIDI 埠名稱與手把的 id 字串會照實列出（判讀有沒有偵測到控制器用）；相機 / 螢幕 label、語音內容仍然不收', async () => {
  const mi = midiSetup({ inputs: [{ name: "Cas's iPad Bluetooth MIDI" }, { name: 'nanoKONTROL2', manufacturer: 'KORG' }], outputs: [{ name: 'nanoKONTROL2' }] })
  const pm = mi.probe.start(); await settle(); mi.probe.stop(); const midiR = await pm
  const pd = padSetup(() => [fakePad({ over: { id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)' } })])
  const pp = pd.probe.start(); await adv(pd.clock, 200, 40); pd.probe.stop(); const padR = await pp
  const scr = await D.createProbe('screens', makeEnv({ win: fakeWin({ getScreenDetails: () => Promise.resolve({ screens: [{ width: 1, height: 1, label: 'Alice-MacBook display', isPrimary: true }] }) }) }).env, collect().hooks).start()
  const rep = D.buildReport({ results: { midi: midiR, gamepad: padR, screens: scr }, meta: {} })
  for (const shown of ["Cas's iPad Bluetooth MIDI", 'nanoKONTROL2', 'Xbox Wireless Controller']) assert.ok(rep.text.includes(shown), `報告會列出：${shown}`)
  assert.deepEqual(rep.json.results.find((r) => r.id === 'midi').data.inputs, ["Cas's iPad Bluetooth MIDI", 'nanoKONTROL2'])
  assert.ok(rep.json.results.find((r) => r.id === 'gamepad').data.pads[0].id.includes('Xbox Wireless Controller'))
  assert.ok(!rep.text.includes('Alice'), '螢幕 label 不收')
  // 文件如實說明這個例外（以前寫「不含裝置名稱」）
  const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8')
  const zh = read('../../README.md'), en = read('../../README.en.md')
  assert.doesNotMatch(zh, /影像、音訊或裝置名稱/); assert.doesNotMatch(en, /audio or device names/)
  assert.match(zh, /Web MIDI 埠名稱與手把(的)?型號字串會照實列出/); assert.match(en, /Web MIDI port names and gamepad id strings/)
  assert.match(read('./diagnostics.js'), /Web MIDI 埠名稱與手把的 id 字串會照實列出/)
})

test('報告：切成英文後標題 / 狀態 / 詳情都是英文；中文模式輸出不變', () => {
  const results = { ls: D.makeResult(D.getCheck('ls'), { status: 'pass', msg: { key: '寫入、讀回、刪除都成功' } }, 4) }
  const zh = D.buildReport({ results, meta: {} }).markdown
  registerEn(en); registerEn(en2); setLocale('en')
  try {
    const rep = D.buildReport({ results, meta: {}, locale: 'en' })
    assert.match(rep.markdown, /^# MidiSea device diagnostics report/); assert.match(rep.markdown, /\| Group \| Check \| Status \| Details \| Time \(ms\) \|/)
    assert.match(rep.markdown, /localStorage read\/write \| Passed \| Write, read back and delete all succeeded \| 4 \|/); assert.match(rep.markdown, /Not tested/); assert.equal(rep.json.locale, 'en')
    assert.ok(!/[㐀-鿿]/.test(rep.markdown), '英文報告沒有中文殘留：' + (rep.markdown.match(/.*[㐀-鿿].*/) || [''])[0])
  } finally { setLocale('zh') }
  assert.equal(D.buildReport({ results, meta: {} }).markdown, zh)
})

test('reportFileName：本地時間 YYYYMMDD-HHMMSS', () => {
  assert.equal(D.reportFileName(new Date(2026, 8, 20, 14, 5, 9).getTime()), 'midisea-diagnostics-20260920-140509.json')
  assert.match(D.reportFileName(), /^midisea-diagnostics-\d{8}-\d{6}\.json$/)
})

test('copyText：Clipboard API；被拒 → 退回 execCommand（用完移除 textarea）；都不行 → ok:false', async () => {
  const written = []
  const nav = strict({ clipboard: { writeText(t) { written.push(t); return Promise.resolve() } } })
  assert.deepEqual(await D.copyText('報告', { nav }), { ok: true, method: 'clipboard' }); assert.deepEqual(written, ['報告'])
  const body = { children: [], appendChild(n) { body.children.push(n) }, removeChild(n) { body.children = body.children.filter((c) => c !== n) } }; strict(body)
  const cmds = []
  const doc = strict({ body, createElement() { const ta = { value: '', attrs: {}, style: {}, selected: 0, setAttribute(k, v) { ta.attrs[k] = v }, select() { ta.selected++ }, setSelectionRange() {} }; return strict(ta) }, execCommand(c) { cmds.push(c); return true } })
  const denied = strict({ clipboard: { writeText() { return Promise.reject(new Error('NotAllowedError')) } } })
  assert.deepEqual(await D.copyText('abc', { nav: denied, doc }), { ok: true, method: 'execCommand' }); assert.deepEqual(cmds, ['copy']); assert.equal(body.children.length, 0, 'textarea 已移除')
  assert.deepEqual(await D.copyText('abc', { nav: {}, doc }), { ok: true, method: 'execCommand' })
  const failing = strict({ body, createElement: doc.createElement, execCommand() { return false } })
  assert.deepEqual(await D.copyText('abc', { nav: denied, doc: failing }), { ok: false, method: null }); assert.equal(body.children.length, 0)
  assert.deepEqual(await D.copyText('abc', {}), { ok: false, method: null }); assert.deepEqual(await D.copyText('abc', null), { ok: false, method: null })
})

test('downloadText：建立 object URL、點擊隱藏連結、10 秒後（或 revoke()）釋放；缺 API → ok:false', () => {
  const clock = makeClock(); const made = [], revoked = [], clicked = []
  const URLc = strict({ createObjectURL(b) { made.push(b); return 'blob:x' + made.length }, revokeObjectURL(u) { revoked.push(u) } })
  function BlobC(parts, o) { this.parts = parts; this.type = o.type }
  const body = strict({ children: [], appendChild(n) { body.children.push(n) }, removeChild(n) { body.children = body.children.filter((c) => c !== n) } })
  const doc = strict({ body, createElement() { const a = { style: {}, click() { clicked.push({ href: a.href, download: a.download }) } }; return strict(a) } })
  const { env } = makeEnv({ doc, URL: URLc, Blob: BlobC }, clock)
  const r = D.downloadText('{"a":1}', 'x.json', env)
  assert.equal(r.ok, true); assert.deepEqual(clicked, [{ href: 'blob:x1', download: 'x.json' }]); assert.equal(made[0].type, 'application/json'); assert.deepEqual(made[0].parts, ['{"a":1}']); assert.equal(body.children.length, 0)
  clock.advance(9999); assert.deepEqual(revoked, []); clock.advance(1); assert.deepEqual(revoked, ['blob:x1']); assert.equal(clock.pending(), 0)
  const r2 = D.downloadText('x', 'y.json', env); r2.revoke(); assert.deepEqual(revoked, ['blob:x1', 'blob:x2'], 'revoke() 立刻釋放'); assert.equal(clock.pending(), 0); r2.revoke(); assert.equal(revoked.length, 2, '重複呼叫無害')
  assert.equal(D.downloadText('x', 'y', { doc }).ok, false); assert.equal(D.downloadText('x', 'y', null).ok, false)
  const boom = strict({ createObjectURL() { throw new Error('x') }, revokeObjectURL() {} })
  assert.equal(D.downloadText('x', 'y', { ...env, URL: boom }).ok, false)
})

// ───────────────────────────── 摘要（localStorage）─────────────────────────────
test('摘要：存成 { at, pass, fail, unsupported, pending, total }；讀回時壞資料 → null；儲存丟例外不會炸', () => {
  const mem = {}
  const storage = { get: (k) => (k in mem ? mem[k] : null), set: (k, v) => { mem[k] = v } }
  assert.equal(DIAG_LS_KEY, 'ixd2026.diag'); assert.equal(loadSummary(storage), null)
  const saved = saveSummary({ pass: 20, fail: 2, unsupported: 3, pending: 12, total: 37 }, 1758000000000, storage)
  assert.deepEqual(saved, { at: 1758000000000, pass: 20, fail: 2, unsupported: 3, pending: 12, total: 37 }); assert.deepEqual(mem['ixd2026.diag'], saved); assert.deepEqual(loadSummary(storage), saved)
  for (const bad of [null, 'x', {}, { at: 'now', pass: 1, fail: 1 }, { at: 1, pass: -1, fail: 0 }, { at: 1, pass: 1 }, { at: 0, pass: 1, fail: 1 }, [], 5]) assert.equal(sanitizeSummary(bad), null)
  assert.deepEqual(sanitizeSummary({ at: 5, pass: 1.9, fail: 2 }), { at: 5, pass: 1, fail: 2, unsupported: 0, pending: 0, total: 0 })
  mem['ixd2026.diag'] = { at: 'x' }; assert.equal(loadSummary(storage), null)
  const thrower = { get() { throw new Error('SecurityError') }, set() { throw new Error('QuotaExceeded') } }
  assert.equal(loadSummary(thrower), null); assert.equal(saveSummary({ pass: 1, fail: 0 }, 5, thrower), null)
  assert.equal(saveSummary(null, 5, storage), null, '沒有摘要就不存')
  assert.equal(loadSummary(), null, '預設走 persist.js：Node 沒有 localStorage → null，不丟例外')
})

test('「上次診斷」那一行（formatSummaryLine）：有總數 → 通過 x / 共 N 項 + 失敗 / 不支援 / 尚未測；只跑快速檢查（大量尚未測）不會被看成「0 失敗 = 都驗過」；舊格式（沒有 total）維持原句', () => {
  const at = new Date(2026, 8, 20, 14, 30).getTime()
  const when = formatWhen(at, 'zh-TW')
  // 只按「執行所有快速檢查」：37 項裡 25 項有結果（通過含資訊項）、12 項互動檢查尚未測
  const onlyAuto = { at, pass: 25, fail: 0, unsupported: 0, pending: 12, total: 37 }
  assert.equal(formatSummaryLine(onlyAuto, t, 'zh-TW'), `上次診斷：${when}，通過 25 / 37 項，失敗 0、不支援 0、尚未測 12`)
  const safari = { at, pass: 20, fail: 0, unsupported: 5, pending: 12, total: 37 }
  assert.match(formatSummaryLine(safari, t, 'zh-TW'), /不支援 5、尚未測 12$/, '不支援的項目也列出來')
  const legacy = { at, pass: 20, fail: 2, unsupported: 0, pending: 0, total: 0 }
  assert.equal(formatSummaryLine(legacy, t, 'zh-TW'), `上次診斷：${when}，通過 20 項、失敗 2 項`, '舊摘要沒有 total → 原本的一行')
  assert.equal(formatSummaryLine({ at, pass: 3, fail: 0 }, t, 'zh-TW'), `上次診斷：${when}，通過 3 項、失敗 0 項`)
  // 與診斷頁自己的算法一致：直接餵 summarize 的結果
  const sum = D.summarize(['a', 'b', 'c', 'd', 'e'].map((id) => ({ id })), { a: { status: 'pass' }, b: { status: 'info' }, c: { status: 'fail' }, d: { status: 'unsupported' } })
  const line = formatSummaryLine({ at, ...sum }, t, 'zh-TW')
  assert.match(line, new RegExp(`通過 ${sum.pass} / ${sum.total} 項，失敗 ${sum.fail}、不支援 ${sum.unsupported}、尚未測 ${sum.pending}$`))
  // 英文
  registerEn(en); registerEn(en2); setLocale('en')
  try {
    const l = formatSummaryLine(onlyAuto, t, 'en-US')
    assert.match(l, /^Last diagnosis: .+, 25 of 37 passed, 0 failed, 0 unsupported, 12 not tested yet$/); assert.ok(!/[㐀-鿿]/.test(l), l)
    assert.match(formatSummaryLine(legacy, t, 'en-US'), /, 20 passed, 2 failed$/)
  } finally { setLocale('zh') }
  // 元件確實走這個函式（不是自己再拼一份）
  assert.match(readFileSync(new URL('../ui/devices/DiagnosticsSection.jsx', import.meta.url), 'utf8'), /formatSummaryLine\(sum, t, localeTag\(locale\)\)/)
})

test('formatWhen / diagnosticsHref', () => {
  const at = new Date(2026, 8, 20, 14, 30).getTime()
  assert.match(formatWhen(at, 'en-US'), /2026/); assert.match(formatWhen(at, 'zh-TW'), /2026/); assert.equal(formatWhen(NaN), ''); assert.equal(formatWhen(at, 'not a locale!!'), new Date(at).toISOString())
  assert.equal(diagnosticsHref('en'), '?diagnostics=1&lang=en'); assert.equal(diagnosticsHref('zh'), '?diagnostics=1&lang=zh'); assert.equal(diagnosticsHref(undefined), '?diagnostics=1'); assert.equal(diagnosticsHref('fr'), '?diagnostics=1')
})

// ───────────────────────────── 瀏覽器版環境（Illegal invocation 把關）─────────────────────────────
function strictGlobal() {
  const bc = fakeBC()
  const g = strict({
    navigator: { userAgent: 'FakeUA', platform: 'X', language: 'en', languages: ['en'], onLine: true, hardwareConcurrency: 4, vibrate() { return true }, getGamepads() { return [] }, storage: { estimate() { return Promise.resolve({ usage: 1, quota: 2 }) } }, clipboard: { writeText() { return Promise.resolve() } } },
    window: { isSecureContext: true, location: { href: 'https://x.test/?diagnostics=1#hash', protocol: 'https:' }, screen: { width: 10, height: 20 }, devicePixelRatio: 1, innerWidth: 5, innerHeight: 6, PointerEvent: function PointerEvent() {}, matchMedia() { return { matches: false } } },
    document: { hidden: false, visibilityState: 'visible', documentElement: {}, createElement() { return {} } },
    performance: { now() { return 42 } },
    setTimeout(fn, ms) { return setTimeout(fn, ms) },
    clearTimeout(id) { clearTimeout(id) },
    requestAnimationFrame(cb) { return setTimeout(() => cb(1), 16) },
    cancelAnimationFrame(id) { clearTimeout(id) },
    BroadcastChannel: function BroadcastChannel(name) { return bc.make(name) },
    localStorage: fakeStorage(),
    Intl: { DateTimeFormat() { return { resolvedOptions() { return { timeZone: 'UTC' } } } } },
    URL: { createObjectURL() { return 'blob:1' }, revokeObjectURL() {} },
    Blob: function Blob() {}, File: function File() {},
  }, 'global')
  return { g, bc }
}

test('browserEnv：計時器 / rAF / 時鐘 / BroadcastChannel 都包成箭頭函式，脫離物件呼叫也不會 Illegal invocation', async () => {
  const { g, bc } = strictGlobal()
  const env = D.browserEnv(g)
  const { setTimeout: st, clearTimeout: ct, now, raf, cancelRaf, createChannel, randomId, getStorage } = env   // 故意脫離 env 呼叫
  assert.equal(now(), 42)
  await new Promise((resolve) => { st(resolve, 1) })
  ct(st(() => assert.fail('已取消的計時器不該觸發'), 5))
  await new Promise((resolve) => { raf(resolve) }); cancelRaf(raf(() => assert.fail('已取消的 rAF 不該觸發')))
  const ch = createChannel('x'); assert.equal(ch.name, 'x'); assert.equal(bc.chans.length, 1)
  assert.equal(typeof randomId(), 'string'); assert.equal(getStorage(), g.localStorage); assert.equal(env.nav, g.navigator); assert.equal(env.win, g.window)
  await new Promise((r) => setTimeout(r, 30))
  const bare = D.browserEnv({})
  assert.equal(bare.nav, null); assert.equal(bare.raf, null); assert.equal(bare.createChannel, null); assert.equal(bare.MediaRecorder, null); assert.equal(bare.makeFile, null)
  assert.equal(typeof bare.now(), 'number'); assert.equal(bare.getStorage(), undefined, '沒有 localStorage：由 ls 檢查自己判斷')
})

test('用「會檢查 this 的全域」跑完整個快速檢查與報告匯出流程——沒有 Illegal invocation', async () => {
  const { g } = strictGlobal()
  const env = D.browserEnv(g)
  const out = await D.runAutoChecks(env, { checks: D.getAutoChecks().filter((c) => c.id !== 'fps') })
  assert.equal(out.length, 24)
  for (const r of out) { assert.ok(D.STATUSES.includes(r.status), r.id); assert.ok(!/Illegal invocation/.test(r.detail), r.id + '：' + r.detail) }
  const by = Object.fromEntries(out.map((r) => [r.id, r]))
  for (const id of ['env-ua', 'env-screen', 'env-locale', 'env-storage']) assert.equal(by[id].status, 'info', id + '：' + by[id].detail)
  for (const id of ['ls', 'bc', 'vibrate-api', 'gamepad-api', 'pointer-api', 'env-secure']) assert.equal(by[id].status, 'pass', id + '：' + by[id].detail)
  const fps = await (async () => { const p = D.runAutoChecks(env, { checks: D.getAutoChecks().filter((c) => c.id === 'fps'), guardMs: 8000 }); return p })()
  assert.ok(D.STATUSES.includes(fps[0].status), 'fps 用真 rAF 假實作也不會 Illegal invocation：' + fps[0].detail)
  const rep = D.buildReport({ results: Object.fromEntries(out.map((r) => [r.id, r])), meta: D.collectMeta(env) })
  assert.ok(rep.text.includes('"url": "https://x.test/?diagnostics=1"'))
  assert.deepEqual(await D.copyText(rep.text, env), { ok: true, method: 'clipboard' })
})

test('沒有殘留：所有測試用到的假環境最後都沒有排程中的計時器（抽樣：完整快速檢查重跑三次）', async () => {
  for (let i = 0; i < 3; i++) {
    const x = fullEnv(); const p = D.runAutoChecks(x.env); await adv(x.clock, 8000, 100); await p
    assert.equal(x.clock.pending(), 0); assert.equal(x.raf.live.size, 0)
  }
})

// ═════════════════════════════ 真機驗證日：語音旁白 / 看門狗自我檢查 / 相機手勢 ═════════════════════════════
// ───────────────────────────── 語音旁白 ─────────────────────────────
function fakeNarrator(o = {}) {
  const n = {
    spoken: [], cancels: 0, disposed: 0, resolveSpeak: null,
    supported() { return o.supported !== false },
    speak(text, opts) {
      n.spoken.push({ text, opts })
      if (o.mode === 'hang') return new Promise(() => {})
      if (o.mode === 'defer') return new Promise((r) => { n.resolveSpeak = r })
      return Promise.resolve(o.result || 'done')
    },
    cancel() { n.cancels++ },
    dispose() { n.disposed++ },
    pickVoice() { return o.voice === undefined ? { name: 'Mei-Jia', lang: 'zh-TW', localService: true } : o.voice },
  }
  return strict(n, 'narrator')
}
function fakeSynth(voices, o = {}) {
  const ls = new Set()
  const s = {
    voices, added: 0, removed: 0,
    getVoices() { return s.voices },
    addEventListener(t, f) { if (t === 'voiceschanged') { ls.add(f); s.added++ } },
    removeEventListener(t, f) { if (t === 'voiceschanged') { ls.delete(f); s.removed++ } },
    fire() { for (const f of [...ls]) f() },
    listenerCount() { return ls.size },
  }
  if (o.noEvents) { delete s.addEventListener; delete s.removeEventListener }
  return strict(s, 'speechSynthesis')
}
const VOICES = [
  { name: 'Mei-Jia', lang: 'zh-TW', localService: true }, { name: 'Google 國語', lang: 'zh_TW', localService: false }, { name: 'HK', lang: 'zh-HK', localService: true },
  { name: 'Samantha', lang: 'en-US', localService: false }, null,
]
function narrSetup(o = {}) {
  const clock = makeClock()
  const narrator = o.narrator || fakeNarrator(o.nar)
  const synth = o.synth === null ? undefined : (o.synth || fakeSynth(o.voices ?? VOICES))
  const { seen, hooks } = collect()
  const { env } = makeEnv({ narrator, nav: strict({}), win: fakeWin({ speechSynthesis: synth }) }, clock)
  return { clock, narrator, synth, seen, env, probe: D.createProbe('narration', env, { ...hooks, lang: o.lang || 'zh-TW' }) }
}

test('語音旁白：summarizeVoices 只計數（zh-TW / en-US 各幾個、幾個是離線）；容忍 zh_TW / zh-Hant-TW / 大小寫；空值與壞輸入不丟例外', () => {
  assert.deepEqual(D.summarizeVoices(VOICES), { total: 4, zhTW: 2, enUS: 1, zhTWLocal: 1, enUSLocal: 0, local: 2 })
  assert.deepEqual(D.summarizeVoices([{ lang: 'zh-Hant-TW', localService: true }, { lang: 'EN-us', localService: true }, { lang: 'ja-JP' }, {}, { lang: 5 }]), { total: 5, zhTW: 1, enUS: 1, zhTWLocal: 1, enUSLocal: 1, local: 2 })
  assert.deepEqual(D.summarizeVoices(null), { total: 0, zhTW: 0, enUS: 0, zhTWLocal: 0, enUSLocal: 0, local: 0 }); assert.equal(D.summarizeVoices(undefined).total, 0)
  assert.equal(D.summarizeVoices({ length: 1, 0: { lang: 'en-US' } }).enUS, 1, '類陣列（SpeechSynthesisVoiceList）也能計數')
})

test('語音旁白：按下按鈕的同一個手勢內就呼叫 narrator.speak（iOS）；念完 → 待操作 + 聲音清單；使用者回答「有」→ 通過、「沒有」→ 失敗', async () => {
  const x = narrSetup()
  const p = x.probe.start()
  assert.equal(x.narrator.spoken.length, 1, '同步呼叫（在第一個 await 之前）：iOS 才允許出聲')
  assert.deepEqual(x.narrator.spoken[0].opts, { lang: 'zh-TW' }); assert.match(x.narrator.spoken[0].text, /這是旁白測試/)
  await settle()
  const r = await p
  assert.equal(r.status, 'needs-action', '念完還要人回答：有沒有聽到')
  assert.deepEqual(r.data.voices, { total: 4, zhTW: 2, enUS: 1, zhTWLocal: 1, enUSLocal: 0, local: 2 }); assert.equal(r.data.lang, 'zh-TW'); assert.equal(r.data.outcome, 'done')
  assert.deepEqual(r.data.voice, { name: 'Mei-Jia', lang: 'zh-TW', local: true })
  assert.match(r.detail, /已念出測試句（zh-TW）/); assert.match(r.detail, /zh-TW 2 個（離線 1）、en-US 1 個（離線 0）/); assert.match(r.detail, /zh-TW 有離線聲音/)
  assert.ok(x.seen.updates.some((u) => u.voices && u.voices.zhTW === 2), '畫面即時顯示聲音清單')
  const spec = D.getCheck('narration')
  assert.equal(spec.verdict.required, true); assert.equal(spec.verdict.ask, '有聽到嗎？'); assert.equal(spec.verdict.ok, '有'); assert.equal(spec.verdict.bad, '沒有')
  assert.equal(D.applyVerdict(spec, r, undefined).status, 'needs-action', '沒回答前維持待操作')
  const yes = D.applyVerdict(spec, r, 'ok'); assert.equal(yes.status, 'pass'); assert.equal(yes.verdict, 'ok'); assert.match(yes.detail, /使用者確認：有聽到旁白/)
  const no = D.applyVerdict(spec, r, 'bad'); assert.equal(no.status, 'fail'); assert.match(no.detail, /使用者回報：沒有聽到旁白/)
  assert.equal(x.narrator.cancels >= 1 && x.narrator.disposed >= 1, true, '結束一定 cancel + dispose（放掉 voiceschanged 監聽）'); assert.equal(x.clock.pending(), 0); assert.deepEqual(x.seen.running, [true, false])
})

test('語音旁白：測試句依語系（en-US → 英文，不受全域語系影響）；沒有 zh-TW 聲音 / 沒有離線聲音的提示；聲音清單一開始是空的 → 等 voiceschanged，等不到也繼續', async () => {
  registerEn(en); registerEn(en2)
  const e = narrSetup({ lang: 'en-US' }); const pe = e.probe.start(); await settle(); const re = await pe
  assert.equal(e.narrator.spoken[0].text, 'This is a narration test. If you can hear this sentence, spoken narration works.'); assert.deepEqual(e.narrator.spoken[0].opts, { lang: 'en-US' })
  assert.match(re.detail, /en-US 的聲音都不是離線聲音/, '只有線上的 en-US 聲音 → 提醒斷網可能念不出來')

  const none = narrSetup({ voices: [{ name: 'Kyoko', lang: 'ja-JP', localService: true }] }); const pn = none.probe.start(); await settle(); const rn = await pn
  assert.match(rn.detail, /沒有 zh-TW 的聲音/); assert.equal(rn.data.voices.zhTW, 0)

  const late = narrSetup({ voices: [] }); const pl = late.probe.start(); await settle()
  assert.equal(late.synth.listenerCount(), 1, '等 voiceschanged 期間有掛監聽')
  late.synth.voices = [{ name: 'Mei-Jia', lang: 'zh-TW', localService: true }]; late.synth.fire(); await settle()
  const rl = await pl; assert.equal(rl.data.voices.zhTW, 1); assert.equal(late.synth.listenerCount(), 0, '監聽拿掉了'); assert.equal(late.clock.pending(), 0)

  const never = narrSetup({ voices: [] }); const pv = never.probe.start(); await adv(never.clock, 2000, 100); const rv = await pv
  assert.equal(rv.data.voices.total, 0); assert.match(rv.detail, /聲音清單是空的/); assert.equal(rv.status, 'needs-action', '聲音清單是空的仍然念念看（由人判斷）'); assert.equal(never.synth.listenerCount(), 0); assert.equal(never.clock.pending(), 0)

  const noEv = narrSetup({ voices: [], synth: fakeSynth([], { noEvents: true }) }); const pne = noEv.probe.start(); await settle(); assert.equal((await pne).data.voices.total, 0, '沒有 addEventListener 的舊瀏覽器也不會卡住')
  const noSynthObj = narrSetup({ synth: null }); const pns = noSynthObj.probe.start(); await settle(); assert.equal((await pns).data.voices.total, 0, 'window 上沒有 speechSynthesis（旁白器另有來源）也只是沒有清單')
})

test('語音旁白：念不出聲 → 失敗並提示 iOS 要先點一下；被中斷 → 失敗；不支援 → unsupported；卡住 → 逾時 20 秒失敗並閉嘴', async () => {
  const err = narrSetup({ nar: { result: 'error' } }); const pe = err.probe.start(); await settle(); const re = await pe
  assert.equal(re.status, 'fail'); assert.match(re.detail, /念不出聲/); assert.match(re.detail, /iPhone \/ iPad 請直接點按鈕/); assert.equal(re.data.outcome, 'error')
  const can = narrSetup({ nar: { result: 'cancelled' } }); const pc = can.probe.start(); await settle(); assert.match((await pc).detail, /被中斷/)
  const uns = narrSetup({ nar: { result: 'unsupported' } }); const pu = uns.probe.start(); await settle(); assert.equal((await pu).status, 'unsupported')
  const off = narrSetup({ nar: { supported: false } }); const ro = await off.probe.start(); assert.equal(ro.status, 'unsupported'); assert.match(ro.detail, /speechSynthesis/); assert.equal(off.narrator.spoken.length, 0, '不支援就不呼叫 speak')
  const hang = narrSetup({ nar: { mode: 'hang' } }); const ph = hang.probe.start(); await adv(hang.clock, 21000, 500); const rh = await ph
  assert.equal(rh.status, 'fail'); assert.match(rh.detail, /20 秒內沒有念完/); assert.ok(hang.narrator.cancels >= 1, '逾時後一定 cancel'); assert.equal(hang.clock.pending(), 0)
  // 沒有注入旁白器、Node 沒有 speechSynthesis → 用共用的 narrator：不支援（不丟例外）
  const real = D.createProbe('narration', makeEnv({ win: fakeWin(), nav: strict({}) }).env, {}); assert.equal((await real.start()).status, 'unsupported')
})

test('語音旁白：念到一半按停止 / 離開頁面 → 同步 cancel + dispose，結果是略過（不是失敗）；遲到的念完事件不會回頭改任何東西', async () => {
  const x = narrSetup({ nar: { mode: 'defer' } })
  const p = x.probe.start(); await settle()
  assert.equal(x.narrator.cancels, 0); x.probe.stop()
  assert.ok(x.narrator.cancels >= 1 && x.narrator.disposed >= 1, 'stop() 當下就閉嘴 + 放掉監聽（不等 async 收尾）')
  assert.deepEqual(x.seen.running, [true, false], '畫面立刻回到未執行')
  const r = await p; assert.equal(r.status, 'skipped'); x.narrator.resolveSpeak('done'); await settle()
  assert.ok(!x.seen.results.some((v) => v.status === 'needs-action' || v.status === 'fail'), '遲到的結果沒有出現'); assert.equal(x.clock.pending(), 0); assert.equal(x.synth.listenerCount(), 0)
  // 等聲音清單期間就 stop
  const y = narrSetup({ voices: [], nar: { mode: 'defer' } }); const py = y.probe.start(); await settle(); assert.equal(y.synth.listenerCount(), 1)
  y.probe.stop(); assert.equal(y.synth.listenerCount(), 0, 'stop 也拿掉 voiceschanged 監聽'); assert.equal((await py).status, 'skipped'); assert.equal(y.clock.pending(), 0)
})

test('語音旁白：報告只留計數與挑到的聲音（名稱 / 語言 / 是否離線），不含其他聲音的名稱', async () => {
  const x = narrSetup(); const p = x.probe.start(); await settle(); const r = await p
  const rep = D.buildReport({ results: { narration: D.applyVerdict(D.getCheck('narration'), r, 'ok') }, meta: {} })
  assert.ok(rep.text.includes('"zhTW": 2')); assert.ok(!rep.text.includes('Samantha') && !rep.text.includes('Google 國語'), '沒挑到的聲音名稱不進報告')
  assert.equal(rep.json.results.find((v) => v.id === 'narration').status, 'pass')
})

// ───────────────────────────── 看門狗自我檢查 ─────────────────────────────
// 每一幀的延遲由劇本決定（Infinity = 之後 rAF 再也不來）
function scriptedRaf(clock, delays) {
  let seq = 0, i = 0
  const live = new Map()
  return {
    live,
    raf: (cb) => { const id = ++seq; const d = i < delays.length ? delays[i++] : delays[delays.length - 1]; if (!Number.isFinite(d)) return id; live.set(id, clock.setTimeout(() => { live.delete(id); cb(clock.now()) }, d)); return id },
    cancelRaf: (id) => { const h = live.get(id); if (h != null) clock.clearTimeout(h); live.delete(id) },
  }
}
function wdSetup(o = {}) {
  const clock = makeClock()
  const r = o.delays ? scriptedRaf(clock, o.delays) : fakeRaf(clock, o.rafMs ?? 16)
  const { seen, hooks } = collect()
  const doc = strict({ hidden: !!o.hidden, visibilityState: o.hidden ? 'hidden' : 'visible' })
  const win = fakeWin({ location: { search: o.search ?? '?diagnostics=1&kiosk=1', href: 'https://midisea.shyetech.com/' } })
  const over = { win, doc, ...(o.noRaf ? {} : { raf: r.raf, cancelRaf: r.cancelRaf }), ...(o.resilience ? { resilience: o.resilience } : {}) }
  const { env } = makeEnv(over, clock)
  return { clock, r, seen, env, probe: D.createProbe('watchdog', env, hooks) }
}

test('看門狗：驗證判定邏輯（真實的 watchdogVerdict）——正常 → ok、卡死 → stalled、分頁隱藏 → hidden；壞的判定函式 / 丟例外的判定函式都會被抓到', () => {
  const real = D.checkWatchdogVerdicts()
  assert.equal(real.ok, true); assert.deepEqual(real.cases.map((c) => [c.id, c.expect, c.got, c.ok]), [['normal', 'ok', 'ok', true], ['stalled', 'stalled', 'stalled', true], ['hidden', 'hidden', 'hidden', true]])
  const always = D.checkWatchdogVerdicts(() => 'ok'); assert.equal(always.ok, false); assert.deepEqual(always.cases.map((c) => c.ok), [true, false, false])
  const boom = D.checkWatchdogVerdicts(() => { throw new Error('boom') }); assert.equal(boom.ok, false); assert.deepEqual(boom.cases.map((c) => c.got), ['error', 'error', 'error'])
  const seenInputs = []; D.checkWatchdogVerdicts((i) => { seenInputs.push(i); return 'ok' })
  assert.deepEqual(seenInputs.map((i) => [i.enabled, i.visible]), [[true, true], [true, true], [true, false]]); assert.ok(seenInputs.every((i) => i.now > i.lastFrameAt || i.lastFrameAt === 0))
})

test('看門狗：這個網址的參數在主畫面會不會啟用（resolveConfig）——診斷頁自己的 diagnostics / guided 參數先去掉；?kiosk / ?watchdog=1 / ?audience=1 會啟用，?watchdog=0 明確關閉', () => {
  const cfg = (search) => D.watchdogConfigInfo({ win: { location: { search } } })
  assert.deepEqual([cfg('?diagnostics=1').on, cfg('?diagnostics=1').reason], [false, 'default'])
  assert.deepEqual([cfg('?diagnostics=1&guided=1').on, cfg('?diagnostics=1&guided=1').reason], [false, 'default'])
  assert.deepEqual([cfg('?diagnostics=1&kiosk=1').on, cfg('?diagnostics=1&kiosk=1').reason], [true, 'kiosk'])
  assert.deepEqual([cfg('?diagnostics=1&guided=1&watchdog=1').on, cfg('?diagnostics=1&guided=1&watchdog=1').reason], [true, 'flag'])
  assert.deepEqual([cfg('?diagnostics=1&watchdog=0&kiosk=1').on, cfg('?diagnostics=1&watchdog=0&kiosk=1').reason], [false, 'flag-off'])
  assert.deepEqual([cfg('?diagnostics=1&audience=1').on, cfg('?diagnostics=1&audience=1').reason], [true, 'audience'])
  assert.deepEqual(cfg('').examples, [{ search: '?kiosk=1', on: true }, { search: '?watchdog=1', on: true }], '展場用網址範例：都會啟用')
  assert.equal(D.watchdogConfigInfo({}).on, false); assert.equal(D.watchdogConfigInfo(null).on, false, '沒有 window 也不丟例外')
  assert.equal(D.watchdogConfigInfo({ win: {} }).reason, 'default')
})

test('看門狗自我檢查：3 秒取樣幀數 / 平均 FPS / 最大幀間隔 + 3 組判定 + 網址設定 → 通過；註明「不會模擬真的卡死」；放掉所有 rAF 與計時器', async () => {
  const x = wdSetup()
  const p = x.probe.start(); await adv(x.clock, 3200, 16)
  const r = await p
  assert.equal(r.status, 'pass', r.detail)
  assert.ok(r.data.frames >= 180 && r.data.frames <= 195, 'frames ' + r.data.frames); assert.equal(r.data.maxGapMs, 16); assert.ok(Math.abs(r.data.avgFps - 62.5) < 1, 'fps ' + r.data.avgFps); assert.equal(r.data.sampleMs, 3000)
  assert.deepEqual(r.data.verdicts, { normal: 'ok', stalled: 'stalled', hidden: 'hidden' }); assert.equal(r.data.verdictOk, true)
  assert.deepEqual(r.data.config, { on: true, reason: 'kiosk', examples: [{ search: '?kiosk=1', on: true }, { search: '?watchdog=1', on: true }] }); assert.equal(r.data.stallMs, 10000)
  assert.match(r.detail, /取樣 3 秒：\d+ 幀，平均 62\.\d FPS，最大幀間隔 16 ms/); assert.match(r.detail, /判定邏輯驗證：正常 → ok、卡死 → stalled、分頁隱藏 → hidden，3 組都符合預期/)
  assert.match(r.detail, /主畫面用這個網址的參數會啟用看門狗（展場模式 \?kiosk）/); assert.match(r.detail, /展場請用 \?kiosk=1（或 \?watchdog=1）/); assert.match(r.detail, /連續 10 秒沒有畫面幀，連續 2 次檢查（每 2 秒一次）/)
  assert.match(r.detail, /這不會模擬真的卡死；實機卡死復原要在主畫面加 \?watchdog=1 手動驗/)
  assert.equal(x.r.live.size, 0, '沒有殘留 rAF'); assert.equal(x.clock.pending(), 0); assert.deepEqual(x.seen.running, [true, false])
  assert.equal(x.seen.updates[0].phase, 'sampling'); assert.ok(x.seen.updates.some((u) => u.frames > 50 && u.maxGapMs === 16), '取樣中即時回報幀數'); assert.ok(x.seen.updates.length < 30, '即時回報有節流（每 250ms 一次），不是每幀一次')
  assert.equal(D.getCheck('watchdog').detailList, true)
  // 一般網址（沒有 ?kiosk）：仍通過（只是資訊），但說明「不會啟用」與原因
  const plain = wdSetup({ search: '?diagnostics=1' }); const pp = plain.probe.start(); await adv(plain.clock, 3200, 16); const rp = await pp
  assert.equal(rp.status, 'pass'); assert.equal(rp.data.config.on, false); assert.match(rp.detail, /不會啟用看門狗（一般使用的預設值：不啟用）/); assert.match(rp.detail, /診斷頁本身不會啟動看門狗/)
})

test('看門狗自我檢查：幀間隔太大 / 中途 rAF 停了 / 幾乎沒有幀 → 失敗並說明；稍慢但正常（1.5 秒一幀）仍通過', async () => {
  const gap = wdSetup({ delays: [10, 10, 10, 5100, 10] }); const pg = gap.probe.start(); await adv(gap.clock, 6500, 100); const rg = await pg
  assert.equal(rg.status, 'fail'); assert.equal(rg.data.maxGapMs, 5100); assert.equal(rg.data.frames, 4); assert.match(rg.detail, /最大幀間隔已超過看門狗門檻的一半（5000 ms）/); assert.equal(gap.r.live.size, 0); assert.equal(gap.clock.pending(), 0)

  const stop = wdSetup({ delays: [10, 10, 10, Infinity] }); const ps = stop.probe.start(); await adv(stop.clock, 6000, 100); const rs = await ps
  assert.equal(rs.status, 'fail'); assert.equal(rs.data.frames, 3); assert.ok(rs.data.maxGapMs >= 5000, '「最後一幀之後 rAF 就不來了」也算進最大幀間隔：' + rs.data.maxGapMs); assert.match(rs.detail, /最大幀間隔已超過/); assert.equal(stop.clock.pending(), 0)

  const none = wdSetup({ delays: [Infinity] }); const pn = none.probe.start(); await adv(none.clock, 6000, 100); const rn = await pn
  assert.equal(rn.status, 'fail'); assert.equal(rn.data.frames, 0); assert.match(rn.detail, /幾乎沒有畫面幀（0 幀）：分頁可能在背景、被節流，或畫面已經卡住/); assert.equal(rn.data.avgFps, 0)
  const one = wdSetup({ delays: [10, Infinity] }); const p1 = one.probe.start(); await adv(one.clock, 6000, 100); assert.match((await p1).detail, /（1 幀）/)

  const slow = wdSetup({ rafMs: 1500 }); const psl = slow.probe.start(); await adv(slow.clock, 5000, 100); const rsl = await psl
  assert.equal(rsl.status, 'pass'); assert.equal(rsl.data.frames, 3); assert.equal(rsl.data.maxGapMs, 1500)
})

test('看門狗自我檢查：判定函式不符預期（永遠回 ok / 丟例外）→ 失敗並列出實際判定；設定函式可注入', async () => {
  const bad = wdSetup({ resilience: { watchdogVerdict: () => 'ok' } }); const pb = bad.probe.start(); await adv(bad.clock, 3200, 16); const rb = await pb
  assert.equal(rb.status, 'fail'); assert.equal(rb.data.verdictOk, false); assert.deepEqual(rb.data.verdicts, { normal: 'ok', stalled: 'ok', hidden: 'ok' })
  assert.match(rb.detail, /判定邏輯不符預期：正常 → ok（應為 ok）、卡死 → ok（應為 stalled）、分頁隱藏 → ok（應為 hidden）/)
  const boom = wdSetup({ resilience: { watchdogVerdict: () => { throw new Error('boom') } } }); const pt = boom.probe.start(); await adv(boom.clock, 3200, 16); const rt = await pt
  assert.equal(rt.status, 'fail'); assert.deepEqual(Object.values(rt.data.verdicts), ['error', 'error', 'error'])
  const cfgThrows = wdSetup({ resilience: { resolveConfig: () => { throw new Error('config boom') } } }); const rc = await cfgThrows.probe.start(); assert.equal(rc.status, 'fail'); assert.match(rc.detail, /config boom/)
  const custom = wdSetup({ resilience: { WATCHDOG_STALL_MS: 20000, WATCHDOG_STRIKES: 3, WATCHDOG_CHECK_MS: 4000 } }); const pcu = custom.probe.start(); await adv(custom.clock, 3200, 16); assert.match((await pcu).detail, /連續 20 秒沒有畫面幀，連續 3 次檢查（每 4 秒一次）/)
})

test('看門狗自我檢查：分頁在背景 → 略過（不取樣）；沒有 rAF → unsupported（仍列出判定驗證與說明）；按停止 → 立刻放掉 rAF；環境全是壞的 → 失敗不丟例外', async () => {
  const hid = wdSetup({ hidden: true }); const rh = await hid.probe.start(); assert.equal(rh.status, 'skipped'); assert.match(rh.detail, /分頁在背景/); assert.equal(hid.r.live.size, 0)
  const noRaf = wdSetup({ noRaf: true }); const rn = await noRaf.probe.start()
  assert.equal(rn.status, 'unsupported'); assert.match(rn.detail, /沒有 requestAnimationFrame/); assert.match(rn.detail, /判定邏輯驗證/); assert.match(rn.detail, /不會模擬真的卡死/); assert.equal(rn.data.sampled, false)
  const st = wdSetup(); const ps = st.probe.start(); await adv(st.clock, 500, 16)
  assert.ok(st.r.live.size > 0); st.probe.stop(); assert.equal(st.r.live.size, 0, 'stop() 同步取消 rAF'); assert.equal(st.clock.pending(), 0, '也清掉保險計時器'); assert.equal((await ps).status, 'skipped'); assert.deepEqual(st.seen.running, [true, false])
  const boom = new Proxy({}, { get() { throw new Error('boom') } })
  const r = await D.createProbe('watchdog', makeEnv({ nav: boom, win: boom, doc: boom }).env).start(); assert.equal(r.status, 'fail'); assert.match(r.detail, /boom/)
})

// ───────────────────────────── 相機手勢（MediaPipe）─────────────────────────────
// 合成手部 landmark（掌尺單位、y 向下）：與 gestures.test.mjs 同一套產生器的精簡版，用真的 classifyHand 分類
const HAND_DEF = [
  { mcp: [-0.33, -0.97], len: [0.42, 0.24, 0.21], fan: -10 }, { mcp: [0.0, -1.0], len: [0.47, 0.30, 0.25], fan: 0 },
  { mcp: [0.30, -0.95], len: [0.44, 0.28, 0.24], fan: 9 }, { mcp: [0.56, -0.82], len: [0.35, 0.19, 0.19], fan: 20 },
]
const radn = (dg) => (dg * Math.PI) / 180
function handFinger(def, { spread = 1, curl = 0, mode = 'depth' } = {}) {
  const base = radn(def.fan * spread), flex = [90 * curl, 100 * curl, 70 * curl].map(radn)
  const pts = [[def.mcp[0], def.mcp[1]]]; let cum = 0
  for (let i = 0; i < 3; i++) {
    cum += flex[i]; const [px, py] = pts[i]
    if (mode === 'depth') { const L = def.len[i] * Math.cos(cum); pts.push([px + Math.sin(base) * L, py - Math.cos(base) * L]) }
    else { const a = base + cum; pts.push([px + Math.sin(a) * def.len[i], py - Math.cos(a) * def.len[i]]) }
  }
  return pts.slice(1)
}
function makeHandLm({ curls = [0, 0, 0, 0], spread = 1, mode = 'depth', pinch = null, thumb = [[-0.28, -0.18], [-0.55, -0.38], [-0.80, -0.52], [-1.00, -0.66]] } = {}) {
  const pts = new Array(21); pts[0] = [0, 0]
  HAND_DEF.forEach((d, i) => { const f = handFinger(d, { spread, curl: curls[i], mode }); pts[5 + i * 4] = d.mcp; pts[6 + i * 4] = f[0]; pts[7 + i * 4] = f[1]; pts[8 + i * 4] = f[2] })
  const th = thumb.map((p) => [...p])
  if (pinch != null) { const tip = pts[8]; th[3] = [tip[0] - pinch, tip[1]]; th[2] = [(th[1][0] + th[3][0]) * 0.5, (th[1][1] + th[3][1]) * 0.5]; th[1] = [-0.52, -0.42] }
  for (let i = 0; i < 4; i++) pts[1 + i] = th[i]
  const W = 640, H = 480, scale = 0.25, tx = 0.5, ty = 0.55
  return pts.map(([x, y]) => ({ x: (x * scale * H + tx * W) / W, y: (y * scale * H + ty * H) / H, z: 0 }))
}
const OPEN_PALM = () => makeHandLm({})
const PINCH = () => makeHandLm({ curls: [0.35, 0, 0, 0], spread: 0.6, mode: 'plane', pinch: 0.05 })
const FIST = () => makeHandLm({ curls: [1, 1, 1, 1], spread: 0.3, thumb: [[-0.28, -0.18], [-0.40, -0.40], [-0.20, -0.55], [0.05, -0.55]] })

// 假 MediaPipe 模組：createFromOptions 可以延遲 / 失敗 / 卡住；detectForVideo 依「第幾次呼叫」回傳劇本
function fakeVision(clock, o = {}) {
  const log = [], landmarkers = []
  const mod = {
    FilesetResolver: { forVisionTasks(url) { log.push('fileset:' + url); return o.filesetError ? Promise.reject(new Error('fileset failed')) : Promise.resolve({ url }) } },
    HandLandmarker: {
      createFromOptions(fileset, opts) {
        log.push('create:' + opts.baseOptions.delegate + ':' + opts.numHands + ':' + opts.runningMode + ':' + opts.baseOptions.modelAssetPath)
        if (o.gpuFail && opts.baseOptions.delegate === 'GPU') return Promise.reject(new Error('gpu unavailable'))
        if (o.modelError) return Promise.reject(new Error('model download failed'))
        const lm = strict({
          closed: 0, calls: 0, stamps: [],
          detectForVideo(video, ts) { lm.calls++; lm.stamps.push(ts); if (o.detectThrows) throw new Error('detect boom'); return { landmarks: o.script ? o.script(lm.calls) : [] } },
          close() { lm.closed++ },
        }, 'HandLandmarker')
        landmarkers.push(lm)
        if (o.modelHang) return new Promise(() => {})
        if (o.lateModel) return new Promise((res) => { o.lateResolve = () => res(lm) })
        if (o.modelMs) return new Promise((res) => { clock.setTimeout(() => res(lm), o.modelMs) })
        return Promise.resolve(lm)
      },
    },
  }
  return { mod: strict(mod, 'vision'), log, landmarkers }
}
function fakeGestureVideo(clock, frameMs = 16) {
  const v = { readyState: 4, videoWidth: 640, videoHeight: 480, srcObject: null, played: 0, paused: 0, play() { v.played++; return Promise.resolve() }, pause() { v.paused++ } }
  Object.defineProperty(v, 'currentTime', { get() { return Math.floor(clock.now() / frameMs) / 30 } })   // 每 frameMs 毫秒才有新的一幀
  return strict(v, 'video')
}
function gestureSetup(o = {}) {
  const clock = makeClock()
  const md = fakeMedia(o.md)
  const vision = fakeVision(clock, o.vision)
  const video = fakeGestureVideo(clock, o.frameMs)
  const { seen, hooks } = collect()
  seen.attached = 0; seen.detached = 0; seen.draws = []
  const nav = o.noMedia ? strict({}) : strict({ mediaDevices: md, onLine: o.offline ? false : true })
  const doc = strict({ hidden: false })
  const win = fakeWin({ isSecureContext: o.secure !== false })
  const importVision = o.importVision || (() => Promise.resolve(vision.mod))
  const { env } = makeEnv({ nav, win, doc, WebAssembly: o.noWasm ? null : {}, importVision: o.noLoader ? undefined : importVision }, clock)
  const probe = D.createProbe('gesture', env, { ...hooks, attach: o.attach || (async (s) => { seen.attached++; video.srcObject = s; return video }), detach: () => { seen.detached++ }, draw: (h) => { seen.draws.push(h) } })
  return { clock, md, vision, video, seen, env, probe, doc }
}

test('相機手勢：合成的張手 / 捏合 / 握拳用真的 classifyHand 分類（產生器自我檢查）', async () => {
  const { classifyHand } = await import('./gestures.js')
  const asp = 640 / 480
  assert.equal(classifyHand(OPEN_PALM(), { aspect: asp }).gesture, 'open_palm'); assert.equal(classifyHand(PINCH(), { aspect: asp }).gesture, 'pinch'); assert.equal(classifyHand(FIST(), { aspect: asp }).gesture, 'other')
  assert.equal(OPEN_PALM().length, 21)
})

test('相機手勢：請求相機 → 動態載入 → 載入模型 → 偵測 8 秒 → 回報載入時間 / 實際 FPS / 最多同時幾隻手 / 看過哪些手勢；結束停 track、關辨識器、放掉預覽並清掉骨架', async () => {
  const script = (n) => (n <= 30 ? [] : n <= 200 ? [OPEN_PALM()] : n <= 320 ? [OPEN_PALM(), PINCH()] : n <= 400 ? [FIST()] : [PINCH()])
  const x = gestureSetup({ vision: { script, modelMs: 1200 } })
  const p = x.probe.start()
  assert.deepEqual(x.md.calls, [{ video: { facingMode: 'user', width: 640, height: 480 }, audio: false }], '按下才請求相機（640×480 前鏡頭、不要音訊）')
  await settle(); assert.deepEqual(x.vision.log, ['fileset:' + WASM_BASE_EXPECT, 'create:GPU:2:VIDEO:' + MODEL_URL_EXPECT], 'GPU 優先、最多 2 隻手、VIDEO 模式、資源網址與主畫面手勢一致')
  assert.equal(x.seen.attached, 1); assert.ok(x.seen.updates.some((u) => u.phase === 'camera')); assert.ok(x.seen.updates.some((u) => u.phase === 'loading'))
  await adv(x.clock, 9500, 16)
  const r = await p
  assert.equal(r.status, 'pass', r.detail)
  assert.equal(r.data.modelMs, 1200); assert.equal(r.data.delegate, 'GPU'); assert.equal(r.data.frames, r.data.frames | 0); assert.ok(r.data.frames >= 490 && r.data.frames <= 500, 'frames ' + r.data.frames)
  assert.ok(Math.abs(r.data.fps - 62.5) < 2, 'fps ' + r.data.fps); assert.equal(r.data.seconds, 8); assert.equal(r.data.handsMax, 2); assert.deepEqual(r.data.gestures, ['open_palm', 'pinch']); assert.equal(r.data.width, 640); assert.equal(r.data.height, 480)
  assert.ok(r.data.framesWithHand > 250 && r.data.framesWithHand < r.data.frames)
  assert.match(r.detail, /手勢模型載入 1\.2 秒（GPU）/); assert.match(r.detail, /辨識幀率 6\d\.\d FPS/); assert.match(r.detail, /最多同時偵測 2 隻手/); assert.match(r.detail, /看到的手勢：張手 · 捏合/)
  const lm = x.vision.landmarkers[0]
  assert.ok(lm.stamps.every((t, i) => i === 0 || t > lm.stamps[i - 1]), '時間戳嚴格遞增（MediaPipe VIDEO 模式的要求）')
  assert.ok(x.md.streams[0].tracks.every((t) => t.stopped === 1), '結束一定停掉相機 track'); assert.equal(lm.closed, 1, '辨識器 close 了'); assert.equal(x.seen.detached, 1); assert.deepEqual(x.seen.draws.at(-1), [], '骨架清掉了')
  assert.ok(x.seen.draws.some((h) => h.length === 2 && h[0].length === 21), '每個偵測幀都把 landmark 交給畫面畫骨架'); assert.equal(x.clock.pending(), 0); assert.deepEqual(x.seen.running, [true, false])
  assert.ok(x.seen.updates.some((u) => u.gestures && u.gestures.includes('pinch') && u.handsMax === 2), '畫面即時顯示手勢'); assert.ok(x.seen.updates.some((u) => u.aspect === 1.333), '預覽比例跟著影片')
  assert.ok(x.seen.updates.length < 100, '即時回報有節流')
  const json = JSON.stringify(r); assert.ok(!json.includes('landmarks') && !/0\.\d{6}/.test(json), '結果沒有影像或 landmark 座標')
})

const WASM_BASE_EXPECT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const MODEL_URL_EXPECT = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

test('相機手勢：沒有手 → 待操作（要你把手放進去再測）；只看到「其他」姿勢 → 通過但註明沒看到張手 / 捏合；GPU 不行退 CPU', async () => {
  const empty = gestureSetup(); const pe = empty.probe.start(); await adv(empty.clock, 9500, 16); const re = await pe
  assert.equal(re.status, 'needs-action'); assert.equal(re.data.handsMax, 0); assert.deepEqual(re.data.gestures, []); assert.match(re.detail, /沒有偵測到手：請把手放在鏡頭前/)
  const other = gestureSetup({ vision: { script: () => [FIST()], gpuFail: true } }); const po = other.probe.start(); await adv(other.clock, 9500, 16); const ro = await po
  assert.equal(ro.status, 'pass'); assert.equal(ro.data.handsMax, 1); assert.deepEqual(ro.data.gestures, []); assert.match(ro.detail, /偵測到手，但沒有看到「張手」或「捏合」/)
  assert.equal(ro.data.delegate, 'CPU'); assert.deepEqual(other.vision.log.filter((l) => l.startsWith('create')).map((l) => l.split(':')[1]), ['GPU', 'CPU']); assert.match(ro.detail, /（CPU）/)
  assert.equal(other.vision.landmarkers.length, 1, 'GPU 失敗沒有留下辨識器'); assert.equal(other.vision.landmarkers[0].closed, 1)
})

test('相機手勢：幀率太低（新畫面每 250ms 才一幀）→ 失敗並說明；幾乎沒有幀 → 失敗；連續偵測失敗 5 次 → 失敗（含錯誤碼）；分頁被藏起來 → 略過', async () => {
  const slow = gestureSetup({ frameMs: 250, vision: { script: () => [OPEN_PALM()] } }); const ps = slow.probe.start(); await adv(slow.clock, 9500, 16); const rs = await ps
  assert.equal(rs.status, 'fail'); assert.ok(rs.data.fps < 8, 'fps ' + rs.data.fps); assert.match(rs.detail, /低於 8 FPS：手勢會不順/); assert.equal(rs.data.handsMax, 1)
  assert.equal(slow.vision.landmarkers[0].closed, 1)

  const dead = gestureSetup(); dead.video.readyState = 0   // 影片一直沒有資料
  const pd = dead.probe.start(); await adv(dead.clock, 9500, 16); const rd = await pd
  assert.equal(rd.status, 'fail'); assert.match(rd.detail, /幾乎沒有辨識到畫面（0 幀）/); assert.ok(dead.md.streams[0].tracks.every((t) => t.stopped === 1))

  const boom = gestureSetup({ vision: { detectThrows: true } }); const pb = boom.probe.start(); await adv(boom.clock, 9500, 16); const rb = await pb
  assert.equal(rb.status, 'fail'); assert.match(rb.detail, /手勢辨識執行失敗/); assert.match(rb.detail, /detect boom/); assert.equal(boom.vision.landmarkers[0].calls, 5, '連續失敗 5 次就放棄（不會一直丟例外）'); assert.equal(boom.clock.pending(), 0)

  const hid = gestureSetup({ vision: { script: () => [OPEN_PALM()] } }); const ph = hid.probe.start(); await adv(hid.clock, 1000, 16); hid.doc.hidden = true; await adv(hid.clock, 200, 16); const rh = await ph
  assert.equal(rh.status, 'skipped'); assert.match(rh.detail, /分頁在背景：瀏覽器暫停了相機與畫面，結果不準/); assert.ok(hid.md.streams[0].tracks.every((t) => t.stopped === 1)); assert.equal(hid.vision.landmarkers[0].closed, 1, '中止也放掉相機與辨識器')
})

test('相機手勢：相機被拒絕 / 找不到 / 被占用 / 逾時 → 失敗，且「不會下載模型」也不留 track；不支援（沒有相機 API / WebAssembly / 載入器）→ unsupported', async () => {
  for (const [name, re] of [['NotAllowedError', /權限被拒絕/], ['NotFoundError', /找不到可用的相機裝置/], ['NotReadableError', /占用/], ['SecurityError', /https/], ['TypeError', /https/]]) {
    const x = gestureSetup({ md: { mode: name } }); const r = await x.probe.start()
    assert.equal(r.status, 'fail', name); assert.match(r.detail, re, name); assert.equal(r.data.error, name); assert.equal(x.md.streams.length, 0); assert.equal(x.seen.attached, 0)
    assert.deepEqual(x.vision.log, [], name + '：相機被拒 → 沒有下載 WASM 與模型'); assert.equal(x.vision.landmarkers.length, 0); assert.equal(x.clock.pending(), 0)
  }
  const late = gestureSetup({ md: { mode: 'late' } }); const pl = late.probe.start(); await adv(late.clock, 31000, 1000); const rl = await pl
  assert.equal(rl.status, 'fail'); assert.match(rl.detail, /30 秒/); late.md.resolveLate(); await settle(); assert.ok(late.md.streams[0].tracks.every((t) => t.stopped === 1), '逾時後才到的串流也停掉'); assert.equal(late.seen.attached, 0)
  const over = gestureSetup({ md: { mode: 'ok' } }); let n = 0; const origGum = over.md.getUserMedia
  over.env.nav.mediaDevices.getUserMedia = function (c) { n++; if (n === 1) { const e = new Error('x'); e.name = 'OverconstrainedError'; return Promise.reject(e) } return origGum.call(this, c) }
  const po = over.probe.start(); await adv(over.clock, 9500, 16); const ro = await po
  assert.equal(n, 2, '規格不符 → 放寬成 video: true 再試一次（與主畫面手勢一致）'); assert.deepEqual(over.md.calls.at(-1), { video: true, audio: false }); assert.ok(ro.status === 'needs-action' || ro.status === 'pass')

  const noCam = await gestureSetup({ noMedia: true }).probe.start(); assert.equal(noCam.status, 'unsupported'); assert.match(noCam.detail, /getUserMedia/)
  const insecure = await gestureSetup({ noMedia: true, secure: false }).probe.start(); assert.equal(insecure.status, 'unsupported'); assert.match(insecure.detail, /https/)
  const noWasm = gestureSetup({ noWasm: true }); const rw = await noWasm.probe.start(); assert.equal(rw.status, 'unsupported'); assert.match(rw.detail, /WebAssembly/); assert.equal(noWasm.md.calls.length, 0, '不支援就不請求相機')
  const noLoader = gestureSetup({ noLoader: true }); assert.equal((await noLoader.probe.start()).status, 'unsupported'); assert.equal(noLoader.md.calls.length, 0)
})

test('相機手勢：載入失敗（離線 / 網路錯誤 / 模型下載失敗 / 逾時 60 秒 / 缺 API）→ 給清楚說明並記為失敗；相機與辨識器都放掉；逾時後才建好的辨識器立刻 close', async () => {
  const off = gestureSetup({ offline: true, vision: { modelError: true } }); const ro = await off.probe.start()
  assert.equal(ro.status, 'fail'); assert.match(ro.detail, /目前離線：第一次啟用需要下載手勢模型（約 8 MB）/); assert.equal(ro.data.offline, true); assert.equal(ro.data.phase, 'model'); assert.ok(off.md.streams[0].tracks.every((t) => t.stopped === 1)); assert.equal(off.seen.detached, 1)
  const net = gestureSetup({ vision: { modelError: true } }); const rn = await net.probe.start()
  assert.equal(rn.status, 'fail'); assert.match(rn.detail, /手勢模型載入失敗（無法連到 jsDelivr 或 Google 儲存空間）/); assert.match(rn.detail, /model download failed/); assert.equal(rn.data.offline, false)
  const fs = gestureSetup({ vision: { filesetError: true } }); assert.match((await fs.probe.start()).detail, /fileset failed/)
  const imp = gestureSetup({ importVision: () => Promise.reject(new Error('chunk load failed')) }); const ri = await imp.probe.start(); assert.equal(ri.status, 'fail'); assert.match(ri.detail, /chunk load failed/); assert.ok(imp.md.streams[0].tracks.every((t) => t.stopped === 1))
  const impThrow = gestureSetup({ importVision: () => { throw new Error('sync import boom') } }); const rit = await impThrow.probe.start(); assert.equal(rit.status, 'fail'); assert.match(rit.detail, /sync import boom/)
  const noApi = gestureSetup({ importVision: () => Promise.resolve({}) }); const rna = await noApi.probe.start(); assert.equal(rna.status, 'fail'); assert.match(rna.detail, /MediaPipe API missing/)
  const viaDefault = gestureSetup({ importVision: () => Promise.resolve({ default: { FilesetResolver: { forVisionTasks() { return Promise.resolve({}) } }, HandLandmarker: { createFromOptions() { return Promise.resolve({ detectForVideo() { return { landmarks: [] } }, close() {} }) } } } }) })
  const pdf = viaDefault.probe.start(); await adv(viaDefault.clock, 9500, 16); assert.equal((await pdf).status, 'needs-action', '模組以 default 匯出也認得（與主畫面一致）')

  const hang = gestureSetup({ vision: { modelHang: true } }); const ph = hang.probe.start(); await adv(hang.clock, 61000, 1000); const rh = await ph
  assert.equal(rh.status, 'fail'); assert.equal(rh.data.error, 'TimeoutError'); assert.ok(hang.md.streams[0].tracks.every((t) => t.stopped === 1)); assert.equal(hang.clock.pending(), 0)

  const vo = { lateModel: true }
  const late = gestureSetup({ vision: vo }); const pl = late.probe.start(); await settle(); late.probe.stop(); assert.equal((await pl).status, 'skipped')
  assert.ok(late.md.streams[0].tracks.every((t) => t.stopped === 1), '模型還在載入時按停止 → 相機立刻停'); assert.equal(late.vision.landmarkers[0].closed, 0, '還沒建好，沒東西可關')
  vo.lateResolve(); await settle()
  assert.equal(late.vision.landmarkers[0].closed, 1, '按停止之後才建好的辨識器立刻 close（不留在記憶體裡）'); assert.equal(late.seen.updates.filter((u) => u.phase === 'running').length, 0, '停止後不會進入偵測'); assert.equal(late.clock.pending(), 0)
})

test('相機手勢：任何階段按停止 / 離開頁面（stop）→ 同步停 track、關辨識器、放掉預覽；遲到的辨識器 / 串流立刻釋放；結果是略過', async () => {
  // 1) 等相機授權時就停（getUserMedia 還沒回來）
  const a = gestureSetup({ md: { mode: 'late' } }); const pa = a.probe.start(); await settle(); a.probe.stop()
  assert.deepEqual(a.seen.running, [true, false]); assert.equal(a.clock.pending(), 0); assert.equal((await pa).status, 'skipped'); a.md.resolveLate(); await settle()
  assert.ok(a.md.streams[0].tracks.every((t) => t.stopped === 1), '之後才到的串流立刻停掉'); assert.equal(a.seen.attached, 0); assert.deepEqual(a.vision.log, [])
  // 2) 載入模型時停：模型建好之後（遲到）立刻 close
  const bo = { lateModel: true }
  const b = gestureSetup({ vision: bo }); const pb = b.probe.start(); await settle(); assert.equal(b.vision.landmarkers.length, 1)
  b.probe.stop(); assert.ok(b.md.streams[0].tracks.every((t) => t.stopped === 1)); assert.equal(b.seen.detached, 1)
  assert.equal((await pb).status, 'skipped'); assert.equal(b.clock.pending(), 0); bo.lateResolve(); await settle(); assert.equal(b.vision.landmarkers[0].closed, 1, '遲到的辨識器立刻 close')
  // 3) 偵測中停：同步關閉
  const c = gestureSetup({ vision: { script: () => [OPEN_PALM()] } }); const pc = c.probe.start(); await adv(c.clock, 2000, 16)
  const lm = c.vision.landmarkers[0]; const callsBefore = lm.calls; assert.ok(callsBefore > 50)
  c.probe.stop(); assert.equal(lm.closed, 1, 'stop() 同步 close 辨識器'); assert.ok(c.md.streams[0].tracks.every((t) => t.stopped === 1), '同步停 track'); assert.equal(c.seen.detached, 1); assert.deepEqual(c.seen.draws.at(-1), [])
  assert.equal(c.clock.pending(), 0, '沒有殘留計時器'); assert.equal((await pc).status, 'skipped'); await adv(c.clock, 500, 16); assert.equal(lm.calls, callsBefore, '停止後不再推論'); assert.equal(lm.closed, 1)
  // 4) 預覽卡住 / 沒有預覽元素
  const d2 = gestureSetup({ attach: () => Promise.resolve(null) }); const rd = await d2.probe.start(); assert.equal(rd.status, 'fail'); assert.match(rd.detail, /沒有可用的預覽畫面/); assert.ok(d2.md.streams[0].tracks.every((t) => t.stopped === 1))
  const hang = gestureSetup({ attach: () => new Promise(() => {}) }); const ph = hang.probe.start(); await adv(hang.clock, 5500, 250); assert.equal((await ph).status, 'fail'); assert.ok(hang.md.streams[0].tracks.every((t) => t.stopped === 1))
  // 5) 沒有視訊軌 / 中途被拔除
  const none = gestureSetup({ md: { kinds: [] } }); const rn = await none.probe.start(); assert.equal(rn.status, 'fail'); assert.match(rn.detail, /視訊軌/)
  const e2 = gestureSetup({ vision: { script: () => [] } }); const pe = e2.probe.start(); await adv(e2.clock, 500, 16); e2.md.streams[0].tracks[0].onended(); assert.ok(e2.seen.updates.some((u) => u.ended === true)); e2.probe.stop(); assert.equal(e2.md.streams[0].tracks[0].onended, null); await pe
})

test('相機手勢：環境全是壞的（任何屬性存取都丟例外）→ 失敗不丟例外；browserEnv 提供 importVision / WebAssembly，且 import 時完全沒有呼叫（不會提前下載 MediaPipe）', async () => {
  const boom = new Proxy({}, { get() { throw new Error('boom') } })
  const r = await D.createProbe('gesture', makeEnv({ nav: boom, win: boom, doc: boom, WebAssembly: {}, importVision: () => Promise.resolve({}) }).env).start(); assert.equal(r.status, 'fail'); assert.match(r.detail, /boom/)
  const be = D.browserEnv({}); assert.equal(be.WebAssembly, null); assert.equal(typeof be.importVision, 'function')
  const { g } = strictGlobal(); g.WebAssembly = {}; assert.deepEqual(D.browserEnv(g).WebAssembly, {})
})

// ───────────────────────────── 導引：依裝置能力略過 ─────────────────────────────
function fullGuideEnv() {
  const x = fullEnv({
    nav: { mediaDevices: fakeMedia() }, win: { open() {}, DeviceOrientationEvent: function DeviceOrientationEvent() {}, WebAssembly: {} },
    env: { narrator: fakeNarrator(), WebAssembly: {}, importVision: () => Promise.resolve({}) },
  })
  return x
}

test('導引：能力齊全的裝置 → 15 項互動檢查一項都不略過；每項的「能力檢查」與檢查本體遇到缺 API 時的結果一致（不支援 → 同一份原因）', async () => {
  const { planGuide } = await import('./diagnosticsGuide.js')
  const x = fullGuideEnv()
  const plan = planGuide(D.getInteractiveChecks(), (id) => D.guideSupport(id, x.env))
  assert.deepEqual(plan.skipped, []); assert.equal(plan.steps.length, 15); assert.deepEqual(plan.steps.slice(0, 3), ['narration', 'watchdog', 'gesture'])

  // 全空的環境：每一項都不支援；原因與「真的按下去」得到的 unsupported 結果同一句
  const bare = () => makeEnv({ nav: strict({}), win: fakeWin(), doc: strict({ documentElement: {} }) }).env
  for (const c of D.getInteractiveChecks()) {
    const sup = D.guideSupport(c.id, bare())
    if (c.id === 'pointer') { assert.equal(sup, null, '觸控畫板一定可以做（沒有觸控筆由使用者略過）'); continue }
    assert.ok(sup && sup.status === 'unsupported', c.id + ' 應該不支援'); assert.ok(sup.msg, c.id + ' 有原因')
    const ran = await D.createProbe(c.id, bare(), {}).start()
    assert.equal(ran.status, 'unsupported', c.id + '：檢查本體也回 unsupported')
    if (c.id === 'watchdog') assert.ok(ran.detail.startsWith(D.renderDetail(sup)), '看門狗：原因在最前面，後面還附判定驗證與說明'); else assert.equal(ran.detail, D.renderDetail(sup), c.id + '：原因文字一致')
  }
  assert.equal(D.guideSupport('nope', {}), null); assert.equal(D.guideSupport('cam', null).status, 'unsupported', 'env 是 null 也不丟例外')
})

test('導引：iPhone Safari 這類裝置（沒有震動 / MIDI / 全螢幕 / 螢幕管理 / 手把…）→ 這些項目自動略過並註明原因；有的照常做', async () => {
  const { planGuide } = await import('./diagnosticsGuide.js')
  const x = fullGuideEnv()
  const iphone = { ...x.env, nav: strict({ mediaDevices: fakeMedia(), userAgent: 'iPhone', maxTouchPoints: 5 }), win: fakeWin({ SpeechRecognition: undefined, webkitSpeechRecognition: function () {}, open() {}, DeviceOrientationEvent: function () {} }), doc: strict({ documentElement: {} }) }
  const plan = planGuide(D.getInteractiveChecks(), (id) => D.guideSupport(id, iphone))
  assert.deepEqual(plan.skipped.map((s) => s.id).sort(), ['fullscreen', 'gamepad', 'midi', 'rumble', 'screens', 'vibrate'].sort())
  assert.deepEqual(plan.steps, ['narration', 'watchdog', 'gesture', 'cam', 'mic', 'speech', 'popup', 'pointer', 'orient'])
  const reasons = Object.fromEntries(plan.skipped.map((s) => [s.id, D.renderDetail(s.outcome)]))
  assert.match(reasons.vibrate, /iPhone Safari/); assert.match(reasons.midi, /Web MIDI/); assert.match(reasons.fullscreen, /iPhone Safari 不支援網頁全螢幕/); assert.match(reasons.screens, /getScreenDetails/); assert.match(reasons.gamepad, /Gamepad/)
  // 英文原因（切換語系後重新翻譯）
  registerEn(en); registerEn(en2); setLocale('en')
  try { assert.match(D.renderDetail(plan.skipped.find((s) => s.id === 'vibrate').outcome), /No vibration API/) } finally { setLocale('zh') }
  // 沒有麥克風 / 相機 API 的裝置：相機、麥克風、相機手勢一起略過
  const noMedia = { ...x.env, nav: strict({}) }
  assert.deepEqual(planGuide(D.getInteractiveChecks(), (id) => D.guideSupport(id, noMedia)).skipped.map((s) => s.id).filter((id) => ['cam', 'mic', 'gesture'].includes(id)).sort(), ['cam', 'gesture', 'mic'])
})

// ───────────────────────────── 報告：裝置備註 ─────────────────────────────
test('報告的裝置備註：沒填（或全是空白）→ 輸出與以前完全一樣（沒有段落、JSON 沒有 deviceNote、隱私聲明不變）', () => {
  const results = { ls: D.makeResult(D.getCheck('ls'), { status: 'pass', msg: { key: '寫入、讀回、刪除都成功' } }, 4) }
  const base = D.buildReport({ results, meta: {} })
  for (const note of [undefined, null, {}, { model: '', os: '', browser: '', tester: '', memo: '' }, { model: '  ', memo: '\n \n' }, 'x', 5, []]) {
    const r = D.buildReport({ results, meta: {}, note })
    assert.equal(r.markdown, base.markdown, JSON.stringify(note)); assert.equal(r.text, base.text); assert.deepEqual(r.json, base.json); assert.ok(!('deviceNote' in r.json))
  }
  assert.ok(!base.text.includes('裝置備註')); assert.match(base.markdown, /^- 本報告不含個人資料、IP、影像或音訊。$/m); assert.ok(!base.markdown.includes('除外'))
})

test('報告的裝置備註：只有填了的欄位出現（Markdown 段落 + JSON deviceNote）；多行備註的續行縮排；段落在摘要與表格之間；表格列數不變', () => {
  const x = { ls: D.makeResult(D.getCheck('ls'), { status: 'pass', msg: { key: '寫入、讀回、刪除都成功' } }, 4) }
  const rep = D.buildReport({ results: x, meta: {}, note: { model: ' iPhone 15 ', os: '', browser: 'Safari 18', tester: '', memo: '第一行\n\n第二行\n' } })
  assert.deepEqual(rep.json.deviceNote, { model: 'iPhone 15', browser: 'Safari 18', memo: '第一行\n\n第二行' }, 'JSON：只有填的欄位，值已 trim')
  assert.deepEqual(Object.keys(rep.json.deviceNote), ['model', 'browser', 'memo']); assert.ok(!('os' in rep.json.deviceNote) && !('tester' in rep.json.deviceNote), '沒填的欄位連鍵都沒有')
  const lines = rep.markdown.split('\n')
  const h = lines.indexOf('## 裝置備註'); assert.ok(h > 0, 'Markdown 有「裝置備註」段落')
  assert.deepEqual(lines.slice(h, h + 5), ['## 裝置備註', '- 裝置型號：iPhone 15', '- 瀏覽器與版本：Safari 18', '- 備註：第一行', '  第二行'], '續行縮排 2 格，空行略過')
  assert.ok(!rep.markdown.includes('作業系統與版本：') && !rep.markdown.includes('測試人：'), '沒填的欄位不出現')
  assert.ok(lines.findIndex((l) => l.startsWith('- 摘要：')) < h && h < lines.findIndex((l) => l.startsWith('| 群組')), '在摘要之後、表格之前')
  assert.equal(lines.filter((l) => l.startsWith('| ')).length, 40 + 2, '表格不受影響')
  assert.match(rep.markdown, /^- 本報告不含個人資料、IP、影像或音訊（你自己填寫的裝置備註除外）。$/m, '有備註時隱私聲明如實改成「除了你自己填寫的裝置備註」')
  const m = rep.text.match(/```json\n([\s\S]*)\n```\n$/); assert.deepEqual(JSON.parse(m[1]).deviceNote, rep.json.deviceNote, '複製的文字尾端 JSON 也有 deviceNote')
  const all = D.buildReport({ results: x, meta: {}, note: { model: 'A', os: 'B', browser: 'C', tester: 'D', memo: 'E' } })
  const al = all.markdown.split('\n'); const ai = al.indexOf('## 裝置備註')
  assert.deepEqual(al.slice(ai, ai + 6), ['## 裝置備註', '- 裝置型號：A', '- 作業系統與版本：B', '- 瀏覽器與版本：C', '- 測試人：D', '- 備註：E'])
})

test('報告的裝置備註：長度上限（備註 ≤ 500 字）；危險字元清理（三個反引號不會破壞程式碼區塊、控制字元 / 雙向控制字元去掉）；Markdown 與 JSON 一致', () => {
  const dirty = 'X' + String.fromCharCode(0x202e) + 'Y' + String.fromCharCode(0) + 'Z'
  const rep = D.buildReport({ results: {}, meta: {}, note: { memo: '字'.repeat(700), tester: '人'.repeat(90), model: dirty } })
  assert.equal(Array.from(rep.json.deviceNote.memo).length, 500); assert.equal(Array.from(rep.json.deviceNote.tester).length, 40); assert.equal(rep.json.deviceNote.model, 'XYZ')
  assert.ok(rep.markdown.includes('- 備註：' + '字'.repeat(500)) && !rep.markdown.includes('字'.repeat(501)))
  const fence = D.buildReport({ results: {}, meta: {}, note: { memo: '前\n```\n# 標題\n```json\n{"x":1}\n```\n後' } })
  assert.equal((fence.text.match(/```/g) || []).length, 2, '整份文字只有 JSON 區塊自己的一對圍欄'); assert.ok(fence.json.deviceNote.memo.includes("'''")); assert.ok(fence.text.trimEnd().endsWith('```'))
  assert.doesNotThrow(() => JSON.parse(fence.text.match(/```json\n([\s\S]*)\n```\n$/)[1]))
})

test('報告的裝置備註：切成英文後段落標題 / 欄位標籤 / 隱私聲明都是英文（備註內容原樣，不翻譯）；中文模式輸出不變', () => {
  const note = { model: 'iPhone 15', tester: '小明', memo: '第 2 台' }
  const zh = D.buildReport({ results: {}, meta: {}, note }).markdown
  registerEn(en); registerEn(en2); setLocale('en')
  try {
    const rep = D.buildReport({ results: {}, meta: {}, note, locale: 'en' })
    for (const line of ['## Device notes', '- Device model: iPhone 15', '- Tester: 小明', '- Notes: 第 2 台', '- This report contains no personal data, IP address, images or audio (except the device notes you filled in yourself).']) assert.ok(rep.markdown.split('\n').includes(line), line)
    assert.ok(!/OS and version|Browser and version/.test(rep.markdown), '沒填的欄位不出現')
    const noChinese = rep.markdown.split('\n').filter((l) => !/小明|第 2 台/.test(l)).join('\n'); assert.ok(!/[㐀-鿿]/.test(noChinese), '除了使用者自己填的內容，沒有中文殘留：' + (noChinese.match(/.*[㐀-鿿].*/) || [''])[0])
  } finally { setLocale('zh') }
  assert.equal(D.buildReport({ results: {}, meta: {}, note }).markdown, zh)
})

test('隱私：草稿在儲存裡、或有別人的名字，只要畫面沒明確傳入 note 就不會進報告；備註以外的內容與沒有備註時完全相同；仍然沒有 IP / 連線碼', async () => {
  const { saveNote, loadNote } = await import('./diagnosticsNote.js')
  const mem = new Map(); const storage = { get: (k) => (mem.has(k) ? mem.get(k) : null), set: (k, v) => { mem.set(k, v) }, remove: (k) => { mem.delete(k) } }
  saveNote({ tester: 'Alice Chen', memo: '客戶的 iPhone，電話 0912345678' }, storage)
  assert.equal(loadNote(storage).tester, 'Alice Chen', '草稿確實存在這台裝置')
  const x = fullEnv(); const meta = D.collectMeta(x.env, 0)
  const without = D.buildReport({ results: {}, meta })
  assert.ok(!without.text.includes('Alice') && !without.text.includes('0912345678'), '草稿不會自動進報告：只有按複製 / 下載時、由畫面明確傳入 note 才會')
  const withNote = D.buildReport({ results: {}, meta, note: loadNote(storage) })
  assert.ok(withNote.text.includes('Alice Chen') && withNote.text.includes('0912345678'), '使用者自己填的備註原樣進報告（畫面上已說明會原樣寫進報告）')
  const strip = (t) => t.split('\n').filter((l) => !l.includes('Alice') && !l.includes('0912345678') && !l.startsWith('## ') && !l.startsWith('  ') && !l.includes('除外') && !l.includes('不含個人資料')).join('\n').replace(/\n{3,}/g, '\n\n')
  assert.equal(strip(withNote.markdown), strip(without.markdown), '備註以外的內容一字不差')
  for (const secret of ['192.168', 'remote=', 'abc123']) assert.ok(!withNote.text.includes(secret), '仍然沒有 IP / 連線碼：' + secret)
})

test('診斷入口連結：一般 / 導引模式（&guided=1）、語系參數位置不變；面板那一節有「開啟導引模式」連結並仍走 formatSummaryLine', () => {
  assert.equal(diagnosticsHref('en', { guided: true }), '?diagnostics=1&guided=1&lang=en'); assert.equal(diagnosticsHref('zh', { guided: true }), '?diagnostics=1&guided=1&lang=zh')
  assert.equal(diagnosticsHref(undefined, { guided: true }), '?diagnostics=1&guided=1'); assert.equal(diagnosticsHref('fr', { guided: true }), '?diagnostics=1&guided=1')
  assert.equal(diagnosticsHref('en', { guided: false }), '?diagnostics=1&lang=en'); assert.equal(diagnosticsHref('en', {}), '?diagnostics=1&lang=en'); assert.equal(diagnosticsHref('en', null), '?diagnostics=1&lang=en')
  const src = readFileSync(new URL('../ui/devices/DiagnosticsSection.jsx', import.meta.url), 'utf8')
  assert.match(src, /diagnosticsHref\(locale, \{ guided: true \}\)/); assert.match(src, /t\('開啟導引模式'\)/); assert.match(src, /formatSummaryLine\(sum, t, localeTag\(locale\)\)/, '「上次診斷」摘要維持')
  assert.match(src, /target="_blank" rel="noopener noreferrer"/)
})

// ───────────────────────────── 診斷頁保持輕量（不可靜態 import three / store / MediaPipe）─────────────────────────────
import { statSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function staticImportGraph(entry) {
  const seen = new Map()   // 絕對路徑 → { locals, bare }
  const rx = /^\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm
  const visit = (file) => {
    if (seen.has(file)) return
    const src = readFileSync(file, 'utf8')
    const rec = { locals: [], bare: [] }
    seen.set(file, rec)
    for (const m of src.matchAll(rx)) {
      const spec = m[1]
      if (/\.css$/.test(spec)) continue
      if (spec.startsWith('.')) {
        const base = resolve(dirname(file), spec)
        const hit = [base, base + '.js', base + '.jsx', base + '.mjs'].find((p) => existsSync(p) && statSync(p).isFile())
        if (hit) { rec.locals.push(hit); visit(hit) }
      } else rec.bare.push(spec)
    }
  }
  visit(entry)
  return seen
}
const SRC = fileURLToPath(new URL('..', import.meta.url))

test('診斷頁輕量：靜態 import 的傳遞閉包裡沒有 three / r3f / MediaPipe / store / 場景 / 服務 / 導覽 / 遙控頁；只有 react 與 zustand；MediaPipe 只有 browserEnv 裡的動態 import', () => {
  const g = staticImportGraph(join(SRC, 'DiagnosticsApp.jsx'))
  const files = [...g.keys()].map((f) => f.slice(SRC.length))
  const bare = new Set([...g.values()].flatMap((r) => r.bare))
  assert.deepEqual([...bare].sort(), ['react', 'zustand'], '外部套件只有 react 與 zustand：' + [...bare])
  for (const f of files) {
    assert.ok(!/^(store|scene|services|remote|ui)\//.test(f), '不該被拉進診斷頁：' + f)
    assert.ok(!/(^|\/)(tour[A-Za-z]*|useStore|Scene3D|App|AudienceApp|RemoteApp)\.jsx?$/.test(f) || f === 'DiagnosticsApp.jsx', '不該被拉進診斷頁：' + f)
  }
  for (const need of ['lib/diagnostics.js', 'lib/diagnosticsGuide.js', 'lib/diagnosticsNote.js', 'lib/gestures.js', 'lib/narration.js', 'lib/resilience.js', 'lib/hands.js', 'DiagnosticsGuide.jsx', 'DiagnosticsNote.jsx']) assert.ok(files.includes(need), need + ' 在閉包裡')
  const diag = readFileSync(join(SRC, 'lib/diagnostics.js'), 'utf8')
  assert.ok(!/^\s*import\s[^\n]*@mediapipe/m.test(diag), 'diagnostics.js 沒有靜態 import MediaPipe')
  assert.equal((diag.match(/import\('@mediapipe\/tasks-vision'\)/g) || []).length, 1); assert.match(diag, /importVision: \(\) => import\('@mediapipe\/tasks-vision'\)/)
  for (const f of ['DiagnosticsApp.jsx', 'DiagnosticsGuide.jsx', 'DiagnosticsNote.jsx', 'lib/diagnosticsNote.js', 'lib/diagnosticsGuide.js']) assert.ok(!/mediapipe|from 'three'|useStore/i.test(readFileSync(join(SRC, f), 'utf8').replace(/\/\/.*$/gm, '')), f)
  // 主畫面「裝置」面板那一節只 import 摘要小檔案：不會把整個診斷邏輯拉進主 bundle
  const sec = [...staticImportGraph(join(SRC, 'ui/devices/DiagnosticsSection.jsx')).keys()].map((f) => f.slice(SRC.length))
  for (const f of sec) assert.ok(!/lib\/(diagnostics|diagnosticsNote|diagnosticsGuide|hands|gestures|narration|resilience)\.js$/.test(f), '面板那一節不該 import：' + f)
  assert.ok(sec.includes('lib/diagnosticsSummary.js'))
})

test('沒有 Illegal invocation 的寫法：新檢查不把原生方法存成變數再呼叫（speak / getVoices / addEventListener / getUserMedia / createFromOptions / getHighEntropyValues 都以方法呼叫）', () => {
  const src = readFileSync(join(SRC, 'lib/diagnostics.js'), 'utf8').replace(/\/\/.*$/gm, '')
  const seg = src.slice(src.indexOf('export const NARRATION_LINE'), src.indexOf('export function getGroups'))
  assert.ok(seg.length > 5000, '取到新檢查那一段')
  for (const bad of [/=\s*synth\.(getVoices|addEventListener|removeEventListener)\s*[;\n]/, /=\s*nar\.(speak|cancel|dispose)\s*[;\n]/, /=\s*md\.getUserMedia\s*[;\n]/, /=\s*HL\.createFromOptions\s*[;\n]/, /=\s*FR\.forVisionTasks\s*[;\n]/, /=\s*lm\.(detectForVideo|close)\s*[;\n]/, /=\s*env\.(raf|cancelRaf)\s*[;\n]/]) assert.ok(!bad.test(seg), '不該把原生方法存成變數：' + bad)
  const note = readFileSync(join(SRC, 'lib/diagnosticsNote.js'), 'utf8').replace(/\/\/.*$/gm, '')
  assert.ok(!/=\s*uad\.getHighEntropyValues\s*[;\n]/.test(note)); assert.match(note, /uad\.getHighEntropyValues\(\[/)
})
