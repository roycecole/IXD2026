// 常駐服務：GestureService（由 App 掛載一次）。
// 使用者在「裝置」面板打開相機手勢（useHandsStore.enabled）後才啟動：
//   相機（AR 開著就共用它）→ 動態載入 MediaPipe → 偵測迴圈 → gestures.js 狀態機 → 寫回 store：
//     張手（持續 ≥0.5 秒）＝平靜：洋流速度 / 游動速度 / 垃圾數量朝平靜值平滑靠近（input(pid, v)，≤15 次/秒）
//     捏合＝spawnWhale()（上升緣觸發，冷卻 3 秒）
//     揮手（只在資料導覽進行中、且「揮手換站」開著）：張開手掌快速橫掃，向左揮＝下一站、向右揮＝上一站（以使用者自己的左右為準）；
//       走 touchGuide()（不是 touch()：touch 會中止導覽）；這段期間暫停「張手平靜」（平靜的參數寫入是真實輸入，會中止導覽）。沒在導覽時完全不處理揮手。
// 關閉 / 離開時停掉偵測、放掉自己開的相機。畫布角落的徽章（受 overlays.hud 控制）與「相機使用中」指示
// （永遠顯示，不受 hud 影響——隱私）用 portal 掛到 .canvas-wrap。
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store/useStore.js'
import { touchGuide } from '../store/activity.js'
import { useT, t } from '../i18n/index.js'
import { createGestureTracker, createWaveDetector, routeWave } from '../lib/gestures.js'
import { createHandsRuntime, useHandsStore, stateLabel, waveLabel, errorKey } from '../lib/hands.js'
import { tourRunner } from './tourCore.js'
import '../styles/gestures.css'

const readParam = (pid) => useStore.getState().params[pid]
const patch = (p) => useHandsStore.setState(p)
const WAVE_SHOW_MS = 2000   // 「揮手：下一站」在徽章 / 狀態列停留多久

// 啟動一次手勢（相機 + 模型 + 偵測迴圈），回傳停止函式。日誌用「當下語系」的 t()。
function runGestures() {
  const tracker = createGestureTracker()
  const wave = createWaveDetector()
  let lastState = 'idle', lastCalm = false, waveWas = false, waveTimer = 0

  // 揮手 → 導覽換站（routeWave 內部 try/catch；導覽沒在進行會回 null，什麼都不做）
  const onWave = (dir) => {
    const r = routeWave(dir, { runner: tourRunner, touchGuide })
    if (!r) return
    useStore.getState().pushLog('out', t('揮手：{action}', { action: waveLabel(t, r.action) }))
    patch({ wave: r.action })
    clearTimeout(waveTimer)
    waveTimer = setTimeout(() => { waveTimer = 0; patch({ wave: null }) }, WAVE_SHOW_MS)
  }

  const rt = createHandsRuntime({
    onStatus: (p) => {
      patch(p)
      const st = useStore.getState()
      if (p.phase === 'error') {                                     // 失敗：關掉開關，原因留給 Section 顯示
        patch({ enabled: false, state: 'idle', calm: false })
        st.pushLog('out', t('相機手勢失敗：{err}', { err: t(errorKey(p.error && p.error.code)) }))
      } else if (p.phase === 'running') st.pushLog('out', t('相機手勢已啟動（{delegate}）', { delegate: p.delegate || 'CPU' }))
    },
    onFrame: (lm, now, info) => {
      if (info && info.reset) { tracker.reset(); wave.reset(); waveWas = false; lastState = 'idle'; lastCalm = false; patch({ state: 'idle', calm: false }) }
      const st = useStore.getState()
      const waveOn = useHandsStore.getState().waveNav !== false && tourRunner.isRunning()   // 揮手只在導覽進行中處理
      const out = tracker.update(lm, now, { readParam, aspect: info && info.aspect, suppressCalm: waveOn })
      for (const w of out.writes) st.input(w.pid, w.v)
      if (out.events.includes('pinch')) {
        st.pushLog('in', t('手勢：捏合 → 召喚鯨魚'))
        st.spawnWhale()
      }
      if (out.calm && !lastCalm) st.pushLog('in', t('手勢：張手 → 海面平靜'))
      if (out.state !== lastState || out.calm !== lastCalm) {       // 只在變化時更新（不要每幀重繪）
        lastState = out.state; lastCalm = out.calm
        patch({ state: out.state, calm: out.calm })
      }
      if (waveOn) {
        waveWas = true
        const w = wave.update(lm, now, { aspect: info && info.aspect })   // 前鏡頭 / 面對鏡頭的人：預設 mirror（見 gestures.js 的說明）
        if (w.event) onWave(w.event)
      } else if (waveWas) { waveWas = false; wave.reset() }             // 導覽結束 / 開關關掉：清軌跡（冷卻仍保留）
    },
  })
  rt.start()
  return () => {
    rt.stop()
    clearTimeout(waveTimer); waveTimer = 0
    if (useHandsStore.getState().phase !== 'error') patch({ state: 'idle', calm: false, camera: null, delegate: null, wave: null })   // 錯誤狀態要留給 Section 顯示
    else patch({ wave: null })
  }
}

export default function GestureService() {
  const t = useT()   // 元件內的 t 訂閱語系（會遮住模組層的 t；模組層的 t 給 runGestures 的日誌用「當下」語系）
  const enabled = useHandsStore((s) => s.enabled)
  const camera = useHandsStore((s) => s.camera)
  const phase = useHandsStore((s) => s.phase)
  const state = useHandsStore((s) => s.state)
  const calm = useHandsStore((s) => s.calm)
  const wave = useHandsStore((s) => s.wave)
  const hud = useStore((s) => s.overlays.hud)
  const [host, setHost] = useState(null)

  // 徽章掛載點：畫布容器（App 一直都有渲染它；找不到就掛 body，指示燈不能不見）
  useEffect(() => {
    setHost(enabled ? document.querySelector('.canvas-wrap') || document.body : null)
  }, [enabled])

  // 啟動 / 停止（React StrictMode 會重跑一次 effect：stop() 可重複呼叫，晚到的相機 / 模型會被放掉）
  useEffect(() => (enabled ? runGestures() : undefined), [enabled])

  if (!host) return null
  const showBadge = hud && (phase === 'running' || phase === 'loading')
  return createPortal(
    <div className={'gesture-overlay' + (host === document.body ? ' fixed' : '')}>
      {camera != null && (
        <div className="gesture-cam" role="status">
          <i className="gesture-cam-dot" aria-hidden="true" />
          {t('相機使用中')}
        </div>
      )}
      {showBadge && (
        <div className={'gesture-badge' + (phase === 'running' && calm ? ' calm' : '')} aria-live="polite">
          {phase === 'running'
            ? (wave ? t('手勢 · 揮手：{action}', { action: waveLabel(t, wave) }) : t('手勢 · 偵測到：{state}', { state: stateLabel(t, state) }))
            : t('手勢 · 載入模型中…')}
        </div>
      )}
    </div>,
    host,
  )
}
