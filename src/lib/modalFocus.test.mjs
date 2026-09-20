// 彈窗焦點管理單元測試。執行：node --test src/lib/modalFocus.test.mjs
// 假 DOM：元素有 focus() / contains()；document 記 activeElement 與 keydown 監聽。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { attachModalFocus, focusables, isInModal, MODAL_SELECTOR, FOCUSABLE } from './modalFocus.js'

function world() {
  const doc = { activeElement: null, L: [], body: { name: 'body' }, addEventListener(t, f) { if (t === 'keydown') this.L.push(f) }, removeEventListener(t, f) { this.L = this.L.filter((x) => x !== f) }, querySelector: () => null }
  const el = (name, extra = {}) => ({ name, isConnected: true, hidden: false, focus() { doc.activeElement = this }, getAttribute: () => null, ...extra })
  const opener = el('opener')
  const b1 = el('close'), b2 = el('toggle'), b3 = el('done')
  const container = el('modal', { querySelectorAll: () => [b1, b2, b3], contains(x) { return x === this || [b1, b2, b3].includes(x) } })
  doc.activeElement = opener
  const key = (k, o = {}) => { const e = { key: k, shiftKey: false, prevented: false, preventDefault() { this.prevented = true }, ...o }; for (const f of [...doc.L]) f(e); return e }
  return { doc, el, opener, b1, b2, b3, container, key }
}

test('開啟：焦點移進彈窗（螢幕閱讀器才知道對話框開了）', () => {
  const w = world()
  attachModalFocus({ container: w.container, doc: w.doc, onClose() {} })
  assert.equal(w.doc.activeElement, w.container)
})

test('Esc 關閉（以前沒有任何 Esc 處理）', () => {
  const w = world(); let closed = 0
  attachModalFocus({ container: w.container, doc: w.doc, onClose: () => closed++ })
  const e = w.key('Escape')
  assert.equal(closed, 1); assert.equal(e.prevented, true)
})

test('Tab / Shift+Tab 在彈窗內循環，不會走到背後的面板', () => {
  const w = world()
  attachModalFocus({ container: w.container, doc: w.doc, onClose() {} })
  w.b3.focus(); let e = w.key('Tab')
  assert.equal(w.doc.activeElement, w.b1, '最後一個 → 回到第一個'); assert.equal(e.prevented, true)
  w.b1.focus(); e = w.key('Tab', { shiftKey: true })
  assert.equal(w.doc.activeElement, w.b3, '第一個 Shift+Tab → 最後一個'); assert.equal(e.prevented, true)
  w.container.focus(); e = w.key('Tab', { shiftKey: true })
  assert.equal(w.doc.activeElement, w.b3, '焦點在彈窗容器本身 Shift+Tab → 最後一個')
  w.b2.focus(); e = w.key('Tab')
  assert.equal(e.prevented, false, '中間的元素交給瀏覽器'); assert.equal(w.doc.activeElement, w.b2)
})

test('焦點掉到彈窗外（按下的按鈕被 disabled 而失焦 → body）：Tab 把它拉回彈窗', () => {
  const w = world()
  attachModalFocus({ container: w.container, doc: w.doc, onClose() {} })
  w.doc.activeElement = w.doc.body
  let e = w.key('Tab'); assert.equal(w.doc.activeElement, w.b1); assert.equal(e.prevented, true)
  w.doc.activeElement = w.doc.body
  e = w.key('Tab', { shiftKey: true }); assert.equal(w.doc.activeElement, w.b3)
})

test('沒有可聚焦元素：焦點停在容器，不逃出去', () => {
  const w = world(); w.container.querySelectorAll = () => []
  attachModalFocus({ container: w.container, doc: w.doc, onClose() {} })
  w.doc.activeElement = w.doc.body
  const e = w.key('Tab'); assert.equal(w.doc.activeElement, w.container); assert.equal(e.prevented, true)
})

test('關閉：移除監聽、焦點回到開啟它的按鈕；按鈕不在了 / 從沒聚焦（Safari 點擊不聚焦按鈕 → body）→ 退回 fallbackSelector', () => {
  const w = world()
  let off = attachModalFocus({ container: w.container, doc: w.doc, onClose() {} })
  off()
  assert.equal(w.doc.L.length, 0); assert.equal(w.doc.activeElement, w.opener)

  const w2 = world(); w2.doc.activeElement = w2.doc.body
  const devBtn = w2.el('devices'); w2.doc.querySelector = (sel) => (sel === '[data-k="devices"]' ? devBtn : null)
  off = attachModalFocus({ container: w2.container, doc: w2.doc, onClose() {}, fallbackSelector: '[data-k="devices"]' })
  off(); assert.equal(w2.doc.activeElement, devBtn)

  const w3 = world(); w3.opener.isConnected = false
  off = attachModalFocus({ container: w3.container, doc: w3.doc, onClose() {} }); off()
  assert.notEqual(w3.doc.activeElement, w3.opener, '已卸載的元素不聚焦')
})

test('StrictMode 開發模式的 effect 雙跑：第一次 cleanup 還原焦點，第二次重新記錄，最後仍回到原按鈕', () => {
  const w = world()
  let off = attachModalFocus({ container: w.container, doc: w.doc, onClose() {} }); off()
  off = attachModalFocus({ container: w.container, doc: w.doc, onClose() {} })
  assert.equal(w.doc.activeElement, w.container)
  off(); assert.equal(w.doc.activeElement, w.opener); assert.equal(w.doc.L.length, 0)
})

test('isInModal：焦點在對話框內 → 全域快速鍵要略過；一般元素 / null / 壞值 → false', () => {
  const inside = { closest: (sel) => (sel === MODAL_SELECTOR ? {} : null) }
  assert.equal(isInModal(inside), true)
  assert.equal(isInModal({ closest: () => null }), false)
  assert.equal(isInModal(null), false); assert.equal(isInModal({}), false)
  assert.equal(isInModal({ closest() { throw new Error('x') } }), false)
})

test('focusables：排除 hidden / aria-hidden；選擇器涵蓋按鈕、輸入、select，不含 disabled', () => {
  const mk = (o) => ({ hidden: false, getAttribute: () => null, ...o })
  const list = [mk({ n: 1 }), mk({ n: 2, hidden: true }), mk({ n: 3, getAttribute: (a) => (a === 'aria-hidden' ? 'true' : null) })]
  assert.deepEqual(focusables({ querySelectorAll: () => list }).map((x) => x.n), [1])
  assert.deepEqual(focusables(null), [])
  assert.match(FOCUSABLE, /button:not\(\[disabled\]\)/); assert.match(FOCUSABLE, /input:not\(\[disabled\]\)/)
})

test('接線：DevicesModal 使用 attachModalFocus 並可聚焦；App 的全域快速鍵在彈窗內略過', () => {
  const dm = readFileSync(new URL('../ui/DevicesModal.jsx', import.meta.url), 'utf8')
  assert.match(dm, /attachModalFocus\(/); assert.match(dm, /tabIndex=\{-1\}/)
  const app = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8')
  assert.match(app, /isInModal\(e\.target\)/)
})
