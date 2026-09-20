// 「裝置」面板的 AR 桌面一節（XrSection / XrOverlay，WebXR immersive-ar）。'海水高度' / '洋流速度' / '海水清澈' / '鯨魚' / '海豚' / '海龜' 沿用 ui-shell.js 既有的 key。
export default {
  'AR 桌面': 'AR tabletop',
  '用手機的 AR 把這顆海放在真實的桌面上：走動時球固定在原處，繞著走可以看到各個角度。需要 Android Chrome 等支援 WebXR 的裝置；相機只在你按下按鈕後才啟用，畫面不會上傳。':
    'Use your phone\'s AR to set this sea on a real table. The sphere stays put as you walk, so you can see it from every angle. Needs a device with WebXR, such as Chrome on Android. The camera turns on only after you tap the button, and nothing is uploaded.',
  '在桌面上放置': 'Place on a table',
  '啟動中…': 'Starting…',
  '請先關閉工具列的「實景」：兩者都要用相機，不能同時開。': 'Turn off "AR view" in the toolbar first: both need the camera and cannot run at the same time.',

  // 結束後的說明（裝置面板）
  '已退出 AR，回到一般畫面。': 'Left AR and back to the normal view.',
  'AR 被系統中斷，已回到一般畫面。': 'AR was interrupted by the system. Back to the normal view.',
  '沒有取得相機權限。請在瀏覽器的提示中允許相機，或到網站設定開啟後再試一次。': 'Camera permission was not granted. Allow the camera in the browser prompt, or enable it in the site settings, then try again.',
  '這台裝置不支援桌面偵測（hit-test），無法使用 AR 桌面。': 'This device does not support surface detection (hit-test), so AR tabletop is not available.',
  'AR 需要安全連線（HTTPS）。': 'AR needs a secure (HTTPS) connection.',
  'AR 正在使用中，請先結束其他 AR 或相機使用，再試一次。': 'AR is already in use. Close other AR or camera use and try again.',
  '無法把畫面接到 AR（繪圖初始化失敗），已回到一般畫面。': 'Could not connect the graphics to AR (graphics setup failed). Back to the normal view.',
  '無法啟動桌面偵測，已回到一般畫面。': 'Could not start surface detection. Back to the normal view.',
  'AR 啟動逾時，已回到一般畫面。請再試一次。': 'AR took too long to start. Back to the normal view; please try again.',
  'AR 發生錯誤，已回到一般畫面。': 'AR ran into an error. Back to the normal view.',
  'AR 發生錯誤，已回到一般畫面：{detail}': 'AR ran into an error and went back to the normal view: {detail}',

  // 沉浸模式的 DOM overlay
  'AR 桌面放置': 'AR tabletop placement',
  'AR 啟動中…': 'Starting AR…',
  '移動手機，找一個平面': 'Move your phone to find a surface',
  '對準桌面或地板，點一下把海放在這裡': 'Aim at a table or floor, then tap to place the sea here',
  '退出 AR': 'Exit AR',
  '重新放置': 'Place again',
  '海況控制': 'Sea controls',
  '繞著球走一圈看看；下面的滑桿與按鈕可以調整海況。': 'Walk around the sphere. Use the sliders and buttons below to change the sea.',
}
