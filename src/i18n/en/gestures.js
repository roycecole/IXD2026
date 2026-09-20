// 相機手勢（GestureSection、GestureService、lib/hands.js）的英文字典。
export default {
  // ---- 手勢名稱 ----
  '張手': 'Open palm',
  '捏合': 'Pinch',

  // ---- 畫布角落 ----
  '相機使用中': 'Camera in use',
  '手勢 · 偵測到：{state}': 'Gesture · detected: {state}',
  '手勢 · 載入模型中…': 'Gesture · loading model…',

  // ---- 日誌 ----
  '相機手勢已啟動（{delegate}）': 'Camera gestures on ({delegate})',
  '相機手勢失敗：{err}': 'Camera gestures failed: {err}',
  '手勢：捏合 → 召喚鯨魚': 'Gesture: pinch → summon whale',
  '手勢：張手 → 海面平靜': 'Gesture: open palm → calm sea',

  // ---- 錯誤 / 不支援 ----
  '手勢需要 HTTPS 連線才能使用相機（本機 localhost 也可以）': 'Gestures need an HTTPS connection to use the camera (localhost works too)',
  '這個瀏覽器不支援相機存取': 'This browser does not support camera access',
  '這個瀏覽器不支援 WebAssembly，無法執行手勢辨識': 'This browser does not support WebAssembly, so hand tracking cannot run',
  '相機權限被拒絕：請在網址列的相機圖示允許後再試一次': 'Camera permission was denied. Allow it from the camera icon in the address bar and try again',
  '找不到相機裝置': 'No camera found',
  '相機正被其他程式或分頁使用，或無法啟動': 'The camera is in use by another app or tab, or could not start',
  '相機無法啟動': 'The camera could not start',
  '目前離線：第一次啟用需要下載手勢模型（約 8 MB），連上網路後再試': 'You are offline. The first time you enable gestures, the hand model (about 8 MB) has to be downloaded. Reconnect and try again',
  '手勢模型載入失敗（無法連到 jsDelivr 或 Google 儲存空間），請檢查網路後再試': 'Could not load the hand model (jsDelivr or Google storage is unreachable). Check your connection and try again',
  '相機中斷了（被系統或其他分頁收走）': 'The camera was interrupted (taken by the system or another tab)',
  '手勢辨識執行失敗': 'Hand tracking failed while running',

  // ---- 「裝置」面板：相機手勢一節 ----
  '相機手勢': 'Camera gestures',
  '用相機看你的手，不必碰螢幕：張手讓海面平靜，捏合召喚鯨魚。': 'Let the camera watch your hand, no touching needed: an open palm calms the sea, a pinch summons a whale.',
  '啟用相機手勢': 'Enable camera gestures',
  '已關閉（打開後才會要求相機權限）': 'Off (the camera permission is only requested after you turn it on)',
  '載入手勢模型中…（第一次需下載約 8 MB 的模型與 WebAssembly 運算程式，之後由瀏覽器快取）': 'Loading the hand model… (the first time it downloads the model, about 8 MB, plus the WebAssembly runtime; the browser caches both)',
  '共用 AR 實景的相機': 'sharing the AR view camera',
  '前鏡頭': 'front camera',
  '使用中 · {src} · {delegate}': 'On · {src} · {delegate}',
  '偵測到：{state}': 'Detected: {state}',
  '平靜中': 'calming',
  '五指張開並停留約半秒：洋流、游動速度與垃圾漸漸平靜；放手後不會彈回，其他輸入可以立刻接手。': 'Spread all five fingers and hold for about half a second: current, swim speed and trash ease down gradually. Nothing snaps back when you lower your hand, and other controls take over right away.',
  '拇指與食指捏在一起：召喚一隻鯨魚（每 3 秒最多一次，捏著不放不會重複）。': 'Pinch your thumb and index finger together to summon a whale (at most once every 3 seconds; holding the pinch does not repeat it).',
  '手放在鏡頭前、光線充足、手心朝向相機效果最好；其他手勢都會被忽略。已開啟 AR 實景時，手勢會直接共用實景的相機。': 'Works best with your palm facing the camera in good light. Any other pose is ignored. When the AR view is on, gestures share its camera.',
  '隱私：影像只在這台裝置上處理，不會上傳也不會錄下來；關閉開關、離開頁面或切到背景，都會立刻停止相機（回到這一頁時自動重新開啟）。手勢模型檔（約 8 MB，來自 Google）與運算程式（WebAssembly，來自 jsDelivr）第一次會下載，之後由瀏覽器快取。': 'Privacy: video is processed on this device only. It is never uploaded or recorded, and the camera stops right away when you switch this off, leave the page or switch to another tab (it reopens when you come back). The hand model file (about 8 MB, from Google) and the WebAssembly runtime (from jsDelivr) are downloaded once, then cached by the browser.',
}
