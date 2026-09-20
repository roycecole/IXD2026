import { useStore } from '../store/useStore.js'

// 標準 MIDI 訊息 → store。Web MIDI（USB）與 Web Bluetooth MIDI（BLE）共用這一條路徑，
// 所以 Learn / 錄製 / soft-takeover / 日誌對兩種連線一視同仁。
// 輸入：CC / Note / Pitch Bend（→ 偽 CC128，供 nanoPAD2 X 軸綁 flowX）。
export function routeMidi(data) {
  const status = data[0], d1 = data[1] | 0, d2 = data[2] | 0
  const type = status & 0xf0
  const st = useStore.getState()
  if (type === 0xb0) st.handleCC(d1, d2 / 127)
  else if (type === 0x90 && d2 > 0) st.handleNote(d1, d2 / 127)
  else if (type === 0xe0) st.handleCC(128, ((d2 << 7) | d1) / 16383) // Pitch Bend → 偽 CC128
  // Note Off / velocity=0 為事件結束，這裡忽略
}
