import test from 'node:test'
import assert from 'node:assert/strict'
import { nextDripTime, DRIP_GAP, DRIP_JITTER } from './timing.js'

// Tone 的 Source 時間軸單調遞增：模擬「同一輪連放兩滴」與「144Hz 螢幕上 audioUpdate 間隔只有 40ms」兩種會讓舊寫法倒退的情況
test('水滴排程：時間永遠單調遞增，且相鄰兩滴至少相隔 DRIP_GAP', () => {
  // 舊寫法（now + rand * 0.09）在這組輸入會倒退：第一滴 rand=0.9 → +0.081，第二滴 now 只前進 0.04、rand=0.1 → +0.009
  let last = 0
  const seq = [[10.0, 0.9], [10.04, 0.1], [10.04, 0.0], [10.08, 0.99], [10.12, 0.0]]
  const out = []
  for (const [now, rand] of seq) { last = nextDripTime(now, last, rand); out.push(last) }
  for (let i = 1; i < out.length; i++) assert.ok(out[i] >= out[i - 1] + DRIP_GAP - 1e-9, `第 ${i} 滴 ${out[i]} 太早（前一滴 ${out[i - 1]}）`)
})

test('水滴排程：時間充裕時仍是「現在 + 隨機抖動」，不會被無謂延後', () => {
  const t = nextDripTime(50, 10, 0.5)
  assert.ok(Math.abs(t - (50 + 0.5 * DRIP_JITTER)) < 1e-9)
})

test('水滴排程：隨機序列跑一萬次也不會倒退（模擬各種更新頻率）', () => {
  let last = 0, now = 5, seed = 12345
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296
  for (let i = 0; i < 10000; i++) {
    now += rnd() * 0.12 // 0~120ms 的更新間隔（含 144Hz 的 40ms）
    const t = nextDripTime(now, last, rnd())
    assert.ok(t >= last + DRIP_GAP - 1e-9)
    assert.ok(t >= now)
    last = t
  }
})
