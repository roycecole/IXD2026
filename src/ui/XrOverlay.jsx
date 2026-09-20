// WebXR 桌面放置的 DOM 介面（整個檔案由 XrSection 動態載入，不支援的裝置不會下載）：
//   · XrPanel（具名匯出）  「裝置」面板那一節的內容：說明、「在桌面上放置」按鈕、結束後的說明；同時用 portal 提供 DOM overlay 的根元素。
//   · XrOverlay（預設匯出） immersive 模式的 DOM overlay：提示（找平面 / 點一下放置）、退出、放置後的海況滑桿與鯨豚龜按鈕、重新放置。
// 狀態機在 lib/xr.js（getXrController），3D 側在 scene/XrRuntime.jsx。這裡只讀狀態、呼叫 start / exit / replace，並把海況控制走 store.input（與其他輸入相同的入口）。
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useT, T } from '../i18n/index.js'
import { useStore } from '../store/useStore.js'
import { arState } from '../lib/ar.js'
import { getXrController, overlayHint, endNotice, isActiveStatus } from '../lib/xr.js'
import '../styles/xr.css'

// 靜態表：用 T() 標記，顯示時才 t()（切語系會跟著換）
const HINT = {
  starting: T('AR 啟動中…'),
  find: T('移動手機，找一個平面'),
  tap: T('對準桌面或地板，點一下把海放在這裡'),
}
const SLIDERS = [
  { id: 'seaLevel', label: T('海水高度') },
  { id: 'current', label: T('洋流速度') },
  { id: 'clarity', label: T('海水清澈') },
]
const CREATURES = [
  { act: 'spawnWhale', label: T('鯨魚') },
  { act: 'spawnDolphin', label: T('海豚') },
  { act: 'spawnTurtle', label: T('海龜') },
]
const NOTE = {
  exited: T('已退出 AR，回到一般畫面。'),
  interrupted: T('AR 被系統中斷，已回到一般畫面。'),
  permission: T('沒有取得相機權限。請在瀏覽器的提示中允許相機，或到網站設定開啟後再試一次。'),
  unsupported: T('這台裝置不支援桌面偵測（hit-test），無法使用 AR 桌面。'),
  insecure: T('AR 需要安全連線（HTTPS）。'),
  busy: T('AR 正在使用中，請先結束其他 AR 或相機使用，再試一次。'),
  render: T('無法把畫面接到 AR（繪圖初始化失敗），已回到一般畫面。'),
  'hit-test': T('無法啟動桌面偵測，已回到一般畫面。'),
  timeout: T('AR 啟動逾時，已回到一般畫面。請再試一次。'),
  unknown: T('AR 發生錯誤，已回到一般畫面。'),
}

// 在 DOM overlay 的控制項上操作時，不能同時被當成 XR 的 select（＝「點一下放置」）：beforexrselect 事件 preventDefault。
// 只掛在真正的控制項上；空白處的點擊仍然要能放置。
function NoSelect({ as: Tag = 'div', ...props }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const stop = (e) => { e.preventDefault() }
    el.addEventListener('beforexrselect', stop)
    return () => el.removeEventListener('beforexrselect', stop)
  }, [])
  return <Tag ref={ref} {...props} />
}

function Slider({ id, label }) {
  const t = useT()
  const v = useStore((s) => s.params[id] ?? 0.5)
  return (
    <label className="xr-slider">
      <span>{t(label)}</span>
      <input type="range" min="0" max="1" step="0.01" value={v} onChange={(e) => useStore.getState().input(id, parseFloat(e.target.value))} />
    </label>
  )
}

// immersive 模式的 DOM overlay 內容（session 存在時才會被掛上）
export default function XrOverlay() {
  const t = useT()
  const ctrl = getXrController()
  const st = useSyncExternalStore(ctrl.subscribe, ctrl.getState, ctrl.getState)
  const hint = overlayHint(st)
  return (
    <div className="xr-ui" role="region" aria-label={t('AR 桌面放置')}>
      <div className="xr-top">
        <div className={'xr-hint' + (hint === 'find' ? ' warn' : '')} role="status" aria-live="polite">{hint ? t(HINT[hint]) : ''}</div>
        <NoSelect as="button" type="button" className="xr-btn xr-exit" onClick={() => ctrl.exit()}>{t('退出 AR')}</NoSelect>
      </div>
      {st.status === 'placed' && (
        <NoSelect className="xr-panel" role="group" aria-label={t('海況控制')}>
          <p className="xr-cap">{t('繞著球走一圈看看；下面的滑桿與按鈕可以調整海況。')}</p>
          {SLIDERS.map((s) => <Slider key={s.id} id={s.id} label={s.label} />)}
          <div className="xr-row">
            {CREATURES.map((c) => <button key={c.act} type="button" className="xr-btn" onClick={() => { const fn = useStore.getState()[c.act]; if (fn) fn() }}>{t(c.label)}</button>)}
          </div>
          <button type="button" className="xr-btn xr-again" onClick={() => ctrl.replace()}>{t('重新放置')}</button>
        </NoSelect>
      )}
    </div>
  )
}

// 「裝置」面板的一節內容（XrSection 確認支援後才載入這個檔案並渲染它）
export function XrPanel() {
  const t = useT()
  const ctrl = getXrController()
  const st = useSyncExternalStore(ctrl.subscribe, ctrl.getState, ctrl.getState)
  const rootRef = useRef(null)
  useEffect(() => { import('../scene/XrRuntime.jsx').catch(() => { /* 預載失敗沒關係：真正要進 AR 時會再載一次，仍失敗才退場 */ }) }, [])   // 預載執行層：按鈕一按就能立刻掛上
  useEffect(() => () => { ctrl.dismiss() }, [ctrl])                                                                                            // 關掉面板 → 清掉上次結束的說明

  const active = isActiveStatus(st.status)
  const arBusy = !!arState.on                                          // 「實景」開著時相機被占用：先關掉它
  const notice = endNotice(st)
  const noteKey = notice ? (NOTE[notice.code] ? notice.code : 'unknown') : null
  const isErr = !!notice && notice.code !== 'exited'
  const start = () => { if (active || arState.on) return; ctrl.start({ root: rootRef.current }) }   // 必須在點擊手勢內同步呼叫（requestSession 需要使用者手勢）

  return (
    <>
      <section className="dev-sec xr-sec" aria-labelledby="xr-title">
        <h3 className="dev-sec-title" id="xr-title">{t('AR 桌面')}</h3>
        <p className="dev-sec-desc">{t('用手機的 AR 把這顆海放在真實的桌面上：走動時球固定在原處，繞著走可以看到各個角度。需要 Android Chrome 等支援 WebXR 的裝置；相機只在你按下按鈕後才啟用，畫面不會上傳。')}</p>
        <div className="dev-sec-body">
          <button type="button" className={'xr-start' + (active ? ' on' : '')} onClick={start} disabled={active || arBusy}>
            {st.status === 'requesting' ? t('啟動中…') : t('在桌面上放置')}
          </button>
          {arBusy && <p className="dev-sec-hint warn">{t('請先關閉工具列的「實景」：兩者都要用相機，不能同時開。')}</p>}
          {notice && (
            <p className={'dev-sec-hint' + (isErr ? ' warn' : '')} role="status">
              {noteKey === 'unknown' && notice.detail ? t('AR 發生錯誤，已回到一般畫面：{detail}', { detail: notice.detail }) : t(NOTE[noteKey])}
            </p>
          )}
        </div>
      </section>
      {createPortal(
        <div ref={rootRef} className={'xr-overlay' + (st.session ? ' is-live' : '')}>{st.session ? <XrOverlay /> : null}</div>,
        document.body,
      )}
    </>
  )
}
