// 麥克風開關的重入測試。執行：node --test src/audio/mic.test.mjs
// 瀏覽器專屬情境：getUserMedia 要等權限提示 / 開機（≈0.1–2 秒）→ 使用者在這段時間再點一次。
// 這裡用假的 navigator.mediaDevices / AudioContext / setInterval（每個測試檔各自一個 process，覆寫全域不會外洩）。
import test from 'node:test'
import assert from 'node:assert/strict'

let opened = 0, gumMs = 30, gumFail = null, ctxFail = false
const liveTracks = new Set(), liveCtx = new Set(), liveIv = new Set()
const mkStream = () => { const tr = { stop() { liveTracks.delete(tr) } }; liveTracks.add(tr); return { getTracks: () => [tr] } }
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { mediaDevices: { getUserMedia: async () => { opened++; await new Promise((r) => setTimeout(r, gumMs)); if (gumFail) throw gumFail; return mkStream() } } },
})
globalThis.window = globalThis
globalThis.AudioContext = class {
  constructor() { if (ctxFail) throw new Error('AudioContext blocked'); liveCtx.add(this) }
  createMediaStreamSource() { return { connect() {} } }
  createAnalyser() { return { fftSize: 0, getByteTimeDomainData(d) { d.fill(128) } } }
  close() { liveCtx.delete(this); return Promise.resolve() }
}
const si = globalThis.setInterval, ci = globalThis.clearInterval
globalThis.setInterval = (...a) => { const h = si(...a); liveIv.add(h); return h }
globalThis.clearInterval = (h) => { liveIv.delete(h); return ci(h) }

const { micToggle, micState } = await import('./mic.js')
const reset = () => { opened = 0; gumFail = null; ctxFail = false }
const live = () => ({ tracks: liveTracks.size, ctx: liveCtx.size, iv: liveIv.size })

test('等 getUserMedia 期間再點一次：只開一條串流、兩次都回 true；再點關掉後不留任何孤兒（麥克風 / AudioContext / 計時器）', async () => {
  reset()
  const [a, b] = await Promise.all([micToggle(), micToggle()])   // 使用者在授權提示出現前後連點兩下
  assert.deepEqual([a, b], [true, true])
  assert.equal(opened, 1, '只呼叫一次 getUserMedia')
  assert.deepEqual(live(), { tracks: 1, ctx: 1, iv: 1 })
  assert.equal(micState.on, true)
  assert.equal(await micToggle(), false)
  assert.equal(micState.on, false)
  assert.deepEqual(live(), { tracks: 0, ctx: 0, iv: 0 }, '關閉後硬體指示燈要熄（沒有孤兒串流）')
})

test('關掉之後可以再開；被拒絕後也可以重試（starting 旗標不會卡住）', async () => {
  reset()
  gumFail = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
  assert.equal(await micToggle(), false)
  assert.equal(micState.on, false)
  assert.deepEqual(live(), { tracks: 0, ctx: 0, iv: 0 })
  gumFail = null
  assert.equal(await micToggle(), true)
  assert.equal(await micToggle(), false)
  assert.deepEqual(live(), { tracks: 0, ctx: 0, iv: 0 })
})

test('getUserMedia 成功但 AudioContext 建不起來：已開的麥克風要放掉，UI 狀態為關閉', async () => {
  reset()
  ctxFail = true
  assert.equal(await micToggle(), false)
  assert.equal(micState.on, false)
  assert.deepEqual(live(), { tracks: 0, ctx: 0, iv: 0 }, '不能留下「已授權、指示燈亮著、UI 卻是關閉」的串流')
  ctxFail = false
})
