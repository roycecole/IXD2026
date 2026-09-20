// 自動畫質的「執行期膠水」：用 rAF 量每幀 dt 餵給 lib/quality.js 的狀態機，並依環境事件暫停 / 恢復調整。
// 從 services/QualityService.jsx 抽出來，瀏覽器 API（window / document / rAF / 計時器 / 時鐘）全部可注入，所以能在 node 用假物件測（見 qualityRuntime.test.mjs）。
//
// 暫停調整（狀態機不收樣本、不換級；顯示用的「目前 FPS」照量）的時機：
//   hidden   分頁隱藏（visibilitychange）
//   rec      錄製（app store 的 rec.mode === 'recording'）
//   capture  錄影（TopBar 沒有共用旗標，讀它的錄影鈕 [data-k="capture"]：錄影期間 disabled；找不到按鈕 → 視為沒有錄影）
//   drag     使用者拖曳：任何指標按住超過 dragMs（單擊 / 輕點不打斷取樣）
//   xr       WebXR 桌面放置進行中（lib/xr.js 進出時廣播 window 的 'midisea:xr' 事件；immersive 期間 window rAF 會停，結束後第一幀 dt 很大，會被誤判成慢）
import { createQualityController } from './quality.js'

export const DRAG_MS = 300          // 按住超過這麼久才算「拖曳」
export const STUCK_MS = 30000       // 指標事件遺失（例如視窗失焦時放開）的保險：按住超過這麼久就當作已放開
export const POLL_MS = 500          // 錄影鈕狀態、指標保險的輪詢間隔
export const REPORT_MS = 1000       // 每秒回報一次 FPS 給畫面

export function startQualityRuntime(opts = {}) {
  const g = globalThis
  const win = opts.win || g.window
  const doc = opts.doc || g.document
  if (!win || !doc) return { stop() {}, controller: null }           // 沒有瀏覽器環境（SSR / node）→ 什麼都不做
  const store = opts.store                                            // lib/qualityStore.js 的 store（必要）
  const appStore = opts.appStore || null                              // App 的 useStore（讀 rec.mode；可省略）
  const now = opts.now || (() => (g.performance ? g.performance.now() : Date.now()))
  const raf = opts.raf || ((cb) => g.requestAnimationFrame(cb))
  const caf = opts.caf || ((id) => g.cancelAnimationFrame(id))
  const setIv = opts.setInterval || ((fn, ms) => g.setInterval(fn, ms))
  const clrIv = opts.clearInterval || ((id) => g.clearInterval(id))
  const setTo = opts.setTimeout || ((fn, ms) => g.setTimeout(fn, ms))
  const clrTo = opts.clearTimeout || ((id) => g.clearTimeout(id))
  const dragMs = opts.dragMs ?? DRAG_MS, stuckMs = opts.stuckMs ?? STUCK_MS
  const videoCapturing = opts.videoCapturing || (() => { try { return !!doc.querySelector('[data-k="capture"]:disabled') } catch (e) { return false } })

  const st0 = store.getState()
  const ctl = createQualityController({ mode: st0.mode, startTier: st0.tier, ...(opts.controller || {}), onChange: (tier, info) => store.getState().applyChange(tier, info) })

  // ---- 暫停原因 ----
  const setPause = (reason, on) => { if (on) ctl.pause(reason, now()); else ctl.resume(reason, now()) }
  const onVis = () => setPause('hidden', !!doc.hidden)
  doc.addEventListener('visibilitychange', onVis)
  onVis()
  const onXr = (e) => setPause('xr', !!(e && e.detail && e.detail.active))
  win.addEventListener('midisea:xr', onXr)

  const recOf = (s) => !!(s && s.rec && s.rec.mode === 'recording')
  let unsubRec = () => {}
  if (appStore) {
    setPause('rec', recOf(appStore.getState()))
    unsubRec = appStore.subscribe((s, prev) => { const r = recOf(s); if (r !== recOf(prev)) setPause('rec', r) })
  }

  // ---- 拖曳：任何指標按住超過 dragMs → 暫停；全部放開 → 解除 ----
  const downs = new Set()
  let lastDownAt = 0, dragTimer = null, dragging = false
  const releaseDrag = () => { if (dragTimer != null) { clrTo(dragTimer); dragTimer = null } if (dragging) { dragging = false; setPause('drag', false) } }
  const onDown = (e) => {
    downs.add(e.pointerId); lastDownAt = now()
    if (dragTimer == null && !dragging) dragTimer = setTo(() => { dragTimer = null; if (downs.size && !dragging) { dragging = true; setPause('drag', true) } }, dragMs)
  }
  const onUp = (e) => { downs.delete(e.pointerId); if (!downs.size) releaseDrag() }
  const onBlur = () => { downs.clear(); releaseDrag() }
  win.addEventListener('pointerdown', onDown, true)
  win.addEventListener('pointerup', onUp, true)
  win.addEventListener('pointercancel', onUp, true)
  win.addEventListener('blur', onBlur)

  // ---- 每 POLL_MS：錄影狀態 + 指標事件遺失的保險 ----
  let capturing = false
  const ivPoll = setIv(() => {
    const c = !!videoCapturing()
    if (c !== capturing) { capturing = c; setPause('capture', c) }
    if (downs.size && now() - lastDownAt > stuckMs) { downs.clear(); releaseDrag() }
  }, POLL_MS)

  // ---- 使用者在裝置面板選模式 → 通知狀態機 ----
  const unsubMode = store.subscribe((s, prev) => { if (s.mode !== prev.mode) ctl.setMode(s.mode, now()) })

  // ---- 量 FPS：rAF（刻意不放進 R3F useFrame，避免影響場景）----
  let rafId = 0, last = 0, stopped = false
  const loop = (ts) => {
    if (stopped) return
    rafId = raf(loop)
    if (last) ctl.feed(ts, ts - last)   // 暫停中狀態機自己只更新顯示用 FPS、不參與判斷
    last = ts
  }
  rafId = raf(loop)

  // ---- 每秒回報一次 FPS 給畫面 ----
  const ivPub = setIv(() => {
    const s = ctl.getState(now())
    store.getState().report({ fps: s.fps, paused: s.paused })
  }, REPORT_MS)

  return {
    controller: ctl,
    stop() {
      stopped = true
      caf(rafId)
      clrIv(ivPub); clrIv(ivPoll)
      if (dragTimer != null) { clrTo(dragTimer); dragTimer = null }
      doc.removeEventListener('visibilitychange', onVis)
      win.removeEventListener('midisea:xr', onXr)
      win.removeEventListener('pointerdown', onDown, true)
      win.removeEventListener('pointerup', onUp, true)
      win.removeEventListener('pointercancel', onUp, true)
      win.removeEventListener('blur', onBlur)
      unsubRec(); unsubMode()
    },
  }
}
