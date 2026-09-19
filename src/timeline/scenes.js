// 時間軸場景 keyframe：每個場景只 key 一部分參數，其餘保持手動 / MIDI 自由控制。
// 播放時在相鄰場景間線性內插，讓「資料 → 系統演化」自己走出劇情。

export const SCENES = [
  { t: 0,   label: '黎明 · 資料甦醒', params: { spin: 0.15, worldLight: 0.35, atmosphere: 0.3, pointDensity: 0.3, pointGlow: 0.4, stars: 0.8, zoom: 0.35 } },
  { t: 150, label: '正午 · 全球繁盛', params: { spin: 0.45, worldLight: 0.9,  atmosphere: 0.6, pointDensity: 0.85, pointGlow: 0.7, stars: 0.3, zoom: 0.5 } },
  { t: 300, label: '風暴 · 訊號躁動', params: { spin: 0.7,  worldLight: 0.6,  atmosphere: 0.8, pointDensity: 0.9,  pointGlow: 0.9, glitch: 0.4, heat: 0.8 } },
  { t: 450, label: '黃昏 · 水位漲落', params: { spin: 0.35, worldLight: 0.5,  atmosphere: 0.5, level: 0.9, inflow: 0.8, heat: 0.4, zoom: 0.65 } },
  { t: 600, label: '入夜 · 訊號收斂', params: { spin: 0.2,  worldLight: 0.3,  atmosphere: 0.35, pointGlow: 0.9, glitch: 0.0, stars: 0.9 } },
]

// 回傳 time 當下內插後的 keyed 參數（僅含被 key 的參數）
export function sceneAt(time) {
  const s = SCENES
  if (time <= s[0].t) return s[0].params
  if (time >= s[s.length - 1].t) return s[s.length - 1].params
  let a = s[0], b = s[1]
  for (let i = 0; i < s.length - 1; i++) {
    if (time >= s[i].t && time <= s[i + 1].t) { a = s[i]; b = s[i + 1]; break }
  }
  const f = (time - a.t) / (b.t - a.t)
  const out = {}
  const keys = new Set([...Object.keys(a.params), ...Object.keys(b.params)])
  keys.forEach((k) => {
    const av = a.params[k] ?? b.params[k]
    const bv = b.params[k] ?? a.params[k]
    out[k] = av + (bv - av) * f
  })
  return out
}

export function currentSceneIndex(time) {
  let idx = 0
  for (let i = 0; i < SCENES.length; i++) if (time >= SCENES[i].t) idx = i
  return idx
}
