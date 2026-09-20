// 麥克風 = 風：對手機吹氣 → 浪變大。
// 只做即時 RMS 音量偵測（AnalyserNode），不錄音、不儲存、不上傳。
export const micState = { on: false, level: 0, claps: 0 }

let stream = null, ctx = null, timer = null
let prevRaw = 0, lastClap = 0
let starting = null   // 進行中的「開啟」（等 getUserMedia 授權 / 開機期間）：再點一次不能再開第二條串流

function release() {
  if (timer) { clearInterval(timer); timer = null }
  if (stream) { try { stream.getTracks().forEach((t) => t.stop()) } catch (e) {} stream = null }
  if (ctx) { try { ctx.close() } catch (e) {} ctx = null }
}

export async function micToggle() {
  if (micState.on) {
    release()
    micState.on = false; micState.level = 0
    return false
  }
  // 使用者在權限提示 / getUserMedia 還沒回來前又點一次（畫面沒有回饋）：回傳同一個進行中的請求，
  // 否則第二條串流會蓋掉第一條的 stream / ctx / timer 變數 → 孤兒麥克風永遠關不掉（硬體指示燈一直亮，UI 卻顯示已關閉）。
  if (starting) return starting
  starting = start().finally(() => { starting = null })
  return starting
}

async function start() {
  let s = null, c = null
  try {
    // 關閉降噪/回音消除：吹氣聲才不會被濾掉
    s = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })
    c = new (window.AudioContext || window.webkitAudioContext)()
    const src = c.createMediaStreamSource(s)
    const analyser = c.createAnalyser()
    analyser.fftSize = 512
    src.connect(analyser)
    const data = new Uint8Array(analyser.fftSize)
    const iv = setInterval(() => {
      analyser.getByteTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v }
      const rms = Math.sqrt(sum / data.length)
      // 拍手 = 短促突波（與持續吹氣區分）：瞬間跳升且夠大
      let now2 = 0; try { now2 = performance.now() } catch (e) {}
      if (rms - prevRaw > 0.13 && rms > 0.2 && now2 - lastClap > 350) { lastClap = now2; micState.claps++ }
      prevRaw = rms
      const target = Math.max(0, Math.min(1, (rms - 0.06) * 3.2)) // 門檻略過環境音
      // 快起慢落：吹氣立刻起浪，停止後緩緩平息
      micState.level += (target - micState.level) * (target > micState.level ? 0.5 : 0.06)
    }, 50)
    stream = s; ctx = c; timer = iv   // 全部建好才登記到模組狀態：中途失敗不會留下半套
    micState.on = true
    return true
  } catch (e) {
    // getUserMedia 已成功但後面失敗（例如 AudioContext 建不起來）：要把已經開了的麥克風放掉
    try { s && s.getTracks().forEach((t) => t.stop()) } catch (e2) {}
    try { c && c.close() } catch (e2) {}
    micState.on = false
    return false
  }
}
