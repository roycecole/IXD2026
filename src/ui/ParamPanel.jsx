import { useStore } from '../store/useStore.js'
import { GROUPS, PARAMS } from '../params/registry.js'

function ccForParam(bindings, pid) {
  const cc = Object.keys(bindings).find((c) => bindings[c] === pid)
  return cc === undefined ? null : Number(cc)
}

function Param({ pid }) {
  const value = useStore((s) => s.params[pid])
  const bindings = useStore((s) => s.bindings)
  const learn = useStore((s) => s.learn)
  const setParam = useStore((s) => s.setParam)
  const startLearn = useStore((s) => s.startLearn)
  const unbindParam = useStore((s) => s.unbindParam)

  const meta = PARAMS[pid]
  const cc = ccForParam(bindings, pid)
  const learning = learn.active && learn.target === pid

  const onLabel = (e) => { if (e.shiftKey) unbindParam(pid); else startLearn(pid) }

  return (
    <div className="param">
      <span className={'plabel' + (learning ? ' learning' : '')} onClick={onLabel}
            title="點=Learn 綁定，shift+點=解綁">{meta.label}</span>
      <input type="range" min="0" max="1" step="0.001" value={value}
             onChange={(e) => setParam(pid, parseFloat(e.target.value))} />
      <span className="pval">{value.toFixed(2)}</span>
      <span className={'cc' + (learning ? ' learning' : '')}>
        {learning ? '學習' : cc == null ? '—' : 'CC' + cc}
      </span>
    </div>
  )
}

export default function ParamPanel() {
  const midi = useStore((s) => s.midi)
  const learn = useStore((s) => s.learn)
  const startSeqLearn = useStore((s) => s.startSeqLearn)
  const cancelLearn = useStore((s) => s.cancelLearn)
  const seqActive = learn.active && learn.seq >= 0

  return (
    <aside className="panel">
      <div className="panel-head">
        <span className="dim">控制器</span>
        <span className="ctrl-name">{midi.connected ? (midi.inputs[0] || 'MIDI') : '未連線'}</span>
      </div>
      {midi.error && <p className="hint" style={{ color: '#ff7a7a' }}>MIDI：{midi.error}</p>}

      <button className={'learn-btn' + (seqActive ? ' on' : '')}
              onClick={() => (seqActive ? cancelLearn() : startSeqLearn())}>
        {seqActive ? '依序對應中…（轉旋鈕）· 點此取消' : '⊕ 依序對應旋鈕 (Learn)'}
      </button>
      <p className="hint">點參數名稱 → 轉旋鈕即綁定；shift+點 = 解綁</p>

      {GROUPS.map((g) => (
        <div key={g.id} className="group">
          <div className="group-title">{g.label}</div>
          {g.params.map((p) => <Param key={p.id} pid={p.id} />)}
        </div>
      ))}
    </aside>
  )
}
