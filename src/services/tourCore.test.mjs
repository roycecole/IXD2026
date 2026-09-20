// 資料導覽 × 真實輸入路徑的整合測試。執行：node --test src/services/tourCore.test.mjs
// 後半段是「導覽員控制」：快速鍵 ← → P 的守衛（含忽略輸入元件 / 彈窗 / 修飾鍵）、暫停與跳站對真的 store / 活動掛鉤的影響、
// 每站連結的啟動器（只啟動一次、StrictMode、觀眾視窗、失敗不重試）、複製此站連結（Clipboard → execCommand 退路）、接線與樣式的原始碼檢查。
// 計時器 / 剪貼簿 / document 都用「會檢查 this 的假環境」（../lib/tourTestEnv.mjs）：脫離原物件呼叫會丟 Illegal invocation，跟瀏覽器一樣。
// 以前的導覽測試（src/lib/tour.test.mjs）全用假 store，只把 activity 時間戳往前撥；這裡用「真的」useStore / activity / createTourRunner，
// 驗證各種輸入來源（MIDI / 語音 / 手機遙控 / 手把式 input / 滾輪）在導覽進行中：
//   先中止並還原、再落下使用者的動作（以前是動作先寫進去，100ms 後被還原蓋掉）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { useStore } from '../store/useStore.js'
import { activity, touch, touchGuide, onActivity } from '../store/activity.js'
import { createTourRunner, buildTour, useTourStore, TOUR_MS, PAUSE_SPEED } from '../lib/tour.js'
import { registerEn, setLocale } from '../i18n/index.js'
import { loadEnDict } from '../../scripts/i18n-check.mjs'
import { MODAL_SELECTOR } from '../lib/modalFocus.js'
import { makeTimers, installTimers, makeCopyEnv, illegal } from '../lib/tourTestEnv.mjs'
import { runCommand, CALM_TARGETS, CALM_STEP } from '../lib/voiceCommands.js'
import { dispatch } from '../lib/remoteDispatch.js'
import { attachHapticsSource } from '../lib/haptics.js'
import { inspectStore } from '../lib/inspect.js'
import { attachTourGuards, attachRunningGuards, tourIdleTick, tourRunner, KEEP_SELECTOR, KEEP_KEYS, navKeyAction, isTypingTarget, createLinkStarter, copyTourLink, LINK_START_DELAY_MS } from './tourCore.js'

const { dict: EN_DICT } = await loadEnDict()
registerEn(EN_DICT)
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

// =============================================================================================
// 導覽員快速鍵：← 上一站、→ 下一站、P 暫停 / 繼續（attachRunningGuards 的 capture keydown）
// =============================================================================================
const keyEv = (key, over = {}) => { const e = { key, target: null, prevented: 0, preventDefault() { e.prevented++ }, ...over }; return e }
const fakeRunner = () => {
  const r = { calls: [], paused: false }
  r.stop = (why) => { r.calls.push('stop:' + why); return true }
  r.prev = () => { r.calls.push('prev'); return true }
  r.next = () => { r.calls.push('next'); return true }
  r.pause = () => { r.calls.push('pause'); r.paused = true; return true }
  r.resume = () => { r.calls.push('resume'); r.paused = false; return true }
  r.isPaused = () => r.paused
  return r
}
const press = (win, key, over) => { const e = keyEv(key, over); win.emit('keydown', e); return e }
const tourBtn = { tagName: 'BUTTON', closest: (sel) => (sel === KEEP_SELECTOR ? {} : null), getAttribute: () => null }
const inModal = { tagName: 'BUTTON', closest: (sel) => (sel === MODAL_SELECTOR ? {} : null), getAttribute: () => null }

test('KEEP_KEYS：導覽員快速鍵 ← → P（大小寫）加進「不算操作海」；既有的 T / H / I / ? / 修飾鍵不變；空白鍵與一般字母仍算操作', () => {
  for (const k of ['ArrowLeft', 'ArrowRight', 'p', 'P', 't', 'T', 'h', 'H', 'i', 'I', '?', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab']) assert.ok(KEEP_KEYS.has(k), k)
  for (const k of [' ', 'a', 'r', '1', 'Enter', 'ArrowUp', 'ArrowDown', 'Escape']) assert.ok(!KEEP_KEYS.has(k), k)
})

test('navKeyAction / isTypingTarget：純判斷——修飾鍵、輸入法組字、輸入元件、可編輯區、滑桿類元件、彈窗內 → null；其餘依鍵回 prev / next / toggle', () => {
  assert.equal(navKeyAction(keyEv('ArrowLeft')), 'prev'); assert.equal(navKeyAction(keyEv('ArrowRight')), 'next')
  assert.equal(navKeyAction(keyEv('p')), 'toggle'); assert.equal(navKeyAction(keyEv('P')), 'toggle')
  assert.equal(navKeyAction(keyEv('ArrowRight', { shiftKey: true })), 'next', 'Shift 不算修飾組合')
  for (const mod of ['ctrlKey', 'metaKey', 'altKey', 'isComposing']) assert.equal(navKeyAction(keyEv('p', { [mod]: true })), null, mod)
  for (const k of ['a', 't', 'ArrowUp', 'ArrowDown', ' ', 'Enter', 'Escape', 'constructor', '__proto__', 'toString', undefined, null]) assert.equal(navKeyAction(keyEv(k)), null, String(k))
  for (const t of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true },
    { tagName: 'DIV', getAttribute: (a) => (a === 'role' ? 'slider' : null) }, { tagName: 'DIV', getAttribute: (a) => (a === 'role' ? 'textbox' : null) },
    { tagName: 'DIV', getAttribute: (a) => (a === 'role' ? 'spinbutton' : null) }]) { assert.equal(isTypingTarget(t), true); assert.equal(navKeyAction(keyEv('ArrowLeft', { target: t })), null) }
  assert.equal(navKeyAction(keyEv('ArrowLeft', { target: inModal })), null, '彈窗內（isInModal，與 App 全域快速鍵同一個判斷）')
  for (const t of [null, undefined, {}, { tagName: 'BUTTON' }, { tagName: 'DIV', getAttribute: () => 'button' }, tourBtn]) assert.equal(isTypingTarget(t), false)
  assert.equal(navKeyAction(keyEv('ArrowLeft', { target: tourBtn })), 'prev', '導覽自己的按鈕上也能用快速鍵')
  assert.equal(isTypingTarget({ get tagName() { throw new Error('x') } }), false, '壞元素不丟錯')
  assert.equal(navKeyAction(null), null); assert.equal(navKeyAction({}), null)
})

test('attachRunningGuards：← → P 換站 / 暫停 / 繼續，preventDefault（不捲動面板）、不中止導覽；按住不放（repeat）不連續跳站', () => {
  const win = makeWin(), r = fakeRunner()
  const off = attachRunningGuards(win, r)
  const a = press(win, 'ArrowRight'); const b = press(win, 'ArrowLeft'); const c = press(win, 'p'); const d = press(win, 'P'); const e = press(win, 'p')
  assert.deepEqual(r.calls, ['next', 'prev', 'pause', 'resume', 'pause'], 'P 依目前是否暫停切換')
  for (const ev of [a, b, c, d, e]) assert.equal(ev.prevented, 1)
  assert.ok(!r.calls.some((x) => x.startsWith('stop')), '不算操作海')
  r.calls.length = 0
  const rep1 = press(win, 'ArrowRight', { repeat: true }); const rep2 = press(win, 'p', { repeat: true })
  assert.deepEqual(r.calls, [], '按住不放：不動作也不中止'); assert.equal(rep1.prevented, 1); assert.equal(rep2.prevented, 1)
  off(); assert.equal(win.count(), 0)
})

test('attachRunningGuards：忽略 ctrl / meta / alt 組合、輸入元件、可編輯區、滑桿、彈窗內——不換站、不 preventDefault；這些情況下 ← → P 仍屬 KEEP_KEYS 不中止', () => {
  const win = makeWin(), r = fakeRunner()
  attachRunningGuards(win, r)
  for (const over of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { target: { tagName: 'INPUT' } }, { target: { tagName: 'TEXTAREA' } }, { target: { tagName: 'SELECT' } },
    { target: { tagName: 'DIV', isContentEditable: true } }, { target: { tagName: 'DIV', getAttribute: () => 'slider' } }, { target: inModal }]) {
    for (const key of ['ArrowLeft', 'ArrowRight', 'p']) { const ev = press(win, key, over); assert.equal(ev.prevented, 0, `${key} ${JSON.stringify(Object.keys(over))}`) }
  }
  assert.deepEqual(r.calls, [])
  // 一般輸入元件裡打「其他字」仍算操作（既有行為不變）
  press(win, 'a', { target: { tagName: 'INPUT' } }); assert.deepEqual(r.calls, ['stop:input'])
})

test('attachRunningGuards：Esc 仍是結束；空白鍵 / 一般字母 / 方向鍵上下仍是「接手」中止；導覽卡片內按 Enter / 空白不中止；T / H 等不中止（既有行為不變）', () => {
  const win = makeWin(), r = fakeRunner()
  attachRunningGuards(win, r)
  press(win, 'Escape'); press(win, ' '); press(win, 'a'); press(win, 'ArrowUp'); press(win, 'ArrowDown'); press(win, 'r')
  assert.deepEqual(r.calls, ['stop:user', 'stop:input', 'stop:input', 'stop:input', 'stop:input', 'stop:input'])
  r.calls.length = 0
  press(win, 'Enter', { target: tourBtn }); press(win, ' ', { target: tourBtn }); press(win, 't'); press(win, 'H'); press(win, 'Tab'); press(win, '?')
  assert.deepEqual(r.calls, [])
  press(win, 'Escape', { target: { tagName: 'INPUT' } }); assert.deepEqual(r.calls, ['stop:user'], 'Esc 在輸入元件裡也結束')
})

// ---- 真的 store / 執行器 / 活動掛鉤 ----
const pd = () => {}
test('鍵盤（真的 store + 活動掛鉤）：→ ← 換站、P 暫停 / 繼續——導覽照跑，不被當成使用者輸入；Esc 結束並還原', () => {
  const { runner, win, detach } = setup()
  const off = attachRunningGuards(win, runner)
  runner.start({ auto: false })
  const t0 = activity.last
  win.emit('keydown', keyEv('ArrowRight', { preventDefault: pd })); assert.equal(runner.current().index, 1)
  win.emit('keydown', keyEv('ArrowRight', { preventDefault: pd })); assert.equal(runner.current().index, 2)
  win.emit('keydown', keyEv('ArrowLeft', { preventDefault: pd })); assert.equal(runner.current().index, 1)
  win.emit('keydown', keyEv('p', { preventDefault: pd })); assert.equal(runner.isPaused(), true); assert.equal(useTourStore.getState().paused, true)
  win.emit('keydown', keyEv('P', { preventDefault: pd })); assert.equal(runner.isPaused(), false); assert.equal(useTourStore.getState().paused, false)
  assert.equal(runner.isRunning(), true); assert.equal(activity.last, t0, '沒有任何 touch：導覽員操作不算使用者活動')
  win.emit('keydown', keyEv('Escape'))
  assert.equal(runner.isRunning(), false); assert.ok(near(S().params.seaLevel, USER.seaLevel), '還原成導覽前的海')
  off(); detach()
})

test('導覽員操作（真的 store）：goto / next / prev / pause / resume / 暫停中換站 都不會被活動掛鉤或輪詢當成使用者輸入而中止（導覽自己換海況 / 播放 / 停播都不 touch）', () => {
  const { runner, advance, detach } = setup()
  runner.start({ auto: false })
  const t0 = activity.last
  runner.goto('tide'); S().tickPlayback(0.05); runner.goto('air'); runner.next(); runner.prev(); advance(100)
  runner.pause(); runner.goto('fish'); runner.next(); advance(100); runner.resume(); advance(100)
  runner.goto('reservoir'); advance(1000)
  assert.equal(runner.isRunning(), true); assert.equal(activity.last, t0)
  runner.stop('user'); detach()
})

// ---- 導覽員操作 = 「有人在場講解」：留下 activity.guideAt（展場防呆的閒置判斷用），但不能是 touch()（會中止導覽）----
test('導覽員操作留下 guideAt：← → P / 點導覽卡與進度點 / 在導覽卡按鈕上按 Enter 都呼叫 guide()；一般畫面點擊 / 一般字母是「接手」（中止、不記 guide）；T / H 等 KEEP 鍵不記', () => {
  const win = makeWin(), r = fakeRunner()
  let guides = 0
  const off = attachRunningGuards(win, r, () => { guides++ })
  press(win, 'ArrowRight'); press(win, 'ArrowLeft'); press(win, 'p'); assert.equal(guides, 3)
  press(win, 'ArrowRight', { repeat: true }); assert.equal(guides, 4, '按住不放也算在場（只是不連續跳站）')
  win.emit('pointerdown', { target: tourBtn }); assert.equal(guides, 5)
  press(win, 'Enter', { target: tourBtn }); press(win, ' ', { target: tourBtn }); assert.equal(guides, 7)
  assert.deepEqual(r.calls.filter((c) => c.startsWith('stop')), [], '都不中止導覽')
  win.emit('pointerdown', { target: { closest: () => null } }); press(win, ' ', { target: null }); press(win, 'a')
  assert.equal(guides, 7, '接手不算導覽員操作'); assert.deepEqual(r.calls.filter((c) => c.startsWith('stop')), ['stop:input', 'stop:input', 'stop:input'])
  press(win, 't'); press(win, 'H'); press(win, 'Shift'); assert.equal(guides, 7, '與導覽卡無關的 KEEP 鍵不記')
  press(win, 'ArrowRight', { ctrlKey: true }); press(win, 'ArrowRight', { target: { tagName: 'INPUT' } }); assert.equal(guides, 7, '被忽略的組合 / 輸入元件不記')
  off()
})

test('導覽員操作留下 guideAt（真的 store / activity）：只更新 guideAt——activity.last 不動、導覽仍在跑；導覽自己 tick 換站不更新 guideAt（否則自動導覽永遠不閒置）', () => {
  const { runner, win, advance, detach } = setup()
  const off = attachRunningGuards(win, runner)              // 預設的 guide = 真的 touchGuide
  runner.start({ auto: true })
  activity.guideAt = -1e9
  const last0 = activity.last
  win.emit('keydown', keyEv('ArrowRight', { preventDefault: pd }))
  assert.ok(activity.guideAt > 0, '← → 換站記下時間'); assert.equal(activity.last, last0)
  activity.guideAt = -1e9; win.emit('keydown', keyEv('p', { preventDefault: pd })); assert.ok(activity.guideAt > 0, 'P 暫停')
  assert.equal(runner.isRunning(), true); assert.equal(runner.isPaused(), true)
  activity.guideAt = -1e9; win.emit('pointerdown', { target: tourBtn }); assert.ok(activity.guideAt > 0, '點導覽卡 / 進度點 / 字幕卡按鈕')
  assert.equal(activity.last, last0, '導覽員操作全程不算使用者活動'); assert.equal(runner.isRunning(), true)
  win.emit('keydown', keyEv('p', { preventDefault: pd }))   // 繼續
  activity.guideAt = -1e9
  advance(buildTour(S().gov)[runner.current().index].durationMs)   // 導覽自己時間到換站
  assert.equal(runner.isRunning(), true); assert.equal(activity.guideAt, -1e9, '導覽自己的換站不算導覽員操作')
  runner.stop('user'); off(); detach()
})

test('touchGuide：只寫 activity.guideAt（不動 activity.last、不跑活動掛鉤）；初值是很久以前（不會讓剛載入的頁面被當成「導覽員剛操作過」）', () => {
  assert.ok(activity.guideAt !== undefined)
  let hooked = 0
  const off = onActivity(() => { hooked++ })
  const last0 = activity.last
  touchGuide()
  assert.equal(hooked, 0, '不觸發活動掛鉤（掛鉤會中止導覽）'); assert.equal(activity.last, last0)
  assert.ok(activity.guideAt > 0 && activity.guideAt <= performance.now())
  off(); activity.guideAt = -1e9
})

test('L（系統事件面板）快速鍵在 KEEP_KEYS：導覽進行中按 L 不中止導覽；Footer 切換鈕與 Monitor 隱藏鈕帶 data-tour-ui（點它們也不中止）', () => {
  assert.ok(KEEP_KEYS.has('l') && KEEP_KEYS.has('L'))
  const win = makeWin(), r = fakeRunner()
  attachRunningGuards(win, r)
  press(win, 'l'); press(win, 'L'); assert.deepEqual(r.calls, [], 'L 只是切版面，不算操作海')
  press(win, 'k'); assert.deepEqual(r.calls, ['stop:input'], '其他字母照舊接手')
  const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8')
  const footer = read('../ui/Footer.jsx'), monitor = read('../ui/Monitor.jsx')
  assert.match(footer.match(/<button[^>]*id=\{MONITOR_TOGGLE_ID\}[\s\S]*?>/)[0], /data-tour-ui/)
  assert.match(monitor.match(/<button[^>]*className="monitor-hide"[\s\S]*?>/)[0], /data-tour-ui/)
})

test('isTypingTarget：checkbox / 按鈕類 INPUT 不算輸入元件（點過導覽卡的 checkbox 後 ← → P 仍可用）；文字 / 數字 / 滑桿 / radio 等仍算', () => {
  for (const type of ['checkbox', 'CHECKBOX', 'button', 'submit', 'reset', 'image']) {
    const el = { tagName: 'INPUT', type }
    assert.equal(isTypingTarget(el), false, type)
    assert.equal(navKeyAction(keyEv('ArrowLeft', { target: el })), 'prev', type); assert.equal(navKeyAction(keyEv('ArrowRight', { target: el })), 'next', type); assert.equal(navKeyAction(keyEv('p', { target: el })), 'toggle', type)
  }
  for (const type of ['text', 'search', 'number', 'email', 'password', 'url', 'tel', 'range', 'radio', 'date', '', undefined]) assert.equal(isTypingTarget({ tagName: 'INPUT', type }), true, String(type))
  assert.equal(isTypingTarget({ tagName: 'INPUT' }), true, '沒有 type 屬性 = 文字框')
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA', type: 'checkbox' }), true); assert.equal(isTypingTarget({ tagName: 'SELECT' }), true)
  const win = makeWin(), r = fakeRunner()
  attachRunningGuards(win, r)
  const cb = { tagName: 'INPUT', type: 'checkbox', closest: (sel) => (sel === KEEP_SELECTOR ? {} : null), getAttribute: () => null }   // 面板導覽卡的 checkbox（帶 data-tour-ui 的容器內）
  const e1 = press(win, 'p', { target: cb }); const e2 = press(win, 'ArrowRight', { target: cb })
  assert.deepEqual(r.calls, ['pause', 'next']); assert.equal(e1.prevented, 1); assert.equal(e2.prevented, 1)
  r.calls.length = 0
  press(win, 'p', { target: { tagName: 'INPUT', type: 'text' } }); assert.deepEqual(r.calls, [], '文字框裡打 p 不是快速鍵')
})

test('暫停（真的 store）：序列播放凍結——倍速為極小值、播放頭實質不動、不換站；繼續後還原該站的倍速、播放頭照常前進', () => {
  const { runner, advance, toStation, win, detach } = setup()
  const off = attachRunningGuards(win, runner)
  runner.start({ auto: false })
  toStation('tide')
  const stop = buildTour(S().gov).find((x) => x.id === 'tide')
  assert.equal(S().rec.mode, 'playing'); assert.equal(S().rec.speed, stop.speed)
  S().tickPlayback(0.05)
  const ph0 = S().rec.playhead
  assert.ok(ph0 > 0)
  win.emit('keydown', keyEv('p', { preventDefault: pd }))
  assert.equal(S().rec.speed, PAUSE_SPEED); assert.equal(S().rec.mode, 'playing')
  for (let i = 0; i < 400; i++) S().tickPlayback(0.05)                             // 20 秒的畫面時間
  assert.ok(S().rec.playhead - ph0 < 1e-3, `播放頭不該前進：${S().rec.playhead - ph0}`)
  assert.equal(S().rec.mode, 'playing', '序列沒有被播完')
  advance(120000)
  assert.equal(runner.current().stop.id, 'tide', '暫停中不換站（計時凍結）')
  win.emit('keydown', keyEv('p', { preventDefault: pd }))
  assert.equal(S().rec.speed, stop.speed)
  const ph1 = S().rec.playhead
  S().tickPlayback(0.05)
  assert.ok(Math.abs(S().rec.playhead - ph1 - 0.05 * stop.speed) < 1e-9, '繼續後以該站倍速前進')
  advance(stop.durationMs - 100)                                                    // 剩餘時間 = 暫停前剩下的（暫停前只過了很少）
  assert.equal(runner.current().stop.id, 'tide', '暫停前那一小段 + 這段 < 整站時間')
  runner.stop('user'); off(); detach()
})

test('暫停中「真實輸入」仍中止導覽（真的 store）：還原參數 / 海況 / 倍速，且倍速不會停在極小值', () => {
  const { runner, toStation, detach } = setup()
  runner.start({ auto: true })
  toStation('moon')
  runner.pause()
  assert.equal(S().rec.speed, PAUSE_SPEED)
  S().input('spin', 0.7)                                                            // 使用者動手：先中止並還原，動作再落下
  assert.equal(runner.isRunning(), false); assert.equal(useTourStore.getState().paused, false)
  assert.equal(S().rec.mode, 'idle'); assert.equal(S().rec.speed, 1, '還原成導覽前的倍速（setup 設的 1）')
  assert.ok(near(S().params.spin, 0.7)); assert.ok(near(S().params.seaLevel, USER.seaLevel))
  detach()
})

test('start({ at, hold })（真的 store）：直接停在指定站——暫停狀態、序列在起點凍結；繼續才開始跑；Esc 結束還原', () => {
  const { runner, advance, detach } = setup()
  assert.equal(runner.start({ auto: false, at: 'air', hold: true }), true)
  const stop = buildTour(S().gov).find((x) => x.id === 'air')
  assert.equal(runner.current().stop.id, 'air'); assert.equal(runner.isPaused(), true); assert.equal(useTourStore.getState().paused, true)
  assert.equal(S().govOptionId, stop.optionId); assert.equal(S().rec.mode, 'playing'); assert.equal(S().rec.speed, PAUSE_SPEED)
  for (let i = 0; i < 100; i++) S().tickPlayback(0.05)
  assert.ok(S().rec.playhead < 1e-3)
  advance(60000); assert.equal(runner.current().stop.id, 'air')
  runner.resume(); assert.equal(S().rec.speed, stop.speed)
  runner.stop('user')
  assert.equal(S().rec.speed, 1); assert.ok(near(S().params.seaLevel, USER.seaLevel))
  detach()
})

// =============================================================================================
// 每站連結的啟動器（?tourstop= → 資料載入後只啟動一次）
// =============================================================================================
function fakeGovStore(gov = null) {
  const subs = new Set()
  let state = { gov }
  return { getState: () => state, subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn) }, set(next) { const prev = state; state = { ...state, ...next }; for (const f of [...subs]) f(state, prev) }, count: () => subs.size }
}
const GOV = { options: [{ id: 'a' }] }
function linkKit({ search = '?tourstop=air', gov = null, start = () => true, remote = false } = {}) {
  const timers = makeTimers()
  const { setTimeout: fakeSet, clearTimeout: fakeClear } = timers                   // 假計時器只准「裸函式」呼叫（this 為 undefined），跟原生 setTimeout 一樣
  const store = fakeGovStore(gov)
  const runner = { starts: [], start(o) { if (this !== runner) throw illegal(); runner.starts.push(o); return start(o) } }
  const tourStore = { getState: () => ({ remote }) }
  const starter = createLinkStarter({ runner, store, tourStore, getSearch: () => search, schedule: (fn, ms) => fakeSet(fn, ms), cancel: (id) => fakeClear(id) })
  return { timers, store, runner, starter }
}

test('LINK_START_DELAY_MS：正的、不過長（延後到 App 在 setGov 之後、同一個 tick 內套完首次到訪 / 分享參數之後才記「導覽前」的狀態）', () => {
  assert.ok(LINK_START_DELAY_MS > 0 && LINK_START_DELAY_MS <= 1500)
})

test('連結啟動器：資料已載入 → 延後一小段才 start({ auto: false, at: 站 id, hold })，只有一次；StrictMode 雙掛載（attach / detach / attach）不會啟動兩次', () => {
  const k = linkKit({ gov: GOV })
  const off1 = k.starter.attach()                                                   // StrictMode 第一次掛載
  assert.equal(k.runner.starts.length, 0, '不是同步啟動'); assert.equal(k.timers.pending(), 1)
  off1()                                                                            // 模擬 StrictMode 的清理
  assert.equal(k.timers.pending(), 0, '清理時取消計時器'); assert.equal(k.store.count(), 0, '清理時退訂')
  const off2 = k.starter.attach()                                                   // 第二次掛載
  assert.equal(k.timers.pending(), 1)
  k.timers.advance(LINK_START_DELAY_MS - 1); assert.equal(k.runner.starts.length, 0)
  k.timers.advance(1)
  assert.deepEqual(k.runner.starts, [{ auto: false, at: 'air', hold: false }])
  assert.equal(k.starter.isDone(), true)
  const off3 = k.starter.attach(); off3()                                           // 之後再怎麼掛載都不再啟動
  k.timers.advance(10000); assert.equal(k.runner.starts.length, 1)
  off2(); k.store.set({ gov: { options: [{ id: 'b' }] } }); k.timers.advance(10000); assert.equal(k.runner.starts.length, 1)
})

test('連結啟動器：資料還沒載入 → 等 gov 有 options 才排程（沒有 options 的空資料不算）；載入後只啟動一次，之後 gov 再變也不重啟', () => {
  const k = linkKit({ search: '?tourstop=3&tourhold=1', gov: null })
  k.starter.attach()
  assert.equal(k.timers.pending(), 0); assert.equal(k.store.count(), 1)
  k.store.set({ gov: { options: [] } }); assert.equal(k.timers.pending(), 0, '沒有海況選項 = 還沒好')
  k.store.set({ gov: GOV }); assert.equal(k.timers.pending(), 1)
  k.store.set({ gov: { options: [{ id: 'a' }, { id: 'b' }] } }); assert.equal(k.timers.pending(), 1, '同一輪不重複排程')
  k.timers.advance(LINK_START_DELAY_MS)
  assert.deepEqual(k.runner.starts, [{ auto: false, at: 2, hold: true }], '序號連結：0 起算的 index、hold')
  k.store.set({ gov: { options: [{ id: 'c' }] } }); k.timers.advance(5000)
  assert.equal(k.runner.starts.length, 1)
})

test('連結啟動器：start 失敗（回 false，例如正在錄製 / 丟例外）→ 放棄，不重試迴圈', () => {
  for (const start of [() => false, () => { throw new Error('boom') }]) {
    const k = linkKit({ gov: GOV, start })
    k.starter.attach(); k.timers.advance(LINK_START_DELAY_MS)
    assert.equal(k.runner.starts.length, 1)
    k.store.set({ gov: { options: [{ id: 'z' }] } }); k.timers.advance(60000); k.starter.attach()
    assert.equal(k.runner.starts.length, 1, '不重試'); assert.equal(k.timers.pending(), 0)
  }
})

test('連結啟動器：沒有導覽連結 / 非法連結 / 觀眾視窗（?audience 或 remote）→ 什麼都不做（不訂閱、不排程）；卸載（detach）取消尚未觸發的啟動', () => {
  for (const [search, remote] of [['', false], ['?tourstop=nope', false], ['?tourhold=1', false], ['?kiosk=1', false], ['?tourstop=air&audience=1', false], ['?tourstop=air&view=audience', false], ['?tourstop=air', true]]) {
    const k = linkKit({ search, gov: GOV, remote })
    const off = k.starter.attach()
    assert.equal(k.store.count(), 0, search); assert.equal(k.timers.pending(), 0, search); assert.equal(k.starter.isDone(), true, search)
    off(); k.timers.advance(10000); assert.equal(k.runner.starts.length, 0, search)
  }
  const k = linkKit({ gov: GOV })
  const off = k.starter.attach(); off()                                             // 真的卸載：還沒觸發就取消
  k.timers.advance(10000); assert.equal(k.runner.starts.length, 0); assert.equal(k.starter.isDone(), false, '還沒試過：之後重新掛載仍可啟動')
  k.starter.attach(); k.timers.advance(LINK_START_DELAY_MS); assert.equal(k.runner.starts.length, 1)
})

test('連結啟動器：預設的計時器是「裸函式包一層」——換成會檢查 this 的假 setTimeout / clearTimeout 也能用（掛在物件上呼叫會丟 Illegal invocation）；對照組確認假環境有效', () => {
  const timers = makeTimers()
  const naive = { setTimeout: timers.setTimeout }
  assert.throws(() => naive.setTimeout(() => {}, 1), /Illegal invocation/, '對照組：脫離原物件呼叫會丟')
  const restore = installTimers(timers)
  try {
    const store = fakeGovStore(GOV)
    const runner = { starts: [], start(o) { runner.starts.push(o); return true } }
    const starter = createLinkStarter({ runner, store, tourStore: { getState: () => ({ remote: false }) }, getSearch: () => '?tourstop=fish' })   // 不傳 schedule / cancel：用預設
    const off = starter.attach()
    assert.equal(timers.pending(), 1)
    off(); assert.equal(timers.pending(), 0, '預設的 cancel 也正常')
    starter.attach(); timers.advance(LINK_START_DELAY_MS)
    assert.deepEqual(runner.starts, [{ auto: false, at: 'fish', hold: false }])
  } finally { restore() }
})

// ---- 背景分頁載入的深連結：等分頁可見才啟動（否則背景時 rAF 不跑、計時器照換站，切回來已不是連結指的那一站）----
function hiddenDoc(hidden = true) {
  const L = new Set()
  const d = {
    hidden,
    addEventListener(type, fn) { if (d !== this) throw illegal(); if (type === 'visibilitychange') L.add(fn) },
    removeEventListener(type, fn) { if (d !== this) throw illegal(); if (type === 'visibilitychange') L.delete(fn) },
    setHidden(v) { d.hidden = v; for (const f of [...L]) f({}) },
    count: () => L.size,
  }
  return d
}
function linkKitDoc(doc, over = {}) {
  const timers = makeTimers()
  const { setTimeout: fakeSet, clearTimeout: fakeClear } = timers
  const store = fakeGovStore(GOV)
  const runner = { starts: [], start(o) { runner.starts.push(o); return true } }
  const starter = createLinkStarter({ runner, store, tourStore: { getState: () => ({ remote: false }) }, getSearch: () => '?tourstop=air', schedule: (fn, ms) => fakeSet(fn, ms), cancel: (id) => fakeClear(id), doc, ...over })
  return { timers, store, runner, starter }
}

test('連結啟動器：分頁在背景（Ctrl / Cmd + 點連結）→ 不排程、不啟動；變可見後才排程並「只」啟動一次', () => {
  const doc = hiddenDoc(true)
  const k = linkKitDoc(doc)
  const off = k.starter.attach()
  assert.equal(k.timers.pending(), 0, '背景：不排程'); assert.equal(doc.count(), 1, '訂閱 visibilitychange')
  k.timers.advance(60000); assert.equal(k.runner.starts.length, 0, '背景一整分鐘：導覽沒有被啟動、不會照時間換站'); assert.equal(k.starter.isDone(), false, '還沒試過')
  k.store.set({ gov: { options: [{ id: 'x' }] } }); assert.equal(k.timers.pending(), 0, '背景時 gov 變化也不排程')
  doc.setHidden(false)
  assert.equal(k.timers.pending(), 1, '可見了：排程'); k.timers.advance(LINK_START_DELAY_MS - 1); assert.equal(k.runner.starts.length, 0)
  k.timers.advance(1)
  assert.deepEqual(k.runner.starts, [{ auto: false, at: 'air', hold: false }]); assert.equal(k.starter.isDone(), true)
  doc.setHidden(true); doc.setHidden(false); k.timers.advance(10000); assert.equal(k.runner.starts.length, 1, '之後再切換可見不會重啟')
  off(); assert.equal(doc.count(), 0)
})

test('連結啟動器：排程之後、觸發之前被切到背景 → 這次不啟動（不算「試過」），回到前景再排一次；已可見時行為不變', () => {
  const doc = hiddenDoc(false)
  const k = linkKitDoc(doc)
  k.starter.attach(); assert.equal(k.timers.pending(), 1)
  doc.hidden = true                                                                  // 計時器到期前被切走（不一定有時間收到 visibilitychange）
  k.timers.advance(LINK_START_DELAY_MS)
  assert.equal(k.runner.starts.length, 0); assert.equal(k.starter.isDone(), false)
  doc.setHidden(false); k.timers.advance(LINK_START_DELAY_MS)
  assert.equal(k.runner.starts.length, 1)
  const v = linkKitDoc(hiddenDoc(false)); v.starter.attach(); v.timers.advance(LINK_START_DELAY_MS)
  assert.deepEqual(v.runner.starts, [{ auto: false, at: 'air', hold: false }], '可見分頁：與以前完全相同')
})

test('連結啟動器：StrictMode（attach / detach / attach）在背景分頁也不殘留 visibilitychange 監聽、不啟動兩次；detach 取消尚未觸發的啟動；沒有 document（Node / SSR）視為可見', () => {
  const doc = hiddenDoc(true)
  const k = linkKitDoc(doc)
  const off1 = k.starter.attach(); off1(); assert.equal(doc.count(), 0)
  const off2 = k.starter.attach(); assert.equal(doc.count(), 1)
  doc.setHidden(false); off2(); assert.equal(k.timers.pending(), 0, 'detach 取消尚未觸發的啟動'); assert.equal(doc.count(), 0)
  k.timers.advance(10000); assert.equal(k.runner.starts.length, 0)
  k.starter.attach(); doc.setHidden(true); doc.setHidden(false); k.timers.advance(LINK_START_DELAY_MS); assert.equal(k.runner.starts.length, 1)
  const nodoc = linkKitDoc(null); nodoc.starter.attach(); nodoc.timers.advance(LINK_START_DELAY_MS); assert.equal(nodoc.runner.starts.length, 1)
  const bad = linkKitDoc({ get hidden() { throw new Error('x') } }); bad.starter.attach(); bad.timers.advance(LINK_START_DELAY_MS); assert.equal(bad.runner.starts.length, 1, '讀 hidden 出錯 → 當作可見')
})

// =============================================================================================
// 複製此站連結
// =============================================================================================
const IDS_ALL = ['reservoir', 'tide', 'moon', 'dust', 'air', 'birds', 'fish', 'stations']
function copyKit({ running = true, index = 4, paused = false, stopList = IDS_ALL.map((id) => ({ id, caption: { key: id, p: {} } })), pushLog = true } = {}) {
  const lines = []
  const tourStore = { getState: () => ({ running, index, paused, stopList }) }
  const store = { getState: () => (pushLog ? { pushLog: (dir, text) => lines.push([dir, text]) } : {}) }
  return { lines, tourStore, store }
}

test('複製此站連結：連結指向目前這一站（站 id）、只帶 tourstop；成功 → \'ok\' + OUT 日誌「已複製第 n 站連結」', async () => {
  const env = makeCopyEnv({ clipboard: 'ok' })
  const k = copyKit({ index: 4 })
  const r = await copyTourLink({ tourStore: k.tourStore, store: k.store, getHref: () => 'https://midisea.shyetech.com/?kiosk=1&tour=0#remote=peer-1', env })
  assert.equal(r, 'ok')
  assert.equal(env.state.copied, 'https://midisea.shyetech.com/?tourstop=air')
  assert.deepEqual(k.lines, [['out', '已複製第 5 站連結']])
})

test('複製此站連結：暫停中 → 帶 tourhold=1（收到連結的人也停在那一站）；英文語系 → 帶 lang=en 與英文日誌', async () => {
  const env = makeCopyEnv()
  const k = copyKit({ index: 6, paused: true })
  assert.equal(await copyTourLink({ tourStore: k.tourStore, store: k.store, getHref: () => 'https://a.test/x/', env }), 'ok')
  assert.equal(env.state.copied, 'https://a.test/x/?tourstop=fish&tourhold=1')
  setLocale('en')
  try {
    const env2 = makeCopyEnv(), k2 = copyKit({ index: 1 })
    assert.equal(await copyTourLink({ tourStore: k2.tourStore, store: k2.store, getHref: () => 'https://a.test/', env: env2 }), 'ok')
    assert.equal(env2.state.copied, 'https://a.test/?tourstop=tide&lang=en')
    assert.deepEqual(k2.lines, [['out', 'Copied the link to stop 2']])
  } finally { setLocale('zh') }
})

test('複製此站連結：Clipboard 被拒 → 退回 textarea + execCommand 仍成功；兩者都失敗 → \'fail\' + OUT 日誌一行（不丟例外）', async () => {
  const env = makeCopyEnv({ clipboard: 'reject', exec: 'ok' }), k = copyKit()
  assert.equal(await copyTourLink({ tourStore: k.tourStore, store: k.store, getHref: () => 'https://a.test/', env }), 'ok')
  assert.equal(env.state.copied, 'https://a.test/?tourstop=air'); assert.equal(env.body.children.length, 0)
  const bad = makeCopyEnv({ clipboard: 'reject', exec: 'false' }), k2 = copyKit()
  assert.equal(await copyTourLink({ tourStore: k2.tourStore, store: k2.store, getHref: () => 'https://a.test/', env: bad }), 'fail')
  assert.deepEqual(k2.lines, [['out', '複製連結失敗：瀏覽器不允許存取剪貼簿']])
  const none = makeCopyEnv({ clipboard: 'none', exec: 'none' }), k3 = copyKit({ pushLog: false })     // store 沒有 pushLog 也不炸
  assert.equal(await copyTourLink({ tourStore: k3.tourStore, store: k3.store, getHref: () => 'https://a.test/', env: none }), 'fail')
})

test('複製此站連結：導覽沒在跑 / 找不到目前這一站 / 網址不合法 → \'none\'（不複製、不寫日誌）或 \'fail\'', async () => {
  for (const over of [{ running: false }, { index: 99 }, { stopList: [] }, { stopList: null }]) {
    const env = makeCopyEnv(), k = copyKit(over)
    assert.equal(await copyTourLink({ tourStore: k.tourStore, store: k.store, getHref: () => 'https://a.test/', env }), 'none', JSON.stringify(over))
    assert.deepEqual(env.calls, []); assert.deepEqual(k.lines, [])
  }
  const env = makeCopyEnv(), k = copyKit()
  assert.equal(await copyTourLink({ tourStore: k.tourStore, store: k.store, getHref: () => '', env }), 'fail', '網址讀不到 → 沒有連結可複製')
  assert.deepEqual(env.calls, [])
})

// =============================================================================================
// 接線 / 樣式（原始碼層級：沒有瀏覽器可跑 React / CSS，這裡守住規格明說的結構）
// =============================================================================================
const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2B06}\u{23E9}-\u{23FA}\u{FE0F}]/u
// 取出 @media (...) { ... } 區塊（大括號配對）
function mediaBlock(css, head) {
  const i = css.indexOf(head); assert.ok(i >= 0, `找不到 ${head}`)
  let depth = 0, j = css.indexOf('{', i)
  const start = j
  for (; j < css.length; j++) { if (css[j] === '{') depth++; else if (css[j] === '}') { depth--; if (!depth) break } }
  return css.slice(start, j + 1)
}

test('接線：TourService 掛上連結啟動器（linkStarter.attach，回傳取消函式給 useEffect）；快速鍵在 tourCore，不在元件', () => {
  const svc = src('./TourService.jsx')
  assert.match(svc, /useEffect\(\(\) => linkStarter\.attach\(\), \[\]\)/)
  assert.match(src('./tourCore.js'), /navKeyAction\(e\)/)
})

test('TourNav：每個按鈕都是 type="button" 且帶 data-tour-ui / aria-label / title；aria-pressed 用在暫停與念出字幕；旁白開關只在 supportsNarration() 時渲染；不用 emoji', () => {
  const nav = src('../ui/TourNav.jsx')
  const buttons = nav.match(/<button\b[\s\S]*?>/g) || []
  assert.equal(buttons.length, 5, '上一站 / 暫停·繼續 / 下一站 / 複製連結 / 念出字幕')
  for (const b of buttons) { assert.match(b, /type="button"/); assert.match(b, /data-tour-ui/); assert.match(b, /aria-label=/); assert.match(b, /title=/) }
  assert.equal((nav.match(/aria-pressed=/g) || []).length, 2)
  assert.match(nav, /canSpeak && \(/); assert.match(nav, /supportsNarration\(\)/)
  assert.match(nav, /tourRunner\.prev\(\)/); assert.match(nav, /tourRunner\.next\(\)/); assert.match(nav, /tourRunner\.pause\(\)/); assert.match(nav, /tourRunner\.resume\(\)/); assert.match(nav, /copyTourLink\(\)/)
  assert.match(nav, /clearTimeout\(timer\.current\)/, '「已複製」的計時器可取消')
  assert.match(nav, /alive\.current = false/, '卸載後不再排計時器')
  assert.match(nav, /onDoubleClick=\{stopDbl\}/, '連按「下一站」不會冒泡到 .canvas-wrap 的雙擊（切換演出模式）')
  for (const f of ['../ui/TourNav.jsx', '../ui/TourCaption.jsx', '../ui/TourControls.jsx', '../styles/tourpresenter.css']) assert.doesNotMatch(src(f), EMOJI, `${f} 不放 emoji`)
})

test('TourCaption：進度點在主視窗是真的 <button>（aria-label「第 n 站：標題」、目前站 aria-current="step"、點擊 goto）；觀眾視窗（remote）維持純顯示；「已暫停」小標與 data-paused', () => {
  const cap = src('../ui/TourCaption.jsx')
  assert.match(cap, /<button key=\{i\} type="button" className="tour-dotbtn" data-tour-ui aria-current=\{i === view\.index \? 'step' : undefined\}/)
  assert.match(cap, /tourRunner\.goto\(i\)/); assert.match(cap, /t\('第 \{n\} 站：\{title\}'/)
  assert.match(cap, /const interactive = !remote/); assert.match(cap, /aria-hidden="true"/, 'remote 的點列是 aria-hidden 純顯示')
  assert.match(cap, /data-paused=\{paused \? 'true' : undefined\}/); assert.match(cap, /\{paused && <span className="tour-paused">/)
  assert.match(cap, /role="status" aria-live="polite"/); assert.ok(cap.indexOf('role="status"') < cap.indexOf('<TourNav'), 'live region 只包字幕文字，控制列在外面')
  assert.match(cap, /\{interactive && <TourNav variant="caption" \/>\}/)
  assert.match(cap, /role="group" aria-label=\{t\('導覽進度（點一下跳到該站）'\)\} onDoubleClick=\{stopDbl\}/, '連點進度點不會冒泡到 .canvas-wrap 的雙擊')
})

test('樣式：字幕容器仍 pointer-events: none、按鈕才收事件；進度點按鈕熱區 ≥ 44px 且不撐高字幕；暫停時進度條 animation-play-state: paused；導覽按鈕 ≥ 40px', () => {
  const tour = src('../styles/tour.css'), pres = src('../styles/tourpresenter.css')
  assert.match(tour, /\.tour-caption \{[^}]*pointer-events: none/)
  assert.match(pres, /\.tour-cap \.tour-dotbtn \{[^}]*height: 44px;[^}]*pointer-events: auto/)
  assert.match(pres, /\.tour-cap \.tour-dotbtn \{[^}]*flex: 0 1 44px/)
  assert.match(pres, /\.tour-dots-nav \{[^}]*height: 7px/, '點列容器高度固定：熱區溢出但不撐高字幕')
  assert.match(pres, /\.tour-dot(\.cur)? \{/, '')
  assert.match(pres, /\.tour-caption\[data-paused='true'\] \.tour-dot\.cur b \{ animation-play-state: paused; \}/)
  assert.match(pres, /\.tour-nav \.tour-nb \{[^}]*min-width: 40px; height: 40px; min-height: 40px/)
  assert.match(pres, /\.tour-nav \.tour-nb \{[^}]*pointer-events: auto/)
  assert.match(tour, /\.tour-dot \{ position: relative; display: block; width: 7px; height: 7px;/, '視覺上仍是小點')
})

test('樣式：短螢幕橫向（max-height 460px 且 landscape）字幕改成靠左下的窄卡（max-width 44vw、字級縮小、說明最多 3 行）；手機直向與桌機的既有規則沒被動到', () => {
  const pres = src('../styles/tourpresenter.css'), tour = src('../styles/tour.css')
  const m = mediaBlock(pres, '@media (orientation: landscape) and (max-height: 460px)')
  assert.match(m, /\.tour-caption \{[^}]*left: 8px;[^}]*bottom: 8px;[^}]*transform: none;[^}]*max-width: 44vw/)
  assert.match(m, /\.tour-cap-body \{[^}]*font-size: 11px;[^}]*-webkit-line-clamp: 3; line-clamp: 3/)
  assert.match(m, /\.tour-cap-title \{ font-size: 13px; \}/)
  assert.match(m, /:has\(\.kiosk-qr\) \.tour-caption \{ left: 172px;/, '展場的掃碼 QR 在左下角：字幕往右讓開')
  // 既有規則（桌機 / ≤820px）原封不動：tour.css 仍是 translateX(-50%) 置中、bottom 46px / 40px、QR 上方 176px
  assert.match(tour, /\.tour-caption \{\s*position: absolute; left: 50%; bottom: 46px; transform: translateX\(-50%\)/)
  assert.match(mediaBlock(tour, '@media (max-width: 820px)'), /\.app\.stagemode \.canvas-wrap:has\(\.kiosk-qr\) \.tour-caption \{ bottom: 176px; \}/)
  assert.doesNotMatch(tour, /orientation: landscape/, '橫向規則只在 tourpresenter.css')
})

test('CSS 載入順序：每個 import tourpresenter.css 的元件都先 import tour.css（同權重時 tourpresenter.css 勝出）', () => {
  for (const f of ['../ui/TourNav.jsx', '../ui/TourCaption.jsx', '../ui/TourControls.jsx']) {
    const code = src(f)
    const a = code.indexOf("import '../styles/tour.css'"), b = code.indexOf("import '../styles/tourpresenter.css'")
    assert.ok(a >= 0 && b > a, f)
  }
})
