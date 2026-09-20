// 手機遙控訊息派送（lib/remoteDispatch.js）的測試。執行：node --test src/lib/remoteDispatch.test.mjs
// 涵蓋：遙控「有人在」時間戳 remoteActivity（只有有效的操作訊息才更新；連線 / 心跳 / 狀態同步 / 導覽員協定訊息不更新；與 activity 同一個時鐘）、
//   p / a / n 三種訊息的驗證與夾範圍（NaN / Infinity 不放行）、動作白名單、洋流擁有權（被擋掉的訊息不算活動）、
//   touch 在動作「之前」發生（導覽才會先中止還原）、壞訊息與 store 丟例外都不會讓派送丟出例外。
// 用真的 useStore（跟 tourCore.test.mjs 一樣）；需要攔截的動作以 useStore.setState 換成 spy，測完還原。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { useStore } from '../store/useStore.js'
import { activity, onActivity } from '../store/activity.js'
import { dispatch, remoteActivity, noteRemoteActivity } from './remoteDispatch.js'

const S = () => useStore.getState()
const INITIAL_AT = remoteActivity.at                          // 在任何 dispatch 之前讀：測「初值是很久以前」

// 暫時把 store 的某些動作換成 spy；回傳還原函式
function spyOn(names, calls) {
  const orig = {}
  const patch = {}
  for (const n of names) { orig[n] = S()[n]; patch[n] = (...a) => { calls.push([n, ...a]) } }
  useStore.setState(patch)
  return () => useStore.setState(orig)
}

test('remoteActivity：初值是「很久以前」（剛載入的頁面不會被當成有人在）；介面是 { at }；只有 noteRemoteActivity 之類的有效操作會更新', () => {
  assert.ok(INITIAL_AT < -1e6)
  assert.equal(typeof remoteActivity.at, 'number')
  assert.deepEqual(Object.keys(remoteActivity), ['at'])
})

test('noteRemoteActivity：寫入 performance.now()（與 activity.last 同一個時鐘），連續呼叫單調不減', () => {
  const t0 = performance.now()
  noteRemoteActivity()
  const a = remoteActivity.at
  assert.ok(a >= t0 && a <= performance.now())
  noteRemoteActivity()
  assert.ok(remoteActivity.at >= a)
  assert.ok(Math.abs(remoteActivity.at - performance.now()) < 1000)
})

test('p（參數滑桿）：經 input() 進 store、夾在 0..1、更新 remoteActivity 與 activity.last', () => {
  remoteActivity.at = -1e9
  const before = activity.last
  dispatch({ t: 'p', pid: 'glow', v: 0.37 })
  assert.ok(Math.abs(S().params.glow - 0.37) < 1e-9)
  assert.ok(remoteActivity.at > 0)
  assert.ok(activity.last >= before)
  dispatch({ t: 'p', pid: 'glow', v: 5 })
  assert.equal(S().params.glow, 1)
  dispatch({ t: 'p', pid: 'glow', v: -3 })
  assert.equal(S().params.glow, 0)
})

test('p 無效（未知參數 / 非數字 / NaN / Infinity / 原型鏈名稱）：不動 store、不更新 remoteActivity', () => {
  useStore.setState({ params: { ...S().params, glow: 0.5 } })
  for (const m of [
    { t: 'p', pid: 'notAParam', v: 0.5 }, { t: 'p', pid: 'glow', v: '0.5' }, { t: 'p', pid: 'glow' }, { t: 'p', v: 0.5 },
    { t: 'p', pid: 'glow', v: NaN }, { t: 'p', pid: 'glow', v: Infinity }, { t: 'p', pid: 'glow', v: -Infinity },
    { t: 'p', pid: '__proto__', v: 0.5 }, { t: 'p', pid: 'constructor', v: 0.5 }, { t: 'p', pid: 'toString', v: 0.5 },
  ]) {
    remoteActivity.at = -1e9
    dispatch(m)
    assert.equal(remoteActivity.at, -1e9, JSON.stringify(m))
    assert.equal(S().params.glow, 0.5, JSON.stringify(m))
  }
  assert.ok(Object.values(S().params).every((v) => Number.isFinite(v)), '沒有任何參數被寫成 NaN')
})

test('a（動作）：白名單內才會呼叫、更新 remoteActivity；touch() 在動作「之前」發生（導覽要先中止並還原）', () => {
  const calls = []
  const restore = spyOn(['spawnWhale', 'spawnDolphin', 'spawnTurtle', 'clearTrash', 'transportPlay', 'transportStop', 'transportRecord'], calls)
  const order = []
  const off = onActivity(() => order.push('touch'))
  try {
    for (const a of ['spawnWhale', 'spawnDolphin', 'spawnTurtle', 'clearTrash', 'transportPlay', 'transportStop', 'transportRecord']) {
      remoteActivity.at = -1e9
      order.length = 0
      calls.length = 0
      useStore.setState({ [a]: (...x) => { order.push('action'); calls.push([a, ...x]) } })
      dispatch({ t: 'a', a })
      assert.deepEqual(calls, [[a]], a)
      assert.deepEqual(order, ['touch', 'action'], `${a}：先 touch 再動作`)
      assert.ok(remoteActivity.at > 0, a)
    }
  } finally { off(); restore() }
})

test('a 無效（不在白名單：其他 store 動作 / 原型鏈名稱 / 非字串）：不呼叫、不更新 remoteActivity、不觸發活動掛鉤', () => {
  const calls = []
  const restore = spyOn(['setParam', 'pushLog', 'stopPlayback', 'clearRec'], calls)
  let hooks = 0
  const off = onActivity(() => { hooks++ })
  try {
    for (const a of ['setParam', 'pushLog', 'stopPlayback', 'clearRec', 'constructor', '__proto__', 'toString', '', 'SPAWNWHALE', null, undefined, 5, ['spawnWhale'], {}]) {
      remoteActivity.at = -1e9
      dispatch({ t: 'a', a })
      assert.equal(remoteActivity.at, -1e9, String(a))
    }
    assert.deepEqual(calls, [])
    assert.equal(hooks, 0)
  } finally { off(); restore() }
})

test('n（打擊墊）：handleNote(note 取整, vel 夾在 0.05..1、預設 0.8)；更新 remoteActivity；note 不是數字 → 忽略', () => {
  const calls = []
  const restore = spyOn(['handleNote'], calls)
  try {
    remoteActivity.at = -1e9
    dispatch({ t: 'n', note: 20.9, vel: 0.5 })
    assert.deepEqual(calls.at(-1), ['handleNote', 20, 0.5])
    assert.ok(remoteActivity.at > 0)
    dispatch({ t: 'n', note: 21, vel: 9 }); assert.deepEqual(calls.at(-1), ['handleNote', 21, 1])
    dispatch({ t: 'n', note: 22, vel: 0 }); assert.deepEqual(calls.at(-1), ['handleNote', 22, 0.8], 'vel 0 / 缺少 → 預設 0.8')
    dispatch({ t: 'n', note: 23 }); assert.deepEqual(calls.at(-1), ['handleNote', 23, 0.8])
    dispatch({ t: 'n', note: 24, vel: 0.001 }); assert.deepEqual(calls.at(-1), ['handleNote', 24, 0.05])
    dispatch({ t: 'n', note: 25, vel: 'x' }); assert.deepEqual(calls.at(-1), ['handleNote', 25, 0.8])
    const n = calls.length
    remoteActivity.at = -1e9
    for (const m of [{ t: 'n' }, { t: 'n', note: '20' }, { t: 'n', note: null }, { t: 'n', note: {} }]) dispatch(m)
    assert.equal(calls.length, n)
    assert.equal(remoteActivity.at, -1e9)
  } finally { restore() }
})

test('連線 / 心跳 / 狀態同步 / 導覽員協定訊息（hello、g、guide、tour、sync、role）：不更新 remoteActivity、不動 store、不觸發活動掛鉤、不丟例外', () => {
  const paramsBefore = S().params
  let hooks = 0
  const off = onActivity(() => { hooks++ })
  try {
    remoteActivity.at = -1e9
    for (const m of [
      { t: 'hello', guide: 'k3x9a1b7zq' }, { t: 'g', c: 'next' }, { t: 'g', c: 'start' }, { t: 'guide', ok: true }, { t: 'tour', running: true },
      { t: 'sync', params: { glow: 1 } }, { t: 'role', id: 'free', pids: [] }, { t: 'ping' }, { t: 'hb' },
    ]) assert.doesNotThrow(() => dispatch(m, 'peer-1'))
    assert.equal(remoteActivity.at, -1e9)
    assert.equal(hooks, 0)
    assert.equal(S().params, paramsBefore)
  } finally { off() }
})

test('壞訊息（null / 字串 / 數字 / 陣列 / 缺 t / 未知 t）：靜默忽略，不丟例外、不更新 remoteActivity', () => {
  remoteActivity.at = -1e9
  for (const m of [null, undefined, 0, 1, '', 'p', true, [], [{ t: 'p' }], {}, { t: null }, { t: 5 }, { t: 'zzz' }, () => {}, Symbol('x')]) assert.doesNotThrow(() => dispatch(m), String(typeof m))
  assert.equal(remoteActivity.at, -1e9)
  const evil = { t: 'p', get pid() { throw new Error('getter boom') }, v: 0.5 }
  assert.doesNotThrow(() => dispatch(evil))
})

test('store 的動作丟例外：dispatch 自己吞掉（遙控訊息不能讓主迴圈停擺）', () => {
  const orig = { clearTrash: S().clearTrash, handleNote: S().handleNote, input: S().input }
  useStore.setState({ clearTrash: () => { throw new Error('boom a') }, handleNote: () => { throw new Error('boom n') }, input: () => { throw new Error('boom p') } })
  try {
    assert.doesNotThrow(() => dispatch({ t: 'a', a: 'clearTrash' }))
    assert.doesNotThrow(() => dispatch({ t: 'n', note: 20, vel: 0.5 }))
    assert.doesNotThrow(() => dispatch({ t: 'p', pid: 'glow', v: 0.5 }))
  } finally { useStore.setState(orig) }
})

test('洋流擁有權：最近有動的那支手機擁有 flowX / flowY，其他手機 1.5 秒內的洋流訊息被擋掉——而且被擋掉的不算「有人在」；擁有者靜止 1.5 秒後可換手', () => {
  const realNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  const calls = []
  const restore = spyOn(['input'], calls)
  try {
    remoteActivity.at = -1e9
    dispatch({ t: 'p', pid: 'flowX', v: 0.2 }, 'A')
    assert.deepEqual(calls.at(-1), ['input', 'flowX', 0.2])
    assert.ok(remoteActivity.at > 0)
    remoteActivity.at = -1e9
    now += 500
    dispatch({ t: 'p', pid: 'flowY', v: 0.9 }, 'B')                       // A 還擁有：B 被擋
    assert.equal(calls.length, 1)
    assert.equal(remoteActivity.at, -1e9, '被擋掉的訊息不算活動')
    dispatch({ t: 'p', pid: 'flowX', v: 0.4 }, 'A')                        // 擁有者自己照常
    assert.deepEqual(calls.at(-1), ['input', 'flowX', 0.4])
    now += 1499
    dispatch({ t: 'p', pid: 'flowX', v: 0.6 }, 'B')                        // 距 A 最後一次 1499ms：仍擋
    assert.equal(calls.length, 2)
    now += 1
    dispatch({ t: 'p', pid: 'flowX', v: 0.6 }, 'B')                        // 滿 1500ms：換手
    assert.deepEqual(calls.at(-1), ['input', 'flowX', 0.6])
    dispatch({ t: 'p', pid: 'glow', v: 0.5 }, 'A')                         // 非洋流參數不受擁有權影響
    assert.deepEqual(calls.at(-1), ['input', 'glow', 0.5])
    dispatch({ t: 'p', pid: 'flowX', v: 0.1 })                             // 沒有來源識別 → 不做擁有權判斷
    assert.deepEqual(calls.at(-1), ['input', 'flowX', 0.1])
  } finally { Date.now = realNow; restore() }
})

test('接線：remoteDispatch 不 import PeerJS / import.meta.env（Node 可測）；p / a / n 三個分支都在動作前呼叫 noteRemoteActivity', () => {
  const code = readFileSync(new URL('./remoteDispatch.js', import.meta.url), 'utf8')
  const noComments = code.replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(noComments, /from 'peerjs'|import\.meta\.env/)
  assert.equal((noComments.match(/noteRemoteActivity\(\)/g) || []).length, 4, '1 個定義（export function noteRemoteActivity()）+ 3 個分支呼叫')
  assert.match(code, /export const remoteActivity = \{ at: -1e9 \}/)
})
