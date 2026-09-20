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
const SPEC_INTER = ['cam', 'mic', 'speech', 'midi', 'gamepad', 'rumble', 'pointer', 'vibrate', 'orient', 'screens', 'popup', 'fullscreen']

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
  registerEn(en); setLocale('en')
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
  assert.equal(rep.json.results.length, D.getChecks().length); assert.equal(rep.json.summary.total, 37)
  assert.equal(rep.json.summary.pass + rep.json.summary.fail + rep.json.summary.unsupported + rep.json.summary.pending, 37)
  assert.equal(rep.json.summary.pass, 25); assert.equal(rep.json.summary.pending, 12)
  const row = rep.json.results.find((r) => r.id === 'gl'); assert.deepEqual(Object.keys(row).slice(0, 6), ['id', 'group', 'title', 'status', 'detail', 'ms']); assert.equal(row.status, 'pass'); assert.equal(row.title, 'WebGL 圖形')
  assert.equal(rep.json.results.find((r) => r.id === 'cam').status, 'not-run'); assert.equal(rep.json.results.find((r) => r.id === 'cam').ms, null)
  for (const k of ['app', 'version', 'generatedAt', 'url', 'userAgent', 'screen', 'summary', 'results', 'locale']) assert.ok(k in rep.json, k)
  const lines = rep.markdown.split('\n')
  assert.equal(lines[0], '# MidiSea 裝置診斷報告'); assert.ok(lines.some((l) => l === '| 群組 | 項目 | 狀態 | 詳情 | 耗時 (ms) |')); assert.ok(lines.some((l) => l === '| --- | --- | --- | --- | ---: |'))
  assert.ok(lines.some((l) => /^- 產生時間：2026-09-20T00:00:00\.000Z$/.test(l))); assert.ok(lines.some((l) => /^- 摘要：通過 25、失敗 0、不支援 0、尚未測 12（共 37 項）$/.test(l)))
  assert.equal(lines.filter((l) => l.startsWith('| ')).length, 37 + 2, '每項一列 + 表頭 + 分隔線')
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
  registerEn(en); setLocale('en')
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
  registerEn(en); setLocale('en')
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
