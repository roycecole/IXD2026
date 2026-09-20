// 使用者活動時間戳：任何人為輸入更新，供閒置吸引模式（Attract Mode）判斷
export const activity = { last: 0, glowAt: -1e9 }
// 活動掛鉤：touch() 是「使用者要動手了」的同步通知——導覽（services/tourCore.js）在這裡先中止並還原，
// 呼叫端必須在「讀 store 狀態 / 套用輸入」之前呼叫 touch()，輸入才會落在還原後的海上（否則輸入先寫進去、100ms 後被還原蓋掉）。
// 掛鉤內若再呼叫 touch()（例如導覽結束時的 touch）是安全的：導覽器先把自己標成「已結束」才呼叫，重入會直接回傳。
const hooks = new Set()
export function onActivity(fn) { hooks.add(fn); return () => hooks.delete(fn) }
export function touch() {
  try { activity.last = performance.now() } catch (e) { activity.last = 0 }
  if (hooks.size) for (const fn of [...hooks]) { try { fn() } catch (e) { /* 掛鉤出錯不影響輸入 */ } }
}
// 人為調整「輝光」的時間（旋鈕 / 滑桿 / 手機遙控皆經 input()）：AR 環境光自動調輝光據此暫停。
// 不用 hudState 判斷——它只記「最後動的參數」，其他參數（例如手機傾斜每秒 20 次的洋流）一動就讓暫停失效。
export function touchGlow() { try { activity.glowAt = performance.now() } catch (e) { activity.glowAt = 0 } }
touch()
