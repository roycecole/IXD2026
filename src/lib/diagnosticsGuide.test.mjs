// 診斷頁導引模式的純邏輯（lib/diagnosticsGuide.js）：排序 / 依裝置能力略過 / 前進後退 / 統計。執行：node --test src/lib/diagnosticsGuide.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GUIDE_ORDER, orderSteps, planGuide, createGuide, guideNext, guideBack, guideGoto, guideRestart, guideCurrent, guideIsLast, guideProgress, bucketOf, guideStats, wantsGuided,
} from './diagnosticsGuide.js'
import { getChecks, getInteractiveChecks } from './diagnostics.js'

const inter = (id) => ({ id, kind: 'interactive' })
const auto = (id) => ({ id, kind: 'auto' })

test('導引順序：旁白 → 看門狗 → 相機手勢 → 相機 → 麥克風 → 語音辨識 → 震動 → 螢幕 / 彈出視窗 → 全螢幕 → MIDI / 手把 / 觸控筆 / 動作感測器；真實註冊表的 15 項互動檢查一項不漏', () => {
  const ids = orderSteps(getChecks()).map((c) => c.id)
  assert.deepEqual(ids, GUIDE_ORDER)
  assert.deepEqual(ids, ['narration', 'watchdog', 'gesture', 'cam', 'mic', 'speech', 'vibrate', 'screens', 'popup', 'fullscreen', 'midi', 'gamepad', 'rumble', 'pointer', 'orient'])
  assert.equal(ids.length, getInteractiveChecks().length, '註冊表的互動檢查都在導引裡（沒有漏、沒有多）')
  assert.deepEqual([...ids].sort(), getInteractiveChecks().map((c) => c.id).sort())
  for (const c of getInteractiveChecks()) assert.ok(typeof c.guide === 'string' && /[㐀-鿿]/.test(c.guide), c.id + ' 有「這項要做什麼」的一句話')
})

test('orderSteps：自動檢查一律丟掉；沒列在順序表裡的互動檢查排在最後（維持原本相對順序）；輸入亂序也照順序表排；壞輸入不丟例外', () => {
  const list = [auto('gl'), inter('orient'), inter('future-b'), inter('cam'), inter('future-a'), inter('narration'), null, undefined]
  assert.deepEqual(orderSteps(list).map((c) => c.id), ['narration', 'cam', 'orient', 'future-b', 'future-a'])
  assert.deepEqual(orderSteps(null), []); assert.deepEqual(orderSteps(undefined), []); assert.deepEqual(orderSteps([]), [])
})

test('planGuide：依裝置能力略過不支援的項目並保留原因；能力檢查丟例外 → 當作可以做；沒給檢查函式 → 全部都做', () => {
  const checks = ['narration', 'watchdog', 'gesture', 'cam', 'vibrate', 'midi'].map(inter)
  const reason = (id) => ({ status: 'unsupported', msg: { key: '沒有 ' + id } })
  const plan = planGuide(checks, (id) => (id === 'vibrate' || id === 'midi' ? reason(id) : id === 'cam' ? (() => { throw new Error('boom') })() : null))
  assert.deepEqual(plan.order, ['narration', 'watchdog', 'gesture', 'cam', 'vibrate', 'midi'])
  assert.deepEqual(plan.steps, ['narration', 'watchdog', 'gesture', 'cam'], '例外 → 仍然要做')
  assert.deepEqual(plan.skipped.map((s) => s.id), ['vibrate', 'midi'])
  assert.deepEqual(plan.skipped[0].outcome, reason('vibrate'), '略過的原因原樣保留（畫面記成「不支援」並顯示原因）')
  const all = planGuide(checks)
  assert.deepEqual(all.steps, all.order); assert.deepEqual(all.skipped, [])
  const none = planGuide(checks, (id) => reason(id))
  assert.deepEqual(none.steps, []); assert.equal(none.skipped.length, 6)
  assert.deepEqual(planGuide(null), { order: [], steps: [], skipped: [] })
})

test('狀態機：intro → 第 1 項 → … → 最後一項 → summary；後退反向；邊界不越界；每個函式回傳新物件（不改舊狀態）', () => {
  const plan = planGuide(['narration', 'watchdog', 'gesture'].map(inter))
  const g0 = createGuide(plan)
  assert.deepEqual(g0, { steps: ['narration', 'watchdog', 'gesture'], skipped: [], phase: 'intro', index: 0 })
  assert.equal(guideCurrent(g0), null); assert.equal(guideIsLast(g0), false)
  const g1 = guideNext(g0); assert.deepEqual([g1.phase, g1.index, guideCurrent(g1)], ['step', 0, 'narration']); assert.equal(g0.phase, 'intro', '舊狀態不變')
  const g2 = guideNext(g1), g3 = guideNext(g2)
  assert.deepEqual([g3.phase, g3.index, guideCurrent(g3), guideIsLast(g3)], ['step', 2, 'gesture', true])
  const s = guideNext(g3); assert.deepEqual([s.phase, guideCurrent(s)], ['summary', null])
  assert.equal(guideNext(s), s, '總結頁再往前 = 原地')
  assert.deepEqual([guideBack(s).phase, guideBack(s).index], ['step', 2], '總結 → 最後一項')
  assert.equal(guideBack(g3).index, 1); assert.deepEqual([guideBack(g1).phase, guideBack(g1).index], ['intro', 0], '第 1 項 → 回到 intro')
  assert.equal(guideBack(g0), g0, 'intro 再後退 = 原地')
  assert.deepEqual([guideGoto(s, 1).phase, guideGoto(s, 1).index, guideCurrent(guideGoto(s, 1))], ['step', 1, 'watchdog'], '從總結跳回某一項重測')
  assert.equal(guideGoto(s, 99).index, 2); assert.equal(guideGoto(s, -5).index, 0); assert.equal(guideGoto(s, NaN).index, 0)
  assert.deepEqual([guideRestart(s).phase, guideRestart(s).index], ['intro', 0])
})

test('狀態機：沒有任何要做的項目（全部不支援）→ intro 直接到 summary，後退回 intro；只有 1 項時第 1 項就是最後一項', () => {
  const none = createGuide(planGuide(['midi'].map(inter), () => ({ status: 'unsupported', msg: 'x' })))
  assert.deepEqual(none.steps, []); assert.deepEqual(none.skipped, ['midi'])
  const s = guideNext(none); assert.equal(s.phase, 'summary'); assert.equal(guideBack(s).phase, 'intro'); assert.equal(guideGoto(none, 0), none)
  assert.deepEqual(guideProgress(none), { phase: 'intro', n: 0, total: 0, pct: 100 })
  const one = guideNext(createGuide(planGuide([inter('cam')])))
  assert.equal(guideIsLast(one), true); assert.equal(guideNext(one).phase, 'summary')
  assert.equal(guideNext(createGuide(null)).phase, 'summary'); assert.equal(createGuide(undefined).phase, 'intro')
})

test('進度「第 n / N 項」與進度條：intro = 0；第 k 項 = k；summary = N', () => {
  let g = createGuide(planGuide(['narration', 'watchdog', 'gesture', 'cam'].map(inter)))
  assert.deepEqual(guideProgress(g), { phase: 'intro', n: 0, total: 4, pct: 0 })
  g = guideNext(g); assert.deepEqual(guideProgress(g), { phase: 'step', n: 1, total: 4, pct: 25 })
  g = guideNext(g); g = guideNext(g); assert.deepEqual(guideProgress(g), { phase: 'step', n: 3, total: 4, pct: 75 })
  g = guideNext(guideNext(g)); assert.deepEqual(guideProgress(g), { phase: 'summary', n: 4, total: 4, pct: 100 })
})

test('完成統計：通過（含資訊）/ 失敗 / 不支援 / 略過各幾項；沒結果與待操作（還在等回答）算「未完成」；總數 = 各項相加', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  const results = { a: { status: 'pass' }, b: { status: 'info' }, c: { status: 'fail' }, d: { status: 'unsupported' }, e: { status: 'skipped' }, f: { status: 'needs-action' } }
  const st = guideStats(ids, results)
  assert.deepEqual(st, { total: 8, pass: 2, fail: 1, unsupported: 1, skipped: 1, pending: 3 })
  assert.equal(st.pass + st.fail + st.unsupported + st.skipped + st.pending, st.total)
  assert.deepEqual(guideStats([], {}), { total: 0, pass: 0, fail: 0, unsupported: 0, skipped: 0, pending: 0 })
  assert.deepEqual(guideStats(['x'], null), { total: 1, pass: 0, fail: 0, unsupported: 0, skipped: 0, pending: 1 })
  assert.deepEqual(guideStats(null, {}), { total: 0, pass: 0, fail: 0, unsupported: 0, skipped: 0, pending: 0 })
  for (const [r, b] of [[null, 'pending'], [undefined, 'pending'], [{ status: 'weird' }, 'pending'], [{ status: 'pass' }, 'pass'], [{ status: 'skipped' }, 'skipped']]) assert.equal(bucketOf(r), b)
})

test('?guided=1 直接進導引：有出現就開（?guided、?guided=1、true），?guided=0 / false / off / no 或沒帶 → 關；壞輸入不丟例外', () => {
  for (const q of ['?diagnostics=1&guided=1', '?guided', '?guided=true', '?guided=yes', '&guided=1']) assert.equal(wantsGuided(q), true, q)
  for (const q of ['?diagnostics=1', '', '?guided=0', '?guided=false', '?guided=OFF', '?guided=no', null, undefined]) assert.equal(wantsGuided(q), false, String(q))
})
