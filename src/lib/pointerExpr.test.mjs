// 觸控筆壓力 / 傾斜（lib/pointerExpr.js）單元測試。執行：node --test src/lib/pointerExpr.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PEN_CFG, isPen, pressureToForce, createPenForce, tiltFromAltAz, readTilt, tiltToUnit, tiltToFlow, createPenFlow,
} from './pointerExpr.js'

const pen = (o = {}) => ({ pointerType: 'pen', pointerId: 7, pressure: 0.5, tiltX: 0, tiltY: 0, buttons: 1, ...o })
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`)

// ── pointerType 判斷 ──
test('isPen：只有 pen 為真；滑鼠 / 手指 / 空值都不是', () => {
  assert.equal(isPen({ pointerType: 'pen' }), true)
  for (const t of ['mouse', 'touch', '', undefined]) assert.equal(isPen({ pointerType: t }), false)
  assert.equal(isPen(null), false); assert.equal(isPen(undefined), false)
})

// ── 壓力 → 浪勁 ──
test('pressureToForce：0.5 為錨點 = 1；0 端→ forceMin、1 端→ forceMax；單調遞增', () => {
  near(pressureToForce(0.5), 1)
  near(pressureToForce(1), PEN_CFG.forceMax)
  near(pressureToForce(0.0001), PEN_CFG.forceMin, 0.001)
  let prev = -Infinity
  for (let p = 0.01; p <= 1.0001; p += 0.01) { const f = pressureToForce(p); assert.ok(f > prev, `p=${p}`); prev = f }
  near(pressureToForce(1.7), PEN_CFG.forceMax)                    // 超出範圍夾住
})
test('pressureToForce：無壓力資料（undefined / NaN / 0 / 負數 / 非數字）→ 1，行為與現在相同', () => {
  for (const v of [undefined, null, NaN, Infinity, 0, -0.3, '0.9']) assert.equal(pressureToForce(v), 1, String(v))
})

test('createPenForce：非筆（滑鼠 / 手指）恆為 1，即使 pressure 很大', () => {
  const f = createPenForce()
  for (const type of ['mouse', 'touch']) {
    assert.equal(f.down({ pointerType: type, pointerId: 1, pressure: 1 }), false)
    assert.equal(f.move({ pointerType: type, pointerId: 1, pressure: 1 }), 1)
    assert.equal(f.active, false)
  }
})
test('createPenForce：筆的壓力有平滑（突然重壓不會一步到位），並收斂到目標', () => {
  const f = createPenForce({ pressureAlpha: 0.35 })
  f.down(pen({ pressure: 0.5 }))
  near(f.move(pen({ pressure: 0.5 })), 1)
  const first = f.move(pen({ pressure: 1 }))
  assert.ok(first > 1 && first < PEN_CFG.forceMax, `第一步 ${first} 應介於 1 與 ${PEN_CFG.forceMax}`)
  let last = first
  for (let i = 0; i < 40; i++) last = f.move(pen({ pressure: 1 }))
  near(last, PEN_CFG.forceMax, 0.01)
  for (let i = 0; i < 60; i++) last = f.move(pen({ pressure: 0.2 }))
  assert.ok(last < 1, '放輕後回到小於 1')
})
test('createPenForce：down 以第一筆壓力起頭；up 後歸零重來；不同 pointerId 不互相干擾', () => {
  const f = createPenForce()
  f.down(pen({ pressure: 0.9 }))
  near(f.smoothed, 0.9)
  near(f.move(pen({ pressure: 0.9 })), pressureToForce(0.9))
  assert.equal(f.move(pen({ pointerId: 99, pressure: 0.1 })), 1)      // 另一支筆：不算
  near(f.smoothed, 0.9)
  f.up(pen({ pointerId: 99 })); assert.equal(f.active, true)           // 別人的 up 不會結束我
  f.up(pen()); assert.equal(f.active, false); assert.equal(f.smoothed, null)
  f.down(pen({ pressure: 0.2 })); near(f.smoothed, 0.2)
})
test('createPenForce：筆回報 pressure=0 / 缺值 → 沿用上一個平滑值（沒有就 1）', () => {
  const f = createPenForce()
  f.down(pen({ pressure: 0 }))
  assert.equal(f.move(pen({ pressure: 0 })), 1)
  assert.equal(f.move(pen({ pressure: undefined })), 1)
  f.move(pen({ pressure: 0.8 }))
  const keep = f.move(pen({ pressure: 0 }))
  near(keep, pressureToForce(0.8))
})

// ── 傾斜換算 ──
test('tiltToUnit：死區為 0、滿刻度 ±1、保留正負號、連續', () => {
  assert.equal(tiltToUnit(0), 0)
  assert.equal(tiltToUnit(PEN_CFG.tiltDead), 0)
  assert.equal(tiltToUnit(-PEN_CFG.tiltDead), 0)
  near(tiltToUnit(PEN_CFG.tiltMax), 1); near(tiltToUnit(-PEN_CFG.tiltMax), -1)
  near(tiltToUnit(89), 1); near(tiltToUnit(-89), -1)
  const mid = (PEN_CFG.tiltDead + PEN_CFG.tiltMax) / 2
  near(tiltToUnit(mid), 0.5); near(tiltToUnit(-mid), -0.5)
  assert.equal(tiltToUnit(NaN), 0); assert.equal(tiltToUnit(undefined), 0)
})
test('tiltToFlow：兩軸都在死區 → null；右倒 → flowX>0.5；朝使用者倒 → flowY>0.5；映到 0..1', () => {
  assert.equal(tiltToFlow(0, 0), null)
  assert.equal(tiltToFlow(3, -4), null)
  const r = tiltToFlow(PEN_CFG.tiltMax, 0)
  near(r.x, 1); near(r.y, 0.5)
  const l = tiltToFlow(-PEN_CFG.tiltMax, 0); near(l.x, 0)
  const d = tiltToFlow(0, PEN_CFG.tiltMax); near(d.x, 0.5); near(d.y, 1)
  const u = tiltToFlow(0, -PEN_CFG.tiltMax); near(u.y, 0)
  const diag = tiltToFlow(90, 90); near(diag.x, 1); near(diag.y, 1)
})
test('tiltFromAltAz / readTilt：只給 altitude+azimuth 的環境（Apple Pencil）也能換出傾斜；垂直 → 0', () => {
  const up = tiltFromAltAz(Math.PI / 2, 0); near(up.tiltX, 0); near(up.tiltY, 0)
  const right = tiltFromAltAz(Math.PI / 4, 0); near(right.tiltX, 45, 1e-6); near(right.tiltY, 0, 1e-6)      // azimuth 0 = 朝 +X 倒
  const down = tiltFromAltAz(Math.PI / 4, Math.PI / 2); near(down.tiltX, 0, 1e-6); near(down.tiltY, 45, 1e-6)  // azimuth π/2 = 朝 +Y（使用者）倒
  assert.deepEqual(tiltFromAltAz(NaN, 0), { tiltX: 0, tiltY: 0 })
  assert.deepEqual(readTilt({ tiltX: 12, tiltY: -5 }), { tiltX: 12, tiltY: -5 })                         // 有 tiltX/Y 就用它
  const alt = readTilt({ tiltX: 0, tiltY: 0, altitudeAngle: Math.PI / 4, azimuthAngle: 0 }); near(alt.tiltX, 45, 1e-6)
  assert.deepEqual(readTilt({ tiltX: 0, tiltY: 0, altitudeAngle: Math.PI / 2, azimuthAngle: 1 }), { tiltX: 0, tiltY: 0 })   // 垂直：不推算
  assert.deepEqual(readTilt(null), { tiltX: 0, tiltY: 0 })
})

// ── 洋流輸出器 ──
test('createPenFlow：只有筆、只在按下之後才輸出；hover / 沒 down / 滑鼠都不輸出', () => {
  const f = createPenFlow()
  assert.equal(f.move(pen({ tiltX: 45 }), 1000), null)               // 沒 down
  assert.equal(f.down({ pointerType: 'mouse', pointerId: 1 }), false)
  assert.equal(f.move({ pointerType: 'mouse', pointerId: 1, tiltX: 45, buttons: 1 }, 1000), null)
  assert.equal(f.down({ pointerType: 'touch', pointerId: 2 }), false)
  assert.equal(f.active, false)
  assert.equal(f.down(pen()), true); assert.equal(f.active, true)
  const out = f.move(pen({ tiltX: 45 }), 1000)
  assert.ok(out && out.flowX > 0.5, '按下後右倒 → 輸出')
  f.up(pen()); assert.equal(f.active, false)
  assert.equal(f.move(pen({ tiltX: 45 }), 2000), null)               // up 之後不輸出
})
test('createPenFlow：hover（buttons=0）不輸出，並自我收回（up 事件掉了也不會卡住）', () => {
  const f = createPenFlow()
  f.down(pen())
  assert.equal(f.move(pen({ tiltX: 45, buttons: 0 }), 1000), null)
  assert.equal(f.active, false)
})
test('createPenFlow：另一支筆 / 其他 pointerId 的事件不影響', () => {
  const f = createPenFlow()
  f.down(pen({ pointerId: 7 }))
  assert.equal(f.move(pen({ pointerId: 8, tiltX: 45 }), 1000), null)
  f.up(pen({ pointerId: 8 })); assert.equal(f.active, true)
  assert.ok(f.move(pen({ pointerId: 7, tiltX: 45 }), 1000))
})
test('createPenFlow：立著（死區）不輸出、也不把洋流打回中央；沒有傾斜資料的筆完全不輸出', () => {
  const f = createPenFlow()
  f.down(pen())
  for (let t = 0; t < 20; t++) assert.equal(f.move(pen({ tiltX: 2, tiltY: -3 }), 1000 + t * 100), null)
  const g = createPenFlow(); g.down(pen())
  for (let t = 0; t < 20; t++) assert.equal(g.move(pen({ tiltX: undefined, tiltY: undefined }), 1000 + t * 100), null)
})
test('createPenFlow：節流 ≤ 20 次/秒（每 10ms 一個事件也一秒最多 20 筆）', () => {
  const f = createPenFlow()
  f.down(pen())
  let n = 0
  for (let ms = 0; ms < 1000; ms += 10) {
    const out = f.move(pen({ tiltX: 20 + (ms % 200) / 10, tiltY: 30 - (ms % 300) / 10 }), 5000 + ms)   // 傾斜一直在變
    if (out) n++
  }
  assert.ok(n > 0 && n <= 20, `一秒內輸出 ${n} 次`)
})
test('createPenFlow：輸出落在 0..1、平滑（起頭不跳）、變化太小不送', () => {
  const f = createPenFlow({ flowAlpha: 0.5 })
  f.down(pen())
  const a = f.move(pen({ tiltX: 90, tiltY: -90 }), 1000)
  assert.ok(a.flowX >= 0 && a.flowX <= 1 && a.flowY >= 0 && a.flowY <= 1)
  near(a.flowX, 1); near(a.flowY, 0)                                  // 起頭直接用目標，不從 0.5 慢慢爬
  const b = f.move(pen({ tiltX: 30, tiltY: -90 }), 1100)
  assert.ok(b.flowX < 1 && b.flowX > tiltToFlow(30, 0).x, '平滑：不會一步跳到新目標')
  assert.equal(f.move(pen({ tiltX: 30, tiltY: -90 }), 1100 + 20), null)   // 未滿 50ms
  const c = createPenFlow(); c.down(pen())
  assert.ok(c.move(pen({ tiltX: 40 }), 1000))
  assert.equal(c.move(pen({ tiltX: 40 }), 1100), null)                // 完全相同 → 不送
})
test('createPenFlow：離開死區重新傾斜時從新的目標起頭（不被舊平滑值拖著走）', () => {
  const f = createPenFlow({ flowAlpha: 0.2 })
  f.down(pen())
  f.move(pen({ tiltX: 60 }), 1000)
  assert.equal(f.move(pen({ tiltX: 0 }), 1100), null)                 // 立起來
  const back = f.move(pen({ tiltX: -60 }), 1200)
  near(back.flowX, 0)
})
