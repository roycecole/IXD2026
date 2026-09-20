import { useStore } from '../store/useStore.js'
import { useT } from '../i18n/index.js'

export default function Monitor() {
  const t = useT()
  const log = useStore((s) => s.log)
  const ins = log.filter((l) => l.dir === 'in').slice(-4)
  const outs = log.filter((l) => l.dir === 'out').slice(-4)

  return (
    <section className="monitor" aria-label={t('輸入輸出監看：MIDI 進、系統事件出')}>
      <div className="mcol">
        <div className="mhead">{t('IN · 演奏者（KORG）')}</div>
        {ins.length
          ? ins.map((l, i) => <div key={i} className="mline">{l.text}</div>)
          : <div className="mline dim">{t('等待輸入…（先按「連線 MIDI」）')}</div>}
      </div>
      <div className="mcol">
        <div className="mhead">{t('OUT · 系統事件')}</div>
        {outs.length
          ? outs.map((l, i) => <div key={i} className="mline">{l.text}</div>)
          : <div className="mline dim">—</div>}
      </div>
    </section>
  )
}
