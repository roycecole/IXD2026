import { useEffect, useRef, useState } from 'react'
import { startHost, onHostChange, remoteUrl, multiState } from '../lib/multiplayer.js'
import { isGuideQrKey, GUIDE_QR_MS } from '../lib/tourRemote.js'
import { isTypingTarget } from '../services/tourCore.js'
import { isInModal } from '../lib/modalFocus.js'
import { touchGuide } from '../store/activity.js'
import { useT } from '../i18n/index.js'
import '../styles/guide.css'

// 展場模式：角落常顯的小 QR —— 觀眾走過隨掃隨入，「多人」成為展場的預設狀態（不必開 modal）。
// host 斷線重建換了 ID 時 QR 會自動重畫。
// 導覽員 QR：按 G 鍵，換成帶 guide token 的 QR（講解者用手機掃了就能操控資料導覽），標示「導覽員 QR」與倒數，
//   GUIDE_QR_MS（60 秒）後自動換回一般 QR；再按一次 G 立即換回。（掛載期間自己監聽 keydown：忽略輸入元件、彈窗內與修飾鍵。）
export default function KioskQR() {
  const t = useT()
  const cv = useRef(null)
  const drawn = useRef('')
  const drawRef = useRef(null)
  const modeRef = useRef(false)                        // true = 導覽員 QR（draw 讀 ref，切換不必重建 host 訂閱 / 計時器）
  const [count, setCount] = useState(Math.max(0, multiState.count - multiState.guides))
  const [err, setErr] = useState(null)
  const [guideUntil, setGuideUntil] = useState(0)      // 0 = 一般 QR；否則是自動換回的時間（Date.now 毫秒）
  const [, setLeft] = useState(0)                      // 只用來每半秒觸發重繪（倒數顯示在 render 時由 guideUntil 算出，切換當下不會閃過 0）
  const guide = guideUntil > 0
  const secs = guide ? Math.max(1, Math.ceil((guideUntil - Date.now()) / 1000)) : 0

  const clearQr = () => {
    try { const c = cv.current; const g = c && c.getContext && c.getContext('2d'); if (g) g.clearRect(0, 0, c.width, c.height) } catch (e) { /* ignore */ }
  }

  useEffect(() => {
    let dead = false
    const draw = async () => {
      const guideMode = modeRef.current
      const url = remoteUrl({ guide: guideMode })
      if (!url) { if (guideMode) { drawn.current = ''; clearQr() } return }   // 導覽員 QR 還沒有 token：不要留著一般 QR 讓人誤以為是導覽員的
      if (url === drawn.current || !cv.current) return
      drawn.current = url
      try {
        const QR = await import('qrcode')
        if (dead || drawn.current !== url || !cv.current) return              // 等待載入期間換了模式 / 換了 host：這一張作廢
        await QR.toCanvas(cv.current, url, { width: guideMode ? 156 : 132, margin: 2, errorCorrectionLevel: 'L', color: { dark: '#0b0e17', light: '#f2f7ff' } })
      } catch (e) { if (drawn.current === url) drawn.current = '' }
    }
    drawRef.current = draw
    const refresh = () => { if (dead) return; setCount(Math.max(0, multiState.count - multiState.guides)); if (multiState.on) setErr(null); draw() }
    const boot = () => startHost().then(refresh).catch((e) => { if (!dead) setErr(e && (e.message || e.type) || t('離線')) })
    const off = onHostChange(refresh)
    boot()
    // 展場長時間常駐：開機時網路不通 / host 被銷毀後，每 5 秒補一次啟動；QR 因重建換 ID / 換 token 時自動重畫
    const iv = setInterval(() => { if (!multiState.on) boot(); else refresh() }, 5000)
    const iv2 = setInterval(refresh, 1500)
    return () => { dead = true; drawRef.current = null; off(); clearInterval(iv); clearInterval(iv2) }
  }, [])

  // G 鍵：一般 QR ⇄ 導覽員 QR（沒有 token 時不切換）。按 G 表示有人在場操作：記一筆導覽員在場，版本更新 / 每日重載不會在這時打斷。
  useEffect(() => {
    const onKey = (e) => {
      if (!isGuideQrKey(e, { typing: isTypingTarget, inModal: isInModal })) return
      try { touchGuide() } catch (err) { /* ignore */ }
      setGuideUntil((cur) => (cur > 0 ? 0 : multiState.guide ? Date.now() + GUIDE_QR_MS : 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 倒數：時間到自動換回一般 QR；卸載 / 換回時清計時器
  useEffect(() => {
    if (guideUntil <= 0) return
    const tick = () => { const s = Math.ceil((guideUntil - Date.now()) / 1000); if (s <= 0) setGuideUntil(0); else setLeft(s) }
    tick()
    const iv = setInterval(tick, 500)
    return () => clearInterval(iv)
  }, [guideUntil])

  // 模式切換：立刻清掉舊 QR 並重畫
  useEffect(() => {
    modeRef.current = guide
    drawn.current = ''
    clearQr()
    if (drawRef.current) drawRef.current()
  }, [guide])

  return (
    <div className={'kiosk-qr' + (guide ? ' is-guide' : '')} role="img" aria-label={guide ? t('導覽員遙控器 QR code') : t('掃碼加入合奏')}>
      <canvas ref={cv} width={132} height={132} />
      <div className="kiosk-qr-cap">{guide ? t('導覽員 QR · 僅供講解者') : t('掃碼一起演奏')}</div>
      <div className="kiosk-qr-count">
        {guide ? t('{s} 秒後換回一般 QR', { s: secs }) : err ? t('離線中 · 重試中…') : count > 0 ? t('{n} 人合奏中', { n: count }) : t('用手機演奏這片海')}
      </div>
    </div>
  )
}
