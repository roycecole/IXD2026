// WebXR 桌面放置的 R3F 執行層。只在 XR 工作階段存在時，才由 Scene3D 動態載入並掛進 Canvas（一般使用者、不支援的裝置永遠不會下載這個 chunk）。
// 職責：把 session 接上 three 的 XR manager → 建 hit-test 來源 → 每幀更新準星 → 使用者點一下就放置 → 依控制器狀態擺放世界根 group
//       （縮放 / 位置 / 朝向）→ session 結束（使用者退出 / 系統中斷 / 錯誤）時把 2D 狀態全部還原（相機 / 世界 / 點大小 / 畫布尺寸與 DPR）。
// 與現有渲染管線的分工：
//   · R3F 8 本來就接了 gl.xr 的 sessionstart / sessionend（切換動畫迴圈、把 XRFrame 當第 3 個參數傳給 useFrame），所以不需要 @react-three/xr；
//   · 相機由 XR 控制（Scene3D 的 CameraRig 在 XR 時不動）；渲染由 BackdropFX 的 XR 分支做標準 XR 渲染（沒有後處理）；背景 / 霧由 FogDriver 在 XR 時關掉。
//   · 狀態（idle / requesting / placing / placed / ended）與放置數學在 lib/xr.js；畫面上的按鈕與滑桿在 ui/XrOverlay.jsx（DOM overlay）。
// 這裡沒有任何全域監聽：select 監聽掛在 session 上、sessionend 掛在 gl.xr 上，session 結束後都會自然消失。
import { Component, useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { getXrController, XR_PLACE, pickReferenceSpaceType, createHitTracker, isHorizontalHit } from '../lib/xr.js'

const attached = new WeakMap()   // session → setSession 的 promise：同一個 session 只接一次（React StrictMode 開發模式會把 effect 跑兩次）

// PointsMaterial 的 size 是「世界單位」，不會跟著父 group 的縮放縮小：世界根縮到桌面尺度後，粒子 / 氣泡 / 亮星要一起乘上縮放係數；還原時乘回 1。
function scalePoints(root, k) {
  root.traverse((o) => {
    if (o.isPoints && o.material && typeof o.material.size === 'number') {
      if (o.userData.xrBaseSize == null) o.userData.xrBaseSize = o.material.size
      o.material.size = o.userData.xrBaseSize * k
    }
  })
}

// 準星：貼地的環（半徑 = 球體半徑，即「球會坐在這個圈裡」）+ 內圈脈動 + 中心點。放置後留一圈淡淡的底環。
function makeReticle() {
  const g = new THREE.Group()
  g.matrixAutoUpdate = false
  g.visible = false
  const R = XR_PLACE.radiusM
  const mk = (geo, opacity) => {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: '#8fe0ff', transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, fog: false }))
    m.renderOrder = 10
    return m
  }
  const ring = mk(new THREE.RingGeometry(R - 0.008, R, 64).rotateX(-Math.PI / 2), 0.9)
  const inner = mk(new THREE.RingGeometry(R * 0.42, R * 0.42 + 0.004, 48).rotateX(-Math.PI / 2), 0.5)
  const dot = mk(new THREE.CircleGeometry(0.01, 20).rotateX(-Math.PI / 2), 0.9)
  g.add(ring, inner, dot)
  g.userData = { ring, inner, dot }
  return g
}

function XrRuntimeCore({ worldRef, shell }) {
  const { gl, camera, get } = useThree()
  const reticle = useMemo(makeReticle, [])
  const runRef = useRef(null)
  useEffect(() => () => { reticle.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose() }) }, [reticle])

  useEffect(() => {
    const ctrl = getXrController()
    const session = ctrl.getState().session
    if (!session) return undefined
    const xr = gl.xr
    const world = worldRef.current
    let disposed = false
    const run = { hitSource: null, tracker: createHitTracker(XR_PLACE.lostFrames), lastHit: new Float32Array(16), viewer: [0, 0, 0], step: null }
    runRef.current = run
    const fail = (code, e) => { try { ctrl.fail(code, e && e.message ? e.message : e) } catch (e2) { /* ignore */ } }

    // ---- 還原一般 2D 畫面（冪等）：世界根 / 準星 / 點大小 / 相機 / 畫布尺寸與 DPR。背景、霧、清除透明度由 FogDriver 在 XR 結束後自動接回，渲染由 BackdropFX 接回 ----
    const saved = { near: camera.near, far: camera.far, fov: camera.fov, zoom: camera.zoom, pos: camera.position.clone(), quat: camera.quaternion.clone() }
    const restore2D = () => {
      try {
        if (world) { world.visible = true; world.position.set(0, 0, 0); world.rotation.set(0, 0, 0); world.scale.set(1, 1, 1); scalePoints(world, 1) }
        reticle.visible = false
        camera.near = saved.near; camera.far = saved.far; camera.fov = saved.fov; camera.zoom = saved.zoom
        camera.position.copy(saved.pos); camera.quaternion.copy(saved.quat)
        const st = get()
        camera.aspect = st.size.width / Math.max(1, st.size.height)
        camera.updateProjectionMatrix()
        camera.updateMatrixWorld(true)
        camera.layers.enableAll()
        if (!xr.isPresenting) {   // three 結束 session 時已還原尺寸 / DPR；AR 期間 R3F 的尺寸或 DPR 若變過（畫質降級、視窗縮放）在這裡對齊
          gl.setPixelRatio(st.viewport.dpr)
          gl.setSize(st.size.width, st.size.height, true)
        }
      } catch (e) { console.warn('[xr] 還原一般畫面時出錯', e) }
    }
    const onXrEnd = () => { xr.removeEventListener('sessionend', onXrEnd); restore2D() }   // 一次性；即使元件先卸載，session 真正結束時仍會補做一次還原

    // ---- 依控制器狀態擺放世界根 / 準星 ----
    const ui = reticle.userData
    const apply = (s) => {
      if (s.status === 'ended' || s.status === 'idle') return   // 退場時的還原由 restore2D 負責
      try {
        const pl = s.placement
        if (s.status === 'placed' && pl) {
          if (world) {
            world.position.fromArray(pl.position); world.rotation.set(0, pl.yaw, 0); world.scale.setScalar(pl.scale)
            scalePoints(world, pl.scale)
            world.visible = !!s.tracking          // 追蹤遺失時世界會黏在畫面上，先藏起來，找回來再出現
          }
          reticle.matrix.fromArray(pl.hit); reticle.matrixWorldNeedsUpdate = true
          reticle.visible = !!s.tracking
          ui.ring.material.opacity = 0.4; ui.inner.visible = false; ui.dot.visible = false   // 放置後只留一圈淡淡的底環
        } else {
          if (world) world.visible = false        // requesting / placing：世界先不出現，只顯示準星
          if (s.status !== 'placing') reticle.visible = false
          ui.ring.material.opacity = 0.9; ui.inner.visible = true; ui.dot.visible = true
        }
      } catch (e) { fail('apply', e) }
    }

    // ---- 每幀（只在 XR 中有 frame）：追蹤狀態、放置階段的 hit-test 與準星 ----
    run.step = (frame, t) => {
      const ref = xr.getReferenceSpace()
      if (!ref) return
      const vp = frame.getViewerPose(ref)
      const tracked = !!vp
      if (vp) { const p = vp.transform.position; run.viewer[0] = p.x; run.viewer[1] = p.y; run.viewer[2] = p.z }
      let s = ctrl.getState()
      if (s.status === 'requesting') return
      if (s.tracking !== tracked) { ctrl.setTracking(tracked); s = ctrl.getState() }
      if (s.status !== 'placing') return
      let ok = false
      if (tracked && run.hitSource) {
        const res = frame.getHitTestResults(run.hitSource)
        if (res.length) {
          const pose = res[0].getPose(ref)
          if (pose) {
            const m = pose.transform.matrix
            if (isHorizontalHit(m)) { run.lastHit.set(m); reticle.matrix.fromArray(m); reticle.matrixWorldNeedsUpdate = true; ok = true }
          }
        }
      }
      const r = run.tracker.update(ok)
      if (r.changed) ctrl.setHit(r.found)
      reticle.visible = r.found && tracked
      ui.inner.material.opacity = 0.35 + 0.25 * Math.sin(t * 4)
    }

    // 使用者點一下（螢幕上的 DOM overlay 控制項已用 beforexrselect 擋掉，不會誤觸）：放在目前準星的位置
    const onSelect = () => {
      try {
        if (ctrl.getState().status !== 'placing' || !run.tracker.found) return
        ctrl.place(run.lastHit, run.viewer, shell)
      } catch (e) { fail('place', e) }
    }

    const attach = () => {
      let p = attached.get(session)
      if (!p) { p = Promise.resolve().then(() => xr.setSession(session)); attached.set(session, p) }
      return p
    }
    const boot = async () => {
      try { await attach() } catch (e) { fail('render', e); return }
      if (disposed) return
      try {
        const space = await session.requestReferenceSpace('viewer')
        if (disposed) return
        const src = await session.requestHitTestSource({ space })
        if (disposed) { try { src.cancel() } catch (e) { /* ignore */ } return }
        run.hitSource = src
      } catch (e) { fail('hit-test', e); return }
      if (!disposed) ctrl.ready()
    }

    let unsub = null
    try {
      xr.addEventListener('sessionend', onXrEnd)
      session.addEventListener('select', onSelect)
      unsub = ctrl.subscribe(apply)
      apply(ctrl.getState())
      camera.near = XR_PLACE.near; camera.far = XR_PLACE.far; camera.updateProjectionMatrix()   // 桌面尺度：手機貼近球時不能被 near 切掉
      xr.setReferenceSpaceType(pickReferenceSpaceType(session))
      boot()
    } catch (e) {
      disposed = true
      if (unsub) unsub()
      xr.removeEventListener('sessionend', onXrEnd)
      restore2D()
      fail('runtime', e)
      return undefined
    }

    return () => {
      disposed = true
      if (unsub) unsub()
      try { session.removeEventListener('select', onSelect) } catch (e) { /* ignore */ }
      if (run.hitSource) { try { run.hitSource.cancel() } catch (e) { /* ignore */ } run.hitSource = null }
      run.step = null
      if (runRef.current === run) runRef.current = null
      if (xr.isPresenting) ctrl.exit()                      // Canvas 在 session 還活著時被卸載 → 結束 session；sessionend 監聽保留，結束後補做完整還原
      else xr.removeEventListener('sessionend', onXrEnd)
      restore2D()
    }
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((state, dt, frame) => {
    const run = runRef.current
    if (!frame || !run || !run.step) return                 // 非 XR 幀（沒有 XRFrame）什麼都不做
    try { run.step(frame, state.clock.elapsedTime) } catch (e) {
      run.step = null
      try { getXrController().fail('frame', e && e.message) } catch (e2) { /* ignore */ }
    }
  })

  return <primitive object={reticle} />
}

// 執行層出任何 render 錯誤 → 退場回一般畫面；不能讓 Canvas 的錯誤邊界把整個 App 帶垮
class Guard extends Component {
  constructor(props) { super(props); this.state = { bad: false } }
  static getDerivedStateFromError() { return { bad: true } }
  componentDidCatch(e) { try { getXrController().fail('runtime', e && e.message) } catch (e2) { /* ignore */ } }
  render() { return this.state.bad ? null : this.props.children }
}

export default function XrRuntime(props) {
  return <Guard><XrRuntimeCore {...props} /></Guard>
}
