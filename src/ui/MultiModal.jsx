import { useEffect, useRef, useState } from 'react'
import { startHost, onHostChange, remoteUrl, multiState } from '../lib/multiplayer.js'
import { stats } from '../store/stats.js'
import { useT } from '../i18n/index.js'
import '../styles/guide.css'

// 多人合奏：開 host + 顯示 QR。手機掃碼開遙控頁，一人演奏變一群人合奏。
// 「合奏 | 導覽員」切換：導覽員模式顯示帶 guide token 的 QR（#remote=<id>&guide=<token>），手機掃了只能操控資料導覽（上一站 / 暫停 / 下一站）。
export default function MultiModal({ onClose }) {
  const t = useT()
  const canvasRef = useRef(null)
  const drawn = useRef('')
  const modeRef = useRef('jam')                      // draw 讀 ref，切換模式不必重建整個 effect（host 訂閱 / 計時器）
  const drawRef = useRef(null)
  const [mode, setMode] = useState('jam')            // 'jam' 合奏 QR | 'guide' 導覽員 QR
  const [state, setState] = useState({ ready: multiState.on, count: multiState.count, guides: multiState.guides, err: null })
  const [copied, setCopied] = useState(false)
  const guideMode = mode === 'guide'

  const clearQr = () => {
    try { const c = canvasRef.current; const g = c && c.getContext && c.getContext('2d'); if (g) g.clearRect(0, 0, c.width, c.height) } catch (e) { /* 沒有 2d context 就算了 */ }
  }

  useEffect(() => {
    let dead = false
    const draw = async () => {                        // host 重建換 ID / 換 token 時也會重畫
      const url = remoteUrl({ guide: modeRef.current === 'guide' })
      if (!url) { if (modeRef.current === 'guide') { drawn.current = ''; clearQr() } return }   // 導覽員 QR 還沒有 token：不要留著合奏 QR 讓人誤掃
      if (url === drawn.current || !canvasRef.current) return
      drawn.current = url
      try {
        const QR = await import('qrcode')
        if (dead || drawn.current !== url || !canvasRef.current) return                          // 等待載入期間換了模式 / 換了 host：這一張作廢
        await QR.toCanvas(canvasRef.current, url, {
          width: 216, margin: 2,
          color: { dark: '#0b0e17', light: '#f2f7ff' }, // 標準深碼淺底：掃描相容性最佳
        })
      } catch (e) { if (drawn.current === url) drawn.current = '' }
    }
    drawRef.current = draw
    // 只有 host 真的在線才清錯誤（否則離線時錯誤訊息每 2 秒被抹掉，之後永遠卡在「正在開啟…」）
    const refresh = () => { if (!dead) { setState((s) => ({ ...s, ready: multiState.on, count: multiState.count, guides: multiState.guides, err: multiState.on ? null : s.err })); draw() } }
    const boot = () => startHost().then(refresh).catch((e) => { if (!dead) setState((s) => ({ ...s, err: e.message || e.type || true })) })
    const off = onHostChange(refresh)
    boot()
    const iv = setInterval(refresh, 2000)
    const iv2 = setInterval(() => { if (!multiState.on) boot() }, 5000) // 離線時每 5 秒重試（與展場 QR 一致）
    return () => { dead = true; drawRef.current = null; off(); clearInterval(iv); clearInterval(iv2) }
  }, [])

  useEffect(() => {                                   // 切換「合奏 | 導覽員」：立刻清掉舊 QR 並重畫
    modeRef.current = mode
    drawn.current = ''
    setCopied(false)
    clearQr()
    if (drawRef.current) drawRef.current()
  }, [mode])

  const copy = async () => {
    const url = remoteUrl({ guide: guideMode })
    if (!url) return
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1800) } catch (e) {}
  }

  const jammers = Math.max(0, state.count - state.guides)   // 導覽員的手機不算「在合奏」
  const guideReady = !!multiState.guide

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal multi-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t('多人合奏')}>
        <div className="modal-head">
          <span>{guideMode ? t('導覽員遙控器 · 手機掃 QR 操控資料導覽') : t('多人合奏 · 手機掃 QR 當遙控器')}</span>
          <button onClick={onClose} aria-label={t('關閉')}>✕</button>
        </div>
        <div className="multi-body">
          <div className="multi-seg" role="group" aria-label={t('QR 類型')}>
            <button type="button" className={guideMode ? '' : 'on'} aria-pressed={!guideMode} onClick={() => setMode('jam')}>{t('合奏')}</button>
            <button type="button" className={guideMode ? 'on' : ''} aria-pressed={guideMode} onClick={() => setMode('guide')}>{t('導覽員')}</button>
          </div>
          <canvas ref={canvasRef} className="multi-qr" aria-label={guideMode ? t('導覽員遙控器 QR code') : t('遙控器 QR code')} />
          {state.err && <p className="hint" style={{ color: '#ff7a7a' }}>{t('連線服務啟動失敗：{err}（需要網路）', { err: state.err === true ? t('啟動失敗') : state.err })}</p>}
          {!state.err && !state.ready && <p className="hint">{t('正在開啟連線服務…')}</p>}
          {state.ready && !guideMode && (
            <>
              <p className="multi-count">{jammers > 0 ? t('已有 {n} 支手機連線 — 正在合奏', { n: jammers }) : t('等待手機掃碼加入…')}</p>
              <button className="multi-copy" onClick={copy}>{copied ? t('已複製連結') : t('複製遙控連結')}</button>
              {stats.joins > 0 && <p className="hint">{t('本機累計 {joins} 人掃碼 · 演出 {shows} 次', { joins: stats.joins, shows: stats.plays + stats.recs })}</p>}
            </>
          )}
          {state.ready && guideMode && (guideReady ? (
            <>
              <p className="multi-count">{state.guides > 0 ? t('已有 {n} 支導覽員手機連線', { n: state.guides }) : t('等待導覽員手機掃碼…')}</p>
              <button className="multi-copy" onClick={copy}>{copied ? t('已複製連結') : t('複製導覽員連結')}</button>
              <p className="multi-guide-note">{t('只能操控資料導覽：手機出現「上一站 / 暫停 / 下一站」大按鈕，站在投影機旁就能講解，不必碰筆電。不能演奏，也不會改動其他設定。')}</p>
              <p className="multi-guide-warn">{t('只給講解的人掃，別公開。這個 QR 只在這次開啟的主畫面有效；主畫面重新載入後會換新，要重新掃描。')}</p>
            </>
          ) : <p className="hint" style={{ color: '#ff7a7a' }}>{t('這個瀏覽器無法產生安全的導覽員連結')}</p>)}
          {!guideMode && <p className="hint">{t('每支手機會分到一個「聲部」（海 / 生態 / 氛圍 / 自由），滑桿即時跟著主畫面同步；所有輸入可被錄製、可被 soft-takeover 接管 —— 一個人演奏，變一群人合奏一片海。')}</p>}
        </div>
      </div>
    </div>
  )
}
