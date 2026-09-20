import { useEffect, useRef, useState } from 'react'
import { startHost, onHostChange, remoteUrl, multiState } from '../lib/multiplayer.js'

// 展場模式：角落常顯的小 QR —— 觀眾走過隨掃隨入，「多人」成為展場的預設狀態（不必開 modal）。
// host 斷線重建換了 ID 時 QR 會自動重畫。
export default function KioskQR() {
  const cv = useRef(null)
  const drawn = useRef('')
  const [count, setCount] = useState(multiState.count)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let dead = false
    const draw = async () => {
      const url = remoteUrl()
      if (!url || url === drawn.current || !cv.current) return
      drawn.current = url
      try {
        const QR = await import('qrcode')
        await QR.toCanvas(cv.current, url, { width: 132, margin: 2, errorCorrectionLevel: 'L', color: { dark: '#0b0e17', light: '#f2f7ff' } })
      } catch (e) { drawn.current = '' }
    }
    const refresh = () => { if (dead) return; setCount(multiState.count); if (multiState.on) setErr(null); draw() }
    const boot = () => startHost().then(refresh).catch((e) => { if (!dead) setErr(e && (e.message || e.type) || '離線') })
    const off = onHostChange(refresh)
    boot()
    // 展場長時間常駐：開機時網路不通 / host 被銷毀後，每 5 秒補一次啟動；QR 因重建換 ID 時自動重畫
    const iv = setInterval(() => { if (!multiState.on) boot(); else refresh() }, 5000)
    const iv2 = setInterval(refresh, 1500)
    return () => { dead = true; off(); clearInterval(iv); clearInterval(iv2) }
  }, [])

  return (
    <div className="kiosk-qr" role="img" aria-label="掃碼加入合奏">
      <canvas ref={cv} width={132} height={132} />
      <div className="kiosk-qr-cap">掃碼一起演奏</div>
      <div className="kiosk-qr-count">
        {err ? '離線中 · 重試中…' : count > 0 ? `${count} 人合奏中` : '用手機演奏這片海'}
      </div>
    </div>
  )
}
