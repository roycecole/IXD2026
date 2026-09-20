// AR 實景背景：網頁相機（getUserMedia）鋪在畫布後面，球體照常渲染（Canvas 透明）。
// 模糊 / 清澈只作用在背景 <video>（CSS filter，GPU 加速），不影響球體本身。
export const arState = { on: false, blur: 6, clarity: 0.85, err: null }

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

// 背景濾鏡：模糊=高斯模糊 px；清澈=亮度+飽和（低=朦朧暗、高=清亮）
export function arFilter() {
  return `blur(${arState.blur}px) brightness(${(0.35 + arState.clarity * 0.75).toFixed(2)}) saturate(${(0.5 + arState.clarity * 0.7).toFixed(2)})`
}
