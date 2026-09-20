import { useStore, getPendingTakeoverCCs } from '../store/useStore.js'
import { routeMidi } from '../lib/midiRoute.js'
import { bleConnect, bleSupported } from '../lib/blemidi.js'

// 回傳 { connect, connectBle }：需由使用者手勢（按鈕）觸發，瀏覽器才會授權 Web MIDI / Web Bluetooth。
// connect＝USB（Web MIDI，含 LED 回饋）；connectBle＝藍牙 MIDI（Web Bluetooth，直接 GATT，兩者共用 routeMidi）。
// 輸入：CC / Note / Pitch Bend（→ 偽 CC128，供 nanoPAD2 X 軸綁 flowX）。
// 輸出：nanoKONTROL2 LED 回饋（需以 KORG Kontrol Editor 將 LED Mode 設為 External）：
//   ● REC 錄製中閃爍、▶ PLAY 播放中恆亮、■ STOP 有錄製待播放時亮、
//   Cycle Learn 模式閃爍、各軌 R 鍵 = 該軌 soft-takeover 待接管時閃爍、
//   Solo1-4 = 鯨/豚/龜/清垃圾 觸發時亮 0.3 秒。

let midiOut = null
let bleCur = null   // 目前的藍牙連線句柄（{name, device, disconnect}）
let ledTimer = null
let flashUntil = { 32: 0, 33: 0, 34: 0, 35: 0 }
let lastSpawnSeen = { whale: 0, dolphin: 0, turtle: 0 }

function ledSend(cc, on) {
  try { if (midiOut) midiOut.send([0xb0, cc, on ? 127 : 0]) } catch (e) {}
}

function startLedLoop() {
  if (ledTimer) clearInterval(ledTimer)
  ledTimer = setInterval(() => {
    if (!midiOut) return
    const st = useStore.getState()
    const now = performance.now()
    const blink = Math.floor(now / 250) % 2 === 0

    ledSend(45, st.rec.mode === 'recording' ? blink : false)          // ● 錄製閃
    ledSend(41, st.rec.mode === 'playing')                            // ▶ 播放亮
    ledSend(42, st.rec.mode === 'idle' && st.rec.count > 0)           // ■ 待播放亮
    ledSend(46, st.learn.active ? blink : false)                      // Learn 閃

    // 觸發按鈕回饋（鯨/豚/龜 + 清垃圾）
    const sp = st.spawns
    if (sp.whale > lastSpawnSeen.whale) { lastSpawnSeen.whale = sp.whale; flashUntil[32] = now + 300 }
    if (sp.dolphin > lastSpawnSeen.dolphin) { lastSpawnSeen.dolphin = sp.dolphin; flashUntil[33] = now + 300 }
    if (sp.turtle > lastSpawnSeen.turtle) { lastSpawnSeen.turtle = sp.turtle; flashUntil[34] = now + 300 }
    for (const cc of [32, 33, 34, 35]) ledSend(cc, now < flashUntil[cc])

    // soft-takeover 待接管 → 該軌 R 鍵閃（fader CC0-7 / knob CC16-23 → R = CC64-71）
    const pending = getPendingTakeoverCCs()
    for (let trk = 0; trk < 8; trk++) {
      ledSend(64 + trk, (pending.includes(trk) || pending.includes(16 + trk)) ? blink : false)
    }
  }, 150)
}

export function useMIDI() {
  const connect = async () => {
    const setMidi = useStore.getState().setMidi
    if (!navigator.requestMIDIAccess) {
      setMidi({ connected: false, error: '此瀏覽器不支援 Web MIDI（請用桌面版 Chrome / Edge）' })
      return
    }
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false })

      const route = (e) => routeMidi(e.data)

      const bind = () => {
        const names = []
        for (const input of access.inputs.values()) {
          names.push(input.name || 'unknown')
          input.onmidimessage = route
        }
        midiOut = null
        for (const output of access.outputs.values()) {
          if (!midiOut || /nanoKONTROL/i.test(output.name || '')) midiOut = output
        }
        useStore.getState().setMidi({ connected: true, inputs: names, error: null })
      }

      bind()
      startLedLoop()
      access.onstatechange = bind          // 熱插拔自動重綁
    } catch (err) {
      setMidi({ connected: false, error: String(err && err.message ? err.message : err) })
    }
  }

  // 藍牙 MIDI：iPad / iPhone Safari 沒有 Web Bluetooth → 引導改用「多人」QR 遙控
  const connectBle = async () => {
    const setMidi = useStore.getState().setMidi
    if (!bleSupported()) {
      setMidi({ error: '此瀏覽器不支援 Web Bluetooth（iPad / iPhone Safari 請改用「多人」掃 QR 當遙控器）' })
      return
    }
    try {
      if (bleCur) { try { bleCur.disconnect() } catch (e) {} bleCur = null } // 重連前先斷舊連線（不留殭屍 GATT）
      const dev = await bleConnect({
        onMsg: routeMidi,
        onDisconnect: (d) => {
          // 只有「目前這台」斷線才清狀態：先前被換掉的舊連線晚到的斷線事件不該把新連線的名稱清掉
          if (bleCur && bleCur.device !== d) return
          const s = useStore.getState(); s.setMidi({ bleName: null }); s.pushLog('in', '藍牙 MIDI 已斷線'); bleCur = null
        },
      })
      bleCur = dev
      const s = useStore.getState()
      s.setMidi({ bleName: dev.name, error: null })
      s.pushLog('in', `藍牙 MIDI 已連線：${dev.name}`)
    } catch (err) {
      if (err && err.name === 'NotFoundError') return // 使用者取消選擇裝置
      setMidi({ error: '藍牙 MIDI：' + String(err && err.message ? err.message : err) })
    }
  }

  return { connect, connectBle }
}
