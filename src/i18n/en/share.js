// 分享連結 / 圖片分享文案（src/lib/share.js、src/lib/capture.js、src/ui/TopBar.jsx、src/App.jsx 的分享脈絡）
export default {
  // 「分享星球」附在圖片旁的文案；{url} 是帶目前視覺狀態與資料脈絡的分享連結
  '我在 MidiSea 演了一片海 {url}': 'I played a sea in MidiSea {url}',
  // 不支援檔案分享 → 改下載 PNG，並把同一段文案（含網址）複製到剪貼簿
  '圖片已下載，文案與連結已複製': 'Image downloaded · caption and link copied',
  '分享星球 → 下載 PNG，文案與連結已複製': 'Snapshot → PNG downloaded, caption and link copied',
  // 複製分享連結：剪貼簿不可用 → 跳出輸入框（手動複製）；兩條路都不行 → 日誌記下失敗
  '複製此連結': 'Copy this link',
  '分享連結複製失敗': 'Copying the share link failed',
  // 打開分享連結時的日誌
  '開啟分享連結：套用海況與資料設定': 'Opened a share link: sea and data settings applied',
}
