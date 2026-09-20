// 新手導覽（一步一步的互動引導）的純邏輯——瀏覽器 API 一律以參數注入（win / doc / storage），Node 可測。
// UI 在 src/ui/Onboarding.jsx；這裡放：
//   · 步驟定義（STEPS：標題 / 內文用 T() 標記，顯示時才 t()；targets＝要高亮的元素，依序當作備援）
//   · 何時自動顯示（shouldAutoShow）與偏好存取（isFirstVisit / markDone）
//   · 幾何：可見矩形（visibleRectOf）、捲進視野（scrollTargetIntoView）、卡片定位（placeCard）
//   · 導航狀態機（createOnboarding：開始 / 上一步 / 下一步 / 略過 / 完成，可訂閱，給 useSyncExternalStore 用）
//
// 【存取順序（不能亂）】'ixd2026.seen' 是「首次到訪以今天真實的海開場」的判斷依據（App 載入 ocean.json 時讀它）。
//   引導「開始」時絕對不寫任何鍵；只有「完成 / 略過」才把 seen 與 onboarded 一起寫入。
//   App 在首次 render 就用 isFirstVisit() 把「這次進站是不是首次」記下來（不是等 ocean.json 載入完才讀），
//   所以即使使用者在資料載入前就按了略過，開場的海仍照首次到訪處理。
// 【瀏覽器坑】所有原生方法一律「以方法呼叫」（storage.getItem(k)、el.getBoundingClientRect()、win.getComputedStyle(el)），
//   不存成變數再脫離原物件呼叫（會 Illegal invocation）；測試用的假環境會檢查 this。
import { T } from '../i18n/index.js'
import { LS } from './persist.js'
import { flagOn } from './urlFlags.js'
import { hasTourLink } from './tourLink.js'

// ============================================================================================
// 步驟
// ============================================================================================
// targets：CSS 選擇器（依序嘗試，第一個「存在、看得到」的就是高亮目標；全部落空 → 置中卡片，不卡住、不報錯）。
// 選擇器對應的是現有元件的 class / data-k：.canvas-wrap（App）、.panel .group（ParamPanel：第一個是 OCEAN 滑桿群）、
// .gov-select / .gov-card（DataCard）、.tour-card（TourControls）、.toolstrip / [data-k=help]（TopBar）、.footer-help（Footer）。
export const STEPS = [
  { id: 'welcome', title: T('歡迎來到 MidiSea'), body: T('一顆裝著海的球，海況來自台灣政府開放資料。按「開始」，一步一步帶你玩。'), targets: [], nextLabel: T('開始') },
  { id: 'play', title: T('轉動與觸碰'), body: T('拖曳球體轉動，兩指或滾輪縮放；點一下亮起星星，雙擊進入全螢幕演出模式。'), targets: ['.canvas-wrap'] },
  { id: 'sea', title: T('調整海'), body: T('拖動滑桿（或轉 MIDI 旋鈕），改變海水高度、洋流與清澈度，球會立刻回應。'), targets: ['.panel .group', '.panel'] },
  { id: 'data', title: T('接上真實資料'), body: T('選一個資料，例如水庫、潮汐、月亮或揚塵，球就依真實資料變化；再按「▶ 播放」看它一天的起伏。'), targets: ['.gov-select', '.gov-card'] },
  { id: 'tour', title: T('資料導覽'), body: T('按 T 或「▶ 開始導覽」，球會自動巡演今日的水庫、潮汐、月亮、鳥與魚；碰一下就停止。'), targets: ['.tour-card', '.gov-card'] },
  { id: 'more', title: T('更多功能'), body: T('工具列還有分享、實景 AR、多人合奏、裝置、EN / 中文切換與說明。'), targets: ['.toolstrip', '.topbar'] },
  { id: 'done', title: T('準備好了'), body: T('隨時按「說明」看完整說明，也能在說明裡選「重新看新手導覽」。'), targets: ['[data-k="help"]', '.footer-help'], nextLabel: T('開始探索') },
]
export const NEXT_LABEL = T('下一步')   // 沒有指定 nextLabel 的步驟用這個

export const COMPACT_MAX = 520   // 視窗寬 ≤ 520px 視為手機：卡片改成貼底的 bottom sheet
export const isCompact = (vw) => vw <= COMPACT_MAX

// 進度：index 是 0 起算；n 是「第 n 步」
export function progressOf(index, total) {
  const i = Math.max(0, Math.min(total - 1, Math.round(Number(index) || 0)))
  return { n: i + 1, total, first: i === 0, last: i === total - 1, pct: total > 0 ? (i + 1) / total : 0 }
}

// ============================================================================================
// 何時自動顯示 + 偏好存取
// ============================================================================================
// ?onboard=1（或 ?onboard、=true…）→ 'on'；?onboard=0 / false / off / no → 'off'；沒帶 → null
export function onboardParam(search) {
  try {
    const v = new URLSearchParams(search || '').get('onboard')
    if (v === null) return null
    return /^(0|false|off|no)$/i.test(v) ? 'off' : 'on'
  } catch (e) { return null }
}
// #remote=<id>：手機遙控頁（與 main.jsx 的判斷一致，id 不能是空的）
export const isRemoteHash = (hash) => /^#remote=(.+)$/.test(String(hash || ''))

// storage 可以是 Storage 物件、回傳 Storage 的函式（存取 window.localStorage 本身就可能丟 SecurityError）、或 null
const safe = (f) => { try { return f() } catch (e) { return null } }
const storageOf = (x) => (typeof x === 'function' ? safe(x) : x || null)
const readKey = (s, key) => { try { return s ? s.getItem(key) : null } catch (e) { return null } }
const writeKey = (s, key, val) => { try { if (!s) return false; s.setItem(key, val); return true } catch (e) { return false } }

// 首次進站才自動顯示：
//   · ?onboard=0 → 永不顯示；#remote / ?audience / ?diagnostics（不同的頁面，沒有這些介面元素）→ 永不顯示（連 ?onboard=1 也不行）
//   · ?onboard=1 → 強制顯示（無視 seen / onboarded / ?kiosk）
//   · ?kiosk → 不顯示（展場整天開著，不能有卡片擋住）
//   · ?tourstop=… 導覽深連結 → 不顯示（收到連結的人要直接看到那一站）
//   · 已有 seen（舊使用者）或 onboarded → 不顯示
//   · localStorage 讀不到（隱私模式 / 被封鎖）→ 視為首次、照樣顯示（與過去自動彈出說明視窗的行為一致），但 sessionStorage 若記得「這個分頁已完成」就不再顯示
export function shouldAutoShow({ search = '', hash = '', local = null, session = null } = {}) {
  const flag = onboardParam(search)
  if (flag === 'off') return false
  if (isRemoteHash(hash) || flagOn(search, 'audience') || flagOn(search, 'diagnostics')) return false
  if (flag === 'on') return true
  if (flagOn(search, 'kiosk')) return false
  if (hasTourLink(search)) return false   // 別人分享的「導覽第 n 站」連結：直接看那一站，不要先擋一張新手卡（?onboard=1 仍可強制顯示）
  const l = storageOf(local), s = storageOf(session)
  return !(readKey(l, LS.seen) || readKey(l, LS.onboarded) || readKey(s, LS.onboarded))
}

// 這次進站是不是「首次到訪」（沒有 seen）。與過去 App 載入 ocean.json 時的判斷完全相同：讀不到 storage → false。
export function isFirstVisit(local = defaultLocal) {
  const s = storageOf(local)
  if (!s) return false
  try { return !s.getItem(LS.seen) } catch (e) { return false }
}

// 完成 / 略過：兩個鍵都寫（seen 讓舊邏輯——今天的海開場、不再打擾——也認得；onboarded 是新鍵）。
// localStorage 寫不進去 → 退而求其次寫 sessionStorage（同一個分頁重新整理不會再彈）。回傳實際寫成功的地方，方便測試。
export function markDone(local = defaultLocal, session = defaultSession) {
  const l = storageOf(local), s = storageOf(session)
  const seen = writeKey(l, LS.seen, '1')
  const onboarded = writeKey(l, LS.onboarded, '1')
  const sess = writeKey(s, LS.onboarded, '1')
  return { seen, onboarded, session: sess }
}

const defaultLocal = () => (typeof window !== 'undefined' ? window.localStorage : null)
const defaultSession = () => (typeof window !== 'undefined' ? window.sessionStorage : null)
const defaultEnv = () => (typeof location !== 'undefined' ? { search: location.search, hash: location.hash } : { search: '', hash: '' })

// ============================================================================================
// 鍵盤
// ============================================================================================
// → / Enter 下一步、← 上一步。（Esc = 略過與 Tab 圈選由 lib/modalFocus.js 的 attachModalFocus 處理，這裡不重複。）
// Enter 落在按鈕 / 連結上 → 交給原生（Enter 觸發該鈕，例如焦點在「略過」就是略過）；其餘（焦點在卡片本身）才算下一步。
export function keyToAction(e) {
  if (!e || e.ctrlKey || e.metaKey || e.altKey) return null
  if (e.key === 'ArrowRight') return 'next'
  if (e.key === 'ArrowLeft') return 'prev'
  if (e.key === 'Enter') return /^(BUTTON|A|SUMMARY|INPUT|SELECT|TEXTAREA)$/i.test((e.target && e.target.tagName) || '') ? null : 'next'
  return null
}

// ============================================================================================
// 幾何（矩形 = { left, top, width, height, right, bottom }）
// ============================================================================================
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
export function rectFrom(r) {
  const left = Number(r && r.left) || 0, top = Number(r && r.top) || 0, width = Number(r && r.width) || 0, height = Number(r && r.height) || 0
  return { left, top, width, height, right: left + width, bottom: top + height }
}
export function intersectRects(a, b) {
  if (!a || !b) return null
  const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top)
  const right = Math.min(a.left + a.width, b.left + b.width), bottom = Math.min(a.top + a.height, b.top + b.height)
  if (!(right > left && bottom > top)) return null
  return rectFrom({ left, top, width: right - left, height: bottom - top })
}
export const rectArea = (r) => (r ? Math.max(0, r.width) * Math.max(0, r.height) : 0)
export const overlapArea = (a, b) => rectArea(intersectRects(a, b))
// 往外推 pad，並限制在視窗內（聚光外框不要畫到畫面外）
export function padRect(r, pad, viewport) {
  const left = Math.max(0, r.left - pad), top = Math.max(0, r.top - pad)
  const right = Math.min(viewport.w, r.left + r.width + pad), bottom = Math.min(viewport.h, r.top + r.height + pad)
  return rectFrom({ left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) })
}
// 太小（< 6px）或不在視窗內的矩形不算「看得到」
export const isUsableRect = (r) => !!r && r.width >= 6 && r.height >= 6

// 把目標捲進「所在的可捲動容器」：目標已完整在容器（扣掉 pad）內 → 不動；比容器還高 / 寬 → 對齊起點；其餘 → 置中。回傳要加到 scrollTop / scrollLeft 的量。
export function scrollDelta1D(tStart, tEnd, cStart, cEnd, pad = 12) {
  if (tStart >= cStart + pad && tEnd <= cEnd - pad) return 0
  const room = (cEnd - cStart) - 2 * pad
  if (tEnd - tStart > room) return tStart - (cStart + pad)
  return (tStart + tEnd) / 2 - (cStart + cEnd) / 2
}

// 元素「實際看得到」的矩形：扣掉所有會裁切它的祖先（overflow 非 visible，例如捲動中的控制面板、橫向捲動的工具列）與視窗。
// 不存在 / 沒接在文件上 / display:none / visibility:hidden / 完全被裁掉 → null。
export function visibleRectOf(el, { win, doc, viewport }) {
  try {
    if (!el || el.isConnected === false) return null
    let r = rectFrom(el.getBoundingClientRect())
    if (!(r.width > 0 && r.height > 0)) return null
    const cs = win.getComputedStyle(el)
    if (cs && (cs.visibility === 'hidden' || cs.display === 'none')) return null
    for (let p = el.parentElement; p && p !== doc.body && p !== doc.documentElement; p = p.parentElement) {
      const s = win.getComputedStyle(p)
      if (s && /(auto|scroll|hidden|clip)/.test(`${s.overflow || ''} ${s.overflowX || ''} ${s.overflowY || ''}`)) {
        r = intersectRects(r, rectFrom(p.getBoundingClientRect()))
        if (!r) return null
      }
    }
    return intersectRects(r, rectFrom({ left: 0, top: 0, width: viewport.w, height: viewport.h }))
  } catch (e) { return null }
}

// 用「自己算 scrollTop」代替 el.scrollIntoView：scrollIntoView 會連 overflow:hidden 的外層（body / .app）一起捲，版面會被推歪。
// 只動「真的可以捲」的祖先（overflow auto / scroll 且內容比框大）。log：記下每個被動到的容器原本的位置，導覽結束時還原。
export function scrollTargetIntoView(el, { win, doc, log = null, pad = 12 } = {}) {
  try {
    if (!el || el.isConnected === false) return false
    let moved = false
    for (let p = el.parentElement; p && p !== doc.body && p !== doc.documentElement; p = p.parentElement) {
      const s = win.getComputedStyle(p)
      if (!s) continue
      const canY = /(auto|scroll)/.test(String(s.overflowY || s.overflow || '')) && p.scrollHeight > p.clientHeight + 1
      const canX = /(auto|scroll)/.test(String(s.overflowX || s.overflow || '')) && p.scrollWidth > p.clientWidth + 1
      if (!canY && !canX) continue
      const c = p.getBoundingClientRect(), t = el.getBoundingClientRect()
      const dy = canY ? scrollDelta1D(t.top, t.top + t.height, c.top, c.top + c.height, pad) : 0
      const dx = canX ? scrollDelta1D(t.left, t.left + t.width, c.left, c.left + c.width, pad) : 0
      if (!dy && !dx) continue
      if (log && !log.some((x) => x.el === p)) log.push({ el: p, top: p.scrollTop, left: p.scrollLeft })
      if (dy) p.scrollTop = p.scrollTop + dy
      if (dx) p.scrollLeft = p.scrollLeft + dx
      moved = true
    }
    return moved
  } catch (e) { return false }
}

// 依序嘗試 step.targets：第一個「存在且看得到」的元素勝出 → { el, rect, selector }；全部落空 → null（呼叫端改成置中卡片）。
// query(selector) → 元素或 null；prepare(el)（可選）在量測前先做「捲進視野」；getRect(el) → 可見矩形或 null。
export function resolveTarget(step, { query, prepare = null, getRect, viewport } = {}) {
  const list = (step && Array.isArray(step.targets)) ? step.targets : []
  for (const selector of list) {
    let el = null
    try { el = query(selector) } catch (e) { el = null }   // 選擇器寫壞了 / 文件不在 → 當作沒有
    if (!el) continue
    try { if (prepare) prepare(el) } catch (e) { /* 捲動失敗不影響定位 */ }
    let rect = null
    try { rect = getRect(el) } catch (e) { rect = null }
    if (isUsableRect(rect, viewport)) return { el, rect, selector }
  }
  return null
}

// ---- 卡片定位 --------------------------------------------------------------------------------
export const CARD_W = 320   // 桌面卡片寬：預設面板 340px + 分隔線 8px 的右側剛好放得下（貼著畫布右緣時不會壓到畫布）
export const cardWidthFor = (vw, compact = isCompact(vw)) => (compact ? Math.max(0, vw - 16) : Math.max(0, Math.min(CARD_W, vw - 24)))

// 回傳 { mode: 'center' | 'anchor' | 'sheet', side, left, top, width, height }
//   · 沒有目標（spot = null）→ 置中
//   · 手機（寬 ≤ 520）→ 貼底的 bottom sheet（side 'bottom'）；若貼底會蓋住目標（目標在畫面下半，例如控制面板的滑桿）→ 改貼頂（side 'top'）
//   · 桌面 → 貼著目標旁邊（右 / 左 / 下 / 上，寬扁的目標先試下 / 上），不超出視窗、盡量不蓋住目標；
//     四邊都放不下（目標超大，例如整個畫布）→ 挑「重疊最少、離理想位置最近」的位置，最後退到視窗內下 / 上緣
// spot：已加過外框 padding 的目標矩形；card：{ h } 量到的卡片高度（寬度固定，見 cardWidthFor）；viewport：{ w, h }
export function placeCard({ spot = null, card = {}, viewport, compact } = {}) {
  const vw = viewport.w, vh = viewport.h
  const cp = compact == null ? isCompact(vw) : !!compact
  const m = cp ? 8 : 12, gap = 14
  const w = cardWidthFor(vw, cp)
  const h = Math.max(0, Math.min(Number(card.h) > 0 ? Number(card.h) : 0, vh - 2 * m))
  const maxX = Math.max(m, vw - m - w), maxY = Math.max(m, vh - m - h)
  const box = (left, top) => rectFrom({ left: Math.round(left), top: Math.round(top), width: w, height: h })
  const out = (mode, side, r) => ({ mode, side, left: r.left, top: r.top, width: w, height: h })

  if (!spot) return out('center', 'center', box((vw - w) / 2, (vh - h) / 2))

  if (cp) {
    const bottom = box(m, vh - m - h), top = box(m, m)
    const a = rectArea(spot) || 1
    const ob = overlapArea(bottom, spot) / a, ot = overlapArea(top, spot) / a
    return ot < ob && ob > 0.15 ? out('sheet', 'top', top) : out('sheet', 'bottom', bottom)
  }

  const sx = spot.left + spot.width / 2, sy = spot.top + spot.height / 2
  const wide = spot.width >= spot.height * 1.8
  const raw = {
    right: [spot.left + spot.width + gap, sy - h / 2],
    left: [spot.left - gap - w, sy - h / 2],
    bottom: [sx - w / 2, spot.top + spot.height + gap],
    top: [sx - w / 2, spot.top - gap - h],
    'inside-bottom': [sx - w / 2, vh - m - h],
    'inside-top': [sx - w / 2, m],
  }
  const order = wide ? ['bottom', 'top', 'right', 'left', 'inside-bottom', 'inside-top'] : ['right', 'left', 'bottom', 'top', 'inside-bottom', 'inside-top']
  // 那一邊「除了放卡片之外還剩多少空間」：空間大的優先（例如面板裡的目標，左邊有整片畫布，比蓋在面板自己的其他控制項上好）
  const spare = {
    right: vw - (spot.left + spot.width) - gap - m - w, left: spot.left - gap - m - w,
    bottom: vh - (spot.top + spot.height) - gap - m - h, top: spot.top - gap - m - h,
    'inside-bottom': -Infinity, 'inside-top': -Infinity,
  }
  const scored = order.map((side, idx) => {
    const [rx, ry] = raw[side]
    const x = clamp(rx, m, maxX), y = clamp(ry, m, maxY)   // 先夾進視窗，再看它蓋到目標多少
    const r = box(x, y)
    return { side, r, idx, overlap: overlapArea(r, spot), disp: Math.floor((Math.abs(r.left - rx) + Math.abs(r.top - ry)) / 20), spare: spare[side] }
  })
  // 排序：蓋到目標的面積少 → 離理想位置近（20px 內視為一樣）→ 剩餘空間大 → 寬扁 / 高窄目標的慣用順序
  scored.sort((p, q) => (p.overlap - q.overlap) || (p.disp - q.disp) || (q.spare - p.spare) || (p.idx - q.idx))
  const best = scored[0]
  return out('anchor', best.side, best.r)
}

// ============================================================================================
// 導航狀態機（可訂閱；React 端用 useSyncExternalStore(subscribe, getState)）
// ============================================================================================
// state = { open, index, source }；source：'auto'（首次進站自動）| 'replay'（說明視窗裡的「重新看新手導覽」）。
// getState() 只在狀態真的改變時才換新物件（useSyncExternalStore 要求快照穩定）。
// 所有方法都是閉包（沒有用到 this），可以直接當 onClick 傳。
export function createOnboarding({ steps = STEPS, getLocal = defaultLocal, getSession = defaultSession, getEnv = defaultEnv } = {}) {
  let state = { open: false, index: 0, source: null }
  let autoTried = false
  const subs = new Set()
  const last = steps.length - 1
  const commit = (next) => { state = next; for (const f of [...subs]) { try { f() } catch (e) { /* 訂閱者出錯不影響其他人 */ } } }
  const end = () => {
    if (!state.open) return false
    markDone(getLocal, getSession)   // 完成 / 略過才寫 seen + onboarded（開始時絕不寫，見檔頭）
    commit({ open: false, index: 0, source: null })
    return true
  }
  const api = {
    getState: () => state,
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn) } },
    // 開始（已經開著就什麼都不做：StrictMode 雙掛載 / 重複點擊都不會把進度洗回第一步）
    open(source = 'replay') {
      if (state.open) return false
      commit({ open: true, index: 0, source })
      return true
    },
    // 進站自動判斷：每次載入頁面只判斷一次（StrictMode 的第二次 effect 不會重來；開著的狀態維持不變）
    autoStart() {
      if (autoTried) return false
      autoTried = true
      let env = null
      try { env = getEnv() } catch (e) { env = null }
      if (!env || !shouldAutoShow({ search: env.search, hash: env.hash, local: getLocal, session: getSession })) return false
      return api.open('auto')
    },
    goto(i) {
      if (!state.open) return false
      const n = clamp(Math.round(Number(i) || 0), 0, last)
      if (n === state.index) return false
      commit({ ...state, index: n })
      return true
    },
    next() { if (!state.open) return false; return state.index >= last ? end() : api.goto(state.index + 1) },   // 最後一步的「下一步」＝完成
    prev() { if (!state.open) return false; return api.goto(state.index - 1) },
    skip() { return end() },
    finish() { return end() },
    close() { if (!state.open) return false; commit({ open: false, index: 0, source: null }); return true },   // 不寫偏好的關閉（程式用）
  }
  return api
}

// 全站唯一的導覽（Onboarding.jsx 與 InfoModal 的「重新看新手導覽」共用）。建立時不碰 window；儲存空間 / 網址都是用到才讀。
export const onboarding = createOnboarding()
