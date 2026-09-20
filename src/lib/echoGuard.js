// 回音防護：資料導覽的旁白（narration.js）用喇叭念字幕，語音指令（voice.js）用麥克風收音——
// 字幕裡的「鯨魚」「魚群」「海龜」等詞會被麥克風收進去、被當成使用者下的指令。
// 旁白進行中，以及結束後短短一段時間（喇叭餘音 / 房間殘響），都忽略辨識到的指令。
//   createEchoGuard({ narrator, now, tailMs }) → { shouldIgnore(), dispose() }
// narrator 只需要 speaking() 與 onChange(cb) → off（見 narration.js）；now 可注入（測試用）。
export const ECHO_TAIL_MS = 700

const defaultNow = () => { try { return performance.now() } catch (e) { return Date.now() } }

export function createEchoGuard({ narrator, now = defaultNow, tailMs = ECHO_TAIL_MS } = {}) {
  let quietUntil = -Infinity
  let off = null
  try {
    if (narrator && typeof narrator.onChange === 'function') {
      off = narrator.onChange((speaking) => { if (!speaking) quietUntil = now() + tailMs })   // 念完的那一刻起再靜音一小段
    }
  } catch (e) { off = null }
  return {
    shouldIgnore() {
      try { if (narrator && narrator.speaking()) return true } catch (e) { /* 旁白壞了不影響語音指令 */ }
      return now() < quietUntil
    },
    dispose() { if (off) { try { off() } catch (e) { /* 無視 */ } off = null } },
  }
}
