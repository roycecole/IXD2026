import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { useStore } from './store/useStore.js'
import DataBoard from './ui/DataBoard.jsx'
import DataHUD from './ui/DataHUD.jsx'
import TourCaption from './ui/TourCaption.jsx'      // 資料導覽字幕（載入它就會註冊 'tour' 鏡像切片）
import InspectCard from './ui/InspectCard.jsx'      // 點物件看資料出處的卡片（載入它就會註冊 'inspect' 鏡像切片）
import { loadOceanData } from './lib/govdata.js'
import { getMirror } from './lib/mirror.js'
import { useT } from './i18n/index.js'
import { AUDIENCE_CHANNEL, createAudience, pickGovOptionId } from './lib/audience.js'
import { registerCoreMirrors } from './services/AudienceService.jsx'
import { keepAwake } from './lib/wakeLock.js'
import { useQualityStore } from './lib/qualityStore.js'
import { startQualityRuntime } from './lib/qualityRuntime.js'
import './styles/audience.css'

const Scene3D = lazy(() => import('./scene/Scene3D.jsx'))   // 與主視窗同一個場景元件

// 觀眾視窗（?audience=1）：全螢幕顯示同一片海 + 資料看板 / 資料 HUD。
// 只「顯示」不「驅動」：沒有控制 UI、沒有聲音、不跑吸引模式 / 導覽 / Services / AR，也不跑 tickPlayback（只跑自己的自動畫質與螢幕喚醒）——
// 參數、資料播放進度、觸發事件全部由主視窗經 BroadcastChannel 推過來（見 lib/audience.js）。
export default function AudienceApp() {
  const t = useT()
  const overlays = useStore((s) => s.overlays)
  const [status, setStatus] = useState({ state: 'waiting', synced: false })
  const [unsupported, setUnsupported] = useState(false)
  const [slow, setSlow] = useState(false)             // 等主視窗超過 8 秒 → 多給一行說明
  const [fs, setFs] = useState(() => { try { return !!document.fullscreenElement } catch (e) { return false } })
  const [clicked, setClicked] = useState(false)       // 「點一下進入全螢幕」提示只出現一次：點過（不論成功與否）就不再提示
  const [closeBlocked, setCloseBlocked] = useState(false)
  const rootRef = useRef(null)

  // 連線：hello → 收快照 → 收增量；主視窗重整 / 斷線會自動重新 hello（見 createAudience）
  useEffect(() => {
    registerCoreMirrors()
    if (typeof BroadcastChannel === 'undefined') { setUnsupported(true); return undefined }
    let ch
    try { ch = new BroadcastChannel(AUDIENCE_CHANNEL) } catch (e) { setUnsupported(true); return undefined }
    const client = createAudience({
      channel: ch,
      apply: (key, value, meta) => { const s = getMirror(key); if (s) s.apply(value, meta) },   // 任意切片：註冊表裡有才套用，沒有的略過
      onStatus: (s) => setStatus(s),
      onClose: () => { try { window.close() } catch (e) { /* ignore */ } setCloseBlocked(true) },   // 主視窗要求關閉；不是腳本開的視窗會關不掉 → 顯示提示
    })
    client.start()
    const bye = () => client.stop()
    window.addEventListener('pagehide', bye)
    return () => { window.removeEventListener('pagehide', bye); client.stop() }
  }, [])

  // 觀眾視窗自己載入 ocean.json（資料本身不走 channel），但不 applyGov：參數由主視窗的 params 切片決定
  useEffect(() => {
    let dead = false
    loadOceanData().then((d) => {
      if (dead || !d) return
      useStore.setState({ gov: d, govOptionId: pickGovOptionId(d, useStore.getState().govOptionId) })   // 主視窗已送來的選項 id 優先
    })
    return () => { dead = true }
  }, [])

  useEffect(() => { document.title = t('MidiSea 觀眾視窗') }, [t])

  // 螢幕保持喚醒：投影機上的這個視窗永遠是「看得見」的那個，它自己持有 wake lock（主視窗可能被縮小 / 蓋住，鎖會跟著放掉；
  // 導覽期間沒有任何鍵盤滑鼠輸入，OS 的顯示器休眠計時器照跑 → 投影機會黑屏）。系統層級：也一併擋住筆電螢幕的休眠。
  useEffect(() => keepAwake(), [])

  // 自動畫質：觀眾視窗是像素負擔最大的畫面（投影機常是 4K / 高 DPR），要用「自己」的 FPS 判斷。
  // 這個視窗的 store 不寫偏好（見 qualityStore 的 audience 判斷），才不會和主視窗搶同一份 localStorage。
  // 主視窗的畫質「模式」經 'quality' 鏡像切片送過來（qualityStore.js）：操作員手動選一級 → 這個視窗鎖定同一級；選自動 → 用自己的 FPS。網址帶 ?quality= 也可鎖定。
  useEffect(() => {
    const rt = startQualityRuntime({ store: useQualityStore, appStore: useStore })
    return () => rt.stop()
  }, [])

  useEffect(() => {
    if (status.state === 'live') { setSlow(false); return undefined }
    const id = setTimeout(() => setSlow(true), 8000)
    return () => clearTimeout(id)
  }, [status.state])

  // 游標：滑鼠不動 2 秒自動隱藏（直接切 class，不觸發 React 重繪）
  useEffect(() => {
    let timer = 0
    const el = rootRef.current
    const show = () => {
      if (el) el.classList.add('show-cursor')
      clearTimeout(timer)
      timer = setTimeout(() => { if (el) el.classList.remove('show-cursor') }, 2200)
    }
    show()
    window.addEventListener('pointermove', show)
    return () => { window.removeEventListener('pointermove', show); clearTimeout(timer) }
  }, [])

  useEffect(() => {
    const on = () => setFs(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])

  const goFullscreen = () => {   // 需要使用者手勢：點一下畫面
    setClicked(true)
    try {
      const el = document.documentElement
      if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen().catch(() => {})
    } catch (e) { /* ignore */ }
  }

  const live = status.state === 'live'
  return (
    <div ref={rootRef} className="audience-app" onClick={goFullscreen} onContextMenu={(e) => e.preventDefault()} role="application" aria-label={t('觀眾視窗')}>
      <div className="aud-scene" aria-hidden="true">
        <Suspense fallback={<div className="canvas-loading">{t('載入海洋…')}</div>}><Scene3D /></Suspense>
      </div>
      {overlays.hud && <DataHUD />}
      <DataBoard />
      <TourCaption />
      <InspectCard />
      {unsupported ? (
        <div className="aud-status warn" role="status">{t('這個瀏覽器不支援視窗同步（BroadcastChannel），無法顯示主視窗的畫面')}</div>
      ) : !live && (
        <div className="aud-status" role="status">
          <span className="aud-dot" />{t('等待主視窗…')}
          {slow && <small>{t('請確認主視窗已開啟，且兩個視窗使用同一個網址')}</small>}
        </div>
      )}
      {closeBlocked && <div className="aud-status warn aud-close" role="status">{t('主視窗要求關閉此視窗，但瀏覽器不允許——請直接關掉它')}</div>}
      {!fs && !clicked && <div className="aud-fs-hint">{t('點一下進入全螢幕')}</div>}
    </div>
  )
}
