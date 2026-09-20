import { useEffect, useRef, useState } from 'react'
import { useT, T } from './i18n/index.js'
import { NOTE_LIMITS, clampNote, clearNote, detectDeviceInfo, noteIsEmpty } from './lib/diagnosticsNote.js'

// 「裝置備註」（選填）：頁首與導引開始前各有一份（同一份狀態）。
//   · 只有填了的欄位才會進報告，只在使用者按「複製報告 / 下載 JSON」時才產生；不上傳。草稿存在這台裝置的 localStorage（App 那邊負責存取）。
//   · 「帶入偵測值」只在使用者按下時才呼叫 navigator.userAgentData.getHighEntropyValues（見 lib/diagnosticsNote.js）；失敗退回解析 UA。
//   note：{ model, os, browser, tester, memo }；setNote：React 的 setState（接受函式）。
const FIELDS = [
  { id: 'model', label: T('裝置型號'), ph: 'iPhone 15 / Pixel 8 / MacBook Air' },
  { id: 'os', label: T('作業系統與版本'), ph: 'iOS 18.1 / Android 15' },
  { id: 'browser', label: T('瀏覽器與版本'), ph: 'Safari 18 / Chrome 130' },
  { id: 'tester', label: T('測試人'), ph: '' },
]

export default function DeviceNote({ note, setNote, env, defaultOpen = false, idPrefix = 'diag-note' }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])   // StrictMode：卸載 → 重掛也正確

  const set = (field, value) => setNote((n) => clampNote({ ...n, [field]: value }))
  const detect = async () => {
    setBusy(true); setMsg('')
    let info = null
    try { info = await detectDeviceInfo(env) } catch (e) { info = null }
    if (!alive.current) return
    setBusy(false)
    if (!info || info.source === 'none') { setMsg(t('偵測不到裝置資訊，請手動填寫。')); return }
    setNote((n) => clampNote({ ...n, model: info.model || n.model, os: info.os || n.os, browser: info.browser || n.browser }))
    setMsg(info.source === 'client-hints' ? t('已帶入偵測值（來自瀏覽器提供的裝置資訊），請確認是否正確。') : t('已帶入偵測值（由 UA 字串推測，型號常常抓不到），請確認並補上。'))
  }
  const clear = () => { clearNote(); setNote(clampNote({})); setMsg(t('已清除裝置備註。')) }
  const filled = !noteIsEmpty(note)

  return (
    <details className="diag-notebox" open={defaultOpen ? true : undefined}>
      <summary>
        <span>{t('裝置備註（選填）')}</span>
        {filled && <em>{t('已填寫')}</em>}
      </summary>
      <p className="diag-note">{t('選填，只在你按複製 / 下載時才進報告，不會上傳。你填的內容會原樣寫進報告（包含測試人姓名），請只填需要的資訊。')}</p>
      <div className="diag-note-grid">
        {FIELDS.map((f) => (
          <label className="diag-field" key={f.id} htmlFor={`${idPrefix}-${f.id}`}>
            <span>{t(f.label)}</span>
            <input id={`${idPrefix}-${f.id}`} type="text" value={note[f.id]} maxLength={NOTE_LIMITS[f.id]} placeholder={f.ph} autoComplete="off" autoCapitalize="off" spellCheck={false}
              onChange={(e) => set(f.id, e.target.value)} />
          </label>
        ))}
        <label className="diag-field diag-field-wide" htmlFor={`${idPrefix}-memo`}>
          <span>{t('備註')} <small>{t('最多 {n} 字', { n: NOTE_LIMITS.memo })} · {Array.from(note.memo).length}/{NOTE_LIMITS.memo}</small></span>
          <textarea id={`${idPrefix}-memo`} rows={3} value={note.memo} maxLength={NOTE_LIMITS.memo}
            onChange={(e) => set('memo', e.target.value)} />
        </label>
      </div>
      <div className="diag-ctl">
        <button type="button" className="diag-btn" onClick={detect} disabled={busy}>{busy ? t('偵測中…') : t('帶入偵測值')}</button>
        <button type="button" className="diag-btn ghost" onClick={clear} disabled={!filled}>{t('清除備註')}</button>
      </div>
      <p className="diag-note" role="status" aria-live="polite">{msg}</p>
    </details>
  )
}
