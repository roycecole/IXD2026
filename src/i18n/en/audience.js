// 觀眾視窗（雙螢幕）：AudienceApp / AudienceSection / AudienceService
export default {
  // ---- 觀眾視窗本體（?audience=1）----
  'MidiSea 觀眾視窗': 'MidiSea audience window',
  '觀眾視窗': 'Audience window',
  '等待主視窗…': 'Waiting for the main window…',
  '請確認主視窗已開啟，且兩個視窗使用同一個網址': 'Make sure the main window is open and both windows use the same URL',
  '這個瀏覽器不支援視窗同步（BroadcastChannel），無法顯示主視窗的畫面': 'This browser does not support window sync (BroadcastChannel), so the main window\'s view cannot be shown',
  '主視窗要求關閉此視窗，但瀏覽器不允許——請直接關掉它': 'The main window asked to close this window, but the browser does not allow it. Please close it yourself.',
  '點一下進入全螢幕': 'Click to go full screen',

  // ---- 「裝置」面板：觀眾視窗一節 ----
  '觀眾視窗（雙螢幕）': 'Audience window (dual screen)',
  '筆電操作、投影機給觀眾看：開一個觀眾視窗放到外接螢幕，全螢幕顯示同一片海（含資料看板），你的操作即時同步。觀眾視窗沒有控制介面、也不出聲音。':
    'Perform on the laptop, show the audience on the projector: open an audience window on the external screen and it shows the same sea full screen (with the data board), synced live with your actions. The audience window has no controls and plays no sound.',
  '開啟觀眾視窗': 'Open audience window',
  '關閉觀眾視窗': 'Close audience window',
  '等待螢幕權限…': 'Waiting for screen permission…',
  '{n} 個觀眾視窗已連線': ({ n }) => (n === 1 ? '1 audience window connected' : `${n} audience windows connected`),
  '尚無觀眾視窗連線': 'No audience window connected',
  '偵測到 {n} 個螢幕': ({ n }) => (n === 1 ? '1 screen detected' : `${n} screens detected`),
  '偵測到多個螢幕': 'Multiple screens detected',
  '目前只有 1 個螢幕': 'Only 1 screen right now',
  '此瀏覽器無法偵測螢幕數量': 'This browser cannot detect the number of screens',
  '已在另一個螢幕開啟觀眾視窗。點一下該視窗即可進入全螢幕。': 'Opened the audience window on another screen. Click it once to go full screen.',
  '觀眾視窗已經開著，已切到前景。': 'The audience window is already open and has been brought to the front.',
  '只偵測到一個螢幕，已開啟一般視窗。接上投影機後，請把視窗拖到投影機畫面，再點一下進入全螢幕。':
    'Only one screen was found, so a regular window was opened. Once the projector is connected, drag the window onto it and click it once to go full screen.',
  '這個瀏覽器無法自動指定螢幕（需要 Chrome / Edge，且網址為 HTTPS 或 localhost）。已開啟一般視窗：請把視窗拖到投影機畫面，再點一下進入全螢幕。':
    'This browser cannot pick a screen automatically (it needs Chrome or Edge, and an HTTPS or localhost URL). A regular window was opened: drag it onto the projector, then click it once to go full screen.',
  '沒有取得多螢幕權限，已開啟一般視窗：請把視窗拖到投影機畫面，再點一下進入全螢幕。之後想自動放置，可在網址列的網站設定允許「視窗管理」。':
    'Multi-screen permission was not granted, so a regular window was opened: drag it onto the projector, then click it once to go full screen. To place it automatically next time, allow "Window management" in the site settings next to the address bar.',
  '讀取螢幕資訊失敗，已開啟一般視窗：請把視窗拖到投影機畫面，再點一下進入全螢幕。':
    'Could not read the screen layout, so a regular window was opened: drag it onto the projector, then click it once to go full screen.',
  '彈出視窗被瀏覽器封鎖。請在網址列允許本網站的彈出視窗，然後再按一次「開啟觀眾視窗」。':
    'The browser blocked the pop-up. Allow pop-ups for this site in the address bar, then press "Open audience window" again.',
  '已取得多螢幕權限，但瀏覽器擋下了這一次的彈出視窗。請再按一次「開啟觀眾視窗」。':
    'Multi-screen permission was granted, but the browser blocked this pop-up. Press "Open audience window" once more.',
  '已要求觀眾視窗關閉。若視窗沒有關閉（不是從這裡開啟的），請直接關掉它。':
    'Asked the audience window to close. If it stays open (it was not opened from here), close it yourself.',
  '資料只在你的瀏覽器內、兩個視窗之間傳遞，不會上傳。自動放到外接螢幕需要 Chrome / Edge、HTTPS（或 localhost）與「視窗管理」權限；Safari / Firefox 會開一般視窗，請手動拖到投影機再點一下進入全螢幕。':
    'Data only moves between the two windows inside your browser and is never uploaded. Automatic placement on the external screen needs Chrome or Edge, HTTPS (or localhost) and the "Window management" permission; Safari and Firefox open a regular window, so drag it onto the projector and click it once to go full screen.',

  // ---- AudienceService：OUT 日誌 ----
  '觀眾視窗連線：{n}': ({ n }) => `Audience windows connected: ${n}`,
  '觀眾視窗已全部離線': 'All audience windows disconnected',
}
