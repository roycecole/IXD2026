// AR 實景相機開關的重入 / 取消測試。執行：node --test src/lib/ar.test.mjs
// 瀏覽器專屬：getUserMedia + video.play 需要 0.5–2 秒，期間使用者再點、或按了關閉。
import test from 'node:test'
import assert from 'node:assert/strict'

let opened = 0, gumMs = 30, gumFail = null
const liveTracks = new Set()
const mkStream = () => { const tr = { onended: null, stop() { liveTracks.delete(tr) } }; liveTracks.add(tr); return { getTracks: () => [tr], getVideoTracks: () => [tr] } }
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { mediaDevices: { getUserMedia: async () => { opened++; await new Promise((r) => setTimeout(r, gumMs)); if (gumFail) throw gumFail; return mkStream() } } },
})
const { arStart, arStop, arState } = await import('./ar.js')
const mkVideo = (playMs = 0) => ({ srcObject: null, play: () => new Promise((r) => setTimeout(r, playMs)) })
const reset = () => { opened = 0; gumFail = null }

test('等相機期間再呼叫 arStart：只開一條串流、同一個結果；arStop 後沒有孤兒相機', async () => {
  reset()
  const video = mkVideo()
  const [a, b] = await Promise.all([arStart(video, () => {}), arStart(video, () => {})])
  assert.deepEqual([a, b], [true, true])
  assert.equal(opened, 1)
  assert.equal(liveTracks.size, 1); assert.equal(arState.on, true)
  assert.equal(await arStart(video, () => {}), true, '已開啟：直接回 true，不再開串流')
  assert.equal(opened, 1)
  arStop(video)
  assert.equal(arState.on, false); assert.equal(liveTracks.size, 0, '相機指示燈要熄')
})

test('等相機期間被 arStop 取消：晚到的串流立刻放掉，不會在「已關閉」之後又亮起', async () => {
  reset()
  const video = mkVideo()
  const p = arStart(video, () => {})
  arStop(video)                              // 使用者在授權完成前按了關閉
  assert.equal(await p, false)
  assert.equal(arState.on, false); assert.equal(liveTracks.size, 0)
  // video.play 期間取消
  const v2 = mkVideo(40)
  const p2 = arStart(v2, () => {})
  await new Promise((r) => setTimeout(r, 50))   // 串流已到、卡在 play()
  arStop(v2)
  assert.equal(await p2, false)
  assert.equal(arState.on, false); assert.equal(liveTracks.size, 0)
})

test('被拒絕 / 失敗：回 false 並留下原因；之後可以重試（starting 不會卡住）', async () => {
  reset()
  gumFail = Object.assign(new Error('x'), { name: 'NotAllowedError' })
  assert.equal(await arStart(mkVideo(), () => {}), false)
  assert.ok(arState.err)
  assert.equal(liveTracks.size, 0)
  gumFail = null
  assert.equal(await arStart(mkVideo(), () => {}), true)
  arStop(null)
  assert.equal(liveTracks.size, 0)
})

test('相機被系統收走（track.onended）→ 自動退出並通知呼叫端', async () => {
  reset()
  let ended = 0
  assert.equal(await arStart(mkVideo(), () => { ended++ }), true)
  const tr = [...liveTracks][0]
  tr.onended()
  assert.equal(ended, 1); assert.equal(arState.on, false); assert.equal(liveTracks.size, 0)
})
