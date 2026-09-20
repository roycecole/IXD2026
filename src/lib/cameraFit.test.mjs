// 視角自動取景（lib/cameraFit.js）單元測試。執行：node --test src/lib/cameraFit.test.mjs
// 不開瀏覽器：用 three 的 PerspectiveCamera / Vector3 實際把球殼上的點投影到 NDC，驗證「整顆球可見、不縮太小」。
import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {
  FIT_FOV, FIT_RADIUS, FIT_BASE_DIST, FIT_MAX, FILL_RADIUS, FIT_MODES, DEFAULT_FIT_MODE, STATION_Z, STATION_HUD_PX,
  validAspect, halfAngles, fitDist, fitScale, aspectOf, rigTarget, createCameraRig, fitEnabled, shellScale, stationLayout,
  fitMode, modeRadius, planeYAtRow, stationPlacement,
} from './cameraFit.js'
import { readFileSync } from 'node:fs'

const SHELL = 2.02           // 與 Scene3D 的 SHELL 相同：球殼半徑
const TAN_V = Math.tan((FIT_FOV * Math.PI) / 360)
const ASPECTS = { '16:9': 16 / 9, '4:3': 4 / 3, '1:1': 1, '9:16': 9 / 16, '9:19.5': 9 / 19.5 }
const PHONE = { '375x812': 375 / 812, '390x844': 390 / 844, '412x915': 412 / 915, '360x800': 360 / 800 }

// 獨立於實作的解析式：球（半徑 r）在較窄方向剛好貼齊所需的距離 = r * sqrt(1 + t^2) / t，t = tan(半視角) 較小者
const refDist = (aspect, r = FIT_RADIUS, fovDeg = FIT_FOV) => {
  const tv = Math.tan((fovDeg * Math.PI) / 360)
  const t = Math.min(tv, tv * aspect)
  return (r * Math.sqrt(1 + t * t)) / t
}

// 球面上的均勻點（Fibonacci 球）
function spherePoints(n, r) {
  const pts = []
  const ga = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n, rr = Math.sqrt(1 - y * y), th = ga * i
    pts.push(new THREE.Vector3(Math.cos(th) * rr * r, y * r, Math.sin(th) * rr * r))
  }
  return pts
}

// 用真實 PerspectiveCamera 擺位（與 CameraRig 同一個 rigTarget 公式）→ 投影 → 回傳 NDC 極值
function project(aspect, { zoom = 0.5, fit, r = SHELL, n = 200 } = {}) {
  const f = fit === undefined ? fitScale({ aspect }) : fit
  const cam = new THREE.PerspectiveCamera(FIT_FOV, aspect, 0.1, 1000)
  const g = rigTarget(zoom, f)
  cam.position.set(g.x, g.y, g.z)
  cam.lookAt(0, 0, 0)
  cam.updateMatrixWorld(true)
  cam.updateProjectionMatrix()
  let mx = 0, my = 0, behind = 0
  const v = new THREE.Vector3()
  for (const p of spherePoints(n, r)) {
    v.copy(p).project(cam)
    mx = Math.max(mx, Math.abs(v.x)); my = Math.max(my, Math.abs(v.y))
    // 相機後方 / 近平面外的點 project 後 z > 1：球在相機前方，這不應該發生
    if (v.z > 1 || v.z < -1) behind++
  }
  return { mx, my, behind, dist: cam.position.length(), fit: f }
}

test('halfAngles / validAspect：垂直半視角 = fov / 2；水平 = atan(tan(v) * aspect)；無效長寬比容錯', () => {
  const { v, h } = halfAngles(1)
  assert.ok(Math.abs(v - (22.5 * Math.PI) / 180) < 1e-12)
  assert.ok(Math.abs(h - v) < 1e-12)
  const w = halfAngles(16 / 9)
  assert.ok(w.h > w.v)
  const n = halfAngles(0.5)
  assert.ok(Math.abs(Math.tan(n.h) - TAN_V * 0.5) < 1e-12)
  for (const a of [0, -1, NaN, Infinity, -Infinity, undefined, null, '1.5', {}, [], true]) assert.equal(validAspect(a), false, String(a))
  for (const a of [0.2, 1, 3, 1e-9]) assert.equal(validAspect(a), true, String(a))
  // fov 亂給 → 退回 45
  assert.deepEqual(halfAngles(1, 0), halfAngles(1, 45))
  assert.deepEqual(halfAngles(1, 200), halfAngles(1, 45))
  assert.deepEqual(halfAngles(1, NaN), halfAngles(1, 45))
})

test('fitDist：16:9 / 4:3 / 1:1 由垂直方向決定（= r / sin(22.5°)），9:16 與 9:19.5 由水平方向決定', () => {
  const vert = FIT_RADIUS / Math.sin((22.5 * Math.PI) / 180)          // ≈ 6.3237
  for (const k of ['16:9', '4:3', '1:1']) {
    assert.ok(Math.abs(fitDist({ aspect: ASPECTS[k] }) - vert) < 1e-9, k)
    assert.ok(Math.abs(fitDist({ aspect: ASPECTS[k] }) - refDist(ASPECTS[k])) < 1e-9, k)
  }
  for (const k of ['9:16', '9:19.5']) {
    const d = fitDist({ aspect: ASPECTS[k] })
    assert.ok(Math.abs(d - refDist(ASPECTS[k])) < 1e-9, k)
    assert.ok(d > vert, k + ' 必須比垂直限制更遠')
  }
  assert.ok(Math.abs(fitDist({ aspect: 9 / 16 }) - 10.664) < 0.01)
  assert.ok(Math.abs(fitDist({ aspect: 9 / 19.5 }) - 12.889) < 0.01)
  // 極端：0.2 很遠；3 與 1 相同（垂直限制）
  assert.ok(Math.abs(fitDist({ aspect: 0.2 }) - refDist(0.2)) < 1e-9)
  assert.ok(Math.abs(fitDist({ aspect: 0.2 }) - 29.3) < 0.1)
  assert.ok(Math.abs(fitDist({ aspect: 3 }) - vert) < 1e-9)
})

test('fitDist：角半徑 asin(r / d) 剛好 = 較窄方向的半視角（球「剛好貼滿」）；margin / radius / fov 參數', () => {
  for (const a of [0.2, 0.3, 0.46, 0.5625, 0.75, 0.9, 1, 1.3, 1.78, 3]) {
    const d = fitDist({ aspect: a })
    const { v, h } = halfAngles(a)
    assert.ok(Math.abs(Math.asin(FIT_RADIUS / d) - Math.min(v, h)) < 1e-12, 'aspect ' + a)
  }
  // margin 是半徑倍數：1.1 → 距離 x1.1
  assert.ok(Math.abs(fitDist({ aspect: 0.5, margin: 1.1 }) / fitDist({ aspect: 0.5 }) - 1.1) < 1e-12)
  // radius 是線性的
  assert.ok(Math.abs(fitDist({ aspect: 0.5, radius: 4.84 }) / fitDist({ aspect: 0.5 }) - 2) < 1e-12)
  // 較大的 fov → 可視範圍變大 → 距離變近
  assert.ok(fitDist({ aspect: 0.5, fovDeg: 60 }) < fitDist({ aspect: 0.5, fovDeg: 45 }))
  assert.ok(Math.abs(fitDist({ aspect: 0.5, fovDeg: 60 }) - refDist(0.5, FIT_RADIUS, 60)) < 1e-9)
  // 無效 margin / radius → 預設
  assert.equal(fitDist({ aspect: 0.5, margin: 0 }), fitDist({ aspect: 0.5 }))
  assert.equal(fitDist({ aspect: 0.5, margin: NaN }), fitDist({ aspect: 0.5 }))
  assert.equal(fitDist({ aspect: 0.5, radius: -3 }), fitDist({ aspect: 0.5 }))
})

test('fitDist 容錯：aspect 為 0 / NaN / 負值 / Infinity / 缺省 → 當正方形（有限的正數），不丟例外', () => {
  const sq = fitDist({ aspect: 1 })
  for (const a of [0, -0, NaN, -1, -0.5, Infinity, -Infinity, undefined, null, 'x']) {
    const d = fitDist({ aspect: a })
    assert.ok(Number.isFinite(d) && d > 0, String(a))
    assert.equal(d, sq, String(a))
  }
  assert.equal(fitDist(), sq)
  assert.equal(fitDist({}), sq)
  // 極小的正長寬比：有限（內部下限），不會是 Infinity
  for (const a of [1e-3, 1e-9, 1e-300, Number.MIN_VALUE]) assert.ok(Number.isFinite(fitDist({ aspect: a })), String(a))
})

test('fitScale：寬螢幕（16:9 / 4:3 / 1:1 / 3）恆為 1 —— 與現況完全一致（用 === 比較，不是近似）', () => {
  for (const k of ['16:9', '4:3', '1:1']) assert.strictEqual(fitScale({ aspect: ASPECTS[k] }), 1, k)
  for (const a of [1.2, 1.5, 2, 2.4, 3, 5, 21 / 9, 32 / 9]) assert.strictEqual(fitScale({ aspect: a }), 1, String(a))
  // 邊界：長寬比約 0.95 以上不動
  const edge = TAN_V > 0 ? Math.tan(Math.asin(FIT_RADIUS / FIT_BASE_DIST)) / TAN_V : 0
  assert.ok(edge > 0.9 && edge < 1, 'edge ' + edge)
  assert.strictEqual(fitScale({ aspect: edge + 1e-6 }), 1)
  assert.ok(fitScale({ aspect: edge - 0.01 }) > 1)
})

test('fitScale：9:16 / 9:19.5 / 手機 / 極窄（0.2）倍率 > 1 且等於 fitDist / baseDist', () => {
  for (const [k, a] of [...Object.entries(ASPECTS).slice(3), ...Object.entries(PHONE), ['0.2', 0.2], ['0.46', 0.46], ['0.56', 0.56], ['0.75', 0.75]]) {
    const f = fitScale({ aspect: a })
    assert.ok(f > 1, k)
    assert.ok(Math.abs(f - fitDist({ aspect: a }) / FIT_BASE_DIST) < 1e-12, k)
  }
  assert.ok(Math.abs(fitScale({ aspect: 9 / 16 }) - 1.6158) < 0.001)
  assert.ok(Math.abs(fitScale({ aspect: 9 / 19.5 }) - 1.953) < 0.002)
  assert.ok(Math.abs(fitScale({ aspect: 0.2 }) - 4.44) < 0.01)
})

test('fitScale：長寬比越窄倍率越大（單調不增）；上限 FIT_MAX；margin / baseDist 參數', () => {
  let prev = Infinity
  for (let a = 0.03; a <= 4; a += 0.01) {
    const f = fitScale({ aspect: a })
    assert.ok(f >= 1 && f <= FIT_MAX, String(a))
    assert.ok(f <= prev + 1e-12, `aspect ${a} 倍率 ${f} 不該比更窄的 ${prev} 大`)
    prev = f
  }
  assert.equal(fitScale({ aspect: 0.02 }), FIT_MAX)
  assert.equal(fitScale({ aspect: 1e-6 }), FIT_MAX)
  assert.equal(fitScale({ aspect: 0.02, maxFit: 3 }), 3)
  assert.equal(fitScale({ aspect: 0.02, maxFit: 0.5 }), 1)              // 上限不可能 < 1
  assert.ok(fitScale({ aspect: 0.5, margin: 1.2 }) > fitScale({ aspect: 0.5 }))
  assert.ok(fitScale({ aspect: 0.5, baseDist: 13 }) < fitScale({ aspect: 0.5 }))
  assert.equal(fitScale({ aspect: 0.5, baseDist: 0 }), fitScale({ aspect: 0.5 }))   // 無效 baseDist → 預設
})

test('fitScale 容錯：aspect 為 0 / NaN / 負值 / Infinity / 缺省 → 1（不調整）', () => {
  for (const a of [0, -0, NaN, -1, -0.46, Infinity, -Infinity, undefined, null, 'x', {}]) assert.strictEqual(fitScale({ aspect: a }), 1, String(a))
  assert.strictEqual(fitScale(), 1)
  assert.strictEqual(fitScale({}), 1)
})

test('aspectOf：畫布尺寸 → 長寬比；任一邊 <= 0 / 非數字 → NaN', () => {
  assert.equal(aspectOf(375, 812), 375 / 812)
  assert.equal(aspectOf(1600, 900), 1600 / 900)
  for (const [w, h] of [[0, 800], [800, 0], [0, 0], [-1, 5], [5, -1], [NaN, 5], [5, NaN], [Infinity, 5], [undefined, 5], ['5', 5]]) assert.ok(Number.isNaN(aspectOf(w, h)), `${w},${h}`)
})

test('rigTarget：fit = 1 時與改版前公式逐位元相同；zoom 仍是比例運作；fit 沿同一條視線後退', () => {
  for (let z = -0.2; z <= 1.2; z += 0.05) {
    const g = rigTarget(z, 1)
    assert.strictEqual(g.z, 4.6 + (1 - z) * 4, String(z))
    assert.strictEqual(g.y, 0.4)
    assert.strictEqual(g.x, 0)
  }
  assert.strictEqual(rigTarget(0.5, 1).z, 6.6)
  assert.strictEqual(rigTarget(undefined).z, 6.6)                          // 預設 fit = 1、zoom 缺省 = 0.5
  assert.strictEqual(rigTarget(NaN, 1).z, 6.6)
  // fit > 1：z、y 同乘 → 視線方向（俯角）不變
  const f = 1.953
  const a = rigTarget(0.5, 1), b = rigTarget(0.5, f)
  assert.ok(Math.abs(b.z / a.z - f) < 1e-12 && Math.abs(b.y / a.y - f) < 1e-12)
  assert.ok(Math.abs(b.y / b.z - a.y / a.z) < 1e-12)
  // zoom 比例：z(zoom) / z(0.5) 與 fit 無關
  for (const zm of [0, 0.25, 0.75, 1]) assert.ok(Math.abs(rigTarget(zm, f).z / rigTarget(0.5, f).z - rigTarget(zm, 1).z / rigTarget(0.5, 1).z) < 1e-12)
  // 無效 fit（< 1 / NaN）→ 當 1（只拉遠不拉近）
  for (const bad of [0.5, 0, -2, NaN, undefined, null]) assert.deepEqual(rigTarget(0.5, bad), rigTarget(0.5, 1), String(bad))
})

test('真實投影：預設 zoom 0.5 在 0.46 / 0.56 / 1 / 1.78 四種長寬比，球殼 200 個點全部落在 NDC [-1, 1] 內', () => {
  for (const a of [0.46, 0.56, 1, 1.78]) {
    const r = project(a, { r: SHELL, n: 200 })
    assert.equal(r.behind, 0, 'aspect ' + a)
    assert.ok(r.mx <= 1 && r.my <= 1, `aspect ${a}：|x|max=${r.mx.toFixed(4)} |y|max=${r.my.toFixed(4)}`)
  }
})

test('真實投影：整個視覺半徑 2.42（含輝光 / 溢流水花）也完整落在 NDC 內，掃過 0.2 ~ 3 的長寬比與各手機尺寸', () => {
  const list = [0.2, 0.25, 0.3, 0.4, 0.46, 0.5, 0.5625, 0.6, 0.7, 0.75, 0.8, 0.9, 0.95, 1, 1.2, 4 / 3, 1.5, 16 / 9, 2, 2.4, 3, ...Object.values(PHONE), ...Object.values(ASPECTS)]
  for (const a of list) {
    const r = project(a, { r: FIT_RADIUS, n: 1500 })
    assert.equal(r.behind, 0, 'aspect ' + a)
    // 貼齊時最大值 ≈ 1（取樣點碰不到精確切點，只會 <= 1）；1e-9 容許浮點誤差
    assert.ok(r.mx <= 1 + 1e-9 && r.my <= 1 + 1e-9, `aspect ${a}：|x|max=${r.mx} |y|max=${r.my}`)
  }
})

test('球不縮太小：需要調整的窄畫布（倍率 > 1）球殼在較窄方向佔畫面 >= 82%；寬螢幕與現況距離相同', () => {
  const rows = []
  for (const a of [0.2, 0.3, 0.46, 0.56, 0.6, 0.75, 0.9, 1, 1.78]) {
    const r = project(a, { r: SHELL, n: 4000 })          // 4000 點：取樣誤差 < 0.1%
    const occ = Math.max(r.mx, r.my)                      // 較窄方向的佔比（NDC 半寬 = 1 為滿）
    const vis = project(a, { r: FIT_RADIUS, n: 4000 })
    rows.push(`aspect ${a.toFixed(3)}  fit ${r.fit.toFixed(3)}  dist ${r.dist.toFixed(3)}  球殼佔比 ${(occ * 100).toFixed(1)}%  視覺半徑佔比 ${(Math.max(vis.mx, vis.my) * 100).toFixed(1)}%`)
    // 倍率 > 1（窄畫布）：長寬比 <= 0.8 時球殼佔 >= 82%（貼齊視覺半徑 2.42 → 球殼理論上 83.5%）；
    // 剛進入調整的 0.8 ~ 0.95 過渡帶，透視使佔比略降到約 81.5%，仍 >= 81%。
    if (r.fit > 1) assert.ok(occ >= (a <= 0.8 ? 0.82 : 0.81), `aspect ${a}：球殼只佔 ${(occ * 100).toFixed(1)}%（fit ${r.fit}）`)
    // 倍率 = 1（寬螢幕）：距離與現況逐位元相同（球殼佔垂直方向約 77%，這是現況、規格要求不改變）
    else assert.equal(r.dist, Math.hypot(6.6, 0.4), `aspect ${a}：寬螢幕距離必須與現況相同`)
    // 視覺半徑（含輝光）在任何長寬比至少一個方向佔 >= 94%（沒有縮太小 / 也不會超出）
    assert.ok(Math.max(vis.mx, vis.my) >= 0.94, `aspect ${a}：視覺半徑佔比 ${Math.max(vis.mx, vis.my)}`)
  }
  console.log(rows.join('\n'))
})

test('zoom 在直式手機上仍可拉近拉遠（比例），預設 0.5 一定整顆可見；zoom 1 拉近會超出（使用者主動放大）', () => {
  const a = 9 / 19.5
  const zs = [0, 0.25, 0.5, 0.75, 1].map((zm) => project(a, { zoom: zm, r: SHELL }))
  for (let i = 1; i < zs.length; i++) assert.ok(zs[i].dist < zs[i - 1].dist, 'zoom 越大越近')
  assert.ok(zs[2].mx <= 1 && zs[2].my <= 1, 'zoom 0.5 整顆可見')
  assert.ok(zs[0].mx < zs[2].mx, 'zoom 0 更遠、球更小')
  assert.ok(zs[4].mx > zs[2].mx, 'zoom 1 更近、球更大')
  // 直式手機的 zoom 範圍是桌面的 fit 倍（同一比例）
  const fit = fitScale({ aspect: a })
  assert.ok(Math.abs(zs[4].dist / zs[0].dist - Math.hypot(4.6, 0.4) / Math.hypot(8.6, 0.4)) < 1e-9)   // 距離比與桌面完全相同（fit 只是整體倍率）
  assert.ok(Math.abs(zs[2].dist / Math.hypot(6.6, 0.4) - fit) < 1e-9)
})

test('最終相機距離（回報用）：各長寬比的 fit 倍率與 zoom 0.5 的相機到球心距離', () => {
  const out = {}
  for (const [k, a] of [['16:9', 16 / 9], ['1:1', 1], ['4:3', 4 / 3], ['0.75 平板直式', 0.75], ['9:16', 9 / 16], ['0.56', 0.56], ['0.46', 0.46], ['9:19.5', 9 / 19.5], ['0.2', 0.2], ['3', 3]]) {
    const f = fitScale({ aspect: a }), g = rigTarget(0.5, f)
    out[k] = `fit ${f.toFixed(3)}, z ${g.z.toFixed(2)}, 距離 ${Math.hypot(g.y, g.z).toFixed(2)}`
  }
  console.log(JSON.stringify(out, null, 1))
  assert.equal(out['16:9'], 'fit 1.000, z 6.60, 距離 6.61')
})

// ---- createCameraRig：第一幀就位 / lerp / 尺寸變了才重算 / 尚未量到尺寸 / ?fit=0 ----
const stepN = (rig, pos, args, n) => { let r; for (let i = 0; i < n; i++) r = rig.step(pos, args); return r }

test('CameraRig：第一幀直接就位（不從 z = 7 慢慢滑）；之後維持 lerp 0.06 的平滑', () => {
  const cam = new THREE.PerspectiveCamera(45, 375 / 812)
  cam.position.set(0, 0.4, 7)                                             // Canvas 預設位置
  const rig = createCameraRig()
  const phone = { width: 375, height: 812, zoom: 0.5, fovDeg: 45 }
  const r1 = rig.step(cam.position, phone)
  const want = rigTarget(0.5, fitScale({ aspect: 375 / 812 }))
  assert.strictEqual(cam.position.z, want.z)                              // 第一幀就是目標，不是 7
  assert.strictEqual(cam.position.y, want.y)
  assert.equal(r1.shown, r1.fit)
  // 第二幀：不動
  rig.step(cam.position, phone)
  assert.ok(Math.abs(cam.position.z - want.z) < 1e-12)
  // 改 zoom → 以 lerp 平滑逼近（第一步只走 6%）
  const z0 = cam.position.z
  const tgt = rigTarget(1, fitScale({ aspect: 375 / 812 }))
  rig.step(cam.position, { ...phone, zoom: 1 })
  assert.ok(Math.abs(cam.position.z - (z0 + (tgt.z - z0) * 0.06)) < 1e-12)
  stepN(rig, cam.position, { ...phone, zoom: 1 }, 600)
  assert.ok(Math.abs(cam.position.z - tgt.z) < 1e-9)
})

test('CameraRig：方向 / 視窗改變 → 倍率重算，相機平滑移到新位置（不是瞬間跳）；回到寬螢幕就回到 6.6', () => {
  const pos = { x: 0, y: 0.4, z: 7 }
  const rig = createCameraRig()
  const portrait = { width: 375, height: 812, zoom: 0.5, fovDeg: 45 }, land = { width: 812, height: 375, zoom: 0.5, fovDeg: 45 }
  rig.step(pos, portrait)
  const zp = pos.z
  assert.ok(zp > 12)
  const r = rig.step(pos, land)                                           // 轉橫
  assert.equal(r.fit, 1)
  assert.ok(pos.z < zp && pos.z > 6.6, '第一步只走一小段')
  assert.ok(zp - pos.z < (zp - 6.6) * 0.07)
  assert.ok(r.shown > 1.5, '霧倍率也跟著相機平滑（不是瞬間 1）')
  stepN(rig, pos, land, 600)
  assert.ok(Math.abs(pos.z - 6.6) < 1e-9 && Math.abs(pos.y - 0.4) < 1e-9)
  assert.ok(Math.abs(rig.step(pos, land).shown - 1) < 1e-9)
})

test('CameraRig：倍率只在尺寸改變時重算（同尺寸連續呼叫不再算 fitScale）', () => {
  // 尺寸相同 → fit 不變；換尺寸 → 變
  const pos = { x: 0, y: 0.4, z: 7 }
  const rig = createCameraRig()
  const a = rig.step(pos, { width: 400, height: 800, zoom: 0.5, fovDeg: 45 }).fit
  const b = rig.step(pos, { width: 400, height: 800, zoom: 0.5, fovDeg: 45 }).fit
  const c = rig.step(pos, { width: 400, height: 900, zoom: 0.5, fovDeg: 45 }).fit
  assert.equal(a, b)
  assert.ok(c > a)
})

test('CameraRig：尚未量到尺寸（0 / NaN）→ 不動也不就位；量到後的那一幀才就位', () => {
  const pos = { x: 0, y: 0.4, z: 7 }
  const rig = createCameraRig()
  for (const bad of [{ width: 0, height: 0 }, { width: 300, height: 0 }, { width: NaN, height: NaN }, {}, undefined]) {
    assert.equal(rig.step(pos, { ...(bad || {}), zoom: 0.5, fovDeg: 45 }), null)
    assert.deepEqual(pos, { x: 0, y: 0.4, z: 7 })
  }
  assert.equal(rig.step(pos), null)                                       // 完全沒參數也不丟例外
  const r = rig.step(pos, { width: 375, height: 812, zoom: 0.5, fovDeg: 45 })
  assert.ok(r && r.fit > 1.9)
  assert.strictEqual(pos.z, rigTarget(0.5, r.fit).z)                      // 量到的第一幀直接就位
})

test('CameraRig：enabled=false（?fit=0）→ 倍率恆為 1，相機與改版前完全相同（只有第一幀就位）', () => {
  const pos = { x: 0, y: 0.4, z: 7 }
  const rig = createCameraRig({ enabled: false })
  const r = rig.step(pos, { width: 375, height: 812, zoom: 0.5, fovDeg: 45 })
  assert.equal(r.fit, 1)
  assert.strictEqual(pos.z, 6.6)
  stepN(rig, pos, { width: 200, height: 900, zoom: 0.25, fovDeg: 45 }, 5)
  assert.ok(Math.abs(rig.step(pos, { width: 200, height: 900, zoom: 0.25, fovDeg: 45 }).fit - 1) < 1e-12)
})

test('CameraRig 用真的 THREE.Vector3 當 pos：位置與 lerp 結果跟 Vector3.lerp 完全一致（改版前的作法）', () => {
  const v = new THREE.Vector3(0, 0.4, 7), ref = new THREE.Vector3(0, 0.4, 6.6)
  const rig = createCameraRig()
  const args = { width: 1600, height: 900, zoom: 0.5, fovDeg: 45 }
  rig.step(v, args)                                                       // 就位（寬螢幕 → 6.6）
  ref.copy(v)
  const tmp = new THREE.Vector3()
  for (let i = 0; i < 40; i++) {
    const zoom = 0.5 + 0.4 * Math.sin(i / 5)
    rig.step(v, { ...args, zoom })
    tmp.set(0, 0.4, 4.6 + (1 - zoom) * 4); ref.lerp(tmp, 0.06)          // 改版前的 CameraRig
    assert.ok(Math.abs(v.z - ref.z) < 1e-12 && Math.abs(v.y - ref.y) < 1e-12 && v.x === 0)
  }
})

test('CameraRig 每幀呼叫是輕量的（不配置物件以外的昂貴運算）：10 萬幀 < 1 秒', () => {
  const pos = { x: 0, y: 0.4, z: 7 }
  const rig = createCameraRig()
  const args = { width: 375, height: 812, zoom: 0.5, fovDeg: 45 }
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < 100000; i++) rig.step(pos, args)
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  assert.ok(ms < 1000, `100000 幀用了 ${ms.toFixed(0)}ms`)
})

test('fitEnabled：?fit=0 / false / off / no（不分大小寫）關閉；沒有參數 / 其他值 / 壞掉的輸入 = 開（永不丟例外）', () => {
  for (const s of ['?fit=0', '?fit=false', '?fit=OFF', '?fit=No', '?x=1&fit=0', 'fit=0']) assert.equal(fitEnabled(s), false, s)
  for (const s of ['', '?fit', '?fit=1', '?fit=on', '?fit=true', '?fit=2', '?x=1', '?fits=0', '?kiosk=0']) assert.equal(fitEnabled(s), true, s)
  for (const s of [undefined, null, 0, {}, [], NaN]) assert.doesNotThrow(() => fitEnabled(s))
  assert.equal(fitEnabled(undefined), true)
})

// ---- 依相機的其他元素 ----
const camGeom = (aspect, zPlane) => {                                     // 與 MoonSky / StationStars 同式：相機在 z = fit * 6.6 前後，平面在 zPlane
  const fit = fitScale({ aspect }), camZ = rigTarget(0.5, fit).z
  const dist = Math.max(4, camZ - zPlane)
  const halfH = TAN_V * dist
  return { fit, camZ, dist, halfH, halfW: halfH * aspect, sphereR: 2.02 * (dist / Math.max(3, camZ)) }
}

test('MoonSky（Scene3D 同式：xr = clamp(halfW - 1.6, 2, 6.4)）：桌面與手機直式（>= 0.31）月亮圓盤（半徑 1.25）都完整在畫面內', () => {
  for (const a of [0.31, 0.4, 0.46, 0.5625, 0.75, 1, 4 / 3, 16 / 9, 3]) {
    const g = camGeom(a, -9)
    const xr = Math.max(2, Math.min(6.4, g.halfW - 1.6)), ymax = Math.max(1.5, g.halfH - 1.6)
    assert.ok(xr + 1.25 <= g.halfW + 1e-9, `aspect ${a}：月亮右緣 ${(xr + 1.25).toFixed(2)} > halfW ${g.halfW.toFixed(2)}`)
    assert.ok(Math.min(ymax, 0.6 + 3.4) + 1.25 <= g.halfH, `aspect ${a}：月亮上緣超出`)
  }
  // 沒有自動取景（?fit=0）的舊行為：直式手機月亮會被切（這正是拉遠要解的問題之一）
  const old = { halfH: TAN_V * (6.6 + 9) }
  old.halfW = old.halfH * 0.46
  assert.ok(Math.max(2, Math.min(6.4, old.halfW - 1.6)) + 1.25 > old.halfW)
})

test('stationLayout：長寬比 >= 0.95 與改版前公式完全相同（桌面 / 橫式 / 平板橫式不變）', () => {
  for (const a of [0.95, 1, 1.2, 4 / 3, 1.5, 16 / 9, 2, 21 / 9, 3]) {
    for (const zoom of [0, 0.25, 0.5, 0.75, 1]) {
      const fit = fitScale({ aspect: a }), camZ = rigTarget(zoom, fit).z
      const dist = Math.max(4, camZ + 10.5), halfH = TAN_V * dist, halfW = halfH * a, sphereR = 2.02 * (dist / Math.max(3, camZ))
      const lay = stationLayout({ halfW, halfH, sphereR, aspect: a })
      assert.strictEqual(lay.x, Math.max(2.4, Math.min(halfW - 1.5, sphereR + 1.4)), `aspect ${a} zoom ${zoom}`)
      assert.strictEqual(lay.y, -0.3)
      assert.strictEqual(lay.s, 1)
    }
  }
  // aspect 無效 → 也是原公式
  assert.deepEqual(stationLayout({ halfW: 10, halfH: 7, sphereR: 5, aspect: NaN }), { x: Math.max(2.4, Math.min(8.5, 6.4)), y: -0.3, s: 1 })
})

test('stationLayout：手機直式（0.46 / 0.5625 / 9:19.5 / 0.75）星座完整在畫面內、放在球的上方、中心不在球的投影範圍內（不被夾到球後面）', () => {
  for (const a of [0.3, 0.4, 0.46, 0.5, 0.5625, 0.6, 0.7, 0.75, 0.8]) {
    const g = camGeom(a, -10.5)
    const lay = stationLayout({ halfW: g.halfW, halfH: g.halfH, sphereR: g.sphereR, aspect: a })
    assert.ok(lay.s >= 0.3 && lay.s <= 1, `aspect ${a} s=${lay.s}`)
    const l = lay.x - 1.36 * lay.s, r = lay.x + 1.36 * lay.s, top = lay.y + 2.7 * lay.s, bot = lay.y - 2.7 * lay.s
    assert.ok(l >= -g.halfW && r <= g.halfW, `aspect ${a}：水平超出 [${l.toFixed(2)}, ${r.toFixed(2)}] vs ±${g.halfW.toFixed(2)}`)
    assert.ok(top <= g.halfH && bot >= -g.halfH, `aspect ${a}：垂直超出 [${bot.toFixed(2)}, ${top.toFixed(2)}] vs ±${g.halfH.toFixed(2)}`)
    assert.ok(Math.hypot(lay.x, lay.y) > g.sphereR, `aspect ${a}：星座中心 (${lay.x.toFixed(2)}, ${lay.y.toFixed(2)}) 在球投影半徑 ${g.sphereR.toFixed(2)} 內`)
    assert.ok(lay.y > 0, `aspect ${a}：在球上方`)
    // 大部分（>= 60% 高度）在球投影之外：下緣最多和球頂重疊 1.1 單位
    assert.ok(bot >= g.sphereR * 0.9 - 1.1 || top - g.sphereR >= 2 * 2.7 * lay.s * 0.6, `aspect ${a}：下緣 ${bot.toFixed(2)} 球頂 ${g.sphereR.toFixed(2)}`)
  }
})

test('stationLayout：長寬比連續變化時位置 / 縮放連續（拖曳分隔線 / 轉螢幕不會跳）', () => {
  let prev = null
  for (let a = 0.3; a <= 1.3; a += 0.002) {
    const g = camGeom(a, -10.5)
    const lay = stationLayout({ halfW: g.halfW, halfH: g.halfH, sphereR: g.sphereR, aspect: a })
    if (prev) {
      assert.ok(Math.abs(lay.x - prev.x) < 0.12, `aspect ${a.toFixed(3)} x 跳 ${Math.abs(lay.x - prev.x).toFixed(3)}`)
      assert.ok(Math.abs(lay.y - prev.y) < 0.12, `aspect ${a.toFixed(3)} y 跳 ${Math.abs(lay.y - prev.y).toFixed(3)}`)
      assert.ok(Math.abs(lay.s - prev.s) < 0.02, `aspect ${a.toFixed(3)} s 跳`)
    }
    prev = lay
  }
})

test('shellScale：桌面（相機 4.6 ~ 8.6）恆為 1；相機拉遠後星殼內緣仍在相機外 >= 3.3', () => {
  for (let z = 4.6; z <= 8.6; z += 0.1) {
    const d = Math.hypot(z, 0.4)
    assert.strictEqual(shellScale(d, 12), 1, `星空 z=${z.toFixed(1)}`)
    assert.strictEqual(shellScale(d, 16), 1, `銀河 z=${z.toFixed(1)}`)
  }
  for (const a of [0.2, 0.3, 0.46, 0.5625, 0.75]) {
    const fit = fitScale({ aspect: a })
    for (const zoom of [0, 0.5, 1]) {
      const g = rigTarget(zoom, fit), d = Math.hypot(g.y, g.z)
      for (const inner of [12, 16]) {
        const k = shellScale(d, inner)
        assert.ok(k >= 1)
        assert.ok(inner * k - d >= 3.3 - 1e-9, `aspect ${a} zoom ${zoom} 內緣 ${inner}：${(inner * k - d).toFixed(2)}`)
      }
    }
  }
  for (const bad of [NaN, undefined, null, 'x', -5]) assert.ok(shellScale(bad, 12) >= 1 && Number.isFinite(shellScale(bad, 12)), String(bad))
  assert.equal(shellScale(10, 0), 1)
  assert.equal(shellScale(10, NaN), 1)
})

// =============================================================================================
// 取景模式：'full'（完整含光暈，預設）/ 'fill'（球殼填滿較窄的那一邊）
// =============================================================================================
const PHONE_SIZES = [['375x812', 375, 812], ['390x844', 390, 844], ['412x915', 412, 915], ['360x800', 360, 800]]
const SIZE_TABLE = [...PHONE_SIZES, ['768x1024', 768, 1024], ['1024x768', 1024, 768], ['300x1000 (0.3)', 300, 1000], ['200x1000 (0.2)', 200, 1000]]

// 與加入 mode 之前完全相同的算式（獨立重寫一份，用來證明預設路徑逐位元不變）
const legacyFit = (aspect) => Math.min(Math.max(1, fitDist({ aspect, radius: FIT_RADIUS }) / FIT_BASE_DIST), FIT_MAX)

test('fitMode / modeRadius：只有 "fill" 是填滿，其餘（缺省 / 亂給）一律當 "full"；半徑 2.02 / 2.42', () => {
  assert.deepEqual(FIT_MODES, ['full', 'fill'])
  assert.equal(DEFAULT_FIT_MODE, 'full')
  assert.equal(fitMode('fill'), 'fill')
  for (const v of ['full', 'FILL', 'Fill', '', undefined, null, 0, 1, {}, [], 'x', true]) assert.equal(fitMode(v), 'full', String(v))
  assert.equal(FILL_RADIUS, SHELL)                                       // 與 Scene3D 的球殼半徑相同
  assert.equal(modeRadius('fill'), 2.02)
  assert.equal(modeRadius('full'), FIT_RADIUS)
  assert.equal(modeRadius(undefined), FIT_RADIUS)
})

test('fitScale mode = "full" / 缺省 / 亂給：與加入 mode 之前逐位元相同（0.02 ~ 5 全掃，用 strictEqual）', () => {
  for (let a = 0.02; a <= 5; a += 0.013) {
    const want = legacyFit(a)
    assert.strictEqual(fitScale({ aspect: a }), want, `預設 ${a}`)
    assert.strictEqual(fitScale({ aspect: a, mode: 'full' }), want, `full ${a}`)
    assert.strictEqual(fitScale({ aspect: a, mode: 'bogus' }), want, `bogus ${a}`)
    assert.strictEqual(fitScale({ aspect: a, mode: undefined }), want, `undefined ${a}`)
  }
  for (const a of [NaN, 0, -1, undefined]) assert.strictEqual(fitScale({ aspect: a, mode: 'fill' }), 1, '無效長寬比 fill：' + a)
})

test('fill：寬螢幕（長寬比 >= 0.95）兩種模式完全相同（fit === 1，與現況逐位元相同）；fill 更早（約 0.776）就回到 1', () => {
  for (let a = 0.952; a <= 6; a += 0.01) {                                // full 的邊界是 0.9515（既有測試）：從那裡起兩種模式都嚴格等於 1
    assert.strictEqual(fitScale({ aspect: a, mode: 'fill' }), 1, String(a))
    assert.strictEqual(fitScale({ aspect: a, mode: 'full' }), 1, String(a))
  }
  assert.strictEqual(fitScale({ aspect: 0.95, mode: 'fill' }), 1)
  assert.ok(fitScale({ aspect: 0.95, mode: 'full' }) - 1 < 0.0015, '0.95 ~ 0.9515 之間 full 只多拉遠 0.13%（肉眼看不出）')
  for (const a of [16 / 9, 4 / 3, 1, 21 / 9, 1024 / 768, 1600 / 900]) assert.strictEqual(fitScale({ aspect: a, mode: 'fill' }), fitScale({ aspect: a }), String(a))
  assert.strictEqual(fitScale({ aspect: 0.8, mode: 'fill' }), 1)
  assert.strictEqual(fitScale({ aspect: 0.9, mode: 'fill' }), 1)          // 過渡帶（0.78 ~ 0.95）：full 還在拉遠，fill 已經是 1
  assert.ok(fitScale({ aspect: 0.9, mode: 'full' }) > 1.04)
  assert.ok(fitScale({ aspect: 0.77, mode: 'fill' }) > 1)
})

test('fill 倍率表（回報用）：375x812 / 390x844 / 412x915 / 360x800 / 768x1024 / 1024x768 / 0.3 / 0.2 —— 與解析式一致，且 <= full', () => {
  const want = { '375x812': 1.629, '390x844': 1.628, '412x915': 1.669, '360x800': 1.670, '768x1024': 1.032, '1024x768': 1, '300x1000 (0.3)': 2.482, '200x1000 (0.2)': 3.707 }
  const rows = []
  for (const [k, w, h] of SIZE_TABLE) {
    const a = aspectOf(w, h)
    const fill = fitScale({ aspect: a, mode: 'fill' }), full = fitScale({ aspect: a, mode: 'full' })
    assert.ok(Math.abs(fill - want[k]) < 0.0006, `${k}：fill ${fill} vs ${want[k]}`)
    assert.ok(Math.abs(fill - Math.max(1, refDist(a, FILL_RADIUS) / FIT_BASE_DIST)) < 1e-12, k + ' 解析式')
    assert.ok(fill >= 1 && fill <= full + 1e-12, `${k}：fill ${fill} 必須落在 [1, full ${full}]`)
    rows.push(`${k.padEnd(16)} aspect ${a.toFixed(3)}  full ${full.toFixed(3)}  fill ${fill.toFixed(3)}  相機 z ${rigTarget(0.5, fill).z.toFixed(2)}（full ${rigTarget(0.5, full).z.toFixed(2)}）`)
  }
  console.log(rows.join('\n'))
})

test('fill：連續無跳變、單調（越窄越大）、<= full、上限 FIT_MAX；明確給 radius 時 radius 優先', () => {
  let prev = Infinity, prevF = null
  for (let a = 0.03; a <= 2; a += 0.001) {
    const f = fitScale({ aspect: a, mode: 'fill' }), full = fitScale({ aspect: a })
    assert.ok(f >= 1 && f <= FIT_MAX && f <= full + 1e-12, String(a))
    assert.ok(f <= prev + 1e-12, `aspect ${a} fill 倍率 ${f} 不該比更窄的 ${prev} 大`)
    if (prevF !== null) assert.ok(Math.abs(f - prevF) <= (1.2 * 0.001 * f) / a + 1e-12, `aspect ${a.toFixed(3)} 跳了 ${Math.abs(f - prevF)}`)   // 連續：長寬比每步 0.001，倍率 ∝ 1 / 長寬比，相對變化 <= 約 0.001 / a
    prev = f; prevF = f
  }
  assert.equal(fitScale({ aspect: 0.02, mode: 'fill' }), FIT_MAX)
  assert.equal(fitScale({ aspect: 0.02, mode: 'fill', maxFit: 3 }), 3)
  assert.equal(fitScale({ aspect: 0.5, mode: 'fill', radius: FIT_RADIUS }), fitScale({ aspect: 0.5 }))   // 明確的 radius 蓋過 mode
  assert.equal(fitScale({ aspect: 0.5, mode: 'fill', radius: -1 }), fitScale({ aspect: 0.5, mode: 'fill' }))   // 無效 radius → 用模式的半徑
})

test('真實投影（fill）：需要拉遠的窄畫布，球殼螢幕直徑 = 畫布寬度的 98 ~ 100%；含輝光的 2.42 被邊緣裁掉一圈；full 則整顆連光暈都在畫面內', () => {
  const rows = []
  for (const [k, w, h] of SIZE_TABLE) {
    const a = aspectOf(w, h)
    const fill = project(a, { r: SHELL, n: 5000, fit: fitScale({ aspect: a, mode: 'fill' }) })
    const glowFill = project(a, { r: FIT_RADIUS, n: 3000, fit: fitScale({ aspect: a, mode: 'fill' }) })
    const full = project(a, { r: SHELL, n: 5000, fit: fitScale({ aspect: a, mode: 'full' }) })
    const glowFull = project(a, { r: FIT_RADIUS, n: 3000, fit: fitScale({ aspect: a, mode: 'full' }) })
    const occ = Math.max(fill.mx, fill.my)
    assert.equal(fill.behind, 0, k)
    assert.ok(occ <= 1 + 1e-9, `${k}：球殼超出畫布 ${occ}`)                                        // 球殼永遠完整可見
    assert.ok(Math.max(glowFull.mx, glowFull.my) <= 1 + 1e-9, `${k}：full 的光暈應完整在畫面內`)
    if (fitScale({ aspect: a, mode: 'fill' }) > 1) {
      assert.ok(occ >= 0.98, `${k}：fill 球殼只佔寬度的 ${(occ * 100).toFixed(2)}%`)
      assert.ok(Math.max(glowFill.mx, glowFill.my) > 1.15, `${k}：fill 的光暈（2.42）應被邊緣裁掉，佔比 ${Math.max(glowFill.mx, glowFill.my).toFixed(3)}`)
      assert.ok(occ > Math.max(full.mx, full.my) * 1.15, `${k}：fill 的球應比 full 大至少 15%`)
    } else {
      assert.equal(fill.dist, full.dist, `${k}：不需要拉遠 → 兩種模式相機距離相同`)
    }
    rows.push(`${k.padEnd(16)} fill 球殼直徑 ${(occ * w).toFixed(0)}px（${(occ * 100).toFixed(1)}% 寬）  full ${(Math.max(full.mx, full.my) * w).toFixed(0)}px（${(Math.max(full.mx, full.my) * 100).toFixed(1)}%）  fill 光暈 ${(Math.max(glowFill.mx, glowFill.my) * 100).toFixed(0)}%`)
  }
  console.log(rows.join('\n'))
  // 375 寬：fill 約 375px、full 約 311px（規格書的背景數字）
  const p = project(375 / 812, { r: SHELL, n: 5000, fit: fitScale({ aspect: 375 / 812, mode: 'full' }) })
  assert.ok(Math.abs(Math.max(p.mx, p.my) * 375 - 311) < 3, '375 寬 full 約 311px')
})

test('真實投影（fill）：掃 0.2 ~ 3 的長寬比與各種 zoom 預設 0.5，球殼永遠整顆可見（不論模式）；寬螢幕距離與現況相同', () => {
  for (let a = 0.2; a <= 3; a += 0.05) {
    const r = project(a, { r: SHELL, n: 800, fit: fitScale({ aspect: a, mode: 'fill' }) })
    assert.equal(r.behind, 0, 'aspect ' + a)
    assert.ok(r.mx <= 1 + 1e-9 && r.my <= 1 + 1e-9, `aspect ${a}：|x|max=${r.mx} |y|max=${r.my}`)
    if (a >= 0.95) assert.equal(r.dist, Math.hypot(6.6, 0.4), `aspect ${a}：寬螢幕距離必須與現況相同`)
  }
})

test('fill 不會因為 fog / far plane / 星殼出問題：相機只比 full 更近；霧的近端佔比不高於 full；星殼 / 銀河外緣遠小於 far = 1000', () => {
  const clarities = [0, 0.5, 1]
  const foggy = (dist, fit, clar) => {                                    // FogDriver 同式：near = (3.5 - (1 - clar) * 1.5) * fit、far = (9 + clar * 6) * fit；水體（半徑 WR）最近點的霧濃度 0..1
    const near = (3.5 - (1 - clar) * 1.5) * fit, far = (9 + clar * 6) * fit
    return Math.min(1, Math.max(0, (dist - 1.95 * 0.985 - near) / (far - near)))
  }
  for (let a = 0.05; a <= 1.2; a += 0.025) {
    for (const zoom of [0, 0.5, 1]) {
      const ff = fitScale({ aspect: a, mode: 'fill' }), fu = fitScale({ aspect: a, mode: 'full' })
      const gFill = rigTarget(zoom, ff), gFull = rigTarget(zoom, fu)
      const dFill = Math.hypot(gFill.y, gFill.z), dFull = Math.hypot(gFull.y, gFull.z)
      assert.ok(dFill <= dFull + 1e-9, `aspect ${a} zoom ${zoom}：fill 相機不該比 full 遠`)
      for (const c of clarities) assert.ok(foggy(dFill, ff, c) <= foggy(dFull, fu, c) + 1e-9, `aspect ${a} zoom ${zoom} clar ${c}：fill 的霧不該比 full 濃`)
      for (const [inner, span] of [[12, 30], [16, 26]]) {                // Stars（半徑 12 ~ 42）/ Galaxy（16 ~ 42）
        const k = shellScale(dFill, inner)
        assert.ok(inner * k - dFill >= 3.3 - 1e-9, `星殼內緣仍在相機外 aspect ${a} zoom ${zoom}`)
        assert.ok((inner + span) * k + dFill < 1000, `星殼外緣 ${(inner + span) * k + dFill} 超過 far plane（R3F 預設 1000）`)
      }
    }
  }
})

test('MoonSky（Scene3D 同式）在 fill 模式：長寬比 >= 0.33 月亮圓盤（半徑 1.25）完整在畫面內（更窄的畫布與 full 一樣會被切一點，屬既有限制）', () => {
  const geom = (aspect, mode, zPlane = -9) => {
    const fit = fitScale({ aspect, mode }), camZ = rigTarget(0.5, fit).z, dist = Math.max(4, camZ - zPlane), halfH = TAN_V * dist
    return { halfH, halfW: halfH * aspect }
  }
  for (let a = 0.33; a <= 3; a += 0.03) {
    const g = geom(a, 'fill')
    const xr = Math.max(2, Math.min(6.4, g.halfW - 1.6)), ymax = Math.max(1.5, g.halfH - 1.6)
    assert.ok(xr + 1.25 <= g.halfW + 1e-9, `aspect ${a.toFixed(2)}：月亮右緣 ${(xr + 1.25).toFixed(2)} > halfW ${g.halfW.toFixed(2)}`)
    assert.ok(Math.min(ymax, 0.6 + 3.4) + 1.25 <= g.halfH, `aspect ${a.toFixed(2)}：月亮上緣超出`)
  }
  // 手機直式：月亮比 full 更靠中間（相機更近 → 可視半寬較小），但仍在畫面內
  const f = geom(375 / 812, 'full'), l = geom(375 / 812, 'fill')
  assert.ok(l.halfW < f.halfW)
  assert.ok(Math.max(2, Math.min(6.4, l.halfW - 1.6)) < Math.max(2, Math.min(6.4, f.halfW - 1.6)))
})

// ---- createCameraRig 的模式切換 ----
test('CameraRig：切換模式 = 目標倍率改變，相機用同一個 lerp 平滑過去（不跳）；來回切換回到原位', () => {
  const pos = { x: 0, y: 0.4, z: 7 }
  const rig = createCameraRig()
  const phone = { width: 375, height: 812, zoom: 0.5, fovDeg: 45 }
  const rFull = rig.step(pos, { ...phone, mode: 'full' })
  assert.strictEqual(pos.z, rigTarget(0.5, fitScale({ aspect: 375 / 812 })).z)     // 第一幀就位在 full
  const zFull = pos.z
  const r1 = rig.step(pos, { ...phone, mode: 'fill' })
  const fillFit = fitScale({ aspect: 375 / 812, mode: 'fill' })
  assert.equal(r1.fit, fillFit)
  assert.ok(pos.z < zFull && zFull - pos.z < (zFull - rigTarget(0.5, fillFit).z) * 0.061, '第一步只走 6%，不跳')
  assert.ok(r1.shown < rFull.shown && r1.shown > fillFit, '霧倍率也跟著相機平滑')
  stepN(rig, pos, { ...phone, mode: 'fill' }, 700)
  assert.ok(Math.abs(pos.z - rigTarget(0.5, fillFit).z) < 1e-9)
  assert.ok(Math.abs(pos.y - rigTarget(0.5, fillFit).y) < 1e-9)
  stepN(rig, pos, { ...phone, mode: 'full' }, 700)                                  // 切回來
  assert.ok(Math.abs(pos.z - zFull) < 1e-9)
})

test('CameraRig：mode 缺省 = full（與加入模式之前相同）；建立時的 mode 是預設、step 的 mode 逐幀覆寫；寬螢幕切模式相機一動也不動；?fit=0 兩種模式都是 1', () => {
  const phone = { width: 375, height: 812, zoom: 0.5, fovDeg: 45 }
  const a = createCameraRig(), b = createCameraRig({ mode: 'fill' }), c = createCameraRig({ mode: 'fill' })
  const pa = { x: 0, y: 0.4, z: 7 }, pb = { ...pa }, pc = { ...pa }
  assert.equal(a.step(pa, phone).fit, fitScale({ aspect: 375 / 812 }))
  assert.equal(b.step(pb, phone).fit, fitScale({ aspect: 375 / 812, mode: 'fill' }))
  assert.equal(c.step(pc, { ...phone, mode: 'full' }).fit, fitScale({ aspect: 375 / 812 }))   // step 的 mode 蓋過建立時的
  // 寬螢幕：每一幀切換模式，位置逐位元不變
  const wide = { width: 1600, height: 900, zoom: 0.5, fovDeg: 45 }
  const pw = { x: 0, y: 0.4, z: 7 }, rw = createCameraRig()
  rw.step(pw, { ...wide, mode: 'full' })
  const snap = { ...pw }
  for (let i = 0; i < 50; i++) { const r = rw.step(pw, { ...wide, mode: i % 2 ? 'fill' : 'full' }); assert.strictEqual(r.fit, 1) }
  assert.deepEqual(pw, { x: 0, y: 0.4, z: 6.6 })
  assert.strictEqual(snap.z, 6.6)
  // ?fit=0（enabled: false）
  for (const mode of ['full', 'fill']) {
    const p = { x: 0, y: 0.4, z: 7 }, rig = createCameraRig({ enabled: false })
    assert.equal(rig.step(p, { ...phone, mode }).fit, 1)
    assert.strictEqual(p.z, 6.6)
  }
})

// =============================================================================================
// 測站星座 × 頂端資料 HUD：直式時星座最高點的螢幕 y >= 68px（精確透視投影驗證）
// =============================================================================================
const HUD_LIMIT_PX = 68
// 用真的 PerspectiveCamera 擺位（CameraRig 同式）→ 把「群組（StationStars 同式：position / scale / 極慢擺動 rotation.y）」內的一組點投影成螢幕列 / 欄（px）
function stationScreen(w, h, zoom, mode, pts, { sways = [-0.08, 0, 0.08] } = {}) {
  const a = w / h, fit = fitScale({ aspect: a, mode }), g = rigTarget(zoom, fit)
  const lay = stationPlacement({ camY: g.y, camZ: g.z, planeZ: STATION_Z, fovDeg: FIT_FOV, width: w, height: h })
  const cam = new THREE.PerspectiveCamera(FIT_FOV, a, 0.1, 1000)
  cam.position.set(g.x, g.y, g.z); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true); cam.updateProjectionMatrix()
  const rows = [], cols = []
  const grp = new THREE.Group(); grp.position.set(lay.x, lay.y, STATION_Z); grp.scale.setScalar(lay.s)
  const v = new THREE.Vector3()
  for (const sway of sways) {
    grp.rotation.y = sway; grp.updateMatrixWorld(true)
    for (const [px, py] of pts) { v.set(px, py, 0).applyMatrix4(grp.matrixWorld).project(cam); rows.push(((1 - v.y) / 2) * h); cols.push(((v.x + 1) / 2) * w) }
  }
  return { lay, rows, cols, fit, cam, g }
}
const CORNERS = [[0, 2.7], [1.36, 2.7], [-1.36, 2.7], [0, -2.7], [1.36, -2.7], [-1.36, -2.7], [1.36, 0], [-1.36, 0]]   // 星座外框（縮放後 x ±1.36、y ±2.7）
const shellTopRow = (w, h, zoom, mode) => {                                                                     // 球殼（半徑 2.02）最高點的螢幕列
  const a = w / h, g = rigTarget(zoom, fitScale({ aspect: a, mode }))
  const cam = new THREE.PerspectiveCamera(FIT_FOV, a, 0.1, 1000)
  cam.position.set(g.x, g.y, g.z); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true); cam.updateProjectionMatrix()
  let top = Infinity; for (const p of spherePoints(2500, SHELL)) top = Math.min(top, ((1 - p.clone().project(cam).y) / 2) * h)
  return top
}

test('planeYAtRow：與 THREE.PerspectiveCamera 的投影互為反函數（各尺寸 / zoom / 模式；誤差 < 1e-6 px）；畫面中心 = camY * planeZ / camZ（預設 zoom 約 -0.64，不是 0）', () => {
  for (const [w, h] of [[375, 812], [1024, 768], [768, 1024]]) {
    for (const zoom of [0, 0.5, 1]) for (const mode of ['full', 'fill']) {
      const a = w / h, g = rigTarget(zoom, fitScale({ aspect: a, mode }))
      const cam = new THREE.PerspectiveCamera(FIT_FOV, a, 0.1, 1000)
      cam.position.set(g.x, g.y, g.z); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true); cam.updateProjectionMatrix()
      for (const row of [0, 30, STATION_HUD_PX, h / 4, h / 2, h * 0.9, h]) {
        const y = planeYAtRow({ camY: g.y, camZ: g.z, planeZ: STATION_Z, fovDeg: FIT_FOV, height: h, row })
        const got = ((1 - new THREE.Vector3(0, y, STATION_Z).project(cam).y) / 2) * h
        assert.ok(Math.abs(got - row) < 1e-6, `${w}x${h} zoom ${zoom} ${mode} row ${row}：投影回來是 ${got}`)
      }
      const yc = planeYAtRow({ camY: g.y, camZ: g.z, planeZ: STATION_Z, height: h, row: h / 2 })
      assert.ok(Math.abs(yc - (g.y * STATION_Z) / g.z) < 1e-9)
      if (zoom === 0.5) assert.ok(Math.abs(yc + 0.6364) < 0.001, '預設 zoom：畫面中心約在 y = -0.636，與 fit / 模式無關：' + yc)
    }
  }
  for (const bad of [{}, { camY: NaN, camZ: 6, planeZ: -10, height: 800, row: 5 }, { camY: 0.4, camZ: 0, planeZ: -10, height: 800, row: 5 }, { camY: 0.4, camZ: 6, planeZ: -10, height: 0, row: 5 }, { camY: 0.4, camZ: 6, planeZ: -10, height: 800, row: NaN }]) assert.ok(Number.isNaN(planeYAtRow(bad)), JSON.stringify(bad))
  assert.equal(planeYAtRow(), NaN)
})

test('stationPlacement：長寬比 >= 0.95 與改版前 Scene3D 內的公式逐位元相同（版位完全不變），不論 zoom / 模式 / 高度', () => {
  for (const a of [0.95, 1, 1.2, 4 / 3, 1.5, 16 / 9, 2, 21 / 9, 3]) {
    for (const zoom of [0, 0.25, 0.5, 0.75, 1]) for (const mode of ['full', 'fill']) for (const h of [300, 768, 900, 1440]) {
      const w = a * h, g = rigTarget(zoom, fitScale({ aspect: aspectOf(w, h), mode }))
      // 改版前的內聯算式（Scene3D StationStars 原文，含 THREE.MathUtils.degToRad）
      const camera = { position: { z: g.z, y: g.y }, fov: 45 }, size = { width: w, height: h }
      const dist = Math.max(4, camera.position.z - -10.5)
      const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * dist
      const asp = size.width / Math.max(1, size.height), halfW = halfH * asp
      const sphereR = 2.02 * (dist / Math.max(3, camera.position.z))
      const want = stationLayout({ halfW, halfH, sphereR, aspect: asp })
      const got = stationPlacement({ camY: g.y, camZ: g.z, planeZ: -10.5, fovDeg: 45, width: w, height: h })
      assert.deepEqual(got, want, `aspect ${a} zoom ${zoom} ${mode} h ${h}`)
      assert.strictEqual(got.y, -0.3); assert.strictEqual(got.s, 1)
    }
  }
})

test('直式手機（375x812 / 390x844 / 412x915 / 360x800）× 兩種模式 × zoom 0 ~ 1：星座最高點螢幕 y >= 68px（含極慢擺動），左右完整在畫布內、水平置中', () => {
  const rows = []
  for (const [k, w, h] of PHONE_SIZES) for (const mode of ['full', 'fill']) for (const zoom of [0, 0.25, 0.5, 0.75, 1]) {
    const r = stationScreen(w, h, zoom, mode, CORNERS)
    const top = Math.min(...r.rows), bot = Math.max(...r.rows), left = Math.min(...r.cols), right = Math.max(...r.cols)
    assert.ok(top >= HUD_LIMIT_PX, `${k} ${mode} zoom ${zoom}：星座最高點在 ${top.toFixed(1)}px（< ${HUD_LIMIT_PX}）`)
    assert.ok(top <= HUD_LIMIT_PX + 8, `${k} ${mode} zoom ${zoom}：星座離頂端 ${top.toFixed(1)}px，不該空出太多`)
    assert.ok(left >= 0 && right <= w, `${k} ${mode} zoom ${zoom}：水平超出 [${left.toFixed(0)}, ${right.toFixed(0)}] vs 0..${w}`)
    assert.ok(bot <= h, `${k} ${mode} zoom ${zoom}：星座掉出畫布下緣`)
    assert.ok(Math.abs((left + right) / 2 - w / 2) < 3, `${k} ${mode} zoom ${zoom}：星座沒有水平置中`)
    assert.equal(r.lay.x, 0)
    if (zoom === 0.5) rows.push(`${k} ${mode.padEnd(4)} s=${r.lay.s.toFixed(3)}  星座列 ${top.toFixed(0)}..${bot.toFixed(0)}px  欄 ${left.toFixed(0)}..${right.toFixed(0)}px`)
  }
  console.log(rows.join('\n'))
})

test('直式手機 zoom 0.5：星座的下緣最多蓋到球頂的 13%（球半徑）——大部分留在球的上方', () => {
  for (const [k, w, h] of PHONE_SIZES) for (const mode of ['full', 'fill']) {
    const r = stationScreen(w, h, 0.5, mode, CORNERS, { sways: [0] })
    const bot = Math.max(...r.rows), sTop = shellTopRow(w, h, 0.5, mode), sR = h / 2 - sTop
    assert.ok(bot - sTop <= sR * 0.13, `${k} ${mode}：下緣 ${bot.toFixed(0)}px、球頂 ${sTop.toFixed(0)}px、球半徑 ${sR.toFixed(0)}px`)
  }
})

test('掃長寬比 0.3 ~ 0.95 × 多種畫布高度 × 兩種模式 × zoom：星座最高點 >= 68px、水平不出畫布（HUD 之下；過渡帶也成立）', () => {
  for (const mode of ['full', 'fill']) for (const h of [520, 640, 812, 1000, 1400]) for (const zoom of [0, 0.5, 1]) {
    for (let a = 0.3; a < 0.95; a += 0.01) {
      const w = a * h
      const r = stationScreen(w, h, zoom, mode, CORNERS)
      const top = Math.min(...r.rows)
      assert.ok(top >= HUD_LIMIT_PX, `aspect ${a.toFixed(2)} h ${h} ${mode} zoom ${zoom}：最高點 ${top.toFixed(1)}px`)
      assert.ok(Math.min(...r.cols) >= 0 && Math.max(...r.cols) <= w + 1e-6, `aspect ${a.toFixed(2)} h ${h}：水平超出`)
    }
  }
})

test('平板直式（768x1024）與極窄（0.3）也在 HUD 之下；星座縮小但不小於下限 0.3（可讀）', () => {
  for (const [w, h] of [[768, 1024], [300, 1000], [600, 900]]) for (const mode of ['full', 'fill']) for (const zoom of [0, 0.5, 1]) {
    const r = stationScreen(w, h, zoom, mode, CORNERS)
    assert.ok(Math.min(...r.rows) >= HUD_LIMIT_PX, `${w}x${h} ${mode} zoom ${zoom}：${Math.min(...r.rows).toFixed(1)}px`)
    assert.ok(r.lay.s >= 0.3 && r.lay.s <= 1, `s=${r.lay.s}`)
  }
})

test('stationPlacement 連續：長寬比連續變化（固定高度）位置 / 縮放不跳（拖曳分隔線、轉螢幕）；兩種模式', () => {
  for (const mode of ['full', 'fill']) for (const h of [640, 900]) {
    let prev = null
    for (let a = 0.3; a <= 1.3; a += 0.002) {
      const w = a * h, g = rigTarget(0.5, fitScale({ aspect: a, mode }))
      const lay = stationPlacement({ camY: g.y, camZ: g.z, planeZ: STATION_Z, fovDeg: FIT_FOV, width: w, height: h })
      if (prev) {
        assert.ok(Math.abs(lay.x - prev.x) < 0.12, `${mode} h ${h} aspect ${a.toFixed(3)} x 跳 ${Math.abs(lay.x - prev.x).toFixed(3)}`)
        assert.ok(Math.abs(lay.y - prev.y) < 0.12, `${mode} h ${h} aspect ${a.toFixed(3)} y 跳 ${Math.abs(lay.y - prev.y).toFixed(3)}`)
        assert.ok(Math.abs(lay.s - prev.s) < 0.02, `${mode} h ${h} aspect ${a.toFixed(3)} s 跳`)
      }
      prev = lay
    }
  }
})

test('stationLayout 選用參數：沒給 yc / yTop = 改版前（既有測試已涵蓋）；給了 → 上緣剛好在 yTop（長寬比 <= 0.8）、寬螢幕仍不變', () => {
  const base = { halfW: 4.4, halfH: 9.5, sphereR: 3.6, aspect: 0.46 }
  const old = stationLayout(base)
  assert.deepEqual(stationLayout({ ...base, yc: 0, yTop: undefined }), old)
  const lay = stationLayout({ ...base, yc: -0.64, yTop: 6.5 })
  assert.ok(Math.abs(lay.y + 2.7 * lay.s - 6.5) < 1e-12, '上緣 = yTop')
  assert.equal(lay.x, 0)
  // 寬螢幕：yc / yTop 完全不影響
  for (const a of [0.95, 1, 1.78]) assert.deepEqual(stationLayout({ ...base, aspect: a, yc: -0.64, yTop: 1 }), stationLayout({ ...base, aspect: a }))
  // yTop 不是數字 → 當沒給
  for (const bad of [NaN, null, 'x', undefined]) assert.deepEqual(stationLayout({ ...base, yTop: bad }), old)
})

test('stationPlacement 容錯：畫布尺寸 0 / NaN / 高度缺省 → 不丟例外、回傳有限數字（不套用 HUD 規則，退回舊行為）', () => {
  for (const [w, h] of [[0, 0], [300, 0], [NaN, NaN], [undefined, undefined], [375, NaN]]) {
    let r
    assert.doesNotThrow(() => { r = stationPlacement({ camY: 0.4, camZ: 6.6, width: w, height: h }) }, `${w},${h}`)
    assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.s), `${w},${h}：${JSON.stringify(r)}`)
  }
  assert.doesNotThrow(() => stationPlacement({ camZ: 6.6, width: 375, height: 812 }))            // camY 缺省
})

test('真實測站資料（public/data/ocean.json 的 188 站）：直式手機上每一顆星都在 HUD 之下；拾取用的世界座標與畫出來的是同一份（群組矩陣）', () => {
  let list
  try { list = JSON.parse(readFileSync(new URL('../../public/data/ocean.json', import.meta.url), 'utf8')).stations.list } catch (e) { list = null }
  if (!list || !list.length) return                                    // 資料檔不在 → 略過（不是這個功能的責任）
  const STN_S = 5.4
  for (const [k, w, h] of PHONE_SIZES) for (const mode of ['full', 'fill']) {
    const pts = list.map((q) => [q.x * STN_S, q.y * STN_S])
    const r = stationScreen(w, h, 0.5, mode, pts)
    assert.ok(Math.min(...r.rows) >= HUD_LIMIT_PX, `${k} ${mode}：最高的星在 ${Math.min(...r.rows).toFixed(1)}px`)
    // 拾取：Scene3D 的 registerPickSource('station') 用 group.matrixWorld 把 (x * 5.4, y * 5.4, 0) 換成世界座標，再投影成螢幕座標——與繪製同一條路徑
    const grp = new THREE.Group(); grp.position.set(r.lay.x, r.lay.y, STATION_Z); grp.scale.setScalar(r.lay.s); grp.updateMatrixWorld(true)
    const v = new THREE.Vector3()
    for (const q of list.slice(0, 40)) {
      v.set(q.x * STN_S, q.y * STN_S, 0).applyMatrix4(grp.matrixWorld)
      assert.ok(Math.abs(v.x - (q.x * STN_S * r.lay.s + r.lay.x)) < 1e-9 && Math.abs(v.y - (q.y * STN_S * r.lay.s + r.lay.y)) < 1e-9 && v.z === STATION_Z)
      const sy = ((1 - v.project(r.cam).y) / 2) * h
      assert.ok(sy >= HUD_LIMIT_PX - 1.5, `${k} ${mode}：拾取座標的螢幕列 ${sy.toFixed(1)}`)
    }
  }
})

test('Scene3D 接線（原始碼）：CameraRig 讀取景狀態並傳 mode；StationStars 用 stationPlacement（星座位置單一來源，拾取讀群組矩陣）；不再有 FIT_ON', () => {
  const src = readFileSync(new URL('../scene/Scene3D.jsx', import.meta.url), 'utf8')
  assert.match(src, /import \{ createCameraRig, shellScale, stationPlacement \} from '\.\.\/lib\/cameraFit\.js'/)
  assert.match(src, /import \{ getViewState \} from '\.\.\/lib\/viewPrefs\.js'/)
  assert.doesNotMatch(src, /FIT_ON/)
  assert.doesNotMatch(src, /fitEnabled/)
  assert.match(src, /mode: view\.get\(\)\.mode/)
  assert.match(src, /createCameraRig\(\{ enabled: view\.get\(\)\.enabled \}\)/)
  assert.match(src, /view\.setCanvas\(state\.size\.width, state\.size\.height\)/)
  assert.match(src, /const lay = stationPlacement\(\{ camY: camera\.position\.y, camZ: camera\.position\.z, planeZ: STN_Z, fovDeg: camera\.fov, width: size\.width, height: size\.height \}\)/)
  assert.match(src, /grp\.current\.position\.set\(lay\.x, lay\.y, STN_Z\)/)
  assert.match(src, /grp\.current\.scale\.setScalar\(lay\.s\)/)
  assert.match(src, /registerPickSource\('station'[\s\S]{0,400}g\.updateWorldMatrix\(true, false\)[\s\S]{0,300}applyMatrix4\(g\.matrixWorld\)/)
  assert.equal(STATION_Z, -10.5)
  assert.match(src, /const STN_Z = -10\.5/)                                   // Scene3D 的平面深度與 cameraFit.STATION_Z 一致
})
