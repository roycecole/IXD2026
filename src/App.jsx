import { flagOn } from './lib/urlFlags.js'
import { useEffect, useRef, useState, Suspense, lazy } from 'react'
import ParamPanel from './ui/ParamPanel.jsx'
import TopBar from './ui/TopBar.jsx'
import Monitor, { toggleMonitorVisible } from './ui/Monitor.jsx'
import Splitter from './ui/Splitter.jsx'
import Footer from './ui/Footer.jsx'
import { useLayoutPrefs } from './lib/layoutPrefs.js'   // 輸入輸出監看（系統事件）顯示 / 隱藏偏好
import InfoModal from './ui/InfoModal.jsx'
import MultiModal from './ui/MultiModal.jsx'
import VirtualController from './ui/VirtualController.jsx'
import ParamHUD from './ui/ParamHUD.jsx'
import TakeoverHint from './ui/TakeoverHint.jsx'
import DataHUD from './ui/DataHUD.jsx'
import KioskQR from './ui/KioskQR.jsx'
import DataBoard from './ui/DataBoard.jsx'
import InspectCard from './ui/InspectCard.jsx'
import DevicesModal from './ui/DevicesModal.jsx'
import Onboarding from './ui/Onboarding.jsx'
import { isFirstVisit } from './lib/onboarding.js'
import Services from './services/Services.jsx'
import TourCaption from './ui/TourCaption.jsx'
import { tourIdleTick, toggleTour } from './services/TourService.jsx'
import { arState, arStart, arStop, arFilter, createLumaSampler, glowForLuma } from './lib/ar.js'
import { stats } from './store/stats.js'
import { multiState } from './lib/multiplayer.js'
import { useMIDI } from './hooks/useMIDI.js'
import { useStore, seriesMeta } from './store/useStore.js'
import { parseShareContext, hasShareContext, applyShareContext } from './lib/share.js'
import { setLocale, getLocale } from './i18n/index.js'   // 分享連結的 ?lang=（一次性覆蓋；i18n 啟動時本來就會讀 ?lang=，這裡只是保險）
import { loadOceanData } from './lib/govdata.js'
import { LS, loadLS, saveLS } from './lib/persist.js'
import { audioUpdate, audioToggle } from './audio/engine.js'
import { formatHud } from './lib/series.js'
import { describeForLog } from './lib/describe.js'
import { activity, touch } from './store/activity.js'
import { keepAwake } from './lib/wakeLock.js'
import { isInModal } from './lib/modalFocus.js'
import { SCENES } from './timeline/scenes.js'
import { t, useLocale } from './i18n/index.js'   // 頂層元件用 useLocale() 訂閱語系 + 模組層 t()（事件 / effect 閉包內取「呼叫當下」的語系）

const Scene3D = lazy(() => import('./scene/Scene3D.jsx')) // code-split：three 分塊延後載入，shell 先 paint

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// Gamepad 搖桿 → 海（左桿=洋流方向、右桿=自轉/海水高度、A/B/X/Y=召喚、Start=播放）
const gpPrev = []
function pollGamepad(st) {
  let pad = null
  try { const pads = navigator.getGamepads ? navigator.getGamepads() : []; for (const p of pads) if (p && p.connected) { pad = p; break } } catch (e) {}
  if (!pad) return
  const dz = (v) => (Math.abs(v) > 0.18 ? v : 0)
  const ax0 = dz(pad.axes[0] || 0), ax1 = dz(pad.axes[1] || 0)
  const ax2 = dz(pad.axes[2] || 0), ax3 = dz(pad.axes[3] || 0)
  // 搖桿有動：先 touch()（資料導覽在這裡同步中止並還原），再重讀 store——下面「目前值 + 增量」的基準才是還原後的值，不是導覽的
  if (ax0 || ax1 || ax2 || ax3) { touch(); st = useStore.getState() }
  if (ax0) st.input('flowX', 0.5 + ax0 * 0.5)
  if (ax1) st.input('flowY', 0.5 - ax1 * 0.5)
  if (ax2) st.input('spin', (st.params.spin ?? 0.3) + ax2 * 0.012)
  if (ax3) st.input('seaLevel', (st.params.seaLevel ?? 0.5) - ax3 * 0.008)
  for (const [i, a] of [[0, 'spawnDolphin'], [1, 'spawnWhale'], [2, 'spawnTurtle'], [3, 'clearTrash'], [9, 'transportPlay'], [8, 'transportRecord']]) {
    const pr = !!(pad.buttons[i] && pad.buttons[i].pressed)
    if (pr && !gpPrev[i]) { touch(); const fn = useStore.getState()[a]; if (fn) fn() }   // 走帶鍵不經 input()，要自己 touch()（先中止導覽再執行）
    gpPrev[i] = pr
  }
}

// 展場統計（kiosk / 演出模式角落）：掃碼加入人數 + 演出次數
function StageStats() {
  useLocale()
  const [, force] = useState(0)
  useEffect(() => { const iv = setInterval(() => force((x) => x + 1), 2000); return () => clearInterval(iv) }, [])
  return <div className="stage-stats">{t('合奏 {joins} 人 · 演出 {plays} 次', { joins: stats.joins, plays: stats.plays + stats.recs })}</div>
}

const KIOSK = flagOn(typeof location !== 'undefined' ? location.search : '', 'kiosk')   // ?kiosk / ?kiosk=1 開；?kiosk=0 關

export default function App() {
  useLocale()   // 語系切換 → 重繪（本檔的文字用模組層 t()）
  const { connect, connectBle } = useMIDI()
  const raf = useRef(0)
  const last = useRef(performance.now())

  const savedSizes = loadLS(LS.sizes, { panelW: 340, monitorH: 84, canvasVh: 46 })
  const [panelW, setPanelW] = useState(savedSizes.panelW || 340)
  const [monitorH, setMonitorH] = useState(savedSizes.monitorH || 84)
  const monitorShown = useLayoutPrefs((s) => s.monitorShown)   // 隱藏時 Monitor 與其水平 Splitter 都不渲染，空間還給畫布 / 面板（日誌照常累積）
  // 手機：畫布高度(vh)，面板可拉高。手機預設縮到 40%（舊預設值 46 視為「沒調整過」），把空間讓給控制面板
  const [canvasVh, setCanvasVh] = useState(() => { const v = savedSizes.canvasVh; const narrow = typeof window !== 'undefined' && window.innerWidth <= 820; return narrow && (!v || v === 46) ? 40 : v || 46 })
  const [stage, setStage] = useState(KIOSK) // 演出模式：隱藏全部 UI，只留球體；?kiosk=1 直接進場
  const [showVK, setShowVK] = useState(false) // 虛擬控制器
  // 首次進站不再自動彈出長篇說明：改由 <Onboarding/>（一步一步的新手導覽，見 lib/onboarding.js）帶；長篇說明留在「說明」鈕後面。
  const [showInfo, setShowInfo] = useState(false)
  const closeInfo = () => { setShowInfo(false); try { localStorage.setItem(LS.seen, '1') } catch (e) {} }   // 看過說明也算「來過了」（與過去相同）
  // 「這次進站是不是首次到訪」：第一次 render 就記下來（載入 ocean.json 時用它決定要不要「以今天真實的海開場」）。
  // 不能等 ocean.json 載入完才去讀 seen——導覽完成 / 略過 / 關閉說明都會寫 seen，若使用者在資料載入前就按了，開場的海就會被當成回訪而改變。
  const [firstVisit] = useState(() => isFirstVisit())
  const [showMulti, setShowMulti] = useState(false)     // 多人合奏 QR
  const [showDevices, setShowDevices] = useState(false)   // 「裝置」面板（觀眾視窗 / 手勢 / 語音 / 觸覺 / 畫質 / AR 桌面）
  const [installEvt, setInstallEvt] = useState(null)    // PWA 加入主畫面
  const [updReady, setUpdReady] = useState(false)       // 部署新版 → 提示重新整理

  // PWA：安裝提示（beforeinstallprompt）+ 更新 toast（新 SW 接管且非首次 → 有新版）
  useEffect(() => {
    const onBip = (e) => { e.preventDefault(); setInstallEvt(e) }
    window.addEventListener('beforeinstallprompt', onBip)
    const onInstalled = () => setInstallEvt(null)
    window.addEventListener('appinstalled', onInstalled)
    const sw = navigator.serviceWorker
    const hadController = !!(sw && sw.controller)
    const onCtrl = () => { if (hadController) setUpdReady(true) }
    sw && sw.addEventListener && sw.addEventListener('controllerchange', onCtrl)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBip)
      window.removeEventListener('appinstalled', onInstalled)
      sw && sw.removeEventListener && sw.removeEventListener('controllerchange', onCtrl)
    }
  }, [])
  const doInstall = async () => {
    const e = installEvt; if (!e) return
    setInstallEvt(null)
    try { await e.prompt() } catch (err) {}
  }

  // AR 實景背景：相機鋪在畫布後。模糊 / 清澈與一般畫面共用同一組參數（背景模糊 / 背景清澈，只影響背景，球體不變）。
  const videoRef = useRef(null)
  const [arOn, setArOn] = useState(false)
  const arPrev = useRef(null)
  const bgBlur = useStore((s) => s.params.bgBlur)
  const bgClarity = useStore((s) => s.params.bgClarity)
  const arBusy = useRef(false)   // 相機授權 / 開機要 0.5–2 秒：期間再點一次要忽略（lib/ar.js 也擋了第二條串流，這裡避免「開啟」的後續動作與日誌跑兩次）
  const toggleAR = async () => {
    if (arBusy.current) return
    arBusy.current = true
    try { await toggleARInner() } finally { arBusy.current = false }
  }
  const toggleARInner = async () => {
    const st = useStore.getState()
    if (arOn) {
      arStop(videoRef.current); setArOn(false); st.pushLog('out', t('AR 實景關閉'))
      if (arPrev.current) { st.applyParams(arPrev.current); arPrev.current = null }   // 還原一般畫面的背景設定
    } else {
      const ok = await arStart(videoRef.current, () => { setArOn(false); if (arPrev.current) { useStore.getState().applyParams(arPrev.current); arPrev.current = null } })
      setArOn(ok)
      if (ok) {
        // 實景預設：背景稍微模糊、略暗，球體才浮得出來（離開 AR 時還原原本的設定）
        arPrev.current = { bgBlur: st.params.bgBlur, bgClarity: st.params.bgClarity }
        if ((st.params.bgBlur ?? 0) < 0.05) st.applyParams({ bgBlur: 0.27 })
        if ((st.params.bgClarity ?? 1) > 0.9) st.applyParams({ bgClarity: 0.85 })
        st.pushLog('out', t('AR 實景開啟（背景=相機）'))
      } else st.pushLog('out', t('AR 相機開啟失敗：{err}', { err: arState.err || t('不支援') }))
    }
  }
  // 參數變動 → 同步到相機畫面的 CSS filter（AR 開啟時）
  useEffect(() => { if (arOn && videoRef.current) videoRef.current.style.filter = arFilter(bgBlur, bgClarity) }, [arOn, bgBlur, bgClarity])

  // 環境光感知：AR 開啟時每 0.6 秒取相機平均亮度 → 自動調球體輝光（環境亮 → 輝光強、暗 → 收斂）。
  // 用 setParam（不進錄製、不閃 HUD）；使用者剛手動調過輝光（旋鈕 / 滑桿 / 遙控）→ 暫停自動 8 秒。
  useEffect(() => {
    if (!arOn) return
    const sample = createLumaSampler()
    let smooth = null
    const iv = setInterval(() => {
      if (!arState.autoGlow) { smooth = null; return }
      const L = sample(videoRef.current)
      if (L == null) return
      arState.luma = L
      if (performance.now() - activity.glowAt < 8000) return // 使用者剛手動調過輝光 → 暫停自動
      const st = useStore.getState()
      const target = glowForLuma(L, st.params.bgClarity ?? 1)
      smooth = smooth == null ? target : smooth + (target - smooth) * 0.35
      if (Math.abs((st.params.glow ?? 0) - smooth) > 0.01) st.setParam('glow', smooth)
    }, 600)
    return () => clearInterval(iv)
  }, [arOn])

  // 預設聲音開啟：瀏覽器規定音訊必須在使用者手勢後才能啟動，所以「預設開啟」＝第一次點 / 觸碰 / 按鍵時自動啟動；
  // 使用者按「聲音」靜音後會記住（下次不再自動開）。第一下若剛好點在「聲音」鈕上，交給按鈕自己處理，避免先開又關。
  const audioOn = useStore((s) => s.audioOn)
  const overlays = useStore((s) => s.overlays)
  useEffect(() => {
    if (loadLS(LS.audio, null) === 'off') return
    const evs = ['pointerup', 'touchend', 'keydown', 'click']
    let done = false
    const cleanup = () => evs.forEach((ev) => window.removeEventListener(ev, start, true))
    async function start(e) {
      if (done) return
      if (e && e.target && e.target.closest && e.target.closest('[data-audio-btn]')) return
      done = true; cleanup()
      try {
        const on = await audioToggle()
        useStore.getState().setAudioOn(on)
        if (on) useStore.getState().pushLog('out', t('聲音自動開啟（第一次互動）· 可按「聲音」靜音'))
        else { done = false; evs.forEach((ev) => window.addEventListener(ev, start, true)) } // 沒成功（例如手勢不算數）→ 下次再試
      } catch (err) { done = false; evs.forEach((ev) => window.addEventListener(ev, start, true)) }
    }
    evs.forEach((ev) => window.addEventListener(ev, start, true))
    return cleanup
  }, [])

  // 全域鍵盤：H 演出模式、空白鍵播放、R 錄製、1-4 召喚生物、? 說明（輸入/按鈕聚焦時放行原生行為）
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target.tagName || ''
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return
      if (isInModal(e.target)) return   // 「裝置」彈窗開著（焦點在彈窗內）：T / H / I / 空白鍵等不該在背後動作（例如在彈窗後面開始導覽）
      const k = e.key
      if (k === 'h' || k === 'H') { setStage((s) => !s); return }
      if (k === 'i' || k === 'I') { useStore.getState().toggleOverlays(); return }
      if ((k === 't' || k === 'T') && !e.ctrlKey && !e.metaKey && !e.altKey) { toggleTour(); return }   // T：開始 / 停止資料導覽
      if ((k === 'l' || k === 'L') && !e.ctrlKey && !e.metaKey && !e.altKey) { toggleMonitorVisible(); return }   // L：顯示 / 隱藏輸入輸出監看（系統事件）
      if (k === '?') { setShowInfo(true); return }
      if (tag === 'BUTTON') return // 按鈕聚焦時交給原生（Enter/Space 觸發該鈕）
      const st = useStore.getState()
      if (k === ' ') { st.transportPlay(); e.preventDefault() }
      else if (k === 'r' || k === 'R') st.transportRecord()
      else if (k === '1') st.spawnWhale()
      else if (k === '2') st.spawnDolphin()
      else if (k === '3') st.spawnTurtle()
      else if (k === '4') st.clearTrash()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 手機 bottom-sheet 把手：往上拖 → 面板拉高（畫布縮小）
  const sheetDrag = (e) => {
    e.preventDefault()
    let lastY = e.clientY
    const mv = (ev) => {
      const dy = ev.clientY - lastY; lastY = ev.clientY
      setCanvasVh((h) => clamp(h + (dy / window.innerHeight) * 100, 26, 78))
    }
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', mv)
    window.addEventListener('pointerup', up)
  }

  // 分享網址帶參數：載入時若有 ?s=（視覺參數）先套用，第一幀就是分享的畫面。
  // 資料脈絡（?o= 海況選項 / ?m= 月份 / ?sl= 鳥魚連動 / ?lang=）要等海況資料載入才能套用，見下一段 effect。
  useEffect(() => {
    try {
      const ctx = parseShareContext(location.search)
      if (ctx.params) useStore.getState().applyParams(ctx.params)
    } catch (e) {}
  }, [])

  // 真實海況：載入 ocean.json；首次到訪（無分享參數）以「今天真實的海」開場
  useEffect(() => {
    loadOceanData().then((d) => {
      if (!d) return
      const st = useStore.getState()
      st.setGov(d)
      // firstVisit：見上方 useState(() => isFirstVisit())（進站當下的判斷，不受載入期間才寫入的 seen 影響）
      const share = (() => { try { return parseShareContext(location.search, { optionIds: new Set((d.options || []).map((o) => o.id)) }) } catch (e) { return null } })()
      const hasShare = hasShareContext(share)
      if (hasShare) {
        // 分享連結：先選海況選項與月份 → 暫時套用鳥魚連動（不寫 localStorage）→ 最後才套分享的視覺參數（海況參數不能蓋掉分享的畫面）；不用今天的海開場
        const r = applyShareContext(useStore, share, { setLocale, getLocale })
        if (r.option || r.month || r.link) st.pushLog('out', t('開啟分享連結：套用海況與資料設定'))
      } else if (firstVisit) st.applyGov()
      else st.applySurveyLinked()   // 回訪：連動中的鳥 / 魚數量用最新資料（已脫鉤 = 獨立控制的保持不動）
      const o = st.govOption()
      if (o) describeForLog(d, o).forEach((l) => st.pushLog('out', l))   // 輸出顯示資料：目前海況背後的資料列
    })
  }, [])

  // 保存視窗尺寸
  useEffect(() => { saveLS(LS.sizes, { panelW, monitorH, canvasVh }) }, [panelW, monitorH, canvasVh])

  // 主迴圈：推進錄製/播放 + 定期把參數 / log 寫進 storage + 閒置吸引模式
  const attract = useRef({ on: false, at: 0, idx: 0 })
  const stepLog = useRef({ idx: -1, name: '' })
  useEffect(() => {
    let n = 0
    const IDLE = 30000, STEP = 11000
    const loop = (now) => {
      raf.current = requestAnimationFrame(loop) // 先排下一幀：中間任何一段丟錯，主迴圈（錄製 / 播放 / 導覽 / 存檔）也不會就此停擺
      const dt = Math.min(0.05, (now - last.current) / 1000)
      last.current = now
      const st = useStore.getState()
      if (st.rec.mode === 'recording') st.advanceRec(dt)
      else if (st.rec.mode === 'playing') st.tickPlayback(dt)
      // Attract Mode：閒置 30s → 資料導覽（依序巡演水庫 / 潮汐 / 月亮 / 揚塵 / 鳥 / 魚 / 測站，畫面下方字幕說明；任何輸入立即退場並還原，見 services/TourService.jsx）。
      // 沒有海況資料可導覽時才退回舊的「每 11s 輪播一組色相場景」。
      const a = attract.current
      if (now - activity.last > IDLE && st.rec.mode === 'idle') {
        if (tourIdleTick(now) === 'nodata') {
          if (!a.on) { a.on = true; a.at = now - STEP; a.idx = 0 }
          if (now - a.at > STEP) { a.at = now; st.applyScene(SCENES[a.idx % SCENES.length].params); a.idx++ }
        } else if (a.on) a.on = false
      } else if (a.on) a.on = false
      // 資料播放：每換一步就把「現在這筆資料」寫進 OUT 監看（輸出顯示資料）
      if (seriesMeta.active && st.rec.mode === 'playing' && seriesMeta.points.length) {
        const idx = Math.max(0, Math.min(seriesMeta.points.length - 1, Math.floor(st.rec.playhead / seriesMeta.step)))
        if (idx !== stepLog.current.idx || seriesMeta.name !== stepLog.current.name) {
          stepLog.current = { idx, name: seriesMeta.name }
          st.pushLog('out', 'DATA ' + formatHud(seriesMeta, seriesMeta.points[idx]))
        }
      } else if (stepLog.current.idx !== -1) stepLog.current = { idx: -1, name: '' }
      n++
      if (n % 2 === 0) pollGamepad(st) // Gamepad 搖桿 / 按鈕（未接手把時為 no-op）
      if (n % 6 === 0) audioUpdate()   // 背景音引擎（未開啟時為 no-op）
      if (n % 90 === 0) st.persistParams()
      if (n % 600 === 0) st.persistLog()
    }
    raf.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf.current)
  }, [])

  const onWheel = (e) => { const st = useStore.getState(); st.input('zoom', (st.params.zoom ?? 0.5) - e.deltaY * 0.0008) }

  // Kiosk 沉浸：演出模式 → 全螢幕 + 螢幕不休眠（wakeLock）+ 藏游標
  useEffect(() => {
    if (stage) {
      try { document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {}) } catch (e) {}
      return keepAwake()   // lib/wakeLock.js：請求完成前就 cleanup（StrictMode 雙跑）也不會洩漏 lock；回前景會重新申請
    } else {
      try { if (document.fullscreenElement) document.exitFullscreen && document.exitFullscreen().catch(() => {}) } catch (e) {}
    }
  }, [stage])

  return (
    <div className={'app' + (stage ? ' stagemode' : '')} style={{ '--panel-w': panelW + 'px', '--monitor-h': monitorH + 'px', '--canvas-vh': canvasVh }}>
      {stage && <button className="stage-exit" onClick={() => setStage(false)} title={t('離開演出模式（或按 H）')}>✕</button>}
      <TopBar onConnect={connect} onBle={connectBle} onInfo={() => setShowInfo(true)} onVK={() => setShowVK((v) => !v)} vkOn={showVK}
              onMulti={() => setShowMulti((v) => !v)} multiOn={showMulti} onAR={toggleAR} arOn={arOn}
              onDevices={() => setShowDevices((v) => !v)} devicesOn={showDevices} />
      <main className="stage">
        <div className={'canvas-wrap' + (arOn ? ' ar-on' : '')} onDoubleClick={() => setStage((s) => !s)} onWheel={onWheel} title={t('雙擊演出模式 · 滾輪縮放')}>
          <video ref={videoRef} className="ar-video" playsInline muted aria-hidden="true" />
          <Suspense fallback={<div className="canvas-loading">{t('載入海洋…')}</div>}><Scene3D /></Suspense>
          {overlays.hud && <ParamHUD />}
          {overlays.hud && <TakeoverHint />}
          {overlays.hud && <DataHUD />}
          <TourCaption />{/* 資料導覽字幕：內部依 overlays.hud 顯示 / 隱藏（hud 關閉時導覽照跑、不顯示字幕） */}
          <DataBoard />
          <InspectCard />{/* 點測站星 / 月亮 / 鳥群看資料出處：內部依 overlays.hud 顯示 / 隱藏 */}
          {overlays.hud && !audioOn && !stage && loadLS(LS.audio, null) !== 'off' && <div className="audio-hint">{t('點一下畫面即開啟聲音')}</div>}
          {arOn && overlays.hud && (
            <div className="ar-ctrl" aria-label={t('AR 背景調整')}>
              <label>{t('模糊')}<input type="range" min="0" max="1" step="0.01" value={bgBlur ?? 0}
                     onChange={(e) => useStore.getState().input('bgBlur', parseFloat(e.target.value))} /></label>
              <label>{t('清澈')}<input type="range" min="0" max="1" step="0.01" value={bgClarity ?? 1}
                     onChange={(e) => useStore.getState().input('bgClarity', parseFloat(e.target.value))} /></label>
              <label className="ar-auto" title={t('依相機畫面平均亮度自動調球體輝光（環境光感知）')}>
                <input type="checkbox" defaultChecked={arState.autoGlow} onChange={(e) => { arState.autoGlow = e.target.checked }} />{t('環境光自動調輝光')}
              </label>
            </div>
          )}
          {stage && overlays.qr && (KIOSK || multiState.on) && <KioskQR />}
          {stage && overlays.qr && <StageStats />}
        </div>
        <Splitter axis="x" onDelta={(dx) => setPanelW((w) => clamp(w - dx, 260, 640))} />
        <div className="sheet-handle" onPointerDown={sheetDrag} title={t('拖曳調整面板高度')}><span /></div>
        <ParamPanel onVK={() => setShowVK(true)} />
      </main>
      {monitorShown && <Splitter axis="y" onDelta={(dy) => setMonitorH((h) => clamp(h - dy, 60, 340))} />}
      {monitorShown && <Monitor />}
      <Footer onInfo={() => setShowInfo(true)} installEvt={installEvt} onInstall={doInstall} />
      {showVK && <VirtualController onClose={() => setShowVK(false)} />}
      {showInfo && <InfoModal onClose={closeInfo} />}
      {showMulti && <MultiModal onClose={() => setShowMulti(false)} />}
      {showDevices && <DevicesModal onClose={() => setShowDevices(false)} />}
      <Onboarding />
      <Services />
      {updReady && (
        <button className="upd-toast" onClick={() => location.reload()} title={t('部署了新版本')}>
          {t('有新版本 · 點此更新')}
        </button>
      )}
    </div>
  )
}
