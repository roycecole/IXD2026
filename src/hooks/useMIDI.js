import { useStore, getPendingTakeoverCCs } from '../store/useStore.js'

// 回傳 { connect }：需由使用者手勢（按鈕）觸發，瀏覽器才會授權 Web MIDI。
// 輸入：CC / Note / Pitch Bend（→ 偽 CC128，供 nanoPAD2 X 軸綁 flowX）。
// 輸出：nanoKONTROL2 LED 回饋（需以 KORG Kontrol Editor 將 LED Mode 設為 External）：
//   ● REC 錄製中閃爍、▶ PLAY 播放中恆亮、■ STOP 有錄製待播放時亮、
//   Cycle Learn 模式閃爍、各軌 R 鍵 = 該軌 soft-takeover 待接管時閃爍、
//   Solo1-4 = 鯨/豚/龜/清垃圾 觸發時亮 0.3 秒。

let midiOut = null
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

      const route = (e) => {
        const [status, d1, d2] = e.data
        const type = status & 0xf0
        const st = useStore.getState()
        if (type === 0xb0) st.handleCC(d1, d2 / 127)
        else if (type === 0x90 && d2 > 0) st.handleNote(d1, d2 / 127)
        else if (type === 0xe0) st.handleCC(128, ((d2 << 7) | d1) / 16383) // Pitch Bend → 偽 CC128
        // Note Off / velocity=0 為事件結束，這裡忽略
      }

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

  return { connect }
}
