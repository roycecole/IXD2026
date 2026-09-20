import { useEffect, useRef, useState } from 'react'
import { startHost, remoteUrl, multiState } from '../lib/multiplayer.js'
import { stats } from '../store/stats.js'

// 多人合奏：開 host + 顯示 QR。手機掃碼開遙控頁，一人演奏變一群人合奏。
export default function MultiModal({ onClose }) {
  const canvasRef = useRef(null)
  const [state, setState] = useState({ ready: multiState.on, count: multiState.count, err: null })
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let dead = false
    const refresh = () => { if (!dead) setState((s) => ({ ...s, ready: multiState.on, count: multiState.count })) }
    ;(async () => {
      try {
        await startHost(refresh)
        refresh()
        const QR = await import('qrcode')
        if (canvasRef.current) {
          await QR.toCanvas(canvasRef.current, remoteUrl(), {
            width: 216, margin: 2,
            color: { dark: '#0b0e17', light: '#f2f7ff' }, // 標準深碼淺底：掃描相容性最佳
          })
        }
      } catch (e) { if (!dead) setState((s) => ({ ...s, err: e.message || '啟動失敗' })) }
    })()
    const iv = setInterval(refresh, 1500)
    return () => { dead = true; clearInterval(iv) }
  }, [])

  const copy = async () => {
    try { await navigator.clipboard.writeText(remoteUrl()); setCopied(true); setTimeout(() => setCopied(false), 1800) } catch (e) {}
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal multi-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="多人合奏">
        <div className="modal-head">
          <span>多人合奏 · 手機掃 QR 當遙控器</span>
          <button onClick={onClose} aria-label="關閉">✕</button>
        </div>
        <div className="multi-body">
          <canvas ref={canvasRef} className="multi-qr" aria-label="遙控器 QR code" />
          {state.err && <p className="hint" style={{ color: '#ff7a7a' }}>連線服務啟動失敗：{state.err}（需要網路）</p>}
          {!state.err && !state.ready && <p className="hint">正在開啟連線服務…</p>}
          {state.ready && (
            <>
              <p className="multi-count">{state.count > 0 ? `已有 ${state.count} 支手機連線 — 正在合奏` : '等待手機掃碼加入…'}</p>
              <button className="multi-copy" onClick={copy}>{copied ? '已複製連結' : '複製遙控連結'}</button>
              {stats.joins > 0 && <p className="hint">本機累計 {stats.joins} 人掃碼 · 演出 {stats.plays + stats.recs} 次</p>}
            </>
          )}
          <p className="hint">每支手機會分到一個「聲部」（海 / 生態 / 氛圍 / 自由），滑桿即時跟著主畫面同步；所有輸入可被錄製、可被 soft-takeover 接管 —— 一個人演奏，變一群人合奏一片海。</p>
        </div>
      </div>
    </div>
  )
}
