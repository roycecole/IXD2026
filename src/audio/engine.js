import { useStore } from '../store/useStore.js'
import { noteQueue } from './bus.js'

let Tone = null // code-splitting：按下「聲音」才動態載入 Tone.js（不佔首載）

// 舒適背景音引擎（Tone.js）：與畫面共用同一套參數（store），
// 所以 MIDI 推桿/旋鈕、滑鼠、錄製回放都會同時「演奏」聲音。
// 映射：海水高度→根音頻率(Hz)、清澈(×垃圾)→濾波明亮度、洋流→浪聲起伏速度、
//       輝光→殘響空間感、垃圾→些微失諧、魚群×游速→點綴音密度、
//       鯨/豚/龜→叫聲、nanoPAD2 打擊墊→音階觸發(velocity=力度)。

export const audioState = { on: false, ready: false, rootHz: 0 }

let N = null            // Tone 節點集合（使用者手勢後才建立，符合瀏覽器 autoplay 政策）
let muted = false
let sparkleAt = 0
const lastSpawns = { whale: 0, dolphin: 0, turtle: 0 }

function build() {
  const master = new Tone.Gain(0)
  master.toDestination()
  const reverb = new Tone.Reverb({ decay: 6, wet: 0.4 })
  reverb.connect(master)
  const filter = new Tone.Filter(900, 'lowpass')
  filter.connect(reverb)

  // 海洋 pad：根音 + 純五度 + 八度（諧和 → 舒適）
  const padGain = new Tone.Gain(0.16); padGain.connect(filter)
  const gB = new Tone.Gain(0.5); gB.connect(padGain)
  const gC = new Tone.Gain(0.6); gC.connect(padGain)
  const oscA = new Tone.Oscillator(55, 'sine'); oscA.connect(padGain); oscA.start()
  const oscB = new Tone.Oscillator(82.5, 'triangle'); oscB.connect(gB); oscB.start()
  const oscC = new Tone.Oscillator(110, 'sine'); oscC.connect(gC); oscC.start()

  // 浪聲：粉紅噪音 + 慢 LFO 音量起伏（像海浪沖刷）
  const noiseGain = new Tone.Gain(0.05); noiseGain.connect(reverb)
  const noiseFilter = new Tone.Filter(420, 'lowpass'); noiseFilter.connect(noiseGain)
  const noise = new Tone.Noise('pink'); noise.connect(noiseFilter); noise.start()
  const lfo = new Tone.LFO(0.08, 0.015, 0.09); lfo.connect(noiseGain.gain); lfo.start()

  // 點綴音（五聲音階、稀疏、輕）+ nanoPAD2 觸發
  const pluckGain = new Tone.Gain(0.3); pluckGain.connect(reverb)
  const pluck = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sine' },
    envelope: { attack: 0.03, decay: 0.5, sustain: 0, release: 1.8 },
  })
  pluck.connect(pluckGain)

  // 生物叫聲（滑音單音）→ 立體聲相 Panner（跟隨生物游過的位置）
  const callGain = new Tone.Gain(0.35); callGain.connect(reverb)
  const callPan = new Tone.Panner(0); callPan.connect(callGain)
  const call = new Tone.Synth({
    portamento: 0.9,
    oscillator: { type: 'sine' },
    envelope: { attack: 0.25, decay: 0.4, sustain: 0.5, release: 1.6 },
  })
  call.connect(callPan)

  Tone.getDestination().volume.value = -8
  master.gain.rampTo(0.85, 2.5) // 緩緩淡入
  N = { master, reverb, filter, oscA, oscB, oscC, lfo, pluck, call, callPan }
}

export async function audioToggle() {
  if (!N) {
    if (!Tone) Tone = await import('tone')
    await Tone.start()
    build()
    Object.assign(lastSpawns, useStore.getState().spawns) // 避免補放過去的叫聲
    audioState.on = true; audioState.ready = true
    return true
  }
  muted = !muted
  audioState.on = !muted
  N.master.gain.rampTo(muted ? 0 : 0.85, 0.8)
  return audioState.on
}

const SCALE = [2, 2.25, 2.5, 3, 3.375, 4] // 大調五聲（相對根音的頻率比）

let panTarget = 0
// 由場景每幀回報生物位置（-1 左 ~ +1 右），叫聲跟著左右聲道移動
export function setCreaturePan(x) { panTarget = Math.max(-1, Math.min(1, x)) }

// 點擊亮星爆發 → 輕柔鈴音（兩顆高音五聲音階，隨海水高度的根音走）
export function chime() {
  if (!N || muted) return
  const t = Tone.now()
  const root = 45 + ((useStore.getState().params.seaLevel ?? 0.5)) * 65
  const f = Math.min(2200, root * 4 * SCALE[(Math.random() * SCALE.length) | 0])
  N.pluck.triggerAttackRelease(f, 0.5, t + 0.01, 0.2)
  N.pluck.triggerAttackRelease(Math.min(2600, f * 1.5), 0.6, t + 0.09, 0.13)
}

function creatureCall(type) {
  const t = Tone.now()
  if (type === 'whale') {
    N.call.triggerAttackRelease(85, 0.4, t, 0.8)
    N.call.triggerAttackRelease(46, 2.2, t + 0.35, 0.8)   // 深沉下滑
  } else if (type === 'dolphin') {
    N.call.triggerAttackRelease(680, 0.12, t, 0.5)
    N.call.triggerAttackRelease(920, 0.1, t + 0.16, 0.45) // 輕快啁啾
    N.call.triggerAttackRelease(780, 0.14, t + 0.3, 0.4)
  } else {
    N.call.triggerAttackRelease(130, 0.5, t, 0.5)
    N.call.triggerAttackRelease(98, 0.8, t + 0.4, 0.4)    // 低緩
  }
}

// 由 App 主迴圈以約 10Hz 呼叫
export function audioUpdate() {
  if (!N || muted) return
  const st = useStore.getState()
  const p = st.params

  const root = 45 + (p.seaLevel ?? 0.5) * 65              // 海水高度 → 根音 45–110 Hz
  audioState.rootHz = Math.round(root)
  N.oscA.frequency.rampTo(root, 0.5)
  N.oscB.frequency.rampTo(root * 1.5, 0.5)
  N.oscC.frequency.rampTo(root * 2, 0.5)

  const clar = (p.clarity ?? 0.6) * (1 - 0.7 * (p.trashCount ?? 0.25))
  N.filter.frequency.rampTo(240 + clar * 2600, 0.8)       // 清澈 → 明亮；混濁 → 悶
  const det = (p.trashCount ?? 0) * 16
  N.oscB.detune.rampTo(det, 1)                            // 垃圾 → 些微失諧（不安感）
  N.oscC.detune.rampTo(-det, 1)
  N.lfo.frequency.rampTo(0.05 + (p.current ?? 0.45) * 0.3, 1.2) // 洋流 → 浪的起伏速度
  N.reverb.wet.rampTo(0.28 + (p.glow ?? 0.6) * 0.42, 1.5)       // 輝光 → 空間感
  N.callPan.pan.rampTo(panTarget * 0.85, 0.12)                  // 生物聲相跟隨

  const t = Tone.now()                                    // 魚群×游速 → 點綴音密度（稀疏）
  const density = 0.35 + (p.fishCount ?? 0.5) * (0.4 + (p.swimSpeed ?? 0.5)) * 1.4
  if (t > sparkleAt) {
    sparkleAt = t + (3.2 / density) * (0.5 + Math.random())
    const f = root * SCALE[(Math.random() * SCALE.length) | 0] * 2
    N.pluck.triggerAttackRelease(f, 0.35, t + 0.02, 0.12 + Math.random() * 0.18)
  }

  const sp = st.spawns                                    // 鯨 / 豚 / 龜 → 叫聲
  for (const k of ['whale', 'dolphin', 'turtle']) {
    if (sp[k] > lastSpawns[k]) { lastSpawns[k] = sp[k]; creatureCall(k) }
  }

  while (noteQueue.length) {                              // nanoPAD2 → 音階觸發
    const { note, vel } = noteQueue.shift()
    const f = 220 * Math.pow(2, (note - 57) / 12)
    N.pluck.triggerAttackRelease(Math.max(60, Math.min(1800, f)), 0.4, Tone.now() + 0.02, 0.1 + vel * 0.5)
  }
}
