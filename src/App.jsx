import { useEffect, useRef } from 'react'
import Scene3D from './scene/Scene3D.jsx'
import ParamPanel from './ui/ParamPanel.jsx'
import TopBar from './ui/TopBar.jsx'
import Monitor from './ui/Monitor.jsx'
import { useMIDI } from './hooks/useMIDI.js'
import { useStore } from './store/useStore.js'

export default function App() {
  const { connect } = useMIDI()
  const raf = useRef(0)
  const last = useRef(performance.now())

  // 時間軸自動化迴圈：播放時推進時間，並把場景內插後的 keyed 參數寫回 store。
  // 未播放時完全交給手動 / MIDI，讓「手動覆寫」自然成立。
  useEffect(() => {
    const loop = (now) => {
      const dt = Math.min(0.05, (now - last.current) / 1000)
      last.current = now
      const st = useStore.getState()
      if (st.rec.mode === 'recording') st.advanceRec(dt)
      else if (st.rec.mode === 'playing') st.tickPlayback(dt)
      raf.current = requestAnimationFrame(loop)
    }
    raf.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf.current)
  }, [])

  return (
    <div className="app">
      <TopBar onConnect={connect} />
      <main className="stage">
        <div className="canvas-wrap"><Scene3D /></div>
        <ParamPanel />
      </main>
      <Monitor />
    </div>
  )
}
