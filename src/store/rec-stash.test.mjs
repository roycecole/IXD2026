// 「使用者的錄製在資料播放 / 導覽之後還在」的回歸測試（真實 useStore）。執行：node --test src/store/rec-stash.test.mjs
// 以前沒有任何測試守這件事：把 playSeries 的暫存（stashedRec）或 restoreUserRec 拿掉，整套測試仍全綠，
// 演奏者錄好的演出卻會在閒置導覽跑完一輪後消失（播放鈕變灰）。
// 各檔案各自一個 process，useStore 單例的狀態不會跟別的測試檔互相影響。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { useStore } from './useStore.js'
import { activity, touch } from './activity.js'
import { createTourRunner, buildTour } from '../lib/tour.js'

const S = () => useStore.getState()
const spec = { kind: 'tide', name: 'T', label: 'L', unit: 'cm', date: '2026-01-01', step: 1.1, target: 'seaLevel', points: [{ h: 0, v: 1 }, { h: 1, v: 5 }, { h: 2, v: 3 }], stats: { min: 1, max: 5, mean: 3 }, extra: { lunar: '', lunarLabel: '', range: '', events: [] } }

function record() {                                     // 使用者錄一段：current 從 0 走到 19/20
  S().clearRec()
  S().startRecording()
  for (let i = 0; i < 20; i++) { S().advanceRec(0.1); S().input('current', i / 20) }
  S().stopRecording()
  return { count: S().rec.count, duration: S().rec.duration }
}
function replayed() {                                   // 播放使用者的錄製，回傳最後套用的 current（證明事件本身完好，不只是計數器）
  S().startPlayback(); S().tickPlayback(S().rec.duration + 1); return S().params.current
}

test('使用者的錄製在資料播放被中止（stopPlayback）後仍在，且內容可再播放', () => {
  const before = record(); assert.ok(before.count > 20)
  assert.equal(S().playSeries(spec), true)
  assert.notEqual(S().rec.count, before.count, '資料播放期間 buffer 是資料序列（測試前提）')
  S().stopPlayback()
  assert.equal(S().rec.count, before.count); assert.equal(S().rec.duration, before.duration); assert.equal(S().rec.mode, 'idle')
  S().setParam('current', 0.123)
  assert.ok(Math.abs(replayed() - 19 / 20) < 1e-9, '重播的是使用者當初錄的最後一個值')
})

test('使用者的錄製在資料播放自然播完後仍在', () => {
  const before = record()
  assert.equal(S().playSeries(spec), true)
  S().tickPlayback(spec.points.length * spec.step + 1)
  assert.equal(S().rec.mode, 'idle')
  assert.equal(S().rec.count, before.count); assert.equal(S().rec.duration, before.duration)
  S().setParam('current', 0.123)
  assert.ok(Math.abs(replayed() - 19 / 20) < 1e-9)
})

test('連續兩次資料播放（導覽轉站）之間錄製不會被吃掉', () => {
  const before = record()
  S().playSeries(spec); S().stopPlayback(); S().playSeries(spec); S().stopPlayback()
  assert.equal(S().rec.count, before.count); assert.equal(S().rec.duration, before.duration)
  S().setParam('current', 0.5)
  assert.ok(Math.abs(replayed() - 19 / 20) < 1e-9)
})

test('使用者在資料播放之後開始新的錄製：暫存被丟棄（新錄製才是使用者的），不會被舊的蓋回', () => {
  record()
  S().playSeries(spec); S().stopPlayback()
  S().startRecording(); S().advanceRec(0.5); S().input('current', 0.9); S().stopRecording()
  const mine = S().rec.count
  S().playSeries(spec); S().stopPlayback()
  assert.equal(S().rec.count, mine, '回到的是最新那一段')
})

test('整個資料導覽跑一輪（真的 createTourRunner，含轉站與結束）之後，使用者的錄製仍在', () => {
  const gov = JSON.parse(readFileSync(new URL('../../public/data/ocean.json', import.meta.url), 'utf8'))
  S().setGov(gov)
  const before = record()
  const clock = { t: 1e6 }
  const runner = createTourRunner({ store: useStore, getActivity: () => activity.last, touch, now: () => clock.t })
  const stops = buildTour(gov)
  assert.ok(stops.some((x) => x.kind === 'series'), '有資料播放的站（測試前提）')
  assert.equal(runner.start({ auto: false }), true)
  for (let i = 0; i < 20000 && runner.isRunning(); i++) {
    clock.t += 100
    if (S().rec.mode === 'playing') S().tickPlayback(0.1)
    runner.tick(clock.t)
  }
  assert.equal(runner.isRunning(), false, '手動導覽播完一輪自己結束')
  assert.equal(S().rec.mode, 'idle')
  assert.equal(S().rec.count, before.count, '錄製筆數不變'); assert.equal(S().rec.duration, before.duration, '錄製長度不變')
  S().setParam('current', 0.123)
  assert.ok(Math.abs(replayed() - 19 / 20) < 1e-9, '使用者的錄製仍可播放，內容完好')
})
