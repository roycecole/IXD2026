// 視角自動取景（lib/cameraFit.js）單元測試。執行：node --test src/lib/cameraFit.test.mjs
// 不開瀏覽器：用 three 的 PerspectiveCamera / Vector3 實際把球殼上的點投影到 NDC，驗證「整顆球可見、不縮太小」。
import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {
  FIT_FOV, FIT_RADIUS, FIT_BASE_DIST, FIT_MAX,
  validAspect, halfAngles, fitDist, fitScale, aspectOf, rigTarget, createCameraRig, fitEnabled, shellScale, stationLayout,
} from './cameraFit.js'

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
