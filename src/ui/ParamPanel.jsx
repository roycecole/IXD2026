import { useStore } from '../store/useStore.js'
import { GROUPS, PARAMS } from '../params/registry.js'
import DataCard from './DataCard.jsx'
import { useT } from '../i18n/index.js'

function ccForParam(bindings, pid) {
  const cc = Object.keys(bindings).find((c) => bindings[c] === pid)
  return cc === undefined ? null : Number(cc)
}

function Param({ pid }) {
  const t = useT()
  const value = useStore((s) => s.params[pid])
  const bindings = useStore((s) => s.bindings)
  const learn = useStore((s) => s.learn)
  const input = useStore((s) => s.input)
  const startLearn = useStore((s) => s.startLearn)
  const unbindParam = useStore((s) => s.unbindParam)

  const linked = useStore((s) => (pid === 'birdCount' ? s.surveyLink.birds : pid === 'fishCount' ? s.surveyLink.fish : false))
  const meta = PARAMS[pid]
  const cc = ccForParam(bindings, pid)
  const learning = learn.active && learn.target === pid

  const onLabel = (e) => { if (e.shiftKey) unbindParam(pid); else startLearn(pid) }

  return (
    <div className="param">
      <span className={'plabel' + (learning ? ' learning' : '')} role="button" tabIndex={0}
            aria-label={t('{label}：Enter 綁定 MIDI，shift+Enter 解綁', { label: t(meta.label) })} onClick={onLabel}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.shiftKey ? unbindParam(pid) : startLearn(pid) } }}
            title={t('點/Enter=Learn 綁定，shift+點=解綁')}>{t(meta.label)}{linked && <em className="plink" title={t('連動調查資料中：拖曳滑桿即可獨立控制')}>{t('資料')}</em>}</span>
      <input type="range" min="0" max="1" step="0.001" value={value}
             onChange={(e) => input(pid, parseFloat(e.target.value))} />
      <span className="pval">{value.toFixed(2)}</span>
      <span className={'cc' + (learning ? ' learning' : '')}>
        {learning ? t('學習') : cc == null ? '—' : 'CC' + cc}
      </span>
    </div>
  )
}

export default function ParamPanel({ onVK }) {
  const t = useT()
  const midi = useStore((s) => s.midi)
  const learn = useStore((s) => s.learn)
  const startSeqLearn = useStore((s) => s.startSeqLearn)
  const cancelLearn = useStore((s) => s.cancelLearn)
  const spawnWhale = useStore((s) => s.spawnWhale)
  const spawnDolphin = useStore((s) => s.spawnDolphin)
  const spawnTurtle = useStore((s) => s.spawnTurtle)
  const clearTrash = useStore((s) => s.clearTrash)
  const seqActive = learn.active && learn.seq >= 0

  return (
    <aside className="panel" aria-label={t('控制面板：真實海況與海洋參數')}>
      <div className="panel-head">
        <span className="dim">{t('控制器')}</span>
        {midi.connected || midi.bleName
          ? <span className="ctrl-name">{midi.connected ? (midi.inputs[0] || 'MIDI') : midi.bleName}{midi.connected && midi.bleName ? t(' + 藍牙') : ''}</span>
          : <button className="ctrl-name ctrl-vk" onClick={onVK} title={t('沒有實體裝置？用滑鼠 / 鍵盤操作虛擬 nanoKONTROL2')}>{t('未連線 · 用虛擬控制器')}</button>}
      </div>
      {midi.error && <p className="hint" style={{ color: '#ff7a7a' }}>{t('MIDI：{err}', { err: t(midi.error, midi.errorP) })}</p>}

      <DataCard />

      <div className="actions">
        <button onClick={spawnWhale}>{t('鯨魚')}</button>
        <button onClick={spawnDolphin}>{t('海豚')}</button>
        <button onClick={spawnTurtle}>{t('海龜')}</button>
        <button onClick={clearTrash}>{t('清除垃圾')}</button>
      </div>

      <button className={'learn-btn' + (seqActive ? ' on' : '')} aria-pressed={seqActive}
              onClick={() => (seqActive ? cancelLearn() : startSeqLearn())}>
        {seqActive ? t('依序對應中…（轉旋鈕）· 點此取消') : t('⊕ 依序對應旋鈕 (Learn)')}
      </button>
      <p className="hint">{t('點參數名稱 → 轉旋鈕即綁定；shift+點 = 解綁')}</p>

      {GROUPS.map((g) => (
        <div key={g.id} className="group">
          <div className="group-title">{g.label}</div>
          {g.params.map((p) => <Param key={p.id} pid={p.id} />)}
        </div>
      ))}
    </aside>
  )
}
