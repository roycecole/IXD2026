// 手機遙控頁專用的輕量「螢幕保持喚醒」（導覽員拿手機講解時，手機不要自己鎖屏）。
// 只依賴 navigator.wakeLock（沒有任何 import）：遙控頁必須保持輕量，不能 import 主畫面用的 lib/wakeLock.js。
//
//   holdScreenAwake({ nav?, doc?, onState? }) → release()
//     onState(state)：'unsupported'（沒有 navigator.wakeLock：舊瀏覽器 / iOS 16.4 以下 / 非 https）· 'pending'（請求中）· 'on'（持有中）
//                     'off'（被系統放掉：例如分頁進背景，回到前景會自動重新取得）· 'failed'（請求被拒：省電模式等；下次回到前景再試）
//     · 請求是非同步的：release() 在請求完成前就被呼叫（StrictMode 雙掛載、連線很快斷掉），請求一完成就立刻放掉，不會留下沒人管的 lock。
//     · 系統會在分頁隱藏時自動放掉 lock（sentinel 發 'release' 事件）→ 回到前景（visibilitychange）時重新取得；隱藏中不請求。
//     · 已持有 / 請求中時不重複請求。release() 可重複呼叫；sentinel 已被系統放掉就不再對它呼叫 release()。
//     · 所有原生呼叫都以「方法」呼叫（navigator.wakeLock.request、sentinel.release / addEventListener、document.addEventListener）：
//       原生函式脫離原物件呼叫會丟 Illegal invocation（Node 不會，所以測試用會檢查 this 的假物件）。任何例外都吞掉——喚醒失敗不能影響遙控。
//   wakeLockSupported(nav?) → boolean
const noop = () => {}

export function wakeLockSupported(nav) {
  try {
    const n = nav !== undefined ? nav : (typeof navigator !== 'undefined' ? navigator : null)
    return !!(n && n.wakeLock && typeof n.wakeLock.request === 'function')
  } catch (e) { return false }
}

export function holdScreenAwake(env = {}) {
  const nav = env.nav !== undefined ? env.nav : (typeof navigator !== 'undefined' ? navigator : null)
  const doc = env.doc !== undefined ? env.doc : (typeof document !== 'undefined' ? document : null)
  const onState = typeof env.onState === 'function' ? env.onState : noop
  let sentinel = null, dead = false, pending = false, state = ''
  let onRel = null   // 目前這個 sentinel 的 'release' 監聽

  const set = (s) => { if (dead || s === state) return; state = s; try { onState(s) } catch (e) { /* 呼叫端出錯不影響喚醒 */ } }
  const unbind = (l) => { if (l && onRel) { try { if (typeof l.removeEventListener === 'function') l.removeEventListener('release', onRel) } catch (e) { /* ignore */ } } onRel = null }
  const safeRelease = (l) => { try { if (l && !l.released) { const r = l.release(); if (r && typeof r.catch === 'function') r.catch(noop) } } catch (e) { /* ignore */ } }

  function acquire() {
    try {
      if (dead || pending) return
      if (!wakeLockSupported(nav)) return
      if (doc && doc.visibilityState && doc.visibilityState !== 'visible') return   // 隱藏中不請求（會被拒）；回到前景再來
      if (sentinel && !sentinel.released) return                                     // 已持有：不重複請求
      pending = true
      set('pending')
      Promise.resolve(nav.wakeLock.request('screen')).then(
        (l) => {
          pending = false
          if (!l) { set('failed'); return }
          if (dead) { safeRelease(l); return }                                        // 等待期間已被 release()：立刻放掉
          sentinel = l
          const mine = () => { if (sentinel === l) { sentinel = null; unbind(l); set('off') } }   // 系統放掉了（分頁進背景 / 省電）：標記，回到前景會重新申請
          onRel = mine
          try { if (typeof l.addEventListener === 'function') l.addEventListener('release', mine) } catch (e) { /* ignore */ }
          set('on')
        },
        () => { pending = false; set('failed') },
      )
    } catch (e) { pending = false; set('failed') }   // request 同步丟例外（例如舊版 API）
  }

  const onVis = () => acquire()
  if (!wakeLockSupported(nav)) {
    set('unsupported')
  } else {
    try { if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVis) } catch (e) { /* ignore */ }
    acquire()
  }

  return function release() {
    if (dead) return
    dead = true
    try { if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVis) } catch (e) { /* ignore */ }
    const l = sentinel
    sentinel = null
    unbind(l)
    safeRelease(l)
  }
}
