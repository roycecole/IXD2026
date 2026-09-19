import { useStore } from '../store/useStore.js'

export default function Monitor() {
  const log = useStore((s) => s.log)
  const ins = log.filter((l) => l.dir === 'in').slice(-4)
  const outs = log.filter((l) => l.dir === 'out').slice(-4)

  return (
    <section className="monitor" aria-label="輸入輸出監看：MIDI 進、系統事件出">
      <div className="mcol">
        <div className="mhead">IN · 演奏者（KORG）</div>
        {ins.length
          ? ins.map((l, i) => <div key={i} className="mline">{l.text}</div>)
          : <div className="mline dim">等待輸入…（先按「連線 MIDI」）</div>}
      </div>
      <div className="mcol">
        <div className="mhead">OUT · 系統事件</div>
        {outs.length
          ? outs.map((l, i) => <div key={i} className="mline">{l.text}</div>)
          : <div className="mline dim">—</div>}
      </div>
    </section>
  )
}
