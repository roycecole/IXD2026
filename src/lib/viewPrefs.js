// 取景偏好（「裝置」面板的「取景」一節與 Scene3D 的 CameraRig 共用）：完整（含光暈）/ 填滿（球填滿寬度）。
// 純函式 + 一個很小的訂閱式狀態；不依賴 React / three / DOM（所有瀏覽器 API 以參數注入，測試用假物件），可用 node 直接測。
//
// 優先序：網址 ?fit=  >  偏好（localStorage LS.view）  >  預設 'full'
//   ?fit=full | 1  → 這一次用「完整」；?fit=fill → 這一次用「填滿」；?fit=0 / false / off / no → 關閉自動取景（除錯用，倍率恆為 1）。
//   其他值 / 沒有這個參數 → 沒有覆寫（自動取景照常開，模式取偏好）。網址只覆寫「這一次」，永遠不寫入偏好；
//   使用者在面板選一個模式 = 明確的選擇：立刻生效、存成偏好、並解除網址的 full / fill 覆寫（?fit=0 是除錯開關，維持關閉，選擇只存成偏好）。
// 倍率的算法在 lib/cameraFit.js（fitScale 的 mode 參數）；這裡只決定「用哪個模式」。
import { LS, loadLS, saveLS } from './persist.js'
import { fitEnabled, fitScale, aspectOf, FIT_MODES, DEFAULT_FIT_MODE } from './cameraFit.js'

export const VIEW_MODES = FIT_MODES            // ['full', 'fill']
export const DEFAULT_VIEW = DEFAULT_FIT_MODE   // 'full'
export const isViewMode = (v) => v === 'full' || v === 'fill'

// 解析網址的 ?fit=。回傳 { off, mode, param }：
//   off：?fit=0 / false / off / no（不分大小寫）→ true；mode：'full' | 'fill' | null（沒指定）；param：面板要顯示的參數值（已限定在白名單內，可安全顯示）。
// 「關閉」的判斷與 cameraFit.fitEnabled 是同一份（不會各說各話）。永不丟例外。
export function parseFitParam(search) {
  const none = { off: false, mode: null, param: null }
  try {
    const raw = new URLSearchParams(search || '').get('fit')
    if (raw === null) return none
    if (!fitEnabled(search)) return { off: true, mode: null, param: String(raw).toLowerCase() }
    if (/^fill$/i.test(raw)) return { off: false, mode: 'fill', param: 'fill' }
    if (/^full$/i.test(raw)) return { off: false, mode: 'full', param: 'full' }
    if (raw === '1') return { off: false, mode: 'full', param: '1' }
    return none
  } catch (e) { return none }
}

// 讀偏好：非法值 / 沒存過 / load 丟例外 → 預設（'full'）。load 可注入（預設 loadLS，本身已包 try/catch）。
export function readViewPref(load = loadLS) {
  try { const v = load(LS.view, null); return isViewMode(v) ? v : DEFAULT_VIEW } catch (e) { return DEFAULT_VIEW }
}

// 存偏好：回傳「有沒有送出寫入」（非法值 → false；save 丟例外 → false）。storage 被擋（隱私模式）時 saveLS 自己吞掉例外，偏好只是這次不保留。
export function saveViewPref(mode, save = saveLS) {
  if (!isViewMode(mode)) return false
  try { save(LS.view, mode); return true } catch (e) { return false }
}

// 網址 + 偏好 → 目前生效的取景。
// { mode 生效的模式, pref 偏好, enabled 自動取景是否開著（?fit=0 → false）, override 'full' | 'fill' | 'off' | null（網址覆寫）, param 網址參數值（顯示用） }
export function resolveView({ search, pref } = {}) {
  const u = parseFitParam(search)
  const p = isViewMode(pref) ? pref : DEFAULT_VIEW
  return { mode: u.mode || p, pref: p, enabled: !u.off, override: u.off ? 'off' : u.mode, param: u.param }
}

// 「兩種取景在這個長寬比下有差別嗎」：長寬比 >= 約 0.95（桌面 / 橫式）兩者都是 1 → false；量不到長寬比 → null。
export function viewMattersAt(aspect) {
  if (!(typeof aspect === 'number' && Number.isFinite(aspect) && aspect > 0)) return null
  return fitScale({ aspect, mode: 'full' }) !== fitScale({ aspect, mode: 'fill' })
}

// 訂閱式狀態（React 端用 useSyncExternalStore(view.subscribe, view.get, view.get)）。search / load / save 可注入（測試用）。
// get() 回傳不可變的快照；沒有變化時是同一個物件（useSyncExternalStore 需要）。
//   { mode, pref, enabled, override, param, affects }
//   affects：目前畫布的長寬比下兩種取景是否不同（null = 還沒量到畫布 / ?fit=0 時為 false）。
// setMode(m)：使用者的選擇 → 立即生效 + 存偏好 + 解除網址 full / fill 覆寫；回傳是否接受（非法值 → false，狀態不變）。
// setCanvas(w, h)：CameraRig 每幀呼叫；只有「兩種取景有沒有差別」改變時才通知訂閱者（拖曳分隔線不會每幀重繪面板）。
export function createViewState({ search, load, save } = {}) {
  const q = search !== undefined ? search : (typeof location !== 'undefined' ? location.search : '')
  const r = resolveView({ search: q, pref: readViewPref(load) })
  let pref = r.pref, urlMode = r.override === 'full' || r.override === 'fill' ? r.override : null
  const off = r.override === 'off', param = r.param
  let matters = null, lastW = -1, lastH = -1
  const subs = new Set()
  const build = () => Object.freeze({
    mode: urlMode || pref, pref, enabled: !off, override: off ? 'off' : urlMode, param,
    affects: off ? false : matters,
  })
  let snap = build()
  const emit = () => {
    snap = build()
    for (const cb of Array.from(subs)) { try { cb() } catch (e) { /* 一個訂閱者壞了不影響其他人 */ } }
  }
  return {
    get: () => snap,
    subscribe(cb) { subs.add(cb); return () => { subs.delete(cb) } },
    setMode(m) {
      if (!isViewMode(m)) return false
      const changed = pref !== m || urlMode !== null
      pref = m; urlMode = null
      saveViewPref(m, save)
      if (changed) emit()
      return true
    },
    setCanvas(width, height) {
      if (width === lastW && height === lastH) return
      lastW = width; lastH = height
      const m = viewMattersAt(aspectOf(width, height))
      if (m !== matters) { matters = m; emit() }
    },
  }
}

// 全站共用的那一份（Scene3D 的 CameraRig 與 ViewSection 讀同一個）：第一次用到才建立——import 時不碰 location / localStorage。
let shared = null
export function getViewState() { return shared || (shared = createViewState()) }
