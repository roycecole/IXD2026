import { useStore } from '../store/useStore.js'
import { SCENES } from '../timeline/scenes.js'

function fmt(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function TopBar({ onConnect }) {
  const rec = useStore((s) => s.rec)
  const midi = useStore((s) => s.midi)
  const startRecording = useStore((s) => s.startRecording)
  const stopRecording = useStore((s) => s.stopRecording)
  const startPlayback = useStore((s) => s.startPlayback)
  const stopPlayback = useStore((s) => s.stopPlayback)
  const clearRec = useStore((s) => s.clearRec)
  const applyScene = useStore((s) => s.applyScene)

  const recording = rec.mode === 'recording'
  const playing = rec.mode === 'playing'
  const hasRec = rec.count > 0

  return (
    <header className="topbar">
      <span className="title">資料導演台 <span className="dim">IXD2026</span></span>

      <div className="transport">
        <button className={'rec' + (recording ? ' on' : '')}
                onClick={() => (recording ? stopRecording() : startRecording())}>
          {recording ? '■ 停止錄製' : '● 錄製'}
        </button>
        <button onClick={() => (playing ? stopPlayback() : startPlayback())}
                disabled={recording || !hasRec}>
          {playing ? '❚❚ 停止' : '▶ 播放'}
        </button>
        <button onClick={clearRec} disabled={recording || !hasRec}>⟲ 清除</button>
        <span className="time">{fmt(rec.playhead)} / {fmt(rec.duration)}</span>
      </div>

      <div className="scenes">
        <span className="dim" style={{ fontSize: 11, alignSelf: 'center' }}>場景</span>
        {SCENES.map((sc, i) => (
          <button key={i} className="scene" title={sc.label} onClick={() => applyScene(sc.params)}>{i}</button>
        ))}
      </div>

      <button className={'conn' + (midi.connected ? ' on' : '')} onClick={onConnect}>
        {midi.connected ? '● MIDI 已連線' : '連線 MIDI'}
      </button>
    </header>
  )
}
