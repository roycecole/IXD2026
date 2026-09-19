// 麥克風 = 風：對手機吹氣 → 浪變大。
// 只做即時 RMS 音量偵測（AnalyserNode），不錄音、不儲存、不上傳。
export const micState = { on: false, level: 0 }

let stream = null, ctx = null, analyser = null, timer = null, data = null

export async function micToggle() {
  if (micState.on) {
    if (timer) { clearInterval(timer); timer = null }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null }
    if (ctx) { try { ctx.close() } catch (e) {} ctx = null }
    micState.on = false; micState.level = 0
    return false
  }
  try {
    // 關閉降噪/回音消除：吹氣聲才不會被濾掉
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })
    ctx = new (window.AudioContext || window.webkitAudioContext)()
    const src = ctx.createMediaStreamSource(stream)
    analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    src.connect(analyser)
    data = new Uint8Array(analyser.fftSize)
    timer = setInterval(() => {
      analyser.getByteTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v }
      const rms = Math.sqrt(sum / data.length)
      const target = Math.max(0, Math.min(1, (rms - 0.06) * 3.2)) // 門檻略過環境音
      // 快起慢落：吹氣立刻起浪，停止後緩緩平息
      micState.level += (target - micState.level) * (target > micState.level ? 0.5 : 0.06)
    }, 50)
    micState.on = true
    return true
  } catch (e) {
    micState.on = false
    return false
  }
}
