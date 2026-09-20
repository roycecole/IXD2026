// 自動畫質的共用狀態（zustand）：目前的模式 / 等級 / FPS / 上次自動降級的原因。
// 誰寫：QualityService（狀態機換級、每秒回報 FPS）與 QualitySection（使用者選模式）。誰讀：Scene3D（等級 → dpr / 數量）、QualitySection。
// 偏好存 localStorage 'ixd2026.quality'（見 lib/quality.js）；網址 ?quality= 是本次覆寫，不寫入偏好。
import { create } from 'zustand'
import { readPrefs, writePrefs, initialTier, parseQueryMode, normalizeMode } from './quality.js'

// 工廠：storage / search 可注入（測試用假物件；預設用 localStorage 與 location.search）
export function createQualityStore({ storage, search } = {}) {
  const prefs = readPrefs(storage)
  const q = parseQueryMode(search !== undefined ? search : (typeof location !== 'undefined' ? location.search : ''))
  const mode = q || prefs.mode
  const persist = (s) => { if (!q) writePrefs({ mode: s.mode, tier: s.tier }, storage) }
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
      writePrefs({ mode: next, tier: get().tier }, storage)
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
