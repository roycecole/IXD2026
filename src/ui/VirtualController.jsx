import { useStore } from '../store/useStore.js'
import { PARAMS, ACTION_BINDINGS } from '../params/registry.js'

// 虛擬 nanoKONTROL2：沒有實體裝置也能用滑鼠 / 鍵盤操作。
// 每個控制都呼叫 store.handleCC(cc, value)，與真硬體走同一條綁定 / Learn / soft-takeover 路徑。

const ACTION_LABELS = { spawnWhale: '鯨魚', spawnDolphin: '海豚', spawnTurtle: '海龜', clearTrash: '清垃圾' }
const PAD_FX = ['水母', '浪湧', '漣漪', '氣泡', '亮星', '海豚', '鯨魚', '海龜'] // nanoPAD2 事件庫（velocity=強度）
const send = (cc, v) => useStore.getState().handleCC(cc, Math.max(0, Math.min(1, v)))
const liveVal = (cc) => { const st = useStore.getState(); const pid = st.bindings[cc]; return pid ? (st.params[pid] ?? 0.5) : 0.5 }

function Knob({ cc, label, value }) {
  const onDown = (e) => {
    e.preventDefault(); e.currentTarget.focus()
    let ly = e.clientY
    const mv = (ev) => { send(cc, liveVal(cc) - (ev.clientY - ly) * 0.006); ly = ev.clientY }
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up)
  }
  const onKey = (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { send(cc, liveVal(cc) + 0.05); e.preventDefault() }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { send(cc, liveVal(cc) - 0.05); e.preventDefault() }
  }
  return (
    <div className="vk-knob" tabIndex={0} role="slider" aria-label={label} aria-valuenow={Math.round(value * 127)}
         onPointerDown={onDown} onKeyDown={onKey} title={`${label}（CC${cc}）`}>
      <div className="vk-dial" style={{ transform: `rotate(${-135 + value * 270}deg)` }}><i /></div>
    </div>
  )
}

function Fader({ cc, label, value }) {
  const onDown = (e) => {
    e.preventDefault()
    const track = e.currentTarget; track.focus()
    const rect = track.getBoundingClientRect()
    const set = (cy) => send(cc, 1 - (cy - rect.top) / rect.height)
    set(e.clientY)
    const mv = (ev) => set(ev.clientY)
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up)
  }
  const onKey = (e) => {
    if (e.key === 'ArrowUp') { send(cc, liveVal(cc) + 0.05); e.preventDefault() }
    else if (e.key === 'ArrowDown') { send(cc, liveVal(cc) - 0.05); e.preventDefault() }
  }
  return (
    <div className="vk-fader" tabIndex={0} role="slider" aria-label={label} aria-valuenow={Math.round(value * 127)}
         onPointerDown={onDown} onKeyDown={onKey} title={`${label}（CC${cc}）`}>
      <div className="vk-fill" style={{ height: value * 100 + '%' }} />
      <div className="vk-thumb" style={{ bottom: `calc(${value * 100}% - 4px)` }} />
    </div>
  )
}

export default function VirtualController({ onClose }) {
  const params = useStore((s) => s.params)
  const bindings = useStore((s) => s.bindings)
  const val = (cc) => { const pid = bindings[cc]; return pid ? (params[pid] ?? 0.5) : 0.5 }
  const lab = (cc) => { const pid = bindings[cc]; return pid ? (PARAMS[pid]?.label || pid) : '—' }
  const transport = [{ cc: 45, l: '●', t: '錄製' }, { cc: 41, l: '▶', t: '播放' }, { cc: 42, l: '■', t: '停止' }, { cc: 46, l: '⟲', t: '清除' }]

  return (
    <div className="vk">
      <div className="vk-head">
        <span>nanoKONTROL2 · 虛擬控制器 <span className="dim">滑鼠拖曳 / 點選後方向鍵微調</span></span>
        <button onClick={onClose} aria-label="關閉">✕</button>
      </div>
      <div className="vk-body">
        <div className="vk-transport">
          {transport.map((b) => (
            <button key={b.cc} className="vk-tbtn" title={`${b.t}（CC${b.cc}）`} onClick={() => send(b.cc, 1)}>{b.l}</button>
          ))}
        </div>
        <div className="vk-strips">
          {Array.from({ length: 8 }, (_, i) => (
            <div className="vk-strip" key={i}>
              <Knob cc={16 + i} label={lab(16 + i)} value={val(16 + i)} />
              <div className="vk-cc">CC{16 + i}</div>
              <Fader cc={i} label={lab(i)} value={val(i)} />
              <div className="vk-cc">CC{i}</div>
              <div className="vk-lab">{lab(i)}</div>
            </div>
          ))}
        </div>
        <div className="vk-solos">
          {[32, 33, 34, 35].map((cc) => (
            <button key={cc} className="vk-solo" title={`Solo（CC${cc}）`} onClick={() => send(cc, 1)}>
              {ACTION_LABELS[ACTION_BINDINGS[cc]] || 'S'}
            </button>
          ))}
        </div>
        <div className="vk-pads" title="nanoPAD2 打擊墊 · 視覺事件庫">
          {Array.from({ length: 16 }, (_, i) => (
            <button key={i} className="vk-pad" title={`Pad ${i + 1}｜${PAD_FX[i % 8]}`}
                    onClick={() => useStore.getState().handleNote(48 + i, 0.9)}>{PAD_FX[i % 8]}</button>
          ))}
        </div>
      </div>
    </div>
  )
}
