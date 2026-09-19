export function downloadBlob(blob, name) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 1000)
}

// 錄製 .canvas-wrap 內的 WebGL 畫布 seconds 秒 → 回呼進度與完成的 Blob。
// 優先 MP4（Chrome 新版 / Safari 支援），否則退回 WebM。
export function captureCanvas({ seconds = 10, onProgress, onDone } = {}) {
  const canvas = document.querySelector('.canvas-wrap canvas')
  if (!canvas || !canvas.captureStream) { onDone && onDone(null, null, '找不到畫布或瀏覽器不支援 captureStream'); return null }

  let stream
  try { stream = canvas.captureStream(30) } catch (e) { onDone && onDone(null, null, String(e)); return null }

  const candidates = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  const mime = candidates.find((t) => { try { return MediaRecorder.isTypeSupported(t) } catch (e) { return false } }) || ''

  let recorder
  try { recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 12000000 } : {}) }
  catch (e) { onDone && onDone(null, null, String(e)); return null }

  const chunks = []
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
  recorder.onstop = () => {
    const type = recorder.mimeType || mime || 'video/webm'
    const ext = type.includes('mp4') ? 'mp4' : 'webm'
    onDone && onDone(new Blob(chunks, { type }), ext, null)
  }

  recorder.start()
  const t0 = performance.now()
  const iv = setInterval(() => {
    const el = (performance.now() - t0) / 1000
    onProgress && onProgress(Math.min(seconds, el))
    if (el >= seconds) clearInterval(iv)
  }, 200)
  setTimeout(() => { try { if (recorder.state !== 'inactive') recorder.stop() } catch (e) {} clearInterval(iv) }, seconds * 1000)
  return recorder
}
