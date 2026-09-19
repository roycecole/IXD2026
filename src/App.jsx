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

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

export default function App() {
  const { connect } = useMIDI()
  const raf = useRef(0)
  const last = useRef(performance.now())

  const savedSizes = loadLS(LS.sizes, { panelW: 340, monitorH: 84 })
  const [panelW, setPanelW] = useState(savedSizes.panelW || 340)
  const [monitorH, setMonitorH] = useState(savedSizes.monitorH || 84)

  // 分享網址帶參數：載入時若有 ?s= 則套用
  useEffect(() => {
    try {
      const s = new URLSearchParams(location.search).get('s')
      if (s) { const p = decodeParams(s); if (p) useStore.getState().applyParams(p) }
    } catch (e) {}
  }, [])

  // 保存視窗尺寸
  useEffect(() => { saveLS(LS.sizes, { panelW, monitorH }) }, [panelW, monitorH])

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
      if (n % 90 === 0) st.persistParams()
      if (n % 600 === 0) st.persistLog()
      raf.current = requestAnimationFrame(loop)
    }
    raf.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf.current)
  }, [])

  return (
    <div className="app" style={{ '--panel-w': panelW + 'px', '--monitor-h': monitorH + 'px' }}>
      <TopBar onConnect={connect} />
      <main className="stage">
        <div className="canvas-wrap"><Scene3D /></div>
        <Splitter axis="x" onDelta={(dx) => setPanelW((w) => clamp(w - dx, 260, 640))} />
        <ParamPanel />
      </main>
      <Splitter axis="y" onDelta={(dy) => setMonitorH((h) => clamp(h - dy, 60, 340))} />
      <Monitor />
    </div>
  )
}
