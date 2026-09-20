import { useStore, seriesMeta } from '../store/useStore.js'
import { AirSparkline } from './AirCompareCard.jsx'

// 目前播放到的小時（'MM-DD HH:MM'，與 series.js 的點 t 同一格式）；不是在播空氣品質序列 → null。
// 回傳原始字串，zustand 只在「換了一小時」（空氣品質 0.2 秒一步）才重繪這個小元件——不會讓整張資料卡跟著播放重繪。
export function airPlayHour(s) {
  if (!seriesMeta.active || s.rec.mode !== 'playing' || seriesMeta.kind !== 'air' || !seriesMeta.points.length) return null
  const step = seriesMeta.step > 0 ? seriesMeta.step : 0.2
  const i = Math.max(0, Math.min(seriesMeta.points.length - 1, Math.floor(s.rec.playhead / step)))
  const p = seriesMeta.points[i]
  return p && p.t ? String(p.t) : null
}

// 空氣品質迷你折線（資料卡 / 資料看板共用）：播放中會標出目前那一小時
export default function AirSparkLive({ air, height }) {
  const hour = useStore(airPlayHour)
  return <AirSparkline air={air} height={height} hour={hour} />
}
