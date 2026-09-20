// 裝置診斷「最近一次摘要」的讀寫（localStorage 鍵 'ixd2026.diag'）與相關小工具。
// 獨立成一個很小的檔案：主畫面「裝置」面板的一節（ui/devices/DiagnosticsSection.jsx）只需要這幾個函式，
// 不該為了顯示「上次診斷」就把整個診斷邏輯（lib/diagnostics.js）拉進主 bundle。
// 儲存介面可注入（測試用）；預設走 persist.js（全部包 try/catch：隱私模式 / 額度滿都不會丟例外）。
import { loadLS, saveLS } from './persist.js'

export const DIAG_LS_KEY = 'ixd2026.diag'   // { at, pass, fail, unsupported, pending, total }：最近一次診斷的摘要（不含任何裝置資訊）

const defaultStorage = { get: (k) => loadLS(k, null), set: (k, v) => saveLS(k, v) }
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null)

// 檢查讀回來的資料：任何欄位不合格 → null（當作「沒有摘要」），不會讓壞資料把面板弄壞
export function sanitizeSummary(v) {
  if (!v || typeof v !== 'object') return null
  const at = typeof v.at === 'number' && Number.isFinite(v.at) && v.at > 0 ? v.at : null
  const pass = count(v.pass), fail = count(v.fail)
  if (at == null || pass == null || fail == null) return null
  return { at, pass, fail, unsupported: count(v.unsupported) || 0, pending: count(v.pending) || 0, total: count(v.total) || 0 }
}

export function loadSummary(storage = defaultStorage) {
  try { return sanitizeSummary(storage.get(DIAG_LS_KEY)) } catch (e) { return null }
}

// summary：{ pass, fail, unsupported, pending, total }（見 lib/diagnostics.js 的 summarize）。回傳實際存下的物件；存取失敗回 null。
export function saveSummary(summary, now = Date.now(), storage = defaultStorage) {
  const s = sanitizeSummary({ at: now, ...(summary || {}) })
  if (!s) return null
  try { storage.set(DIAG_LS_KEY, s); return s } catch (e) { return null }
}

// 「2026/9/20 下午2:30」之類的區域化短格式；Intl 失敗就退回 ISO。tag：'zh-TW' / 'en-US'。
export function formatWhen(at, tag = 'zh-TW') {
  try {
    const d = new Date(at)
    if (Number.isNaN(d.getTime())) return ''
    try { return d.toLocaleString(tag, { dateStyle: 'medium', timeStyle: 'short' }) } catch (e) { return d.toISOString() }
  } catch (e) { return '' }
}

// 「開啟裝置診斷」連結：以目前語系開新分頁（診斷頁的語系偏好只存在 localStorage，?lang= 讓新分頁一開始就跟目前的介面一致）
export function diagnosticsHref(locale) {
  return '?diagnostics=1' + (locale === 'en' || locale === 'zh' ? '&lang=' + locale : '')
}
