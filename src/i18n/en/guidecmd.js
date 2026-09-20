// 導覽員的語音 / 手勢指令與旁白解鎖（voiceCommands / VoiceService / VoiceSection / gestures / GestureService / GestureSection / narration）的英文字典。
// '下一站' / '上一站' 與 tourpresenter.js 的英文相同（重複宣告、譯文一致，不算衝突）。
export default {
  // ---- 旁白（narration.js：iOS 解鎖用的確認語，會被念出來）----
  '旁白已開啟': 'Narration on',

  // ---- 語音：導覽員指令（label = 「聽到：…」與日誌用；say = 「可以這樣說」；fx = 效果說明）----
  '下一站': 'Next stop',
  '上一站': 'Previous stop',
  '暫停導覽': 'Pause tour',
  '繼續導覽': 'Resume tour',
  '開始導覽': 'Start tour',
  '結束導覽': 'End tour',
  '說「下一站」': 'Say "next stop"',
  '說「上一站」': 'Say "previous stop"',
  '說「暫停導覽」或「導覽暫停」': 'Say "pause tour"',
  '說「繼續導覽」或「導覽繼續」': 'Say "resume tour"',
  '說「開始導覽」': 'Say "start tour"',
  '說「結束導覽」或「停止導覽」': 'Say "stop tour" or "end tour"',
  '導覽跳到下一站': 'Tour jumps to the next stop',
  '導覽回到上一站': 'Tour goes back one stop',
  '導覽停在這一站（可繼續）': 'Tour holds on this stop (you can resume)',
  '導覽從這一站接著走': 'Tour carries on from this stop',
  '開始資料導覽': 'Starts the data tour',
  '結束導覽並還原原本的海': 'Ends the tour and restores your sea',

  // ---- 語音：IN 日誌（有聽到，但導覽的狀態讓它沒有動作）----
  '語音：{cmd}（導覽沒在進行）': 'Voice: {cmd} (no tour is running)',
  '語音：{cmd}（導覽已在進行）': 'Voice: {cmd} (the tour is already running)',
  '語音：{cmd}（已經暫停）': 'Voice: {cmd} (already paused)',
  '語音：{cmd}（導覽沒有暫停）': 'Voice: {cmd} (the tour is not paused)',
  '語音：{cmd}（目前無法開始導覽）': 'Voice: {cmd} (the tour cannot start right now)',

  // ---- 「裝置」面板：語音指令一節的導覽員段落 ----
  '導覽員指令（不會中止導覽）': 'Tour guide commands (they do not interrupt the tour)',
  '導覽員語音指令': 'Tour guide voice commands',
  '導覽進行中才有效（「開始導覽」隨時可用）；沒在導覽時說了只會在日誌留一行「有聽到」。': 'They only work while a tour is running ("start tour" works any time); when no tour is running they just leave a "heard" line in the log.',
  '導覽員平常講解時說到這些詞（例如「下一站是水庫」）也會被當成指令：講解期間想避免誤觸發，可先停止收音，或改用手機遙控器。旁白念字幕時本來就會暫時不辨識。':
    'Saying these words while you talk (for example "the next stop is the reservoir") also counts as a command. To avoid accidental jumps while you present, stop listening or use the phone remote instead. Recognition is already paused while the narration is speaking.',

  // ---- 相機手勢：揮手換站（gestures.js / GestureService / GestureSection）----
  '揮手': 'Wave',
  '揮手換站': 'Wave to change stop',
  '揮手：{action}': 'Wave: {action}',
  '手勢 · 揮手：{action}': 'Gesture · wave: {action}',
  '揮手換站已關閉。': 'Wave to change stop is off.',
  '要先啟用相機手勢，揮手換站才會作用。': 'Turn on camera gestures first; wave to change stop only works with them.',
  '相機手勢準備好之後，揮手換站才會作用。': 'Wave to change stop starts working once camera gestures are ready.',
  '待命中：開始資料導覽後，對著相機張開手掌橫掃就能換站。': 'Standing by: once a data tour is running, sweep an open palm across the camera to change stop.',
  '已就緒：張開手掌，向左揮＝下一站、向右揮＝上一站（以你自己的左右為準）。導覽進行中張手不會讓海面平靜。': 'Ready: with an open palm, wave left for the next stop and right for the previous one (left and right are your own). While a tour is running, an open palm does not calm the sea.',
  '資料導覽進行中，張開手掌快速橫掃：以你自己的左右為準，向左揮＝下一站、向右揮＝上一站（像翻頁）。約 1 秒內只換一站；慢慢移動、握拳、只動手指、來回揮都不算，沒在導覽時也不會處理。':
    'While a data tour is running, sweep an open palm quickly sideways: left and right are your own, so wave left for the next stop and right for the previous one (like turning a page). It changes at most one stop per second. Slow movement, a fist, moving only your fingers or waving back and forth do not count, and nothing is handled when no tour is running.',
}
