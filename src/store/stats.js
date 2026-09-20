// 展場統計：本機累計「掃碼加入人數 / 演出次數（播放+錄製）」，kiosk / 多人 modal 顯示。
import { LS, loadLS, saveLS } from '../lib/persist.js'

export const stats = Object.assign({ joins: 0, plays: 0, recs: 0 }, loadLS(LS.stats, {}))

export function bumpStat(k) {
  stats[k] = (stats[k] || 0) + 1
  saveLS(LS.stats, stats)
}
