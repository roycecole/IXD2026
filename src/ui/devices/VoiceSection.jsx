// 「裝置」面板的一節：語音指令（Web Speech API）。
// 這裡只管開關、說明與狀態顯示；辨識的生命週期在 lib/voice.js，接線（執行動作、畫布徽章與提示）在 services/VoiceService.jsx。
// 不支援 SpeechRecognition 的瀏覽器：開關停用並說明原因（不 return null，讓使用者知道為什麼沒有）。
import { useSyncExternalStore } from 'react'
import { useT } from '../../i18n/index.js'
import { getVoice, ERROR_TEXT } from '../../lib/voice.js'
import { COMMANDS } from '../../lib/voiceCommands.js'
import '../../styles/voice.css'

export default function VoiceSection() {
  const t = useT()
  const voice = getVoice()
  const st = useSyncExternalStore(voice.subscribe, voice.getState, voice.getState)
  const live = st.enabled && !st.suspended

  // 狀態訊息：錯誤優先；重試中（收音已開、但連線不穩）附註
  let msg = '', warn = false
  if (!st.supported) { msg = t(ERROR_TEXT.unsupported); warn = true }
  else if (st.error && ERROR_TEXT[st.error]) { msg = t(ERROR_TEXT[st.error]) + (st.enabled ? t('（重試中…）') : ''); warn = true }
  else if (live) msg = st.listening ? t('直接說出指令即可。') : t('正在啟動麥克風…（瀏覽器詢問時請按「允許」）')

  return (
    <section className="dev-sec voice-sec" aria-labelledby="voice-title">
      <h3 className="dev-sec-title" id="voice-title">{t('語音指令')}</h3>
      <p className="dev-sec-desc">{t('說出「鯨魚」「大浪」「安靜」等指令，免碰螢幕就能操作；適合展場、手髒或不方便觸控的時候。')}</p>
      <div className="dev-sec-body">
        <button type="button" className={'voice-toggle' + (st.enabled ? ' on' : '')} aria-pressed={st.enabled}
                disabled={!st.supported} onClick={() => (st.enabled ? voice.stop() : voice.start())}>
          {st.enabled ? t('停止收音') : t('開始收音')}
        </button>
        {live && (
          <span className="voice-badge-inline" role="status">
            <span className="voice-dot" aria-hidden="true" />
            {st.listening ? t('收音中') : t('準備收音…')}
          </span>
        )}
        <span className={'voice-msg' + (warn ? ' warn' : '')} role="status" aria-live="polite">{msg}</span>
        {live && st.lastText && <span className="voice-last">{t('最近聽到：{text}', { text: st.lastText })}</span>}

        <p className="dev-sec-hint voice-list-title">{t('可以這樣說（可連著說多個，例如「鯨魚 大浪」）')}</p>
        <ul className="voice-list" aria-label={t('可用的語音指令')}>
          {COMMANDS.map((c) => (
            <li key={c.id}>
              <span className="voice-say">{t(c.say)}</span>
              <span className="voice-arrow" aria-hidden="true">→</span>
              <span className="voice-fx">{t(c.fx)}</span>
            </li>
          ))}
        </ul>

        <p className="dev-sec-hint">{t('辨識語言：{tag}。跟著介面語言切換，一次只辨識一種語言；想說另一種語言請先切換介面語言。', { tag: st.lang })}</p>
        <p className="dev-sec-hint">{t('隱私：Chrome / Edge 的語音辨識會把麥克風的聲音送到雲端服務（Google / Microsoft）辨識；Safari 依系統設定處理。本站不錄音、不保存、不上傳任何音訊，只拿辨識出的文字來比對指令。')}</p>
        <p className="dev-sec-hint">{t('只有你按下「開始收音」才會啟用麥克風，收音時畫面右上角會一直顯示「收音中」。按停止、離開頁面或切到背景，都會立刻關閉麥克風。')}</p>
        <p className="dev-sec-hint">{t('這和工具列的「麥克風」（吹氣＝風）是各自獨立的功能，可以同時開啟；少數手機同時收音時其中一項會失靈，請擇一使用。')}</p>
      </div>
    </section>
  )
}
