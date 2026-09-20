// 相機手勢單元測試。執行：node --test src/lib/gestures.test.mjs
// 不載入 MediaPipe：用「合成手部 landmark」驗證分類 / 遲滯 / 冷卻 / 平滑 / 左右手鏡像 / 缺手回 idle。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  LM, GESTURE, THRESH, CALM_TARGETS, TRACKER_DEFAULTS,
  validLandmarks, handMetrics, classifyHand, smoothToward, createGestureTracker,
} from './gestures.js'

// =====================================================================
// 合成手部產生器（單位＝手掌尺寸：手腕到中指根＝1；y 向下、手指朝上＝-y；拇指在 -x 側）
// =====================================================================
const FINGER_DEF = [   // 食指、中指、無名指、小指
  { mcp: [-0.33, -0.97], len: [0.42, 0.24, 0.21], fan: -10 },
  { mcp: [0.0, -1.0], len: [0.47, 0.30, 0.25], fan: 0 },
  { mcp: [0.30, -0.95], len: [0.44, 0.28, 0.24], fan: 9 },
  { mcp: [0.56, -0.82], len: [0.35, 0.19, 0.19], fan: 20 },
]
const rad = (d) => (d * Math.PI) / 180

// 一根手指：spread 0..1（扇形張開程度）、curl 0..1（0＝伸直、1＝握緊）。
//   mode 'plane'：在影像平面內向掌心彎（側面看）；'depth'：朝鏡頭彎（正面看，投影後沿手指軸縮短）。
function finger(def, { spread = 1, curl = 0, mode = 'depth' } = {}) {
  const base = rad(def.fan * spread)           // 與「朝上」的夾角（順時針為正）
  const [l1, l2, l3] = def.len
  const flex = [90 * curl, 100 * curl, 70 * curl].map(rad)   // 三個關節各自的彎曲角
  const pts = [[def.mcp[0], def.mcp[1]]]
  let cum = 0
  const lens = [l1, l2, l3]
  for (let i = 0; i < 3; i++) {
    cum += flex[i]
    const [px, py] = pts[i]
    if (mode === 'depth') {
      const L = lens[i] * Math.cos(cum)         // 朝鏡頭彎：沿手指軸的投影長度＝L·cos(累計彎角)
      pts.push([px + Math.sin(base) * L, py - Math.cos(base) * L])
    } else {
      const a = base + cum                        // 平面彎：整根手指在影像平面內向 +x 側轉
      pts.push([px + Math.sin(a) * lens[i], py - Math.cos(a) * lens[i]])
    }
  }
  return pts.slice(1)
}

const THUMB_POSES = {
  out: [[-0.28, -0.18], [-0.55, -0.38], [-0.80, -0.52], [-1.00, -0.66]],     // 外展伸直
  tuck: [[-0.28, -0.18], [-0.40, -0.40], [-0.20, -0.55], [0.05, -0.55]],     // 蜷在掌前（握拳）
  up: [[-0.28, -0.18], [-0.42, -0.40], [-0.48, -0.85], [-0.52, -1.30]],      // 比讚：拇指筆直朝上
  side: [[-0.28, -0.18], [-0.42, -0.42], [-0.46, -0.72], [-0.46, -0.98]],    // 貼著食指根（併攏 / 不外展）
}
const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

// makeHand：回傳 21 點 [{x,y,z}]（掌尺單位）。
//   curls [食,中,無,小]、thumb（'out'|'tuck'|'up'|'side' 或 0..1 外展程度）、spread、mode、pinch（>=0 → 拇指尖貼向食指尖，值＝間距 / 掌尺）
function makeHand({ curls = [0, 0, 0, 0], thumb = 'out', spread = 1, mode = 'depth', pinch = null } = {}) {
  const pts = new Array(21)
  pts[0] = [0, 0]
  const fs = FINGER_DEF.map((d, i) => finger(d, { spread, curl: curls[i], mode }))
  FINGER_DEF.forEach((d, i) => {
    pts[5 + i * 4] = d.mcp
    pts[6 + i * 4] = fs[i][0]; pts[7 + i * 4] = fs[i][1]; pts[8 + i * 4] = fs[i][2]
  })
  let th
  if (typeof thumb === 'number') th = THUMB_POSES.tuck.map((p, i) => lerp2(p, THUMB_POSES.out[i], thumb))
  else th = THUMB_POSES[thumb]
  th = th.map((p) => [...p])
  if (pinch != null) {                                // 拇指尖貼向食指尖
    const tip = pts[8]
    th[3] = [tip[0] - pinch, tip[1] + 0.0]
    th[2] = lerp2(th[1], th[3], 0.55)
    th[1] = [-0.52, -0.42]
  }
  for (let i = 0; i < 4; i++) pts[1 + i] = th[i]
  return pts.map(([x, y]) => ({ x, y, z: 0 }))
}

// 隨機但可重現的雜訊（mulberry32）
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

// 影像轉換：旋轉 / 縮放 / 平移 / 鏡像 / 雜訊，並轉成「正規化影像座標」（x/寬、y/高）。
function place(hand, { rot = 0, scale = 0.25, tx = 0.5, ty = 0.55, mirror = false, noise = 0, seed = 1, W = 640, H = 480 } = {}) {
  const r = rng(seed)
  const c = Math.cos(rad(rot)), s = Math.sin(rad(rot))
  return hand.map((p) => {
    let x = p.x + (noise ? (r() - 0.5) * 2 * noise : 0), y = p.y + (noise ? (r() - 0.5) * 2 * noise : 0)
    if (mirror) x = -x
    const rx = x * c - y * s, ry = x * s + y * c
    const px = (rx * scale * H) + tx * W, py = (ry * scale * H) + ty * H     // 以「畫面高度」為單位，像素座標
    return { x: px / W, y: py / H, z: 0 }
  })
}
const ASPECT = 640 / 480
const cls = (lm, o = {}) => classifyHand(lm, { aspect: ASPECT, ...o }).gesture

// 常用姿勢
const POSES = {
  openPalm: () => makeHand({ curls: [0, 0, 0, 0], thumb: 'out', spread: 1 }),
  fist: () => makeHand({ curls: [1, 1, 1, 1], thumb: 'tuck', spread: 0.3 }),
  thumbsUp: () => makeHand({ curls: [1, 1, 1, 1], thumb: 'up', spread: 0.3 }),
  point: () => makeHand({ curls: [0, 1, 1, 1], thumb: 'tuck', spread: 0.3 }),
  peace: () => makeHand({ curls: [0, 0, 1, 1], thumb: 'tuck', spread: 1 }),
  flatTogether: () => makeHand({ curls: [0, 0, 0, 0], thumb: 'side', spread: 0 }),
  claw: () => makeHand({ curls: [0.55, 0.55, 0.55, 0.55], thumb: 'out', spread: 1 }),
  pinch: (gap = 0.05, others = 0) => makeHand({ curls: [0.35, others, others, others], thumb: 'out', spread: 0.6, pinch: gap, mode: 'plane' }),
}

test('產生器自我檢查：21 點、有限數字、是可用的手', () => {
  for (const [name, mk] of Object.entries(POSES)) {
    const lm = place(mk())
    assert.equal(lm.length, 21, name)
    assert.ok(validLandmarks(lm), name)
    assert.ok(handMetrics(lm, ASPECT), name)
  }
})

// =====================================================================
// 分類
// =====================================================================
test('張手：五指伸直、指間張開 → open_palm', () => {
  assert.equal(cls(place(POSES.openPalm())), GESTURE.OPEN_PALM)
})

test('其他姿勢一律忽略：握拳 / 比讚 / 食指指 / 比 YA / 五指併攏 / 半彎 → other', () => {
  for (const name of ['fist', 'thumbsUp', 'point', 'peace', 'flatTogether', 'claw']) {
    const g = cls(place(POSES[name]()))
    assert.equal(g, GESTURE.OTHER, `${name} 不應被當成張手或捏合（得到 ${g}）`)
  }
})

test('捏合：拇指尖貼食指尖 → pinch；其餘手指伸直（OK 手勢）或半彎、握起都算', () => {
  for (const others of [0, 0.5, 1]) assert.equal(cls(place(POSES.pinch(0.04, others))), GESTURE.PINCH, `others=${others}`)
})

test('握拳不會被誤判成捏合（食指尖縮在掌心附近）', () => {
  // 拇指尖蜷到食指尖旁：距離很近，但食指是握著的
  const h = POSES.fist()
  h[LM.THUMB_TIP] = { ...h[LM.INDEX_TIP], x: h[LM.INDEX_TIP].x - 0.05 }
  assert.notEqual(cls(place(h)), GESTURE.PINCH)
})

test('拇指沒外展的「五指張開」不算張手（拇指貼著手掌）', () => {
  assert.equal(cls(place(makeHand({ thumb: 'side', spread: 1 }))), GESTURE.OTHER)
})

test('捏合遲滯：進入門檻 < 離開門檻；已在捏合時，間距介於兩者之間仍維持', () => {
  assert.ok(THRESH.pinchEnter < THRESH.pinchExit)
  const between = place(POSES.pinch(0.36))          // 間距介於 enter 與 exit 之間
  const mid = handMetrics(between, ASPECT).pinch
  assert.ok(mid > THRESH.pinchEnter && mid < THRESH.pinchExit, `間距 ${mid}`)
  assert.notEqual(cls(between, { prev: GESTURE.OTHER }), GESTURE.PINCH, '還沒捏合時不進入')
  assert.equal(cls(between, { prev: GESTURE.PINCH }), GESTURE.PINCH, '已捏合時維持')
  const far = place(POSES.pinch(0.6))
  assert.notEqual(cls(far, { prev: GESTURE.PINCH }), GESTURE.PINCH, '超過離開門檻才放開')
})

test('張手遲滯：邊界姿勢在「已張手」時維持、「未張手」時不進入', () => {
  // 五指稍微併攏：夾角介於 stay 與 enter 門檻之間
  let found = null
  for (let s = 0.2; s <= 0.8; s += 0.02) {
    const lm = place(makeHand({ spread: s }))
    const m = handMetrics(lm, ASPECT)
    if (m.spread > THRESH.spreadStay + 0.2 && m.spread < THRESH.spreadEnter - 0.2) { found = lm; break }
  }
  assert.ok(found, '應找得到介於兩門檻之間的張開程度')
  assert.equal(cls(found, { prev: GESTURE.OTHER }), GESTURE.OTHER)
  assert.equal(cls(found, { prev: GESTURE.OPEN_PALM }), GESTURE.OPEN_PALM)
})

test('平移 / 縮放 / 旋轉 / 雜訊下分類穩定（張手、捏合、握拳）', () => {
  for (let i = 0; i < 24; i++) {
    const o = { rot: (i * 15) % 360, scale: 0.15 + (i % 5) * 0.06, tx: 0.3 + (i % 4) * 0.13, ty: 0.35 + (i % 3) * 0.15, noise: 0.008, seed: 100 + i }
    assert.equal(cls(place(POSES.openPalm(), o)), GESTURE.OPEN_PALM, `open ${JSON.stringify(o)}`)
    assert.equal(cls(place(POSES.pinch(0.05), o)), GESTURE.PINCH, `pinch ${JSON.stringify(o)}`)
    assert.equal(cls(place(POSES.fist(), o)), GESTURE.OTHER, `fist ${JSON.stringify(o)}`)
  }
})

test('左 / 右手、鏡像相機：把 x 翻轉後分類結果完全相同', () => {
  const cases = { openPalm: GESTURE.OPEN_PALM, pinch: GESTURE.PINCH, fist: GESTURE.OTHER, thumbsUp: GESTURE.OTHER, point: GESTURE.OTHER, peace: GESTURE.OTHER }
  for (const [name, expected] of Object.entries(cases)) {
    for (const rot of [0, 90, 180, 270]) {
      const a = cls(place(POSES[name](), { rot, mirror: false }))
      const b = cls(place(POSES[name](), { rot, mirror: true }))
      assert.equal(a, expected, `${name} rot=${rot}`)
      assert.equal(b, expected, `${name} rot=${rot} mirrored`)
    }
  }
  // 直接把正規化的 x 翻成 1-x（前鏡頭鏡像顯示的等價做法）
  const lm = place(POSES.openPalm())
  const flipped = lm.map((p) => ({ ...p, x: 1 - p.x }))
  assert.equal(cls(flipped), GESTURE.OPEN_PALM)
})

test('寬高比：非正方形畫面（640x480）不傳 aspect 也不致誤判為握拳 / 其他姿勢；傳對 aspect 結果正確', () => {
  const lm = place(POSES.openPalm(), { rot: 90 })   // 手橫放：x 方向被 4:3 拉伸最明顯
  assert.equal(classifyHand(lm, { aspect: ASPECT }).gesture, GESTURE.OPEN_PALM)
  const fist = place(POSES.fist(), { rot: 90 })
  assert.equal(classifyHand(fist).gesture, GESTURE.OTHER)
})

test('壞輸入：null / 點數不足 / NaN / 全部重疊 → other（不丟例外、不誤觸發）', () => {
  for (const bad of [null, undefined, [], new Array(20).fill({ x: 0.5, y: 0.5 }), new Array(21).fill({ x: 0.5, y: 0.5 }), new Array(21).fill({ x: NaN, y: 0 }), 'hand']) {
    assert.equal(classifyHand(bad).gesture, GESTURE.OTHER)
  }
  assert.equal(validLandmarks(place(POSES.openPalm())), true)
  assert.equal(validLandmarks(null), false)
})

// =====================================================================
// 平滑
// =====================================================================
test('smoothToward：單調靠近、不越過目標；與幀率無關（分幾次走結果相同）', () => {
  let v = 0.9
  for (let i = 0; i < 30; i++) { const n = smoothToward(v, 0.15, 67, 600); assert.ok(n < v && n > 0.15); v = n }
  const once = smoothToward(0.9, 0.15, 400, 600)
  let split = 0.9
  for (let i = 0; i < 4; i++) split = smoothToward(split, 0.15, 100, 600)
  assert.ok(Math.abs(once - split) < 1e-9)
  assert.equal(smoothToward(0.3, 0.7, 0, 600), 0.3)
  assert.equal(smoothToward(0.3, 0.7, 100, 0), 0.7)
})

// =====================================================================
// 狀態機（時間軸）
// =====================================================================
// 以 15 fps（67ms）餵幀。回傳所有幀的輸出。
// ctx.apply(writes) 會在每一幀之後立刻被呼叫（模擬 input(pid, v) 寫回 store，下一幀 readParam 就讀到新值）。
function runFrames(tr, lm, fromMs, toMs, ctx = {}, step = 67) {
  const outs = []
  for (let t = fromMs; t <= toMs; t += step) {
    const o = { t, ...tr.update(lm, t, ctx) }
    if (ctx.apply) ctx.apply(o.writes)
    if (ctx.snap) o.snap = ctx.snap()          // 這一幀套用之後的參數快照
    outs.push(o)
  }
  return outs
}
const store = (init) => {
  const p = { ...init }
  const apply = (writes) => writes.forEach((w) => { p[w.pid] = w.v })
  return { p, apply, ctx: { aspect: ASPECT, readParam: (k) => p[k], apply, snap: () => ({ ...p }) } }
}

test('張手需持續 ≥0.5 秒才進入平靜；之前不寫參數', () => {
  const tr = createGestureTracker()
  const s = store({ current: 0.8, swimSpeed: 0.9, trashCount: 0.7 })
  const open = place(POSES.openPalm())
  let calmAt = null
  for (const o of runFrames(tr, open, 0, 1500, s.ctx)) {
    if (o.t < 500) { assert.equal(o.calm, false, `t=${o.t}`); assert.equal(o.writes.length, 0, `t=${o.t}`) }
    if (o.calm && calmAt == null) calmAt = o.t
  }
  assert.ok(calmAt != null && calmAt >= 500 && calmAt <= 600, `平靜開始於 ${calmAt}`)
  assert.equal(tr.state, GESTURE.OPEN_PALM)
})

test('平靜：current / swimSpeed / trashCount 平滑朝平靜值靠近（單調、不越過），最終吸附並停止寫入', () => {
  const tr = createGestureTracker()
  const s = store({ current: 0.8, swimSpeed: 0.9, trashCount: 0.7, spin: 0.4 })
  const open = place(POSES.openPalm())
  const hist = { current: [], swimSpeed: [], trashCount: [] }
  let lastWriteAt = 0
  for (const o of runFrames(tr, open, 0, 8000, s.ctx)) {
    if (o.writes.length) lastWriteAt = o.t
    for (const w of o.writes) { assert.ok(w.pid in hist, `只寫平靜相關參數，卻寫了 ${w.pid}`); hist[w.pid].push(w.v) }
  }
  for (const c of CALM_TARGETS) {
    const h = hist[c.pid]
    assert.ok(h.length > 5, c.pid)
    for (let i = 1; i < h.length; i++) assert.ok(h[i] <= h[i - 1] + 1e-12, `${c.pid} 應單調下降`)
    assert.ok(h.every((v) => v >= c.target - 1e-12 && v <= 1), `${c.pid} 不應越過目標`)
    assert.equal(s.p[c.pid], c.target, `${c.pid} 最終吸附到平靜值`)
  }
  assert.equal(s.p.spin, 0.4, '其他參數不動')
  assert.ok(lastWriteAt < 6000, `到達平靜值後停止寫入（最後一次寫入 ${lastWriteAt}ms）`)
  // 節奏：不是瞬間跳到底，也不是拖很久（張手滿 0.5 秒後開始；時間常數 0.6 秒）
  const tr2 = createGestureTracker(); const s2 = store({ current: 0.8, swimSpeed: 0.9, trashCount: 0.7 })
  const at = {}
  for (const o of runFrames(tr2, open, 0, 2500, s2.ctx)) at[o.t] = o.snap.current
  assert.ok(at[536] > 0.7, `剛進入平靜時不應瞬間跳到底：${at[536]}`)
  assert.ok(at[1005] < at[536] && at[1005] > 0.3, `進入後約 0.5 秒：${at[1005]}`)
  assert.ok(at[2010] < 0.3, `進入後 1.5 秒應已明顯平靜：${at[2010]}`)
})

test('平靜只往更平靜的方向推：已經比平靜值更低的參數不會被拉高', () => {
  const tr = createGestureTracker()
  const s = store({ current: 0.05, swimSpeed: 0.1, trashCount: 0.0 })
  const writes = runFrames(tr, place(POSES.openPalm()), 0, 3000, s.ctx).flatMap((o) => o.writes)
  assert.equal(writes.length, 0)
})

test('平靜輸出節流：任何 1 秒視窗內 ≤15 次；即使以 60fps 餵幀也一樣', () => {
  for (const step of [67, 33, 16]) {
    const tr = createGestureTracker()
    const s = store({ current: 1, swimSpeed: 1, trashCount: 1 })
    const times = []
    for (const o of runFrames(tr, place(POSES.openPalm()), 0, 4000, s.ctx, step)) { if (o.writes.length) times.push(o.t) }
    assert.ok(times.length > 5)
    for (let i = 0; i + 15 < times.length; i++) assert.ok(times[i + 15] - times[i] >= 1000 - 1e-6, `step=${step}：${times[i]}..${times[i + 15]} 內超過 15 次`)
  }
})

test('放手後不彈回：離開張手 → 立刻不再寫入，參數維持原地，讓其他輸入接手', () => {
  const tr = createGestureTracker()
  const s = store({ current: 0.8, swimSpeed: 0.9, trashCount: 0.7 })
  const open = place(POSES.openPalm()), fist = place(POSES.fist())
  runFrames(tr, open, 0, 1200, s.ctx)
  const held = { ...s.p }
  assert.ok(held.current < 0.8)
  let writes = 0
  for (const o of runFrames(tr, fist, 1267, 3000, s.ctx)) { writes += o.writes.length }
  assert.equal(writes, 0)
  assert.deepEqual(s.p, held)
  // 其他輸入接手：外部把 current 改成 0.6，之後也不會被推回
  s.p.current = 0.6
  runFrames(tr, fist, 3067, 4000, s.ctx)
  assert.equal(s.p.current, 0.6)
})

test('張手中偶發單幀誤判不會打斷平靜；持續放手才會', () => {
  const tr = createGestureTracker()
  const s = store({ current: 0.8, swimSpeed: 0.9, trashCount: 0.7 })
  const open = place(POSES.openPalm()), fist = place(POSES.fist())
  runFrames(tr, open, 0, 800, s.ctx)
  const o = tr.update(fist, 868, s.ctx)     // 單幀握拳
  assert.equal(o.calm, true)
  assert.equal(tr.update(open, 935, s.ctx).calm, true)
  // 連續放手超過容忍時間
  let calm = true
  for (const f of runFrames(tr, fist, 1002, 1400, s.ctx)) calm = f.calm
  assert.equal(calm, false)
})

test('捏合：上升緣觸發一次；維持期間不重複；放開再捏 → 冷卻 3 秒內不觸發，之後才觸發', () => {
  const tr = createGestureTracker()
  const s = store({})
  const pinch = place(POSES.pinch(0.04)), open = place(POSES.openPalm()), fist = place(POSES.fist())
  const fires = (from, to, lm) => runFrames(tr, lm, from, to, s.ctx).filter((o) => o.events.includes('pinch')).map((o) => o.t)

  assert.deepEqual(fires(0, 200, open), [], '張手不觸發')
  const first = fires(300, 2000, pinch)               // 捏著不放 1.7 秒
  assert.equal(first.length, 1, `維持期間只觸發一次：${first}`)
  assert.ok(first[0] >= 300 + TRACKER_DEFAULTS.pinchConfirmMs && first[0] <= 300 + 200, `觸發時間 ${first[0]}`)
  const t0 = first[0]

  assert.deepEqual(fires(2067, 2300, open), [])       // 放開
  assert.deepEqual(fires(2367, 2600, pinch), [], '冷卻期間（距第一次 <3s）再捏不觸發')
  assert.deepEqual(fires(2667, 2900, open), [])
  assert.deepEqual(fires(t0 + 3000, t0 + 3300, pinch).length, 1, '冷卻結束後的新捏合會觸發')
})

test('冷卻中開始的捏合，就算一直捏到冷卻結束也不補觸發（要有新的上升緣）', () => {
  const tr = createGestureTracker(); const s = store({})
  const pinch = place(POSES.pinch(0.04)), open = place(POSES.openPalm())
  const all = []
  for (const o of runFrames(tr, pinch, 0, 300, s.ctx)) if (o.events.length) all.push(o.t)
  for (const o of runFrames(tr, open, 400, 700, s.ctx)) if (o.events.length) all.push(o.t)
  for (const o of runFrames(tr, pinch, 800, 5000, s.ctx)) if (o.events.length) all.push(o.t)   // 冷卻中開始、捏到 5 秒
  assert.equal(all.length, 1)
})

test('捏合單幀雜訊（<60ms）不觸發', () => {
  const tr = createGestureTracker(); const s = store({})
  const pinch = place(POSES.pinch(0.04)), open = place(POSES.openPalm())
  let n = 0
  for (const [lm, t] of [[open, 0], [open, 67], [pinch, 134], [open, 201], [open, 268]]) n += tr.update(lm, t, s.ctx).events.length
  assert.equal(n, 0)
})

test('捏合邊界抖動（間距在 enter/exit 之間來回）不會重複觸發', () => {
  const tr = createGestureTracker(); const s = store({})
  const tight = place(POSES.pinch(0.05)), loose = place(POSES.pinch(0.36))   // 0.36 介於 enter 與 exit 之間
  let n = 0, t = 0
  for (let i = 0; i < 60; i++, t += 67) n += tr.update(i % 2 ? loose : tight, t, s.ctx).events.length
  assert.equal(n, 1)
  assert.equal(tr.state, GESTURE.PINCH)
})

test('缺手 >1 秒 → idle；<1 秒維持上一個狀態；idle 之後不再平靜、不觸發', () => {
  const tr = createGestureTracker(); const s = store({ current: 0.8, swimSpeed: 0.9, trashCount: 0.7 })
  const open = place(POSES.openPalm())
  runFrames(tr, open, 0, 1000, s.ctx)
  assert.equal(tr.state, GESTURE.OPEN_PALM)
  const a = tr.update(null, 1300, s.ctx)               // 缺手 0.3 秒
  assert.equal(a.state, GESTURE.OPEN_PALM)
  assert.equal(a.calm, false, '沒看到手就不再推（超過容忍時間）')
  assert.equal(a.writes.length, 0)
  const b = tr.update(null, 1900, s.ctx)               // 缺手 0.9 秒（最後看到 ~1005）
  assert.equal(b.state, GESTURE.OPEN_PALM)
  const c = tr.update(null, 2100, s.ctx)               // 缺手 1.1 秒
  assert.equal(c.state, GESTURE.IDLE)
  assert.equal(c.calm, false)
  // 手回來：重新累積 0.5 秒才平靜
  const back = runFrames(tr, open, 2200, 2500, s.ctx)
  assert.ok(back.every((o) => !o.calm))
})

test('一開始就沒有手 → 一直是 idle；任意壞輸入不丟例外', () => {
  const tr = createGestureTracker()
  for (let t = 0; t < 3000; t += 67) assert.equal(tr.update(null, t, {}).state, GESTURE.IDLE)
  const out = tr.update([{ x: NaN }], 4000, {})
  assert.equal(out.state, GESTURE.IDLE)
  assert.deepEqual(out.events, [])
})

test('顯示狀態：進入張手 / 捏合立即；退回其他要容忍短暫抖動', () => {
  const tr = createGestureTracker(); const s = store({})
  const open = place(POSES.openPalm()), fist = place(POSES.fist()), pinch = place(POSES.pinch(0.04))
  assert.equal(tr.update(fist, 0, s.ctx).state, GESTURE.OTHER)
  assert.equal(tr.update(open, 67, s.ctx).state, GESTURE.OPEN_PALM)
  assert.equal(tr.update(fist, 134, s.ctx).state, GESTURE.OPEN_PALM, '單幀抖動不閃')
  assert.equal(tr.update(pinch, 201, s.ctx).state, GESTURE.PINCH, '換成捏合立即反映')
  assert.equal(tr.update(fist, 268, s.ctx).state, GESTURE.PINCH)
  assert.equal(tr.update(fist, 500, s.ctx).state, GESTURE.OTHER, '持續握拳才退回 other')
})

test('reset()：回到 idle，計時清空', () => {
  const tr = createGestureTracker(); const s = store({ current: 0.9, swimSpeed: 0.9, trashCount: 0.9 })
  runFrames(tr, place(POSES.openPalm()), 0, 1000, s.ctx)
  assert.equal(tr.calm, true)
  tr.reset()
  assert.equal(tr.state, GESTURE.IDLE)
  assert.equal(tr.calm, false)
})

test('readParam 缺失 / 非數字時不寫入（不會把 NaN 寫進參數）', () => {
  const tr = createGestureTracker()
  const outs = runFrames(tr, place(POSES.openPalm()), 0, 2000, { aspect: ASPECT })   // 沒有 readParam
  assert.ok(outs.every((o) => o.writes.length === 0))
  const outs2 = runFrames(createGestureTracker(), place(POSES.openPalm()), 0, 2000, { aspect: ASPECT, readParam: () => NaN })
  assert.ok(outs2.every((o) => o.writes.length === 0))
})

test('平靜寫入值一律落在 0..1', () => {
  const tr = createGestureTracker(); const s = store({ current: 1, swimSpeed: 1, trashCount: 1 })
  for (const o of runFrames(tr, place(POSES.openPalm()), 0, 4000, s.ctx)) { for (const w of o.writes) assert.ok(w.v >= 0 && w.v <= 1) }
})

// =====================================================================
// 版本一致性：CDN 的 WASM 版本必須與安裝的 npm 套件一致
// =====================================================================
test('hands.js 的 MediaPipe 版本 = package.json 的 @mediapipe/tasks-vision（WASM 與 JS 版本不一致會載入失敗）', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  const installed = JSON.parse(readFileSync(new URL('../../node_modules/@mediapipe/tasks-vision/package.json', import.meta.url), 'utf8')).version
  const declared = pkg.dependencies['@mediapipe/tasks-vision']
  assert.equal(declared, installed, 'package.json 應釘死確切版本（不加 ^）')
  const { VISION_VERSION, WASM_BASE } = await import('./hands.js')
  assert.equal(VISION_VERSION, installed)
  assert.ok(WASM_BASE.includes(`@mediapipe/tasks-vision@${installed}/wasm`))
})

// =====================================================================
// 執行層（hands.js）：用假相機 / 假計時器 / 假 landmarker 測生命週期
// =====================================================================
import {
  createHandsRuntime, gestureSupport, setGestureEnabled, useHandsStore, errorKey, stateLabel,
  DETECT_INTERVAL_MS, WASM_BASE, MODEL_URL,
} from './hands.js'

const flush = () => new Promise((r) => setImmediate(r))

function fakeClock() {
  let now = 1000, id = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimeout: (f, ms) => { const i = ++id; timers.set(i, { at: now + ms, f }); return i },
    clearTimeout: (i) => { timers.delete(i) },
    pending: () => timers.size,
    async advance(ms) {
      const end = now + ms
      for (;;) {
        let best = null
        for (const [i, tm] of timers) if (tm.at <= end && (!best || tm.at < best[1].at)) best = [i, tm]
        if (!best) break
        timers.delete(best[0]); now = Math.max(now, best[1].at); best[1].f()
        await flush()
      }
      now = end
      await flush()
    },
  }
}
const fakeStream = () => { const tracks = [{ stopped: false, onended: null, stop() { this.stopped = true } }]; return { tracks, getTracks: () => tracks, getVideoTracks: () => tracks } }
const fakeVideo = (clock, over = {}) => ({ readyState: 4, videoWidth: 640, videoHeight: 480, srcObject: null, removed: false, play: async () => {}, pause() {}, remove() { this.removed = true }, get currentTime() { return clock.now() / 1000 }, ...over })

function fakeVision({ gpuFails = false, gpuDetectThrows = false, result } = {}) {
  const created = []
  return {
    created,
    FilesetResolver: { forVisionTasks: async (base) => ({ base }) },
    HandLandmarker: {
      createFromOptions: async (fileset, o) => {
        if (gpuFails && o.baseOptions.delegate === 'GPU') throw new Error('no webgl')
        const lm = {
          opts: o, fileset, closed: false, calls: [],
          close() { this.closed = true },
          detectForVideo(v, ts) {
            this.calls.push(ts)
            if (gpuDetectThrows && o.baseOptions.delegate === 'GPU') throw new Error('gl lost')
            return { landmarks: result === null ? [] : [result || place(POSES.openPalm())] }
          },
        }
        created.push(lm)
        return lm
      },
    },
  }
}

function harness(over = {}) {
  const clock = fakeClock()
  const streams = [], videos = [], statuses = [], frames = []
  const h = { clock, streams, videos, statuses, frames, hidden: false, ar: null, gum: [], vision: over.vision || fakeVision(), visCbs: new Set(), online: true, gumError: null, importError: null }
  const env = {
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    importVision: async () => { if (h.importError) throw h.importError; return h.vision },
    getUserMedia: async (c) => { h.gum.push(c); if (h.gumError) throw h.gumError; const s = fakeStream(); streams.push(s); return s },
    getArVideo: () => h.ar,
    createVideo: () => { const v = fakeVideo(clock); videos.push(v); return v },
    isHidden: () => h.hidden,
    onVisibility: (cb) => { h.visCbs.add(cb); return () => h.visCbs.delete(cb) },
    isOnline: () => h.online,
    support: () => ({ ok: true, code: null }),
    loadTimeoutMs: 1e9,
    ...(over.env || {}),
  }
  h.rt = createHandsRuntime({ env, onStatus: (p) => statuses.push(p), onFrame: (lm, now, info) => frames.push({ lm, now, info }) })
  h.setHidden = async (v) => { h.hidden = v; for (const cb of h.visCbs) cb(); await flush() }
  h.last = (k) => { for (let i = statuses.length - 1; i >= 0; i--) if (k in statuses[i]) return statuses[i][k]; return undefined }
  h.lm = () => h.vision.created[h.vision.created.length - 1]
  return h
}

test('支援性檢查：非 HTTPS / 沒有 getUserMedia / 沒有 WebAssembly 各有原因碼；正常 → ok', () => {
  const okNav = { mediaDevices: { getUserMedia() {} } }
  assert.deepEqual(gestureSupport({ isSecureContext: true, navigator: okNav, WebAssembly: {} }), { ok: true, code: null })
  assert.equal(gestureSupport({ isSecureContext: false, navigator: {}, WebAssembly: {} }).code, 'insecure')
  assert.equal(gestureSupport({ isSecureContext: true, navigator: {}, WebAssembly: {} }).code, 'no-camera-api')
  assert.equal(gestureSupport({ isSecureContext: true, navigator: okNav }).code, 'no-wasm')
  for (const code of ['insecure', 'no-camera-api', 'no-wasm', 'denied', 'no-camera', 'busy', 'offline', 'load', 'lost', 'detect', 'camera']) assert.ok(/[㐀-鿿]/.test(errorKey(code)), code)
})

test('資源網址：WASM 走 jsDelivr（版本一致）、模型走 Google 官方 storage', () => {
  assert.match(WASM_BASE, /^https:\/\/cdn\.jsdelivr\.net\/npm\/@mediapipe\/tasks-vision@\d+\.\d+\.\d+\/wasm$/)
  assert.equal(MODEL_URL, 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task')
})

test('狀態標籤：張手 / 捏合有名稱，其餘（idle / other）顯示 —', () => {
  const t = (k) => k
  assert.equal(stateLabel(t, 'open_palm'), '張手')
  assert.equal(stateLabel(t, 'pinch'), '捏合')
  assert.equal(stateLabel(t, 'idle'), '—')
  assert.equal(stateLabel(t, 'other'), '—')
})

test('setGestureEnabled：不支援的環境（node 沒有相機）→ 不啟用並留下原因；關閉 → 回到 off', () => {
  assert.equal(setGestureEnabled(true), false)
  let s = useHandsStore.getState()
  assert.equal(s.enabled, false); assert.equal(s.phase, 'error'); assert.ok(s.error && s.error.code)
  setGestureEnabled(false)
  s = useHandsStore.getState()
  assert.equal(s.phase, 'off'); assert.equal(s.error, null); assert.equal(s.camera, null)
})

test('自己開相機：前鏡頭 640x480、只開一次；載入完成後 ≤15fps 偵測；stop 停掉 track、移除 video、關閉 landmarker', async () => {
  const h = harness()
  await h.rt.start(); await h.clock.advance(50)
  assert.equal(h.gum.length, 1)
  assert.deepEqual(h.gum[0], { video: { facingMode: 'user', width: 640, height: 480 }, audio: false })
  assert.equal(h.last('phase'), 'running'); assert.equal(h.last('camera'), 'own'); assert.equal(h.last('delegate'), 'GPU')
  const lm = h.lm()
  assert.deepEqual({ v: lm.opts.runningMode, n: lm.opts.numHands, m: lm.opts.baseOptions.modelAssetPath }, { v: 'VIDEO', n: 1, m: MODEL_URL })
  assert.equal(lm.fileset.base, WASM_BASE)

  await h.clock.advance(3000)
  const ts = lm.calls
  assert.ok(ts.length >= 30 && ts.length <= 46, `3 秒內偵測 ${ts.length} 次`)
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= DETECT_INTERVAL_MS, `間隔 ${ts[i] - ts[i - 1]}`)
  assert.ok(ts.every((v, i) => i === 0 || v > ts[i - 1]), '時間戳嚴格遞增')
  const withHand = h.frames.filter((f) => f.lm)
  assert.ok(withHand.length > 20 && Math.abs(withHand[0].info.aspect - 640 / 480) < 1e-9)

  h.rt.stop()
  assert.ok(h.streams[0].tracks.every((tr) => tr.stopped), '停掉所有 track')
  assert.equal(h.videos[0].removed, true); assert.equal(h.videos[0].srcObject, null)
  assert.equal(lm.closed, true)
  assert.equal(h.last('phase'), 'off')
  const n = lm.calls.length
  await h.clock.advance(1000)
  assert.equal(lm.calls.length, n, 'stop 之後不再偵測')
  assert.equal(h.clock.pending(), 0, '沒有殘留計時器')
  h.rt.stop()   // 可重複呼叫
})

// 有 requestVideoFrameCallback 的相機：依影像幀節奏被叫醒，仍要維持 ≤15fps
function rvfcVideo(clock, fps) {
  const period = 1000 / fps
  let n = 0
  const ids = new Map()
  return fakeVideo(clock, {
    requestVideoFrameCallback(cb) {
      const id = ++n
      const at = (Math.floor(clock.now() / period + 1e-9) + 1) * period
      ids.set(id, clock.setTimeout(() => cb(), Math.max(0, at - clock.now())))
      return id
    },
    cancelVideoFrameCallback(id) { clock.clearTimeout(ids.get(id)); ids.delete(id) },
  })
}

test('有 requestVideoFrameCallback：15 / 24 / 30 / 60 / 120 fps 的相機都不超過 ≈15fps，30fps 相機約 15fps', async () => {
  for (const fps of [15, 24, 30, 60, 120]) {
    let h
    h = harness({ env: { createVideo: () => { const v = rvfcVideo(h.clock, fps); h.videos.push(v); return v } } })
    await h.rt.start(); await h.clock.advance(100)
    const lm = h.lm(); const n0 = lm.calls.length
    await h.clock.advance(4000)
    const calls = lm.calls.slice(n0)
    const rate = calls.length / 4
    assert.ok(rate <= 15.6 && rate >= 9, `${fps}fps 相機 → 偵測 ${rate.toFixed(1)}/s`)
    if (fps === 30 || fps === 60) assert.ok(rate >= 14, `${fps}fps 相機應接近 15fps：${rate}`)
    for (let i = 1; i < calls.length; i++) assert.ok(calls[i] - calls[i - 1] >= DETECT_INTERVAL_MS - 2 - 1e-6, `${fps}fps 間隔 ${calls[i] - calls[i - 1]}`)
    h.rt.stop()
    assert.equal(h.clock.pending(), 0, `${fps}fps：stop 後沒有殘留計時器`)
  }
})

test('rVFC 永遠不觸發（影片被瀏覽器暫停 / 隱藏）時，保底計時器仍讓偵測持續', async () => {
  let h
  h = harness({ env: { createVideo: () => { const v = fakeVideo(h.clock, { requestVideoFrameCallback: () => 1, cancelVideoFrameCallback() {} }); h.videos.push(v); return v } } })
  await h.rt.start(); await h.clock.advance(100)
  const n0 = h.lm().calls.length
  await h.clock.advance(2000)
  assert.ok(h.lm().calls.length - n0 >= 25)
  h.rt.stop()
})

test('AR 實景已開：直接重用 arState.video，不開第二個相機；stop 不碰 AR 的串流', async () => {
  const h = harness()
  const arStream = fakeStream()
  h.ar = fakeVideo(h.clock, { srcObject: arStream })
  await h.rt.start(); await h.clock.advance(500)
  assert.equal(h.gum.length, 0)
  assert.equal(h.last('camera'), 'shared')
  assert.ok(h.lm().calls.length > 3)
  h.rt.stop()
  assert.ok(arStream.tracks.every((tr) => !tr.stopped), 'AR 的 track 不是我們的，不能停')
  assert.equal(h.ar.removed, false); assert.ok(h.ar.srcObject === arStream)
})

test('AR 中途開啟 → 改共用並放掉自己的相機；AR 關閉 → 重新開自己的', async () => {
  const h = harness()
  await h.rt.start(); await h.clock.advance(300)
  assert.equal(h.last('camera'), 'own'); assert.equal(h.gum.length, 1)
  h.ar = fakeVideo(h.clock, { srcObject: fakeStream() })
  await h.clock.advance(300)
  assert.equal(h.last('camera'), 'shared')
  assert.ok(h.streams[0].tracks.every((tr) => tr.stopped), '改共用後放掉自己的相機')
  assert.equal(h.gum.length, 1)
  h.ar = null                                              // 實景關閉
  await h.clock.advance(300)
  assert.equal(h.gum.length, 2, '重新開自己的相機')
  assert.equal(h.last('camera'), 'own')
  assert.ok(h.frames.some((f) => f.info && f.info.reset), '換來源時通知狀態機重置')
  const before = h.lm().calls.length
  await h.clock.advance(500)
  assert.ok(h.lm().calls.length > before, '之後繼續偵測')
  h.rt.stop()
  assert.ok(h.streams[1].tracks.every((tr) => tr.stopped))
})

test('GPU 建不起來 → 退 CPU；GPU 偵測丟例外 → 以 CPU 重建並繼續', async () => {
  const a = harness({ vision: fakeVision({ gpuFails: true }) })
  await a.rt.start(); await a.clock.advance(200)
  assert.equal(a.last('delegate'), 'CPU'); assert.equal(a.last('phase'), 'running')
  a.rt.stop()

  const v = fakeVision({ gpuDetectThrows: true })
  const b = harness({ vision: v })
  await b.rt.start(); await b.clock.advance(1000)
  assert.equal(v.created.length, 2)
  assert.equal(v.created[0].closed, true, '舊的 GPU landmarker 要關掉')
  assert.equal(v.created[1].opts.baseOptions.delegate, 'CPU')
  assert.equal(b.last('delegate'), 'CPU')
  assert.ok(v.created[1].calls.length > 5, '改用 CPU 後持續偵測')
  b.rt.stop()
})

test('相機被拒絕 → error denied；不下載模型、不留殘餘', async () => {
  const h = harness()
  h.gumError = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
  await h.rt.start(); await h.clock.advance(200)
  assert.equal(h.last('phase'), 'error'); assert.equal(h.last('error').code, 'denied')
  assert.equal(h.vision.created.length, 0, '相機沒過就不建模型（省 8MB 下載）')
  assert.equal(h.clock.pending(), 0)
})

test('找不到相機 / 相機被占用 → 對應的原因碼', async () => {
  for (const [name, code] of [['NotFoundError', 'no-camera'], ['NotReadableError', 'busy'], ['WeirdError', 'camera']]) {
    const h = harness(); h.gumError = Object.assign(new Error('x'), { name })
    await h.rt.start(); await h.clock.advance(50)
    assert.equal(h.last('error').code, code, name)
  }
})

test('OverconstrainedError（裝置不支援指定解析度 / 鏡頭）→ 放寬條件重試一次', async () => {
  let n = 0, h
  const env = { getUserMedia: async (c) => { h.gum.push(c); if (n++ === 0) throw Object.assign(new Error('x'), { name: 'OverconstrainedError' }); const s = fakeStream(); h.streams.push(s); return s } }
  h = harness({ env })
  await h.rt.start(); await h.clock.advance(100)
  assert.equal(h.last('phase'), 'running')
  assert.deepEqual(h.gum[1], { video: true, audio: false })
  h.rt.stop()
})

test('載入期間就 stop：晚到的相機串流與 landmarker 都會被放掉', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  let h
  h = harness({ env: { getUserMedia: async () => { await gate; const s = fakeStream(); h.streams.push(s); return s } } })
  const started = h.rt.start()
  await flush()
  h.rt.stop()
  release(); await started; await h.clock.advance(200)
  assert.ok(h.streams[0].tracks.every((tr) => tr.stopped), '停止後才拿到的相機立刻停掉')
  assert.equal(h.vision.created.length, 0)
  assert.equal(h.videos.length, 0)
})

test('模型載入到一半 stop：建好的 landmarker 會被關閉', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const v = fakeVision()
  const orig = v.HandLandmarker.createFromOptions
  v.HandLandmarker.createFromOptions = async (fs, o) => { await gate; return orig(fs, o) }
  const h = harness({ vision: v })
  const started = h.rt.start()
  await h.clock.advance(50)
  h.rt.stop()
  release(); await started; await h.clock.advance(100)
  assert.equal(v.created.length, 1); assert.equal(v.created[0].closed, true)
  assert.ok(h.streams[0].tracks.every((tr) => tr.stopped))
})

test('離線時載入失敗 → offline；線上載入失敗 → load；失敗都會釋放相機', async () => {
  const a = harness(); a.importError = new Error('Failed to fetch'); a.online = false
  await a.rt.start(); await a.clock.advance(50)
  assert.equal(a.last('error').code, 'offline'); assert.ok(a.streams[0].tracks.every((tr) => tr.stopped))
  const b = harness(); b.importError = new Error('boom')
  await b.rt.start(); await b.clock.advance(50)
  assert.equal(b.last('error').code, 'load'); assert.ok(b.streams[0].tracks.every((tr) => tr.stopped))
  assert.equal(b.last('phase'), 'error')
})

test('頁面隱藏 → 暫停偵測並通知重置；回到前景 → 繼續', async () => {
  const h = harness()
  await h.rt.start(); await h.clock.advance(500)
  const lm = h.lm()
  await h.setHidden(true)
  assert.ok(h.frames.some((f) => f.info && f.info.reset && f.lm === null))
  const n = lm.calls.length
  await h.clock.advance(2000)
  assert.equal(lm.calls.length, n, '隱藏期間不偵測')
  assert.equal(h.clock.pending(), 0, '隱藏期間沒有計時器在跑')
  await h.setHidden(false); await h.clock.advance(500)
  assert.ok(lm.calls.length > n, '回到前景後恢復')
  h.rt.stop()
  assert.equal(h.visCbs.size, 0, '可見性監聽要取消')
})

test('相機 track 中途結束（被系統收走）→ error lost 並釋放', async () => {
  const h = harness()
  await h.rt.start(); await h.clock.advance(300)
  h.streams[0].tracks[0].onended()
  assert.equal(h.last('error').code, 'lost'); assert.equal(h.last('phase'), 'error')
  assert.ok(h.streams[0].tracks.every((tr) => tr.stopped)); assert.equal(h.lm().closed, true)
  const n = h.lm().calls.length
  await h.clock.advance(500)
  assert.equal(h.lm().calls.length, n)
})

test('偵測連續失敗（CPU）→ error detect；onFrame 丟例外不會讓迴圈停掉', async () => {
  const v = fakeVision()
  const orig = v.HandLandmarker.createFromOptions
  v.HandLandmarker.createFromOptions = async (fs, o) => { const lm = await orig(fs, { ...o, baseOptions: { ...o.baseOptions, delegate: 'CPU' } }); lm.detectForVideo = () => { throw new Error('inference failed') }; return lm }
  const h = harness({ vision: v })
  await h.rt.start(); await h.clock.advance(1500)
  assert.equal(h.last('phase'), 'error'); assert.equal(h.last('error').code, 'detect')

  const h2 = harness()
  h2.rt = createHandsRuntime({ env: { ...{ now: h2.clock.now, setTimeout: h2.clock.setTimeout, clearTimeout: h2.clock.clearTimeout, importVision: async () => h2.vision, getUserMedia: async () => { const s = fakeStream(); h2.streams.push(s); return s }, getArVideo: () => null, createVideo: () => fakeVideo(h2.clock), isHidden: () => false, onVisibility: () => () => {}, isOnline: () => true, support: () => ({ ok: true }), loadTimeoutMs: 1e9 } }, onFrame: () => { throw new Error('boom') }, onStatus: () => {} })
  await h2.rt.start(); await h2.clock.advance(1000)
  assert.ok(h2.lm().calls.length > 10, 'onFrame 例外不影響偵測')
  h2.rt.stop()
})
