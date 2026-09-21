// 資料導覽的「接線」（非 React，Node 可測）：把 lib/tour.js 的執行器接上真實的 store / 時鐘 / 活動時間戳 / DOM 事件。
// TourService.jsx 只是把這裡的函式放進 useEffect。
//   · tourRunner：唯一的執行器（用 useStore、activity.last、performance.now）
//   · tourIdleTick()：App 主迴圈在「閒置 30 秒且沒有錄製 / 播放」時每幀呼叫，決定要不要自動開始（彈窗開著、或正在腳本編輯器的文字欄位打字 → 'wait'）
//   · toggleTour() / startTour() / stopTour()：鍵盤 T、面板按鈕用
//   · attachTourGuards()：長駐掛鉤（見該函式）；attachRunningGuards()：導覽進行中的 capture 監聽（含導覽員快速鍵 ← → P）
//   · linkStarter（createLinkStarter）：網址帶 ?tourstop= 時，資料載入後只啟動一次導覽（見該函式）
//   · copyTourLink()：「複製此站連結」（TourNav 的按鈕用；有導覽腳本時連結會帶著腳本，收到的人看到同一份站序與備註）
//   · armNarrationUnlock()：TourService 掛載時，旁白偏好已開但 iOS 尚未解鎖 → 註冊「第一次使用者手勢」解鎖（見 lib/narration.js 契約）
// 導覽腳本（lib/tourPlan.js）：tourRunner 的 build 在「每次組站表時」讀 useTourStore.plan——閒置自動 / 手動 / 導覽員（?tourstop=）三種啟動方式一視同仁，
//   自動導覽循環回第 0 站重建站表時也用當下生效的腳本。?tourstop=<站 id / 序號> 以「腳本內的站」為準（runner.start 的 at 是對 build 出來的站表解析的；不在腳本內 → 第 0 站）。
// 中斷的原則：「使用者的第一個動作要落在還原後的海上」——
//   DOM 事件（pointerdown / keydown）用 capture 監聽先中止再往下傳；
//   非 DOM 輸入（MIDI / 語音 / 手機遙控 / 手把 / 手勢 / 滾輪）都會先呼叫 activity.touch()，touch 的同步掛鉤（onActivity）在動作「之前」中止導覽並還原。
//   100ms 輪詢（TourService）只是保險網。
import { useStore } from '../store/useStore.js'
import { activity, touch, touchGuide, onActivity } from '../store/activity.js'
import { stats } from '../store/stats.js'
import { LS, saveLS } from '../lib/persist.js'
import { arState } from '../lib/ar.js'
import { createTourRunner, buildTour, useTourStore, isAudienceSearch } from '../lib/tour.js'
import { narrator as sharedNarrator } from '../lib/narration.js'
import { inspectStore } from '../lib/inspect.js'
import { isInModal } from '../lib/modalFocus.js'
import { parseTourLink, buildTourLink, copyText } from '../lib/tourLink.js'
import { buildPlanLink } from '../lib/tourPlan.js'
import { t, getLocale } from '../i18n/index.js'

// 目前生效的導覽腳本（網址 ?tour= 帶的 > 已存的啟用腳本 > 沒有）；呼叫端（start 的 opts）明確給 plan（含 null）時以呼叫端為準
const activePlan = () => { try { return useTourStore.getState().plan || undefined } catch (e) { return undefined } }

export const tourRunner = createTourRunner({
  store: useStore,
  // AR 實景開著時背景的月亮與河川測站星座都不會畫（見 Scene3D 的 MoonSky / StationStars）→ 略過這兩站，免得字幕在講看不到的東西（腳本列了這兩站也一樣略過）
  build: (gov, opts) => buildTour(gov, { plan: activePlan(), ...opts, skip: arState.on ? ['moon', 'stations'] : [] }),
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

// 導覽腳本編輯器（TourPlanEditor：在面板的導覽卡裡、不是彈窗，所以 anyModalOpen 看不到它）的備註 / 名稱欄位有焦點、而且還沒閒置太久 → 暫不自動開始：
// 導覽一開始編輯器就唯讀（fieldset disabled），寫到一半被打斷；動筆寫備註的人停下來想 30 秒很正常，不該在這時把整個介面搶走。
// 只認「可輸入文字、非唯讀、非停用」的欄位，且在 [data-tour-ui] 內（編輯器的欄位都在裡面；滑桿 / 勾選框 / 下拉、「複製連結」備援的唯讀欄位都不算——
// 調過滑桿後焦點會留在上面，那不是在打字，不能因此擋住自動導覽）。焦點可能忘在欄位上（人走開了）：所以只延後 TYPING_GRACE_MS（從最後一次輸入起算），
// 超過就照常自動導覽——展場 / 吸引模式不能被一個忘記的焦點永遠擋住。
export const TYPING_GRACE_MS = 2 * 60 * 1000
const TEXT_INPUT_TYPE = /^(text|search|url|tel|email)$/
export function typingInEditor() {
  try {
    const el = typeof document !== 'undefined' ? document.activeElement : null
    if (!el || el.readOnly || el.disabled) return false
    const tag = el.tagName || ''
    if (!(tag === 'TEXTAREA' || (tag === 'INPUT' && TEXT_INPUT_TYPE.test(String(el.type || 'text').toLowerCase())))) return false
    return !!(typeof el.closest === 'function' && el.closest('[data-tour-ui]'))
  } catch (e) { return false }
}

// 上次建不出任何一站的「資料快照 + 導覽腳本 + AR 狀態」（同一組條件不必每幀重試）：站表取決於這三樣——腳本改了（編輯器套用）或 AR 開關變了，就要重新嘗試，不能一直回 nodata
let emptyGov = null, emptyPlan
let emptyAr = false

// 回傳給 App 主迴圈：
//   'started' / 'running'：導覽進行中（App 不要再做別的）· 'wait'：暫不啟動（彈窗開著、或正在腳本編輯器打字，等）· 'off'：使用者關閉了閒置自動導覽 / 這是觀眾視窗
//   'nodata'：沒有可導覽的資料 → App 退回舊的「輪播色相場景」吸引模式
export function tourIdleTick(now = performance.now()) {
  const ts = useTourStore.getState()
  if (ts.remote) return 'off'
  if (tourRunner.isRunning()) return 'running'
  if (!ts.autoIdle) return 'off'
  const gov = useStore.getState().gov
  if (!gov || !Array.isArray(gov.options) || !gov.options.length) return 'nodata'
  if (emptyGov === gov && emptyPlan === activePlan() && emptyAr === arState.on) return 'nodata'
  if (anyModalOpen(now)) return 'wait'
  if (typingInEditor() && now - activity.last < TYPING_GRACE_MS) return 'wait'   // 正在腳本編輯器打字（停頓一下想想不算閒置）；久沒動就不擋（見 TYPING_GRACE_MS）
  if (tourRunner.start({ auto: true })) {
    try { inspectStore.close() } catch (e) { /* 資料卡開著（游標停在卡上不會自動關）就開始換海況、換字幕，兩者會打架：導覽接手前先收掉 */ }
    return 'started'
  }
  if (tourRunner.lastFail === 'empty') { emptyGov = gov; emptyPlan = activePlan(); emptyAr = arState.on; return 'nodata' }
  return 'wait'
}

// 這些按鍵不算「操作海」：H 演出模式 / I 資訊面板 / L 系統事件面板 / G 導覽員 QR（KioskQR，講解者把手機連上來）/ ? 說明 / T 導覽開關 / 導覽員快速鍵（← 上一站、→ 下一站、P 暫停 / 繼續）/ 修飾鍵與 Tab
export const KEEP_KEYS = new Set(['t', 'T', 'h', 'H', 'i', 'I', 'l', 'L', 'g', 'G', '?', 'ArrowLeft', 'ArrowRight', 'p', 'P', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab'])
// 點到這些元件不算「操作海」、不中斷導覽：導覽自己的卡片 / 字幕、語言切換（切語言時字幕要跟著換、導覽繼續）、
// 分享 / 分享星球 / 錄影（要擷取「此刻看到的海」，不能先被還原）、資訊面板 / 說明 / 聲音 / 匯出 LOG、離開演出模式。
// （TopBar 按鈕以 data-k 辨識；找不到對應元素時只是退化成「點了就中斷導覽」。）
export const KEEP_SELECTOR = '[data-tour-ui], .stage-exit, [data-k="lang"], [data-k="share"], [data-k="shareimg"], [data-k="capture"], [data-k="overlays"], [data-k="help"], [data-k="audio"], [data-k="log"]'
export const inKeepUi = (e) => { const el = e && e.target; return !!(el && el.closest && el.closest(KEEP_SELECTOR)) }

// 導覽員快速鍵（只在導覽進行中；本函式是純判斷，可在 Node 測）：← 上一站、→ 下一站、P 暫停 / 繼續。
//   忽略：ctrl / meta / alt 組合、輸入法組字中、輸入元件（文字 / 數字 / 滑桿類 INPUT、TEXTAREA、SELECT、contenteditable；checkbox / 按鈕類 INPUT 不算——
//   點過面板導覽卡的 checkbox 後焦點會留在上面，快速鍵不能因此失效）與滑桿類元件（role="slider" 等，
//   例如虛擬控制器的旋鈕用方向鍵調值——那是在「操作海」，交給該元件，導覽會被它的 input 中止）、彈窗開著且焦點在裡面（isInModal，與 App 的全域快速鍵同一個判斷）。
const NAV_KEYS = new Map([['ArrowLeft', 'prev'], ['ArrowRight', 'next'], ['p', 'toggle'], ['P', 'toggle']])
const TYPING_ROLE = /^(slider|textbox|spinbutton|combobox|listbox|searchbox)$/
const NON_TYPING_INPUT = /^(checkbox|button|submit|reset|image)$/   // 這些 type 不吃文字、也不用方向鍵調值（radio / range / number 會用方向鍵，仍算輸入元件）
export function isTypingTarget(el) {
  if (!el) return false
  try {
    const tag = el.tagName || ''
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return !(tag === 'INPUT' && NON_TYPING_INPUT.test(String(el.type || '').toLowerCase()))
    if (el.isContentEditable) return true
    return TYPING_ROLE.test((typeof el.getAttribute === 'function' && el.getAttribute('role')) || '')
  } catch (e) { return false }
}
export function navKeyAction(e) {
  if (!e || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return null
  const act = NAV_KEYS.get(e.key)
  if (!act) return null
  if (isTypingTarget(e.target) || isInModal(e.target)) return null
  return act
}

// 導覽進行中：碰螢幕 / 按鍵 → 立刻結束並還原（capture：先於任何處理器，使用者的動作會落在還原後的狀態上）。導覽自己的卡片與上面列出的非操作性按鈕不算。
// 例外：導覽員快速鍵 ← → P（navKeyAction）——換站 / 暫停，不中止；處理時 preventDefault（不要捲動面板），按住不放不連續跳站。Esc 仍是結束。
// 導覽員的操作（快速鍵、點導覽卡 / 進度點 / 字幕卡按鈕等 KEEP 元件）不是「操作海」，但要讓展場防呆知道「有人在場講解」：
//   呼叫 guide()（預設 touchGuide：只記 activity.guideAt，不跑活動掛鉤、不動 activity.last），版本更新 / 每日重載 60 秒內不會在講解到一半時重載頁面。
export function attachRunningGuards(win, runner = tourRunner, guide = touchGuide) {
  const note = () => { try { guide() } catch (e) { /* 記錄失敗不影響導覽 */ } }
  const onDown = (e) => { if (inKeepUi(e)) note(); else runner.stop('input') }
  const onKey = (e) => {
    if (e.key === 'Escape') { runner.stop('user'); return }
    const nav = navKeyAction(e)
    if (nav) {
      if (typeof e.preventDefault === 'function') e.preventDefault()
      note()
      if (e.repeat) return
      if (nav === 'prev') runner.prev()
      else if (nav === 'next') runner.next()
      else if (runner.isPaused()) runner.resume()
      else runner.pause()
      return
    }
    if (inKeepUi(e)) { note(); return }                       // 在導覽卡 / 字幕卡的按鈕上按 Enter / 空白
    if (KEEP_KEYS.has(e.key) || e.ctrlKey || e.metaKey || e.altKey) return
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

// ---------------------------------------------------------------------------------------------
// 每站連結（深連結）
// ---------------------------------------------------------------------------------------------
const safeSearch = () => { try { return typeof location !== 'undefined' ? location.search : '' } catch (e) { return '' } }
const safeHref = () => { try { return typeof location !== 'undefined' ? location.href : '' } catch (e) { return '' } }

// 網址帶 ?tourstop=（與選帶的 ?tourhold=1）→ 海況資料載入後，「只執行一次」runner.start({ auto:false, at, hold })。
//   · 等 gov 有 options 才動；再延後 delayMs：App 在 setGov 之後、同一個 tick 內還要套用首次到訪 / 分享連結的參數，導覽要在那之後才記「導覽前」的狀態
//   · 只有一次：done 旗標在「試過一次」（成功 / 失敗 / 不適用）時就立起，StrictMode 雙掛載、HMR 重新掛載都不會再啟動；start 失敗（例如正在錄製）就放棄，不重試
//   · 觀眾視窗（remote / ?audience）不跑導覽 → 直接放棄
//   · 分頁在背景（Ctrl / Cmd + 點擊連結、載入途中被切走）時不啟動，等分頁變可見（visibilitychange）才排程：
//     背景分頁的 rAF 不跑（資料播放不前進）、100ms 輪詢卻照時間換站，切回來時已不是連結指的那一站，甚至整輪已結束；仍然只啟動一次
//   · attach() 回傳取消函式（unmount 時退訂 + 清計時器 + 移除 visibilitychange 監聽）；重複 attach 安全。
// 計時器以「裸函式包一層」呼叫（原生 setTimeout 掛在別的物件上再呼叫會丟 Illegal invocation）。
export const LINK_START_DELAY_MS = 400
export function createLinkStarter({
  runner = tourRunner, store = useStore, tourStore = useTourStore, getSearch = safeSearch, delayMs = LINK_START_DELAY_MS,
  schedule = (fn, ms) => setTimeout(fn, ms), cancel = (id) => clearTimeout(id),
  doc = typeof document !== 'undefined' ? document : null,
} = {}) {
  let done = false
  let timer = null
  const govReady = () => { const g = store.getState().gov; return !!(g && Array.isArray(g.options) && g.options.length) }
  const visible = () => { try { return !doc || !doc.hidden } catch (e) { return true } }
  function fire() {
    timer = null
    if (done) return
    if (!visible()) return                                  // 排程後、觸發前被切到背景：不算「試過」，等分頁可見再排一次
    done = true
    const link = parseTourLink(getSearch())
    if (!link) return
    try { runner.start({ auto: false, at: link.stop.id != null ? link.stop.id : link.stop.index, hold: link.hold }) } catch (e) { /* 起不來就放棄 */ }
  }
  function attach() {
    if (done) return () => {}
    const search = getSearch()
    if (!parseTourLink(search) || tourStore.getState().remote || isAudienceSearch(search)) { done = true; return () => {} }
    const check = () => { if (done || timer !== null || !govReady() || !visible()) return; timer = schedule(fire, delayMs) }
    const off = store.subscribe((s, prev) => { if (s.gov !== prev.gov) check() })
    const onVis = () => { if (visible()) check() }
    const hasDoc = !!doc && typeof doc.addEventListener === 'function'
    if (hasDoc) doc.addEventListener('visibilitychange', onVis)
    check()
    return () => { off(); if (hasDoc) doc.removeEventListener('visibilitychange', onVis); if (timer !== null) { cancel(timer); timer = null } }
  }
  return { attach, isDone: () => done }
}
export const linkStarter = createLinkStarter()

// 「複製此站連結」：連結指向「目前這一站」（暫停中就帶 tourhold=1：收到連結的人也停在那一站）。
// 回傳 'ok' | 'fail' | 'none'（導覽沒在跑 → 沒有站可指）。成功 / 失敗都寫一行 OUT 日誌。
export async function copyTourLink({ tourStore = useTourStore, store = useStore, getHref = safeHref, env } = {}) {
  const s = tourStore.getState()
  const stop = s.running && Array.isArray(s.stopList) ? s.stopList[s.index] : null
  if (!stop) return 'none'
  const n = s.index + 1
  // 有導覽腳本：連結帶著腳本（站序 + 備註 + 名稱），收到的人開啟後看到同一份腳本、直接到這一站；備註太長放不進網址時只帶站序（並在日誌說明）
  const built = s.plan ? buildPlanLink({ href: getHref(), plan: s.plan, stopId: stop.id, hold: !!s.paused, locale: getLocale() }) : null
  const link = built ? built.url : buildTourLink({ href: getHref(), stopId: stop.id, hold: !!s.paused, locale: getLocale() })
  let ok = false
  if (link) { try { ok = await copyText(link, env) } catch (e) { ok = false } }
  const st = store.getState()
  if (st.pushLog) st.pushLog('out', ok ? (built && built.truncated ? t('已複製第 {n} 站連結（備註太長，連結沒有帶備註）', { n }) : t('已複製第 {n} 站連結', { n })) : t('複製連結失敗：瀏覽器不允許存取剪貼簿'))
  return ok ? 'ok' : 'fail'
}

// 旁白的 iOS 解鎖（契約 C6，見 lib/narration.js）：旁白偏好已開（?speak=1 或存過偏好）、但這個頁面還沒成功念過 → 註冊一次性的「第一次使用者手勢」解鎖（無聲），
// 沒人碰過頁面就被導覽念字幕時 iOS 才不會把 speak() 靜靜吞掉。回傳取消函式（TourService 卸載 / StrictMode 重掛載時呼叫）；不需要解鎖 / 觀眾視窗 / 任何例外 → 回傳空函式。
// narrator 的方法一律以「方法呼叫」使用（不脫離原物件）。
export function armNarrationUnlock({ narrator = sharedNarrator, tourStore = useTourStore, win = typeof window !== 'undefined' ? window : undefined } = {}) {
  let off = null
  try {
    const s = tourStore.getState()
    if (s.speak && !s.remote && !narrator.isUnlocked()) off = narrator.unlockOnFirstGesture(win)
  } catch (e) { off = null }
  return () => {
    const f = off
    off = null
    try { if (typeof f === 'function') f() } catch (e) { /* 取消失敗無妨 */ }
  }
}
