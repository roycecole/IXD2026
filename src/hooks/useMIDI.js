import { useStore } from '../store/useStore.js'

// 回傳 { connect }：需由使用者手勢（按鈕）觸發，瀏覽器才會授權 Web MIDI。
export function useMIDI() {
  const connect = async () => {
    const setMidi = useStore.getState().setMidi
    if (!navigator.requestMIDIAccess) {
      setMidi({ connected: false, error: '此瀏覽器不支援 Web MIDI（請用桌面版 Chrome / Edge）' })
      return
    }
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false })

      const route = (e, name) => {
        const [status, d1, d2] = e.data
        const type = status & 0xf0
        const st = useStore.getState()
        if (type === 0xb0) st.handleCC(d1, d2 / 127)
        else if (type === 0x90 && d2 > 0) st.handleNote(d1, d2 / 127)
        // Note Off / velocity=0 為事件結束，這裡忽略
      }

      const bind = () => {
        const names = []
        for (const input of access.inputs.values()) {
          names.push(input.name || 'unknown')
          input.onmidimessage = (e) => route(e, input.name || 'unknown')
        }
        useStore.getState().setMidi({ connected: true, inputs: names, error: null })
      }

      bind()
      access.onstatechange = bind          // 熱插拔自動重綁
    } catch (err) {
      setMidi({ connected: false, error: String(err && err.message ? err.message : err) })
    }
  }

  return { connect }
}
