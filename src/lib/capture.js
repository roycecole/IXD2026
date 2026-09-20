import { arFilter } from './ar.js'

export function downloadBlob(blob, name) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 1000)
}

// 「實景」時 WebGL 畫布的背景是透明的（真實背景是它後面的 <video>，以 CSS 鋪滿 + 濾鏡）——直接輸出畫布只會有球體、沒有真實背景。
// 這裡把（相機畫面 cover 對齊 + 與畫面上一致的背景模糊 / 清澈濾鏡）與 WebGL 畫布合成到 2D canvas，分享圖與錄影共用。
// ar：{ video, blur01, clarity01 } 或 null（非實景 → 只畫畫布）。srcRect：要取的畫布區域（畫布像素）；dw/dh：目標尺寸。
export function paintScene(g, canvas, ar, srcRect, dw, dh) {
  const cw = canvas.width, ch = canvas.height
  const r = srcRect || { x: 0, y: 0, w: cw, h: ch }
  const v = ar && ar.video
  if (v && v.readyState >= 2 && v.videoWidth > 0) {
    const s = Math.max(cw / v.videoWidth, ch / v.videoHeight)                  // object-fit: cover：影片鋪滿整張畫布
    const ox = (cw - v.videoWidth * s) / 2, oy = (ch - v.videoHeight * s) / 2  // 影片左上角在畫布座標的位置
    const dpr = cw / Math.max(1, canvas.clientWidth || cw)                     // CSS blur 以 CSS 像素計 → 換成目標像素
    const kx = dw / r.w, ky = dh / r.h                                         // 畫布像素 → 目標像素
    const k = kx * dpr
    // 模糊只在「畫面上看得到的影片範圍（畫布框）」邊緣淡出。只取分享圖那塊正方形來模糊，邊緣會憑空變暗，
    // 所以把來源區域往外多取一圈模糊半徑（不超出畫布框），畫完再被目標畫布裁掉。
    const m = Math.ceil(Math.max(0, Math.min(1, ar.blur01)) * 22 * k * 3 / kx)
    const x0 = Math.max(0, r.x - m), y0 = Math.max(0, r.y - m)
    const x1 = Math.min(cw, r.x + r.w + m), y1 = Math.min(ch, r.y + r.h + m)
    drawFilteredVideo(g, v,
      { sx: (x0 - ox) / s, sy: (y0 - oy) / s, sw: (x1 - x0) / s, sh: (y1 - y0) / s },
      { dx: (x0 - r.x) * kx, dy: (y0 - r.y) * ky, dw: (x1 - x0) * kx, dh: (y1 - y0) * ky },
      dw, dh, ar.blur01, ar.clarity01, k)
  }
  g.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, dw, dh)
}

function drawFilteredVideo(g, v, a, b, dw, dh, blur01, clarity01, k) {
  if ('filter' in g) {                                                         // Chrome / Edge / Firefox
    g.save(); g.filter = arFilter(blur01, clarity01, k)
    g.drawImage(v, a.sx, a.sy, a.sw, a.sh, b.dx, b.dy, b.dw, b.dh)
    g.restore(); return
  }
  // 不支援 ctx.filter（舊版 Safari）：縮小再放大近似模糊，亮度以黑色疊層近似（飽和度略過）
  const blurPx = Math.max(0, Math.min(1, blur01)) * 22 * k
  const f = Math.max(1, Math.min(32, Math.round(blurPx / 1.6)))
  const t = document.createElement('canvas')
  t.width = Math.max(1, Math.round(b.dw / f)); t.height = Math.max(1, Math.round(b.dh / f))
  const tg = t.getContext('2d'); tg.imageSmoothingQuality = 'high'
  tg.drawImage(v, a.sx, a.sy, a.sw, a.sh, 0, 0, t.width, t.height)
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'
  g.drawImage(t, 0, 0, t.width, t.height, b.dx, b.dy, b.dw, b.dh)
  const bright = 0.35 + Math.max(0, Math.min(1, clarity01)) * 0.75
  if (bright < 1) { g.fillStyle = `rgba(0,0,0,${(1 - bright).toFixed(3)})`; g.fillRect(0, 0, dw, dh) }
}

// 分享卡（1080×1080）：場景（實景時含真實背景）+ 下緣資料列 + 標題 / 網址。回傳 2D canvas，方便測試。
export function renderShareCard(opts = {}) {
  const canvas = document.querySelector('.canvas-wrap canvas')
  if (!canvas) return null
  const S = 1080
  const card = document.createElement('canvas')
  card.width = S; card.height = S
  const g = card.getContext('2d')
  g.fillStyle = '#05101c'; g.fillRect(0, 0, S, S)
  // 置中裁切（cover）：取畫布中央的正方形
  const sw = canvas.width, sh = canvas.height
  const side = Math.min(sw, sh)
  paintScene(g, canvas, opts.ar || null, { x: (sw - side) / 2, y: (sh - side) / 2, w: side, h: side }, S, S)
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
  return card
}

// 分享星球：擷取當下畫面（實景時連真實背景一起）→ 合成分享卡 → 手機走 Web Share、桌機下載 PNG。
export async function shareSnapshot(opts = {}) {
  const card = renderShareCard(opts)
  if (!card) return { ok: false, why: '找不到畫布' }
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
  return { ok: true, how: 'download', ar: !!opts.ar }
}

// 錄製 .canvas-wrap 內的 WebGL 畫布 seconds 秒 → 回呼進度與完成的 Blob。
// 優先 MP4（Chrome 新版 / Safari 支援），否則退回 WebM。
export function captureCanvas({ seconds = 10, onProgress, onDone, getAr } = {}) {
  const canvas = document.querySelector('.canvas-wrap canvas')
  if (!canvas || !canvas.captureStream) { onDone && onDone(null, null, '找不到畫布或瀏覽器不支援 captureStream'); return null }

  // 實景時：WebGL 畫布背景是透明的 → 每幀把（相機畫面 + 濾鏡 + 畫布）合成到離屏 2D canvas，錄這張合成畫布
  let source = canvas, comp = null, rafId = 0
  if (getAr && getAr()) {
    // 手機上每幀做全解析度的模糊 + 合成很吃力：長邊限制在 1280、合成頻率壓在約 30fps（錄影本身就是 30fps，相機也不會更快）
    const sc = Math.min(1, 1280 / Math.max(canvas.width, canvas.height))
    comp = document.createElement('canvas'); comp.width = Math.max(2, Math.round(canvas.width * sc)); comp.height = Math.max(2, Math.round(canvas.height * sc))
    const cg = comp.getContext('2d')
    let lastT = -1e9
    const draw = (t = 0) => {
      if (t - lastT >= 30) {
        lastT = t
        cg.fillStyle = '#05101c'; cg.fillRect(0, 0, comp.width, comp.height)
        paintScene(cg, canvas, getAr(), null, comp.width, comp.height)
      }
      rafId = requestAnimationFrame(draw)
    }
    draw()
    source = comp
  }
  let stream
  try { stream = source.captureStream(30) } catch (e) { cancelAnimationFrame(rafId); onDone && onDone(null, null, String(e)); return null }

  const candidates = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  const mime = candidates.find((t) => { try { return MediaRecorder.isTypeSupported(t) } catch (e) { return false } }) || ''

  let recorder
  try { recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 12000000 } : {}) }
  catch (e) { cancelAnimationFrame(rafId); onDone && onDone(null, null, String(e)); return null }

  const chunks = []
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
  recorder.onstop = () => {
    cancelAnimationFrame(rafId)
    const type = recorder.mimeType || mime || 'video/webm'
    const ext = type.includes('mp4') ? 'mp4' : 'webm'
    onDone && onDone(new Blob(chunks, { type }), ext, null)
  }

  try { recorder.start() } catch (e) { cancelAnimationFrame(rafId); onDone && onDone(null, null, String(e)); return null }
  const t0 = performance.now()
  const iv = setInterval(() => {
    const el = (performance.now() - t0) / 1000
    onProgress && onProgress(Math.min(seconds, el))
    if (el >= seconds) clearInterval(iv)
  }, 200)
  setTimeout(() => { try { if (recorder.state !== 'inactive') recorder.stop() } catch (e) {} clearInterval(iv) }, seconds * 1000)
  return recorder
}
