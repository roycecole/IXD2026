import { PARAMS } from '../params/registry.js'

// 參數 HUD：input() 呼叫 setHud，畫面角落淡入「參數名 值」再淡出（非反應式，由 HUD 元件以 rAF 讀取）
export const hudState = { label: '', value: 0, t: -9999 }
export function setHud(pid, value) {
  const m = PARAMS[pid]
  if (!m) return
  hudState.label = m.label
  hudState.value = value
  try { hudState.t = performance.now() } catch (e) { hudState.t = 0 }
}
