// 彈窗的鍵盤 / 螢幕閱讀器行為（純 DOM 邏輯，document 以參數注入，Node 可測）。
// 宣告 role="dialog" aria-modal="true" 就要真的做到：
//   · 開啟時焦點移進彈窗（螢幕閱讀器才會唸出對話框、Tab 才不會先走遍背後的整個控制面板）
//   · Esc 關閉
//   · Tab / Shift+Tab 在彈窗內循環（焦點掉到彈窗外——例如按下去的按鈕被 disabled 而失焦——也會被拉回來）
//   · 關閉後焦點回到原本的按鈕（Safari / Firefox 點按鈕不會聚焦 → 退回 fallbackSelector 指的按鈕）
//   · 彈窗開著時，全域快速鍵（T 導覽 / H 演出模式 / I 面板 / 空白鍵 …）不該在背後動作 → isInModal(e.target) 給 App 的鍵盤處理用
export const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
export const MODAL_SELECTOR = '[role="dialog"][aria-modal="true"]'

export function isInModal(target) {
  try { return !!(target && typeof target.closest === 'function' && target.closest(MODAL_SELECTOR)) } catch (e) { return false }
}

export function focusables(container) {
  if (!container || typeof container.querySelectorAll !== 'function') return []
  return Array.from(container.querySelectorAll(FOCUSABLE)).filter((el) => !(el.hidden || (el.getAttribute && el.getAttribute('aria-hidden') === 'true')))
}

const focusEl = (el) => { try { el && typeof el.focus === 'function' && el.focus({ preventScroll: true }); return true } catch (e) { return false } }

// attachModalFocus({ container, doc, onClose, opener?, fallbackSelector? }) → detach()
//   container：彈窗元素（要有 tabIndex=-1 才能被聚焦）；opener 省略 = 開啟當下的 document.activeElement
export function attachModalFocus({ container, doc = (typeof document !== 'undefined' ? document : null), onClose, opener, fallbackSelector } = {}) {
  if (!container || !doc) return () => {}
  const prev = opener !== undefined ? opener : doc.activeElement
  focusEl(container)

  const onKey = (e) => {
    if (e.key === 'Escape') { if (typeof e.preventDefault === 'function') e.preventDefault(); if (onClose) onClose(); return }
    if (e.key !== 'Tab') return
    const list = focusables(container)
    const active = doc.activeElement
    const first = list[0], last = list[list.length - 1]
    let to = null
    if (!list.length) to = container
    else if (!container.contains(active)) to = e.shiftKey ? last : first
    else if (e.shiftKey && (active === first || active === container)) to = last
    else if (!e.shiftKey && active === last) to = first
    if (to) { if (typeof e.preventDefault === 'function') e.preventDefault(); focusEl(to) }
  }
  doc.addEventListener('keydown', onKey)

  return function detach() {
    doc.removeEventListener('keydown', onKey)
    let target = prev && prev !== doc.body && prev.isConnected !== false ? prev : null
    if (!target && fallbackSelector) { try { target = doc.querySelector(fallbackSelector) } catch (e) { target = null } }
    focusEl(target)
  }
}
