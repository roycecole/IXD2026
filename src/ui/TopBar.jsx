import { useStore } from '../store/useStore.js'
import { SCENES, currentSceneIndex } from '../timeline/scenes.js'

function fmt(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function TopBar({ onConnect }) {
  const timeline = useStore((s) => s.timeline)
  const play = useStore((s) => s.play)
  const pause = useStore((s) => s.pause)
  const reset = useStore((s) => s.reset)
  const setTime = useStore((s) => s.setTime)
  const midi = useStore((s) => s.midi)
  const cur = currentSceneIndex(timeline.time)

  return (
    <header className="topbar">
      <span className="title">資料導演台 <span className="dim">IXD2026</span></span>

      <div className="transport">
        <button onClick={() => (timeline.playing ? pause() : play())}>
          {timeline.playing ? '❚❚ 暫停' : '▶ 播放'}
        </button>
        <button onClick={reset}>↺ 歸零</button>
        <span className="time">{fmt(timeline.time)} / {fmt(timeline.duration)}</span>
      </div>

      <div className="scenes">
        {SCENES.map((sc, i) => (
          <button key={i} className={'scene' + (i === cur ? ' active' : '')}
                  title={sc.label} onClick={() => setTime(sc.t)}>{i}</button>
        ))}
      </div>

      <button className={'conn' + (midi.connected ? ' on' : '')} onClick={onConnect}>
        {midi.connected ? '● MIDI 已連線' : '連線 MIDI'}
      </button>
    </header>
  )
}
