// 使用者活動時間戳：任何人為輸入更新，供閒置吸引模式（Attract Mode）判斷
export const activity = { last: 0 }
export function touch() { try { activity.last = performance.now() } catch (e) { activity.last = 0 } }
touch()
