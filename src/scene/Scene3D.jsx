import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useRef, useMemo, useEffect } from 'react'
import * as THREE from 'three'
import { useStore } from '../store/useStore.js'

// 效能：場景一律用 useStore.getState() 在 useFrame 內讀參數，MIDI 訊息不觸發 React re-render。
// 本階段用程序化波浪近似水的運動（非流體模擬），球殼用簡化的邊緣反光（fresnel，非多層折射）。

const R = 1.95      // 內容半徑
const SHELL = 2.02  // 球殼半徑
const _v = new THREE.Vector3()

// ---- 平滑後的環境值（每幀由 EnvDriver 往目標 lerp，確保所有變化不跳動）----
const env = { seaLevel: 0.55, current: 0.45, clarity: 0.6, jelly: 0.5, fish: 0.55, swim: 0.5, trash: 0.25, glow: 0.6 }
const seaY = () => (env.seaLevel - 0.5) * 2.2
const waveH = (x, z, t) => {
  const c = 0.4 + env.current * 1.6
  return Math.sin(x * 1.6 + t * c) * 0.11 + Math.sin(z * 2.1 - t * c * 0.8) * 0.07 + Math.sin((x + z) * 2.7 + t * c * 1.3) * 0.04
}
// 生態耦合：垃圾越多 → 水越濁、生物越少
const effClarity = () => env.clarity * (1 - 0.7 * env.trash)
const effFish = () => Math.max(0, env.fish * (1 - 0.8 * env.trash))
const effJelly = () => Math.max(0, env.jelly * (1 - 0.6 * env.trash))

// ---- Canvas 貼圖產生器（js 繪製，快取）----
const TEXS = {}
function makeTex(key, size, draw) {
  if (TEXS[key]) return TEXS[key]
  const c = document.createElement('canvas'); c.width = c.height = size
  const g = c.getContext('2d'); draw(g, size)
  const t = new THREE.CanvasTexture(c); t.anisotropy = 2
  TEXS[key] = t; return t
}
const glow = (g, color, blur) => { g.shadowColor = color; g.shadowBlur = blur }

const glyphTex = (ch) => makeTex('gly' + ch, 128, (g, s) => {
  glow(g, 'rgba(130,220,255,0.9)', 16)
  g.fillStyle = 'rgba(205,240,255,0.95)'
  g.font = `bold ${s * 0.62}px "PingFang TC", system-ui, sans-serif`
  g.textAlign = 'center'; g.textBaseline = 'middle'
  g.fillText(ch, s / 2, s / 2)
})
const radialTex = () => makeTex('radial', 128, (g, s) => {
  const grd = g.createRadialGradient(s / 2, s / 2, s * 0.08, s / 2, s / 2, s * 0.5)
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.72, 'rgba(255,255,255,1)'); grd.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grd; g.fillRect(0, 0, s, s)
})
const jellyTex = () => makeTex('jelly', 128, (g, s) => {
  glow(g, 'rgba(155,215,255,0.9)', 26)
  g.fillStyle = 'rgba(180,225,255,0.6)'
  g.beginPath(); g.ellipse(s / 2, s * 0.42, s * 0.26, s * 0.2, 0, Math.PI, 0); g.closePath(); g.fill()
  g.strokeStyle = 'rgba(195,232,255,0.55)'; g.lineWidth = s * 0.02
  for (let i = -2; i <= 2; i++) { const x = s / 2 + i * s * 0.09; g.beginPath(); g.moveTo(x, s * 0.44); g.bezierCurveTo(x + s * 0.03, s * 0.6, x - s * 0.03, s * 0.74, x, s * 0.86); g.stroke() }
})
const fishTex = () => makeTex('fish', 128, (g, s) => {
  glow(g, 'rgba(140,220,255,0.85)', 14)
  g.fillStyle = 'rgba(185,232,255,0.92)'
  g.beginPath(); g.ellipse(s * 0.46, s * 0.5, s * 0.28, s * 0.15, 0, 0, 7); g.fill()
  g.beginPath(); g.moveTo(s * 0.2, s * 0.5); g.lineTo(s * 0.08, s * 0.36); g.lineTo(s * 0.08, s * 0.64); g.closePath(); g.fill()
})
const trashTex = () => makeTex('trash', 128, (g, s) => {
  glow(g, 'rgba(90,110,120,0.5)', 8)
  g.fillStyle = 'rgba(120,135,140,0.85)'
  g.fillRect(s * 0.42, s * 0.32, s * 0.16, s * 0.42)
  g.fillRect(s * 0.46, s * 0.22, s * 0.08, s * 0.12)
  g.fillStyle = 'rgba(80,95,100,0.7)'; g.fillRect(s * 0.45, s * 0.18, s * 0.1, s * 0.05)
})
const whaleTex = () => makeTex('whale', 256, (g, s) => {
  glow(g, 'rgba(120,180,240,0.8)', 22)
  g.fillStyle = 'rgba(150,195,240,0.92)'
  g.beginPath(); g.ellipse(s * 0.52, s * 0.5, s * 0.36, s * 0.2, 0, 0, 7); g.fill()
  g.beginPath(); g.moveTo(s * 0.18, s * 0.5); g.quadraticCurveTo(s * 0.05, s * 0.3, s * 0.02, s * 0.34); g.quadraticCurveTo(s * 0.12, s * 0.5, s * 0.02, s * 0.66); g.quadraticCurveTo(s * 0.05, s * 0.7, s * 0.18, s * 0.5); g.fill()
  g.fillStyle = 'rgba(20,40,70,0.85)'; g.beginPath(); g.arc(s * 0.76, s * 0.46, s * 0.02, 0, 7); g.fill()
})
const dolphinTex = () => makeTex('dolphin', 256, (g, s) => {
  glow(g, 'rgba(150,210,255,0.85)', 18)
  g.fillStyle = 'rgba(180,222,255,0.92)'
  g.beginPath(); g.ellipse(s * 0.5, s * 0.52, s * 0.34, s * 0.14, -0.12, 0, 7); g.fill()
  g.beginPath(); g.moveTo(s * 0.5, s * 0.4); g.lineTo(s * 0.56, s * 0.24); g.lineTo(s * 0.63, s * 0.44); g.closePath(); g.fill()
  g.beginPath(); g.moveTo(s * 0.8, s * 0.5); g.lineTo(s * 0.93, s * 0.46); g.lineTo(s * 0.82, s * 0.57); g.closePath(); g.fill()
  g.beginPath(); g.moveTo(s * 0.18, s * 0.52); g.lineTo(s * 0.06, s * 0.42); g.lineTo(s * 0.1, s * 0.55); g.lineTo(s * 0.06, s * 0.62); g.closePath(); g.fill()
})
const turtleTex = () => makeTex('turtle', 256, (g, s) => {
  glow(g, 'rgba(140,225,200,0.85)', 18)
  g.fillStyle = 'rgba(155,225,195,0.9)'
  g.beginPath(); g.ellipse(s * 0.5, s * 0.52, s * 0.26, s * 0.22, 0, 0, 7); g.fill()
  ;[[0.28, 0.34], [0.72, 0.34], [0.28, 0.72], [0.72, 0.72]].forEach(([fx, fy]) => { g.beginPath(); g.ellipse(s * fx, s * fy, s * 0.1, s * 0.05, fx < 0.5 ? -0.6 : 0.6, 0, 7); g.fill() })
  g.beginPath(); g.ellipse(s * 0.5, s * 0.24, s * 0.08, s * 0.06, 0, 0, 7); g.fill()
  g.strokeStyle = 'rgba(40,90,80,0.5)'; g.lineWidth = s * 0.012
  g.beginPath(); g.moveTo(s * 0.5, s * 0.32); g.lineTo(s * 0.5, s * 0.72); g.moveTo(s * 0.32, s * 0.52); g.lineTo(s * 0.68, s * 0.52); g.stroke()
})
const creatureTex = (type) => (type === 'whale' ? whaleTex() : type === 'dolphin' ? dolphinTex() : turtleTex())

function buildGrid(seg, size) {
  const geo = new THREE.BufferGeometry(), N = seg + 1, verts = [], uvs = [], idx = []
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    verts.push((i / seg - 0.5) * size, 0, (j / seg - 0.5) * size); uvs.push(i / seg, j / seg)
  }
  for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) {
    const a = j * N + i, b = a + 1, c = a + N, d = c + 1; idx.push(a, c, b, b, c, d)
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geo.setIndex(idx)
  return geo
}
function sprite(map, extra) { return new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, opacity: 0, fog: true, ...extra })) }

// ---- 每幀把 env 往目標平滑 ----
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
  })
  return null
}

function WaterVolume() {
  const ref = useRef()
  useFrame(() => {
    const m = ref.current; if (!m) return
    const clar = effClarity()
    m.material.color.setHSL(0.57 - (1 - clar) * 0.14, 0.5 + (1 - clar) * 0.2, 0.16 + clar * 0.12)
    m.material.opacity = 0.16 + (1 - clar) * 0.3
  })
  return <mesh ref={ref}><sphereGeometry args={[R * 0.99, 32, 32]} /><meshBasicMaterial color="#0a3a66" transparent opacity={0.2} side={THREE.BackSide} depthWrite={false} /></mesh>
}

function WaveSurface() {
  const ref = useRef()
  const geo = useMemo(() => buildGrid(48, 3.9), [])
  const alpha = useMemo(() => radialTex(), [])
  useFrame((state) => {
    const m = ref.current; if (!m) return
    const t = state.clock.elapsedTime
    const pos = geo.attributes.position
    for (let i = 0; i < pos.count; i++) pos.setY(i, waveH(pos.getX(i), pos.getZ(i), t))
    pos.needsUpdate = true
    const y = seaY(); m.position.y = y
    const rad = (Math.sqrt(Math.max(0.02, R * R - y * y)) * 0.98) / 1.95
    m.scale.set(rad, 1, rad)
    const clar = effClarity()
    m.material.color.setHSL(0.55, 0.6, 0.36 + clar * 0.26)
    m.material.opacity = 0.28 + env.glow * 0.24
  })
  return <mesh ref={ref} geometry={geo}><meshBasicMaterial color="#4fb0e0" transparent opacity={0.5} alphaMap={alpha} side={THREE.DoubleSide} depthWrite={false} /></mesh>
}

function Jellies() {
  const MAX = 12
  const pool = useMemo(() => Array.from({ length: MAX }, (_, i) => ({ m: sprite(jellyTex()), seed: i * 13.7, x: Math.sin(i * 4.1) * 1.2, y: Math.cos(i * 2.7) * 0.8, z: Math.sin(i * 6.3) * 1.1, ph: i })), [])
  useFrame((state, dt) => {
    const t = state.clock.elapsedTime, active = Math.round(effJelly() * MAX)
    pool.forEach((j, i) => {
      j.m.material.opacity += ((i < active ? 0.85 : 0) - j.m.material.opacity) * Math.min(1, dt * 2)
      j.y += Math.sin(t * 0.4 + j.seed) * (0.03 + env.swim * 0.05) * dt
      j.x += Math.sin(t * 0.3 + j.seed) * 0.002 * (1 + env.current * 2)
      _v.set(j.x, seaY() * 0.3 + j.y, j.z); if (_v.length() > R * 0.9) _v.setLength(R * 0.9); j.m.position.copy(_v)
      const pulse = 1 + Math.sin(t * 1.5 + j.ph) * 0.12
      j.m.scale.set(0.5 * pulse, 0.55 * pulse, 1)
    })
  })
  return <group>{pool.map((j, i) => <primitive key={i} object={j.m} />)}</group>
}

function Fish() {
  const MAX = 48
  const pool = useMemo(() => Array.from({ length: MAX }, (_, i) => ({ m: sprite(fishTex()), a: i * 0.5, r: 0.6 + (i % 5) * 0.24, y: Math.sin(i * 3.1) * 1.0, sp: 0.5 + (i % 7) * 0.08 })), [])
  useFrame((state, dt) => {
    const t = state.clock.elapsedTime, active = Math.round(effFish() * MAX)
    pool.forEach((f, i) => {
      f.m.material.opacity += ((i < active ? 0.9 : 0) - f.m.material.opacity) * Math.min(1, dt * 2)
      f.a += dt * (0.2 + env.current * 0.8) * (0.4 + env.swim) * f.sp
      _v.set(Math.cos(f.a) * f.r, f.y + Math.sin(t * 0.7 + i) * 0.1, Math.sin(f.a) * f.r)
      if (_v.length() > R * 0.92) _v.setLength(R * 0.92); f.m.position.copy(_v)
      f.m.scale.set(0.26 * (Math.cos(f.a) > 0 ? 1 : -1), 0.26, 1)
    })
  })
  return <group>{pool.map((f, i) => <primitive key={i} object={f.m} />)}</group>
}

function Trash() {
  const MAX = 20
  const pool = useMemo(() => Array.from({ length: MAX }, (_, i) => ({ m: sprite(trashTex()), x: Math.sin(i * 5.3) * 1.3, y: Math.cos(i * 3.9) * 1.2, z: Math.sin(i * 2.1) * 1.2 })), [])
  useFrame((state, dt) => {
    const t = state.clock.elapsedTime, active = Math.round(env.trash * MAX)
    pool.forEach((o, i) => {
      o.m.material.opacity += ((i < active ? 0.8 : 0) - o.m.material.opacity) * Math.min(1, dt * 2)
      o.y += Math.sin(t * 0.3 + i) * 0.003
      _v.set(o.x + Math.sin(t * 0.2 + i) * 0.3, o.y, o.z); if (_v.length() > R * 0.9) _v.setLength(R * 0.9); o.m.position.copy(_v)
      o.m.scale.setScalar(0.3)
    })
  })
  return <group>{pool.map((o, i) => <primitive key={i} object={o.m} />)}</group>
}

function FlowingText() {
  const chars = useMemo(() => ['海', '浪', '潮', '深', '流', '光', '靜', '夢', '0', '1', '7', '2', '0', '2', '6', '∞'], [])
  const pool = useMemo(() => Array.from({ length: 14 }, (_, i) => ({ m: sprite(glyphTex(chars[i % chars.length])), x: Math.sin(i * 12.9) * 1.4, z: Math.cos(i * 7.3) * 1.2, idx: i })), [chars])
  useFrame((state, dt) => {
    const t = state.clock.elapsedTime, y0 = seaY()
    pool.forEach((it) => {
      it.x += (0.05 + env.current * 0.4) * (0.4 + env.swim) * dt
      const lim = Math.sqrt(Math.max(0.1, R * R - it.z * it.z)) * 0.9
      if (it.x > lim) it.x = -lim
      it.m.position.set(it.x, y0 + waveH(it.x, it.z, t) + 0.12, it.z)
      const edge = 1 - Math.min(1, Math.abs(it.x) / lim)
      it.m.material.opacity = (0.28 + 0.7 * edge) * (0.65 + 0.35 * Math.sin(t * 0.8 + it.idx))
      it.m.scale.setScalar(0.42)
    })
  })
  return <group>{pool.map((p, i) => <primitive key={i} object={p.m} />)}</group>
}

function Guests() {
  const pool = useMemo(() => Array.from({ length: 5 }, () => ({ m: sprite(null), active: false, type: null, born: 0, dir: 1 })), [])
  const last = useRef({ whale: 0, dolphin: 0, turtle: 0 })
  useFrame((state) => {
    const t = state.clock.elapsedTime, sp = useStore.getState().spawns
    for (const type of ['whale', 'dolphin', 'turtle']) {
      if (sp[type] > last.current[type]) {
        last.current[type] = sp[type]
        const slot = pool.find((s) => !s.active)
        if (slot) { slot.active = true; slot.type = type; slot.born = t; slot.dir = Math.sin(sp[type] * 99) > 0 ? 1 : -1; slot.m.material.map = creatureTex(type); slot.m.material.needsUpdate = true }
      }
    }
    pool.forEach((slot) => {
      if (!slot.active) { slot.m.material.opacity = 0; return }
      const age = t - slot.born, dur = 9
      if (age > dur) { slot.active = false; slot.m.material.opacity = 0; return }
      const f = age / dur
      const baseY = slot.type === 'turtle' ? -0.4 : slot.type === 'whale' ? 0.05 : 0.35
      _v.set((f - 0.5) * 3.2 * slot.dir, baseY + Math.sin(f * Math.PI) * 0.25 + Math.sin(t * 1.2) * 0.05, Math.cos(f * Math.PI) * 0.7)
      if (_v.length() > R * 0.96) _v.setLength(R * 0.96); slot.m.position.copy(_v)
      const size = slot.type === 'whale' ? 1.7 : slot.type === 'dolphin' ? 1.05 : 0.85
      slot.m.scale.set(size * slot.dir, size, 1)
      slot.m.material.opacity = Math.sin(f * Math.PI) * 0.95
    })
  })
  return <group>{pool.map((s, i) => <primitive key={i} object={s.m} />)}</group>
}

function Ocean() {
  const g = useRef()
  useFrame((_, dt) => { const p = useStore.getState().params; if (g.current) g.current.rotation.y += Math.min(0.05, dt) * (0.04 + (p.spin ?? 0.3) * 1.4) })
  return (
    <group ref={g}>
      <WaterVolume />
      <WaveSurface />
      <Jellies />
      <Fish />
      <Trash />
      <FlowingText />
      <Guests />
    </group>
  )
}

function GlassShell() {
  const mat = useMemo(() => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uColor: { value: new THREE.Color('#9fe0ff') }, uOpacity: { value: 0.6 } },
    vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv=modelViewMatrix*vec4(position,1.0); vN=normalize(normalMatrix*normal); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }',
    fragmentShader: 'varying vec3 vN; varying vec3 vV; uniform vec3 uColor; uniform float uOpacity; void main(){ float f=pow(1.0-max(dot(vN,vV),0.0),2.5); gl_FragColor=vec4(uColor, f*uOpacity); }',
  }), [])
  const drag = useRef(false), lastX = useRef(0)
  useEffect(() => {
    const mv = (e) => { if (!drag.current) return; const dx = e.clientX - lastX.current; lastX.current = e.clientX; const st = useStore.getState(); st.input('spin', st.params.spin + dx * 0.003) }
    const up = () => { drag.current = false }
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up) }
  }, [])
  useFrame(() => { mat.uniforms.uOpacity.value = 0.3 + env.glow * 0.55 })
  return (
    <mesh onPointerDown={(e) => { drag.current = true; lastX.current = (e.clientX ?? e.nativeEvent.clientX) }}>
      <sphereGeometry args={[SHELL, 48, 48]} />
      <primitive object={mat} attach="material" />
    </mesh>
  )
}

function FogDriver() {
  const { scene } = useThree()
  const fog = useMemo(() => new THREE.Fog('#05121f', 5, 12), [])
  useEffect(() => { scene.fog = fog; return () => { scene.fog = null } }, [scene, fog])
  useFrame(() => { const clar = effClarity(); fog.color.setHSL(0.57, 0.5, 0.04 + clar * 0.07); fog.near = 3.5 - (1 - clar) * 1.5; fog.far = 9 + clar * 6 })
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
    <Canvas camera={{ position: [0, 0.4, 7], fov: 45 }} dpr={[1, 2]} gl={{ preserveDrawingBuffer: true, antialias: true }}>
      <color attach="background" args={['#05101c']} />
      <EnvDriver />
      <FogDriver />
      <ambientLight intensity={0.6} />
      <Ocean />
      <GlassShell />
      <CameraRig />
    </Canvas>
  )
}
