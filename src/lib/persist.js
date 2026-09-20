// localStorage（跨 session 持久）+ sessionStorage（本 session）統一存取，全部包 try/catch。
export const LS = {
  bindings: 'ixd2026.bindings',   // MIDI 綁定
  params: 'ixd2026.params',       // 目前參數（視覺狀態）
  sizes: 'ixd2026.sizes',         // 面板 / 監看尺寸
  recording: 'ixd2026.recording', // 上次錄製
  markers: 'ixd2026.markers',     // Marker 場景快照（實體 Marker 鍵存的參數組）
  stats: 'ixd2026.stats',         // 展場統計（掃碼人數 / 演出次數）
  surveyLink: 'ixd2026.surveyLink', // 鳥 / 魚數量是否連動調查資料
  board: 'ixd2026.board',         // （舊）資料看板顯示開關，遷移到 overlays
  overlays: 'ixd2026.overlays',   // 畫布上的資訊面板顯示開關 { board, hud, qr }
  audio: 'ixd2026.audio',         // 聲音偏好：'off' = 使用者靜音過，不再自動開啟
  lang: 'ixd2026.lang',           // 語系：'zh' | 'en'（沒存過 → 依瀏覽器語言）
  tour: 'ixd2026.tour',           // 資料導覽偏好：{ auto: boolean }（閒置自動導覽；沒存過 → 預設，?kiosk=1 一律開）
  seen: 'ixd2026.seen',           // 「來過了」：值 '1'。首次到訪以今天真實的海開場、舊使用者不被新手導覽打擾都靠它（App 載入 ocean.json 時讀；lib/onboarding.js 完成 / 略過導覽時寫）
  onboarded: 'ixd2026.onboarded', // 新手導覽（一步一步）完成或略過：值 '1'。與 seen 成對寫入（見 lib/onboarding.js）
  crashes: 'ixd2026.crashes',     // 展場防呆：崩潰紀錄（環狀最近 20 筆：時間 / 訊息 / stack 前 300 字 / build id / 網址旗標；見 lib/resilience.js）
  monitor: 'ixd2026.monitor',     // 輸入輸出監看（系統事件）顯示偏好：'show' | 'hide'（沒存過 → 桌面顯示 / 手機隱藏；?log=1 / ?log=0 只覆寫一次、不寫入）
  tourplan: 'ixd2026.tourplan',   // 導覽腳本（導覽員自訂的站序與每站備註；見 lib/tourPlan.js）
  view: 'ixd2026.view',           // 取景偏好：'full'（完整含光暈）| 'fill'（球填滿寬度）；?fit=full|fill|0 只覆寫一次（見 lib/cameraFit.js）
  diagnote: 'ixd2026.diagnote',   // 裝置診斷頁的「裝置備註」草稿（選填：型號 / 作業系統 / 瀏覽器 / 備註；只在使用者按複製 / 下載時才進報告）
  oplight: 'ixd2026.oplight',     // 展場角落防呆指示燈顯示偏好：'on' | 'off'（沒存過 → 展場模式顯示、一般不顯示；?oplight=1/0 只覆寫一次）
  wavenav: 'ixd2026.wavenav',     // 相機手勢「揮手換站」開關：'on' | 'off'（沒存過 → 預設開；見 services/GestureService.jsx）
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
