// 資料導覽 · 導覽員控制（TourNav / 可點的進度點 / 已暫停）＋ 空氣品質站字幕 ＋ 相關 OUT 日誌。
// 空氣品質是「模型資料」（Open-Meteo / CAMS 全球大氣模型），不是政府觀測值：英文一律寫 model / modeled / not government observations，不要譯成 official / observed。
// 用語依 GLOSSARY.md：sphere、stop（導覽的「站」）、caption（字幕）。按鈕文字簡短；title / aria-label 用完整說明並附快速鍵。
export default {
  // ---- 導覽員按鈕列（TourNav）----
  '導覽員控制': 'Tour controls',
  '上一站': 'Previous stop',
  '上一站（快速鍵 ←）': 'Previous stop (shortcut ←)',
  '暫停講解': 'Pause tour',
  '暫停講解（快速鍵 P）': 'Pause tour (shortcut P)',
  '繼續講解（快速鍵 P）': 'Resume tour (shortcut P)',
  '下一站': 'Next stop',
  '下一站（快速鍵 →）': 'Next stop (shortcut →)',
  '複製此站連結': 'Copy link to this stop',
  '複製此站連結：貼給別人，開啟後直接到這一站': 'Copy link to this stop: share it and it opens right here',
  '複製失敗（瀏覽器不允許存取剪貼簿）': 'Copy failed (clipboard access blocked)',
  '已複製': 'Copied',
  '複製失敗': 'Copy failed',
  '念出字幕': 'Read captions aloud',
  '念出字幕：用語音朗讀每一站的說明': 'Read captions aloud: speaks each stop’s description with your browser’s voice',

  // ---- 字幕卡（TourCaption）----
  '已暫停': 'Paused',
  '導覽進度（點一下跳到該站）': 'Tour progress (tap a dot to jump to that stop)',
  '第 {n} 站：{title}': 'Stop {n}: {title}',
  '第 {n} 站': 'Stop {n}',

  // ---- 面板卡片（TourControls）----
  '導覽時念出字幕': 'Read captions aloud during the tour',
  '用語音朗讀每一站的字幕；預設關閉，只在這個視窗出聲': 'Speaks each stop’s caption with your browser’s voice. Off by default; only this window makes sound.',
  '導覽員：← 上一站、→ 下一站、P 暫停 / 繼續；也可以點進度點直接跳到該站': 'Presenter keys: ← previous stop, → next stop, P pause / resume. You can also tap a progress dot to jump to that stop.',

  // ---- 字幕：空氣品質站（Open-Meteo / CAMS 模型資料，非政府觀測）----
  '{name} · 模型資料': '{name} · model data',
  'PM2.5 {lo}–{hi} μg/m³（Open-Meteo / CAMS 模型，非政府觀測）：越高，海水越混濁、垃圾越多': 'PM2.5 {lo}–{hi} μg/m³ (Open-Meteo / CAMS model, not government observations): higher PM2.5, murkier sea and more trash',
  'PM2.5 約 {v} μg/m³（Open-Meteo / CAMS 模型，非政府觀測）：這段時間變化很小': 'PM2.5 about {v} μg/m³ (Open-Meteo / CAMS model, not government observations): little change over this period',

  // ---- OUT 日誌 ----
  '資料導覽暫停（第 {n} 站）': 'Data tour paused (stop {n})',
  '資料導覽繼續（第 {n} 站）': 'Data tour resumed (stop {n})',
  '已複製第 {n} 站連結': 'Copied the link to stop {n}',
  '複製連結失敗：瀏覽器不允許存取剪貼簿': 'Could not copy the link: clipboard access was blocked',
}
