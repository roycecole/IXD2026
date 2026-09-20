// nanoPAD2 打擊墊事件匯流：handleNote 推入，場景 PadFx 每幀消化（velocity = 強度）
export const padEvents = []

// 淨化波力度（0..1）：store.purify(v) 寫入，場景（漣漪三環）與音訊（上行琶音）各自讀取，
// 配合 spawns.purify 計數器偵測「有新的淨化事件」。
export const purifyMeta = { v: 1 }
