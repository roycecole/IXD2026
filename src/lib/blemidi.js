// Web Bluetooth MIDI（BLE-MIDI）：不經 Web MIDI API，直接以 GATT 連 BLE-MIDI 裝置。
// 支援：Chrome / Edge（桌面、Android）。**iPad / iPhone Safari 沒有 Web Bluetooth**——
// 那些裝置請用「多人」掃 QR 當遙控器（走 WebRTC，不需藍牙）。
export const BLE_MIDI_SERVICE = '03b80e5a-ede8-4b33-a751-6ce34ec4c700'
export const BLE_MIDI_CHAR = '7772e5db-3868-4112-a1a9-f2669d106bf3'

export const bleSupported = () => typeof navigator !== 'undefined' && !!navigator.bluetooth

const dataLen = (s) => { const t = s & 0xf0; return t === 0xc0 || t === 0xd0 ? 1 : 2 }

// BLE-MIDI 封包 → 標準 MIDI 訊息陣列（[status, d1, d2?]）。
// 封包 = [標頭 1xxxxxxx] + 重複 [時間戳低位 1xxxxxxx][MIDI 訊息]；連續同狀態時（running status）狀態位元組可省略；
// SysEx（F0…F7）此專案不使用，解析時略過。純函式，可在 Node 測試。
export function parseBleMidi(b) {
  const out = []
  const n = b.length
  if (n < 2 || !(b[0] & 0x80)) return out
  let i = 1, running = 0, inSysex = false
  while (i < n) {
    if (inSysex) {
      // SysEx 結尾 F7 之前一定有時間戳；時間戳的低 7 位若恰為 0x77，位元組值也是 0xF7（約 1/128 機率）——
      // 因此「下一個位元組是 F7」時，目前這個 bit7 位元組是時間戳，兩個一起吃掉才是正確結尾。
      const c = b[i++]
      if (c & 0x80) {
        if (b[i] === 0xf7) { i++; inSysex = false }
        else if (c === 0xf7) inSysex = false           // 沒有時間戳的違規 F7：仍視為結尾
      }
      continue
    }
    if (b[i] & 0x80) { i++; if (i >= n) break }              // 時間戳低位（狀態位元組之前一定有）
    let s
    if (b[i] & 0x80) {                                       // 狀態位元組
      s = b[i++]
      if (s >= 0xf8) { out.push([s]); continue }             // 即時訊息（單位元組，不影響 running status）
      if (s === 0xf0) { inSysex = true; continue }
      if (s >= 0xf1) {                                       // 系統共通：吃掉資料位元組並清 running status
        running = 0
        const need = s === 0xf2 ? 2 : (s === 0xf1 || s === 0xf3) ? 1 : 0
        i += need
        continue
      }
      running = s
    } else {                                                 // 資料位元組 → 沿用 running status
      s = running
      if (!s) { i++; continue }
    }
    const need = dataLen(s)
    if (i + need > n) break                                  // 封包被截斷
    const msg = [s]
    let ok = true
    for (let k = 0; k < need; k++) { const d = b[i + k]; if (d & 0x80) { ok = false; break } msg.push(d) }
    if (!ok) break                                           // 資料位元組不該有 bit7，視為損壞
    i += need
    out.push(msg)
  }
  return out
}

// 把 GATT 特徵值的通知轉成 MIDI 訊息（chr 只需有 add/removeEventListener，方便以假物件測試）
export function attachBleCharacteristic(chr, onMsg) {
  const handler = (e) => {
    const dv = e.target.value
    if (!dv) return
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)
    for (const m of parseBleMidi(bytes)) onMsg(m)
  }
  chr.addEventListener('characteristicvaluechanged', handler)
  return () => chr.removeEventListener('characteristicvaluechanged', handler)
}

// 需由使用者手勢觸發（requestDevice 的限制）。回傳 { name, disconnect }。
export async function bleConnect({ onMsg, onDisconnect }) {
  const dev = await navigator.bluetooth.requestDevice({
    filters: [{ services: [BLE_MIDI_SERVICE] }],
    optionalServices: [BLE_MIDI_SERVICE],
  })
  const server = await dev.gatt.connect()
  let detach = () => {}
  try {
    const svc = await server.getPrimaryService(BLE_MIDI_SERVICE)
    const chr = await svc.getCharacteristic(BLE_MIDI_CHAR)
    detach = attachBleCharacteristic(chr, onMsg)
    await chr.startNotifications()
  } catch (e) {                                         // 半途失敗要收乾淨，否則裝置佔著連線、下次連不上
    detach()
    try { server.disconnect() } catch (x) {}
    throw e
  }
  dev.addEventListener('gattserverdisconnected', () => { detach(); onDisconnect && onDisconnect(dev) })
  return { name: dev.name || 'BLE MIDI', device: dev, disconnect: () => { try { dev.gatt.disconnect() } catch (e) {} } }
}
