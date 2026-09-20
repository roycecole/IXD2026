// 相機手勢的執行層：相機 + MediaPipe HandLandmarker 載入 + 偵測迴圈 + 共用狀態（zustand）。
//   分類 / 狀態機 / 參數對應在 lib/gestures.js（純函式）；這裡只負責「把影像變成 landmark 送出去」。
//
//   · MediaPipe（@mediapipe/tasks-vision）只在使用者打開手勢時「動態 import」，不進主 bundle。
//   · 相機：AR 實景已開 → 直接重用 arState.video（不開第二個相機）；否則自己開隱藏的 <video>（前鏡頭、640x480）。
//     AR 開關中途切換會自動換來源；關閉手勢 / 離開時停掉自己開的所有 track（AR 的串流不是我們的，不碰）。
//   · 偵測 ≤ 15 fps（requestVideoFrameCallback + 最小間隔節流；沒有 rVFC 時退回計時器）；推論在主執行緒同步執行，
//     所以節流也看「推論花了多久」：慢的裝置（舊手機 / 舊 iPad）會拉長間隔，讓主執行緒有時間畫 React / three（見 restAfter）。
//   · 頁面隱藏時暫停偵測「並放掉自己開的相機」（與語音一致：切走分頁後相機指示燈要熄）；回到前景再重開。AR 共用的相機不是我們的，不碰。
//   · 所有瀏覽器相依（getUserMedia、計時器、可見性、動態 import）都可注入（createHandsRuntime 的 opts.env），
//     gestures.test.mjs 用假相機 / 假 landmarker 測生命週期。
import { create } from 'zustand'
import { T } from '../i18n/index.js'
import { arState } from './ar.js'

// ---- 版本與資源（WASM 與 JS 版本必須一致，否則載入失敗；package.json 釘死同一版，gestures.test.mjs 有檢查）----
export const VISION_VERSION = '1.0.1'
export const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/wasm`
export const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
export const DETECT_INTERVAL_MS = 66      // 名目間隔（≈15 fps）：沒有 rVFC 時的輪詢週期，也是 rVFC 路徑的保底計時
const MIN_GAP_MS = DETECT_INTERVAL_MS - 2  // 兩次偵測的最小間隔；容許計時器提早醒來與影像幀時間抖動（30fps 相機 → 每隔一幀偵測＝15fps）
const REST_FACTOR = 2                     // 推論花了 d 毫秒 → 至少讓主執行緒喘 2d 毫秒（佔用率 ≤ 1/3）
const MAX_REST_MS = 100                   // 上限：再慢也不把偵測間隔拉到手勢狀態機的容忍（openGraceMs≈150ms）以外太多
// 推論結束後至少要休息多久（純函式，可測）：快的裝置（d 小）= 0，行為與只看名目間隔完全相同
export const restAfter = (durationMs) => (durationMs > 0 ? Math.min(MAX_REST_MS, REST_FACTOR * durationMs) : 0)
const LOAD_TIMEOUT_MS = 60000             // 模型 / WASM 載入的逾時（約 8MB + 11MB WASM；慢網路給足時間）
const MAX_DETECT_FAILS = 8

const noop = () => {}

// ---- 共用狀態（Section 顯示、Service 驅動、徽章讀取）----
//   enabled：使用者的意圖（開關）；phase：'off' | 'loading' | 'running' | 'error'
//   error：{ code, detail }；camera：null | 'own'（自己的相機）| 'shared'（重用 AR 實景的相機）
//   state：'idle'|'open_palm'|'pinch'|'other'；calm：平靜中
//   wave：最近一次「揮手換站」的動作（'next' | 'prev'，顯示約 2 秒後由 GestureService 清成 null）
//   waveNav：「揮手換站」開關（預設開；不在 OFF 裡——關閉 / 重新啟用相機手勢不會重設它。只在手勢已啟用且資料導覽進行中才有作用）
const OFF = { enabled: false, phase: 'off', error: null, camera: null, delegate: null, state: 'idle', calm: false, wave: null }
export const useHandsStore = create(() => ({ ...OFF, waveNav: true }))

export function setWaveNav(on) { useHandsStore.setState({ waveNav: !!on, wave: null }) }

export function setGestureEnabled(on) {
  if (!on) { useHandsStore.setState({ ...OFF }); return true }
  const sup = gestureSupport()
  if (!sup.ok) { useHandsStore.setState({ ...OFF, phase: 'error', error: { code: sup.code, detail: null } }); return false }
  useHandsStore.setState({ ...OFF, enabled: true, phase: 'loading' })
  return true
}

// ---- 支援性檢查（不啟動任何東西）----
export function gestureSupport(env = globalThis) {
  const nav = env.navigator
  if (env.isSecureContext === false) return { ok: false, code: 'insecure' }        // http（非 localhost）沒有 mediaDevices
  if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function') return { ok: false, code: 'no-camera-api' }
  if (typeof env.WebAssembly === 'undefined') return { ok: false, code: 'no-wasm' }
  return { ok: true, code: null }
}

// ---- 給 UI 用的文字 key（顯示時才 t()，語系切換會跟著變）----
const ERROR_KEYS = {
  insecure: T('手勢需要 HTTPS 連線才能使用相機（本機 localhost 也可以）'),
  'no-camera-api': T('這個瀏覽器不支援相機存取'),
  'no-wasm': T('這個瀏覽器不支援 WebAssembly，無法執行手勢辨識'),
  denied: T('相機權限被拒絕：請在網址列的相機圖示允許後再試一次'),
  'no-camera': T('找不到相機裝置'),
  busy: T('相機正被其他程式或分頁使用，或無法啟動'),
  camera: T('相機無法啟動'),
  offline: T('目前離線：第一次啟用需要下載手勢模型（約 8 MB），連上網路後再試'),
  load: T('手勢模型載入失敗（無法連到 jsDelivr 或 Google 儲存空間），請檢查網路後再試'),
  lost: T('相機中斷了（被系統或其他分頁收走）'),
  detect: T('手勢辨識執行失敗'),
}
export function errorKey(code) { return ERROR_KEYS[code] || ERROR_KEYS.camera }

const STATE_KEYS = { open_palm: T('張手'), pinch: T('捏合') }
export function stateLabel(t, state) { const k = STATE_KEYS[state]; return k ? t(k) : '—' }

// 揮手動作的名稱（跟導覽的「下一站 / 上一站」同一組詞）
const WAVE_KEYS = { next: T('下一站'), prev: T('上一站') }
export function waveLabel(t, action) { const k = WAVE_KEYS[action]; return k ? t(k) : '—' }

// ---- 錯誤分類 ----
function cameraErrorCode(e) {
  const n = e && e.name
  if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return 'denied'
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError') return 'no-camera'
  if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return 'busy'
  return 'camera'
}
function loadErrorCode(e, online) { return online === false ? 'offline' : 'load' }
const errMsg = (e) => (e && (e.message || e.name)) || String(e || '')

// ---- 瀏覽器環境（測試時由 opts.env 覆寫）----
function createHiddenVideo() {
  const v = document.createElement('video')
  v.muted = true; v.playsInline = true; v.autoplay = true
  v.setAttribute('playsinline', ''); v.setAttribute('muted', ''); v.setAttribute('aria-hidden', 'true'); v.tabIndex = -1
  // 不用 display:none（部分瀏覽器不解碼隱藏的 video）；縮成 2px、幾乎透明、不吃事件
  Object.assign(v.style, { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0.01', pointerEvents: 'none', zIndex: '-1' })
  document.body.appendChild(v)
  return v
}
function browserEnv() {
  const g = globalThis
  return {
    now: () => (g.performance ? g.performance.now() : Date.now()),
    importVision: () => import('@mediapipe/tasks-vision'),   // 動態載入：Vite 會拆成獨立 chunk，不進主 bundle
    getUserMedia: (c) => g.navigator.mediaDevices.getUserMedia(c),
    getArVideo: () => (arState.on && arState.video ? arState.video : null),
    createVideo: createHiddenVideo,
    isHidden: () => !!(g.document && g.document.hidden),
    onVisibility: (cb) => { g.document.addEventListener('visibilitychange', cb); return () => g.document.removeEventListener('visibilitychange', cb) },
    setTimeout: (f, ms) => g.setTimeout(f, ms),
    clearTimeout: (id) => g.clearTimeout(id),
    isOnline: () => !(g.navigator && g.navigator.onLine === false),
    support: () => gestureSupport(g),
    loadTimeoutMs: LOAD_TIMEOUT_MS,
  }
}

// ---- 執行層 ----
// createHandsRuntime({ onFrame(landmarks|null, nowMs, { aspect, reset }), onStatus(patch), env? })
//   → { start(), stop() }（都可重複呼叫）。onStatus 的 patch 欄位＝ useHandsStore 的欄位（phase / error / camera / delegate）。
export function createHandsRuntime(opts = {}) {
  const E = { ...browserEnv(), ...(opts.env || {}) }
  const onStatus = opts.onStatus || noop
  const onFrame = opts.onFrame || noop

  let started = false, stopped = false, paused = false, rebuilding = false, owning = false
  let vision = null, fileset = null, landmarker = null, delegate = null
  let own = null                     // { video, stream }
  let srcKind = null                 // 'ar' | 'own' | null（相機還沒準備好）
  let cancelNext = noop, offVis = noop
  let nextDetectAt = -Infinity, lastTs = 0, lastVideoTime = -1, failStreak = 0   // nextDetectAt：最早可以再偵測的時間（名目間隔 + 推論後的休息）

  const currentVideo = () => (srcKind === 'ar' ? E.getArVideo() : srcKind === 'own' && own ? own.video : null)

  // ---- 釋放 ----
  function closeOwn() {
    if (!own) return
    const { video, stream } = own
    own = null
    try { stream.getTracks().forEach((tr) => { tr.onended = null; tr.stop() }) } catch (e) { /* ignore */ }
    try { video.pause && video.pause(); video.srcObject = null; video.remove && video.remove() } catch (e) { /* ignore */ }
  }
  function closeLandmarker() {
    const lm = landmarker
    landmarker = null; delegate = null
    try { lm && lm.close && lm.close() } catch (e) { /* ignore */ }
  }
  function teardown() {
    stopped = true
    cancelNext(); cancelNext = noop
    offVis(); offVis = noop
    closeOwn(); closeLandmarker()
    srcKind = null
  }
  function stop() {
    if (stopped) return
    teardown()
    onStatus({ phase: 'off', camera: null, delegate: null })
  }
  function fail(code, detail) {
    if (stopped) return
    teardown()
    onStatus({ phase: 'error', error: { code, detail: detail || null }, camera: null, delegate: null })
  }

  function withTimeout(p, ms) {
    return new Promise((resolve, reject) => {
      const id = E.setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), ms)
      Promise.resolve(p).then((v) => { E.clearTimeout(id); resolve(v) }, (e) => { E.clearTimeout(id); reject(e) })
    })
  }

  // ---- 相機 ----
  async function openOwn() {
    if (owning || stopped) return false
    owning = true
    try {
      let stream
      try { stream = await E.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 }, audio: false }) }
      catch (e) {
        if (e && e.name === 'OverconstrainedError') stream = await E.getUserMedia({ video: true, audio: false })   // 裝置不支援指定解析度 / 鏡頭方向 → 放寬
        else throw e
      }
      if (stopped) { stream.getTracks().forEach((tr) => tr.stop()); return false }   // 等相機的期間使用者已關掉 → 立刻放掉
      const video = E.createVideo()
      video.srcObject = stream
      own = { video, stream }
      stream.getVideoTracks().forEach((tr) => { tr.onended = () => { if (own && own.stream === stream) fail('lost') } })
      try { await video.play() } catch (e) { /* autoplay 屬性通常已夠；play() 被擋不算失敗 */ }
      if (stopped) return false
      srcKind = 'own'
      onStatus({ camera: 'own' })
      return true
    } catch (e) {
      fail(cameraErrorCode(e), errMsg(e))
      return false
    } finally { owning = false }
  }
  async function acquireSource() {
    if (E.getArVideo()) { srcKind = 'ar'; onStatus({ camera: 'shared' }); return true }   // AR 已開：共用，不開第二個相機
    return openOwn()
  }

  // ---- 模型 ----
  async function buildLandmarker(prefer = 'GPU') {
    const FR = vision.FilesetResolver || (vision.default && vision.default.FilesetResolver)
    const HL = vision.HandLandmarker || (vision.default && vision.default.HandLandmarker)
    if (!FR || !HL) throw new Error('MediaPipe API missing')
    if (!fileset) fileset = await FR.forVisionTasks(WASM_BASE)
    const make = (d) => HL.createFromOptions(fileset, { baseOptions: { modelAssetPath: MODEL_URL, delegate: d }, runningMode: 'VIDEO', numHands: 1 })
    let lm, used = prefer
    if (prefer === 'GPU') {
      try { lm = await make('GPU') } catch (e) { if (stopped) throw e; used = 'CPU'; lm = await make('CPU') }   // GPU 不行就退 CPU
    } else lm = await make('CPU')
    if (stopped) { try { lm.close && lm.close() } catch (e) { /* ignore */ } return }
    closeLandmarker()
    landmarker = lm; delegate = used
    onStatus({ delegate: used })
  }

  // ---- 偵測迴圈 ----
  function scheduleNext(video) {
    cancelNext()
    cancelNext = noop
    if (stopped || paused) return
    let done = false, rid = null, tid = null
    const clear = () => {
      done = true
      if (tid != null) E.clearTimeout(tid)
      if (rid != null && video && typeof video.cancelVideoFrameCallback === 'function') { try { video.cancelVideoFrameCallback(rid) } catch (e) { /* ignore */ } }
    }
    const go = () => { if (done) return; clear(); cancelNext = noop; tick() }
    if (video && typeof video.requestVideoFrameCallback === 'function') { try { rid = video.requestVideoFrameCallback(go) } catch (e) { rid = null } }
    // 有 rVFC：等下一個影像幀（每幀醒來只做節流判斷）；保底計時器一定會醒：影片暫停 / 隱藏 / 瀏覽器不觸發 rVFC 時也維持偵測
    tid = E.setTimeout(go, DETECT_INTERVAL_MS)
    cancelNext = clear
  }

  function tick() {
    if (stopped || paused) return
    if (E.isHidden()) { pause(); return }
    const now = E.now()
    if (now < nextDetectAt) { scheduleNext(currentVideo()); return }   // 節流：≈15 fps，且推論慢時讓出主執行緒

    // 來源自適應：AR 開 → 共用它的相機並放掉自己的；AR 關 → 改開自己的
    const ar = E.getArVideo()
    if (ar && srcKind !== 'ar') { closeOwn(); srcKind = 'ar'; lastVideoTime = -1; onStatus({ camera: 'shared' }) }
    else if (!ar && srcKind === 'ar') {
      srcKind = null; onStatus({ camera: null }); safeFrame(null, now, { reset: true })
      openOwn().then((ok) => {
        if (!ok || stopped) return
        if (paused) { releaseOwnCamera(); return }            // 重開的期間頁面被藏起來：不留相機開著
        scheduleNext(currentVideo())
      })
      return
    }
    if (srcKind == null) return       // 相機準備中：openOwn 完成後會重新排程

    const video = currentVideo()
    if (!landmarker || rebuilding || !video || video.readyState < 2 || !(video.videoWidth > 0) || video.currentTime === lastVideoTime) { scheduleNext(video); return }
    lastVideoTime = video.currentTime
    nextDetectAt = now + MIN_GAP_MS
    let lm = null
    try {
      const ts = Math.max(now, lastTs + 1)            // MediaPipe VIDEO 模式要求時間戳嚴格遞增
      lastTs = ts
      const res = landmarker.detectForVideo(video, ts)
      lm = (res && res.landmarks && res.landmarks[0]) || null
      failStreak = 0
    } catch (e) { onDetectError(e); return }
    // 推論是主執行緒上的同步呼叫：舊手機 / 舊 iPad 上一次要數十毫秒，光靠名目間隔會讓它幾乎一直在算（React 與 three 的 rAF 被餓到、FPS 掉，
    // 而自動畫質降級並不會減少推論成本 → 永遠升不回來）。量這次花了多久，下一次至少等到「推論結束後再休息 restAfter(d)」。
    const rest = restAfter(E.now() - now)
    if (rest > 0) nextDetectAt = Math.max(nextDetectAt, E.now() + rest)
    safeFrame(lm, now, { aspect: video.videoWidth / video.videoHeight })
    scheduleNext(video)
  }

  function safeFrame(lm, now, info) { try { onFrame(lm, now, info) } catch (e) { /* 呼叫端的錯誤不該讓偵測迴圈停掉 */ } }

  function onDetectError(e) {
    failStreak++
    if (delegate === 'GPU') {                           // GPU 跑不動 → 退 CPU 重建一次
      rebuilding = true
      buildLandmarker('CPU').then(() => { rebuilding = false; failStreak = 0; if (!stopped) scheduleNext(currentVideo()) })
        .catch((err) => fail(loadErrorCode(err, E.isOnline()), errMsg(err)))
      return
    }
    if (failStreak >= MAX_DETECT_FAILS) { fail('detect', errMsg(e)); return }
    scheduleNext(currentVideo())
  }

  // ---- 頁面隱藏時暫停 ----
  // 暫停偵測並放掉「自己開的」相機（桌面 Chrome / Edge 在分頁隱藏時仍會持續擷取，指示燈一直亮）；AR 共用的相機不是我們的，不碰。
  function releaseOwnCamera() {
    if (srcKind !== 'own') return
    closeOwn(); srcKind = null; lastVideoTime = -1
    onStatus({ camera: null })
  }
  function pause() {
    if (paused) return
    paused = true
    cancelNext(); cancelNext = noop
    releaseOwnCamera()
    safeFrame(null, E.now(), { reset: true })
  }
  function onVisibility() {
    if (stopped) return
    if (E.isHidden()) pause()
    else if (paused) {
      paused = false; lastVideoTime = -1
      if (srcKind == null && !E.getArVideo()) {          // 隱藏期間放掉了自己的相機 → 重開（權限已授予，通常不會再跳提示）
        openOwn().then((ok) => {
          if (!ok || stopped) return                       // 失敗 → openOwn 內已 fail()（顯示原因）
          if (paused) { releaseOwnCamera(); return }       // 重開的期間又被藏起來（快速切分頁）→ 立刻放掉，不留相機開著
          scheduleNext(currentVideo())
        })
      } else scheduleNext(currentVideo())
    }
  }

  async function start() {
    if (started || stopped) return
    started = true
    onStatus({ phase: 'loading', error: null })
    const sup = E.support()
    if (!sup.ok) { fail(sup.code); return }
    try {
      const visionP = Promise.resolve(E.importVision())   // 先開始下載程式（很小），與相機授權並行
      visionP.catch(noop)                                  // 若相機失敗不會 await 它，避免 unhandled rejection
      if (!(await acquireSource())) return                 // 相機先行：被拒絕就不下載 8MB 模型
      if (stopped) return
      vision = await withTimeout(visionP, E.loadTimeoutMs)
      if (stopped) return
      await withTimeout(buildLandmarker('GPU'), E.loadTimeoutMs)
      if (stopped) { closeLandmarker(); return }
      onStatus({ phase: 'running', delegate })
      offVis = E.onVisibility(onVisibility)
      if (E.isHidden()) pause()
      else scheduleNext(currentVideo())
    } catch (e) {
      fail(loadErrorCode(e, E.isOnline()), errMsg(e))
    }
  }

  return { start, stop }
}
