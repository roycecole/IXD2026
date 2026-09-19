const EVENT_URL = 'https://ixda.kktix.cc/events/ixda-member-2026'

export default function Footer({ onInfo }) {
  return (
    <footer className="footer">
      <span className="footer-main"><b>MidiSea</b> · IxDA Taiwan 2026 會員工作坊「AI 共生黑客鬆」</span>
      <span className="footer-sep">·</span>
      <span className="footer-team">12組 卡加布列島</span>
      <a href={EVENT_URL} target="_blank" rel="noopener noreferrer">活動 ↗</a>
      <button className="footer-help" onClick={onInfo}>操作說明</button>
    </footer>
  )
}
