import { useState } from 'react'
import { useStore } from '../store/useStore.js'
import { PARAMS, ACTION_BINDINGS } from '../params/registry.js'
import { useT, T } from '../i18n/index.js'

// 虛擬 nanoKONTROL2：沒有實體裝置也能用滑鼠 / 鍵盤操作。
// 每個控制都呼叫 store.handleCC(cc, value)，與真硬體走同一條綁定 / Learn / soft-takeover 路徑。

const ACTION_LABELS = { spawnWhale: T('鯨魚'), spawnDolphin: T('海豚'), spawnTurtle: T('海龜'), clearTrash: T('清垃圾') }
// nanoPAD2 事件庫：16 效果 × 4 bank（bank=強度檔位 弱/中/強/爆），velocity=力度
const PAD_FX = [T('水母'), T('浪湧'), T('漣漪'), T('氣泡'), T('亮星'), T('海豚'), T('鯨魚'), T('海龜'), T('淨化'), T('垃圾'), T('轉向'), T('閃光'), T('衝刺'), T('三漣'), T('星雨'), T('大浪')]
const BANK_NAMES = [T('弱'), T('中'), T('強'), T('爆')]
const send = (cc, v) => useStore.getState().handleCC(cc, Math.max(0, Math.min(1, v)))
const liveVal = (cc) => { const st = useStore.getState(); const pid = st.bindings[cc]; return pid ? (st.params[pid] ?? 0.5) : 0.5 }

function Knob({ cc, label, value }) {
  const t = useT()
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
         onPointerDown={onDown} onKeyDown={onKey} title={t('{label}（CC{cc}）', { label, cc })}>
      <div className="vk-dial" style={{ transform: `rotate(${-135 + value * 270}deg)` }}><i /></div>
    </div>
  )
}

function Fader({ cc, label, value }) {
  const t = useT()
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
         onPointerDown={onDown} onKeyDown={onKey} title={t('{label}（CC{cc}）', { label, cc })}>
      <div className="vk-fill" style={{ height: value * 100 + '%' }} />
      <div className="vk-thumb" style={{ bottom: `calc(${value * 100}% - 4px)` }} />
    </div>
  )
}

export default function VirtualController({ onClose }) {
  const t = useT()
  const params = useStore((s) => s.params)
  const bindings = useStore((s) => s.bindings)
  const [bank, setBank] = useState(1) // 打擊墊 bank（強度檔位），對應 nanoPAD2 音高區段
  const val = (cc) => { const pid = bindings[cc]; return pid ? (params[pid] ?? 0.5) : 0.5 }
  const lab = (cc) => { const pid = bindings[cc]; if (!pid) return '—'; const lb = PARAMS[pid]?.label; return lb ? t(lb) : pid }
  const transport = [{ cc: 45, l: '●', t: T('錄製') }, { cc: 41, l: '▶', t: T('播放') }, { cc: 42, l: '■', t: T('停止') }, { cc: 46, l: '⟲', t: T('清除') }]

  return (
    <div className="vk">
      <div className="vk-head">
        <span>{t('nanoKONTROL2 · 虛擬控制器')} <span className="dim">{t('滑鼠拖曳 / 點選後方向鍵微調')}</span></span>
        <button onClick={onClose} aria-label={t('關閉')}>✕</button>
      </div>
      <div className="vk-body">
        <div className="vk-transport">
          {transport.map((b) => (
            <button key={b.cc} className="vk-tbtn" title={t('{label}（CC{cc}）', { label: t(b.t), cc: b.cc })} onClick={() => send(b.cc, 1)}>{b.l}</button>
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
            <button key={cc} className="vk-solo" title={t('Solo（CC{cc}）', { cc })} onClick={() => send(cc, 1)}>
              {ACTION_LABELS[ACTION_BINDINGS[cc]] ? t(ACTION_LABELS[ACTION_BINDINGS[cc]]) : 'S'}
            </button>
          ))}
        </div>
        <div className="vk-padwrap" role="region" aria-label={t('nanoPAD2 打擊墊：16 種效果，bank 切換強度')}>
          <div className="vk-banks">
            <span className="vk-cc">BANK</span>
            {BANK_NAMES.map((b, i) => (
              <button key={i} className={'vk-bank' + (bank === i ? ' on' : '')} aria-pressed={bank === i}
                      title={t('Bank {n}（{name}）｜nanoPAD2 對應音高 {lo}–{hi}', { n: i + 1, name: t(b), lo: i * 16, hi: i * 16 + 15 })}
                      onClick={() => setBank(i)}>{t(b)}</button>
            ))}
          </div>
          <div className="vk-pads" title={t('nanoPAD2 打擊墊 · 16 種視覺事件（velocity=強度）')}>
            {Array.from({ length: 16 }, (_, i) => (
              <button key={i} className="vk-pad" title={t('Pad {n}｜{fx}（bank {bank}）', { n: i + 1, fx: t(PAD_FX[i]), bank: t(BANK_NAMES[bank]) })}
                      onClick={() => useStore.getState().handleNote(bank * 16 + i, 0.9)}>{t(PAD_FX[i])}</button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
