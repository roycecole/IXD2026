// 相機手勢「揮手換站」開關的偏好：記住使用者的選擇（LS.wavenav：'on' | 'off'；沒存過 / 壞值 → 預設開）。
// 純函式：storage 以參數注入（{ getItem, setItem }，測試傳假物件），不依賴 React / zustand / hands.js；import 時不碰任何瀏覽器 API。
// 注意（瀏覽器專屬）：storage.getItem / setItem 一律以「方法」呼叫，不存進變數再脫離原物件呼叫（會丟 TypeError: Illegal invocation，Node 不會）。
// 存進 localStorage 的是 JSON 字串（'"off"'，與其他偏好一致），讀的時候也容忍裸字串（'off'）。
//
// 用法（services/GestureService.jsx 掛載時 hydrateWavePref、ui/devices/GestureSection.jsx 切換時 saveWavePref）：
//   · 揮手換站只在「相機手勢已啟用」且「資料導覽進行中」才有作用（這裡不改變這件事）；這裡只管「開關的預設值要不要記住」。
//   · 存過才套用：沒存過 / 讀不到 / 壞值 = 不動目前的狀態（hands.js 的預設就是開）。
import { LS } from './persist.js'

export const WAVE_DEFAULT = true   // 沒存過 → 開

// 讀出「存過的選擇」：'on' | 'off'；沒存過 / 壞值 / storage 不能用 / 丟例外 → null（呼叫者退回預設）
export function readWavePref(storage) {
  try {
    if (!storage) return null
    let v = storage.getItem(LS.wavenav)
    if (typeof v !== 'string') return null
    v = v.trim()
    try { v = JSON.parse(v) } catch (e) { /* 裸字串（on / off）照原樣比對 */ }
    return v === 'on' || v === 'off' ? v : null
  } catch (e) { return null }
}

// 揮手換站要不要開：存過 'off' → false；其他（沒存過 / 存 'on' / 壞值 / storage 丟例外）→ 預設 true
export function loadWavePref(storage) {
  return readWavePref(storage) !== 'off'
}

// 存下使用者的選擇。回傳「有沒有送出寫入」：storage 不能用 / setItem 丟例外（隱私模式、額度滿）→ false（這次仍然生效，只是重新整理後不保留）
export function saveWavePref(storage, on) {
  try {
    if (!storage) return false
    storage.setItem(LS.wavenav, JSON.stringify(on ? 'on' : 'off'))
    return true
  } catch (e) { return false }
}

// 現在的 localStorage（呼叫當下才取；被擋 / 沒有 → null）。回傳的是 storage 物件本身，呼叫端以方法呼叫它。
export function defaultWaveStorage() {
  try { return globalThis.localStorage || null } catch (e) { return null }
}

// 啟動時把「存過的選擇」套進手勢狀態（useHandsStore：{ getState, setState }）。可重複呼叫（React StrictMode 的 effect 會跑兩次）。
// 只有「存過、且和目前狀態不同」才寫入；回傳有沒有改動。沒存過就完全不動（不會把預設值寫進 localStorage）。
export function hydrateWavePref(store, storage = defaultWaveStorage()) {
  try {
    const saved = readWavePref(storage)
    if (saved === null) return false
    const on = saved === 'on'
    if ((store.getState().waveNav !== false) === on) return false
    store.setState({ waveNav: on, wave: null })   // 與 hands.js 的 setWaveNav 相同：切換時清掉最近一次的揮手顯示
    return true
  } catch (e) { return false }
}
