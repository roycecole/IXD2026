// 說明視窗（InfoModal 外殼）與多人視窗（MultiModal）。說明正文另在 src/ui/info/InfoZh.jsx / InfoEn.jsx。
export default {
  // ---- InfoModal 外殼 ----
  'MidiSea 資料導演台': 'MidiSea Data Director',
  '關閉': 'Close',
  '本作品為': 'Made for the',
  'IxDA Taiwan 2026 會員工作坊「AI 共生黑客鬆」': 'IxDA Taiwan 2026 member workshop "AI Symbiosis Hackathon"',
  '隊伍：': 'Team ',
  '12組 卡加布列島': '12 · Kagabulie Island',
  '前往活動頁面 ↗': 'Go to the event page ↗',
  '開始探索': 'Start exploring',

  // ---- MultiModal ----
  '多人合奏': 'Multiplayer jam',
  '多人合奏 · 手機掃 QR 當遙控器': 'Multiplayer jam · Scan the QR code to use your phone as a remote',
  '遙控器 QR code': 'Remote QR code',
  '連線服務啟動失敗：{err}（需要網路）': 'Could not start the connection service: {err}. An internet connection is required.',
  '啟動失敗': 'Failed to start',
  '正在開啟連線服務…': 'Opening the connection service…',
  '已有 {n} 支手機連線 — 正在合奏': ({ n }) => (n === 1 ? '1 phone connected — jamming' : `${n} phones connected — jamming`),
  '等待手機掃碼加入…': 'Waiting for phones to scan and join…',
  '複製遙控連結': 'Copy remote link',
  '已複製連結': 'Link copied',
  '本機累計 {joins} 人掃碼 · 演出 {shows} 次': ({ joins, shows }) => `${joins} phone ${joins === 1 ? 'scan' : 'scans'} on this device · ${shows} ${shows === 1 ? 'performance' : 'performances'}`,
  '每支手機會分到一個「聲部」（海 / 生態 / 氛圍 / 自由），滑桿即時跟著主畫面同步；所有輸入可被錄製、可被 soft-takeover 接管 —— 一個人演奏，變一群人合奏一片海。':
    'Each phone gets a "part" (Ocean / Life / Mood / Free), and its sliders stay in sync with the main screen in real time. Every input can be recorded, and pickup mode lets you take over any parameter without jumps. One performer becomes a whole band, playing one sea together.',
}
