// 常駐服務：VoiceService（由 App 透過 <Services/> 掛載一次）。
// 語音指令的「接線」：辨識結果 → 執行海洋動作、寫 IN 日誌、畫布下方短暫顯示「聽到：鯨魚」；
// 收音中在畫布右上角一直顯示「收音中」徽章（隱私：永遠顯示，不受 overlays.hud 控制；徽章上的 ✕ 可立即停止）。
// 「聽到：…」提示屬於資訊面板，跟著 overlays.hud 顯示 / 隱藏；錯誤提示（權限被拒、連不上服務）不受 hud 控制。
// 辨識本身（SpeechRecognition 生命週期）在 lib/voice.js，指令表與比對在 lib/voiceCommands.js；開關在「裝置」面板的 VoiceSection。
// 徽章與提示用 React portal 掛到 .canvas-wrap（不必改 App.jsx）。
// 生命週期：語系切換 → 辨識語言跟著換（重啟辨識器）；分頁進背景 → 先放掉麥克風、回前景再接續；元件卸載 → stop() 真正釋放。
import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store/useStore.js'
import { touch } from '../store/activity.js'
import { useT, useLocale, localeTag } from '../i18n/index.js'
import { getVoice, ERROR_TEXT } from '../lib/voice.js'
import { runCommand, heardText, logText } from '../lib/voiceCommands.js'
import { narrator } from '../lib/narration.js'
import { createEchoGuard } from '../lib/echoGuard.js'
import '../styles/voice.css'

const HEARD_MS = 2200        // 「聽到：…」顯示多久
const HEARD_JOIN_MS = 900    // 這段時間內連續辨識到的指令併成同一行（一句話說了多個指令）
const ERROR_MS = 7000
const nowMs = () => { try { return performance.now() } catch (e) { return Date.now() } }

export default function VoiceService() {
  const t = useT()
  const locale = useLocale()
  const voice = getVoice()
  const st = useSyncExternalStore(voice.subscribe, voice.getState, voice.getState)
  const hud = useStore((s) => s.overlays.hud)
  const [heard, setHeard] = useState([])       // 目前顯示的指令 id 們
  const [errCode, setErrCode] = useState(null)
  const [host, setHost] = useState(null)       // .canvas-wrap

  // 指令 → 動作 + 日誌 + 提示
  useEffect(() => {
    const h = { ids: [], at: -1e9, timer: 0 }
    const echo = createEchoGuard({ narrator })   // 資料導覽旁白開著時，字幕裡的「鯨魚」「魚群」會被麥克風收進去 → 旁白期間（含餘音）忽略辨識結果
    const off = voice.onCommand((f) => {
      if (echo.shouldIgnore()) return
      touch()   // 算一次人為操作（閒置吸引模式據此重新計時）
      useStore.getState().pushLog('in', logText(f.id))
      try { runCommand(f.id, useStore) } catch (e) { /* 動作出錯不影響辨識 */ }
      const n = nowMs()
      h.ids = n - h.at < HEARD_JOIN_MS ? [...h.ids, f.id].slice(-4) : [f.id]
      h.at = n
      setHeard(h.ids)
      clearTimeout(h.timer)
      h.timer = setTimeout(() => { h.ids = []; setHeard([]) }, HEARD_MS)
    })
    return () => { off(); echo.dispose(); clearTimeout(h.timer) }
  }, [voice])

  // 卸載時真正釋放麥克風
  useEffect(() => () => voice.stop(), [voice])

  // 辨識語言跟著介面語系（收音中會用新語言重啟）
  useEffect(() => { voice.setLang(localeTag(locale)) }, [voice, locale])

  // 分頁進背景 / 螢幕鎖定 → 放掉麥克風；回到前景再接續
  useEffect(() => {
    const onVis = () => { if (document.hidden) voice.suspend(); else voice.resume() }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [voice])

  // 找到畫布容器（App 先渲染 <main>，通常第一次就找得到；找不到就輪詢幾次）
  useEffect(() => {
    let tries = 0, id = 0
    const find = () => {
      const el = document.querySelector('.canvas-wrap')
      if (el) setHost(el)
      else if (tries++ < 20) id = setTimeout(find, 250)
    }
    find()
    return () => clearTimeout(id)
  }, [])

  // 已自動停用（權限被拒、連不上服務、連續失敗）→ 畫布上也提醒一下（使用者可能已關掉「裝置」面板）；重試中不打擾
  useEffect(() => {
    if (st.enabled || !st.error) { setErrCode(null); return undefined }
    setErrCode(st.error)
    const id = setTimeout(() => setErrCode(null), ERROR_MS)
    return () => clearTimeout(id)
  }, [st.enabled, st.error])

  if (!host) return null
  const badge = st.enabled && !st.suspended
  return createPortal(
    <>
      {badge && (
        <div className="voice-badge" role="status" aria-live="polite">
          <span className="voice-dot" aria-hidden="true" />
          <span>{st.listening ? t('收音中') : t('準備收音…')}</span>
          <button type="button" className="voice-badge-x" aria-label={t('停止收音')} title={t('停止收音')}
                  onPointerDown={(e) => e.stopPropagation()} onClick={() => voice.stop()}>✕</button>
        </div>
      )}
      {hud && heard.length > 0 && <div className="voice-heard" role="status" aria-live="polite">{heardText(heard)}</div>}
      {errCode && ERROR_TEXT[errCode] && <div className="voice-error" role="alert">{t(ERROR_TEXT[errCode])}</div>}
    </>,
    host,
  )
}
