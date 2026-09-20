// 診斷頁「依序帶我做完互動檢查」導引模式的純邏輯（排序 / 依裝置能力略過 / 前進後退 / 統計）。node 可測，不碰瀏覽器 API、不碰畫面。
//   流程：intro（快速檢查摘要 + 裝置備註）→ step 0 … step N-1（一次一項）→ summary（總結 + 複製 / 下載）。
//   plan：{ order, steps, skipped }
//     order    所有互動檢查（依 GUIDE_ORDER 排序）
//     steps    要做的（這台裝置有這個能力）
//     skipped  依裝置能力略過的 [{ id, outcome }]（outcome = { status:'unsupported', msg }，畫面把它記成「不支援」並註明原因）
//   狀態：{ steps, skipped, phase:'intro'|'step'|'summary', index }（不可變：每個函式回傳新物件）
import { flagOn } from './urlFlags.js'

// 導引順序：先驗旁白、看門狗、相機手勢（展前優先），再相機 / 麥克風 / 語音辨識，最後是需要外接硬體或桌面才有的項目。
// 註冊表裡沒列出的互動檢查（日後新增）會排在最後，不會漏掉。
export const GUIDE_ORDER = ['narration', 'watchdog', 'gesture', 'cam', 'mic', 'speech', 'vibrate', 'screens', 'popup', 'fullscreen', 'midi', 'gamepad', 'rumble', 'pointer', 'orient']

// 互動檢查 → 導引順序（非互動的丟掉；沒列在 GUIDE_ORDER 的維持原本順序排在最後）
export function orderSteps(checks) {
  const list = Array.from(checks || []).filter((c) => c && c.kind === 'interactive')
  const rank = (id) => { const i = GUIDE_ORDER.indexOf(id); return i < 0 ? GUIDE_ORDER.length : i }
  return list.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c.id) - rank(b.c.id) || a.i - b.i).map((x) => x.c)
}

// skipFor(id) → null（這台裝置可以做）或 { status:'unsupported', msg }（不能做的原因）。丟例外 → 當作可以做（讓使用者自己按按鈕看結果）。
export function planGuide(checks, skipFor = () => null) {
  const order = orderSteps(checks).map((c) => c.id)
  const steps = [], skipped = []
  for (const id of order) {
    let out = null
    try { out = skipFor(id) } catch (e) { out = null }
    if (out && typeof out === 'object') skipped.push({ id, outcome: out }); else steps.push(id)
  }
  return { order, steps, skipped }
}

export function createGuide(plan) {
  const p = plan || {}
  return { steps: Array.from(p.steps || []), skipped: Array.from(p.skipped || []).map((s) => s.id), phase: 'intro', index: 0 }
}

const lastIndex = (g) => Math.max(0, g.steps.length - 1)

// 前進：intro → 第 1 項 → … → 最後一項 → summary（沒有任何要做的項目時 intro 直接到 summary）
export function guideNext(g) {
  if (g.phase === 'intro') return g.steps.length ? { ...g, phase: 'step', index: 0 } : { ...g, phase: 'summary' }
  if (g.phase === 'step') return g.index + 1 < g.steps.length ? { ...g, index: g.index + 1 } : { ...g, phase: 'summary' }
  return g
}
// 後退：summary → 最後一項 → … → 第 1 項 → intro
export function guideBack(g) {
  if (g.phase === 'summary') return g.steps.length ? { ...g, phase: 'step', index: lastIndex(g) } : { ...g, phase: 'intro' }
  if (g.phase === 'step') return g.index > 0 ? { ...g, index: g.index - 1 } : { ...g, phase: 'intro', index: 0 }
  return g
}
export function guideGoto(g, i) {
  if (!g.steps.length) return g
  const n = Number.isFinite(i) ? Math.max(0, Math.min(g.steps.length - 1, Math.floor(i))) : 0
  return { ...g, phase: 'step', index: n }
}
export const guideRestart = (g) => ({ ...g, phase: 'intro', index: 0 })
export const guideCurrent = (g) => (g.phase === 'step' ? g.steps[g.index] || null : null)
export const guideIsLast = (g) => g.phase === 'step' && g.index === g.steps.length - 1

// 頂部進度「第 n / N 項」與進度條（0..100）：intro → n = 0；summary → n = N
export function guideProgress(g) {
  const total = g.steps.length
  const n = g.phase === 'intro' ? 0 : g.phase === 'summary' ? total : g.index + 1
  return { phase: g.phase, n, total, pct: total ? Math.round((n / total) * 100) : 100 }
}

// 結果 → 統計桶。有結果的都只算一次：pass / info → pass；fail；unsupported；skipped；其餘（沒結果 / 待操作 = 還在等使用者回答）→ pending。
export function bucketOf(result) {
  const st = result && result.status
  if (st === 'pass' || st === 'info') return 'pass'
  if (st === 'fail') return 'fail'
  if (st === 'unsupported') return 'unsupported'
  if (st === 'skipped') return 'skipped'
  return 'pending'
}

// 一整輪的統計：ids = plan.order（含被略過的）；results：id → 結果（含使用者判斷）。total = pass + fail + unsupported + skipped + pending。
export function guideStats(ids, results) {
  const s = { total: 0, pass: 0, fail: 0, unsupported: 0, skipped: 0, pending: 0 }
  for (const id of Array.from(ids || [])) { s.total++; s[bucketOf(results && results[id])]++ }
  return s
}

// 「?guided=1」直接進導引；其他值（?guided=0 / false / off / no）/ 沒帶 → false。與主畫面其他網址旗標同一套規則（urlFlags.flagOn）。
export const wantsGuided = (search) => flagOn(search, 'guided')
