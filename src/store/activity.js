// 使用者活動時間戳：任何人為輸入更新，供閒置吸引模式（Attract Mode）判斷
export const activity = { last: 0, glowAt: -1e9 }
export function touch() { try { activity.last = performance.now() } catch (e) { activity.last = 0 } }
// 人為調整「輝光」的時間（旋鈕 / 滑桿 / 手機遙控皆經 input()）：AR 環境光自動調輝光據此暫停。
// 不用 hudState 判斷——它只記「最後動的參數」，其他參數（例如手機傾斜每秒 20 次的洋流）一動就讓暫停失效。
export function touchGlow() { try { activity.glowAt = performance.now() } catch (e) { activity.glowAt = 0 } }
touch()
