import { T } from '../i18n/index.js'

// 場景預設：透過 TopBar「場景」鈕即時套用一組海洋狀態（applyScene）。
// 每個場景有自己的配色（hue：0 墨綠 ← 0.5 湛藍 → 1 紫粉），水色 / 輝光 / 漣漪跟著轉調。
export const SCENES = [
  { t: 0, label: T('清澈晨海'), params: { clarity: 0.9, trashCount: 0.05, jellyCount: 0.5, fishCount: 0.7, current: 0.3, seaLevel: 0.55, glow: 0.7, hue: 0.5 } },
  { t: 1, label: T('水母群舞'), params: { clarity: 0.75, jellyCount: 0.95, fishCount: 0.4, current: 0.5, glow: 0.9, hue: 0.85 } },
  { t: 2, label: T('魚汛'),     params: { clarity: 0.8, fishCount: 1.0, jellyCount: 0.3, current: 0.7, swimSpeed: 0.85, hue: 0.25 } },
  { t: 3, label: T('垃圾危機'), params: { clarity: 0.2, trashCount: 0.95, jellyCount: 0.15, fishCount: 0.15, glow: 0.3, hue: 0.05 } },
  { t: 4, label: T('復原'),     params: { clarity: 0.9, trashCount: 0.0, jellyCount: 0.7, fishCount: 0.85, glow: 0.85, hue: 0.62 } },
]

export function currentSceneIndex() { return 0 }
