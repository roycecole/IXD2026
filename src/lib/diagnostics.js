// 裝置診斷（?diagnostics=1）的純邏輯：檢查項定義 + 執行器 + 報告格式。
// 展前要在現場的實際硬體逐項檢查（相機手勢 / 語音 / 觸覺 / AR / 雙螢幕 / 觸控筆…）並留下證據；畫面在 src/DiagnosticsApp.jsx。
//
// 設計重點
//   · 環境全部可注入：env = { nav, win, doc, now, setTimeout, clearTimeout, raf, createChannel, MediaRecorder, AudioContext, Intl, URL, Blob, makeFile, getStorage, randomId }。
//     缺的欄位 = 該功能不存在（回報 unsupported / fail，不丟例外）。瀏覽器版本由 browserEnv() 提供（呼叫時才碰全域，import 時不碰任何 API）。
//   · 一律「以方法呼叫」原生函式（env.nav.mediaDevices.getUserMedia(…) 而不是先存成變數再呼叫）；計時器 / rAF 在 browserEnv 裡包一層箭頭函式。
//     瀏覽器對「脫離物件的原生函式」會丟 TypeError: Illegal invocation，Node 不會——測試用「會檢查 this 的假物件」把關。
//   · 每個檢查回傳 { id, group, status, detail, ms }：status = pass | fail | unsupported | needs-action | skipped | info（沒執行 = 尚未測，不在結果裡）。
//     另外附 msg（{ key, params } 訊息描述，畫面用目前語系重新翻譯，所以切換語言不必重跑）與 data（結構化量測值，供 JSON 報告）。
//   · 自動檢查（runAutoChecks）不需要使用者手勢；互動檢查（createProbe）在使用者按下按鈕後才啟動，
//     任何結束路徑（完成 / 錯誤 / 逾時 / stop() / 卸載）都會停掉所有 track / 辨識 / 計時器 / 監聽（測試逐一驗證）。
//   · 隱私：報告不含個資 / IP / 影像 / 音訊——相機 / 麥克風 / 螢幕的 label 不收，語音辨識的文字只報字數，網址去掉 #hash。
//     例外（刻意保留，README 與診斷頁都要如實說明）：Web MIDI 埠名稱與手把的 id 字串會照實列出——「有沒有偵測到 KORG 控制器」就靠它判讀；
//     藍牙 / 網路 MIDI 埠與手把有時以擁有者命名，所以貼出報告前請看一眼（測試釘住：diagnostics.test.mjs「報告的隱私範圍」）。
//
// 註冊表（getChecks）在函式裡才建立、不在模組頂層呼叫任何函式：主畫面只 import diagnosticsSummary.js，不會把這個檔案拉進主 bundle。
import { T, t } from '../i18n/index.js'
export { DIAG_LS_KEY, loadSummary, saveSummary, sanitizeSummary, formatWhen, diagnosticsHref } from './diagnosticsSummary.js'

export const DIAG_VERSION = 1
export const STATUSES = ['pass', 'fail', 'unsupported', 'needs-action', 'skipped', 'info']

// 各項逾時 / 取樣長度（毫秒）
export const LIMITS = {
  guardMs: 8000,                    // 單項自動檢查的保險逾時（任何檢查卡住都不會拖住整個「快速檢查」）
  fpsMs: 2000, fpsGraceMs: 2500, fpsPass: 45,
  bcMs: 1500, wakeLockMs: 3000, xrMs: 4000, swMs: 3000, probeMs: 1500,
  permMs: 30000,                    // getUserMedia / MIDI / 螢幕資訊：等權限提示的上限
  camFpsMs: 1500, camPreviewMs: 30000, attachMs: 5000,
  micMs: 3000, micStepMs: 100, micPass: 0.02,
  speechMs: 5000, speechStartMs: 20000, speechEndMs: 2000,
  orientReadyMs: 3000,
  watchMaxMs: 180000,               // 「持續監看」類（MIDI / 手把 / 感測器）最長監看時間，避免忘了關
  gamepadPollMs: 80, emitMs: 100,
  fsHoldMs: 1200, fsMs: 3000, rumbleMs: 3000,
  vibratePattern: [200, 100, 200, 100, 400],
}

// ───────────────────────────── 小工具 ─────────────────────────────
const isFn = (v) => typeof v === 'function'
const isObj = (v) => v !== null && typeof v === 'object'
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const round = (v, p = 0) => { const k = 10 ** p; return Math.round(v * k) / k }
const d = (key, params) => (params ? { key, params } : { key })   // 訊息描述：key 必須是 T('…') 標記過的中文原文
const tset = (env, fn, ms) => (isFn(env.setTimeout) ? env.setTimeout(fn, ms) : globalThis.setTimeout(fn, ms))
const tclear = (env, id) => { if (isFn(env.clearTimeout)) env.clearTimeout(id); else globalThis.clearTimeout(id) }
const tnow = (env) => (isFn(env.now) ? env.now() : Date.now())
const safe = (fn) => { try { return fn() } catch (e) { return undefined } }

export function fmtBytes(n) {
  const v = num(n)
  if (v == null) return '—'
  if (v >= 1e9) return round(v / 1e9, 1) + ' GB'
  if (v >= 1e6) return round(v / 1e6, 1) + ' MB'
  if (v >= 1e3) return round(v / 1e3, 1) + ' KB'
  return v + ' B'
}
const errName = (e) => String((e && e.name) || 'Error')
const errText = (e) => (errName(e) + (e && e.message ? ': ' + String(e.message).slice(0, 120) : ''))
const failFromError = (e) => ({ status: 'fail', msg: d(T('發生例外：{err}'), { err: errText(e) }) })
const timeoutError = () => { const e = new Error('timeout'); e.name = 'TimeoutError'; return e }
const cancelledError = () => { const e = new Error('cancelled'); e.name = 'CancelledError'; return e }

// 「取消」：長時間的檢查註冊清理函式，取消（或逾時）時一律執行；重複取消無害
export function createCancel() {
  let cancelled = false
  const subs = new Set()
  return {
    get cancelled() { return cancelled },
    cancel() { if (cancelled) return; cancelled = true; for (const f of [...subs]) safe(f); subs.clear() },
    onCancel(fn) { if (cancelled) { safe(fn); return () => {} } subs.add(fn); return () => { subs.delete(fn) } },
  }
}

// 逾時競賽：ms 內沒結果 → reject TimeoutError；逾時「之後」才到的結果交給 onLate（例如立刻把遲到的 stream 停掉），不會變成沒人管的資源
export function raceTimeout(env, promise, ms, onLate) {
  return new Promise((resolve, reject) => {
    let done = false
    const timer = tset(env, () => { if (done) return; done = true; reject(timeoutError()) }, ms)
    Promise.resolve(promise).then(
      (v) => { if (done) { if (onLate) safe(() => onLate(v)); return } done = true; tclear(env, timer); resolve(v) },
      (e) => { if (done) return; done = true; tclear(env, timer); reject(e) },
    )
  })
}

// 每 ms 最多送出一次（合併期間內的資料）；取消後不再送。給高頻事件（MIDI / 手把 / 感測器）用，避免畫面每幀重繪。
function makeThrottle(env, fn, ms) {
  let last = -Infinity, timer = null, pending = null, dead = false
  const flush = () => { timer = null; if (dead || !pending) return; const p = pending; pending = null; last = tnow(env); fn(p) }
  return {
    push(patch) {
      if (dead) return
      pending = pending ? { ...pending, ...patch } : patch
      const wait = last + ms - tnow(env)
      if (wait <= 0) { if (timer != null) { tclear(env, timer); timer = null } flush() }
      else if (timer == null) timer = tset(env, flush, wait)
    },
    cancel() { dead = true; pending = null; if (timer != null) { tclear(env, timer); timer = null } },
  }
}

// ───────────────────────────── 訊息 / 結果 ─────────────────────────────
// 訊息描述：字串（原樣）| { key, params }（key 是中文原文；params 的值可以是數字 / 字串 / 巢狀訊息）| 陣列（用「 · 」串起來，null 略過）
export function fmtMsg(m, tr = t) {
  if (m == null || m === false) return ''
  if (typeof m === 'string') return m
  if (Array.isArray(m)) return m.map((x) => fmtMsg(x, tr)).filter(Boolean).join(' · ')
  if (!isObj(m) || typeof m.key !== 'string') return ''
  const params = {}
  for (const [k, v] of Object.entries(m.params || {})) params[k] = isObj(v) ? fmtMsg(v, tr) : v
  return tr(m.key, params)
}
export function renderDetail(r, tr = t) { return r ? (r.msg != null ? fmtMsg(r.msg, tr) : String(r.detail || '')) : '' }

// out：{ status, msg?, data?, ms? } → 完整結果 { id, group, status, detail, ms, msg?, data? }
export function makeResult(check, out, elapsedMs) {
  const o = out || {}
  const r = {
    id: check.id, group: check.group,
    status: STATUSES.includes(o.status) ? o.status : 'fail',
    detail: fmtMsg(o.msg),
    ms: Math.max(0, Math.round(num(o.ms) != null ? o.ms : (num(elapsedMs) || 0))),
  }
  if (o.msg != null && typeof o.msg !== 'string') r.msg = o.msg
  if (o.data != null) r.data = o.data
  return r
}

// 狀態的顯示文字（key，顯示時再 t()）；徽章要「顏色 + 文字」，不能只靠顏色
export function statusKey(status) {
  switch (status) {
    case 'pass': return T('通過')
    case 'fail': return T('失敗')
    case 'unsupported': return T('不支援')
    case 'needs-action': return T('待操作')
    case 'skipped': return T('已略過')
    case 'info': return T('資訊')
    default: return T('尚未測')
  }
}

// 總覽：通過（含資訊項：有執行、沒有問題）/ 失敗 / 不支援 / 尚未測（沒執行、待操作、已略過）。results：id → 結果。
export function summarize(checks, results) {
  const s = { total: checks.length, pass: 0, fail: 0, unsupported: 0, pending: 0 }
  for (const c of checks) {
    const st = results && results[c.id] && results[c.id].status
    if (st === 'pass' || st === 'info') s.pass++
    else if (st === 'fail') s.fail++
    else if (st === 'unsupported') s.unsupported++
    else s.pending++
  }
  return s
}

// ───────────────────────────── 瀏覽器環境 ─────────────────────────────
// g：全域物件（預設 globalThis；測試傳「會檢查 this 的假全域」）。呼叫時才讀全域，所以 http / iOS Safari / Firefox 缺 API 也不會在 import 時炸掉。
export function browserEnv(g = globalThis) {
  const perf = g.performance || null
  return {
    nav: g.navigator || null,
    win: g.window || null,
    doc: g.document || null,
    now: () => (perf && isFn(perf.now) ? perf.now() : Date.now()),
    setTimeout: (fn, ms) => g.setTimeout(fn, ms),
    clearTimeout: (id) => g.clearTimeout(id),
    raf: isFn(g.requestAnimationFrame) ? (cb) => g.requestAnimationFrame(cb) : null,
    cancelRaf: isFn(g.cancelAnimationFrame) ? (id) => g.cancelAnimationFrame(id) : null,
    createChannel: isFn(g.BroadcastChannel) ? (name) => new g.BroadcastChannel(name) : null,
    MediaRecorder: g.MediaRecorder || null,
    AudioContext: g.AudioContext || g.webkitAudioContext || null,
    Intl: g.Intl || null,
    URL: g.URL || null,
    Blob: g.Blob || null,
    makeFile: isFn(g.File) ? () => new g.File(['x'], 'midisea-diagnostics.png', { type: 'image/png' }) : null,
    getStorage: () => g.localStorage,   // 隱私模式讀這個屬性就可能丟 SecurityError：由檢查自己 try/catch
    randomId: () => Math.random().toString(36).slice(2, 10),
  }
}

const isSecure = (env) => {
  const w = env.win
  if (w && typeof w.isSecureContext === 'boolean') return w.isSecureContext
  return !!(w && w.location && w.location.protocol === 'https:')
}

export function screenInfo(env) {
  const w = (env && env.win) || {}
  const s = w.screen || {}
  return {
    width: num(s.width), height: num(s.height), availWidth: num(s.availWidth), availHeight: num(s.availHeight),
    dpr: num(w.devicePixelRatio), viewportWidth: num(w.innerWidth), viewportHeight: num(w.innerHeight),
    colorDepth: num(s.colorDepth), orientation: s.orientation && typeof s.orientation.type === 'string' ? s.orientation.type : null,
  }
}

// ───────────────────────────── 自動檢查（不需要使用者手勢）─────────────────────────────
function envUa(env) {
  const nav = env.nav
  if (!nav) return { status: 'fail', msg: d(T('讀不到 navigator：這不是一般的瀏覽器環境')) }
  const uad = nav.userAgentData
  const platform = String((uad && uad.platform) || nav.platform || '')
  const ua = String(nav.userAgent || '')
  const mobile = uad && typeof uad.mobile === 'boolean' ? uad.mobile : null
  return { status: 'info', msg: d(T('平台 {platform}；UA：{ua}'), { platform: platform || '—', ua: ua || '—' }), data: { ua, platform, mobile } }
}

function envScreen(env) {
  const s = screenInfo(env)
  if (s.width == null && s.viewportWidth == null) return { status: 'fail', msg: d(T('讀不到螢幕資訊')) }
  return {
    status: 'info',
    msg: d(T('螢幕 {sw}×{sh}，像素比 {dpr}；視窗 {vw}×{vh}；方向 {o}'), {
      sw: s.width ?? '—', sh: s.height ?? '—', dpr: s.dpr ?? '—', vw: s.viewportWidth ?? '—', vh: s.viewportHeight ?? '—', o: s.orientation || '—',
    }),
    data: s,
  }
}

function envSecure(env) {
  const w = env.win
  const proto = String((w && w.location && w.location.protocol) || '')
  const ok = isSecure(env)
  return ok
    ? { status: 'pass', msg: d(T('{proto} 安全環境：相機、麥克風、WebXR、Wake Lock 都可以使用'), { proto: proto || 'https:' }), data: { secure: true, protocol: proto } }
    : { status: 'fail', msg: d(T('{proto} 不是安全環境：相機、麥克風、WebXR、Wake Lock、Web MIDI 都無法使用，請改用 https'), { proto: proto || '—' }), data: { secure: false, protocol: proto } }
}

function envLocale(env) {
  const nav = env.nav || {}
  const langs = Array.from(nav.languages || (nav.language ? [nav.language] : [])).slice(0, 3).map(String)
  let tz = null
  try { tz = env.Intl && env.Intl.DateTimeFormat().resolvedOptions().timeZone } catch (e) { tz = null }
  return { status: 'info', msg: d(T('語言 {langs}；時區 {tz}'), { langs: langs.join(', ') || '—', tz: tz || '—' }), data: { languages: langs, timeZone: tz || null } }
}

function envNetwork(env) {
  const nav = env.nav || {}
  const online = typeof nav.onLine === 'boolean' ? nav.onLine : null
  const c = nav.connection
  const conn = c ? { type: c.effectiveType || null, downlink: num(c.downlink), rtt: num(c.rtt), saveData: c.saveData === true } : null
  const extra = conn && (conn.type || conn.downlink != null)
    ? d(T('連線類型 {type}，下行 {down} Mbps，延遲 {rtt} ms'), { type: conn.type || '—', down: conn.downlink ?? '—', rtt: conn.rtt ?? '—' }) : null
  if (online === false) return { status: 'fail', msg: [d(T('目前離線：語音辨識（Chrome）與政府開放資料需要網路')), extra], data: { online, connection: conn } }
  if (online === true) return { status: 'pass', msg: [d(T('目前線上')), extra], data: { online, connection: conn } }
  return { status: 'info', msg: d(T('瀏覽器沒有回報網路狀態')), data: { online: null, connection: conn } }
}

function envHardware(env) {
  const nav = env.nav || {}
  const cores = num(nav.hardwareConcurrency), mem = num(nav.deviceMemory)
  return { status: 'info', msg: d(T('CPU 執行緒數 {cores}；記憶體 {mem}'), { cores: cores ?? '—', mem: mem != null ? mem + ' GB' : '—' }), data: { cores, memoryGB: mem } }
}

async function envStorage(env) {
  const st = env.nav && env.nav.storage
  if (!st || !isFn(st.estimate)) return { status: 'unsupported', msg: d(T('沒有儲存空間估計 API')) }
  const est = await raceTimeout(env, st.estimate(), LIMITS.probeMs)
  const usage = num(est && est.usage), quota = num(est && est.quota)
  let persisted = null
  if (isFn(st.persisted)) { try { persisted = await raceTimeout(env, st.persisted(), LIMITS.probeMs) } catch (e) { persisted = null } }
  return {
    status: 'info',
    msg: [d(T('已用 {usage}，上限約 {quota}'), { usage: fmtBytes(usage), quota: fmtBytes(quota) }), persisted === true ? d(T('資料已設為持久保存')) : null],
    data: { usage, quota, persisted },
  }
}

const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|software|basic render|mesa offscreen/i
function makeGl(env, type) {
  const doc = env.doc
  if (!doc || !isFn(doc.createElement)) return null
  try { const c = doc.createElement('canvas'); return c && isFn(c.getContext) ? (c.getContext(type) || null) : null } catch (e) { return null }
}
function glStrings(gl) {
  let renderer = '', vendor = ''
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    if (ext) { renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || ''); vendor = String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || '') }
    if (!renderer) renderer = String(gl.getParameter(gl.RENDERER) || '')
    if (!vendor) vendor = String(gl.getParameter(gl.VENDOR) || '')
  } catch (e) { /* 部分瀏覽器（隱私設定）不給 */ }
  return { renderer, vendor }
}
function checkGl(env) {
  let gl = makeGl(env, 'webgl2'), version = 2
  if (!gl) { gl = makeGl(env, 'webgl') || makeGl(env, 'experimental-webgl'); version = 1 }
  if (!gl) return { status: 'fail', msg: d(T('無法建立 WebGL：三維畫面無法顯示。可能是硬體加速被關閉、顯示卡被封鎖或省電模式')) }
  try {
    const { renderer, vendor } = glStrings(gl)
    let maxTex = null, antialias = null
    try { maxTex = num(gl.getParameter(gl.MAX_TEXTURE_SIZE)) } catch (e) { /* ignore */ }
    try { const a = gl.getContextAttributes(); antialias = a ? !!a.antialias : null } catch (e) { /* ignore */ }
    const software = SOFTWARE_GL.test(renderer)
    const msg = [
      d(T('WebGL {v}'), { v: version }),
      d(T('繪圖器 {renderer}'), { renderer: renderer || '—' }),
      d(T('廠商 {vendor}'), { vendor: vendor || '—' }),
      d(T('最大貼圖 {n} px'), { n: maxTex ?? '—' }),
      antialias == null ? null : d(antialias ? T('抗鋸齒：有') : T('抗鋸齒：無')),
      version === 1 ? d(T('只有 WebGL 1：三維畫面需要 WebGL 2')) : null,
      software ? d(T('偵測到軟體繪圖：效能會很差，請確認已開啟硬體加速')) : null,
    ]
    return { status: version === 2 && !software ? 'pass' : 'fail', msg, data: { version, renderer, vendor, maxTextureSize: maxTex, antialias, software } }
  } finally {
    try { const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext() } catch (e) { /* 盡力釋放 GPU 資源 */ }
  }
}

// rAF 取樣 2 秒：平均 / 最低 FPS。分頁在背景時瀏覽器不會送幀 → 略過；卡住或被取消都會放掉 rAF 與計時器。
function checkFps(env, ctx) {
  if (!isFn(env.raf)) return { status: 'unsupported', msg: d(T('沒有 requestAnimationFrame')) }
  if (env.doc && env.doc.hidden === true) return { status: 'skipped', msg: d(T('分頁在背景：瀏覽器不會產生畫面幀，請把這個分頁留在前景再測')) }
  if (ctx.cancel.cancelled) return { status: 'skipped', msg: d(T('這項檢查已取消')) }
  return new Promise((resolve) => {
    let start = null, last = null, frames = 0, minFps = Infinity, id = null, timer = null, done = false
    const finish = (out) => {
      if (done) return
      done = true
      if (timer != null) tclear(env, timer)
      if (id != null && isFn(env.cancelRaf)) safe(() => env.cancelRaf(id))
      resolve(out)
    }
    const evaluate = () => {
      const secs = (last - start) / 1000
      if (frames < 3 || !(secs > 0)) return { status: 'fail', msg: d(T('取樣期間幾乎沒有畫面幀（只有 {n} 幀）'), { n: frames + 1 }) }
      const avg = frames / secs, min = Number.isFinite(minFps) ? minFps : avg
      const data = { avg: round(avg, 1), min: round(min, 1), frames: frames + 1, seconds: round(secs, 2) }
      const msg = d(T('平均 {avg} FPS，最低 {min} FPS（取樣 {s} 秒）'), { avg: data.avg, min: data.min, s: data.seconds })
      return avg >= LIMITS.fpsPass ? { status: 'pass', msg, data } : { status: 'fail', msg: [msg, d(T('低於 {n} FPS：三維畫面會不順'), { n: LIMITS.fpsPass })], data }
    }
    const tick = (ts) => {
      if (done) return
      const n = num(ts) != null ? ts : tnow(env)
      if (start == null) start = n
      else { frames++; const dt = n - last; if (dt > 0) minFps = Math.min(minFps, 1000 / dt) }
      last = n
      if (n - start >= LIMITS.fpsMs) return finish(evaluate())
      id = env.raf(tick)
    }
    ctx.cancel.onCancel(() => finish({ status: 'skipped', msg: d(T('這項檢查已取消')) }))
    id = env.raf(tick)
    timer = tset(env, () => finish({ status: 'fail', msg: d(T('等了 {s} 秒都沒有畫面幀：分頁可能在背景，或瀏覽器把動畫節流了'), { s: round((LIMITS.fpsMs + LIMITS.fpsGraceMs) / 1000, 1) }) }), LIMITS.fpsMs + LIMITS.fpsGraceMs)
  })
}

function checkLs(env) {
  let store
  try { store = isFn(env.getStorage) ? env.getStorage() : null } catch (e) { return { status: 'fail', msg: d(T('讀取 localStorage 被拒絕（{err}）：可能是隱私模式或封鎖網站資料'), { err: errName(e) }) } }
  if (!store) return { status: 'unsupported', msg: d(T('沒有 localStorage')) }
  const key = 'ixd2026.diag-probe'
  try {
    const v = 'p' + (isFn(env.randomId) ? env.randomId() : '0')
    store.setItem(key, v)
    const back = store.getItem(key)
    store.removeItem(key)
    return back === v ? { status: 'pass', msg: d(T('寫入、讀回、刪除都成功')) } : { status: 'fail', msg: d(T('寫入後讀回的值不一致')) }
  } catch (e) {
    safe(() => store.removeItem(key))
    return { status: 'fail', msg: d(T('讀寫失敗：{err}（隱私模式或空間已滿）'), { err: errName(e) }) }
  }
}

// 開兩個同名 channel 互傳：證明「主視窗 → 觀眾視窗」的同步管道可用。不論結果都關掉兩個 channel。
async function checkBroadcast(env, ctx) {
  if (!isFn(env.createChannel)) return { status: 'unsupported', msg: d(T('沒有 BroadcastChannel：雙螢幕（觀眾視窗）同步無法使用')) }
  let a = null, b = null
  const close = () => { for (const c of [a, b]) { if (!c) continue; safe(() => { c.onmessage = null }); safe(() => c.close()) } a = b = null }
  const off = ctx.cancel.onCancel(close)
  try {
    const name = 'ixd2026-diag-' + (isFn(env.randomId) ? env.randomId() : '0')
    a = env.createChannel(name)
    b = env.createChannel(name)
    const token = 'ping-' + tnow(env)
    const got = new Promise((resolve) => { b.onmessage = (ev) => resolve(ev && ev.data) })
    const t0 = tnow(env)
    a.postMessage({ token })
    const res = await raceTimeout(env, got, LIMITS.bcMs)
    return res && res.token === token
      ? { status: 'pass', msg: d(T('兩個 channel 往返成功（{ms} ms）'), { ms: Math.round(tnow(env) - t0) }) }
      : { status: 'fail', msg: d(T('收到的訊息內容不對')) }
  } catch (e) {
    return errName(e) === 'TimeoutError' ? { status: 'fail', msg: d(T('{ms} ms 內沒有收到訊息'), { ms: LIMITS.bcMs }) } : failFromError(e)
  } finally {
    off()
    close()
  }
}

async function checkSw(env) {
  const sw = env.nav && env.nav.serviceWorker
  if (!sw) return { status: 'unsupported', msg: d(T('沒有 Service Worker（非 https、隱私模式或瀏覽器不支援）：無法離線使用與安裝為 App')) }
  if (!isFn(sw.getRegistration)) return { status: 'info', msg: d(T('有 Service Worker API，但無法查詢註冊狀態')) }
  const reg = await raceTimeout(env, sw.getRegistration(), LIMITS.swMs)
  const controlled = !!sw.controller
  if (!reg) return { status: 'needs-action', msg: d(T('尚未註冊：重新整理一次後再測（開發模式不會註冊）')), data: { state: 'none', controlled } }
  const state = reg.active ? 'active' : reg.waiting ? 'waiting' : reg.installing ? 'installing' : 'none'
  const data = { state, controlled }
  if (state === 'active') {
    return { status: 'pass', msg: [d(T('Service Worker 已啟用')), d(controlled ? T('正在控制這個頁面（可離線）') : T('尚未控制這個頁面：重新整理後生效'))], data }
  }
  return { status: 'needs-action', msg: d(T('已註冊但狀態是 {state}：稍候或重新整理後再測'), { state }), data }
}

function checkShare(env) {
  const nav = env.nav
  if (!nav || !isFn(nav.share)) return { status: 'unsupported', msg: d(T('沒有 Web Share：「分享」會改用下載圖片')) }
  let files = false
  if (isFn(nav.canShare) && isFn(env.makeFile)) {
    try { files = nav.canShare({ files: [env.makeFile()] }) === true } catch (e) { files = false }
  }
  return files
    ? { status: 'pass', msg: d(T('可以分享圖片檔（canShare 檔案 = 是）')), data: { share: true, files: true } }
    : { status: 'unsupported', msg: d(T('有 Web Share，但不能分享圖片檔（只能分享文字 / 連結）')), data: { share: true, files: false } }
}

async function checkClipboard(env) {
  const nav = env.nav || {}
  const cb = nav.clipboard
  const text = !!cb && isFn(cb.writeText)
  const image = !!cb && isFn(cb.write) && !!env.win && isFn(env.win.ClipboardItem)
  let perm = null
  if (nav.permissions && isFn(nav.permissions.query)) {
    try { const p = await raceTimeout(env, nav.permissions.query({ name: 'clipboard-write' }), LIMITS.probeMs); perm = p && p.state ? String(p.state) : null } catch (e) { perm = null }
  }
  const data = { text, image, permission: perm }
  if (!text) return { status: 'unsupported', msg: d(T('沒有剪貼簿寫入 API（需要 https）：「複製報告」會改用備援做法')), data }
  const msg = [d(text ? T('可寫入文字') : T('不能寫入文字')), d(image ? T('可寫入圖片') : T('不能寫入圖片')), perm ? d(T('權限 {state}'), { state: perm }) : null]
  return { status: perm === 'denied' ? 'fail' : 'pass', msg, data }
}

function checkFsApi(env) {
  const doc = env.doc
  const el = doc && doc.documentElement
  if (!el || !(isFn(el.requestFullscreen) || isFn(el.webkitRequestFullscreen))) return { status: 'unsupported', msg: d(T('沒有全螢幕 API（iPhone Safari 不支援網頁全螢幕；可「加入主畫面」以獨立視窗開啟）')) }
  const enabled = doc.fullscreenEnabled !== undefined ? doc.fullscreenEnabled : doc.webkitFullscreenEnabled
  if (enabled === false) return { status: 'fail', msg: d(T('全螢幕被停用（權限政策或內嵌框架）')) }
  return { status: 'pass', msg: d(T('支援全螢幕（互動檢查可實際進入 / 離開）')) }
}

// 請求後立刻釋放。遲到的鎖（逾時後才拿到）也會被釋放，不會留下沒人管的 lock。
async function checkWakeLock(env) {
  const wl = env.nav && env.nav.wakeLock
  if (!wl || !isFn(wl.request)) return { status: 'unsupported', msg: d(T('沒有 Screen Wake Lock（非 https 或舊瀏覽器）：投影機可能被系統休眠成黑屏')) }
  if (env.doc && env.doc.visibilityState && env.doc.visibilityState !== 'visible') return { status: 'skipped', msg: d(T('分頁在背景：Wake Lock 只有前景分頁能取得')) }
  const release = (s) => { safe(() => { if (s && !s.released) { const r = s.release(); if (r && isFn(r.catch)) r.catch(() => {}) } }) }
  let sentinel = null
  try {
    sentinel = await raceTimeout(env, wl.request('screen'), LIMITS.wakeLockMs, release)
    release(sentinel)
    return { status: 'pass', msg: d(T('已取得螢幕常亮鎖並立刻釋放')) }
  } catch (e) {
    const n = errName(e)
    if (n === 'TimeoutError') return { status: 'fail', msg: d(T('{s} 秒內沒有回應'), { s: LIMITS.wakeLockMs / 1000 }) }
    if (n === 'NotAllowedError') return { status: 'fail', msg: d(T('被拒絕（NotAllowedError）：可能是省電模式、權限政策，或分頁不在前景')) }
    return failFromError(e)
  } finally {
    release(sentinel)
  }
}

const RECORDER_TYPES = ['video/mp4', 'video/mp4;codecs=avc1', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/webm', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm;codecs=h264', 'audio/webm;codecs=opus', 'audio/mp4']
function checkRecorder(env) {
  const MR = env.MediaRecorder
  if (!MR || !isFn(MR.isTypeSupported)) return { status: 'unsupported', msg: d(T('沒有 MediaRecorder：無法錄影')) }
  const ok = [], no = []
  for (const type of RECORDER_TYPES) { let s = false; try { s = MR.isTypeSupported(type) === true } catch (e) { s = false }; (s ? ok : no).push(type) }
  const video = ok.filter((x) => x.startsWith('video/'))
  const mp4 = video.some((x) => x.startsWith('video/mp4')), webm = video.some((x) => x.startsWith('video/webm'))
  const data = { supported: ok, unsupported: no, mp4, webm }
  if (!video.length) return { status: 'fail', msg: d(T('有 MediaRecorder，但沒有任何影片格式可用')), data }
  return { status: 'pass', msg: [d(T('mp4：{mp4}；webm：{webm}'), { mp4: d(mp4 ? T('格式可用') : T('格式不可用')), webm: d(webm ? T('格式可用') : T('格式不可用')) }), d(T('{n}/{total} 種格式可用：{list}'), { n: ok.length, total: RECORDER_TYPES.length, list: ok.join(', ') })], data }
}

// ---- 只查「API 是否存在」（不開權限、不開裝置）----
function checkMidiApi(env) {
  const has = !!env.nav && isFn(env.nav.requestMIDIAccess)
  return has ? { status: 'pass', msg: d(T('有 requestMIDIAccess（互動檢查可列出裝置）')) }
    : { status: 'unsupported', msg: d(T('沒有 Web MIDI（Safari、iPhone 與 Firefox 預設沒有；請用桌面版 Chrome / Edge）')) }
}
async function checkBleApi(env) {
  const bt = env.nav && env.nav.bluetooth
  if (!bt) return { status: 'unsupported', msg: d(T('沒有 Web Bluetooth（Safari 與 Firefox 沒有）：藍牙 MIDI 需要 Chrome / Edge')) }
  let avail = null
  if (isFn(bt.getAvailability)) { try { avail = await raceTimeout(env, bt.getAvailability(), LIMITS.probeMs) } catch (e) { avail = null } }
  if (avail === false) return { status: 'fail', msg: d(T('有 Web Bluetooth，但沒有可用的藍牙介面卡（藍牙已關閉或沒有硬體）')) }
  return { status: 'pass', msg: d(avail === true ? T('有 Web Bluetooth，藍牙可用') : T('有 Web Bluetooth')), data: { available: avail } }
}
async function checkXrApi(env) {
  const xr = env.nav && env.nav.xr
  if (!xr || !isFn(xr.isSessionSupported)) return { status: 'unsupported', msg: d(T('沒有 WebXR（iPhone Safari 沒有；「實景」仍可用相機當背景）')) }
  let ok
  try { ok = await raceTimeout(env, xr.isSessionSupported('immersive-ar'), LIMITS.xrMs) } catch (e) {
    return errName(e) === 'TimeoutError' ? { status: 'fail', msg: d(T('isSessionSupported 在 {s} 秒內沒有回應'), { s: LIMITS.xrMs / 1000 }) } : failFromError(e)
  }
  return ok === true
    ? { status: 'pass', msg: d(T('支援 immersive-ar（只查支援度，沒有開啟 AR 工作階段）')), data: { immersiveAr: true } }
    : { status: 'unsupported', msg: d(T('這台裝置不支援 immersive-ar（桌面 AR 需要 Android Chrome + ARCore）')), data: { immersiveAr: false } }
}
function checkSpeechApi(env) {
  const w = env.win
  return w && isFn(w.SpeechRecognition || w.webkitSpeechRecognition)
    ? { status: 'pass', msg: d(T('有 SpeechRecognition（互動檢查可實際收音辨識）')) }
    : { status: 'unsupported', msg: d(T('沒有語音辨識（Firefox 沒有）；請改用 Chrome、Edge 或 Safari')) }
}
function checkGamepadApi(env) {
  const nav = env.nav
  if (!nav || !isFn(nav.getGamepads)) return { status: 'unsupported', msg: d(T('沒有 Gamepad API')) }
  let n = 0
  try { n = Array.from(nav.getGamepads() || []).filter((p) => p && p.connected !== false).length } catch (e) { return { status: 'fail', msg: d(T('getGamepads() 丟出例外：{err}'), { err: errName(e) }) } }
  return { status: 'pass', msg: d(T('有 Gamepad API；目前偵測到 {n} 支手把（Chrome 要按過手把按鍵才會出現）'), { n }), data: { connected: n } }
}
function checkVibrateApi(env) {
  return env.nav && isFn(env.nav.vibrate)
    ? { status: 'pass', msg: d(T('有 navigator.vibrate（桌機多半沒有馬達；請用互動檢查實測）')) }
    : { status: 'unsupported', msg: d(T('沒有震動 API（iPhone Safari 就是如此）：手機震動會靜默略過')) }
}
function checkPointerApi(env) {
  const w = env.win || {}, nav = env.nav || {}
  const has = isFn(w.PointerEvent)
  const touch = num(nav.maxTouchPoints)
  let coarse = null
  if (isFn(w.matchMedia)) { try { coarse = w.matchMedia('(pointer: coarse)').matches === true } catch (e) { coarse = null } }
  return {
    status: has ? 'pass' : 'unsupported',
    msg: [d(has ? T('有 PointerEvent') : T('沒有 PointerEvent（觸控筆壓力與傾斜角無法讀取）')), d(T('最大觸控點數 {n}'), { n: touch ?? '—' }), coarse == null ? null : d(coarse ? T('主要輸入：觸控') : T('主要輸入：滑鼠或觸控板'))],
    data: { pointerEvent: has, maxTouchPoints: touch, coarse },
  }
}
function checkScreensApi(env) {
  const w = env.win || {}
  const has = isFn(w.getScreenDetails)
  const ext = w.screen && typeof w.screen.isExtended === 'boolean' ? w.screen.isExtended : null
  return has
    ? { status: 'pass', msg: [d(T('有 getScreenDetails（互動檢查可列出所有螢幕）')), ext == null ? null : d(ext ? T('目前是延伸桌面（多螢幕）') : T('目前只有 1 個螢幕'))], data: { getScreenDetails: true, isExtended: ext } }
    : { status: 'unsupported', msg: d(T('沒有 getScreenDetails（Safari、Firefox 與非 https 沒有）：仍可手動把觀眾視窗拖到投影機')), data: { getScreenDetails: false, isExtended: ext } }
}

// ───────────────────────────── 互動檢查（使用者按下按鈕後才執行）─────────────────────────────
// 媒體錯誤分類（getUserMedia / MIDI 共用）
export function classifyMediaError(e) {
  switch (errName(e)) {
    case 'NotAllowedError': case 'PermissionDeniedError': return 'denied'
    case 'NotFoundError': case 'DevicesNotFoundError': return 'notfound'
    case 'NotReadableError': case 'TrackStartError': return 'busy'
    case 'OverconstrainedError': case 'ConstraintNotSatisfiedError': return 'constraint'
    case 'SecurityError': return 'security'
    case 'TimeoutError': return 'timeout'
    case 'AbortError': return 'abort'
    case 'TypeError': return 'type'
    default: return 'error'
  }
}
function mediaError(e, what) {
  const kind = classifyMediaError(e)
  switch (kind) {
    case 'denied': return { status: 'fail', msg: d(T('使用{what}的權限被拒絕：請在網址列旁的網站設定允許，然後重新測試'), { what }), data: { error: errName(e) } }
    case 'notfound': return { status: 'fail', msg: d(T('找不到可用的{what}'), { what }), data: { error: errName(e) } }
    case 'busy': return { status: 'fail', msg: d(T('{what}無法啟動：可能被其他 App 或分頁占用'), { what }), data: { error: errName(e) } }
    case 'constraint': return { status: 'fail', msg: d(T('{what}不符合要求的規格（{err}）'), { what, err: errName(e) }), data: { error: errName(e) } }
    case 'security': return { status: 'fail', msg: d(T('被安全性規則擋下：需要 https，或被權限政策 / 內嵌框架禁用')), data: { error: errName(e) } }
    case 'timeout': return { status: 'fail', msg: d(T('等了 {s} 秒沒有回應（權限提示可能被忽略了）'), { s: round(LIMITS.permMs / 1000) }), data: { error: 'TimeoutError' } }
    case 'abort': return { status: 'fail', msg: d(T('要求被中止（AbortError）')), data: { error: errName(e) } }
    case 'type': return { status: 'fail', msg: d(T('瀏覽器拒絕了這個要求（TypeError）：常見原因是不是 https')), data: { error: errName(e) } }
    default: return { status: 'fail', msg: d(T('{what}啟動失敗：{err}'), { what, err: errText(e) }), data: { error: errName(e) } }
  }
}
const mediaUnsupported = (env, what) => ({
  status: 'unsupported',
  msg: isSecure(env) ? d(T('這個瀏覽器沒有 getUserMedia：無法使用{what}'), { what }) : d(T('沒有 getUserMedia：目前不是 https，瀏覽器不開放{what}'), { what }),
})
const stopStream = (stream) => { safe(() => { for (const tr of Array.from(stream.getTracks())) safe(() => tr.stop()) }) }

// 用一個「探測器」包住長時間 / 需釋放資源的互動檢查。
//   createProbe(id, env, opts) → { id, start(), stop(), destroy(), running }
//   opts：onUpdate(patch)（即時資料：音量、辨識文字、手把數值…）/ onResult(result)（結果，可能多次）/ onRunning(bool) / 各檢查自己的選項（facing、lang、attach、detach）
//   start()：在使用者手勢內呼叫（同步跑到 body 的第一個 await 為止，所以 AudioContext / requestPermission 這類「必須在手勢內同步呼叫」的動作放在 body 開頭）；已在執行中就回傳同一個 promise。
//   stop()：同步釋放所有資源（track、辨識器、計時器、監聽）；之後才醒來的非同步程式碼也會被立刻清掉。重複呼叫無害。
export function createProbe(id, env, opts = {}) {
  const check = getCheck(id)
  if (!check || check.kind !== 'interactive' || !isFn(check.body)) throw new Error('unknown probe: ' + id)
  const e = env || {}
  let hooks = opts
  let current = null   // 目前這一輪 { cancelled, cleanups, sleepers, promise }
  let latest = null    // 最近開始的一輪：舊一輪（已被 stop）遲到的結果不能蓋掉新一輪

  const runCleanups = (run) => { const fns = run.cleanups.reverse(); run.cleanups = []; for (const fn of fns) safe(fn) }
  const wakeAll = (run) => { for (const w of [...run.sleepers]) safe(w) }
  const callHook = (name, ...a) => { const h = hooks && hooks[name]; if (isFn(h)) safe(() => h(...a)) }

  function makeApi(run, t0) {
    const wait = (promise, ms) => new Promise((resolve) => {
      if (run.cancelled) return resolve('cancel')
      let timer = null, done = false
      const finish = (v) => { if (done) return; done = true; if (timer != null) tclear(e, timer); run.sleepers.delete(cancelWake); resolve(v) }
      const cancelWake = () => finish('cancel')
      run.sleepers.add(cancelWake)
      timer = tset(e, () => finish('timeout'), ms)
      if (promise) Promise.resolve(promise).then(() => finish('done'), () => finish('done'))
    })
    return {
      env: e,
      opts: hooks || {},
      get cancelled() { return run.cancelled },
      cleanup(fn) { if (run.cancelled) safe(fn); else run.cleanups.push(fn) },
      emit(patch) { if (run === latest) callHook('onUpdate', patch) },
      report(out) { if (run === latest) callHook('onResult', makeResult(check, out, tnow(e) - t0)) },
      sleep: async (ms) => (await wait(null, ms)) === 'timeout',                // true = 時間到；false = 被取消
      until: async (promise, ms) => (await wait(promise, ms)) === 'done',       // true = promise 先結束；false = 逾時或被取消
      // 逾時競賽 + 可取消：stop() 時等待中的 await（例如沒人回答的權限提示）立刻放行（reject CancelledError，body 一律 return null）；
      // 逾時 / 取消「之後」才到的結果交給 onLate（例如把遲到的 stream 立刻停掉）。計時器在任何結束路徑都會清掉。
      race: (promise, ms, onLate) => new Promise((resolve, reject) => {
        const late = () => { Promise.resolve(promise).then((v) => { if (onLate) safe(() => onLate(v)) }, () => {}) }
        if (run.cancelled) { late(); return reject(cancelledError()) }
        let done = false, timer = null
        const wake = () => { if (done) return; fin(); late(); reject(cancelledError()) }
        const fin = () => { done = true; if (timer != null) tclear(e, timer); run.sleepers.delete(wake) }
        run.sleepers.add(wake)
        timer = tset(e, () => { if (done) return; fin(); late(); reject(timeoutError()) }, ms)
        Promise.resolve(promise).then((v) => { if (done) return; fin(); resolve(v) }, (er) => { if (done) return; fin(); reject(er) })
      }),
      throttled(fn, ms = LIMITS.emitMs) { const th = makeThrottle(e, fn, ms); this.cleanup(() => th.cancel()); return (p) => th.push(p) },
    }
  }

  function start() {
    if (current && !current.cancelled) return current.promise
    const run = { cancelled: false, cleanups: [], sleepers: new Set(), promise: null }
    current = latest = run
    const t0 = tnow(e)
    const api = makeApi(run, t0)
    callHook('onRunning', true)
    run.promise = (async () => {
      let out
      try { out = await check.body(api, hooks || {}) } catch (err) { out = failFromError(err) } finally { runCleanups(run); wakeAll(run) }
      if (current === run) current = null
      const result = makeResult(check, out || { status: 'skipped', msg: d(T('已停止，沒有取得結果')) }, tnow(e) - t0)
      if (run === latest) { callHook('onResult', result); if (!run.stopNotified) callHook('onRunning', false) }
      return result
    })()
    return run.promise
  }

  function stop() {
    const run = current
    if (!run || run.cancelled) return
    run.cancelled = true
    runCleanups(run)
    wakeAll(run)
    run.stopNotified = true
    if (run === latest) callHook('onRunning', false)   // 畫面立刻回到「未執行」，不必等 body 收尾
  }

  return {
    id,
    start,
    stop,
    destroy() { stop(); hooks = null },
    get running() { return !!current && !current.cancelled },
  }
}

// ---- 相機 ----
// 量影片實際幀率：requestVideoFrameCallback 計次 → getVideoPlaybackQuality 差值 → 都沒有就回 null（畫面只顯示標稱值）
async function measureVideoFps(api, video, ms) {
  const env = api.env
  if (isFn(video.requestVideoFrameCallback)) {
    return new Promise((resolve) => {
      let n = 0, first = null, last = null, id = null, done = false, timer = null
      const finish = () => {
        if (done) return
        done = true
        if (timer != null) tclear(env, timer)
        if (id != null && isFn(video.cancelVideoFrameCallback)) safe(() => video.cancelVideoFrameCallback(id))
        resolve(n >= 3 && last > first ? n / ((last - first) / 1000) : null)
      }
      const cb = (now) => {
        if (done) return
        const ts = num(now) != null ? now : tnow(env)
        if (first == null) first = ts; else n++
        last = ts
        if (ts - first >= ms) return finish()
        id = video.requestVideoFrameCallback(cb)
      }
      api.cleanup(finish)
      if (done) return
      id = video.requestVideoFrameCallback(cb)
      timer = tset(env, finish, ms + 1500)
    })
  }
  if (isFn(video.getVideoPlaybackQuality)) {
    const q0 = num(safe(() => video.getVideoPlaybackQuality().totalVideoFrames))
    if (q0 == null || !(await api.sleep(ms))) return null
    const q1 = num(safe(() => video.getVideoPlaybackQuality().totalVideoFrames))
    return q1 != null && q1 > q0 ? (q1 - q0) / (ms / 1000) : null
  }
  return null
}

async function cameraBody(api) {
  const { env, opts } = api
  const md = env.nav && env.nav.mediaDevices
  if (!md || !isFn(md.getUserMedia)) return mediaUnsupported(env, d(T('相機裝置')))
  const facing = opts.facing === 'environment' ? 'environment' : 'user'
  let stream
  try {
    stream = await api.race(md.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: { ideal: facing } }, audio: false }), LIMITS.permMs, stopStream)
  } catch (e) { return api.cancelled ? null : mediaError(e, d(T('相機裝置'))) }
  api.cleanup(() => stopStream(stream))   // 一定停掉（若 stop() 早就被呼叫，cleanup 會立刻執行）
  if (api.cancelled) return null
  const vt = safe(() => stream.getVideoTracks()[0])
  if (!vt) return { status: 'fail', msg: d(T('取得了串流，但裡面沒有視訊軌')) }
  api.cleanup(() => safe(() => { vt.onended = null }))
  safe(() => { vt.onended = () => api.emit({ ended: true }) })
  const st = safe(() => (isFn(vt.getSettings) ? vt.getSettings() : {})) || {}
  const w = num(st.width), h = num(st.height), nominal = num(st.frameRate)
  let video = null
  api.cleanup(() => { if (isFn(opts.detach)) safe(() => opts.detach()) })   // 先放掉預覽，再停 track（cleanup 反向執行）；在 attach 之前登記：attach 卡住時 stop() 也放得掉
  if (isFn(opts.attach)) { try { video = await api.race(opts.attach(stream), LIMITS.attachMs) } catch (e) { video = null } }   // 預覽元素卡住也不會拖住整個檢查
  if (api.cancelled) return null
  const fps = video ? await measureVideoFps(api, video, LIMITS.camFpsMs) : null
  const data = { width: w, height: h, fps: fps != null ? round(fps, 1) : null, nominalFps: nominal, facingMode: typeof st.facingMode === 'string' ? st.facingMode : null }
  const out = {
    status: 'pass',
    msg: [
      w && h ? d(T('已取得影像 {w}×{h}'), { w, h }) : d(T('已取得影像（解析度不明）')),
      fps != null ? d(T('實測 {fps} fps'), { fps: round(fps, 1) }) : nominal != null ? d(T('標稱 {fps} fps'), { fps: round(nominal, 1) }) : d(T('幀率不明')),
    ],
    data,
  }
  api.report(out)
  if (!api.cancelled) await api.sleep(LIMITS.camPreviewMs)   // 預覽維持一段時間讓人確認畫面；時間到 / 按停止 / 離開頁面 → 一律釋放
  return out
}

// ---- 麥克風 ----
export function rmsOfBytes(buf) {   // 0..255 的時域資料（128 = 靜音）→ RMS 0..1
  const n = buf ? buf.length : 0
  if (!n) return 0
  let sum = 0
  for (let i = 0; i < n; i++) { const v = (buf[i] - 128) / 128; sum += v * v }
  return Math.sqrt(sum / n)
}
const meter = (rms) => Math.min(1, rms * 3)   // 顯示用：說話的 RMS 約 0.05~0.3，放大成音量條好看的範圍

async function micBody(api) {
  const { env } = api
  const md = env.nav && env.nav.mediaDevices
  if (!md || !isFn(md.getUserMedia)) return mediaUnsupported(env, d(T('麥克風裝置')))
  // AudioContext 必須在使用者手勢內「同步」建立並 resume（Safari）：所以放在第一個 await 之前
  let ctx = null
  if (isFn(env.AudioContext)) {
    try {
      ctx = new env.AudioContext()
      api.cleanup(() => safe(() => { const r = ctx.close(); if (r && isFn(r.catch)) r.catch(() => {}) }))
      if (ctx.state === 'suspended' && isFn(ctx.resume)) { const r = ctx.resume(); if (r && isFn(r.catch)) r.catch(() => {}) }
    } catch (e) { ctx = null }
  }
  let stream
  try { stream = await api.race(md.getUserMedia({ audio: true, video: false }), LIMITS.permMs, stopStream) } catch (e) { return api.cancelled ? null : mediaError(e, d(T('麥克風裝置'))) }
  api.cleanup(() => stopStream(stream))
  if (api.cancelled) return null
  const at = safe(() => stream.getAudioTracks()[0])
  if (!at) return { status: 'fail', msg: d(T('取得了串流，但裡面沒有音訊軌')) }
  if (!ctx) return { status: 'pass', msg: d(T('已取得麥克風串流，但這個瀏覽器沒有 AudioContext，無法量音量')) }
  let analyser, source
  try {
    analyser = ctx.createAnalyser(); analyser.fftSize = 1024
    source = ctx.createMediaStreamSource(stream)
    api.cleanup(() => safe(() => source.disconnect()))
    source.connect(analyser)   // 不接到喇叭：只量，不播放（避免回授）
  } catch (e) { return failFromError(e) }
  const buf = new Uint8Array(analyser.fftSize)
  const steps = Math.round(LIMITS.micMs / LIMITS.micStepMs)
  let peak = 0, n = 0
  for (let i = 0; i < steps; i++) {
    if (!(await api.sleep(LIMITS.micStepMs))) break
    analyser.getByteTimeDomainData(buf)
    const rms = rmsOfBytes(buf)
    peak = Math.max(peak, rms); n++
    api.emit({ level: meter(rms), peak: meter(peak), elapsedMs: (i + 1) * LIMITS.micStepMs })
  }
  if (n === 0) return null
  const pct = Math.round(meter(peak) * 100)
  const data = { peakPct: pct, samples: n }
  return peak >= LIMITS.micPass
    ? { status: 'pass', msg: d(T('收到聲音：最大音量 {pct}%'), { pct }), data }
    : { status: 'needs-action', msg: d(T('麥克風已開啟，但幾乎沒收到聲音（最大音量 {pct}%）：請對著麥克風說話後再測一次，並確認沒有靜音'), { pct }), data }
}

// ---- 語音辨識 ----
function speechOutcome(errCode, text, lang) {
  const chars = Array.from(String(text || '').replace(/\s+/g, '')).length
  const data = { lang, chars, error: errCode || null }   // 只留字數，不留辨識出來的文字（可能含個資）
  if (chars > 0) return { status: 'pass', msg: d(T('辨識成功：{n} 個字（語言 {lang}）'), { n: chars, lang }), data }
  switch (errCode) {
    case null: case undefined: case 'no-speech': return { status: 'needs-action', msg: d(T('沒有辨識到文字：請對著麥克風說一句話後再測一次（語言 {lang}）'), { lang }), data }
    case 'not-allowed': case 'service-not-allowed': return { status: 'fail', msg: d(T('權限被拒絕（錯誤碼 {code}）：請允許麥克風；Safari 還要在系統設定開啟「聽寫」與 Siri'), { code: errCode }), data }
    case 'audio-capture': return { status: 'fail', msg: d(T('找不到可用的麥克風（錯誤碼 {code}）'), { code: errCode }), data }
    case 'network': return { status: 'fail', msg: d(T('連不上語音辨識服務（錯誤碼 {code}）：Chrome 會把聲音送到雲端辨識，需要網路'), { code: errCode }), data }
    case 'language-not-supported': return { status: 'fail', msg: d(T('不支援這個語言（錯誤碼 {code}，語言 {lang}）'), { code: errCode, lang }), data }
    default: return { status: 'fail', msg: d(T('辨識失敗（錯誤碼 {code}）'), { code: errCode }), data }
  }
}

async function speechBody(api) {
  const { env, opts } = api
  const w = env.win
  const Ctor = w && (w.SpeechRecognition || w.webkitSpeechRecognition)
  if (!isFn(Ctor)) return { status: 'unsupported', msg: d(T('這個瀏覽器沒有語音辨識（Firefox 沒有）；請改用 Chrome、Edge 或 Safari')) }
  const lang = typeof opts.lang === 'string' && opts.lang ? opts.lang : 'zh-TW'
  let rec
  try { rec = new Ctor() } catch (e) { return failFromError(e) }
  let text = '', errCode = null, ended = false
  let resolveStart, resolveEnd
  const startedP = new Promise((r) => { resolveStart = r })
  const endedP = new Promise((r) => { resolveEnd = r })
  api.cleanup(() => {   // 拔掉 handler 再 abort：麥克風才會真的放掉，遲到的事件也不會回頭改東西
    safe(() => { rec.onstart = rec.onaudiostart = rec.onresult = rec.onerror = rec.onend = null })
    safe(() => rec.abort())
  })
  try {
    rec.lang = lang; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1
    rec.onstart = () => resolveStart()
    rec.onaudiostart = () => resolveStart()
    rec.onresult = (ev) => {
      let s = ''
      const list = (ev && ev.results) || []
      for (let i = 0; i < list.length; i++) { const alt = list[i] && list[i][0]; if (alt && alt.transcript) s += alt.transcript }
      text = s
      api.emit({ text, lang })
    }
    rec.onerror = (ev) => { errCode = String((ev && ev.error) || 'error'); resolveStart() }
    rec.onend = () => { ended = true; resolveStart(); resolveEnd() }
    rec.start()
  } catch (e) { return failFromError(e) }
  api.emit({ text: '', lang, listening: true })
  const started = await api.until(startedP, LIMITS.speechStartMs)   // 等使用者按「允許」
  if (api.cancelled) return null
  if (!started) return { status: 'fail', msg: d(T('等了 {s} 秒還沒開始收音（權限提示沒有回應？）'), { s: round(LIMITS.speechStartMs / 1000) }), data: { lang, chars: 0, error: 'timeout' } }
  if (errCode) await api.until(endedP, 500)
  else {
    await api.until(endedP, LIMITS.speechMs)                        // 收音 5 秒；辨識器自己先結束 / 出錯也算
    if (!ended && !api.cancelled) { safe(() => rec.stop()); await api.until(endedP, LIMITS.speechEndMs) }   // stop() 後最後一筆結果才會送來
  }
  if (api.cancelled && !text) return null   // 使用者中途停止、還沒辨識到任何文字：不算結果
  return speechOutcome(errCode === 'aborted' ? null : errCode, text, lang)
}

// ---- Web MIDI ----
function midiError(e) {
  switch (classifyMediaError(e)) {
    case 'denied': case 'security': return { status: 'fail', msg: d(T('MIDI 權限被拒絕：請在網站設定允許 MIDI 裝置，然後重新測試')), data: { error: errName(e) } }
    case 'timeout': return { status: 'fail', msg: d(T('等了 {s} 秒沒有回應（權限提示可能被忽略了）'), { s: round(LIMITS.permMs / 1000) }), data: { error: 'TimeoutError' } }
    default: return { status: 'fail', msg: d(T('MIDI 啟動失敗：{err}'), { err: errText(e) }), data: { error: errName(e) } }
  }
}
function midiText(data) {   // 訊息位元組 → 簡短文字（只給人看：CC 1:7=64 之類）
  if (!data || !data.length) return ''
  const s = data[0]
  if (s >= 0xf0) return ''
  const ch = (s & 0x0f) + 1, kind = s & 0xf0
  const a = data[1] ?? 0, b = data[2] ?? 0
  if (kind === 0x90) return b > 0 ? `Note On ${ch}:${a}=${b}` : `Note Off ${ch}:${a}`
  if (kind === 0x80) return `Note Off ${ch}:${a}`
  if (kind === 0xb0) return `CC ${ch}:${a}=${b}`
  if (kind === 0xc0) return `Program ${ch}:${a}`
  if (kind === 0xe0) return `Pitch ${ch}:${(b << 7) | a}`
  return `0x${s.toString(16)}`
}

async function midiBody(api) {
  const { env } = api
  const nav = env.nav
  if (!nav || !isFn(nav.requestMIDIAccess)) return { status: 'unsupported', msg: d(T('沒有 Web MIDI（Safari、iPhone 與 Firefox 預設沒有）；請用桌面版 Chrome / Edge')) }
  let access
  try { access = await api.race(nav.requestMIDIAccess({ sysex: false }), LIMITS.permMs) } catch (e) { return api.cancelled ? null : midiError(e) }
  if (!access) return { status: 'fail', msg: d(T('MIDI 啟動失敗：沒有回傳存取物件')) }
  const stat = { messages: 0, last: '' }
  const portsOf = (map) => {
    const out = []
    safe(() => { if (map && isFn(map.forEach)) map.forEach((p) => { if (p) out.push({ name: String(p.name || ''), manufacturer: String(p.manufacturer || ''), state: String(p.state || '') }) }) })
    return out
  }
  const snapshot = () => ({ inputs: portsOf(access.inputs), outputs: portsOf(access.outputs), messages: stat.messages, last: stat.last })
  const build = () => {
    const s = snapshot()
    const count = s.inputs.length + s.outputs.length
    const data = { inputs: s.inputs.map((p) => p.name), outputs: s.outputs.map((p) => p.name), messages: stat.messages }
    if (!count) return { status: 'needs-action', msg: d(T('沒有偵測到 MIDI 裝置：接上控制器後會即時更新，或再按一次')), data }
    const names = Array.from(new Set([...s.inputs, ...s.outputs].map((p) => p.name).filter(Boolean))).join('、')
    return { status: 'pass', msg: [d(T('輸入 {i} 個、輸出 {o} 個：{names}'), { i: s.inputs.length, o: s.outputs.length, names: names || '—' }), stat.messages ? d(T('已收到 {n} 則訊息'), { n: stat.messages }) : null], data }
  }
  const publish = () => { api.report(build()); api.emit(snapshot()) }
  const publishT = api.throttled(publish)
  const onMsg = (ev) => { const txt = midiText(ev && ev.data); if (!txt) return; stat.messages++; stat.last = txt; publishT({}) }
  const attach = () => safe(() => { if (access.inputs && isFn(access.inputs.forEach)) access.inputs.forEach((p) => { if (p) p.onmidimessage = onMsg }) })
  api.cleanup(() => {
    safe(() => { access.onstatechange = null })
    safe(() => { if (access.inputs && isFn(access.inputs.forEach)) access.inputs.forEach((p) => { if (p) p.onmidimessage = null }) })
  })
  safe(() => { access.onstatechange = () => { attach(); publishT({}) } })
  attach()
  publish()
  await api.sleep(LIMITS.watchMaxMs)
  return safe(build) || build()
}

// ---- 手把 ----
const hasRumble = (p) => !!p && ((!!p.vibrationActuator && isFn(p.vibrationActuator.playEffect)) || (!!p.hapticActuators && p.hapticActuators.length > 0))
function readPads(nav) {
  const out = []
  for (const p of Array.from(nav.getGamepads() || [])) {
    if (!p || p.connected === false) continue
    out.push({
      index: num(p.index) ?? out.length, id: String(p.id || '').slice(0, 90), mapping: String(p.mapping || ''),
      buttons: Array.from(p.buttons || []).map((b) => (isObj(b) ? { pressed: !!b.pressed, value: num(b.value) ?? (b.pressed ? 1 : 0) } : { pressed: !!b, value: b ? 1 : 0 })),
      axes: Array.from(p.axes || []).map((a) => num(a) ?? 0),
      rumble: hasRumble(p),
    })
  }
  return out
}

async function gamepadBody(api) {
  const { env } = api
  const nav = env.nav
  if (!nav || !isFn(nav.getGamepads)) return { status: 'unsupported', msg: d(T('沒有 Gamepad API')) }
  const pushLive = api.throttled((p) => api.emit(p))
  let activity = false, sig = null, liveSig = null, lastOut = null
  const build = (pads) => {
    const data = { count: pads.length, pads: pads.map((p) => ({ id: p.id, mapping: p.mapping, buttons: p.buttons.length, axes: p.axes.length, rumble: p.rumble })), activity }
    if (!pads.length) return { status: 'needs-action', msg: d(T('沒有偵測到手把：接上手把後按一下任意按鍵（瀏覽器要按過才會露出手把）')), data }
    return { status: 'pass', msg: [d(T('偵測到 {n} 支手把：{names}'), { n: pads.length, names: pads.map((p) => p.id || '—').join('；') }), activity ? d(T('已收到按鍵或搖桿輸入')) : d(T('還沒收到按鍵輸入：請按幾個鍵、推一下搖桿'))], data }
  }
  const poll = () => {
    let pads
    try { pads = readPads(nav) } catch (e) { lastOut = { status: 'fail', msg: d(T('getGamepads() 丟出例外：{err}'), { err: errName(e) }) }; return false }
    for (const p of pads) if (p.buttons.some((b) => b.pressed) || p.axes.some((a) => Math.abs(a) > 0.3)) activity = true
    const s = pads.map((p) => p.index + ':' + p.id).join('|') + '#' + activity
    if (s !== sig) { sig = s; lastOut = build(pads); api.report(lastOut) }
    const ls = JSON.stringify(pads.map((p) => [p.index, p.id, p.buttons.map((b) => (b.pressed ? 1 : 0) + ':' + b.value), p.axes.map((a) => Math.round(a * 100))]))
    if (ls !== liveSig) { liveSig = ls; pushLive({ pads }) }   // 數值沒變就不更新畫面（輪詢照跑，畫面不重繪）
    return true
  }
  const w = env.win
  const onPad = () => { if (!api.cancelled) poll() }
  if (w && isFn(w.addEventListener)) {
    w.addEventListener('gamepadconnected', onPad); w.addEventListener('gamepaddisconnected', onPad)
    api.cleanup(() => { safe(() => w.removeEventListener('gamepadconnected', onPad)); safe(() => w.removeEventListener('gamepaddisconnected', onPad)) })
  }
  const t0 = tnow(env)
  while (!api.cancelled && tnow(env) - t0 < LIMITS.watchMaxMs) {
    if (!poll()) break
    if (!(await api.sleep(LIMITS.gamepadPollMs))) break
  }
  return lastOut
}

async function rumbleBody(api) {
  const { env } = api
  const nav = env.nav
  if (!nav || !isFn(nav.getGamepads)) return { status: 'unsupported', msg: d(T('沒有 Gamepad API')) }
  let pads
  try { pads = Array.from(nav.getGamepads() || []).filter((p) => p && p.connected !== false) } catch (e) { return failFromError(e) }
  if (!pads.length) return { status: 'needs-action', msg: d(T('沒有偵測到手把：接上並按一下任意按鍵後再測')) }
  const pad = pads.find(hasRumble)
  if (!pad) return { status: 'unsupported', msg: d(T('偵測到 {n} 支手把，但都沒有震動馬達（或這個瀏覽器不支援手把震動：目前只有 Chrome / Edge）'), { n: pads.length }), data: { pads: pads.length, actuator: false } }
  const act = pad.vibrationActuator && isFn(pad.vibrationActuator.playEffect) ? pad.vibrationActuator : null
  api.cleanup(() => safe(() => { const r = act && isFn(act.reset) ? act.reset() : null; if (r && isFn(r.catch)) r.catch(() => {}) }))
  try {
    let r
    if (act) r = await api.race(act.playEffect('dual-rumble', { startDelay: 0, duration: 400, weakMagnitude: 0.6, strongMagnitude: 0.6 }), LIMITS.rumbleMs)
    else r = await api.race(pad.hapticActuators[0].pulse(0.6, 400), LIMITS.rumbleMs)
    if (r === 'complete' || r === true) return { status: 'pass', msg: d(T('有震動馬達，雙馬達震動已播完（{r}）'), { r: String(r) }), data: { actuator: true, result: String(r) } }
    return { status: 'fail', msg: d(T('有震動馬達，但播放結果是 {r}'), { r: String(r) }), data: { actuator: true, result: String(r) } }
  } catch (e) {
    if (api.cancelled) return null
    return errName(e) === 'TimeoutError' ? { status: 'fail', msg: d(T('震動 {s} 秒內沒有回應'), { s: LIMITS.rumbleMs / 1000 }) } : failFromError(e)
  }
}

// ---- 手機震動（送出後請使用者回答有沒有震到；navigator.vibrate 回傳 true 只代表「已送出」）----
async function vibrateBody(api) {
  const { env } = api
  const nav = env.nav
  if (!nav || !isFn(nav.vibrate)) return { status: 'unsupported', msg: d(T('沒有震動 API（iPhone Safari 就是如此）')) }
  const pattern = LIMITS.vibratePattern
  const total = pattern.reduce((a, b) => a + b, 0)
  api.cleanup(() => safe(() => nav.vibrate(0)))   // 中途停止 / 離開頁面 → 立刻停止震動
  let ok
  try { ok = nav.vibrate(pattern) } catch (e) { return failFromError(e) }
  if (ok === false) return { status: 'fail', msg: d(T('vibrate() 回傳 false：被瀏覽器擋下（需要先點過畫面、省電模式，或分頁不在前景）')) }
  api.report({ status: 'needs-action', msg: d(T('已送出 {ms} 毫秒的震動節奏'), { ms: total }), data: { sent: true, totalMs: total } })
  if (!(await api.sleep(total))) return null
  return { status: 'needs-action', msg: d(T('已送出 {ms} 毫秒的震動節奏'), { ms: total }), data: { sent: true, totalMs: total } }
}

// ---- 觸控筆與觸控（畫板事件由畫面餵進來；不需要權限，所以不走 createProbe）----
export function createPointerTracker() {
  const counts = { mouse: 0, touch: 0, pen: 0 }
  const active = new Map()
  const pressures = new Set()
  let maxTouches = 0, penPressureMax = 0, penTilt = false, last = null
  return {
    handle(kind, ev) {   // kind：down | move | up | cancel
      if (!ev) return
      const type = ev.pointerType === 'pen' || ev.pointerType === 'touch' || ev.pointerType === 'mouse' ? ev.pointerType : 'other'
      if (type in counts) counts[type]++
      if (kind === 'down' || kind === 'move') active.set(ev.pointerId, type); else active.delete(ev.pointerId)
      let touches = 0
      for (const v of active.values()) if (v === 'touch') touches++
      maxTouches = Math.max(maxTouches, touches)
      last = { pointerType: type, pressure: num(ev.pressure), tiltX: num(ev.tiltX), tiltY: num(ev.tiltY), width: num(ev.width), height: num(ev.height) }
      if (type === 'pen') {
        const p = num(ev.pressure)
        if (p != null) { penPressureMax = Math.max(penPressureMax, p); pressures.add(round(p, 2)) }
        if ((num(ev.tiltX) || 0) !== 0 || (num(ev.tiltY) || 0) !== 0) penTilt = true
      }
    },
    snapshot() {
      return {
        seen: { mouse: counts.mouse > 0, touch: counts.touch > 0, pen: counts.pen > 0 },
        maxTouches, active: active.size, last,
        pen: { pressureMax: round(penPressureMax, 2), pressureVaries: pressures.size >= 3, tilt: penTilt },
      }
    },
    reset() { counts.mouse = counts.touch = counts.pen = 0; active.clear(); pressures.clear(); maxTouches = 0; penPressureMax = 0; penTilt = false; last = null },
  }
}
export function pointerOutcome(snap) {
  const seen = (snap && snap.seen) || {}
  const data = { mouse: !!seen.mouse, touch: !!seen.touch, pen: !!seen.pen, maxTouches: (snap && snap.maxTouches) || 0, penPressureMax: snap && snap.pen ? snap.pen.pressureMax : 0, penPressureVaries: !!(snap && snap.pen && snap.pen.pressureVaries), penTilt: !!(snap && snap.pen && snap.pen.tilt) }
  if (seen.pen) {
    return {
      status: 'pass',
      msg: [d(T('偵測到觸控筆')), d(data.penPressureVaries ? T('壓力會變化（最大 {p}）') : T('壓力沒有變化（最大 {p}）'), { p: data.penPressureMax }), d(data.penTilt ? T('有傾斜角') : T('沒有傾斜角')), seen.touch ? d(T('觸控最多 {n} 指'), { n: data.maxTouches }) : null],
      data,
    }
  }
  const got = [seen.mouse ? d(T('滑鼠輸入')) : null, seen.touch ? d(T('觸控輸入（最多 {n} 指）'), { n: data.maxTouches }) : null].filter(Boolean)
  return got.length
    ? { status: 'needs-action', msg: d(T('目前只偵測到 {got}，還沒偵測到觸控筆：用觸控筆在畫板上畫畫才會通過'), { got }), data }
    : { status: 'needs-action', msg: d(T('還沒收到任何輸入：在畫板上用手指、滑鼠或觸控筆畫畫')), data }
}

// ---- 螢幕清單 ----
const screenKind = (s) => (s.isPrimary === true ? T('主要顯示器') : s.isInternal === true ? T('內建顯示器') : s.isInternal === false ? T('外接顯示器') : T('其他顯示器'))
async function screensBody(api) {
  const { env } = api
  const w = env.win
  if (!w || !isFn(w.getScreenDetails)) return { status: 'unsupported', msg: d(T('沒有 getScreenDetails（Safari、Firefox 與非 https 沒有）：仍可手動把觀眾視窗拖到投影機')) }
  let details
  try { details = await api.race(w.getScreenDetails(), LIMITS.permMs) } catch (e) {
    if (api.cancelled) return null
    const kind = classifyMediaError(e)
    if (kind === 'denied' || kind === 'security') return { status: 'fail', msg: d(T('「視窗管理」權限被拒絕：請在網站設定允許，然後重新測試')), data: { error: errName(e) } }
    if (kind === 'timeout') return { status: 'fail', msg: d(T('等了 {s} 秒沒有回應（權限提示可能被忽略了）'), { s: round(LIMITS.permMs / 1000) }), data: { error: 'TimeoutError' } }
    return { status: 'fail', msg: d(T('讀取螢幕資訊失敗：{err}'), { err: errText(e) }), data: { error: errName(e) } }
  }
  const screens = Array.from((details && details.screens) || []).map((s) => ({
    width: num(s.width), height: num(s.height), primary: s.isPrimary === true, internal: typeof s.isInternal === 'boolean' ? s.isInternal : null, dpr: num(s.devicePixelRatio),
  }))
  api.emit({ screens })
  if (!screens.length) return { status: 'fail', msg: d(T('螢幕清單是空的')), data: { count: 0, screens } }
  const list = (details.screens ? Array.from(details.screens) : []).map((s) => d(T('{w}×{h}（{kind}）'), { w: num(s.width) ?? '—', h: num(s.height) ?? '—', kind: d(screenKind(s)) }))
  if (screens.length === 1) return { status: 'needs-action', msg: [d(T('只偵測到 1 個螢幕：{list}'), { list }), d(T('雙螢幕功能需要接上投影機或開啟延伸桌面後再測'))], data: { count: 1, screens } }
  return { status: 'pass', msg: d(T('偵測到 {n} 個螢幕：{list}'), { n: screens.length, list }), data: { count: screens.length, screens } }
}

// ---- 彈出視窗（觀眾視窗靠它）：開一個空白視窗並立刻關閉 ----
async function popupBody(api) {
  const { env } = api
  const w = env.win
  if (!w || !isFn(w.open)) return { status: 'unsupported', msg: d(T('沒有 window.open')) }
  let p = null
  try { p = w.open('about:blank', '_blank', 'popup,width=240,height=160') } catch (e) { return failFromError(e) }
  if (!p) return { status: 'fail', msg: d(T('彈出視窗被封鎖：觀眾視窗（雙螢幕）需要允許本網站的彈出視窗')), data: { blocked: true } }
  safe(() => p.close())
  return { status: 'pass', msg: d(T('可以開啟彈出視窗（已立刻關閉）')), data: { blocked: false } }
}

// ---- 方向 / 動作感測器 ----
async function orientBody(api) {
  const { env } = api
  const w = env.win
  const DOE = w && w.DeviceOrientationEvent, DME = w && w.DeviceMotionEvent
  if (!isFn(DOE) && !isFn(DME)) return { status: 'unsupported', msg: d(T('沒有 DeviceOrientation / DeviceMotion 事件（桌機通常沒有感測器）')) }
  // iOS 13+：requestPermission() 必須在使用者手勢內「同步」呼叫（第一個 await 之前）
  const asks = []
  for (const C of [DOE, DME]) if (C && isFn(C.requestPermission)) { try { asks.push(C.requestPermission()) } catch (e) { asks.push(Promise.reject(e)) } }
  if (asks.length) {
    let states
    try { states = await api.race(Promise.all(asks), LIMITS.permMs) } catch (e) { if (api.cancelled) return null; return { status: 'fail', msg: d(T('無法取得感測器權限（{err}）：iPhone / iPad 請重新整理後直接按這個按鈕'), { err: errName(e) }), data: { permission: 'error' } } }
    if (api.cancelled) return null
    if (Array.from(states || []).some((s) => s !== 'granted')) return { status: 'fail', msg: d(T('感測器權限被拒絕：請到「設定 › Safari › 動作與方向存取」允許，或重新開啟網頁後再按一次')), data: { permission: 'denied' } }
  }
  let sawEvent = false, hasO = false, hasM = false
  let resolveValid
  const validP = new Promise((r) => { resolveValid = r })
  const push = api.throttled((p) => api.emit(p))
  const onO = (ev) => {
    sawEvent = true
    const o = { alpha: num(ev && ev.alpha), beta: num(ev && ev.beta), gamma: num(ev && ev.gamma) }
    if (o.alpha != null || o.beta != null || o.gamma != null) { hasO = true; resolveValid() }
    push({ orient: o })
  }
  const onM = (ev) => {
    sawEvent = true
    const a = (ev && (ev.accelerationIncludingGravity || ev.acceleration)) || {}
    const m = { x: num(a.x), y: num(a.y), z: num(a.z) }
    if (m.x != null || m.y != null || m.z != null) { hasM = true; resolveValid() }
    push({ motion: m })
  }
  w.addEventListener('deviceorientation', onO)
  w.addEventListener('devicemotion', onM)
  api.cleanup(() => { safe(() => w.removeEventListener('deviceorientation', onO)); safe(() => w.removeEventListener('devicemotion', onM)) })
  const got = await api.until(validP, LIMITS.orientReadyMs)
  if (!got) {
    if (api.cancelled) return null
    return sawEvent
      ? { status: 'unsupported', msg: d(T('有收到事件但沒有數值：這台裝置沒有方向 / 動作感測器')), data: { events: true, orientation: false, motion: false } }
      : { status: 'fail', msg: d(T('{s} 秒內沒有收到任何感測器事件：請搖動裝置，或確認已允許存取'), { s: LIMITS.orientReadyMs / 1000 }), data: { events: false, orientation: false, motion: false } }
  }
  const out = {
    status: 'pass',
    msg: d(T('已收到感測器數值：方向 {o}、動作 {m}'), { o: d(hasO ? T('感測器有數值') : T('感測器沒有數值')), m: d(hasM ? T('感測器有數值') : T('感測器沒有數值')) }),
    data: { events: true, orientation: hasO, motion: hasM },
  }
  api.report(out)
  await api.sleep(LIMITS.watchMaxMs)   // 持續顯示即時數值，直到使用者停止 / 離開
  return out
}

// ---- 全螢幕：進入 → 停留一下 → 離開 ----
async function fullscreenBody(api) {
  const { env } = api
  const doc = env.doc
  const el = doc && doc.documentElement
  if (!el || !(isFn(el.requestFullscreen) || isFn(el.webkitRequestFullscreen))) return { status: 'unsupported', msg: d(T('沒有全螢幕 API（iPhone Safari 不支援網頁全螢幕）')) }
  if (doc.fullscreenEnabled === false || doc.webkitFullscreenEnabled === false) return { status: 'fail', msg: d(T('全螢幕被停用（權限政策或內嵌框架）')) }
  const cur = () => doc.fullscreenElement || doc.webkitFullscreenElement || null
  if (cur()) return { status: 'needs-action', msg: d(T('目前已經是全螢幕：請先離開全螢幕再測')) }
  const listeners = new Set()
  const onChange = () => { for (const f of [...listeners]) f() }
  doc.addEventListener('fullscreenchange', onChange)
  doc.addEventListener('webkitfullscreenchange', onChange)
  const exit = () => { const r = isFn(doc.exitFullscreen) ? doc.exitFullscreen() : isFn(doc.webkitExitFullscreen) ? doc.webkitExitFullscreen() : null; if (r && isFn(r.catch)) r.catch(() => {}) }
  api.cleanup(() => {
    safe(() => doc.removeEventListener('fullscreenchange', onChange))
    safe(() => doc.removeEventListener('webkitfullscreenchange', onChange))
    if (cur()) safe(exit)   // 測到一半離開頁面 / 按停止：確實退出全螢幕
  })
  const waitState = (pred) => api.until(new Promise((resolve) => { const f = () => { if (pred()) { listeners.delete(f); resolve() } }; listeners.add(f); f() }), LIMITS.fsMs)
  try {
    const r = isFn(el.requestFullscreen) ? el.requestFullscreen() : el.webkitRequestFullscreen()
    if (r && isFn(r.then)) await api.race(r, LIMITS.fsMs)
  } catch (e) {
    if (api.cancelled) return null
    return { status: 'fail', msg: d(T('進入全螢幕被拒絕（{err}）：需要在按鈕的點擊中呼叫，且沒有被權限政策禁用'), { err: errName(e) }) }
  }
  if (!(await waitState(() => !!cur()))) return api.cancelled ? null : { status: 'fail', msg: d(T('{s} 秒內沒有進入全螢幕'), { s: LIMITS.fsMs / 1000 }) }
  api.emit({ fullscreen: true })
  if (!(await api.sleep(LIMITS.fsHoldMs))) return null
  try {
    const r = isFn(doc.exitFullscreen) ? doc.exitFullscreen() : doc.webkitExitFullscreen()
    if (r && isFn(r.then)) await api.race(r, LIMITS.fsMs)
  } catch (e) { return api.cancelled ? null : failFromError(e) }
  if (!(await waitState(() => !cur()))) return api.cancelled ? null : { status: 'fail', msg: d(T('{s} 秒內沒有離開全螢幕'), { s: LIMITS.fsMs / 1000 }) }
  api.emit({ fullscreen: false })
  return { status: 'pass', msg: d(T('進入與離開全螢幕都成功')) }
}

// ───────────────────────────── 註冊表 ─────────────────────────────
export function getGroups() {
  return [
    { id: 'env', title: T('環境資訊'), kind: 'auto' },
    { id: 'gfx', title: T('圖形與效能'), kind: 'auto' },
    { id: 'web', title: T('瀏覽器功能支援'), kind: 'auto' },
    { id: 'api', title: T('裝置 API 是否存在'), kind: 'auto' },
    { id: 'media', title: T('相機、麥克風與語音（互動）'), kind: 'interactive' },
    { id: 'input', title: T('MIDI、手把與觸控筆（互動）'), kind: 'interactive' },
    { id: 'sense', title: T('震動與感測器（互動）'), kind: 'interactive' },
    { id: 'display', title: T('螢幕與視窗（互動）'), kind: 'interactive' },
  ]
}

// 「是否覺得正常」的兩個按鈕（記錄在報告裡）：required = 沒回答前狀態維持「待操作」
let cache = null
function buildChecks() {
  const okBad = { ok: T('正常'), bad: T('不正常') }
  const auto = (id, group, title, run, extra) => ({ id, group, kind: 'auto', title, run, ...(extra || {}) })
  const inter = (id, group, title, body, extra) => ({ id, group, kind: 'interactive', title, body, ...extra })
  return [
    auto('env-ua', 'env', T('瀏覽器與平台'), envUa),
    auto('env-screen', 'env', T('螢幕與視窗大小'), envScreen),
    auto('env-secure', 'env', T('安全環境（https）'), envSecure),
    auto('env-locale', 'env', T('語言與時區'), envLocale),
    auto('env-network', 'env', T('網路狀態'), envNetwork),
    auto('env-hardware', 'env', T('處理器與記憶體'), envHardware),
    auto('env-storage', 'env', T('儲存空間估計'), envStorage),
    auto('gl', 'gfx', T('WebGL 圖形'), checkGl),
    auto('fps', 'gfx', T('畫面幀率取樣（2 秒）'), checkFps),
    auto('ls', 'web', T('localStorage 讀寫'), checkLs),
    auto('bc', 'web', T('BroadcastChannel 往返'), checkBroadcast),
    auto('sw', 'web', T('Service Worker 離線'), checkSw),
    auto('share', 'web', T('Web Share 分享圖片'), checkShare),
    auto('clipboard', 'web', T('剪貼簿寫入'), checkClipboard),
    auto('fs-api', 'web', T('全螢幕 API'), checkFsApi),
    auto('wakelock', 'web', T('Screen Wake Lock 螢幕常亮'), checkWakeLock),
    auto('recorder', 'web', T('MediaRecorder 錄影格式'), checkRecorder),
    auto('midi-api', 'api', T('Web MIDI（是否存在）'), checkMidiApi),
    auto('ble-api', 'api', T('Web Bluetooth（是否存在）'), checkBleApi),
    auto('xr-api', 'api', T('WebXR AR 支援度'), checkXrApi),
    auto('speech-api', 'api', T('語音辨識（是否存在）'), checkSpeechApi),
    auto('gamepad-api', 'api', T('Gamepad 手把 API'), checkGamepadApi),
    auto('vibrate-api', 'api', T('震動 API（是否存在）'), checkVibrateApi),
    auto('pointer-api', 'api', T('PointerEvent 與觸控點數'), checkPointerApi),
    auto('screens-api', 'api', T('多螢幕 getScreenDetails（是否存在）'), checkScreensApi),

    inter('cam', 'media', T('相機（視訊預覽）'), cameraBody, {
      hint: T('按下後瀏覽器會詢問相機權限；畫面只顯示在這裡，不會錄影或上傳。'), startLabel: T('開啟相機'), stopLabel: T('關閉相機'),
      verdict: { ask: T('畫面看起來正常嗎？'), ...okBad, okNote: T('使用者確認：畫面正常'), badNote: T('使用者回報：畫面不正常'), required: false },
    }),
    inter('mic', 'media', T('麥克風（音量條）'), micBody, {
      hint: T('按下後收音 3 秒並顯示音量條，請對著麥克風說話；聲音不會被錄下或上傳。'), startLabel: T('測試麥克風'), stopLabel: T('停止'),
    }),
    inter('speech', 'media', T('語音辨識（收音 5 秒）'), speechBody, {
      hint: T('按下後收音 5 秒並顯示辨識文字，請說一句話。Chrome 的語音辨識會把聲音送到雲端服務；報告只記字數，不記內容。'), startLabel: T('開始收音'), stopLabel: T('停止'),
    }),
    inter('midi', 'input', T('Web MIDI 裝置清單'), midiBody, {
      hint: T('接上 MIDI 控制器後按下；轉動旋鈕或按鍵可以看到收到的訊息數。'), startLabel: T('列出 MIDI 裝置'), stopLabel: T('停止監聽'),
    }),
    inter('gamepad', 'input', T('手把（即時按鍵與搖桿）'), gamepadBody, {
      hint: T('接上手把後按一下任意按鍵，會列出手把並即時顯示按鍵與搖桿數值。'), startLabel: T('開始偵測手把'), stopLabel: T('停止偵測'),
    }),
    inter('rumble', 'input', T('手把震動測試'), rumbleBody, {
      hint: T('對第一支支援震動的手把送出一段雙馬達震動。'), startLabel: T('震動測試'), stopLabel: T('停止'),
    }),
    { id: 'pointer', group: 'input', kind: 'interactive', custom: 'pointer', title: T('觸控筆與觸控畫板'), hint: T('在下方畫板用手指、滑鼠或觸控筆畫畫；偵測到觸控筆才算通過。') },
    inter('vibrate', 'sense', T('手機震動（實測）'), vibrateBody, {
      hint: T('按下後手機會震動約 1 秒，接著請回答有沒有震到。'), startLabel: T('震動一下'), stopLabel: T('停止'),
      verdict: { ask: T('有震到嗎？'), ok: T('是，有震到'), bad: T('否，沒震到'), okNote: T('使用者確認：有感覺到震動'), badNote: T('使用者回報：沒有感覺到震動'), required: true },
    }),
    inter('orient', 'sense', T('方向與動作感測器'), orientBody, {
      hint: T('iPhone / iPad 會先詢問權限；搖動或旋轉裝置，數值會即時變化。'), startLabel: T('開始讀取感測器'), stopLabel: T('停止讀取'),
    }),
    inter('screens', 'display', T('螢幕清單（getScreenDetails）'), screensBody, {
      hint: T('按下後瀏覽器可能詢問「視窗管理」權限；接上投影機或開啟延伸桌面後應看到 2 個以上的螢幕。'), startLabel: T('列出螢幕'), stopLabel: T('停止'),
    }),
    inter('popup', 'display', T('彈出視窗測試'), popupBody, {
      hint: T('開啟一個空白視窗並立刻關閉，確認觀眾視窗不會被彈出視窗封鎖擋住。'), startLabel: T('測試彈出視窗'), stopLabel: T('停止'),
    }),
    inter('fullscreen', 'display', T('全螢幕進入與離開'), fullscreenBody, {
      hint: T('進入全螢幕約 1 秒後自動離開。'), startLabel: T('測試全螢幕'), stopLabel: T('停止'),
      verdict: { ask: T('全螢幕的畫面正常嗎？'), ...okBad, okNote: T('使用者確認：全螢幕畫面正常'), badNote: T('使用者回報：全螢幕畫面不正常'), required: false },
    }),
  ]
}
export function getChecks() { return cache || (cache = buildChecks()) }
export const getAutoChecks = () => getChecks().filter((c) => c.kind === 'auto')
export const getInteractiveChecks = () => getChecks().filter((c) => c.kind === 'interactive')
export function getCheck(id) { return getChecks().find((c) => c.id === id) || null }

// ───────────────────────────── 執行器 ─────────────────────────────
// 執行單一自動檢查：任何例外 / 逾時都變成 fail 結果（不會丟出）；不論成敗都通知該項放掉資源。
export async function runCheck(check, env, opts = {}) {
  const e = env || {}
  const guardMs = opts.guardMs || check.guardMs || LIMITS.guardMs
  const local = createCancel()
  const off = opts.cancel ? opts.cancel.onCancel(() => local.cancel()) : null
  const t0 = tnow(e)
  let out
  try {
    out = await raceTimeout(e, Promise.resolve().then(() => check.run(e, { cancel: local })), guardMs)
  } catch (err) {
    out = errName(err) === 'TimeoutError' ? { status: 'fail', msg: d(T('逾時：沒有在時限內得到結果')) } : failFromError(err)
  } finally {
    local.cancel()
    if (off) off()
  }
  return makeResult(check, out, tnow(e) - t0)
}

// 依序執行所有自動檢查（「執行所有快速檢查」）。onStart(check) / onResult(result) 逐項回報；cancel 取消後停在下一項之前。
export async function runAutoChecks(env, opts = {}) {
  const checks = opts.checks || getAutoChecks()
  const cancel = opts.cancel || createCancel()
  const out = []
  for (const c of checks) {
    if (cancel.cancelled) break
    if (isFn(opts.onStart)) safe(() => opts.onStart(c))
    const r = await runCheck(c, env, { cancel, guardMs: opts.guardMs })
    out.push(r)
    if (isFn(opts.onResult)) safe(() => opts.onResult(r))
  }
  return out
}

// 使用者的「正常 / 不正常」判斷疊加在機器結果上：只有技術上成功（pass / needs-action）才套用；不正常 → 失敗。
export function applyVerdict(check, result, verdict) {
  const spec = check && check.verdict
  if (!result || !spec || (verdict !== 'ok' && verdict !== 'bad')) return result
  if (result.status !== 'pass' && result.status !== 'needs-action') return result
  const note = d(verdict === 'ok' ? spec.okNote : spec.badNote)
  const base = result.msg != null ? result.msg : (result.detail || null)
  const msg = base ? [base, note] : note
  return { ...result, status: verdict === 'ok' ? 'pass' : 'fail', verdict, msg, detail: fmtMsg(msg) }
}

// ───────────────────────────── 報告 ─────────────────────────────
const stripHash = (u) => { const s = String(u || ''); const i = s.indexOf('#'); return i >= 0 ? s.slice(0, i) : s }   // #remote=<id> 之類的連線碼不進報告

export function collectMeta(env, now = Date.now()) {
  const e = env || {}
  const nav = e.nav || {}
  const loc = (e.win && e.win.location) || {}
  let tz = null
  try { tz = e.Intl && e.Intl.DateTimeFormat().resolvedOptions().timeZone } catch (err) { tz = null }
  return {
    generatedAt: new Date(now).toISOString(),
    url: stripHash(loc.href),
    userAgent: String(nav.userAgent || ''),
    platform: String((nav.userAgentData && nav.userAgentData.platform) || nav.platform || ''),
    language: String(nav.language || ''),
    timeZone: tz || null,
    screen: screenInfo(e),
  }
}

const cell = (s) => String(s == null ? '' : s).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
const screenLine = (s) => `${s.width ?? '—'}×${s.height ?? '—'} @${s.dpr ?? '—'}x; viewport ${s.viewportWidth ?? '—'}×${s.viewportHeight ?? '—'}`

// 報告：Markdown 表格 + JSON。results：id → 結果（含使用者判斷）。不含任何個資 / IP / 影像 / 音訊。
export function buildReport({ checks = getChecks(), results = {}, meta = {}, tr = t, locale = 'zh' } = {}) {
  const groups = new Map(getGroups().map((g) => [g.id, g]))
  const rows = checks.map((c) => {
    const r = results[c.id]
    const g = groups.get(c.group)
    return {
      id: c.id, group: c.group, groupTitle: g ? tr(g.title) : c.group, title: tr(c.title),
      status: r ? r.status : 'not-run',
      detail: r ? renderDetail(r, tr) : '',
      ms: r ? r.ms : null,
      ...(r && r.verdict ? { verdict: r.verdict } : {}),
      ...(r && r.data != null ? { data: r.data } : {}),
    }
  })
  const summary = summarize(checks, results)
  const json = {
    app: 'MidiSea', kind: 'device-diagnostics', version: DIAG_VERSION,
    generatedAt: meta.generatedAt || null, url: meta.url || '', locale,
    userAgent: meta.userAgent || '', platform: meta.platform || '', language: meta.language || '', timeZone: meta.timeZone || null,
    screen: meta.screen || null, summary,
    results: rows.map(({ groupTitle, ...r }) => r),
  }
  const lines = [
    '# ' + tr(T('MidiSea 裝置診斷報告')),
    '',
    '- ' + tr(T('產生時間：{v}'), { v: json.generatedAt || '—' }),
    '- ' + tr(T('網址：{v}'), { v: json.url || '—' }),
    '- ' + tr(T('瀏覽器 UA：{v}'), { v: json.userAgent || '—' }),
    '- ' + tr(T('螢幕與視窗：{v}'), { v: meta.screen ? screenLine(meta.screen) : '—' }),
    '- ' + tr(T('摘要：通過 {pass}、失敗 {fail}、不支援 {unsupported}、尚未測 {pending}（共 {total} 項）'), summary),
    '- ' + tr(T('本報告不含個人資料、IP、影像或音訊。')),
    '',
    tr(T('| 群組 | 項目 | 狀態 | 詳情 | 耗時 (ms) |')),
    '| --- | --- | --- | --- | ---: |',
    ...rows.map((r) => `| ${cell(r.groupTitle)} | ${cell(r.title)} | ${cell(tr(statusKey(r.status)))} | ${cell(r.detail)} | ${r.ms == null ? '' : r.ms} |`),
  ]
  const markdown = lines.join('\n')
  return { json, markdown, summary, text: markdown + '\n\n```json\n' + JSON.stringify(json, null, 2) + '\n```\n' }
}

export function reportFileName(now = Date.now()) {
  const x = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `midisea-diagnostics-${x.getFullYear()}${p(x.getMonth() + 1)}${p(x.getDate())}-${p(x.getHours())}${p(x.getMinutes())}${p(x.getSeconds())}.json`
}

// 複製文字：先用 Clipboard API（需要 https 與使用者手勢），失敗退回 execCommand('copy')，都不行回 { ok:false }（畫面改顯示可手動全選的文字框）
export async function copyText(text, env) {
  const nav = env && env.nav, doc = env && env.doc
  if (nav && nav.clipboard && isFn(nav.clipboard.writeText)) {
    try { await nav.clipboard.writeText(text); return { ok: true, method: 'clipboard' } } catch (e) { /* 權限不足 / 沒有手勢：試備援 */ }
  }
  if (doc && doc.body && isFn(doc.createElement) && isFn(doc.execCommand)) {
    let ta = null, ok = false
    try {
      ta = doc.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.left = '-9999px'; ta.style.opacity = '0'
      doc.body.appendChild(ta)
      ta.select()
      if (isFn(ta.setSelectionRange)) ta.setSelectionRange(0, text.length)
      ok = doc.execCommand('copy') === true
    } catch (e) { ok = false }
    if (ta) safe(() => doc.body.removeChild(ta))
    if (ok) return { ok: true, method: 'execCommand' }
  }
  return { ok: false, method: null }
}

// 下載文字檔（JSON 報告）。回傳 { ok, name, revoke }：revoke() 立刻釋放 object URL 並取消延後釋放的計時器（畫面卸載時呼叫）。
export function downloadText(text, name, env, type = 'application/json') {
  const doc = env && env.doc, URLc = env && env.URL, BlobC = env && env.Blob
  if (!doc || !doc.body || !isFn(doc.createElement) || !URLc || !isFn(URLc.createObjectURL) || !isFn(BlobC)) return { ok: false, name, revoke() {} }
  let url = null, timer = null
  try {
    url = URLc.createObjectURL(new BlobC([text], { type }))
    const a = doc.createElement('a')
    a.href = url; a.download = name; a.rel = 'noopener'; a.style.display = 'none'
    doc.body.appendChild(a)
    a.click()
    safe(() => doc.body.removeChild(a))
  } catch (e) {
    if (url) safe(() => URLc.revokeObjectURL(url))
    return { ok: false, name, revoke() {} }
  }
  const revoke = () => { if (timer != null) { tclear(env, timer); timer = null } if (url) { const u = url; url = null; safe(() => URLc.revokeObjectURL(u)) } }
  timer = tset(env, () => { timer = null; revoke() }, 10000)
  return { ok: true, name, revoke }
}
