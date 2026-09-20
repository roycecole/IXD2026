import { useT } from '../i18n/index.js'

const EVENT_URL = 'https://ixda.kktix.cc/events/ixda-member-2026'

export default function Footer({ onInfo, installEvt, onInstall }) {
  const t = useT()
  return (
    <footer className="footer">
      <span className="footer-main"><b>MidiSea</b> · {t('IxDA Taiwan 2026 會員工作坊「AI 共生黑客鬆」')}</span>
      <span className="footer-sep">·</span>
      <span className="footer-team">{t('{n}組 卡加布列島', { n: 12 })}</span>
      <a href={EVENT_URL} target="_blank" rel="noopener noreferrer">{t('活動 ↗')}</a>
      <button className="footer-help" onClick={onInfo}>{t('操作說明')}</button>
      {installEvt && <button className="footer-install" onClick={onInstall} title={t('安裝成 App：離線可開、全螢幕演出')}>{t('加入主畫面')}</button>}
    </footer>
  )
}
