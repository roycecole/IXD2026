// 資料導覽的「接線」（非 React，Node 可測）：把 lib/tour.js 的執行器接上真實的 store / 時鐘 / 活動時間戳 / DOM 事件。
// TourService.jsx 只是把這裡的函式放進 useEffect。
//   · tourRunner：唯一的執行器（用 useStore、activity.last、performance.now）
//   · tourIdleTick()：App 主迴圈在「閒置 30 秒且沒有錄製 / 播放」時每幀呼叫，決定要不要自動開始
//   · toggleTour() / startTour() / stopTour()：鍵盤 T、面板按鈕用
//   · attachTourGuards()：長駐掛鉤（見該函式）；attachRunningGuards()：導覽進行中的 capture 監聽
// 中斷的原則：「使用者的第一個動作要落在還原後的海上」——
//   DOM 事件（pointerdown / keydown）用 capture 監聽先中止再往下傳；
//   非 DOM 輸入（MIDI / 語音 / 手機遙控 / 手把 / 手勢 / 滾輪）都會先呼叫 activity.touch()，touch 的同步掛鉤（onActivity）在動作「之前」中止導覽並還原。
//   100ms 輪詢（TourService）只是保險網。
import { useStore } from '../store/useStore.js'
import { activity, touch, onActivity } from '../store/activity.js'
import { stats } from '../store/stats.js'
import { LS, saveLS } from '../lib/persist.js'
import { arState } from '../lib/ar.js'
import { createTourRunner, buildTour, useTourStore } from '../lib/tour.js'
import { inspectStore } from '../lib/inspect.js'

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
  if (tourRunner.start({ auto: true })) {
    try { inspectStore.close() } catch (e) { /* 資料卡開著（游標停在卡上不會自動關）就開始換海況、換字幕，兩者會打架：導覽接手前先收掉 */ }
    return 'started'
  }
  if (tourRunner.lastFail === 'empty') { emptyGov = gov; return 'nodata' }
  return 'wait'
}

// 這些按鍵不算「操作海」：H 演出模式 / I 資訊面板 / ? 說明 / T 導覽開關 / 修飾鍵與 Tab
export const KEEP_KEYS = new Set(['t', 'T', 'h', 'H', 'i', 'I', '?', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab'])
// 點到這些元件不算「操作海」、不中斷導覽：導覽自己的卡片 / 字幕、語言切換（切語言時字幕要跟著換、導覽繼續）、
// 分享 / 分享星球 / 錄影（要擷取「此刻看到的海」，不能先被還原）、資訊面板 / 說明 / 聲音 / 匯出 LOG、離開演出模式。
// （TopBar 按鈕以 data-k 辨識；找不到對應元素時只是退化成「點了就中斷導覽」。）
export const KEEP_SELECTOR = '[data-tour-ui], .stage-exit, [data-k="lang"], [data-k="share"], [data-k="shareimg"], [data-k="capture"], [data-k="overlays"], [data-k="help"], [data-k="audio"], [data-k="log"]'
export const inKeepUi = (e) => { const el = e && e.target; return !!(el && el.closest && el.closest(KEEP_SELECTOR)) }

// 導覽進行中：碰螢幕 / 按鍵 → 立刻結束並還原（capture：先於任何處理器，使用者的動作會落在還原後的狀態上）。導覽自己的卡片與上面列出的非操作性按鈕不算。
export function attachRunningGuards(win, runner = tourRunner) {
  const onDown = (e) => { if (!inKeepUi(e)) runner.stop('input') }
  const onKey = (e) => {
    if (e.key === 'Escape') { runner.stop('user'); return }
    if (KEEP_KEYS.has(e.key) || e.ctrlKey || e.metaKey || e.altKey || inKeepUi(e)) return
    runner.stop('input')
  }
  win.addEventListener('pointerdown', onDown, true)
  win.addEventListener('keydown', onKey, true)
  return () => { win.removeEventListener('pointerdown', onDown, true); win.removeEventListener('keydown', onKey, true) }
}

// 長駐掛鉤（TourService 掛載時一次；卸載時全部拆掉並結束進行中的導覽）：
//   ① 活動掛鉤：任何 touch()（MIDI / 語音 / 遙控 / 手把 / 手勢 / 滾輪 / 走帶鍵…）→ 導覽同步中止並還原，動作再往下做。
//   ② 隱藏：分頁被隱藏 / 最小化 / 被完全蓋住 / 離開頁面 → 中止並還原。導覽的計時器（setInterval）在背景仍會跑（約每秒一次），
//      但資料播放靠 requestAnimationFrame——背景時它停了——所以導覽會照時間換站、換字幕，畫面上的海卻沒有動（投影機上的觀眾視窗只看得到靜止的海配上不斷更換的說明）。
//   ③ 閒置計時：導覽「沒在跑」時，點擊 / 按鍵 / 滾輪 / 資料播放或錄製結束 都算一次活動——
//      否則只按面板、關彈窗、看資料卡、播完自己的序列的人會在 30 秒後被導覽接手（剛關掉說明視窗 0.5 秒內就開始換海）。
//      導覽進行中不在這裡處理（由 attachRunningGuards 與上面的掛鉤負責，否則會把導覽自己的按鈕誤判成輸入）。
export function attachTourGuards({ win, doc, runner = tourRunner, store = useStore, touchFn = touch, hook = onActivity } = {}) {
  const offHook = hook(() => { if (runner.isRunning()) runner.stop('input') })

  const onHide = () => { if (runner.isRunning()) runner.stop('hidden') }
  const onVis = () => { if (doc && doc.hidden) onHide() }
  win.addEventListener('pagehide', onHide)
  if (doc) doc.addEventListener('visibilitychange', onVis)

  const onAct = () => { if (!runner.isRunning()) touchFn() }
  const ACT = ['pointerdown', 'keydown', 'wheel']
  for (const ev of ACT) win.addEventListener(ev, onAct, { capture: true, passive: true })   // passive：只是記時間，不擋捲動 / 滾輪（移除時 capture 旗標相同即可）

  const offStore = store.subscribe((s, prev) => {
    if (s.rec.mode === prev.rec.mode || s.rec.mode !== 'idle') return   // 只看「回到 idle」：播放 / 錄製結束的那一刻（不是每幀）
    if (!runner.isActive()) touchFn()                                    // 導覽自己的播放結束不算（否則會在導覽中觸發 base 比較而自己中止）
  })

  return function detach() {
    offHook(); offStore()
    win.removeEventListener('pagehide', onHide)
    if (doc) doc.removeEventListener('visibilitychange', onVis)
    for (const ev of ACT) win.removeEventListener(ev, onAct, true)
    onHide()   // 卸載：結束並還原（導覽中的參數不該被主迴圈寫進使用者的偏好）
  }
}
