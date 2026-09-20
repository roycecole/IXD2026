// 導覽員遙控（手機當導覽員遙控器）：手機遙控頁的「導覽員」區塊、多人視窗的「合奏 | 導覽員」QR、展場 QR 的導覽員模式、IN 日誌。
// 用語依 GLOSSARY.md：stop（導覽的「站」）、sphere、phone remote。「導覽員」= Guide（拿手機遙控資料導覽的講解者）。
// 站名（今日水庫 / 潮汐 / 月亮 / 揚塵 / 空氣品質…）只在遙控頁顯示：潮汐 / 月亮 / 揚塵 / 空氣品質沿用資料層的既有譯名，這裡只補沒有的。
// 已存在、直接沿用的 key（不要在這裡重複宣告，免得譯文不一致）：上一站 / 下一站 / 已暫停 / 第 {n} 站 / 第 {n} / {total} 站（tour.js、tourpresenter.js）。
export default {
  // ---- 遙控頁：導覽員區塊 ----
  '導覽員': 'Guide',
  '只能操控資料導覽': 'Controls the data tour only',
  '連線中斷 · 按鈕暫時無法使用': 'Disconnected · buttons are unavailable for now',
  '主畫面還沒載入海況資料': 'The main screen has not loaded the sea data yet',
  '導覽還沒開始': 'The tour has not started yet',
  '正在取得導覽狀態…': 'Getting the tour status…',
  '暫停': 'Pause',
  '繼續': 'Resume',
  '開始導覽': 'Start tour',
  '結束導覽': 'End tour',
  '導覽站（點一下跳到該站）': 'Tour stops (tap to jump to one)',
  '念出字幕：開': 'Read captions aloud: on',
  '念出字幕：關': 'Read captions aloud: off',
  '導覽員連結已失效或主畫面沒有回應，先當一般遙控使用（主畫面重開後，請重新掃描導覽員 QR）':
    'This guide link is no longer valid, or the main screen did not respond, so this phone works as a regular remote for now. After the main screen restarts, scan the guide QR again.',
  '演奏控制': 'Play controls',
  '操作會中止導覽': 'Touching these stops the tour',

  // ---- 遙控頁：自動重連 / 螢幕保持喚醒 / 倒數與下一站預告 ----
  '重新連線中…（第 {n} 次）': 'Reconnecting… (attempt {n})',
  '連線中斷 · 回到這個畫面會自動重連': 'Disconnected · will reconnect when you come back to this screen',
  '主畫面已重新載入，請重新掃描 QR': 'The main screen was reloaded. Please scan the QR code again',
  '螢幕保持喚醒中': 'Screen kept awake',
  '此瀏覽器無法保持喚醒（請把手機的自動鎖定調長）': 'This browser cannot keep the screen awake (set your phone’s auto-lock to a longer time)',
  '剩 {n} 秒': ({ n }) => `${n} s left`,
  '下一站：{name}': 'Up next: {name}',
  '最後一站': 'Last stop',

  // ---- 站名（遙控頁依自己的語系顯示；host 只送站 id）----
  '今日水庫': 'Reservoir today',
  '鳥群調查': 'Bird survey',
  '魚群調查': 'Fish survey',
  '河川測站': 'River stations',

  // ---- 多人視窗：合奏 | 導覽員 ----
  '導覽員遙控器 · 手機掃 QR 操控資料導覽': 'Guide remote · scan with your phone to run the data tour',
  'QR 類型': 'QR type',
  '合奏': 'Jam',
  '導覽員遙控器 QR code': 'Guide remote QR code',
  '已有 {n} 支導覽員手機連線': ({ n }) => `${n} guide ${n === 1 ? 'phone' : 'phones'} connected`,
  '等待導覽員手機掃碼…': 'Waiting for the guide’s phone to scan…',
  '複製導覽員連結': 'Copy guide link',
  '只能操控資料導覽：手機出現「上一站 / 暫停 / 下一站」大按鈕，站在投影機旁就能講解，不必碰筆電。不能演奏，也不會改動其他設定。':
    'Controls the data tour only: the phone shows big Previous / Pause / Next buttons, so you can present next to the projector without touching the laptop. It cannot play the sea or change any other setting.',
  '只給講解的人掃，別公開。這個 QR 只在這次開啟的主畫面有效；主畫面重新載入後會換新，要重新掃描。':
    'Share it only with the presenter. This QR is valid only for this session of the main screen; after the main screen reloads it changes and the phone must scan again.',
  '這個瀏覽器無法產生安全的導覽員連結': 'This browser cannot generate a secure guide link',

  // ---- 展場 QR：按 G 顯示導覽員 QR ----
  '導覽員 QR · 僅供講解者': 'Guide QR · presenters only',
  '{s} 秒後換回一般 QR': ({ s }) => `Back to the regular QR in ${s} s`,

  // ---- IN 日誌 ----
  '導覽員遙控器已連線（{n} 支）': ({ n }) => `Guide remote connected (${n} online)`,
  '導覽員遙控器已離線（剩 {n} 支）': ({ n }) => `Guide remote disconnected (${n} left)`,

  // ---- IN 日誌：同一支手機自動重連 ----
  '遙控器重新連線 · 聲部「{part}」（{n} 人連線）': 'Remote reconnected · part "{part}" ({n} connected)',
}
