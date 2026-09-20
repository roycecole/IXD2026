import { useEffect, useRef, useState } from 'react'
import { startHost, onHostChange, remoteUrl, multiState } from '../lib/multiplayer.js'
import { stats } from '../store/stats.js'
import { useT } from '../i18n/index.js'

// 多人合奏：開 host + 顯示 QR。手機掃碼開遙控頁，一人演奏變一群人合奏。
export default function MultiModal({ onClose }) {
  const t = useT()
  const canvasRef = useRef(null)
  const drawn = useRef('')
  const [state, setState] = useState({ ready: multiState.on, count: multiState.count, err: null })
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let dead = false
    const draw = async () => {                        // host 重建換 ID 時也會重畫
      const url = remoteUrl()
      if (!url || url === drawn.current || !canvasRef.current) return
      drawn.current = url
      try {
        const QR = await import('qrcode')
        await QR.toCanvas(canvasRef.current, url, {
          width: 216, margin: 2,
          color: { dark: '#0b0e17', light: '#f2f7ff' }, // 標準深碼淺底：掃描相容性最佳
        })
      } catch (e) { drawn.current = '' }
    }
    // 只有 host 真的在線才清錯誤（否則離線時錯誤訊息每 2 秒被抹掉，之後永遠卡在「正在開啟…」）
    const refresh = () => { if (!dead) { setState((s) => ({ ...s, ready: multiState.on, count: multiState.count, err: multiState.on ? null : s.err })); draw() } }
    const boot = () => startHost().then(refresh).catch((e) => { if (!dead) setState((s) => ({ ...s, err: e.message || e.type || true })) })
    const off = onHostChange(refresh)
    boot()
    const iv = setInterval(refresh, 2000)
    const iv2 = setInterval(() => { if (!multiState.on) boot() }, 5000) // 離線時每 5 秒重試（與展場 QR 一致）
    return () => { dead = true; off(); clearInterval(iv); clearInterval(iv2) }
  }, [])

  const copy = async () => {
    try { await navigator.clipboard.writeText(remoteUrl()); setCopied(true); setTimeout(() => setCopied(false), 1800) } catch (e) {}
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal multi-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t('多人合奏')}>
        <div className="modal-head">
          <span>{t('多人合奏 · 手機掃 QR 當遙控器')}</span>
          <button onClick={onClose} aria-label={t('關閉')}>✕</button>
        </div>
        <div className="multi-body">
          <canvas ref={canvasRef} className="multi-qr" aria-label={t('遙控器 QR code')} />
          {state.err && <p className="hint" style={{ color: '#ff7a7a' }}>{t('連線服務啟動失敗：{err}（需要網路）', { err: state.err === true ? t('啟動失敗') : state.err })}</p>}
          {!state.err && !state.ready && <p className="hint">{t('正在開啟連線服務…')}</p>}
          {state.ready && (
            <>
              <p className="multi-count">{state.count > 0 ? t('已有 {n} 支手機連線 — 正在合奏', { n: state.count }) : t('等待手機掃碼加入…')}</p>
              <button className="multi-copy" onClick={copy}>{copied ? t('已複製連結') : t('複製遙控連結')}</button>
              {stats.joins > 0 && <p className="hint">{t('本機累計 {joins} 人掃碼 · 演出 {shows} 次', { joins: stats.joins, shows: stats.plays + stats.recs })}</p>}
            </>
          )}
          <p className="hint">{t('每支手機會分到一個「聲部」（海 / 生態 / 氛圍 / 自由），滑桿即時跟著主畫面同步；所有輸入可被錄製、可被 soft-takeover 接管 —— 一個人演奏，變一群人合奏一片海。')}</p>
        </div>
      </div>
    </div>
  )
}
