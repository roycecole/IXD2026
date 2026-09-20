// 常駐服務：QualityService（由 App 掛載一次；平常不渲染畫面，只有網址帶 ?fps=1 時在角落顯示 FPS 除錯數字）。
// 用 requestAnimationFrame 量每幀的 dt（刻意不放進 R3F useFrame，避免影響場景），餵給 lib/quality.js 的狀態機；
// 狀態機換級 → 寫進 lib/qualityStore.js，Scene3D 讀 tier 調整 dpr / 生物與粒子數量 / 背景特效。
// 暫停調整的時機（分頁隱藏、錄製、錄影、拖曳）與所有監聽 / 計時器的建立與釋放都在 lib/qualityRuntime.js（瀏覽器 API 可注入，node 可測）。
// 不使用任何權限；離開時取消 rAF、計時器與所有監聽。
import { useEffect } from 'react'
import { useStore } from '../store/useStore.js'
import { useQualityStore } from '../lib/qualityStore.js'
import { isFpsDebug } from '../lib/quality.js'
import { startQualityRuntime } from '../lib/qualityRuntime.js'
import '../styles/quality.css'

function FpsBadge() {
  const fps = useQualityStore((s) => s.fps)
  const tier = useQualityStore((s) => s.tier)
  const mode = useQualityStore((s) => s.mode)
  const paused = useQualityStore((s) => s.paused)
  return <div className="qual-fps" aria-hidden="true">{fps == null ? '--' : fps} fps · {tier}{mode === 'auto' ? ' (auto)' : ''}{paused ? ' · paused' : ''}</div>
}

export default function QualityService() {
  useEffect(() => {
    const rt = startQualityRuntime({ store: useQualityStore, appStore: useStore })
    return () => rt.stop()
  }, [])
  return typeof location !== 'undefined' && isFpsDebug(location.search) ? <FpsBadge /> : null
}
