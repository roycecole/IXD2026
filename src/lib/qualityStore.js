// 自動畫質的共用狀態（zustand）：目前的模式 / 等級 / FPS / 上次自動降級的原因。
// 誰寫：QualityService（狀態機換級、每秒回報 FPS）與 QualitySection（使用者選模式）。誰讀：Scene3D（等級 → dpr / 數量）、QualitySection。
// 偏好存 localStorage 'ixd2026.quality'（見 lib/quality.js）；網址 ?quality= 是本次覆寫，不寫入偏好。
import { create } from 'zustand'
import { readPrefs, writePrefs, initialTier, parseQueryMode, normalizeMode, isAudienceQuery, MODES } from './quality.js'
import { registerMirror } from './mirror.js'

// 工廠：storage / search 可注入（測試用假物件；預設用 localStorage 與 location.search）
// persist：是否把模式 / 等級寫進偏好。預設 true；觀眾視窗（?audience=1）預設 false——它和主視窗共用同一份 localStorage，
// 各自量到的 FPS 不同（投影機 vs 筆電），互相覆寫會讓「重新開啟」時繼承到對方的降級；觀眾視窗仍會「讀」偏好當起跳等級。
export function createQualityStore({ storage, search, persist: persistOpt } = {}) {
  const query = search !== undefined ? search : (typeof location !== 'undefined' ? location.search : '')
  const prefs = readPrefs(storage)
  const q = parseQueryMode(query)
  const writes = persistOpt !== undefined ? !!persistOpt : !isAudienceQuery(query)
  const mode = q || prefs.mode
  const persist = (s) => { if (!q && writes) writePrefs({ mode: s.mode, tier: s.tier }, storage) }
  return create((set, get) => ({
    mode,                                          // 使用者選的：'auto' | 'high' | 'medium' | 'low'
    tier: initialTier({ mode, tier: prefs.tier }), // 目前實際生效的等級：'high' | 'medium' | 'low'
    fps: null,                                     // 目前 FPS（每秒更新；null = 量不到，例如暫停或分頁在背景）
    paused: false,                                 // 自動調整暫停中（拖曳 / 錄影 / 背景分頁）
    reason: null,                                  // 上次「自動降級」：{ at(Date.now), from, to, fps, windowMs, threshold }
    overridden: !!q,                               // 目前的模式來自網址 ?quality=
    setMode(m) {
      const next = normalizeMode(m)
      set((s) => ({ mode: next, tier: next === 'auto' ? s.tier : next, overridden: false }))
      if (writes) writePrefs({ mode: next, tier: get().tier }, storage)
    },
    // 狀態機換級的回呼（info.kind = 'down' | 'up' | 'manual'）
    applyChange(tier, info) {
      const s = get()
      if (info && info.kind === 'down') {
        set({ tier, reason: { at: Date.now(), from: info.from, to: info.to, fps: info.fps, windowMs: info.windowMs, threshold: info.threshold } })
      } else if (s.tier !== tier) set({ tier })
      else return
      persist(get())
    },
    report({ fps, paused }) {
      const s = get()
      if (s.fps !== fps || s.paused !== paused) set({ fps, paused })
    },
  }))
}

export const useQualityStore = createQualityStore()

// 鏡像切片：主視窗的畫質「模式」（auto / high / medium / low）送到觀眾視窗——
// 操作員在「裝置 → 畫質」手動選了一級（例如選「低」保護筆電），已經開著的觀眾視窗也要跟著；改回自動，觀眾視窗就改用自己的 FPS 自動調整。
// 只送模式、不送等級：自動模式下各視窗的等級由自己量到的 FPS 決定（投影機與筆電螢幕的負擔不同）。
// apply 直接改這個視窗的 store（不走 setMode，不寫共用偏好——觀眾視窗的 store 本來也不寫，見 createQualityStore 的 persist）；
// 觀眾視窗的 qualityRuntime 訂閱了 mode，會通知它的狀態機（鎖定 / 由目前等級接手）。
export function createQualityMirror(store) {
  return {
    get: () => ({ mode: store.getState().mode }),
    apply: (v) => {
      if (!v || typeof v !== 'object' || !MODES.includes(v.mode)) return
      const s = store.getState()
      if (s.mode === v.mode) return
      store.setState({ mode: v.mode, tier: v.mode === 'auto' ? s.tier : v.mode, overridden: true })
    },
    subscribe: (cb) => store.subscribe((s, prev) => { if (s.mode !== prev.mode) cb() }),
  }
}
registerMirror('quality', createQualityMirror(useQualityStore))
