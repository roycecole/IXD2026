export function downloadBlob(blob, name) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 1000)
}

// 分享星球：擷取當下球體畫面 → 合成分享卡（標題 + 網址）→ 手機走 Web Share、桌機下載 PNG。
export async function shareSnapshot(opts = {}) {
  const canvas = document.querySelector('.canvas-wrap canvas')
  if (!canvas) return { ok: false, why: '找不到畫布' }
  const S = 1080
  const card = document.createElement('canvas')
  card.width = S; card.height = S
  const g = card.getContext('2d')
  g.fillStyle = '#05101c'; g.fillRect(0, 0, S, S)
  // 置中裁切（cover）
  const sw = canvas.width, sh = canvas.height
  const side = Math.min(sw, sh)
  g.drawImage(canvas, (sw - side) / 2, (sh - side) / 2, side, side, 0, 0, S, S)
  // 下緣漸層 + 文案
  const lines = (opts.lines || []).slice(0, 3)           // 目前海況背後的資料列（輸出顯示資料）
  const gh = 220 + lines.length * 42
  const grd = g.createLinearGradient(0, S - gh, 0, S)
  grd.addColorStop(0, 'rgba(5,16,28,0)'); grd.addColorStop(1, 'rgba(5,16,28,0.92)')
  g.fillStyle = grd; g.fillRect(0, S - gh, S, gh)
  g.fillStyle = 'rgba(160,220,255,0.9)'; g.font = '400 26px system-ui, -apple-system, "Noto Sans TC", sans-serif'
  lines.forEach((t, i) => { g.fillText(t.length > 40 ? t.slice(0, 39) + '…' : t, 48, S - 150 - (lines.length - 1 - i) * 40 - 8) })
  g.fillStyle = '#eaf6ff'; g.font = '600 44px system-ui, -apple-system, "Noto Sans TC", sans-serif'
  g.fillText('MidiSea 資料導演台', 48, S - 96)
  g.fillStyle = 'rgba(190,228,255,0.75)'; g.font = '400 30px system-ui, -apple-system, "Noto Sans TC", sans-serif'
  g.fillText('midisea.shyetech.com · 台灣政府開放資料的一片海', 48, S - 44)
  const blob = await new Promise((res) => card.toBlob(res, 'image/png'))
  if (!blob) return { ok: false, why: '截圖失敗' }
  const file = new File([blob], 'midisea-star.png', { type: 'image/png' })
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'MidiSea 資料導演台', text: '我在 MidiSea 演了一片海' })
      return { ok: true, how: 'share' }
    }
  } catch (e) { if (e && e.name === 'AbortError') return { ok: true, how: 'cancel' } }
  downloadBlob(blob, 'midisea-star.png')
  return { ok: true, how: 'download' }
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
