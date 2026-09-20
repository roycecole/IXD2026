// 「裝置」面板的觸覺回饋一節（HapticsSection）。'弱' / '中' / '強' 與 '鯨魚' 等沿用 ui-shell.js 既有的 key。
export default {
  '觸覺回饋': 'Haptics',
  '不同事件有不同的觸感節奏：鯨魚長而低、水滴短而輕、淨化波漸強、海豚兩下輕點。手機用震動馬達，手把（Gamepad）用雙震動馬達。':
    'Each event has its own feel: whales are long and low, drops are short and light, the purify wave builds up, dolphins tap twice. Phones use the vibration motor; gamepads use their dual rumble motors.',
  '啟用觸覺回饋': 'Enable haptics',
  '觸覺強度': 'Haptic strength',
  '測試觸感': 'Try haptics',
  '停止測試': 'Stop test',
  '沒有可用的震動裝置': 'No vibration device available',
  '正在播放：{name}': 'Playing: {name}',
  '鯨魚（長而低）': 'Whale (long and low)',
  '水滴（短而輕）': 'Drip (short and light)',
  '淨化波（漸強）': 'Purify wave (building up)',
  '海豚（兩下輕點）': 'Dolphin (two light taps)',
  '海龜（緩慢兩下）': 'Turtle (two slow taps)',
  '錄製開始（短、短、長）': 'Recording starts (short, short, long)',
  '手機震動：支援': 'Phone vibration: supported',
  '手機震動：不支援': 'Phone vibration: not supported',
  '手把：未偵測到（接上後按一下任意按鍵）': 'Gamepad: none detected (press any button after plugging it in)',
  '手把：偵測到 {n} 支，{m} 支支援震動': ({ n, m }) => (n === 1
    ? `Gamepad: 1 detected, ${m ? 'rumble supported' : 'no rumble support'}`
    : `Gamepads: ${n} detected, ${m} with rumble support`),
  '這個瀏覽器沒有震動 API（iOS Safari 就是如此），手機震動會靜默略過；可改接手把（Chrome / Edge）體驗觸覺回饋。':
    'This browser has no vibration API (iOS Safari is one), so phone vibration is skipped silently. Connect a gamepad (Chrome / Edge) to feel haptics instead.',
  '這台看起來不是手機或平板，多半沒有震動馬達；接上支援震動的手把即可使用。':
    'This does not look like a phone or tablet and probably has no vibration motor. Connect a gamepad with rumble instead.',
  '系統開啟了「減少動態效果」，所以觸覺回饋預設關閉；你仍可手動開啟。':
    'Your system asks for reduced motion, so haptics are off by default. You can still turn them on.',
  '偵測到的手把不支援震動（目前只有 Chrome / Edge 支援手把震動）。':
    'The detected gamepad has no rumble support (only Chrome and Edge support gamepad rumble).',
  '目前沒有可用的震動裝置，事件會靜默略過。': 'No vibration device is available right now, so events are skipped silently.',
  '偏好只存在這台裝置，不會傳送任何資料。': 'Your choice stays on this device; nothing is sent anywhere.',
}
