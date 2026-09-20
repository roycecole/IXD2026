// AR 實景背景：網頁相機（getUserMedia）鋪在畫布後面，球體照常渲染（Canvas 透明）。
// 模糊 / 清澈只作用在背景 <video>（CSS filter，GPU 加速），不影響球體本身。
export const arState = { on: false, err: null, autoGlow: true, luma: 0 }  // 模糊 / 清澈已改為共用參數 bgBlur / bgClarity（一般畫面與 AR 同一組）

// 環境光感知：把 <video> 縮成 16×9 取平均亮度（0..1，Rec.709 權重）。太小不影響效能（約 144 像素）。
export function createLumaSampler() {
  const cv = document.createElement('canvas')
  cv.width = 16; cv.height = 9
  const g = cv.getContext('2d', { willReadFrequently: true })
  return (video) => {
    if (!video || video.readyState < 2 || !video.videoWidth) return null
    try {
      g.drawImage(video, 0, 0, 16, 9)
      const d = g.getImageData(0, 0, 16, 9).data
      let s = 0
      for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
      return s / (d.length / 4) / 255
    } catch (e) { return null }
  }
}

// 亮度 → 輝光：環境越亮，加法混合的線稿越需要更強輝光才看得見；環境暗則收斂（不刺眼）。
// 以「使用者實際看到的亮度」為準（含清澈滑桿的亮度濾鏡）。
export function glowForLuma(luma, clarity) {
  const seen = Math.max(0, Math.min(1, luma * (0.35 + clarity * 0.75)))
  return Math.max(0.3, Math.min(0.95, 0.32 + seen * 0.7))
}

let stream = null

export async function arStart(video, onEnd) {
  if (arState.on) return true
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
    // 相機被系統/其他分頁收走時自動退出 AR（否則場景卡在透明背景）
    stream.getVideoTracks().forEach((tr) => { tr.onended = () => { arStop(video); onEnd && onEnd() } })
    if (video) { video.srcObject = stream; await video.play().catch(() => {}) }
    arState.on = true; arState.err = null
    return true
  } catch (e) {
    arState.err = (e && (e.name === 'NotAllowedError' ? '未授權相機' : e.message)) || String(e)
    return false
  }
}

export function arStop(video) {
  try { stream && stream.getTracks().forEach((t) => t.stop()) } catch (e) {}
  stream = null
  if (video) video.srcObject = null
  arState.on = false
}

// 背景濾鏡：模糊＝高斯模糊 0..22px（bgBlur 0..1）；清澈＝亮度+飽和（bgClarity：低=朦朧暗、高=清亮）。只作用在相機畫面。
export function arFilter(blur01 = 0.27, clarity01 = 0.85) {
  const px = Math.max(0, Math.min(1, blur01)) * 22
  const c = Math.max(0, Math.min(1, clarity01))
  return `blur(${px.toFixed(1)}px) brightness(${(0.35 + c * 0.75).toFixed(2)}) saturate(${(0.5 + c * 0.7).toFixed(2)})`
}
