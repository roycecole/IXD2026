// 「裝置」面板的一節：AR 桌面（WebXR immersive-ar）。
// 這個檔案只是「閘門」：不支援的裝置（iOS Safari 沒有 navigator.xr、桌面沒有 AR 裝置）→ return null，完全不載入任何 XR 程式碼；
// 支援的裝置才動態載入 lib/xr.js（偵測）與 ui/XrOverlay.jsx（面板內容 + DOM overlay），所以主 bundle 不變。
// iOS 仍用工具列的「實景」（相機當背景）。
import { useEffect, useState } from 'react'

let cachedPanel = null   // 載入過就記住：面板關掉再開不會閃一下

export default function XrSection() {
  const [Panel, setPanel] = useState(() => cachedPanel)
  useEffect(() => {
    if (cachedPanel || typeof navigator === 'undefined' || !('xr' in navigator)) return undefined   // 沒有 WebXR：零成本，什麼都不做
    let dead = false
    import('../../lib/xr.js')
      .then((m) => m.isXrArSupported())
      .then((ok) => (ok ? import('../XrOverlay.jsx') : null))
      .then((m) => { if (m) { cachedPanel = m.XrPanel; if (!dead) setPanel(() => m.XrPanel) } })
      .catch(() => { /* 偵測 / 載入失敗 = 當作不支援，這一節不出現，其他功能不受影響 */ })
    return () => { dead = true }
  }, [])
  return Panel ? <Panel /> : null
}
