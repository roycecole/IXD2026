// 版面偏好：畫面下方「輸入輸出監看（IN 演奏者 / OUT 系統事件）」要不要顯示。
//   預設：桌面（寬度 > 820px）顯示；手機（≤ 820px）隱藏。使用者自己切換過 → 記住（localStorage 存 'show' | 'hide'）。
//   網址覆寫 ?log=1 / ?log=0：只影響這一次載入，不寫偏好（比照 ?hud=0）；優先序：網址 > 使用者偏好 > 依寬度的預設。
//   沒有任何偏好、沒有網址覆寫時（source = 'default'），視窗跨過 820px 會跟著自動顯示 / 隱藏（與 CSS 的手機版面斷點一致）；
//   使用者一旦手動切換（或用了網址覆寫），就不再自動跟隨。
// 純函式（可用 node 測）與「以可注入環境建立的 zustand store」分開：測試傳假 storage / 假 window，瀏覽器用 browserEnv()。
// 注意（瀏覽器專屬）：storage.getItem / matchMedia 都以「方法」呼叫，不把原生函式存起來再脫離原物件呼叫（會丟 Illegal invocation）。
import { create } from 'zustand'
import { LS } from './persist.js'

export const NARROW_MAX = 820                    // 與 styles.css 的手機版面斷點一致（max-width: 820px）
export const MONITOR_ID = 'monitor-region'       // Monitor 區塊的 DOM id（切換鈕的 aria-controls 指向它）
export const MONITOR_TOGGLE_ID = 'footer-monitor-toggle'   // Footer 切換鈕的 DOM id（從 Monitor 內按「隱藏」後把焦點移過去）

// ---------- 純函式 ----------

// 依視窗寬度的預設：> 820 顯示；≤ 820 隱藏；量不到寬度（SSR / 測試 / 寬度為 0 的隱藏 iframe）→ 桌面預設（顯示）
export function defaultMonitorShown(width) {
  const w = Number(width)
  if (!Number.isFinite(w) || w <= 0) return true
  return w > NARROW_MAX
}

// 偏好值正規化：只接受 'show' | 'hide'。存進 localStorage 的是 JSON 字串（'"show"'，與其他偏好一致），也容忍裸字串；壞值 → null
export function normalizePref(v) {
  let x = v
  if (typeof x === 'string') {
    const s = x.trim()
    try { x = JSON.parse(s) } catch (e) { x = s }
  }
  return x === 'show' || x === 'hide' ? x : null
}

export function readMonitorPref(storage) {
  try { return storage ? normalizePref(storage.getItem(LS.monitor)) : null } catch (e) { return null }
}
export function writeMonitorPref(storage, pref) {
  if (pref !== 'show' && pref !== 'hide') return false
  try { if (!storage) return false; storage.setItem(LS.monitor, JSON.stringify(pref)); return true } catch (e) { return false }
}

// ?log=1 → true；?log=0 → false；沒有這個參數 / 看不懂的值 → null（不覆寫）。
// 開：1 / true / on / yes / show / 空值（?log、?log=）；關：0 / false / off / no / hide（不分大小寫）
export function parseLogParam(search) {
  let v
  try { v = new URLSearchParams(search || '').get('log') } catch (e) { return null }
  if (v === null) return null
  const s = v.trim().toLowerCase()
  if (s === '' || /^(1|true|on|yes|show)$/.test(s)) return true
  if (/^(0|false|off|no|hide)$/.test(s)) return false
  return null
}

// 決定「一開始」要不要顯示：網址 > 使用者偏好 > 依寬度預設。source 告訴呼叫者是哪一層決定的（'url' | 'saved' | 'default'）
export function resolveMonitorShown({ width, saved, search } = {}) {
  const url = parseLogParam(search)
  if (url !== null) return { shown: url, source: 'url' }
  const pref = normalizePref(saved)
  if (pref) return { shown: pref === 'show', source: 'saved' }
  return { shown: defaultMonitorShown(width), source: 'default' }
}

// Footer「最新一則 OUT 系統事件」：從日誌（舊 → 新）挑最後一則 dir === 'out' 且有內容的文字（收斂空白）；沒有 → null
export function pickLatestOut(log) {
  if (!Array.isArray(log)) return null
  for (let i = log.length - 1; i >= 0; i--) {
    const l = log[i]
    if (l && l.dir === 'out' && typeof l.text === 'string') {
      const s = l.text.replace(/\s+/g, ' ').trim()
      if (s) return s
    }
  }
  return null
}

// 資料播放每一步寫一行的 OUT 事件（App.jsx：'DATA ' + formatHud(…)）：高頻（空氣品質 0.2 秒一步），不該進 aria-live 朗讀佇列
export function isDataLine(text) { return typeof text === 'string' && /^DATA\s/.test(text) }

// 節流：距離「上次更新」還要等多久才能更新下一次（毫秒，最小 0）。Footer 那一行是 aria-live，事件很密時不要每則都朗讀 / 重繪
export function throttleDelay(lastAt, now, ms) {
  const d = Number(lastAt) + Number(ms) - Number(now)
  return Number.isFinite(d) ? Math.max(0, d) : 0
}

// 監看視窗是否跨過手機斷點。回傳取消函式；訂閱當下會先呼叫一次 cb(目前是否為窄螢幕)（補上「store 建立後到掛載前」寬度可能已變的落差）。
// 優先用 matchMedia 的 change（只在跨過斷點時觸發）；沒有 matchMedia 才退回 resize（也只在窄 / 寬翻轉時才呼叫 cb）。
export function watchNarrowViewport(win, cb, max = NARROW_MAX) {
  if (!win || typeof cb !== 'function') return () => {}
  try {
    if (typeof win.matchMedia === 'function') {
      const mql = win.matchMedia(`(max-width: ${max}px)`)
      if (mql) {
        const on = () => cb(!!mql.matches)
        if (typeof mql.addEventListener === 'function') {
          mql.addEventListener('change', on)
          on()
          return () => { try { mql.removeEventListener('change', on) } catch (e) {} }
        }
        if (typeof mql.addListener === 'function') {   // 舊版 Safari（< 14）
          mql.addListener(on)
          on()
          return () => { try { mql.removeListener(on) } catch (e) {} }
        }
      }
    }
  } catch (e) { /* 退回 resize */ }
  if (typeof win.addEventListener !== 'function') return () => {}
  const narrow = () => { const w = Number(win.innerWidth); return Number.isFinite(w) && w > 0 && w <= max }
  let last = narrow()
  const on = () => { const n = narrow(); if (n !== last) { last = n; cb(n) } }
  win.addEventListener('resize', on)
  cb(last)
  return () => { try { win.removeEventListener('resize', on) } catch (e) {} }
}

// ---------- store ----------

// env = { width, search, getStorage }：測試傳假的；瀏覽器見 browserEnv()。getStorage 可能丟例外（隱私模式存取 localStorage 會丟 SecurityError）→ 一律視為沒有 storage。
export function createLayoutPrefs(env = {}) {
  const getStorage = () => { try { return typeof env.getStorage === 'function' ? env.getStorage() : null } catch (e) { return null } }
  const init = resolveMonitorShown({ width: env.width, saved: readMonitorPref(getStorage()), search: env.search })
  return create((set, get) => ({
    monitorShown: init.shown,
    monitorSource: init.source,                   // 'url' | 'saved' | 'default'
    // 使用者主動切換：寫偏好（storage 不可用就只在本次工作階段有效），之後不再自動跟隨視窗寬度
    setMonitorShown: (show) => {
      const v = !!show
      writeMonitorPref(getStorage(), v ? 'show' : 'hide')
      set({ monitorShown: v, monitorSource: 'saved' })
    },
    toggleMonitor: () => get().setMonitorShown(!get().monitorShown),
    // 視窗跨過手機斷點：只有「沒偏好也沒網址覆寫」時才跟著變
    setNarrow: (narrow) => {
      if (get().monitorSource !== 'default') return
      const shown = !narrow
      if (shown !== get().monitorShown) set({ monitorShown: shown })
    },
  }))
}

function browserEnv() {
  const w = typeof window !== 'undefined' ? window : null
  let search = ''
  try { if (w) search = w.location.search } catch (e) {}
  let width = null
  try { if (w) width = w.innerWidth } catch (e) {}
  return { width, search, getStorage: () => { try { return w ? w.localStorage : null } catch (e) { return null } } }
}

export const useLayoutPrefs = createLayoutPrefs(browserEnv())
