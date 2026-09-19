const EVENT_URL = 'https://ixda.kktix.cc/events/ixda-member-2026'

export default function Footer({ onInfo, installEvt, onInstall }) {
  return (
    <footer className="footer">
      <span className="footer-main"><b>MidiSea</b> · IxDA Taiwan 2026 會員工作坊「AI 共生黑客鬆」</span>
      <span className="footer-sep">·</span>
      <span className="footer-team">12組 卡加布列島</span>
      <a href={EVENT_URL} target="_blank" rel="noopener noreferrer">活動 ↗</a>
      <button className="footer-help" onClick={onInfo}>操作說明</button>
      {installEvt && <button className="footer-install" onClick={onInstall} title="安裝成 App：離線可開、全螢幕演出">加入主畫面</button>}
    </footer>
  )
}
