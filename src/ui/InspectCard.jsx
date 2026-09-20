import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useStore } from '../store/useStore.js'
import { useT } from '../i18n/index.js'
import { inspectStore, describeInspect, placeCard } from '../lib/inspect.js'
import { registerMirror } from '../lib/mirror.js'
import '../styles/inspect.css'

// 點物件看資料出處：點背景上的測站星 / 月亮 / 鳥群 → 貼近該物件的小卡片（選取在 scene/Scene3D.jsx 的 InspectPicker，內容組裝在 lib/inspect.js）。
// 屬「畫布上的資訊面板」：受 overlays.hud 控制（關閉時不顯示；選取器也不會開卡，點擊照常）。
// 鏡像到觀眾視窗：狀態是純 JSON（資料 + 0..1 的相對位置），觀眾視窗 apply 只設定狀態；那邊要顯示就在 AudienceApp 渲染 <InspectCard />。
registerMirror('inspect', {
  get: () => inspectStore.get(),
  apply: (v) => inspectStore.applyMirror(v),
  subscribe: (cb) => inspectStore.subscribe(cb),
})

export default function InspectCard() {
  const t = useT()   // 訂閱語系：describeInspect 讀「當下語系」，切換時要重繪
  const hud = useStore((s) => s.overlays.hud)
  const st = useSyncExternalStore(inspectStore.subscribe, inspectStore.get, inspectStore.get)
  const ref = useRef(null)
  const [place, setPlace] = useState(null)
  const view = hud && st.open && st.data ? describeInspect(st.data) : null
  const visible = !!view

  // 量測後貼近物件（邊界夾住；窄畫面改停靠下緣）。語系切換 / 視窗縮放會改變卡片尺寸 → 重排
  useLayoutEffect(() => {
    if (!visible) { setPlace(null); return undefined }
    const el = ref.current
    const host = el && (el.offsetParent || el.parentElement)
    if (!host) return undefined
    const measure = () => {
      const hr = host.getBoundingClientRect()
      const wasDock = el.classList.contains('dock')
      if (wasDock) el.classList.remove('dock')            // 以「非停靠」的自然寬度量尺寸
      const cw = el.offsetWidth, ch = el.offsetHeight
      if (wasDock) el.classList.add('dock')
      const x = st.x * hr.width, y = st.y * hr.height
      setPlace({ ...placeCard({ x, y, cw, ch, w: hr.width, h: hr.height }), px: x, py: y })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [visible, st.seq, st.x, st.y, t])

  // Esc 關閉；點卡片與畫布以外的地方關閉（畫布上的輕點由選取器判斷：點空白會關、點到別的物件會換卡，拖曳不受影響）
  useEffect(() => {
    if (!visible) return undefined
    const onKey = (e) => { if (e.key === 'Escape') inspectStore.close() }
    const onDown = (e) => {
      const el = ref.current
      const tg = e.target
      if (el && tg && el.contains(tg)) return
      if (tg && tg.closest && tg.closest('.canvas-wrap')) return
      inspectStore.close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown, true)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', onDown, true) }
  }, [visible])

  if (!view) return null
  const stop = (e) => e.stopPropagation()   // 卡片上的雙擊 / 滾輪不要傳給畫布（會切演出模式 / 縮放）
  return (
    <>
      {place && <span className="inspect-pin" aria-hidden="true" style={{ left: place.px, top: place.py }} />}
      <div ref={ref} className={'inspect-card ic-' + view.kind + (place && place.dock ? ' dock' : '')}
           role="dialog" aria-modal="false" aria-label={view.title}
           style={!place ? { visibility: 'hidden' } : place.dock ? undefined : { left: place.left, top: place.top }}
           onPointerDown={() => inspectStore.touch()} onPointerEnter={() => inspectStore.hold(true)} onPointerLeave={() => inspectStore.hold(false)}
           onDoubleClick={stop} onWheel={stop}>
        <div className="ic-head">
          <span className="ic-eyebrow">{view.eyebrow}</span>
          <button type="button" className="ic-x" onClick={() => inspectStore.close()} aria-label={t('關閉')} title={t('關閉')}>×</button>
        </div>
        <div className="ic-title">{view.title}</div>
        {view.rows.length > 0 && (
          <dl className="ic-rows">
            {view.rows.map((r, i) => <div className="ic-row" key={i}><dt>{r.k}</dt><dd>{r.v}</dd></div>)}
          </dl>
        )}
        {view.note && <p className="ic-note">{view.note}</p>}
        {view.source && <p className="ic-src">{view.source}</p>}
      </div>
    </>
  )
}
