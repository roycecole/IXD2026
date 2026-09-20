// 單音 Synth 的排程時間：Tone 的 Source 時間軸要求 start 時間單調遞增（state.increasing），
// 否則丟「The time must be greater than or equal to the last scheduled time」。
// drip 每滴會在 attack + decay ≈ 0.112s 後自動收尾，所以下一滴至少要晚 DRIP_GAP 秒。
export const DRIP_GAP = 0.13
export const DRIP_JITTER = 0.09

// now：Tone.now()；last：上一滴排定的時間（沒有就 0）；rand：0~1 的隨機數（測試可注入）
export function nextDripTime(now, last, rand = Math.random()) {
  return Math.max(now + rand * DRIP_JITTER, last + DRIP_GAP)
}
