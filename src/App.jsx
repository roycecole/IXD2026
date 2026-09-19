import { useEffect, useRef, useState } from 'react'
import Scene3D from './scene/Scene3D.jsx'
import ParamPanel from './ui/ParamPanel.jsx'
import TopBar from './ui/TopBar.jsx'
import Monitor from './ui/Monitor.jsx'
import Splitter from './ui/Splitter.jsx'
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
    <div className="app" style={{ '--panel-w': panelW + 'px', '--monitor-h': monitorH + 'px', '--canvas-vh': canvasVh }}>
      <TopBar onConnect={connect} />
      <main className="stage">
        <div className="canvas-wrap"><Scene3D /></div>
        <Splitter axis="x" onDelta={(dx) => setPanelW((w) => clamp(w - dx, 260, 640))} />
        <div className="sheet-handle" onPointerDown={sheetDrag} title="拖曳調整面板高度"><span /></div>
        <ParamPanel />
      </main>
      <Splitter axis="y" onDelta={(dy) => setMonitorH((h) => clamp(h - dy, 60, 340))} />
      <Monitor />
    </div>
  )
}
