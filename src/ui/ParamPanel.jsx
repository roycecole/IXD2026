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
  const input = useStore((s) => s.input)
  const startLearn = useStore((s) => s.startLearn)
  const unbindParam = useStore((s) => s.unbindParam)

  const meta = PARAMS[pid]
  const cc = ccForParam(bindings, pid)
  const learning = learn.active && learn.target === pid

  const onLabel = (e) => { if (e.shiftKey) unbindParam(pid); else startLearn(pid) }

  return (
    <div className="param">
      <span className={'plabel' + (learning ? ' learning' : '')} role="button" tabIndex={0}
            aria-label={`${meta.label}：Enter 綁定 MIDI，shift+Enter 解綁`} onClick={onLabel}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.shiftKey ? unbindParam(pid) : startLearn(pid) } }}
            title="點/Enter=Learn 綁定，shift+點=解綁">{meta.label}</span>
      <input type="range" min="0" max="1" step="0.001" value={value}
             onChange={(e) => input(pid, parseFloat(e.target.value))} />
      <span className="pval">{value.toFixed(2)}</span>
      <span className={'cc' + (learning ? ' learning' : '')}>
        {learning ? '學習' : cc == null ? '—' : 'CC' + cc}
      </span>
    </div>
  )
}

export default function ParamPanel({ onVK }) {
  const midi = useStore((s) => s.midi)
  const gov = useStore((s) => s.gov)
  const govOptionId = useStore((s) => s.govOptionId)
  const setGovOption = useStore((s) => s.setGovOption)
  const applyGov = useStore((s) => s.applyGov)
  const playGovSeries = useStore((s) => s.playGovSeries)
  const recMode = useStore((s) => s.rec.mode)
  const recSpeed = useStore((s) => s.rec.speed)
  const recLoop = useStore((s) => s.rec.loop)
  const setRecSpeed = useStore((s) => s.setRecSpeed)
  const toggleRecLoop = useStore((s) => s.toggleRecLoop)
  const learn = useStore((s) => s.learn)
  const startSeqLearn = useStore((s) => s.startSeqLearn)
  const cancelLearn = useStore((s) => s.cancelLearn)
  const spawnWhale = useStore((s) => s.spawnWhale)
  const spawnDolphin = useStore((s) => s.spawnDolphin)
  const spawnTurtle = useStore((s) => s.spawnTurtle)
  const clearTrash = useStore((s) => s.clearTrash)
  const seqActive = learn.active && learn.seq >= 0

  const opt = gov && gov.options && (gov.options.find((o) => o.id === govOptionId) || gov.options[0])
  const hasSeries = !!(opt && opt.series && opt.series.points && opt.series.points.length)

  return (
    <aside className="panel" aria-label="控制面板：真實海況與海洋參數">
      <div className="panel-head">
        <span className="dim">控制器</span>
        {midi.connected
          ? <span className="ctrl-name">{midi.inputs[0] || 'MIDI'}</span>
          : <button className="ctrl-name ctrl-vk" onClick={onVK} title="沒有實體裝置？用滑鼠 / 鍵盤操作虛擬 nanoKONTROL2">未連線 · 用虛擬控制器</button>}
      </div>
      {midi.error && <p className="hint" style={{ color: '#ff7a7a' }}>MIDI：{midi.error}</p>}

      {gov && gov.options && (
        <div className="gov-card">
          <div className="gov-title">今日海況 <span className="dim">· {gov.sourceShort}</span></div>
          {gov.weather && <div className="gov-metrics">{gov.weather.weather} · {gov.weather.airTemp}°C · 風 {gov.weather.windSpeed} m/s</div>}
          <select className="gov-select" value={govOptionId || ''} onChange={(e) => setGovOption(e.target.value)}>
            {gov.options.map((o) => <option key={o.id} value={o.id}>{o.kind === 'tide' ? `${o.name}（潮汐）` : `${o.name}（水位 ${o.level}%）`}</option>)}
          </select>
          <button className="gov-apply" onClick={applyGov}>套用此海況</button>
          {hasSeries && (
            <>
              <button className="gov-apply gov-series" onClick={playGovSeries} disabled={recMode !== 'idle'}
                      title={`把 ${opt.name} ${opt.series.date || ''} 的${opt.series.label}時間序列轉成自動化播放`}>
                ▶ 播放 24h {opt.series.label}資料
              </button>
              <div className="gov-playctl" aria-label="資料播放設定">
                {[0.5, 1, 2, 4].map((v) => (
                  <button key={v} className={'gov-spd' + (recSpeed === v ? ' on' : '')} aria-pressed={recSpeed === v}
                          onClick={() => setRecSpeed(v)} title={`播放倍速 ×${v}`}>×{v}</button>
                ))}
                <button className={'gov-spd' + (recLoop ? ' on' : '')} aria-pressed={recLoop}
                        onClick={toggleRecLoop} title="播完自動從頭循環">循環</button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="actions">
        <button onClick={spawnWhale}>鯨魚</button>
        <button onClick={spawnDolphin}>海豚</button>
        <button onClick={spawnTurtle}>海龜</button>
        <button onClick={clearTrash}>清除垃圾</button>
      </div>

      <button className={'learn-btn' + (seqActive ? ' on' : '')} aria-pressed={seqActive}
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
