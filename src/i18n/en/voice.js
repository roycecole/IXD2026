// 語音指令（VoiceSection / VoiceService / lib/voice.js / lib/voiceCommands.js）。
// '鯨魚' / '海豚' / '海龜' / '大浪' / '亮星' / '淨化' / '清垃圾' / '停止' / '鯨魚出現' / '海豚出現' / '海龜出現' 沿用 ui-shell.js、store.js 既有的 key。
export default {
  // ---- 「裝置」面板一節 ----
  '語音指令': 'Voice commands',
  '說出「鯨魚」「大浪」「安靜」等指令，免碰螢幕就能操作；適合展場、手髒或不方便觸控的時候。':
    'Say "whale", "big wave" or "quiet" to control the sea without touching the screen. Handy at exhibits, with dirty hands, or whenever touch is awkward.',
  '開始收音': 'Start listening',
  '停止收音': 'Stop listening',
  '收音中': 'Listening',
  '準備收音…': 'Getting ready…',
  '直接說出指令即可。': 'Just say a command.',
  '正在啟動麥克風…（瀏覽器詢問時請按「允許」）': 'Starting the microphone… (click "Allow" when the browser asks)',
  '（重試中…）': ' (retrying…)',
  '最近聽到：{text}': 'Last heard: {text}',
  '可以這樣說（可連著說多個，例如「鯨魚 大浪」）': 'What you can say (chain several, e.g. "whale, big wave")',
  '可用的語音指令': 'Available voice commands',

  // ---- 指令：說法與效果 ----
  '說「鯨魚」': 'Say "whale"',
  '說「海豚」': 'Say "dolphin"',
  '說「海龜」': 'Say "turtle"',
  '說「大浪」或「大浪來了」': 'Say "big wave" or "wave"',
  '說「亮星」或「星星」': 'Say "sparkle" or "stars"',
  '說「淨化」': 'Say "purify"',
  '說「清垃圾」或「清理垃圾」': 'Say "clean" or "clear trash"',
  '說「安靜」「平靜」或「靜一點」': 'Say "quiet", "calm" or "peace"',
  '說「快一點」': 'Say "faster"',
  '說「停」或「停止」': 'Say "stop"',
  '大浪與氣泡': 'Big wave with bubbles',
  '亮星爆發': 'Star burst',
  '淨化波擴散': 'Purify wave ripples out',
  '清除垃圾並淨化': 'Clears the trash with a purify wave',
  '洋流、游速與垃圾一起放緩': 'Current, swim speed and trash ease off',
  '洋流與游速加快': 'Current and swim speed pick up',
  '停止播放或錄製': 'Stops playback or recording',
  '安靜': 'Calm',
  '快一點': 'Faster',

  // ---- 回饋與日誌 ----
  '聽到：{cmd}': ({ cmd }) => `Heard: ${String(cmd).toLowerCase()}`,
  '語音指令：{cmd}': 'Voice command: {cmd}',

  // ---- 說明與隱私 ----
  '辨識語言：{tag}。跟著介面語言切換，一次只辨識一種語言；想說另一種語言請先切換介面語言。':
    'Recognition language: {tag}. It follows the interface language, and only one language is recognized at a time; switch the interface language to speak the other one.',
  '隱私：Chrome / Edge 的語音辨識會把麥克風的聲音送到雲端服務（Google / Microsoft）辨識；Safari 依系統設定處理。本站不錄音、不保存、不上傳任何音訊，只拿辨識出的文字來比對指令。':
    'Privacy: in Chrome and Edge, speech recognition sends your microphone audio to a cloud service (Google / Microsoft); Safari follows your system settings. This site does not record, store or upload any audio; it only compares the recognized text with the commands.',
  '只有你按下「開始收音」才會啟用麥克風，收音時畫面右上角會一直顯示「收音中」。按停止、離開頁面或切到背景，都會立刻關閉麥克風。':
    'The microphone is only used after you press "Start listening", and a "Listening" badge stays in the top right corner of the canvas. Pressing stop, leaving the page or switching to the background turns the microphone off right away.',
  '這和工具列的「麥克風」（吹氣＝風）是各自獨立的功能，可以同時開啟；少數手機同時收音時其中一項會失靈，請擇一使用。':
    'This is separate from the toolbar "Mic" (blow = wind), and both can be on at once. On a few phones one of them stops working when both listen, so pick one there.',

  // ---- 錯誤 ----
  '麥克風權限被拒絕。請在瀏覽器的網站設定允許使用麥克風，再重新開啟。': 'Microphone access was denied. Allow the microphone in your browser\'s site settings, then turn voice commands on again.',
  '瀏覽器的語音辨識服務目前無法使用（Safari 請到系統設定開啟「聽寫」與 Siri）。': 'The browser\'s speech recognition service is unavailable right now (on Safari, turn on Dictation and Siri in System Settings).',
  '連不上語音辨識服務：Chrome 的語音辨識需要網路連線。': 'Cannot reach the speech recognition service: speech recognition in Chrome needs an internet connection.',
  '找不到可用的麥克風。': 'No usable microphone found.',
  '這個瀏覽器不支援目前語言的語音辨識。': 'This browser does not support speech recognition for the current language.',
  '這個瀏覽器不支援語音辨識（例如 Firefox）；請改用 Chrome、Edge 或 Safari。': 'This browser does not support speech recognition (Firefox, for example); try Chrome, Edge or Safari.',
  '語音辨識連續失敗，已自動關閉；稍後可以再開啟。': 'Speech recognition kept failing and was turned off. You can try again later.',
}
