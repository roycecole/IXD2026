// 資料導覽 × 真實輸入路徑的整合測試。執行：node --test src/services/tourCore.test.mjs
// 以前的導覽測試（src/lib/tour.test.mjs）全用假 store，只把 activity 時間戳往前撥；這裡用「真的」useStore / activity / createTourRunner，
// 驗證各種輸入來源（MIDI / 語音 / 手機遙控 / 手把式 input / 滾輪）在導覽進行中：
//   先中止並還原、再落下使用者的動作（以前是動作先寫進去，100ms 後被還原蓋掉）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { useStore } from '../store/useStore.js'
import { activity, touch, onActivity } from '../store/activity.js'
import { createTourRunner, buildTour, useTourStore, TOUR_MS } from '../lib/tour.js'
import { runCommand, CALM_TARGETS, CALM_STEP } from '../lib/voiceCommands.js'
import { dispatch } from '../lib/remoteDispatch.js'
import { attachHapticsSource } from '../lib/haptics.js'
import { inspectStore } from '../lib/inspect.js'
import { attachTourGuards, attachRunningGuards, tourIdleTick, tourRunner, KEEP_SELECTOR } from './tourCore.js'

const gov = JSON.parse(readFileSync(new URL('../../public/data/ocean.json', import.meta.url), 'utf8'))
const S = () => useStore.getState()

// ---- 場景準備：使用者原本的海 + 一個用假時鐘驅動的導覽器（其餘全是真的）----
const USER = { current: 0.8, swimSpeed: 0.8, trashCount: 0.6, spin: 0.3, zoom: 0.5, seaLevel: 0.2, hue: 0.9, glow: 0.4 }
function setup() {
  S().stopPlayback(); if (S().rec.mode === 'recording') S().stopRecording()
  S().clearRec()
  S().setGov(gov)
  S().applyParams(USER)
  S().setRecSpeed(1)
  useTourStore.setState({ remote: false, running: false, caption: null })
  const clock = { t: 1e6 }
  const runner = createTourRunner({ store: useStore, getActivity: () => activity.last, touch, now: () => clock.t })
  const fakeWin = makeWin(), fakeDoc = makeDoc()
  const detach = attachTourGuards({ win: fakeWin, doc: fakeDoc, runner })
  const advance = (ms) => { clock.t += ms; runner.tick(clock.t) }   // 導覽的 100ms 輪詢（保險網）
  const toStation = (id) => {                                        // 換到指定站（依序 advance）
    const stops = buildTour(S().gov)
    const idx = stops.findIndex((x) => x.id === id)
    assert.ok(idx >= 0, `資料裡沒有 ${id} 站`)
    while (runner.current().index < idx) advance(stops[runner.current().index].durationMs)
    assert.equal(runner.current().stop.id, id)
  }
  return { runner, clock, advance, toStation, win: fakeWin, doc: fakeDoc, detach }
}
function makeWin() {
  const L = {}
  return { L, addEventListener(t, f, c) { (L[t] ||= []).push(f) }, removeEventListener(t, f) { L[t] = (L[t] || []).filter((x) => x !== f) }, emit(t, e = {}) { for (const f of [...(L[t] || [])]) f({ target: null, ...e }) }, count: () => Object.values(L).reduce((n, a) => n + a.length, 0) }
}
function makeDoc() { const d = makeWin(); d.hidden = false; return d }
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

// ================= 非 DOM 輸入：先還原、後套用 =================
test('MIDI 旋鈕（handleCC）：導覽中第一個動作立刻中止並還原，動作落在還原後的海上（以前 100ms 後被還原蓋回導覽前的值）', () => {
  const { runner, advance, detach } = setup()
  assert.equal(runner.start({ auto: true }), true)
  const tourSea = S().params.seaLevel
  assert.notEqual(tourSea, USER.seaLevel, '導覽的海與使用者的不同（測試前提）')
  S().handleCC(16, 0.15)                                  // Knob 1 → spin
  assert.equal(runner.isRunning(), false, '同步中止：不必等 100ms 輪詢')
  assert.ok(near(S().params.spin, 0.15), '旋鈕值落下')
  assert.ok(near(S().params.seaLevel, USER.seaLevel), '其餘參數已還原成使用者原本的')
  advance(100); advance(100)
  assert.ok(near(S().params.spin, 0.15), '之後的輪詢不會把它還原掉')
  detach()
})

test('滾輪縮放（input(zoom)）：第一格不被還原蓋掉', () => {
  const { runner, advance, detach } = setup()
  runner.start({ auto: true })
  S().input('zoom', USER.zoom - 0.1)
  assert.equal(runner.isRunning(), false)
  advance(100)
  assert.ok(near(S().params.zoom, USER.zoom - 0.1))
  detach()
})

test('語音「清垃圾」：垃圾真的變 0 並維持（以前被還原成導覽前的 0.6，看起來指令沒作用）', () => {
  const { runner, advance, detach } = setup()
  runner.start({ auto: true })
  touch(); runCommand('clean', useStore)                  // VoiceService 的順序：先 touch()，再 runCommand
  assert.equal(runner.isRunning(), false)
  assert.equal(S().params.trashCount, 0)
  advance(100); advance(100)
  assert.equal(S().params.trashCount, 0, '之後不會被還原回 0.6')
  detach()
})

test('語音「安靜」：由「還原後」的洋流往下走一步（不是導覽當下的值），且維持', () => {
  const { runner, advance, detach } = setup()
  runner.start({ auto: true })
  touch(); runCommand('calm', useStore)
  const want = USER.current + (CALM_TARGETS.current - USER.current) * CALM_STEP
  assert.ok(near(S().params.current, want, 1e-6), `current ${S().params.current} ≠ ${want}`)
  advance(100)
  assert.ok(near(S().params.current, want, 1e-6))
  detach()
})

test('手機遙控：滑桿（p）、走帶鍵（a：轉錄）都在導覽中先中止再生效；走帶鍵以前不算活動，導覽根本不會停', () => {
  const a = setup()
  a.runner.start({ auto: true })
  dispatch({ t: 'p', pid: 'spin', v: 0.9 }, 'phoneA')
  assert.equal(a.runner.isRunning(), false)
  a.advance(100)
  assert.ok(near(S().params.spin, 0.9))
  a.detach()

  const b = setup()
  b.runner.start({ auto: true })
  dispatch({ t: 'a', a: 'transportRecord' }, 'phoneB')     // 手機上按 ● 錄製
  assert.equal(b.runner.isRunning(), false, '以前：走帶鍵不 touch()，導覽照跑、錄製鍵形同無效')
  assert.equal(S().rec.mode, 'recording')
  assert.ok(near(S().params.seaLevel, USER.seaLevel), '錄製從使用者原本的海開始（t=0 快照）')
  b.advance(100)
  assert.equal(S().rec.mode, 'recording', '輪詢不會把錄製砍掉')
  S().stopRecording()
  b.detach()
})

test('MIDI ● 錄製（handleCC 45）：導覽的序列站（播放中）第一下就開始錄，不必按第二次；從還原後的海起錄', () => {
  const { runner, advance, toStation, detach } = setup()
  runner.start({ auto: true })
  toStation('tide')
  assert.equal(S().rec.mode, 'playing', '導覽正在播潮汐（測試前提）')
  S().handleCC(45, 1)
  assert.equal(runner.isRunning(), false)
  assert.equal(S().rec.mode, 'recording', '第一下就錄（以前被 startRecording 的「播放中不可開錄」防禦擋掉，之後導覽又被中止）')
  assert.ok(near(S().params.seaLevel, USER.seaLevel))
  advance(100)
  assert.equal(S().rec.mode, 'recording')
  S().stopRecording()
  detach()
})

test('MIDI ▶ 播放（handleCC 41）：導覽的靜態站第一下就播使用者自己的錄製，不被 100ms 後的還原砍掉；導覽在動作前已還原', () => {
  const { runner, advance, detach } = setup()
  S().startRecording(); S().advanceRec(1); S().input('hue', 0.1); S().advanceRec(1); S().stopRecording()   // 使用者的錄製
  const count = S().rec.count
  assert.ok(count > 0)
  runner.start({ auto: true })                                // 第一站：今日水庫（靜態）
  assert.equal(S().rec.mode, 'idle')
  S().handleCC(41, 1)
  assert.equal(runner.isRunning(), false)
  assert.equal(S().rec.mode, 'playing')
  advance(100); advance(100)
  assert.equal(S().rec.mode, 'playing', '使用者的播放沒被砍')
  assert.equal(S().rec.count, count, '使用者的錄製還在')
  S().stopPlayback()
  detach()
})

test('MIDI ▶ 在導覽的序列站：導覽的播放先被收掉並還原使用者暫存的錄製，然後播放的是使用者的錄製（不是「切換停止導覽的播放」而已）', () => {
  const { runner, toStation, detach } = setup()
  S().startRecording(); S().advanceRec(1); S().input('hue', 0.1); S().advanceRec(1); S().stopRecording()
  const count = S().rec.count
  runner.start({ auto: true })
  toStation('tide')
  S().handleCC(41, 1)
  assert.equal(S().rec.mode, 'playing')
  assert.equal(S().rec.count, count, '播的是使用者的錄製')
  S().stopPlayback()
  detach()
})

test('Marker 鍵（markerSet）：導覽中存下的是使用者的海，不是導覽的', () => {
  const { runner, detach } = setup()
  runner.start({ auto: true })
  const saved = S().markers.length
  S().markerSet()
  const m = S().markers[S().markers.length - 1]
  assert.equal(S().markers.length, Math.min(8, saved + 1))
  assert.ok(near(m.seaLevel, USER.seaLevel) && near(m.current, USER.current))
  detach()
})

test('沒有輸入時導覽照跑：導覽自己的 touch / 播放 / 換站不會觸發活動掛鉤（不會自己中止）', () => {
  const { runner, advance, toStation, detach } = setup()
  runner.start({ auto: true })
  for (let i = 0; i < 30; i++) advance(100)
  toStation('tide'); toStation('fish')
  for (let i = 0; i < 30; i++) { if (S().rec.mode === 'playing') S().tickPlayback(0.1); advance(100) }
  assert.equal(runner.isRunning(), true)
  runner.stop('user')
  detach()
})

test('活動掛鉤：touch 重入安全；detach 後不再中止導覽', () => {
  const { runner, detach } = setup()
  let n = 0
  const off = onActivity(() => { n++ })
  runner.start({ auto: true })
  const before = n
  runner.stop('user')                                       // stop 內部會 touch() → 掛鉤 → 再 stop（已結束）
  assert.equal(runner.isRunning(), false)
  assert.ok(n > before)
  off(); detach()
  runner.start({ auto: true })
  touch()
  assert.equal(runner.isRunning(), true, 'detach 後掛鉤已移除')
  runner.stop('user')
})

test('接線：VoiceService 先 touch() 再 runCommand（順序決定輸入是否落在還原後的海）', () => {
  const src = readFileSync(new URL('./VoiceService.jsx', import.meta.url), 'utf8')
  const a = src.indexOf('touch()'), b = src.indexOf('runCommand(f.id')
  assert.ok(a > 0 && b > a)
})

// ================= 隱藏 / 閒置計時 =================
test('分頁隱藏 / 最小化：導覽中止並還原（背景時 rAF 停了，導覽卻照時間換站、字幕照換 → 投影機看到靜止的海配上會動的說明）', () => {
  const { runner, doc, advance, detach } = setup()
  runner.start({ auto: true })
  advance(TOUR_MS.reservoir)                                // 已經換到第二站
  assert.equal(useTourStore.getState().running, true)
  doc.hidden = true; doc.emit('visibilitychange')
  assert.equal(runner.isRunning(), false)
  assert.equal(useTourStore.getState().running, false); assert.equal(useTourStore.getState().caption, null, '字幕清掉（鏡像到觀眾視窗也清掉）')
  assert.ok(near(S().params.seaLevel, USER.seaLevel), '還原成導覽前的海')
  assert.equal(S().rec.mode, 'idle')
  detach()
})

test('分頁被顯示（visible）不影響導覽；pagehide 仍會中止；detach 拆掉所有監聽', () => {
  const { runner, win, doc, detach } = setup()
  runner.start({ auto: true })
  doc.hidden = false; doc.emit('visibilitychange')
  assert.equal(runner.isRunning(), true)
  win.emit('pagehide')
  assert.equal(runner.isRunning(), false)
  detach()
  assert.equal(win.count(), 0); assert.equal(doc.count(), 0)
})

test('閒置計時：導覽沒在跑時，點擊 / 按鍵 / 滾輪都算活動（以前只按面板、關彈窗的人 30 秒後被導覽接手）；導覽進行中不在這裡處理', () => {
  const { runner, win, detach } = setup()
  const before = activity.last
  const t0 = performance.now(); while (performance.now() - t0 < 2) { /* 讓時間前進 */ }
  win.emit('pointerdown'); assert.ok(activity.last > before, 'pointerdown')
  const b2 = activity.last; const t1 = performance.now(); while (performance.now() - t1 < 2) { /* */ }
  win.emit('keydown', { key: 'Tab' }); assert.ok(activity.last > b2, 'keydown（連修飾鍵 / Tab 也算人在場）')
  const b3 = activity.last; const t2 = performance.now(); while (performance.now() - t2 < 2) { /* */ }
  win.emit('wheel'); assert.ok(activity.last > b3, 'wheel')
  runner.start({ auto: true })
  const b4 = activity.last; const t3 = performance.now(); while (performance.now() - t3 < 2) { /* */ }
  win.emit('pointerdown')
  assert.equal(activity.last, b4, '導覽進行中，這條路徑不 touch（由 attachRunningGuards 負責）')
  runner.stop('user')
  detach()
})

test('資料播放 / 錄製「結束」算一次活動：使用者自己播完 24h 潮位後，要再等 30 秒才會被導覽接手（以前播完立刻接手、換掉終點畫面）', () => {
  const { runner, detach } = setup()
  S().setGovOption('hualien-tide' in {} ? 'hualien-tide' : (gov.options.find((o) => o.kind === 'tide') || gov.options[0]).id)
  S().playGovSeries()
  assert.equal(S().rec.mode, 'playing')
  const t0 = performance.now(); while (performance.now() - t0 < 2) { /* */ }
  const before = activity.last
  S().tickPlayback(9999)                                     // 播完
  assert.equal(S().rec.mode, 'idle')
  assert.ok(activity.last > before, '播放結束 → 活動時間戳更新')
  assert.equal(runner.isRunning(), false)
  detach()
})

test('導覽自己的序列播放結束不算使用者活動（否則導覽會在自己的播放結束時被當成有人輸入而中止）', () => {
  const { runner, advance, toStation, detach } = setup()
  runner.start({ auto: true })
  toStation('tide')
  S().tickPlayback(9999)                                     // 導覽的潮汐序列自然播完
  advance(100)
  assert.equal(runner.isRunning(), true)
  runner.stop('user')
  detach()
})

test('自動導覽啟動時收掉資料卡（游標停在卡片上時卡片不會自動關，導覽開始換海況卻卡片還開著）', () => {
  S().setGov(gov)
  useTourStore.setState({ remote: false, autoIdle: true })
  inspectStore.open({ kind: 'station', n: '景美', r: '景美溪', a: 1, s: 1 }, { x: 0.5, y: 0.5 })
  inspectStore.hold(true)                                    // 游標停在卡上 → 不會自動關
  assert.equal(inspectStore.get().open, true)
  assert.equal(tourIdleTick(1e9), 'started')
  assert.equal(inspectStore.get().open, false)
  tourRunner.stop('user')
})

// ================= 導覽進行中的 capture 守衛（原 TourService 內的邏輯；現在抽出來可測）=================
test('attachRunningGuards：點一般畫面 / 按一般鍵 → 中止；點語言切換 / 分享 / 導覽卡片、T / H 等鍵 → 不中止；Esc → 使用者停止', () => {
  const win = makeWin()
  const calls = []
  const runner = { stop: (r) => { calls.push(r); return true } }
  const off = attachRunningGuards(win, runner)
  const keepEl = { closest: (sel) => (sel === KEEP_SELECTOR ? {} : null) }
  win.emit('pointerdown', { target: { closest: () => null } }); assert.deepEqual(calls, ['input'])
  win.emit('pointerdown', { target: keepEl }); assert.deepEqual(calls, ['input'], '語言切換 / 分享 / 導覽卡片不算操作')
  win.emit('keydown', { key: 't' }); win.emit('keydown', { key: 'Shift' }); win.emit('keydown', { key: 'a', ctrlKey: true }); assert.deepEqual(calls, ['input'])
  win.emit('keydown', { key: ' ', target: null }); assert.deepEqual(calls, ['input', 'input'])
  win.emit('keydown', { key: 'Escape' }); assert.deepEqual(calls, ['input', 'input', 'user'])
  off(); assert.equal(win.count(), 0)
})

// ================= 觸覺：導覽自己的事件不震 =================
function hapticsRun({ suppress }) {
  const { runner, clock, advance, detach } = setup()
  const calls = []
  const engine = { trigger: (name) => { calls.push(name); return true }, getState: () => ({ enabled: true }), cancel() {} }
  const timers = []
  const off = attachHapticsSource({
    store: useStore, haptics: engine, now: () => clock.t,
    setIntervalFn: (fn) => { timers.push(fn); return timers.length }, clearIntervalFn: (id) => { timers[id - 1] = null },
    isSuppressed: suppress ? () => runner.isActive() : undefined,
  })
  runner.start({ auto: true })
  for (let i = 0; i < 1100; i++) {                            // ≈110 秒：一整輪（約 99 秒）以上
    if (S().rec.mode === 'playing') S().tickPlayback(0.1)
    advance(100)
    if (i % 2 === 0) for (const f of timers) if (f) f()       // 溢流滴水計時器（150ms 一次）
  }
  const during = calls.slice()
  runner.stop('user')
  off(); detach()
  return { during, after: calls.slice(during.length) }
}
test('觸覺：閒置導覽跑一整輪，不會因為換站 / 播放起訖 / 滿庫溢流而震（對照組：不靜音時確實會震很多次）', () => {
  const control = hapticsRun({ suppress: false })
  assert.ok(control.during.filter((n) => n === 'playStart').length >= 3, `對照組要有 playStart：${control.during}`)
  const r = hapticsRun({ suppress: true })
  const quiet = r.during.filter((n) => ['record', 'recordStop', 'playStart', 'playStop', 'overflow', 'drip'].includes(n))
  assert.deepEqual(quiet, [], `導覽自己的事件不該震：${quiet}`)
})

test('觸覺：導覽中使用者叫出的鯨魚照震；使用者中止導覽的那一下，還原引起的 playStop / overflow 不震', () => {
  const { runner, clock, advance, toStation, detach } = setup()
  const calls = []
  const engine = { trigger: (name) => { calls.push(name); return true }, getState: () => ({ enabled: true }), cancel() {} }
  const off = attachHapticsSource({ store: useStore, haptics: engine, now: () => clock.t, setIntervalFn: () => 1, clearIntervalFn() {}, isSuppressed: () => runner.isActive() })
  runner.start({ auto: true })
  toStation('tide')
  S().spawnWhale()
  assert.ok(calls.includes('whale'), '鯨魚照震')
  calls.length = 0
  S().input('spin', 0.5)                                      // 使用者動手：導覽中止、還原（包含停掉導覽的播放）
  assert.equal(runner.isRunning(), false)
  assert.deepEqual(calls.filter((n) => n === 'playStop' || n === 'overflow'), [], '還原的副作用不震')
  advance(100)
  off(); detach()
})
