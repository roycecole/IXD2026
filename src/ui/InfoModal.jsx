import { useT, useLocale } from '../i18n/index.js'
import InfoZh from './info/InfoZh.jsx'
import InfoEn from './info/InfoEn.jsx'

const EVENT_URL = 'https://ixda.kktix.cc/events/ixda-member-2026'

// 說明視窗外殼（標題、關閉、隊伍資訊、開始探索）；正文依語系渲染 InfoZh / InfoEn（含行內標記，不逐句 t()）。
export default function InfoModal({ onClose }) {
  const t = useT()
  const locale = useLocale()
  const Body = locale === 'en' ? InfoEn : InfoZh
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{t('MidiSea 資料導演台')}</h2>
          <button onClick={onClose} aria-label={t('關閉')}>✕</button>
        </div>

        <Body />

        <div className="modal-about">
          <div>{t('本作品為')} <b>{t('IxDA Taiwan 2026 會員工作坊「AI 共生黑客鬆」')}</b></div>
          <div>{t('隊伍：')}<b>{t('12組 卡加布列島')}</b></div>
          <a href={EVENT_URL} target="_blank" rel="noopener noreferrer">{t('前往活動頁面 ↗')}</a>
        </div>

        <button className="modal-start" onClick={onClose}>{t('開始探索')}</button>
      </div>
    </div>
  )
}
