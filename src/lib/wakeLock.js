// 螢幕保持喚醒（Screen Wake Lock）：展場整天不關機時，OS 的「顯示器休眠」計時器只算鍵盤 / 滑鼠輸入，
// 導覽、觀眾視窗、手機遙控都不算 → 投影機會被休眠成黑屏。Chrome 的 wake lock 是系統層級（macOS / Windows 會擋掉所有螢幕的休眠）。
//
//   keepAwake(env?) → release()
//     · 沒有 navigator.wakeLock（舊瀏覽器 / 非安全來源）、請求被拒（省電模式、權限政策）→ 靜默略過，不丟例外。
//     · 瀏覽器會在分頁隱藏時自動放掉 lock → 回到前景（visibilitychange）時重新申請。
//     · 請求是非同步的：若 release() 在請求完成前就被呼叫（React StrictMode 開發模式的 effect 雙跑、快速切換），
//       請求一完成就立刻放掉，不會留下沒人管的 lock。
//     · 一律以「方法」呼叫 navigator.wakeLock.request（原生函式不能拆開呼叫，否則 Illegal invocation）。
//   env（測試用）：{ nav, doc }
export function keepAwake(env = {}) {
  const nav = env.nav !== undefined ? env.nav : (typeof navigator !== 'undefined' ? navigator : null)
  const doc = env.doc !== undefined ? env.doc : (typeof document !== 'undefined' ? document : null)
  let sentinel = null, dead = false, pending = false

  const acquire = () => {
    try {
      if (dead || pending) return
      if (!nav || !nav.wakeLock || typeof nav.wakeLock.request !== 'function') return
      if (doc && doc.visibilityState && doc.visibilityState !== 'visible') return
      if (sentinel && !sentinel.released) return
      pending = true
      Promise.resolve(nav.wakeLock.request('screen')).then(
        (l) => {
          pending = false
          if (!l) return
          if (dead) { try { l.release() } catch (e) { /* ignore */ } return }   // 等待期間已被 release()：立刻放掉
          sentinel = l
        },
        () => { pending = false },
      )
    } catch (e) { pending = false }
  }

  const onVis = () => acquire()
  try { if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVis) } catch (e) { /* ignore */ }
  acquire()

  return function release() {
    if (dead) return
    dead = true
    try { if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVis) } catch (e) { /* ignore */ }
    const l = sentinel
    sentinel = null
    try { if (l && !l.released) { const r = l.release(); if (r && typeof r.catch === 'function') r.catch(() => {}) } } catch (e) { /* ignore */ }
  }
}
