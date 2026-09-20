import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useRef, useMemo, useEffect } from 'react'
import * as THREE from 'three'
import * as CANNON from 'cannon-es'
import { arState } from '../lib/ar.js'
import { useStore, seriesMeta } from '../store/useStore.js'
import { birdSeasonal, flockCount } from '../lib/birds.js'
import { ageFromLunar, moonAge, moonPhaseAngle, moonIllum, moonSky, dateAtHour } from '../lib/moon.js'
import { chime, setCreaturePan } from '../audio/engine.js'
import { micState } from '../audio/mic.js'
import { padEvents, purifyMeta } from '../store/events.js'

// 線稿海洋球：細線輪廓 + 微光 + 通透。程序化波浪（非流體模擬）、簡化弧形反光（非折射）。
// 效能：useFrame 內以 getState() 讀參數；線段全部寫進少數共用 batch（2 個 draw call），
// 不逐幀建立物件；粒子/線密度集中在 VIS 管理。

const R = 1.95        // 內容半徑
const SHELL = 2.02    // 球殼半徑
const WR = R * 0.985  // 水體貼壁半徑
const _v = new THREE.Vector3()
const YAXIS = new THREE.Vector3(0, 1, 0)
const bioNodes = []   // 生物節點（供 BioNetwork 科技連線）
const _cl = new THREE.Vector3()
const poke = { dir: new THREE.Vector3(0, 0, 1), str: 0, target: 0, vel: 0 } // 果凍壓凹（球殼柔軟壓回）
const REDUCED = (() => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch (e) { return false } })()

// ---- 手感 / 感測 ----
let spinImpulse = 0                    // 拖曳釋放後的慣性自轉（指數衰減）
let jellyPulse = 0                     // nanoPAD2 打擊墊 → 水母集體脈衝（衰減）
let glowBoost = 0                      // 閃光事件（衰減）：水線 / 球殼 / 大氣短暫增亮
let fishDash = 0                       // 魚群衝刺事件（衰減）：巡游 / 轉向加速
let dayT = 0                           // 極慢晝夜相位（4 分鐘一輪，背景 / 霧色微變）
const compass = { last: null }         // 指北針：轉身 → 洋流方向
let lastTapAt = 0                      // 雙擊偵測：第二擊不重複爆星（留給演出模式切換）
let gather = null                      // 長按聚集點：魚群游向此處
const flow = { x: 0, z: 0 }            // 洋流方向向量（flowX/flowY 參數，nanoPAD2 X-Y 可綁）
const gyro = { tx: 0, tz: 0, x: 0, z: 0, vx: 0, vz: 0, beta0: null } // vx/vz：欠阻尼彈簧速度（晃動感）
let motionAsked = false
async function ensureMotion() {        // 首次手勢時請求感測權限（iOS 需要）
  if (motionAsked) return
  motionAsked = true
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
      if ((await DeviceOrientationEvent.requestPermission()) !== 'granted') return
    }
    window.addEventListener('deviceorientation', (e) => {
      if (e.alpha != null) {                             // 指北針：明顯轉身（>8°）→ 洋流方向跟著羅盤
        if (compass.last == null) compass.last = e.alpha
        let da = e.alpha - compass.last
        if (da > 180) da -= 360; if (da < -180) da += 360
        if (Math.abs(da) > 8) {
          compass.last = e.alpha
          const rad = (e.alpha * Math.PI) / 180
          const st = useStore.getState()
          st.input('flowX', 0.5 + 0.4 * Math.sin(rad))
          st.input('flowY', 0.5 + 0.4 * Math.cos(rad))
        }
      }
      if (e.beta == null || e.gamma == null) return
      if (gyro.beta0 == null) gyro.beta0 = e.beta       // 以拿起手機的角度為基準
      gyro.tz = Math.max(-0.45, Math.min(0.45, -(e.gamma / 90) * 0.8))
      gyro.tx = Math.max(-0.45, Math.min(0.45, ((e.beta - gyro.beta0) / 90) * 0.8))
    })
  } catch (err) {}
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission) {
      if ((await DeviceMotionEvent.requestPermission()) !== 'granted') return
    }
    let lastShake = 0
    window.addEventListener('devicemotion', (e) => {
      const a = e.accelerationIncludingGravity
      if (!a) return
      const mag = Math.abs(Math.hypot(a.x || 0, a.y || 0, a.z || 0) - 9.81)
      const now = performance.now()
      if (mag > 9 && now - lastShake > 700) { lastShake = now; waveMomentum = Math.min(3, waveMomentum + 1.3) } // 搖晃 → 攪動
    })
  } catch (err) {}
}

// ---- 集中管理的視覺參數 ----
const VIS = {
  surfLinesX: 26, surfSamples: 26,   // 水面波浪線（僅水平流向，無垂直線條）
  wallArcs: 26, wallSamples: 12,     // 內壁弧線
  jelly: 12, fish: 40, trash: 14,    // 生物上限
  particles: 90,                     // 發光粒子
  shootingStars: 3,                  // 背景流星
}
if (REDUCED) Object.assign(VIS, { surfLinesX: 16, jelly: 7, fish: 18, trash: 8, particles: 26, shootingStars: 0 })

// ---- 平滑環境值 ----
const env = { seaLevel: 0.55, current: 0.45, clarity: 0.6, jelly: 0.5, fish: 0.55, swim: 0.5, trash: 0.25, glow: 0.6, hue: 0.5 }
let waveTime = 0, waveMomentum = 0   // 拖曳球體 → 水體慣性（衰減）
// 海水高度＝來源數值：0=near 見底、1=滿球（水面貼近球頂）；>97% 由 OverflowFx 觸發外緣溢流
const seaY = () => Math.max(-1.75, Math.min(1.75, (env.seaLevel - 0.5) * 3.5))
function waveH(x, z) {
  const T = waveTime
  const fv = Math.hypot(flow.x, flow.z)
  const dir = fv > 0.03 ? Math.sin((x * flow.x + z * flow.z) * 2.4 + T * 1.4) * 0.075 * fv : 0 // 洋流方向浪
  return (Math.sin(x * 1.7 + T) * 0.09 + Math.sin(z * 2.3 - T * 0.8) * 0.06 +
    Math.sin(x * 0.8 + z * 1.4 + T * 1.5) * 0.05 + Math.sin(x * 2.9 - z * 1.1 - T * 1.2) * 0.03 + dir) * (0.55 + env.current * 0.8 + micState.level * 0.9)
}
const effClarity = () => env.clarity * (1 - 0.7 * env.trash)
const effFish = () => Math.max(0, env.fish * (1 - 0.8 * env.trash))
const effJelly = () => Math.max(0, env.jelly * (1 - 0.6 * env.trash))
const wcol = { r: 0.55, g: 0.85, b: 1.0 } // 水線顏色（依清澈度 + 場景色相更新）
const _wc = new THREE.Color()
const waterHue = () => 0.28 + env.hue * 0.5 // hue 參數 → 色相：0 墨綠 ← 0.5 湛藍 → 1 紫粉

// ---- 貼圖（僅粒子點 / 文字用）----
const TEXS = {}
function makeTex(key, size, draw) {
  if (TEXS[key]) return TEXS[key]
  const c = document.createElement('canvas'); c.width = c.height = size
  const g = c.getContext('2d'); draw(g, size)
  const t = new THREE.CanvasTexture(c); TEXS[key] = t; return t
}
const dotTex = () => makeTex('dot', 64, (g, s) => {
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.3, 'rgba(190,235,255,0.9)'); grd.addColorStop(1, 'rgba(190,235,255,0)')
  g.fillStyle = grd; g.fillRect(0, 0, s, s)
})

// ---- 線段 batch（immediate-mode：每幀重寫，additive 微光）----
function makeBatch(maxSeg) {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxSeg * 6), 3))
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(maxSeg * 6), 3))
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
  lines.frustumCulled = false
  return { lines, geo, pos: geo.attributes.position.array, col: geo.attributes.color.array, n: 0, max: maxSeg }
}
const bBegin = (b) => { b.n = 0 }
function bSeg(b, ax, ay, az, bx, by, bz, r, g, bl, a) {
  if (b.n >= b.max) return
  const o = b.n * 6
  b.pos[o] = ax; b.pos[o + 1] = ay; b.pos[o + 2] = az; b.pos[o + 3] = bx; b.pos[o + 4] = by; b.pos[o + 5] = bz
  b.col[o] = r * a; b.col[o + 1] = g * a; b.col[o + 2] = bl * a
  b.col[o + 3] = r * a; b.col[o + 4] = g * a; b.col[o + 5] = bl * a
  b.n++
}
function bEnd(b) {
  b.geo.setDrawRange(0, b.n * 2)
  b.geo.attributes.position.needsUpdate = true
  b.geo.attributes.color.needsUpdate = true
}
// 折線：local pts（flat xyz）繞 Y 旋轉 + 縮放 + 平移後寫入
const SCR = new Float32Array(240)
function poly(b, pts, n, px, py, pz, cs, sn, s, r, g, bl, a) {
  let ax = 0, ay = 0, az = 0, first = true
  for (let i = 0; i < n; i++) {
    const lx = pts[i * 3] * s, ly = pts[i * 3 + 1] * s, lz = pts[i * 3 + 2] * s
    const wx = px + lx * cs - lz * sn, wy = py + ly, wz = pz + lx * sn + lz * cs
    if (!first) bSeg(b, ax, ay, az, wx, wy, wz, r, g, bl, a)
    ax = wx; ay = wy; az = wz; first = false
  }
}
// 舊網路層（節點連線）沿用
function makeLineLayer(maxSeg) { const b = makeBatch(maxSeg); return b.lines._batch = b, b.lines }
function updateLines(lines, pts, threshold, col, maxSeg) {
  const b = lines._batch; bBegin(b)
  for (let i = 0; i < pts.length && b.n < maxSeg; i++) for (let j = i + 1; j < pts.length && b.n < maxSeg; j++) {
    const a = pts[i], c = pts[j]
    const dx = a.x - c.x, dy = a.y - c.y, dz = a.z - c.z
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (d < threshold) bSeg(b, a.x, a.y, a.z, c.x, c.y, c.z, col.r, col.g, col.b, 1 - d / threshold)
  }
  bEnd(b)
}

// ---- 每幀平滑 + 波時間推進（含拖曳慣性衰減）----
function EnvDriver() {
  useFrame((_, dt) => {
    const p = useStore.getState().params
    const k = Math.min(1, dt * 3)
    env.seaLevel += ((p.seaLevel ?? 0.55) - env.seaLevel) * k
    env.current += ((p.current ?? 0.45) - env.current) * k
    env.clarity += ((p.clarity ?? 0.6) - env.clarity) * k
    env.jelly += ((p.jellyCount ?? 0.5) - env.jelly) * k
    env.fish += ((p.fishCount ?? 0.55) - env.fish) * k
    env.swim += ((p.swimSpeed ?? 0.5) - env.swim) * k
    env.trash += ((p.trashCount ?? 0.25) - env.trash) * k
    env.glow += ((p.glow ?? 0.6) - env.glow) * k
    env.hue += ((p.hue ?? 0.5) - env.hue) * k
    flow.x += (((p.flowX ?? 0.5) - 0.5) * 2 - flow.x) * k
    flow.z += (((p.flowY ?? 0.5) - 0.5) * 2 - flow.z) * k
    waveTime += dt * (0.45 + env.current * 1.5 + waveMomentum + micState.level * 2.2) // 吹氣 → 風起浪快
    waveMomentum *= Math.exp(-dt * 1.6)
    glowBoost *= Math.exp(-dt * 2.2)
    fishDash *= Math.exp(-dt * 1.4)
    const clar = effClarity()
    _wc.setHSL(waterHue(), 0.5 + clar * 0.2, 0.55 + clar * 0.15) // 場景配色：色相轉調、清澈提亮
    wcol.r = _wc.r; wcol.g = _wc.g; wcol.b = _wc.b
  })
  return null
}

// ---- 水體（重點）：水面細線 + 沿內壁收攏到球底的弧線 + 斷續浪尖微光，連續變形 ----
function WaterLines() {
  const batch = useMemo(() => makeBatch(1500), [])
  useFrame(() => {
    bBegin(batch)
    const yw = seaY()
    const murkA = 0.1 + effClarity() * 0.16 + glowBoost * 0.12 // 線的基礎透明度（輕盈；閃光事件短暫增亮）
    const crestT = 0.10 * (0.55 + env.current * 0.8)     // 浪尖門檻
    // 水面線（X 向）
    const zr = Math.sqrt(Math.max(0.05, WR * WR - yw * yw))
    for (let j = 0; j < VIS.surfLinesX; j++) {
      const z = ((j / (VIS.surfLinesX - 1)) * 2 - 1) * zr * 0.96
      const xr = Math.sqrt(Math.max(0.001, WR * WR - yw * yw - z * z))
      let ax = 0, ay = 0, az = 0, first = true
      for (let i = 0; i <= VIS.surfSamples; i++) {
        let x = ((i / VIS.surfSamples) * 2 - 1) * xr
        let y = yw + waveH(x, z)
        if (i === 0 || i === VIS.surfSamples) {           // 端點貼回內壁（交界沿壁爬升回落）
          const rw = Math.sqrt(Math.max(0.001, WR * WR - y * y - z * z))
          x = i === 0 ? -rw : rw
        }
        if (!first) {
          const h = (y - yw)
          const crest = h > crestT ? (h - crestT) * 6 : 0 // 局部斷續浪尖微光
          bSeg(batch, ax, ay, az, x, y, z, wcol.r + crest * 0.3, wcol.g + crest * 0.25, wcol.b, Math.min(0.9, murkA + crest))
        }
        ax = x; ay = y; az = z; first = false
      }
    }
    // 內壁弧線：由水線接觸點沿球壁收攏到球底（上端隨浪連續變形；頂部淡入避免波浪區出現垂直線）
    // 高水位時弧線貫穿整球會有「縱籠」感 → 遞減密度與透明度
    const hiWater = Math.max(0, Math.min(1, (yw - 0.8) / 0.9))
    const arcStep = yw > 1.2 ? 2 : 1
    const arcFade = 1 - hiWater * 0.55
    let pcx = 0, pcy = 0, pcz = 0
    for (let k = 0; k <= VIS.wallArcs; k += arcStep) {
      const phi = (k / VIS.wallArcs) * Math.PI * 2
      const r0 = Math.sqrt(Math.max(0.001, WR * WR - yw * yw))
      const cx0 = Math.cos(phi) * r0, cz0 = Math.sin(phi) * r0
      const yc = yw + waveH(cx0, cz0)
      const rc = Math.sqrt(Math.max(0.001, WR * WR - yc * yc))
      const cx = Math.cos(phi) * rc, cz = Math.sin(phi) * rc
      if (k > 0) {                                        // 水線接觸環（斷續微光，不是完整描邊）
        const h = yc - yw
        const a = 0.05 + Math.max(0, h) * 3.5
        bSeg(batch, pcx, pcy, pcz, cx, yc, cz, wcol.r + 0.2, wcol.g + 0.15, wcol.b, Math.min(0.55, a))
      }
      pcx = cx; pcy = yc; pcz = cz
      if (k === VIS.wallArcs) break
      let ax = cx, ay = yc, az = cz
      for (let m = 1; m <= VIS.wallSamples; m++) {
        const s = m / VIS.wallSamples
        const ease = 1 - (1 - s) * (1 - s)
        let y = yc + (-WR * 0.985 - yc) * ease
        y += waveH(Math.cos(phi) * 0.5, Math.sin(phi) * 0.5) * (1 - s) * (1 - s) * 0.5 // 連續銜接
        const r = Math.sqrt(Math.max(0.0005, WR * WR - y * y))
        const x = Math.cos(phi) * r, z = Math.sin(phi) * r
        bSeg(batch, ax, ay, az, x, y, z, wcol.r, wcol.g, wcol.b, murkA * (1 - s * 0.55) * Math.min(1, 0.08 + s * 2.4) * arcFade)
        ax = x; ay = y; az = z
      }
    }
    bEnd(batch)
  })
  return <primitive object={batch.lines} />
}

// ---- 發光粒子：水面漂移 + 水下隨流收攏 ----
function WaterParticles() {
  const N = VIS.particles
  const pts = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3))
    const m = new THREE.Points(g, new THREE.PointsMaterial({ map: dotTex(), size: 0.07, sizeAttenuation: true, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, color: new THREE.Color('#bfe9ff'), opacity: 0.8 }))
    m.frustumCulled = false; return m
  }, [])
  const st = useMemo(() => Array.from({ length: N }, (_, i) => ({
    surf: i < N * 0.6, a: Math.random() * Math.PI * 2, r: Math.random(), y: -Math.random() * 1.4, sp: 0.3 + Math.random() * 0.7,
  })), [])
  useFrame((state, dt) => {
    const yw = seaY(), arr = pts.geometry.attributes.position.array
    st.forEach((p, i) => {
      p.a += dt * p.sp * (0.15 + env.current * 0.5)
      if (p.surf) {
        const rr = Math.sqrt(Math.max(0.05, WR * WR - yw * yw)) * 0.92 * p.r
        const x = Math.cos(p.a) * rr, z = Math.sin(p.a) * rr
        arr[i * 3] = x; arr[i * 3 + 1] = yw + waveH(x, z) + 0.02; arr[i * 3 + 2] = z
      } else {
        p.y -= dt * 0.05 * (0.3 + env.current)
        if (p.y < -WR * 0.85) p.y = yw - 0.1
        const rmax = Math.sqrt(Math.max(0.02, WR * WR - p.y * p.y)) * 0.8 * p.r
        arr[i * 3] = Math.cos(p.a) * rmax; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = Math.sin(p.a) * rmax
      }
    })
    pts.geometry.attributes.position.needsUpdate = true
    pts.material.opacity = 0.35 + env.glow * 0.5
    pts.material.color.setHSL(waterHue() + 0.04, 0.6, 0.74) // 粒子跟著場景色相
  })
  return <primitive object={pts} />
}

// ---- 極淡水體量感（避免厚重實色）----
function WaterVolume() {
  const ref = useRef()
  useFrame(() => {
    const m = ref.current; if (!m) return
    const clar = effClarity()
    m.material.color.setHSL(waterHue() - (1 - clar) * 0.1, 0.5, 0.14 + clar * 0.08)
    m.material.opacity = 0.05 + (1 - clar) * 0.16
  })
  return <mesh ref={ref}><sphereGeometry args={[WR, 32, 32]} /><meshBasicMaterial transparent opacity={0.08} side={THREE.BackSide} depthWrite={false} /></mesh>
}

// ================= 線稿生物 =================
const clamp01v = (o) => { // 限制在水體內（不穿殼、不出水面）
  const ymax = seaY() - 0.08
  if (o.y > ymax) o.y = ymax
  if (o.y < -WR * 0.86) o.y = -WR * 0.86
  const rmax = Math.sqrt(Math.max(0.02, WR * WR - o.y * o.y)) * 0.92
  const d = Math.sqrt(o.x * o.x + o.z * o.z)
  if (d > rmax) { o.x *= rmax / d; o.z *= rmax / d }
}
function angleTo(a, b) { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d }

function drawJelly(b, j, t) {
  const a = j.vis * 0.7, s = j.size
  const pulse = Math.sin(t * 1.5 + j.ph)
  const bw = 1 + 0.16 * pulse + jellyPulse * 0.5, bh = 0.8 - 0.1 * pulse - jellyPulse * 0.2
  const cs = 1, sn = 0
  let n = 0 // 傘狀輪廓（XY 面）
  for (let i = 0; i <= 8; i++) { const q = Math.PI * i / 8; SCR[n * 3] = Math.cos(q) * 0.5 * bw; SCR[n * 3 + 1] = Math.sin(q) * 0.55 * bh; SCR[n * 3 + 2] = 0; n++ }
  poly(b, SCR, n, j.x, j.y, j.z, cs, sn, s, 0.72, 0.86, 1.0, a)
  n = 0 // 傘狀輪廓（ZY 面）
  for (let i = 0; i <= 8; i++) { const q = Math.PI * i / 8; SCR[n * 3] = 0; SCR[n * 3 + 1] = Math.sin(q) * 0.55 * bh; SCR[n * 3 + 2] = Math.cos(q) * 0.5 * bw; n++ }
  poly(b, SCR, n, j.x, j.y, j.z, cs, sn, s, 0.72, 0.86, 1.0, a)
  n = 0 // 傘緣環
  for (let i = 0; i <= 8; i++) { const q = Math.PI * 2 * i / 8; SCR[n * 3] = Math.cos(q) * 0.5 * bw; SCR[n * 3 + 1] = 0; SCR[n * 3 + 2] = Math.sin(q) * 0.5 * bw; n++ }
  poly(b, SCR, n, j.x, j.y, j.z, cs, sn, s, 0.72, 0.86, 1.0, a * 0.8)
  for (let k = 0; k < 5; k++) { // 觸手（延遲擺動）
    const q = Math.PI * 2 * k / 5
    const bx = Math.cos(q) * 0.3 * bw, bz = Math.sin(q) * 0.3 * bw
    n = 0
    for (let m = 0; m <= 6; m++) {
      const sw = Math.sin(t * 2.1 - m * 0.75 + j.ph + k) * 0.055 * m * (0.5 + env.current * 0.8)
      SCR[n * 3] = bx + sw; SCR[n * 3 + 1] = -m * 0.14 * (1 + 0.08 * pulse); SCR[n * 3 + 2] = bz + Math.cos(t * 1.7 - m * 0.6 + k) * 0.03 * m; n++
    }
    poly(b, SCR, n, j.x, j.y, j.z, cs, sn, s, 0.68, 0.82, 1.0, a * 0.55)
  }
}

function drawFish(b, f, t) {
  const a = f.vis * 0.8, s = f.size
  const cs = Math.cos(f.heading), sn = Math.sin(f.heading)
  const tw = Math.sin(t * 8 * (0.6 + env.swim) + f.ph) * 0.16 // 尾擺（側向）
  let n = 0 // 側面紡錘輪廓
  const P = [[0.5, 0, 0], [0.1, 0.13, 0], [-0.3, 0.03, 0], [-0.3, -0.03, tw * 0.3], [0.1, -0.11, 0], [0.5, 0, 0]]
  P.forEach((p) => { SCR[n * 3] = p[0]; SCR[n * 3 + 1] = p[1]; SCR[n * 3 + 2] = p[2]; n++ })
  poly(b, SCR, n, f.x, f.y, f.z, cs, sn, s, 0.66, 0.9, 1.0, a)
  n = 0 // 尾鰭 V
  ;[[-0.3, 0, 0], [-0.55, 0.12, tw], [-0.3, 0, 0], [-0.55, -0.1, tw]].forEach((p) => { SCR[n * 3] = p[0]; SCR[n * 3 + 1] = p[1]; SCR[n * 3 + 2] = p[2]; n++ })
  poly(b, SCR, 2, f.x, f.y, f.z, cs, sn, s, 0.66, 0.9, 1.0, a * 0.9)
  poly(b, SCR.subarray(6), 2, f.x, f.y, f.z, cs, sn, s, 0.66, 0.9, 1.0, a * 0.9)
}

function drawWhale(b, g, t) {
  const a = g.alpha * 0.85, s = g.size
  const cs = Math.cos(g.heading), sn = Math.sin(g.heading)
  const und = (lx) => Math.sin(t * 1.5 - lx * 1.2) * 0.03
  let n = 0 // 背 + 腹輪廓
  const O = [[1.0, 0.04], [0.55, 0.26], [0.0, 0.3], [-0.5, 0.2], [-0.88, 0.05], [-0.88, -0.02], [-0.4, -0.17], [0.2, -0.21], [0.7, -0.12], [1.0, 0.04]]
  O.forEach((p) => { SCR[n * 3] = p[0]; SCR[n * 3 + 1] = p[1] + und(p[0]); SCR[n * 3 + 2] = 0; n++ })
  poly(b, SCR, n, g.x, g.y, g.z, cs, sn, s, 0.62, 0.8, 1.0, a)
  const fl = Math.sin(t * 1.5 + 1) * 0.08 // 尾鰭（上下）
  n = 0; [[-0.88, 0.02, 0], [-1.14, 0.16 + fl, 0.1], [-0.88, 0.02, 0], [-1.14, 0.1 + fl, -0.14]].forEach((p) => { SCR[n * 3] = p[0]; SCR[n * 3 + 1] = p[1]; SCR[n * 3 + 2] = p[2]; n++ })
  poly(b, SCR, 2, g.x, g.y, g.z, cs, sn, s, 0.62, 0.8, 1.0, a)
  poly(b, SCR.subarray(6), 2, g.x, g.y, g.z, cs, sn, s, 0.62, 0.8, 1.0, a)
  n = 0; [[0.4, -0.1, 0], [0.18, -0.34, 0.06], [0.44, -0.16, 0.02]].forEach((p) => { SCR[n * 3] = p[0]; SCR[n * 3 + 1] = p[1]; SCR[n * 3 + 2] = p[2]; n++ }) // 胸鰭
  poly(b, SCR, 3, g.x, g.y, g.z, cs, sn, s, 0.62, 0.8, 1.0, a * 0.9)
  for (let i = 0; i < 2; i++) { // 腹部流線
    n = 0; [[0.55, -0.09 - i * 0.035, 0], [0.05, -0.16 - i * 0.03, 0]].forEach((p) => { SCR[n * 3] = p[0]; SCR[n * 3 + 1] = p[1]; SCR[n * 3 + 2] = p[2]; n++ })
    poly(b, SCR, 2, g.x, g.y, g.z, cs, sn, s, 0.62, 0.8, 1.0, a * 0.45)
  }
}

function drawDolphin(b, g, t) {
  const a = g.alpha * 0.85, s = g.size
  const cs = Math.cos(g.heading), sn = Math.sin(g.heading)
  const und = (lx) => Math.sin(t * 3 - lx * 1.6) * 0.04
  let n = 0
  const O = [[1.05, 0.0], [0.86, 0.07], [0.35, 0.17], [-0.25, 0.15], [-0.8, 0.03], [-0.8, -0.02], [-0.2, -0.13], [0.5, -0.12], [0.88, -0.04], [1.05, 0.0]]
  O.forEach((p) => { SCR[n * 3] = p[0]; SCR[n * 3 + 1] = p[1] + und(p[0]); SCR[n * 3 + 2] = 0; n++ })
  poly(b, SCR, n, g.x, g.y, g.z, cs, sn, s, 0.72, 0.9, 1.0, a)
  n = 0; [[0.05, 0.16, 0], [-0.1, 0.36, 0], [-0.2, 0.14, 0]].forEach((p) => { SCR[n * 3] = p[0]; SCR[n * 3 + 1] = p[1]; SCR[n * 3 + 2] = p[2]; n++ }) // 背鰭
  poly(b, SCR, 3, g.x, g.y, g.z, cs, sn, s, 0.72, 0.9, 1.0, a)
  const fl = Math.sin(t * 3.2) * 0.1
  n = 0; [[-0.8, 0, 0], [-1.02, 0.1 + fl, 0.1], [-0.8, 0, 0], [-1.02, 0.04 + fl, -0.12]].forEach((p) => { SCR[n * 3] = p[0]; SCR[n * 3 + 1] = p[1]; SCR[n * 3 + 2] = p[2]; n++ })
  poly(b, SCR, 2, g.x, g.y, g.z, cs, sn, s, 0.72, 0.9, 1.0, a)
  poly(b, SCR.subarray(6), 2, g.x, g.y, g.z, cs, sn, s, 0.72, 0.9, 1.0, a)
}

function drawTurtle(b, g, t) {
  const a = g.alpha * 0.85, s = g.size
  const cs = Math.cos(g.heading), sn = Math.sin(g.heading)
  let n = 0 // 龜殼（水平橢圓 + 上拱）
  for (let i = 0; i <= 10; i++) { const q = Math.PI * 2 * i / 10; SCR[n * 3] = Math.cos(q) * 0.45; SCR[n * 3 + 1] = 0; SCR[n * 3 + 2] = Math.sin(q) * 0.58; n++ }
  poly(b, SCR, n, g.x, g.y, g.z, cs, sn, s, 0.62, 0.95, 0.85, a)
  n = 0; for (let i = 0; i <= 6; i++) { const q = Math.PI * i / 6; SCR[n * 3] = 0; SCR[n * 3 + 1] = Math.sin(q) * 0.22; SCR[n * 3 + 2] = -Math.cos(q) * 0.58; n++ }
  poly(b, SCR, n, g.x, g.y, g.z, cs, sn, s, 0.62, 0.95, 0.85, a * 0.9)
  n = 0; [[0, 0.02, -0.58], [0, 0.02, 0.58]].forEach((p) => { SCR[n * 3] = p[0]; SCR[n * 3 + 1] = p[1]; SCR[n * 3 + 2] = p[2]; n++ }) // 殼中線
  poly(b, SCR, 2, g.x, g.y, g.z, cs, sn, s, 0.62, 0.95, 0.85, a * 0.5)
  n = 0; [[-0.45, 0.01, 0], [0.45, 0.01, 0]].forEach((p) => { SCR[n * 3] = p[0]; SCR[n * 3 + 1] = p[1]; SCR[n * 3 + 2] = p[2]; n++ }) // 殼橫線
  poly(b, SCR, 2, g.x, g.y, g.z, cs, sn, s, 0.62, 0.95, 0.85, a * 0.5)
  n = 0; [[0, 0.02, 0.58], [0, 0.05, 0.8], [0.05, 0.02, 0.9], [-0.05, 0.02, 0.9], [0, 0.05, 0.8]].forEach((p) => { SCR[n * 3] = p[0]; SCR[n * 3 + 1] = p[1]; SCR[n * 3 + 2] = p[2]; n++ }) // 頭
  poly(b, SCR, 5, g.x, g.y, g.z, cs, sn, s, 0.62, 0.95, 0.85, a)
  const pd = Math.sin(t * 1.1 + g.ph) * 0.5 // 前肢划水
  ;[-1, 1].forEach((sd) => {
    n = 0; [[sd * 0.4, 0, 0.3], [sd * (0.78 + 0.08 * pd), 0.03, 0.5 + 0.14 * pd]].forEach((p) => { SCR[n * 3] = p[0]; SCR[n * 3 + 1] = p[1]; SCR[n * 3 + 2] = p[2]; n++ })
    poly(b, SCR, 2, g.x, g.y, g.z, cs, sn, s, 0.62, 0.95, 0.85, a * 0.9)
    n = 0; [[sd * 0.38, 0, -0.4], [sd * 0.6, 0.02, -0.6]].forEach((p) => { SCR[n * 3] = p[0]; SCR[n * 3 + 1] = p[1]; SCR[n * 3 + 2] = p[2]; n++ })
    poly(b, SCR, 2, g.x, g.y, g.z, cs, sn, s, 0.62, 0.95, 0.85, a * 0.7)
  })
}

function drawBottle(b, o, t) {
  const a = o.vis * 0.5, s = o.size
  const cs = Math.cos(o.rot), sn = Math.sin(o.rot)
  let n = 0
  const O = [[-0.1, -0.25, 0], [0.1, -0.25, 0], [0.1, 0.12, 0], [0.04, 0.2, 0], [0.04, 0.3, 0], [-0.04, 0.3, 0], [-0.04, 0.2, 0], [-0.1, 0.12, 0], [-0.1, -0.25, 0]]
  O.forEach((p) => { SCR[n * 3] = p[0]; SCR[n * 3 + 1] = p[1]; SCR[n * 3 + 2] = p[2]; n++ })
  poly(b, SCR, n, o.x, o.y, o.z, cs, sn, s, 0.6, 0.7, 0.75, a)
  n = 0; [[-0.05, 0.32, 0], [0.05, 0.32, 0]].forEach((p) => { SCR[n * 3] = p[0]; SCR[n * 3 + 1] = p[1]; SCR[n * 3 + 2] = p[2]; n++ })
  poly(b, SCR, 2, o.x, o.y, o.z, cs, sn, s, 0.6, 0.7, 0.75, a)
}
function drawBag(b, o, t) {
  const a = o.vis * 0.45, s = o.size
  const cs = Math.cos(o.rot), sn = Math.sin(o.rot)
  let n = 0
  for (let i = 0; i <= 8; i++) {
    const q = Math.PI * 2 * i / 8
    const r = 0.24 * (1 + 0.28 * Math.sin(t * 1.3 + i * 1.7 + o.ph)) // 輕微變形
    SCR[n * 3] = Math.cos(q) * r; SCR[n * 3 + 1] = Math.sin(q) * r * 1.25; SCR[n * 3 + 2] = Math.sin(t * 0.9 + i + o.ph) * 0.05; n++
  }
  poly(b, SCR, n, o.x, o.y, o.z, cs, sn, s, 0.66, 0.74, 0.8, a)
}

// ---- 所有生物 / 垃圾：一個元件、一個 batch ----
function LineCreatures() {
  const batch = useMemo(() => makeBatch(1600), [])
  const jellies = useMemo(() => Array.from({ length: VIS.jelly }, (_, i) => ({
    x: Math.sin(i * 4.1) * 1.1, y: -0.3 - (i % 4) * 0.28, z: Math.sin(i * 6.3) * 1.0,
    ph: i * 1.3, size: 0.4 + (i % 3) * 0.13, vis: 0,
  })), [])
  const clusters = useMemo(() => Array.from({ length: 3 }, (_, c) => ({
    ang: c * 2.1, speed: 0.35 + c * 0.18, r: 0.55 + c * 0.3, y: -0.35 - c * 0.35, wobPh: c * 2, cx: 0, cy: 0, cz: 0,
  })), [])
  const fishes = useMemo(() => Array.from({ length: VIS.fish }, (_, i) => ({
    cluster: i % 3, ox: (Math.random() - 0.5) * 0.7, oy: (Math.random() - 0.5) * 0.35, oz: (Math.random() - 0.5) * 0.7,
    lag: 1.2 + Math.random() * 2.2, x: 0, y: -0.5, z: 0, heading: 0, size: 0.1 + Math.random() * 0.07, ph: i, vis: 0,
  })), [])
  const trash = useMemo(() => Array.from({ length: VIS.trash }, (_, i) => ({
    kind: i % 3 === 2 ? 'bag' : 'bottle', x: Math.sin(i * 5.3) * 1.2, y: -0.15 - (i % 5) * 0.24, z: Math.sin(i * 2.1) * 1.1,
    rot: i, rotSp: 0.2 + (i % 4) * 0.15, ph: i * 2.2, size: 0.45 + (i % 3) * 0.18, vis: 0,
  })), [])
  const guests = useMemo(() => Array.from({ length: 5 }, () => ({ active: false, type: null, born: 0, dir: 1, x: 0, y: 0, z: 0, heading: 0, alpha: 0, size: 1, ph: 0 })), [])
  const lastSpawns = useRef({ whale: 0, dolphin: 0, turtle: 0 })
  const lastClaps = useRef(0)
  const lastPurifyLC = useRef(0)
  // 垃圾剛體物理（cannon-es）：浮力 + 洋流 + 互相碰撞 + 球壁向內約束；淨化波施加向外衝量
  const phys = useMemo(() => {
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -2.0, 0) })
    const mat = new CANNON.Material('trash')
    world.addContactMaterial(new CANNON.ContactMaterial(mat, mat, { restitution: 0.55, friction: 0.2 }))
    const bodies = trash.map((o) => {
      const b = new CANNON.Body({
        mass: 0.4, material: mat, shape: new CANNON.Sphere(0.1 + o.size * 0.14),
        position: new CANNON.Vec3(o.x, o.y, o.z), linearDamping: 0.55, angularDamping: 0.5,
      })
      b.angularVelocity.set(0, o.rotSp, 0)
      world.addBody(b)
      return b
    })
    return { world, bodies, f: new CANNON.Vec3() }
  }, [trash])

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime
    bBegin(batch)
    bioNodes.length = 0
    if ((micState.claps || 0) > lastClaps.current) { // 拍手 → 召喚海豚 + 亮星
      lastClaps.current = micState.claps
      useStore.getState().spawnDolphin()
      burstQueue.push({ x: (Math.random() - 0.5) * 2, y: seaY() - 0.2, z: (Math.random() - 0.5) * 2 })
    }
    // 水母
    const jellyActive = Math.round(effJelly() * VIS.jelly)
    jellies.forEach((j, i) => {
      j.vis += ((i < jellyActive ? 1 : 0) - j.vis) * Math.min(1, dt * 2)
      j.y += Math.sin(t * 0.35 + j.ph) * (0.02 + env.swim * 0.045) * dt * 3
      j.x += Math.sin(t * 0.22 + j.ph) * 0.0018 * (1 + env.current * 2)
      j.z += Math.cos(t * 0.19 + j.ph * 2) * 0.0014 * (1 + env.current)
      clamp01v(j)
      if (j.vis > 0.03) { drawJelly(batch, j, t); bioNodes.push(j) }
    })
    // 魚群（疏密不均、速度差、轉向延遲）
    clusters.forEach((c) => {
      c.ang += dt * c.speed * (0.3 + env.current * 0.7) * (0.4 + env.swim) * (1 + fishDash)
      if (gather) {                                        // 長按聚集：魚群游向手指
        c.cx += (gather.x - c.cx) * Math.min(1, dt * 2)
        c.cy += (gather.y - c.cy) * Math.min(1, dt * 2)
        c.cz += (gather.z - c.cz) * Math.min(1, dt * 2)
      } else {
        c.cx = Math.cos(c.ang) * c.r + flow.x * 0.5        // 洋流推移
        c.cz = Math.sin(c.ang) * c.r + flow.z * 0.5
        c.cy = c.y + Math.sin(t * 0.5 + c.wobPh) * 0.15
      }
    })
    const fishActive = Math.round(effFish() * VIS.fish)
    fishes.forEach((f, i) => {
      f.vis += ((i < fishActive ? 1 : 0) - f.vis) * Math.min(1, dt * 2)
      const c = clusters[f.cluster]
      const k = Math.min(1, dt * f.lag * (0.4 + env.swim) * (1 + fishDash * 1.5))
      let nx = f.x + (c.cx + f.ox - f.x) * k
      const ny = f.y + (c.cy + f.oy - f.y) * k
      let nz = f.z + (c.cz + f.oz - f.z) * k
      // 生態敘事：魚群主動避開垃圾（近距離斥力，遠離污染源）
      for (let ti = 0; ti < trash.length; ti++) {
        const o = trash[ti]; if (o.vis < 0.2) continue
        const ddx = nx - o.x, ddz = nz - o.z
        const d2 = ddx * ddx + ddz * ddz
        if (d2 < 0.3 && d2 > 1e-6) {
          const d = Math.sqrt(d2), push = (0.55 - d) / 0.55
          nx += (ddx / d) * push * dt * 1.6; nz += (ddz / d) * push * dt * 1.6
        }
      }
      const dx = nx - f.x, dz = nz - f.z
      if (dx * dx + dz * dz > 1e-7) f.heading += angleTo(f.heading, Math.atan2(dz, dx)) * Math.min(1, dt * 3.5)
      f.x = nx; f.y = ny; f.z = nz
      clamp01v(f)
      if (f.vis > 0.03) drawFish(batch, f, t)
    })
    // 垃圾（瓶 / 袋）：cannon-es 剛體 — 浮在水面互相碰撞、被洋流推、被淨化波推開
    // 注意：applyForce/applyImpulse 不傳第二參數（施力點在質心），否則會注入假力矩瘋轉
    const trashActive = Math.round(env.trash * VIS.trash)
    const sp0 = useStore.getState().spawns
    if (sp0.purify > lastPurifyLC.current) {           // 淨化波：向外+向上衝量把垃圾推散
      lastPurifyLC.current = sp0.purify
      phys.bodies.forEach((b, i) => {
        if (i >= trashActive) return
        const l = Math.hypot(b.position.x, b.position.z) || 1
        b.applyImpulse(phys.f.set((b.position.x / l) * 0.9, 0.35, (b.position.z / l) * 0.9))
      })
    }
    const ywT = seaY()
    const rcap = WR * 0.92
    phys.bodies.forEach((b, i) => {
      const o = trash[i]
      const act = i < trashActive
      b.collisionResponse = act                        // 隱形垃圾不參與碰撞（沉底待命）
      if (act) {
        const depth = ywT - b.position.y               // 吃水深度 → 浮力
        phys.f.set(
          (flow.x * 0.55 + Math.cos(t * 0.4 + o.ph) * 0.1) * b.mass,
          depth > -0.06 ? Math.min(1.4, Math.max(0, depth + 0.1)) * 5.5 * b.mass : 0,
          (flow.z * 0.55 + Math.sin(t * 0.5 + o.ph) * 0.09) * b.mass,
        )
        b.applyForce(phys.f)
      }
      const len = b.position.length()                  // 球壁向內彈簧
      const rmax = WR * 0.9
      if (len > rmax) {
        const kf = ((len - rmax) * 14 * b.mass) / len
        b.applyForce(phys.f.set(-b.position.x * kf, -b.position.y * kf, -b.position.z * kf))
      }
    })
    phys.world.step(1 / 60, Math.min(dt, 0.05), 2)
    trash.forEach((o, i) => {
      o.vis += ((i < trashActive ? 1 : 0) - o.vis) * Math.min(1, dt * 2)
      const b = phys.bodies[i]
      const len2 = b.position.length()                 // 硬邊界：衝量再大也不打穿玻璃殼
      if (len2 > rcap) {
        b.position.scale(rcap / len2, b.position)
        const nx = b.position.x / rcap, ny = b.position.y / rcap, nz = b.position.z / rcap
        const vr = b.velocity.x * nx + b.velocity.y * ny + b.velocity.z * nz
        if (vr > 0) { b.velocity.x -= vr * nx; b.velocity.y -= vr * ny; b.velocity.z -= vr * nz }
      }
      o.x = b.position.x; o.y = b.position.y; o.z = b.position.z
      o.rot += dt * (o.rotSp * 0.4 + b.angularVelocity.y * 0.4)
      if (o.vis > 0.03) (o.kind === 'bag' ? drawBag : drawBottle)(batch, o, t)
    })
    // 訪客（鯨 / 豚 / 龜）
    const sp = useStore.getState().spawns
    for (const type of ['whale', 'dolphin', 'turtle']) {
      if (sp[type] > lastSpawns.current[type]) {
        lastSpawns.current[type] = sp[type]
        const slot = guests.find((s) => !s.active)
        if (slot) {
          slot.active = true; slot.type = type; slot.born = t
          slot.dir = Math.sin(sp[type] * 99) > 0 ? 1 : -1
          slot.heading = slot.dir > 0 ? 0 : Math.PI
          slot.size = type === 'whale' ? 1.05 : type === 'dolphin' ? 0.72 : 0.6
          slot.ph = sp[type]
        }
      }
    }
    let guestPanX = null // 生物游過 → 左右聲道跟隨
    guests.forEach((g) => {
      if (!g.active) return
      const age = t - g.born, dur = 10
      if (age > dur) { g.active = false; return }
      const f = age / dur
      const yw = seaY()
      g.x = (f - 0.5) * 3.0 * g.dir
      if (g.type === 'whale') g.y = Math.min(yw - 0.3, -0.25 + Math.sin(f * Math.PI) * 0.3)
      else if (g.type === 'dolphin') g.y = Math.min(yw - 0.18, yw - 0.4 + Math.sin(f * Math.PI * 3) * 0.22)
      else g.y = -0.62 + Math.sin(f * Math.PI) * 0.18
      g.z = Math.cos(f * Math.PI) * 0.5
      clamp01v(g)
      g.alpha = Math.sin(f * Math.PI)
      ;(g.type === 'whale' ? drawWhale : g.type === 'dolphin' ? drawDolphin : drawTurtle)(batch, g, t)
      bioNodes.push(g)
      if (guestPanX === null) guestPanX = g.x / 1.6
    })
    setCreaturePan(guestPanX === null ? 0 : guestPanX)
    bEnd(batch)
  })
  return <primitive object={batch.lines} />
}

// 生物科技連線（微光細線）
function BioNetwork() {
  const lines = useMemo(() => makeLineLayer(90), [])
  const col = useMemo(() => new THREE.Color('#7fe6ff'), [])
  useFrame(() => { updateLines(lines, bioNodes, 1.15, col, 90); lines.material.opacity = 0.3 + env.glow * 0.4 })
  return <primitive object={lines} />
}

function drawRing(b, cx, cy, cz, rad, a) {
  let px = 0, py = 0, pz = 0
  for (let i = 0; i <= 28; i++) {
    const q = (i / 28) * Math.PI * 2
    const x = cx + Math.cos(q) * rad, z = cz + Math.sin(q) * rad
    if (i > 0) bSeg(b, px, py, pz, x, cy, z, 0.55, 0.9, 1.0, a)
    px = x; py = cy; pz = z
  }
}

// nanoPAD2 打擊墊 → 視覺事件庫（velocity=強度）：16 效果 × 4 bank（bank=強度檔位）
// 0水母脈衝 1浪湧 2漣漪 3氣泡柱 4亮星 5海豚 6鯨魚 7海龜
// 8淨化波 9垃圾投放 10洋流轉向 11閃光 12魚群衝刺 13漣漪三連 14星雨 15大浪+氣泡
function PadFx() {
  const ripples = useMemo(() => makeBatch(9 * 29), [])
  const rState = useMemo(() => Array.from({ length: 9 }, () => ({ active: false, t: 0, x: 0, y: 0, z: 0, str: 0 })), [])
  const bubbles = useMemo(() => {
    const N = 160
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3))
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * 3), 3))
    const m = new THREE.Points(g, new THREE.PointsMaterial({ map: dotTex(), size: 0.08, sizeAttenuation: true, transparent: true, depthWrite: false, fog: false, vertexColors: true, blending: THREE.AdditiveBlending }))
    m.frustumCulled = false
    return { m, st: Array.from({ length: N }, () => ({ active: false, t: 0, x: 0, y: 0, z: 0, vy: 0 })) }
  }, [])
  const spawnRipple = (v) => { const r = rState.find((s) => !s.active); if (!r) return; r.active = true; r.t = 0; r.str = 0.4 + v * 0.9; const a = Math.random() * Math.PI * 2, rr = Math.random() * 0.9; r.x = Math.cos(a) * rr; r.z = Math.sin(a) * rr; r.y = seaY() + 0.02 }
  const spawnBubbles = (v) => { let n = Math.floor(6 + v * 16); const a = Math.random() * Math.PI * 2, rr = 0.3 + Math.random(); const cx = Math.cos(a) * rr, cz = Math.sin(a) * rr; for (const b of bubbles.st) { if (n <= 0) break; if (b.active) continue; b.active = true; b.t = 0; b.x = cx + (Math.random() - 0.5) * 0.25; b.z = cz + (Math.random() - 0.5) * 0.25; b.y = -WR * 0.7 + Math.random() * 0.3; b.vy = 0.4 + v * 0.7; n-- } }
  const lastPurify = useRef(0)
  const spawnPurify = (v) => { // 淨化波：由球心擴散的大漣漪 × 3 + 全場短暫增亮
    for (let i = 0; i < 3; i++) {
      const r = rState.find((s) => !s.active); if (!r) break
      r.active = true; r.t = -i * 0.18; r.str = 1.3 + v * 0.9 + i * 0.35
      r.x = 0; r.z = 0; r.y = seaY() - 0.35 - i * 0.25
    }
    glowBoost = Math.min(1.6, glowBoost + 0.8 + v * 0.5)
  }
  useFrame((_, dt) => {
    const sp = useStore.getState().spawns
    if (sp.purify > lastPurify.current) { lastPurify.current = sp.purify; spawnPurify(purifyMeta.v) } // 清垃圾 / pad 淨化 → 淨化波
    while (padEvents.length) {
      const e = padEvents.shift()
      const v = Math.min(1, e.vel * [0.7, 1, 1.35, 1.7][e.bank || 0]) // bank → 強度檔位
      const st = useStore.getState()
      switch (e.ev % 16) {
        case 0: jellyPulse = Math.max(jellyPulse, v); break
        case 1: waveMomentum = Math.min(3, waveMomentum + v * 1.5); break
        case 2: spawnRipple(v); break
        case 3: spawnBubbles(v); break
        case 4: burstQueue.push({ x: (Math.random() - 0.5) * 2, y: seaY() + 0.1, z: (Math.random() - 0.5) * 2 }); break
        case 5: st.spawnDolphin(); break
        case 6: st.spawnWhale(); break
        case 7: st.spawnTurtle(); break
        case 8: st.purify(v); break // 走 store 計數器：視覺（漣漪+推垃圾）與聲音（琶音）同源觸發
        case 9: st.input('trashCount', Math.min(1, (st.params.trashCount ?? 0) + 0.12 * v)); break
        case 10: { const a2 = Math.random() * Math.PI * 2; st.input('flowX', 0.5 + 0.45 * Math.cos(a2) * v); st.input('flowY', 0.5 + 0.45 * Math.sin(a2) * v); break }
        case 11: glowBoost = Math.min(1.6, glowBoost + 0.5 + v * 0.9); break
        case 12: fishDash = Math.min(2, fishDash + 0.6 + v); break
        case 13: for (let i2 = 0; i2 < 3; i2++) spawnRipple(v * (0.6 + i2 * 0.3)); break
        case 14: for (let i2 = 0; i2 < 4; i2++) burstQueue.push({ x: (Math.random() - 0.5) * 2.4, y: seaY() + 0.2 + Math.random() * 0.9, z: (Math.random() - 0.5) * 2.4 }); break
        default: waveMomentum = Math.min(3, waveMomentum + v * 2); spawnBubbles(v); break
      }
    }
    bBegin(ripples)
    rState.forEach((r) => { if (!r.active) return; r.t += dt; if (r.t < 0) return; if (r.t > 1.6) { r.active = false; return } const rad = r.str * (0.25 + r.t * 1.7); drawRing(ripples, r.x, r.y, r.z, rad, Math.max(0, 1 - r.t / 1.6) * 0.6) })
    bEnd(ripples)
    const bp = bubbles.m.geometry.attributes.position.array, bc = bubbles.m.geometry.attributes.color.array
    bubbles.st.forEach((b, i) => {
      if (!b.active) { bc[i * 3] = bc[i * 3 + 1] = bc[i * 3 + 2] = 0; return }
      b.t += dt; if (b.t > 2) { b.active = false; bc[i * 3] = bc[i * 3 + 1] = bc[i * 3 + 2] = 0; return }
      b.y += b.vy * dt; b.vy *= 0.99
      bp[i * 3] = b.x; bp[i * 3 + 1] = b.y; bp[i * 3 + 2] = b.z
      const a = Math.max(0, 1 - b.t / 2); bc[i * 3] = 0.7 * a; bc[i * 3 + 1] = 0.9 * a; bc[i * 3 + 2] = a
    })
    bubbles.m.geometry.attributes.position.needsUpdate = true
    bubbles.m.geometry.attributes.color.needsUpdate = true
    jellyPulse *= Math.exp(-dt * 3)
  })
  return <group><primitive object={ripples.lines} /><primitive object={bubbles.m} /></group>
}

function Ocean() {
  const g = useRef()
  const wt = useRef()
  useFrame((_, dt) => {
    const p = useStore.getState().params
    if (g.current) g.current.rotation.y += Math.min(0.05, dt) * ((REDUCED ? 0 : 0.04) + (p.spin ?? 0.3) * 1.4 + spinImpulse)
    spinImpulse *= Math.exp(-dt * 1.8)                 // 放手後慣性衰減
    // 陀螺儀：欠阻尼彈簧 → 水面追平衡時會過衝晃動（像真的水）
    gyro.vx += (gyro.tx - gyro.x) * 26 * dt
    gyro.vz += (gyro.tz - gyro.z) * 26 * dt
    const damp = Math.exp(-dt * 4.0)
    gyro.vx *= damp; gyro.vz *= damp
    gyro.x += gyro.vx * dt; gyro.z += gyro.vz * dt
    // 傾動速度 → 注入浪湧（晃手機，海水跟著晃）
    waveMomentum = Math.min(3, waveMomentum + (Math.abs(gyro.vx) + Math.abs(gyro.vz)) * dt * 7)
    if (wt.current) { wt.current.rotation.x = gyro.x; wt.current.rotation.z = gyro.z } // 手機傾斜 → 水面保持水平
  })
  return (
    <>
      <group ref={wt}>
        <WaterVolume />
        <WaterLines />
        <WaterParticles />
      </group>
      <group ref={g}>
        <LineCreatures />
        <PadFx />
        <BioNetwork />
      </group>
    </>
  )
}

// 點擊 / 觸擊 → 亮星星爆發（世界座標佇列，由 StarBursts 消化）
const burstQueue = []
function StarBursts() {
  const MAXB = 5, PER = 14, TOTAL = MAXB * PER
  const pts = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TOTAL * 3), 3))
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TOTAL * 3), 3))
    const m = new THREE.Points(g, new THREE.PointsMaterial({ map: dotTex(), size: 0.14, sizeAttenuation: true, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, vertexColors: true }))
    m.frustumCulled = false; return m
  }, [])
  const bursts = useMemo(() => Array.from({ length: MAXB }, () => ({ active: false, t: 0, ox: 0, oy: 0, oz: 0, dirs: new Float32Array(PER * 3) })), [])
  useFrame((_, dt) => {
    while (burstQueue.length) {
      const q = burstQueue.shift()
      const b = bursts.find((x) => !x.active); if (!b) break
      b.active = true; b.t = 0; b.ox = q.x; b.oy = q.y; b.oz = q.z
      for (let i = 0; i < PER; i++) {
        const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1), sp = 0.45 + Math.random() * 0.95
        b.dirs[i * 3] = Math.sin(ph) * Math.cos(th) * sp
        b.dirs[i * 3 + 1] = Math.cos(ph) * sp
        b.dirs[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * sp
      }
    }
    const pos = pts.geometry.attributes.position.array
    const col = pts.geometry.attributes.color.array
    bursts.forEach((b, bi) => {
      for (let i = 0; i < PER; i++) {
        const o = (bi * PER + i) * 3
        if (!b.active) { col[o] = col[o + 1] = col[o + 2] = 0; continue }
        const e = 1 - Math.pow(1 - Math.min(1, b.t / 1.1), 2)
        pos[o] = b.ox + b.dirs[i * 3] * e
        pos[o + 1] = b.oy + b.dirs[i * 3 + 1] * e
        pos[o + 2] = b.oz + b.dirs[i * 3 + 2] * e
        const a = Math.max(0, 1 - b.t / 1.1) * (0.7 + 0.3 * Math.sin(b.t * 20 + i)) // 閃爍衰減
        col[o] = a; col[o + 1] = 0.95 * a; col[o + 2] = 0.8 * a
      }
      if (b.active) { b.t += dt; if (b.t > 1.1) b.active = false }
    })
    pts.geometry.attributes.position.needsUpdate = true
    pts.geometry.attributes.color.needsUpdate = true
  })
  return <primitive object={pts} />
}

// 薄玻璃球殼：很淡的 fresnel 輪廓 + 局部弧形反光。
// 手勢：拖曳=自轉(+水體慣性)；觸控上下滑=海水高度；兩指縮放=遠近；點擊/觸擊=亮星爆發
function GlassShell() {
  const mat = useMemo(() => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uColor: { value: new THREE.Color('#bfe4ff') }, uOpacity: { value: 0.3 }, uPoke: { value: new THREE.Vector3(0, 0, 1) }, uPokeStr: { value: 0 } },
    vertexShader: 'uniform vec3 uPoke; uniform float uPokeStr; varying vec3 vN; varying vec3 vV; void main(){ vec3 nrm=normalize(position); float infl=smoothstep(0.3,1.0,dot(nrm,uPoke)); float back=smoothstep(0.45,1.0,dot(nrm,-uPoke)); vec3 pos=position-nrm*infl*uPokeStr+nrm*back*uPokeStr*0.35; vec4 mv=modelViewMatrix*vec4(pos,1.0); vN=normalize(normalMatrix*normal); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }',
    fragmentShader: 'varying vec3 vN; varying vec3 vV; uniform vec3 uColor; uniform float uOpacity; void main(){ float f=pow(1.0-max(dot(vN,vV),0.0),3.0); gl_FragColor=vec4(uColor, f*uOpacity); }',
  }), [])
  const arcs = useMemo(() => {
    const mk = (tilt, span, y) => {
      const pts = []
      for (let i = 0; i <= 14; i++) { const a = -span / 2 + (i / 14) * span; pts.push(new THREE.Vector3(Math.cos(a) * SHELL * 0.995, 0, Math.sin(a) * SHELL * 0.995)) }
      const g = new THREE.BufferGeometry().setFromPoints(pts)
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: '#dff2ff', transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      l.rotation.set(tilt, y, 0.35); return l
    }
    return [mk(0.9, 0.9, -0.6), mk(1.05, 0.5, -0.75)]
  }, [])
  const ptrs = useRef(new Map())   // pointerId -> { x, y, t0, moved, touch, point, gathering }
  const pinch = useRef(null)       // { d0, zoom0 }
  const gatherTimer = useRef(0)
  useEffect(() => {
    const mv = (e) => {
      const p = ptrs.current.get(e.pointerId)
      if (!p) return
      const dx = e.clientX - p.x, dy = e.clientY - p.y
      p.x = e.clientX; p.y = e.clientY
      p.moved += Math.abs(dx) + Math.abs(dy)
      const st = useStore.getState()
      if (ptrs.current.size === 2) {                      // 兩指縮放 → 視角遠近
        gather = null
        const [a, b] = [...ptrs.current.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        if (!pinch.current) pinch.current = { d0: d, zoom0: st.params.zoom ?? 0.5 }
        else st.input('zoom', pinch.current.zoom0 + (d - pinch.current.d0) * 0.0035)
        return
      }
      if (ptrs.current.size === 1) {
        if (p.gathering) return                           // 聚集中：手指停留餵魚，不轉球
        st.input('spin', st.params.spin + dx * 0.003)     // 左右拖曳 → 自轉
        spinImpulse = Math.max(-6, Math.min(6, spinImpulse + dx * 0.05)) // 慣性儲能
        waveMomentum = Math.min(2.5, waveMomentum + Math.abs(dx) * 0.012)
        if (p.touch) st.input('seaLevel', (st.params.seaLevel ?? 0.5) - dy * 0.0045) // 觸控上下滑 → 海水高度
      }
    }
    const up = (e) => {
      const p = ptrs.current.get(e.pointerId)
      if (p) {
        if (p.gathering) gather = null                    // 放開 → 魚群解散回巡游
        else if (p.moved < 10 && performance.now() - p.t0 < 450 && p.point) {
          const now = performance.now()
          if (now - lastTapAt > 320) { burstQueue.push(p.point); chime() } // 點擊 → 亮星爆發 + 鈴音（第二擊留給雙擊切換）
          lastTapAt = now
        }
        ptrs.current.delete(e.pointerId)
      }
      if (ptrs.current.size < 2) pinch.current = null
    }
    window.addEventListener('pointermove', mv)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', mv)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [])
  const cols = useMemo(() => ({ base: new THREE.Color('#bfe4ff'), rec: new THREE.Color('#ff8f7a') }), [])
  useFrame((state) => {
    // 狀態氛圍：錄製中球殼微紅呼吸
    const rec = useStore.getState().rec
    if (rec.mode === 'recording') {
      const breath = 0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 2.4)
      mat.uniforms.uColor.value.lerp(cols.rec, 0.08)
      mat.uniforms.uOpacity.value = 0.2 + env.glow * 0.24 + breath * 0.28
    } else {
      mat.uniforms.uColor.value.lerp(cols.base, 0.06)
      mat.uniforms.uOpacity.value = 0.16 + env.glow * 0.24 + glowBoost * 0.22
    }
    mat.uniforms.uPoke.value.copy(poke.dir)
    mat.uniforms.uPokeStr.value = poke.str
  })
  return (
    <group>
      <mesh onPointerDown={(e) => {
        ensureMotion() // 首次手勢：請求陀螺儀/加速度權限（iOS）
        if ((e.button ?? (e.nativeEvent || e).button) === 1) { // 滑鼠中鍵：亮星 + 召喚海豚
          if (e.point) burstQueue.push({ x: e.point.x, y: e.point.y, z: e.point.z })
          chime(); useStore.getState().spawnDolphin(); return
        }
        const ne = e.nativeEvent || e
        const id = e.pointerId ?? ne.pointerId
        ptrs.current.set(id, {
          x: e.clientX ?? ne.clientX, y: e.clientY ?? ne.clientY,
          t0: performance.now(), moved: 0, gathering: false,
          touch: (e.pointerType ?? ne.pointerType) === 'touch',
          point: e.point ? { x: e.point.x, y: e.point.y, z: e.point.z } : null,
        })
        if (ptrs.current.size >= 2) { pinch.current = null; gather = null } // 第二指落下 → 重建縮放基準
        clearTimeout(gatherTimer.current)
        gatherTimer.current = setTimeout(() => {          // 長按 0.5s → 魚群聚集到手指
          const p = ptrs.current.get(id)
          if (p && ptrs.current.size === 1 && p.moved < 15 && p.point) {
            gather = {
              x: p.point.x * 0.55,
              y: Math.max(-WR * 0.75, Math.min(seaY() - 0.2, p.point.y * 0.55)),
              z: p.point.z * 0.55,
            }
            p.gathering = true
          }
        }, 500)
      }}>
        <sphereGeometry args={[SHELL, 48, 48]} />
        <primitive object={mat} attach="material" />
      </mesh>
      {arcs.map((a, i) => <primitive key={i} object={a} />)}
    </group>
  )
}

function AtmosphereGlow() {
  const mat = useMemo(() => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide,
    uniforms: { uColor: { value: new THREE.Color('#4db8ff') }, uPoke: { value: new THREE.Vector3(0, 0, 1) }, uPokeStr: { value: 0 } },
    vertexShader: 'uniform vec3 uPoke; uniform float uPokeStr; varying vec3 vN; varying vec3 vV; void main(){ vec3 nrm=normalize(position); float infl=smoothstep(0.3,1.0,dot(nrm,uPoke)); float back=smoothstep(0.45,1.0,dot(nrm,-uPoke)); vec3 pos=position-nrm*infl*uPokeStr+nrm*back*uPokeStr*0.35; vec4 mv=modelViewMatrix*vec4(pos,1.0); vN=normalize(normalMatrix*normal); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }',
    fragmentShader: 'varying vec3 vN; varying vec3 vV; uniform vec3 uColor; void main(){ float f=pow(1.0-abs(dot(vN,vV)),3.5); gl_FragColor=vec4(uColor, f*0.45); }',
  }), [])
  useFrame(() => { mat.uniforms.uColor.value.setHSL(waterHue() + 0.05, 0.8, 0.26 + env.glow * 0.16 + glowBoost * 0.08); mat.uniforms.uPoke.value.copy(poke.dir); mat.uniforms.uPokeStr.value = poke.str })
  return <mesh scale={1.12}><sphereGeometry args={[SHELL, 48, 48]} /><primitive object={mat} attach="material" /></mesh>
}

function SpaceNetwork() {
  const COUNT = 22
  const nodes = useMemo(() => Array.from({ length: COUNT }, () => {
    const r = SHELL * 1.05 + Math.random() * 1.2, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1)
    return { p: new THREE.Vector3(r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.75, r * Math.sin(ph) * Math.sin(th)), sp: 0.04 + Math.random() * 0.12 }
  }), [])
  const lines = useMemo(() => makeLineLayer(130), [])
  const pts = useMemo(() => {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3))
    const m = new THREE.Points(g, new THREE.PointsMaterial({ map: dotTex(), size: 0.22, sizeAttenuation: true, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, color: new THREE.Color('#7fe0ff') }))
    m.frustumCulled = false; return m
  }, [])
  const col = useMemo(() => new THREE.Color('#5fd0ff'), [])
  useFrame((_, dt) => {
    nodes.forEach((n) => n.p.applyAxisAngle(YAXIS, dt * n.sp * 0.25))
    updateLines(lines, nodes.map((n) => n.p), 1.7, col, 130)
    const pa = pts.geometry.attributes.position.array
    nodes.forEach((n, i) => { pa[i * 3] = n.p.x; pa[i * 3 + 1] = n.p.y; pa[i * 3 + 2] = n.p.z })
    pts.geometry.attributes.position.needsUpdate = true
    const arF = arState.on ? 0 : 1 // AR 實景時收掉太空網絡
    lines.material.opacity = (0.35 + env.glow * 0.35) * arF
    pts.material.opacity = (0.55 + env.glow * 0.3) * arF
  })
  return <group><primitive object={lines} /><primitive object={pts} /></group>
}

// 背景動畫 1：星空閃爍 + 整體緩慢流轉
function Stars() {
  const COUNT = 520
  const { pts, phases } = useMemo(() => {
    const a = new Float32Array(COUNT * 3), c = new Float32Array(COUNT * 3), ph = new Float32Array(COUNT * 2)
    for (let i = 0; i < COUNT; i++) {
      const r = 12 + Math.random() * 30, th = Math.random() * Math.PI * 2, p = Math.acos(2 * Math.random() - 1)
      a[i * 3] = r * Math.sin(p) * Math.cos(th); a[i * 3 + 1] = r * Math.cos(p); a[i * 3 + 2] = r * Math.sin(p) * Math.sin(th)
      c[i * 3] = 0.75; c[i * 3 + 1] = 0.88; c[i * 3 + 2] = 1
      ph[i * 2] = Math.random() * Math.PI * 2          // 相位
      ph[i * 2 + 1] = 0.25 + Math.random() * 1.5       // 各自的閃爍速度
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(a, 3))
    g.setAttribute('color', new THREE.BufferAttribute(c, 3))
    const m = new THREE.Points(g, new THREE.PointsMaterial({ map: dotTex(), size: 0.38, sizeAttenuation: true, transparent: true, opacity: 0.9, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, vertexColors: true }))
    m.frustumCulled = false
    return { pts: m, phases: ph }
  }, [])
  const grp = useRef()
  useFrame((state, dt) => {
    const t = state.clock.elapsedTime
    if (grp.current) grp.current.rotation.y += dt * 0.012
    const col = pts.geometry.attributes.color.array
    for (let i = 0; i < COUNT; i++) {
      const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * phases[i * 2 + 1] + phases[i * 2]))
      col[i * 3] = 0.75 * tw; col[i * 3 + 1] = 0.88 * tw; col[i * 3 + 2] = tw
    }
    pts.geometry.attributes.color.needsUpdate = true
    pts.material.opacity += ((arState.on ? 0 : 0.9) - pts.material.opacity) * Math.min(1, dt * 3) // AR 收星空
  })
  return <group ref={grp}><primitive object={pts} /></group>
}

// 背景動畫 2：偶發流星（拖尾漸淡）
function ShootingStars() {
  const batch = useMemo(() => makeBatch(VIS.shootingStars * 2), [])
  const slots = useMemo(() => Array.from({ length: VIS.shootingStars }, () => ({
    active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, life: 0, next: 2 + Math.random() * 6,
  })), [])
  useFrame((_, dt) => {
    bBegin(batch)
    if (arState.on) { bEnd(batch); return } // AR 實景不放流星
    slots.forEach((s) => {
      if (!s.active) {
        s.next -= dt
        if (s.next <= 0) {
          s.active = true; s.life = 0
          s.x = -7 + Math.random() * 4; s.y = 2.2 + Math.random() * 2.8; s.z = -5 - Math.random() * 5
          const sp = 5.5 + Math.random() * 4
          s.vx = sp; s.vy = -(1.1 + Math.random() * 1.6)
        }
        return
      }
      s.life += dt
      s.x += s.vx * dt; s.y += s.vy * dt
      const a = Math.max(0, Math.sin(Math.min(1, s.life / 1.5) * Math.PI)) * 0.8
      const t1x = s.x - s.vx * 0.11, t1y = s.y - s.vy * 0.11
      const t2x = s.x - s.vx * 0.26, t2y = s.y - s.vy * 0.26
      bSeg(batch, s.x, s.y, s.z, t1x, t1y, s.z, 0.85, 0.95, 1.0, a)
      bSeg(batch, t1x, t1y, s.z, t2x, t2y, s.z, 0.85, 0.95, 1.0, a * 0.3)
      if (s.life > 1.7 || s.x > 9) { s.active = false; s.next = 3 + Math.random() * 7 }
    })
    bEnd(batch)
  })
  return <primitive object={batch.lines} />
}

// 狀態氛圍：播放中的掃描光環（位置 = 播放進度，由球底掃到球頂）
function ScanHalo() {
  const ring = useMemo(() => {
    const N = 72, pts = []
    for (let i = 0; i <= N; i++) { const a = (i / N) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a))) }
    const geo = new THREE.BufferGeometry().setFromPoints(pts)
    const mat = new THREE.LineBasicMaterial({ color: '#8fe0ff', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    const l = new THREE.Line(geo, mat); l.frustumCulled = false; return l
  }, [])
  useFrame(() => {
    const rec = useStore.getState().rec
    if (rec.mode === 'playing' && rec.duration > 0) {
      const f = Math.min(1, rec.playhead / rec.duration)
      const y = -SHELL * 0.96 + f * 2 * SHELL * 0.96
      const r = Math.sqrt(Math.max(0.01, SHELL * SHELL - y * y)) * 1.015
      ring.position.y = y; ring.scale.set(r, 1, r)
      ring.material.opacity = 0.18 + 0.45 * Math.sin(Math.PI * f)
    } else {
      ring.material.opacity += (0 - ring.material.opacity) * 0.12
    }
  })
  return <primitive object={ring} />
}

function FogDriver() {
  const { scene, gl } = useThree()
  const fog = useMemo(() => new THREE.Fog('#05121f', 5, 12), [])
  const bgc = useMemo(() => new THREE.Color('#05101c'), [])
  useEffect(() => { scene.fog = fog; scene.background = bgc; return () => { scene.fog = null; scene.background = null } }, [scene, fog, bgc])
  useFrame((_, dt) => {
    dayT += dt
    if (arState.on) {                       // AR 實景：背景透明、關霧，讓相機畫面透出
      if (scene.background) scene.background = null
      if (scene.fog) scene.fog = null
      gl.setClearAlpha(0)
      return
    }
    if (!scene.background) { scene.background = bgc; scene.fog = fog; gl.setClearAlpha(1) }
    const day = 0.5 + 0.5 * Math.sin((dayT / 240) * Math.PI * 2) // 生態敘事：極慢晝夜（4 分鐘一輪）
    const clar = effClarity()
    const hw = waterHue() + 0.05
    fog.color.setHSL(hw, 0.5, 0.04 + clar * 0.06 + day * 0.012)
    fog.near = 3.5 - (1 - clar) * 1.5; fog.far = 9 + clar * 6
    bgc.setHSL(hw + 0.02, 0.42, 0.045 + day * 0.028)             // 背景隨晝夜 / 場景配色微變
  })
  return null
}

// 滿水位溢流：海水高度 >97% 時，液體不斷從水線沿「球體外緣」滑落（資料超標的視覺警示）
// 液滴抵達球底 → 積成小水痕（擴散淡出的水漬環）
function OverflowFx() {
  const N = 46
  const batch = useMemo(() => makeBatch(N + 6 * 29), [])
  const drops = useMemo(() => Array.from({ length: N }, () => ({ active: false, phi: 0, pol: 0, pol0: 0, vel: 0, t: 0 })), [])
  const puddles = useMemo(() => Array.from({ length: 6 }, () => ({ active: false, t: 0, x: 0, z: 0 })), [])
  const acc = useRef(0)
  useFrame((_, dt) => {
    const over = Math.max(0, (env.seaLevel - 0.97) / 0.03) // 0..1（100% 滿）
    const SO = SHELL + 0.015
    if (over > 0) {
      acc.current += dt * (3 + over * 16)
      const yw = Math.min(SO * 0.97, seaY())
      const pol0 = Math.acos(Math.max(-1, Math.min(1, yw / SO)))
      while (acc.current > 1) {
        acc.current -= 1
        const d = drops.find((s) => !s.active); if (!d) break
        d.active = true; d.phi = Math.random() * Math.PI * 2
        d.pol = d.pol0 = pol0 + Math.random() * 0.04; d.vel = 0.1 + Math.random() * 0.15; d.t = 0
      }
    }
    bBegin(batch)
    drops.forEach((d) => {
      if (!d.active) return
      d.t += dt
      d.vel += dt * 0.55                       // 沿球面往下加速滑落
      d.pol += d.vel * dt
      if (d.pol > Math.PI * 0.96) {            // 到球底 → 積水痕
        d.active = false
        const p = puddles.find((q) => !q.active)
        if (p) { p.active = true; p.t = 0; p.x = Math.cos(d.phi) * Math.sin(d.pol) * SO * 0.6; p.z = Math.sin(d.phi) * Math.sin(d.pol) * SO * 0.6 }
        return
      }
      const y1 = Math.cos(d.pol) * SO, r1 = Math.sin(d.pol) * SO
      const p2 = Math.max(d.pol0, d.pol - 0.05 - d.vel * 0.06) // 拖尾（短線段 = 液滴流痕）
      const y2 = Math.cos(p2) * SO, r2 = Math.sin(p2) * SO
      const cs = Math.cos(d.phi), sn = Math.sin(d.phi)
      const a = Math.min(1, d.t * 4) * Math.max(0.15, 1 - (d.pol - d.pol0) / 2.4) * 0.85
      bSeg(batch, cs * r1, y1, sn * r1, cs * r2, y2, sn * r2, wcol.r + 0.2, wcol.g + 0.15, wcol.b, a)
    })
    puddles.forEach((p) => {                     // 球底水痕：小水漬環擴散淡出
      if (!p.active) return
      p.t += dt
      if (p.t > 1.1) { p.active = false; return }
      drawRing(batch, p.x, -SO * 0.985, p.z, 0.05 + p.t * 0.3, Math.max(0, 1 - p.t / 1.1) * 0.35)
    })
    bEnd(batch)
  })
  return <primitive object={batch.lines} />
}

// 背景銀河：傾斜帶狀星雲塵（成簇），濃度由「河川即時水位資料」驅動（水豐 → 銀河更亮）
function Galaxy() {
  const N = REDUCED ? 400 : 1300
  const pts = useMemo(() => {
    const a = new Float32Array(N * 3), c = new Float32Array(N * 3)
    const tilt = 0.49
    for (let i = 0; i < N; i++) {
      const th = Math.random() * Math.PI * 2
      const spread = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5 // 近似高斯
      const r = 16 + Math.random() * 26
      const y0 = spread * 3.2 * (0.4 + 0.6 * Math.abs(Math.sin(th * 2.3)))       // 沿帶成簇
      const x = Math.cos(th) * r, z = Math.sin(th) * r
      a[i * 3] = x
      a[i * 3 + 1] = y0 * Math.cos(tilt) + z * Math.sin(tilt) * 0.35
      a[i * 3 + 2] = z * Math.cos(tilt) * 0.9 - y0 * Math.sin(tilt)
      const warm = Math.random() < 0.18
      const base = 0.3 + Math.random() * 0.55
      c[i * 3] = base * (warm ? 1 : 0.78); c[i * 3 + 1] = base * 0.87; c[i * 3 + 2] = base * (warm ? 0.72 : 1)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(a, 3))
    g.setAttribute('color', new THREE.BufferAttribute(c, 3))
    const m = new THREE.Points(g, new THREE.PointsMaterial({ map: dotTex(), size: 0.3, sizeAttenuation: true, transparent: true, opacity: 0, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, vertexColors: true }))
    m.frustumCulled = false; return m
  }, [])
  const grp = useRef()
  useFrame((_, dt) => {
    if (grp.current) grp.current.rotation.y += dt * 0.004
    let inten = 0.55                                        // 河川資料 → 銀河濃度
    const gov = useStore.getState().gov
    if (gov && gov.rivers && gov.rivers.length) {
      let s2 = 0, n2 = 0
      gov.rivers.forEach((rv) => { if (typeof rv.pct === 'number') { s2 += Math.max(0, Math.min(1, rv.pct)); n2++ } })
      if (n2) inten = 0.35 + (s2 / n2) * 0.65
    }
    const target = arState.on ? 0 : (0.22 + inten * 0.5) * (0.5 + env.glow * 0.6)
    pts.material.opacity += (target - pts.material.opacity) * Math.min(1, dt * 2)
  })
  return <group ref={grp} rotation={[0.18, 0, 0.35]}><primitive object={pts} /></group>
}

// 潮汐海況的背景月亮：盈虧 = 當日月齡（由 CWA 農曆日期推得，與潮汐資料同源），
// 位置 = 月中天時刻與「當下時刻」決定的天空弧線（新月正午、上弦傍晚、滿月午夜中天）。
// 資料播放時，時刻跟著序列走 → 24h 潮位起伏的同時月亮真的劃過天空；靜止時用現實時刻。
const MOON_R = 6.4, MOON_Z = -9
function MoonSky() {
  const mesh = useRef(), halo = useRef()
  const mat = useMemo(() => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uPhase: { value: 0 }, uAlpha: { value: 0 }, uTint: { value: new THREE.Color('#f6eed2') } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: `varying vec2 vUv; uniform float uPhase; uniform float uAlpha; uniform vec3 uTint;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),f.x), mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0,1.0)),f.x), f.y); }
      void main(){
        vec2 p = vUv*2.0-1.0; float r2 = dot(p,p);
        if (r2 > 1.0) discard;
        vec3 n = vec3(p, sqrt(1.0-r2));
        vec3 L = vec3(sin(uPhase), 0.0, -cos(uPhase));           // 太陽方向：新月在背後、滿月在前、上弦在右
        float ndl = dot(n, L);
        float lit = smoothstep(-0.02, 0.10, ndl);
        float maria = 0.55*noise(p*2.6+1.7) + 0.30*noise(p*6.0+4.2) + 0.15*noise(p*13.0);
        float surf = 0.62 + 0.38*maria;
        float rim = smoothstep(0.86, 1.0, sqrt(r2));
        float shade = 0.55 + 0.45*max(ndl, 0.0);
        vec3 col = uTint*surf*shade*lit + uTint*0.05;              // 暗面留一點點地球反照
        gl_FragColor = vec4(col, (lit*0.92 + 0.10 + rim*0.20*lit) * uAlpha);
      }`,
  }), [])
  const haloMat = useMemo(() => new THREE.SpriteMaterial({ map: dotTex(), color: '#dfe8ff', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }), [])
  const s = useRef({ alpha: 0, x: -MOON_R, y: 0.6, phase: 0, init: false })
  const { camera, size } = useThree()
  useFrame((_, dt) => {
    const st = useStore.getState()
    // 依相機可視範圍夾住月亮（側邊面板 / 手機直式時畫布較窄，不能被切掉）
    const dist = Math.max(4, camera.position.z - MOON_Z)
    const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * dist
    const halfW = halfH * (size.width / Math.max(1, size.height))
    const xr = Math.max(2, Math.min(MOON_R, halfW - 1.6))
    const ymax = Math.max(1.5, halfH - 1.6)
    const o = st.govOption && st.govOption()
    const tide = o && o.kind === 'tide' && o.series
    const S = s.current
    let wantAlpha = 0, tx = S.x, ty = S.y, tPhase = S.phase
    if (tide && !arState.on) {
      const playing = seriesMeta.active && st.rec.mode === 'playing' && seriesMeta.points.length > 0
      let hour
      if (playing) {                                     // 序列時刻（相鄰兩點間平滑內插）
        const pts = seriesMeta.points
        const f = Math.max(0, st.rec.playhead / seriesMeta.step)
        const i0 = Math.min(pts.length - 1, Math.floor(f)), i1 = Math.min(pts.length - 1, i0 + 1)
        hour = pts[i0].h + (pts[i1].h - pts[i0].h) * (f - Math.floor(f))
      } else { const d = new Date(); hour = d.getHours() + d.getMinutes() / 60 }
      // 月齡：資料播放（時刻屬於序列那一天）或資料日期＝今天 → 用 CWA 農曆日期推；資料檔已過期則退回天文公式（永遠是當下）
      const now = new Date()
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      const fromLunar = (playing || tide.date === todayStr) ? ageFromLunar(tide.lunar, hour) : null
      const age = fromLunar != null ? fromLunar : moonAge(playing ? dateAtHour(tide.date, hour) : now)
      const sky = moonSky(age, hour)
      tPhase = moonPhaseAngle(age)
      if (sky.up > 0.05) {                               // 在地平線上：沿弧線劃過（東升左 → 西落右）
        tx = Math.sin(sky.H) * xr; ty = Math.min(ymax, 0.6 + sky.up * 3.4)
        wantAlpha = playing ? Math.min(1, (sky.up - 0.05) / 0.25) : 1
      } else if (!playing) {                             // 靜止且尚在地平線下：貼在將升起 / 剛落下的那一側，半透明
        tx = (sky.H < 0 ? -1 : 1) * xr; ty = 0.6; wantAlpha = 0.5
      }                                                  // 播放中位於地平線下 → 淡出（月落 / 月出前）
    }
    const k = Math.min(1, dt * 3)
    if (!S.init) { S.init = true; S.x = tx; S.y = ty; S.phase = tPhase }
    S.alpha += (wantAlpha - S.alpha) * k
    if (wantAlpha > 0.02) {
      // 靜止且在地平線下時，貼靠的那一側會在下中天（H=±π）瞬間換邊：直接淡出再從新的一側淡入，不要橫掃過整個畫面
      const side = tx < 0 ? -1 : 1
      if (S.side && S.side !== side && Math.abs(tx - S.x) > xr) { S.alpha = 0; S.x = tx; S.y = ty }
      S.side = side
      if (S.alpha < 0.05) { S.x = tx; S.y = ty; S.phase = tPhase }                                            // 剛要淡入：直接就位，不從舊座標 / 舊月相滑過來
      else {
        S.x += (tx - S.x) * k; S.y += (ty - S.y) * k
        let dp = tPhase - S.phase; dp = Math.atan2(Math.sin(dp), Math.cos(dp))                                // 相位走最短弧（新月 2π→0 不倒轉整個週期）
        S.phase += dp * k
      }
    }                                                                                                       // 淡出時位置凍結，避免滑走
    if (mesh.current) { mesh.current.visible = S.alpha > 0.01; mesh.current.position.set(S.x, S.y, MOON_Z) }
    if (halo.current) { halo.current.visible = S.alpha > 0.01; halo.current.position.set(S.x, S.y, MOON_Z - 0.1) }
    mat.uniforms.uPhase.value = S.phase
    mat.uniforms.uAlpha.value = S.alpha
    haloMat.opacity = S.alpha * (0.06 + 0.2 * moonIllum((S.phase / (Math.PI * 2)) * 29.530588853))
  })
  return (
    <>
      <mesh ref={mesh} scale={2.5} visible={false}><planeGeometry args={[1, 1]} /><primitive object={mat} attach="material" /></mesh>
      <sprite ref={halo} scale={[7.5, 7.5, 1]} visible={false}><primitive object={haloMat} attach="material" /></sprite>
    </>
  )
}

// 球外生態：鳥群線稿（V 隊形、拍翅）繞球飛行；群數由鳥類調查資料（該海況流域鳥種數 × 現實季節）驅動
function BirdFlocks() {
  const batch = useMemo(() => makeBatch(240), [])
  const flocks = useMemo(() => Array.from({ length: 5 }, (_, i) => ({
    ang: i * 1.9, r: 3.1 + (i % 3) * 0.7, y: 1.0 + (i % 4) * 0.55,
    speed: (0.05 + (i % 3) * 0.03) * (i % 2 ? 1 : -1), ph: i * 2.3, n: 5 + (i % 3) * 2, vis: 0,
  })), [])
  const flockTarget = useRef(2)
  const acc = useRef(9)
  useFrame((state, dt) => {
    const t = state.clock.elapsedTime
    bBegin(batch)
    // 群數 = 該流域年度鳥種數的基準 × 現實季節（鳥類調查逐月鳥種數；birdMonth 可手動預覽其他月份）。每 0.5 秒重算即可。
    acc.current += dt
    if (acc.current > 0.5) {
      acc.current = 0
      const st = useStore.getState()
      const o = st.govOption && st.govOption()
      const bd = o && o.birds
      if (bd) {
        const mo = st.birdMonth != null ? st.birdMonth : new Date().getMonth()
        const s = birdSeasonal(bd.monthly, mo)
        flockTarget.current = flockCount(bd.species, s ? s.rel : 1)
      } else flockTarget.current = 2
    }
    const flockActive = flockTarget.current
    flocks.forEach((f, i) => {
      f.vis += ((i < flockActive ? 1 : 0) - f.vis) * Math.min(1, dt * 1.5)
      if (f.vis < 0.03) return
      f.ang += dt * f.speed * (0.6 + env.swim * 0.6)
      const cx = Math.cos(f.ang) * f.r, cz = Math.sin(f.ang) * f.r
      const cy = f.y + Math.sin(t * 0.3 + f.ph) * 0.3
      const heading = f.ang + (f.speed > 0 ? Math.PI / 2 : -Math.PI / 2)
      const cs = Math.cos(heading), sn = Math.sin(heading)
      for (let k = 0; k < f.n; k++) {
        const side = k % 2 ? 1 : -1, rank = Math.ceil(k / 2)   // V 隊形
        const lx = -rank * 0.22, lz = side * rank * 0.16
        const bx = cx + lx * cs - lz * sn
        const bz = cz + lx * sn + lz * cs
        const by = cy + Math.sin(t * 2 + k) * 0.04
        const flap = Math.sin(t * 7 + f.ph + k * 0.7) * 0.09   // 拍翅
        const a = f.vis * 0.5
        const wx = -0.1 * cs, wz = -0.1 * sn                    // 後掠
        const px = -0.11 * sn, pz2 = 0.11 * cs                  // 側向
        bSeg(batch, bx, by, bz, bx + wx + px, by + flap, bz + wz + pz2, 0.92, 0.95, 1.0, a)
        bSeg(batch, bx, by, bz, bx + wx - px, by + flap, bz + wz - pz2, 0.92, 0.95, 1.0, a)
      }
    })
    bEnd(batch)
  })
  return <primitive object={batch.lines} />
}

// 果凍壓凹：背景點擊拖曳，離球體越近壓越深，放開欠阻尼回彈（寫入 poke，球殼/大氣頂點內凹）
function JellyController() {
  const { camera, raycaster, pointer, gl } = useThree()
  const pressing = useRef(false)
  const bg = useRef(false)
  const rayD = () => { // 射線離球心最近距離
    raycaster.setFromCamera(pointer, camera)
    const r = raycaster.ray
    const tt = Math.max(0, -r.direction.dot(r.origin))
    _cl.copy(r.origin).addScaledVector(r.direction, tt)
    return _cl.length()
  }
  useEffect(() => {
    const el = gl.domElement
    const down = (e) => {
      pressing.current = true
      const rect = el.getBoundingClientRect()
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1
      const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera({ x: nx, y: ny }, camera)
      const r = raycaster.ray
      const tt = Math.max(0, -r.direction.dot(r.origin))
      _cl.copy(r.origin).addScaledVector(r.direction, tt)
      bg.current = _cl.length() > SHELL // 只有從「背景」按下（射線不穿球）才啟用果凍壓凹
    }
    const up = () => { pressing.current = false }
    el.addEventListener('pointerdown', down)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => { el.removeEventListener('pointerdown', down); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up) }
  }, [gl, camera, raycaster])
  useFrame((_, dt) => {
    if (pressing.current && bg.current) {
      const d = rayD()
      poke.target = d > SHELL ? Math.max(0, Math.min(1, 1 - (d - SHELL) / (SHELL * 0.6))) * 0.42 : 0 // 離球越近壓越深
      if (poke.target > 0.001) poke.dir.copy(_cl).normalize()
    } else poke.target = 0
    poke.vel += (poke.target - poke.str) * 58 * dt // 欠阻尼彈簧 → 放開回彈晃動
    poke.vel *= Math.exp(-dt * 5.2)
    poke.str += poke.vel * dt
  })
  return null
}

function CameraRig() {
  const { camera } = useThree()
  const tmp = useMemo(() => new THREE.Vector3(), [])
  useFrame(() => { const p = useStore.getState().params; const dist = 4.6 + (1 - (p.zoom ?? 0.5)) * 4; tmp.set(0, 0.4, dist); camera.position.lerp(tmp, 0.06); camera.lookAt(0, 0, 0) })
  return null
}

export default function Scene3D() {
  return (
    <Canvas camera={{ position: [0, 0.4, 7], fov: 45 }} dpr={[1, 2]} gl={{ preserveDrawingBuffer: true, antialias: true, alpha: true }}>
      <EnvDriver />
      <FogDriver />
      <Galaxy />
      <Stars />
      <ShootingStars />
      <MoonSky />
      <BirdFlocks />
      <ambientLight intensity={0.6} />
      <Ocean />
      <GlassShell />
      <OverflowFx />
      <ScanHalo />
      <AtmosphereGlow />
      <SpaceNetwork />
      <StarBursts />
      <JellyController />
      <CameraRig />
    </Canvas>
  )
}
