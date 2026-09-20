import { useEffect, useRef } from 'react'
import { useT } from '../i18n/index.js'
import { attachModalFocus } from '../lib/modalFocus.js'
import AudienceSection from './devices/AudienceSection.jsx'
import GestureSection from './devices/GestureSection.jsx'
import VoiceSection from './devices/VoiceSection.jsx'
import HapticsSection from './devices/HapticsSection.jsx'
import QualitySection from './devices/QualitySection.jsx'
import ViewSection from './devices/ViewSection.jsx'
import XrSection from './devices/XrSection.jsx'
import DiagnosticsSection from './devices/DiagnosticsSection.jsx'
import OpsSection from './devices/OpsSection.jsx'

// 「裝置」面板：把各種裝置 / 感測器功能集中一處（觀眾視窗、相機手勢、語音、觸覺、畫質、AR 桌面）。
// 每一節是 ui/devices/*Section.jsx（各自負責自己的開關、狀態與說明）；背後常駐的邏輯在 services/*Service.jsx。
// 不支援的功能節自己 return null（例如沒有 WebXR 的裝置不顯示 AR 桌面）。
// 鍵盤 / 螢幕閱讀器：宣告了 aria-modal 就要真的做到——開啟時焦點移進來、Esc 關閉、Tab 在彈窗內循環、關閉後焦點回到「裝置」鈕（見 lib/modalFocus.js）。
export default function DevicesModal({ onClose }) {
  const t = useT()
  const ref = useRef(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => attachModalFocus({ container: ref.current, onClose: () => closeRef.current && closeRef.current(), fallbackSelector: '[data-k="devices"]' }), [])
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div ref={ref} tabIndex={-1} className="modal devices-modal" role="dialog" aria-modal="true" aria-label={t('裝置')} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{t('裝置')}</h2>
          <button onClick={onClose} aria-label={t('關閉')}>✕</button>
        </div>
        <p className="modal-lead dev-lead">{t('這些功能都是選用的：相機 / 麥克風只在你打開時才啟用，畫面不會上傳。')}</p>
        <AudienceSection />
        <GestureSection />
        <VoiceSection />
        <HapticsSection />
        <QualitySection />
        <ViewSection />
        <XrSection />
        <DiagnosticsSection />
        <OpsSection />
        <button className="modal-start" onClick={onClose}>{t('完成')}</button>
      </div>
    </div>
  )
}
