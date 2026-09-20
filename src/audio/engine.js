import { useStore } from '../store/useStore.js'
import { noteQueue } from './bus.js'
import { purifyMeta } from '../store/events.js'

let Tone = null // code-splitting：按下「聲音」才動態載入 Tone.js（不佔首載）

// 舒適背景音引擎（Tone.js）：與畫面共用同一套參數（store），
// 所以 MIDI 推桿/旋鈕、滑鼠、錄製回放都會同時「演奏」聲音。
// 映射：海水高度→根音頻率(Hz)、清澈(×垃圾)→濾波明亮度、洋流→浪聲起伏速度、
//       輝光→殘響空間感、垃圾→些微失諧、魚群×游速→點綴音密度、
//       鯨/豚/龜→叫聲、nanoPAD2 打擊墊→音階觸發(velocity=力度)。

export const audioState = { on: false, ready: false, rootHz: 0 }

// 開發輔助：主控台可用 window.__audio 取得節點與 Tone（供量測輸出電平等測試；正式建置會被移除）
if (import.meta.env.DEV) Object.defineProperty(window, '__audio', { get: () => ({ N, Tone }), configurable: true })

let N = null            // Tone 節點集合（使用者手勢後才建立，符合瀏覽器 autoplay 政策）
let muted = false
let sparkleAt = 0
let dripAcc = 0, lastUpdateT = 0 // 水滴聲以時間累積
const lastSpawns = { whale: 0, dolphin: 0, turtle: 0, purify: 0 }

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
  pluck.maxPolyphony = 64 // 淨化琶音一次 6 聲部、尾音長 1.8s；預設上限 32，連按約 5 次就會丟音
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

  // 水滴聲：溢流（水位 >97%）時稀疏的高音「滴」— 短促正弦、上揚音高、隨機左右聲道
  const dripPan = new Tone.Panner(0); dripPan.connect(reverb)
  const dripGain = new Tone.Gain(0.22); dripGain.connect(dripPan)
  const drip = new Tone.Synth({ oscillator: { type: 'sine' }, envelope: { attack: 0.002, decay: 0.11, sustain: 0, release: 0.06 } })
  drip.connect(dripGain)

  Tone.getDestination().volume.value = -8
  master.gain.rampTo(0.85, 2.5) // 緩緩淡入
  N = { master, reverb, filter, oscA, oscB, oscC, lfo, pluck, call, callPan, drip, dripPan }
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

// 生態敘事：聲音隨清澈轉調 — 清澈=大調五聲（明亮），混濁=小調五聲（轉暗）
const SCALE_CLEAR = [2, 2.25, 2.5, 3, 3.375, 4]
const SCALE_MURKY = [2, 2.4, 2.667, 3, 3.6, 4]
function scaleNow() {
  const p = useStore.getState().params
  const clar = (p.clarity ?? 0.6) * (1 - 0.7 * (p.trashCount ?? 0.25))
  return clar > 0.45 ? SCALE_CLEAR : SCALE_MURKY
}

let panTarget = 0
// 由場景每幀回報生物位置（-1 左 ~ +1 右），叫聲跟著左右聲道移動
export function setCreaturePan(x) { panTarget = Math.max(-1, Math.min(1, x)) }

// 點擊亮星爆發 → 輕柔鈴音（兩顆高音五聲音階，隨海水高度的根音走）
export function chime() {
  if (!N || muted) return
  const t = Tone.now()
  const root = 45 + ((useStore.getState().params.seaLevel ?? 0.5)) * 65
  const SC = scaleNow()
  const f = Math.min(2200, root * 4 * SC[(Math.random() * SC.length) | 0])
  N.pluck.triggerAttackRelease(f, 0.5, t + 0.01, 0.2)
  N.pluck.triggerAttackRelease(Math.min(2600, f * 1.5), 0.6, t + 0.09, 0.13)
}

// 淨化波 → 明亮大調五聲上行琶音（不論當下濁度都用大調：那正是「變乾淨」的聲音），頂端再拖一個高八度光亮尾音
let lastArpAt = -1
function purifyArp(v) {
  if (Tone.now() - lastArpAt < 0.25) return // 連按 / 多來源同時觸發：0.25 秒內只放一次，避免聲部堆疊爆音
  lastArpAt = Tone.now()
  const root = 45 + (useStore.getState().params.seaLevel ?? 0.5) * 65
  const t = Tone.now() + 0.02
  const idx = [0, 1, 2, 3, 5] // 2, 2.25, 2.5, 3, 4（根音上方一個八度內的五聲音階）
  idx.forEach((k, i) => {
    N.pluck.triggerAttackRelease(Math.min(2200, root * 2 * SCALE_CLEAR[k]), 0.45, t + i * 0.085, 0.11 + v * 0.12 + i * 0.03)
  })
  N.pluck.triggerAttackRelease(Math.min(2600, root * 4 * SCALE_CLEAR[5]), 0.9, t + idx.length * 0.085, 0.1 + v * 0.1)
}

// 溢流水滴：一顆短促的「噗」— 音高快速上揚 1.65 倍，隨機左右聲道
function dripOnce() {
  const t = Tone.now() + Math.random() * 0.09
  const f = 780 + Math.random() * 900
  N.dripPan.pan.value = (Math.random() * 2 - 1) * 0.7
  N.drip.triggerAttackRelease(f, 0.05, t, 0.35 + Math.random() * 0.4)
  N.drip.frequency.setValueAtTime(f, t)
  N.drip.frequency.exponentialRampToValueAtTime(f * 1.65, t + 0.055)
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
    const SC = scaleNow()
    const f = root * SC[(Math.random() * SC.length) | 0] * 2
    N.pluck.triggerAttackRelease(f, 0.35, t + 0.02, 0.12 + Math.random() * 0.18)
  }

  const sp = st.spawns                                    // 鯨 / 豚 / 龜 → 叫聲
  for (const k of ['whale', 'dolphin', 'turtle']) {
    if (sp[k] > lastSpawns[k]) { lastSpawns[k] = sp[k]; creatureCall(k) }
  }
  if (sp.purify > lastSpawns.purify) { lastSpawns.purify = sp.purify; purifyArp(purifyMeta.v) } // 淨化波 → 上行琶音

  // 溢流（與 OverflowFx 同門檻）→ 水滴聲。以「經過的時間」累積（每秒 0.4–3 滴），
  // 與 audioUpdate 被呼叫的頻率（60 / 120 / 144Hz 螢幕）無關
  const over = Math.max(0, ((p.seaLevel ?? 0) - 0.97) / 0.03)
  const dtA = lastUpdateT ? Math.min(0.5, t - lastUpdateT) : 0.1
  lastUpdateT = t
  if (over > 0) {
    dripAcc += dtA * (0.4 + over * 2.6)
    for (let k = 0; dripAcc >= 1 && k < 2; k++) { dripOnce(); dripAcc -= 1 }
    if (dripAcc > 2) dripAcc = 2
  } else dripAcc = 0

  while (noteQueue.length) {                              // nanoPAD2 → 音階觸發
    const { note, vel } = noteQueue.shift()
    const f = 220 * Math.pow(2, (note - 57) / 12)
    N.pluck.triggerAttackRelease(Math.max(60, Math.min(1800, f)), 0.4, Tone.now() + 0.02, 0.1 + vel * 0.5)
  }
}
