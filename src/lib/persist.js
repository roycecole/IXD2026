// localStorage（跨 session 持久）+ sessionStorage（本 session）統一存取，全部包 try/catch。
export const LS = {
  bindings: 'ixd2026.bindings',   // MIDI 綁定
  params: 'ixd2026.params',       // 目前參數（視覺狀態）
  sizes: 'ixd2026.sizes',         // 面板 / 監看尺寸
  recording: 'ixd2026.recording', // 上次錄製
  markers: 'ixd2026.markers',     // Marker 場景快照（實體 Marker 鍵存的參數組）
  stats: 'ixd2026.stats',         // 展場統計（掃碼人數 / 演出次數）
}
export const SS = {
  log: 'ixd2026.log',             // IN/OUT log（本 session）
}

export function loadLS(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback } catch (e) { return fallback }
}
export function saveLS(key, val) { try { localStorage.setItem(key, JSON.stringify(val)) } catch (e) {} }
export function removeLS(key) { try { localStorage.removeItem(key) } catch (e) {} }
export function loadSS(key, fallback) {
  try { const v = sessionStorage.getItem(key); return v ? JSON.parse(v) : fallback } catch (e) { return fallback }
}
export function saveSS(key, val) { try { sessionStorage.setItem(key, JSON.stringify(val)) } catch (e) {} }
