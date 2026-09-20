// 常駐服務：TourService＝資料導覽（由 App 掛載一次，不渲染畫面）。
// 導覽的邏輯在 src/lib/tour.js（純函式 + 可注入的執行器）；這裡把它接上真實的 store / 時鐘 / DOM 事件：
//   · tourRunner：唯一的執行器（用 useStore、activity.last、performance.now）
//   · tourIdleTick()：App 主迴圈在「閒置 30 秒且沒有錄製 / 播放」時每幀呼叫，決定要不要自動開始（取代舊的色相輪播吸引模式）
//   · toggleTour() / startTour() / stopTour()：鍵盤 T、面板按鈕用
//   · 導覽進行中：每 100ms 偵測中斷 / 換站（節流輪詢，停止即清除）；capture 階段的 pointerdown / keydown 讓「使用者的第一個動作」
//     發生在「已還原」的狀態上（先還原、再讓事件往下傳）；離開頁面 / 卸載時一律結束並還原。
// 觀眾視窗（remote）不跑導覽：字幕由 lib/tour.js 註冊的 mirror 切片送過來。
import { useEffect } from 'react'
import { useStore } from '../store/useStore.js'
import { activity, touch } from '../store/activity.js'
import { stats } from '../store/stats.js'
import { LS, saveLS } from '../lib/persist.js'
import { arState } from '../lib/ar.js'
import { createTourRunner, buildTour, useTourStore } from '../lib/tour.js'

export const tourRunner = createTourRunner({
  store: useStore,
  // AR 實景開著時背景的月亮與河川測站星座都不會畫（見 Scene3D 的 MoonSky / StationStars）→ 略過這兩站，免得字幕在講看不到的東西
  build: (gov, opts) => buildTour(gov, { ...opts, skip: arState.on ? ['moon', 'stations'] : [] }),
  getActivity: () => activity.last,
  touch,
  now: () => performance.now(),
  // startPlayback 會把「演出次數」+1（展場角落的統計）；導覽不是使用者的演出，扣回去，否則展場循環導覽會一直灌水
  afterPlay: () => { stats.plays = Math.max(0, (stats.plays || 0) - 1); saveLS(LS.stats, stats) },
})

export const startTour = () => tourRunner.start({ auto: false })
export const stopTour = (reason = 'user') => tourRunner.stop(reason)
export function toggleTour() {
  if (tourRunner.isRunning()) { tourRunner.stop('user'); return false }
  return tourRunner.start({ auto: false })
}

// 有彈窗（說明 / 裝置 / 多人）開著時不自動開始：使用者正在讀，背景的海不該自己動
let modalAt = -1e9, modalOpen = false
function anyModalOpen(now) {
  if (now - modalAt > 500) {
    modalAt = now
    try { modalOpen = !!document.querySelector('.modal-backdrop') } catch (e) { modalOpen = false }
  }
  return modalOpen
}

let emptyGov = null   // 上次建不出任何一站的資料快照（同一份資料不必每幀重試）

// 回傳給 App 主迴圈：
//   'started' / 'running'：導覽進行中（App 不要再做別的）· 'wait'：暫不啟動（彈窗開著等）· 'off'：使用者關閉了閒置自動導覽 / 這是觀眾視窗
//   'nodata'：沒有可導覽的資料 → App 退回舊的「輪播色相場景」吸引模式
export function tourIdleTick(now = performance.now()) {
  const ts = useTourStore.getState()
  if (ts.remote) return 'off'
  if (tourRunner.isRunning()) return 'running'
  if (!ts.autoIdle) return 'off'
  const gov = useStore.getState().gov
  if (!gov || !Array.isArray(gov.options) || !gov.options.length || emptyGov === gov) return 'nodata'
  if (anyModalOpen(now)) return 'wait'
  if (tourRunner.start({ auto: true })) return 'started'
  if (tourRunner.lastFail === 'empty') { emptyGov = gov; return 'nodata' }
  return 'wait'
}

// 這些按鍵不算「操作海」：H 演出模式 / I 資訊面板 / ? 說明 / T 導覽開關 / 修飾鍵與 Tab
const KEEP_KEYS = new Set(['t', 'T', 'h', 'H', 'i', 'I', '?', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab'])
// 點到這些元件不算「操作海」、不中斷導覽：導覽自己的卡片 / 字幕、語言切換（切語言時字幕要跟著換、導覽繼續）、
// 分享 / 分享星球 / 錄影（要擷取「此刻看到的海」，不能先被還原）、資訊面板 / 說明 / 聲音 / 匯出 LOG、離開演出模式。
// （TopBar 按鈕以 data-k 辨識；找不到對應元素時只是退化成「點了就中斷導覽」。）
const KEEP_SELECTOR = '[data-tour-ui], .stage-exit, [data-k="lang"], [data-k="share"], [data-k="shareimg"], [data-k="capture"], [data-k="overlays"], [data-k="help"], [data-k="audio"], [data-k="log"]'
const inKeepUi = (e) => { const el = e.target; return !!(el && el.closest && el.closest(KEEP_SELECTOR)) }

export default function TourService() {
  const running = useTourStore((s) => s.running)

  // 導覽進行中：輪詢中斷 / 換站（100ms；停止就清掉）
  useEffect(() => {
    if (!running) return
    const iv = setInterval(() => tourRunner.tick(performance.now()), 100)
    return () => clearInterval(iv)
  }, [running])

  // 導覽進行中：碰螢幕 / 按鍵 → 立刻結束並還原（capture：先於任何處理器，使用者的動作會落在還原後的狀態上）。導覽自己的卡片與上面列出的非操作性按鈕不算。
  useEffect(() => {
    if (!running) return
    const onDown = (e) => { if (!inKeepUi(e)) tourRunner.stop('input') }
    const onKey = (e) => {
      if (e.key === 'Escape') { tourRunner.stop('user'); return }
      if (KEEP_KEYS.has(e.key) || e.ctrlKey || e.metaKey || e.altKey || inKeepUi(e)) return
      tourRunner.stop('input')
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey, true) }
  }, [running])

  // 離開頁面 / 卸載：結束並還原（導覽中的參數不該被主迴圈寫進使用者的偏好）
  useEffect(() => {
    const onHide = () => { if (tourRunner.isRunning()) tourRunner.stop('hidden') }
    window.addEventListener('pagehide', onHide)
    return () => { window.removeEventListener('pagehide', onHide); onHide() }
  }, [])

  return null
}
