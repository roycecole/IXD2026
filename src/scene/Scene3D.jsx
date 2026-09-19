import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useRef, useMemo, useEffect } from 'react'
import * as THREE from 'three'
import { useStore } from '../store/useStore.js'

// 效能關鍵：場景一律用 useStore.getState() 在 useFrame 內讀參數，
// 不透過 React 訂閱，避免每則 MIDI 訊息觸發 re-render。

// 球面上的資料點（fibonacci sphere 均勻分佈）。之後可換成氣象站經緯度。
function DataPoints({ count = 900 }) {
  const ref = useRef()
  const positions = useMemo(() => {
    const arr = new Float32Array(count * 3)
    const R = 2.03
    for (let i = 0; i < count; i++) {
      const y = 1 - (i / (count - 1)) * 2
      const r = Math.sqrt(Math.max(0, 1 - y * y))
      const phi = i * Math.PI * (3 - Math.sqrt(5))
      arr[i * 3] = Math.cos(phi) * r * R
      arr[i * 3 + 1] = y * R
      arr[i * 3 + 2] = Math.sin(phi) * r * R
    }
    return arr
  }, [count])

  useFrame(() => {
    const p = useStore.getState().params
    const o = ref.current
    if (!o) return
    o.geometry.setDrawRange(0, Math.floor(count * (0.1 + p.pointDensity * 0.9)))
    o.material.opacity = 0.25 + p.pointGlow * 0.75
    o.material.size = 0.02 + p.pointGlow * 0.05
    o.material.color.setHSL(0.5 - p.heat * 0.45, 0.85, 0.6) // teal → amber by heat
  })

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial color="#5dcaa5" size={0.04} sizeAttenuation transparent depthWrite={false} />
    </points>
  )
}

// 自轉球體 + 經緯線框 + 大氣層。滑鼠拖曳球體 → 改變自轉速度（寫回 spin 參數）。
function Globe() {
  const grp = useRef()
  const atmo = useRef()
  const dragging = useRef(false)
  const lastX = useRef(0)

  useEffect(() => {
    const onMove = (e) => {
      if (!dragging.current) return
      const dx = e.clientX - lastX.current
      lastX.current = e.clientX
      const st = useStore.getState()
      st.input('spin', st.params.spin + dx * 0.003) // 拖曳改變自轉速度（可被錄製）
    }
    const onUp = () => { dragging.current = false }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  useFrame((_, dt) => {
    const p = useStore.getState().params
    if (grp.current) {
      grp.current.rotation.y += Math.min(0.05, dt) * (0.05 + p.spin * 1.5)
      grp.current.rotation.z = (p.tilt - 0.5) * 0.6
      const target = 0.55 + p.globeScale * 1.15 // 球體大小
      const cur = grp.current.scale.x
      grp.current.scale.setScalar(cur + (target - cur) * 0.12)
    }
    if (atmo.current) {
      atmo.current.material.opacity = 0.05 + p.atmosphere * 0.35
      const s = 2.14 + p.atmosphere * 0.14
      atmo.current.scale.set(s, s, s)
    }
  })

  return (
    <group ref={grp}>
      <mesh onPointerDown={(e) => { dragging.current = true; lastX.current = (e.clientX ?? e.nativeEvent.clientX) }}>
        <sphereGeometry args={[2, 64, 64]} />
        <meshStandardMaterial color="#12305a" emissive="#0a1e42" emissiveIntensity={0.45} roughness={0.85} metalness={0.1} />
      </mesh>
      <mesh scale={[2.006, 2.006, 2.006]}>
        <sphereGeometry args={[1, 32, 20]} />
        <meshBasicMaterial color="#3a7fa8" wireframe transparent opacity={0.22} />
      </mesh>
      <DataPoints />
      <mesh ref={atmo} scale={[2.14, 2.14, 2.14]}>
        <sphereGeometry args={[1, 32, 32]} />
        <meshBasicMaterial color="#4aa3ff" transparent opacity={0.15} side={THREE.BackSide} depthWrite={false} />
      </mesh>
    </group>
  )
}

function Stars({ count = 700 }) {
  const ref = useRef()
  const positions = useMemo(() => {
    const a = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const r = 34 + Math.random() * 22
      const th = Math.random() * Math.PI * 2
      const ph = Math.acos(2 * Math.random() - 1)
      a[i * 3] = r * Math.sin(ph) * Math.cos(th)
      a[i * 3 + 1] = r * Math.cos(ph)
      a[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th)
    }
    return a
  }, [count])
  useFrame(() => {
    const p = useStore.getState().params
    if (ref.current) ref.current.material.opacity = 0.15 + p.stars * 0.85
  })
  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial color="#ffffff" size={0.14} sizeAttenuation transparent depthWrite={false} />
    </points>
  )
}

function Lights() {
  const dir = useRef()
  const amb = useRef()
  useFrame(() => {
    const p = useStore.getState().params
    if (dir.current) dir.current.intensity = 0.3 + p.worldLight * 1.9 // 背景亮度
    if (amb.current) amb.current.intensity = 0.08 + p.worldLight * 0.6
  })
  return (
    <>
      <ambientLight ref={amb} intensity={0.25} />
      <directionalLight ref={dir} position={[5, 3, 5]} intensity={1.2} />
    </>
  )
}

function CameraRig() {
  const { camera } = useThree()
  const tmp = useMemo(() => new THREE.Vector3(), [])
  useFrame(() => {
    const p = useStore.getState().params
    const dist = 5.5 + (1 - p.zoom) * 6
    const y = (p.camHeight - 0.5) * 9
    tmp.set(0, y, dist)
    camera.position.lerp(tmp, 0.06)
    camera.lookAt(0, 0, 0)
  })
  return null
}

export default function Scene3D() {
  return (
    <Canvas camera={{ position: [0, 0, 8], fov: 45 }} dpr={[1, 2]}>
      <color attach="background" args={['#05060c']} />
      <fog attach="fog" args={['#05060c', 30, 72]} />
      <Lights />
      <Stars />
      <Globe />
      <CameraRig />
    </Canvas>
  )
}
