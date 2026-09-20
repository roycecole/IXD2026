// 相機手勢：純函式（不碰瀏覽器 API、不載入 MediaPipe），可直接用 node 測試（gestures.test.mjs）。
//   1) classifyHand(landmarks)：由 MediaPipe 手部 21 個 landmark 分類「張手 / 捏合 / 其他」
//   2) createGestureTracker()：時間軸狀態機（張手需持續 ≥0.5 秒才進入平靜、捏合上升緣觸發 + 冷卻 3 秒、
//      手消失 >1 秒回 idle、平靜時把參數平滑推向平靜值並節流輸出）
//   3) createWaveDetector()：「揮手換站」——資料導覽進行中，張開手掌快速橫掃（約 0.5 秒內位移超過門檻）→ 'left' / 'right'（以使用者自己的左右為準）；
//      routeWave(dir, { runner, touchGuide })：把揮手接到導覽（向左揮＝下一站、向右揮＝上一站），走 touchGuide()（不是 touch()：touch 會讓導覽以 'input' 中止）
// 分類只用「點與點的距離比值 / 夾角」——對平移、縮放、旋轉、鏡像（前鏡頭是鏡像的）與左右手都不變。
// 21 點編號（MediaPipe Hands）：0 手腕；1-4 拇指（CMC、MCP、IP、指尖）；5-8 食指；9-12 中指；13-16 無名指；17-20 小指（各為 MCP、PIP、DIP、指尖）。

export const LM = {
  WRIST: 0,
  THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
}
const FINGERS = [   // 食指、中指、無名指、小指：[MCP, PIP, DIP, TIP]
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
]

// ---- 手勢 id ----
export const GESTURE = { IDLE: 'idle', OPEN_PALM: 'open_palm', PINCH: 'pinch', OTHER: 'other' }

// ---- 分類閾值（enter＝進入 / stay＝維持；維持門檻比進入寬鬆＝遲滯，避免在邊界抖動）----
export const THRESH = {
  pinchEnter: 0.3,         // 拇指尖—食指尖距離 / 手掌尺寸 ≤ 此值 → 進入捏合（真人捏合時兩個指尖 landmark 約隔 0.1–0.25 個掌長）
  pinchExit: 0.5,          // 已在捏合時，超過此值才算放開（進入 < 離開）
  pinchMinReach: 1.05,     // 捏合時食指尖距手腕至少這麼遠（× 手掌尺寸）；握拳時食指尖縮在掌心附近（≈0.8），不算捏合
  fingerReachEnter: 1.15,  // 指尖到手腕距離 / 第二指節到手腕距離：伸直≈1.3、微彎≈1.2、半彎≈1.0、握拳≈0.7
  fingerReachStay: 1.05,
  fingerStraightEnter: 0.8, // 指節連線的直度（弦長 / 折線長）：伸直≈1、彎曲 <0.7
  fingerStraightStay: 0.7,
  thumbStraightEnter: 0.75,
  thumbStraightStay: 0.65,
  thumbAwayEnter: 0.42,    // 拇指尖離食指根的距離（× 手掌尺寸）：外展≈0.7、貼在掌邊≈0.15
  thumbAwayStay: 0.32,
  spreadEnter: 5,          // 相鄰手指方向夾角的平均（度）：併攏 ≈0–3、張開 ≈8–15
  spreadStay: 3,
  spreadMinEnter: 1,       // 每一對相鄰手指至少要有的夾角
  spreadMinStay: 0,
}

// ---- 揮手換站的門檻（判定規則與說明見下方 createWaveDetector）----
// 【合成資料調校、需要真機調整：這些數值只用合成的手部 landmark 驗證過，沒有真機（不同鏡頭視角 / 距離 / 光線 / 裝置）驗證。】
export const WAVE = {
  windowMs: 500,        // 位移統計的時間窗：位移必須在這段時間內完成（越短越要求快）
  minDx: 0.27,          // 窗內淨水平位移（占影像寬度）：手臂長度前約 25–30 公分的橫掃
  maxSlope: 0.75,       // 垂直位移 / 水平位移 上限（兩者都換成「影像高度」單位比較）：主要是橫向的動作
  maxWander: 1.5,       // 路徑總長 / 淨位移 上限：來回抖動、畫圈不算
  minSamples: 4,        // 窗內至少要有幾幀（15 fps ≈ 0.27 秒）
  minSpanMs: 200,       // 窗內首尾至少相隔這麼久
  maxStepDx: 0.25,      // 相鄰兩幀的水平跳動上限（占影像寬度）：超過 = 偵測跳號，軌跡重來
  gapMs: 300,           // 兩個有效幀相隔超過這麼久 = 手中間消失過，軌跡重來
  entryMs: 300,         // 手出現（或軌跡重來）後，要先在畫面內待這麼久才可能判定揮手（手從畫面邊緣掃進來不算）
  edge: 0.05,           // 手掌任何一點離影像左右邊緣小於這個距離 = 正在進出畫面，這一幀不算（並讓軌跡重來）
  endMargin: 0.1,       // 揮動的終點（手掌中心）離影像左右邊緣至少這麼遠（手掃出畫面不算）
  openRatio: 0.6,       // 窗內至少這個比例的幀是張開手掌（快速移動時偶爾有幀被判成其他手形）
  cooldownMs: 1000,     // 觸發後的冷卻
  settleMs: 150,        // 冷卻後，手掌中心在最近這段時間內幾乎不動才重新就緒
  settleDx: 0.03,       // 「幾乎不動」：最近 settleMs 內水平移動範圍上限（占影像寬度）
}
export const WAVE_ACTION = { left: 'next', right: 'prev' }   // 使用者視角：向左揮＝下一站、向右揮＝上一站（像翻頁）


// ---- 幾何 ----
function toPts(lm, aspect) {
  const a = aspect > 0 ? aspect : 1
  const out = new Array(21)
  for (let i = 0; i < 21; i++) out[i] = { x: lm[i].x * a, y: lm[i].y }   // landmark 是「正規化影像座標」：x 要乘寬高比才是等比例
  return out
}
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y)
function angleBetween(ax, ay, bx, by) {
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by)
  if (la < 1e-9 || lb < 1e-9) return 0
  const c = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))
  return (Math.acos(c) * 180) / Math.PI
}

// 是否為可用的 21 點（長度足夠、座標為有限數字）
export function validLandmarks(lm) {
  if (!Array.isArray(lm) || lm.length < 21) return false
  for (let i = 0; i < 21; i++) {
    const p = lm[i]
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return false
  }
  return true
}

// 手部量測（全部是無單位的比值 / 角度）。回傳 null＝不是可用的手（點不足或退化）。
//   palm：手掌尺寸＝手腕到中指根；其餘距離都除以它，所以離鏡頭遠近不影響。
export function handMetrics(lm, aspect = 1) {
  if (!validLandmarks(lm)) return null
  const p = toPts(lm, aspect)
  const w = p[0]
  const palm = dist(w, p[9])
  if (!(palm > 1e-6)) return null

  const fingers = FINGERS.map(([m, pi, d, t]) => {
    const reach = dist(p[t], w) / Math.max(dist(p[pi], w), 1e-9)
    const path = dist(p[m], p[pi]) + dist(p[pi], p[d]) + dist(p[d], p[t])
    const straight = path > 1e-9 ? dist(p[m], p[t]) / path : 0
    return { reach, straight }
  })
  const thumbPath = dist(p[1], p[2]) + dist(p[2], p[3]) + dist(p[3], p[4])
  const thumbStraight = thumbPath > 1e-9 ? dist(p[1], p[4]) / thumbPath : 0
  const thumbAway = dist(p[4], p[5]) / palm

  // 相鄰手指的方向夾角（MCP → 指尖）
  const dirs = FINGERS.map(([m, , , t]) => [p[t].x - p[m].x, p[t].y - p[m].y])
  const gaps = []
  for (let i = 0; i < 3; i++) gaps.push(angleBetween(dirs[i][0], dirs[i][1], dirs[i + 1][0], dirs[i + 1][1]))
  const spread = (gaps[0] + gaps[1] + gaps[2]) / 3
  const spreadMin = Math.min(gaps[0], gaps[1], gaps[2])

  return {
    palm,
    fingers,                                    // [{reach, straight}]×4（食指→小指）
    thumbStraight, thumbAway,
    spread, spreadMin,
    pinch: dist(p[4], p[8]) / palm,             // 拇指尖—食指尖 / 手掌尺寸
    indexTipReach: dist(p[8], w) / palm,        // 食指尖距手腕 / 手掌尺寸
  }
}

// 分類一隻手。opts：{ aspect（影像寬/高，預設 1）, prev（上一個分類結果，套用遲滯用）}
// 回傳 { gesture: 'open_palm'|'pinch'|'other', metrics }。非手 / 點不足 → 'other'（一律忽略，不誤觸發）。
export function classifyHand(lm, opts = {}) {
  const m = handMetrics(lm, opts.aspect || 1)
  if (!m) return { gesture: GESTURE.OTHER, metrics: null }
  const wasPinch = opts.prev === GESTURE.PINCH
  const wasOpen = opts.prev === GESTURE.OPEN_PALM
  const T = THRESH

  // 捏合優先：拇指尖與食指尖貼近（有遲滯），且食指沒有縮回掌心（排除握拳）
  const pinchMax = wasPinch ? T.pinchExit : T.pinchEnter
  if (m.pinch <= pinchMax && m.indexTipReach >= T.pinchMinReach) return { gesture: GESTURE.PINCH, metrics: m }

  // 張手：四指伸直 + 拇指外展伸直 + 指間張開
  const reachMin = wasOpen ? T.fingerReachStay : T.fingerReachEnter
  const straightMin = wasOpen ? T.fingerStraightStay : T.fingerStraightEnter
  const fingersOk = m.fingers.every((f) => f.reach >= reachMin && f.straight >= straightMin)
  const thumbOk = m.thumbStraight >= (wasOpen ? T.thumbStraightStay : T.thumbStraightEnter) && m.thumbAway >= (wasOpen ? T.thumbAwayStay : T.thumbAwayEnter)
  const spreadOk = m.spread >= (wasOpen ? T.spreadStay : T.spreadEnter) && m.spreadMin >= (wasOpen ? T.spreadMinStay : T.spreadMinEnter)
  if (fingersOk && thumbOk && spreadOk) return { gesture: GESTURE.OPEN_PALM, metrics: m }

  return { gesture: GESTURE.OTHER, metrics: m }
}

// ---- 平滑 ----
// 指數趨近：dtMs 內以時間常數 tauMs 由 cur 朝 target 靠近（與幀率無關）。
export function smoothToward(cur, target, dtMs, tauMs) {
  if (!(tauMs > 0)) return target
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tauMs)
  return cur + (target - cur) * k
}

// ---- 手勢 → 參數對應 ----
// 「平靜」：把這幾個參數朝平靜值靠近。only:'down'＝只往更平靜（更小）的方向推：本來就比平靜值更低的，不會被拉高。
export const CALM_TARGETS = [
  { pid: 'current', target: 0.15, only: 'down' },     // 洋流速度
  { pid: 'swimSpeed', target: 0.3, only: 'down' },    // 游動速度
  { pid: 'trashCount', target: 0.1, only: 'down' },   // 垃圾數量
]

export const TRACKER_DEFAULTS = {
  openHoldMs: 500,        // 張手持續多久才進入平靜
  openGraceMs: 150,       // 張手中偶發的誤判（單幀）容忍時間，超過才算放手
  lostMs: 1000,           // 偵測不到手超過此時間 → idle
  pinchConfirmMs: 60,     // 捏合要維持多久才觸發（擋掉單幀雜訊）
  cooldownMs: 3000,       // 捏合觸發後的冷卻
  writeIntervalMs: 67,    // 平靜輸出的最小間隔 → ≤15 次/秒
  tauMs: 600,             // 平靜的趨近時間常數
  epsilon: 0.006,         // 距目標小於此值就吸附並停止推動
  calm: CALM_TARGETS,
}

// 手勢時間軸狀態機（純函式風格：時間由呼叫端傳入，方便測試）。
//   update(landmarks|null, nowMs, { readParam(pid)→0..1, aspect, suppressCalm })   suppressCalm：true → 不進入平靜（見下方註解）
//   → { state, calm, events, writes }
//     state：'idle'（沒手 >1 秒）|'open_palm'|'pinch'|'other'
//     calm：是否正在「平靜」（張手已持續 ≥ openHoldMs）
//     events：這一幀新發生的事件，例如 ['pinch']（＝該召喚鯨魚）
//     writes：這一幀該寫入的參數 [{ pid, v }]（呼叫端用 input(pid, v) 套用；已節流）
export function createGestureTracker(opts = {}) {
  const C = { ...TRACKER_DEFAULTS, ...opts }
  let raw = GESTURE.OTHER          // 上一個原始分類（遲滯用）
  let state = GESTURE.IDLE         // 對外顯示的狀態
  let lastSeen = null              // 最後一次看到手的時間
  let lastMatch = null             // 顯示狀態與原始分類一致的最後時間（離開張手 / 捏合的容忍用）
  let openSince = null, lastOpen = null
  let pinchSince = null, pinchFired = false, lastFire = null
  let calmTick = null, lastWrite = null, calmNow = false

  function resetAll() {
    raw = GESTURE.OTHER; state = GESTURE.IDLE; lastSeen = null; lastMatch = null
    openSince = null; lastOpen = null; pinchSince = null; pinchFired = false
    calmTick = null; lastWrite = null; calmNow = false
    // lastFire 不清：冷卻跨越「手暫時消失」仍然有效（不能靠遮住鏡頭再露出來繞過冷卻）
  }

  function update(lm, now, ctx = {}) {
    const events = [], writes = []
    const valid = validLandmarks(lm)

    if (valid) {
      lastSeen = now
      raw = classifyHand(lm, { aspect: ctx.aspect || 1, prev: raw }).gesture

      // 張手計時
      if (raw === GESTURE.OPEN_PALM) { if (openSince == null) openSince = now; lastOpen = now }

      // 捏合：上升緣 + 冷卻（維持期間不重複觸發）
      if (raw === GESTURE.PINCH) {
        if (pinchSince == null) pinchSince = now
        if (!pinchFired && now - pinchSince >= C.pinchConfirmMs) {
          pinchFired = true
          if (lastFire == null || now - lastFire >= C.cooldownMs) { events.push('pinch'); lastFire = now }
        }
      } else { pinchSince = null; pinchFired = false }

      // 顯示狀態：進入張手 / 捏合立即；退回「其他」要等容忍時間（避免徽章閃爍）
      if (raw === state) lastMatch = now
      else if (raw === GESTURE.OTHER && (state === GESTURE.OPEN_PALM || state === GESTURE.PINCH)) {
        if (lastMatch == null || now - lastMatch > C.openGraceMs) { state = GESTURE.OTHER; lastMatch = now }
      } else { state = raw; lastMatch = now }
    } else if (lastSeen != null && now - lastSeen > C.lostMs) {
      resetAll()
    }

    // 張手中斷超過容忍時間 → 清計時
    if (openSince != null && (lastOpen == null || now - lastOpen > C.openGraceMs)) openSince = null
    // 呼叫端要求暫停「平靜」（導覽進行中且開著揮手換站：要揮手就得先張開手掌，平靜的參數寫入會被當成真實輸入而中止導覽）：不累計張手時間，放手 / 導覽結束後要重新停留 0.5 秒才會平靜
    if (ctx.suppressCalm) openSince = null

    const calm = openSince != null && now - openSince >= C.openHoldMs
    calmNow = calm
    // 只在「這一幀確實是張手」時才推：放手後立刻停（不會在容忍時間內多推幾下），單幀誤判只是略過該幀
    if (calm && valid && raw === GESTURE.OPEN_PALM) {
      if (lastWrite == null || now - lastWrite >= C.writeIntervalMs) {
        const dt = calmTick == null ? C.writeIntervalMs : now - calmTick
        for (const { pid, target, only } of C.calm) {
          const cur = ctx.readParam ? ctx.readParam(pid) : undefined
          if (!Number.isFinite(cur)) continue
          if (only === 'down' && cur <= target) continue
          if (only === 'up' && cur >= target) continue
          if (Math.abs(cur - target) <= C.epsilon) continue
          let next = smoothToward(cur, target, dt, C.tauMs)
          if (Math.abs(next - target) <= C.epsilon) next = target
          writes.push({ pid, v: Math.max(0, Math.min(1, next)) })
        }
        calmTick = now
        if (writes.length) lastWrite = now
      }
    } else if (!calm) { calmTick = null }

    return { state, calm, events, writes }
  }

  return {
    update,
    reset: resetAll,
    get state() { return state },
    get calm() { return calmNow },
  }
}

// =====================================================================
// 揮手換站（導覽員手勢）
// =====================================================================
// 只在資料導覽進行中由 GestureService 餵幀；沒在導覽時完全不處理（不影響上面既有的張手 / 捏合對應）。
// 判定：手掌保持張開，手掌中心（手腕 + 四指根的平均）的「水平位移」在 windowMs 內超過 minDx（占影像寬度的比例）→ 揮手。
// 方向以「使用者自己的左右」為準（像翻頁）：向左揮＝下一站、向右揮＝上一站（WAVE_ACTION）。
//   鏡像：MediaPipe 的 landmark 是相機「原始影像」座標（沒有鏡像）。人面對鏡頭時，他的左邊在原始影像的右邊（x 較大），
//   所以預設（ctx.mirror !== false，前鏡頭 / 面對鏡頭的人）把 x 翻成 1 - x 再判斷方向——使用者手往自己的左邊移、在鏡像預覽裡也是往左。
//   左右手：只看手掌中心的移動與「是否張開」（分類本身對鏡像 / 左右手不變），所以左手右手一樣。
// 不算揮手：緩慢移動（位移只在 windowMs 內累計）、握拳 / 其他手形（張開比例不足）、只有手指在動（手掌中心不動）、來回抖動（路徑長 / 淨位移過大）、
//   偵測跳號（單幀跳動過大 = 換手 / 誤偵測）、進出畫面（手掌貼到影像邊緣的幀不算；手出現後要先在畫面內穩定 entryMs；終點不能貼邊）。
// 遲滯（一次揮動不會連發兩次、收手不會被當成反方向）：觸發後冷卻 cooldownMs，且冷卻後手掌還要「幾乎不動」settleMs 才重新就緒（就緒時視窗重新累計，不看收手的動作）。
const PALM_POINTS = [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP]

// 手掌中心與外框（正規化影像座標；只用手腕與四指根，手指再怎麼動都不影響）
export function palmBox(lm) {
  let sx = 0, sy = 0, minX = Infinity, maxX = -Infinity
  for (const i of PALM_POINTS) { const p = lm[i]; sx += p.x; sy += p.y; if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x }
  return { cx: sx / PALM_POINTS.length, cy: sy / PALM_POINTS.length, minX, maxX }
}

// update(landmarks|null, nowMs, { aspect（影像寬 / 高，預設 1）, mirror（預設 true：原始影像是面對鏡頭的人，見上方說明）}) → { event: null | 'left' | 'right' }
export function createWaveDetector(opts = {}) {
  const C = { ...WAVE, ...opts }
  let samples = []            // { t, x（使用者視角的 x：往右變大）, y, open }，只留最近 windowMs
  let trackStart = null       // 這一段連續軌跡的起點時間
  let lastSeen = null
  let lastFire = null         // 冷卻跨越重置仍有效（不能靠遮住鏡頭再露出來繞過冷卻）
  let armed = true
  let prevGesture = GESTURE.OTHER

  function resetTrack() { samples = []; trackStart = null; prevGesture = GESTURE.OTHER }
  function reset() { resetTrack(); lastSeen = null; armed = true }

  function update(lm, now, ctx = {}) {
    const out = { event: null }
    if (!validLandmarks(lm)) return out                                // 這一幀沒有手：什麼都不做（下一個有效幀會檢查 gapMs）
    const aspect = ctx.aspect > 0 ? ctx.aspect : 1
    const box = palmBox(lm)
    if (box.minX < C.edge || box.maxX > 1 - C.edge) { resetTrack(); return out }   // 進 / 出畫面中
    if (lastSeen != null && now - lastSeen > C.gapMs) resetTrack()
    lastSeen = now

    const ux = ctx.mirror === false ? box.cx : 1 - box.cx
    const prev = samples.length ? samples[samples.length - 1] : null
    if (prev && Math.abs(ux - prev.x) > C.maxStepDx) resetTrack()      // 偵測跳號
    prevGesture = classifyHand(lm, { aspect, prev: prevGesture }).gesture
    if (trackStart == null) trackStart = now
    samples.push({ t: now, x: ux, y: box.cy, open: prevGesture === GESTURE.OPEN_PALM })
    while (samples.length && now - samples[0].t > C.windowMs) samples.shift()

    if (lastFire != null && now - lastFire < C.cooldownMs) return out  // 冷卻中
    if (!armed) {                                                       // 冷卻過了：手要先幾乎不動一下才重新就緒（避開收手的動作）
      const recent = samples.filter((s) => now - s.t <= C.settleMs)
      if (recent.length < 2) return out
      let lo = Infinity, hi = -Infinity
      for (const s of recent) { if (s.x < lo) lo = s.x; if (s.x > hi) hi = s.x }
      if (hi - lo > C.settleDx) return out
      armed = true
      samples = samples.slice(-1)                                       // 就緒：視窗重新累計，不看收手時的位移
      return out
    }

    if (samples.length < C.minSamples) return out
    const first = samples[0], last = samples[samples.length - 1]
    if (last.t - first.t < C.minSpanMs) return out
    if (first.t - trackStart < C.entryMs) return out                    // 手剛出現：先穩定一下（從邊緣掃進來的不算）
    const dx = last.x - first.x, adx = Math.abs(dx)
    if (adx < C.minDx) return out
    if (last.x < C.endMargin || last.x > 1 - C.endMargin) return out   // 終點貼邊：手掃出畫面
    if (Math.abs(last.y - first.y) > C.maxSlope * adx * aspect) return out   // x 是寬度的比例、y 是高度的比例：乘 aspect 換成同單位
    let path = 0, open = 0
    for (let i = 0; i < samples.length; i++) { if (i) path += Math.abs(samples[i].x - samples[i - 1].x); if (samples[i].open) open++ }
    if (path > C.maxWander * adx) return out                            // 來回抖動
    if (open / samples.length < C.openRatio) return out                 // 不是張開的手掌

    lastFire = now; armed = false; samples = []
    out.event = dx < 0 ? 'left' : 'right'
    return out
  }

  return { update, reset, get armed() { return armed } }
}

// 把揮手接到導覽：runner = tourCore 的 tourRunner（或測試用假物件，方法一律「以方法呼叫」）。
//   導覽沒在進行 → 什麼都不做、回傳 null（沒在導覽時完全不處理揮手）；進行中 → touchGuide()（只記「有人在場」，不是 touch()：touch 會中止導覽）並換站，回傳 { dir, action }。
//   最後一站再揮「下一站」＝ runner.next() 的既有行為（手動導覽結束並還原；自動導覽回到第一站）。任何例外都不外洩。
export function routeWave(dir, { runner, touchGuide } = {}) {
  const action = WAVE_ACTION[dir]
  if (!action) return null
  try {
    if (!runner || !runner.isRunning()) return null
    try { if (typeof touchGuide === 'function') touchGuide() } catch (e) { /* 只是記時間 */ }
    if (action === 'next') runner.next()
    else runner.prev()
    return { dir, action }
  } catch (e) {
    return null
  }
}
