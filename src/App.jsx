import { useEffect, useRef, useState } from 'react'
import Scene3D from './scene/Scene3D.jsx'
import ParamPanel from './ui/ParamPanel.jsx'
import TopBar from './ui/TopBar.jsx'
import Monitor from './ui/Monitor.jsx'
import Splitter from './ui/Splitter.jsx'
import Footer from './ui/Footer.jsx'
import InfoModal from './ui/InfoModal.jsx'
import VirtualController from './ui/VirtualController.jsx'
import { useMIDI } from './hooks/useMIDI.js'
import { useStore } from './store/useStore.js'
import { decodeParams } from './lib/share.js'
import { LS, loadLS, saveLS } from './lib/persist.js'
import { audioUpdate } from './audio/engine.js'

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

export default function App() {
  const { connect } = useMIDI()
  const raf = useRef(0)
  const last = useRef(performance.now())

  const savedSizes = loadLS(LS.sizes, { panelW: 340, monitorH: 84, canvasVh: 46 })
  const [panelW, setPanelW] = useState(savedSizes.panelW || 340)
  const [monitorH, setMonitorH] = useState(savedSizes.monitorH || 84)
  const [canvasVh, setCanvasVh] = useState(savedSizes.canvasVh || 46) // 手機：畫布高度(vh)，面板可拉高
  const [stage, setStage] = useState(false) // 演出模式：隱藏全部 UI，只留球體
  const [showVK, setShowVK] = useState(false) // 虛擬控制器
  const [showInfo, setShowInfo] = useState(() => { try { return !localStorage.getItem('ixd2026.seen') } catch (e) { return true } })
  const closeInfo = () => { setShowInfo(false); try { localStorage.setItem('ixd2026.seen', '1') } catch (e) {} }

  // 全域鍵盤：H 演出模式、空白鍵播放、R 錄製、1-4 召喚生物、? 說明（輸入/按鈕聚焦時放行原生行為）
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target.tagName || ''
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return
      const k = e.key
      if (k === 'h' || k === 'H') { setStage((s) => !s); return }
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

  // 分享網址帶參數：載入時若有 ?s= 則套用
  useEffect(() => {
    try {
      const s = new URLSearchParams(location.search).get('s')
      if (s) { const p = decodeParams(s); if (p) useStore.getState().applyParams(p) }
    } catch (e) {}
  }, [])

  // 保存視窗尺寸
  useEffect(() => { saveLS(LS.sizes, { panelW, monitorH, canvasVh }) }, [panelW, monitorH, canvasVh])

  // 主迴圈：推進錄製/播放 + 定期把參數 / log 寫進 storage
  useEffect(() => {
    let n = 0
    const loop = (now) => {
      const dt = Math.min(0.05, (now - last.current) / 1000)
      last.current = now
      const st = useStore.getState()
      if (st.rec.mode === 'recording') st.advanceRec(dt)
      else if (st.rec.mode === 'playing') st.tickPlayback(dt)
      n++
      if (n % 6 === 0) audioUpdate()   // 背景音引擎（未開啟時為 no-op）
      if (n % 90 === 0) st.persistParams()
      if (n % 600 === 0) st.persistLog()
      raf.current = requestAnimationFrame(loop)
    }
    raf.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf.current)
  }, [])

  return (
    <div className={'app' + (stage ? ' stagemode' : '')} style={{ '--panel-w': panelW + 'px', '--monitor-h': monitorH + 'px', '--canvas-vh': canvasVh }}>
      {stage && <button className="stage-exit" onClick={() => setStage(false)} title="離開演出模式（或按 H）">✕</button>}
      <TopBar onConnect={connect} onInfo={() => setShowInfo(true)} onVK={() => setShowVK((v) => !v)} vkOn={showVK} />
      <main className="stage">
        <div className="canvas-wrap" onDoubleClick={() => setStage((s) => !s)} title="雙擊進入/離開演出模式（或按 H）"><Scene3D /></div>
        <Splitter axis="x" onDelta={(dx) => setPanelW((w) => clamp(w - dx, 260, 640))} />
        <div className="sheet-handle" onPointerDown={sheetDrag} title="拖曳調整面板高度"><span /></div>
        <ParamPanel />
      </main>
      <Splitter axis="y" onDelta={(dy) => setMonitorH((h) => clamp(h - dy, 60, 340))} />
      <Monitor />
      <Footer onInfo={() => setShowInfo(true)} />
      {showVK && <VirtualController onClose={() => setShowVK(false)} />}
      {showInfo && <InfoModal onClose={closeInfo} />}
    </div>
  )
}
