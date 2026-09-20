// 自動畫質執行期膠水（lib/qualityRuntime.js）單元測試。執行：node --test src/lib/qualityRuntime.test.mjs
// window / document / rAF / 計時器 / 時鐘全部是假的，由 env.run() 一幀一幀推進。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startQualityRuntime, DRAG_MS, STUCK_MS } from './qualityRuntime.js'
import { createQualityStore } from './qualityStore.js'

function makeEnv() {
  let t = 1000
  const winL = new Map(), docL = new Map()
  const add = (m) => (type, fn) => { if (!m.has(type)) m.set(type, new Set()); m.get(type).add(fn) }
  const rem = (m) => (type, fn) => { if (m.has(type)) m.get(type).delete(fn) }
  const emit = (m) => (type, ev = {}) => { for (const fn of [...(m.get(type) || [])]) fn(ev) }
  const count = (m) => [...m.values()].reduce((n, s) => n + s.size, 0)
  const win = { addEventListener: add(winL), removeEventListener: rem(winL), emit: emit(winL) }
  const doc = { hidden: false, capturing: false, addEventListener: add(docL), removeEventListener: rem(docL), emit: emit(docL), querySelector: () => (doc.capturing ? {} : null) }
  const rafs = new Map(); let rafSeq = 0
  const timers = new Map(); let tseq = 0
  const env = {
    win, doc, now: () => t,
    raf: (cb) => { const id = ++rafSeq; rafs.set(id, cb); return id },
    caf: (id) => { rafs.delete(id) },
    setInterval: (fn, ms) => { const id = ++tseq; timers.set(id, { fn, ms, at: t + ms, iv: true }); return id },
    setTimeout: (fn, ms) => { const id = ++tseq; timers.set(id, { fn, ms, at: t + ms, iv: false }); return id },
    clearInterval: (id) => { timers.delete(id) },
    clearTimeout: (id) => { timers.delete(id) },
    // 推進 seconds 秒、每秒 fps 幀：先跑到期的計時器，再呼叫 rAF（分頁隱藏時瀏覽器不呼叫 rAF）
    run(seconds, fps) {
      const dt = 1000 / fps, end = t + seconds * 1000
      while (t < end - 1e-6) {
        t += dt
        for (const [id, x] of [...timers]) {
          if (!timers.has(id)) continue
          while (x.at <= t) { x.fn(); if (x.iv) x.at += x.ms; else { timers.delete(id); break } }
        }
        if (!doc.hidden) { const cbs = [...rafs]; rafs.clear(); for (const [, cb] of cbs) cb(t) }
      }
    },
    skip(ms) { t += ms },   // 時間流逝但沒有幀（例如分頁隱藏）
    counts: () => ({ win: count(winL), doc: count(docL), raf: rafs.size, timers: timers.size }),
  }
  return env
}
function makeApp(mode = 'idle') {
  let state = { rec: { mode } }
  const subs = new Set()
  return { getState: () => state, subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn) }, setRec(m) { const prev = state; state = { rec: { mode: m } }; for (const fn of [...subs]) fn(state, prev) }, subs }
}
const memStorage = () => { const mem = new Map(); return { mem, getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) } }
function setup({ mode, rec } = {}) {
  const env = makeEnv()
  const store = createQualityStore({ storage: memStorage(), search: mode ? `?quality=${mode}` : '' })
  const app = makeApp(rec)
  const rt = startQualityRuntime({ store, appStore: app, win: env.win, doc: env.doc, now: env.now, raf: env.raf, caf: env.caf, setInterval: env.setInterval, clearInterval: env.clearInterval, setTimeout: env.setTimeout, clearTimeout: env.clearTimeout })
  return { env, store, app, rt, ctl: rt.controller }
}
const ptr = (id) => ({ pointerId: id })

test('rAF 餵幀：持續低 FPS → 降級並寫進 store（含原因）；每秒回報 FPS', () => {
  const { env, store, rt } = setup()
  env.run(4, 60)
  assert.equal(store.getState().tier, 'high')
  env.run(6, 20)
  assert.equal(store.getState().tier, 'medium')
  assert.equal(store.getState().reason.from, 'high')
  assert.equal(store.getState().reason.to, 'medium')
  assert.ok(Math.abs(store.getState().fps - 20) <= 1, `fps ${store.getState().fps}`)
  assert.equal(store.getState().paused, false)
  rt.stop()
})

test('分頁隱藏：暫停（不降級），回到前景後樣本歸零、不把停頓當低 FPS', () => {
  const { env, store, ctl, rt } = setup()
  env.run(9, 60)
  env.doc.hidden = true; env.doc.emit('visibilitychange')
  assert.equal(ctl.isPaused(), true)
  env.run(20, 5)                                            // 隱藏期間沒有 rAF；時間流逝
  assert.equal(store.getState().paused, true)
  assert.equal(store.getState().tier, 'high')
  env.doc.hidden = false; env.doc.emit('visibilitychange')
  assert.equal(ctl.isPaused(), false)
  env.run(10, 60)
  assert.equal(store.getState().tier, 'high')
  assert.equal(store.getState().paused, false)
  rt.stop()
})

test('錄製（rec.mode = recording）：暫停調整；結束後恢復', () => {
  const { env, store, app, ctl, rt } = setup()
  env.run(9, 60)
  app.setRec('recording')
  assert.equal(ctl.isPaused(), true)
  env.run(20, 10)
  assert.equal(store.getState().tier, 'high', '錄製中再慢也不降級')
  app.setRec('idle')
  assert.equal(ctl.isPaused(), false)
  env.run(6, 10)
  assert.equal(store.getState().tier, 'medium', '錄製結束後才判斷')
  rt.stop()
})

test('啟動時已在錄製：一開始就是暫停', () => {
  const { ctl, rt } = setup({ rec: 'recording' })
  assert.equal(ctl.isPaused(), true)
  rt.stop()
})

test('拖曳：輕點不暫停；按住超過 0.3 秒才暫停；全部放開才恢復；多指要全部放開', () => {
  const { env, store, ctl, rt } = setup()
  env.run(9, 60)
  env.win.emit('pointerdown', ptr(1)); env.run(0.15, 60); env.win.emit('pointerup', ptr(1))
  assert.equal(ctl.isPaused(), false, '輕點（< 0.3 秒）不算拖曳')
  env.run(0.5, 60)
  assert.equal(ctl.isPaused(), false, '輕點的計時器已被取消')
  env.win.emit('pointerdown', ptr(1)); env.win.emit('pointerdown', ptr(2))
  env.run(DRAG_MS / 1000 + 0.1, 60)
  assert.equal(ctl.isPaused(), true)
  env.run(20, 10)
  assert.equal(store.getState().tier, 'high', '拖曳中再慢也不降級')
  env.win.emit('pointerup', ptr(1))
  assert.equal(ctl.isPaused(), true, '還有一指按著')
  env.win.emit('pointerup', ptr(2))
  assert.equal(ctl.isPaused(), false)
  rt.stop()
})

test('拖曳中視窗失焦 / pointercancel 都會解除；事件遺失有 30 秒保險', () => {
  const { env, ctl, rt } = setup()
  env.win.emit('pointerdown', ptr(1)); env.run(0.5, 60)
  assert.equal(ctl.isPaused(), true)
  env.win.emit('blur')
  assert.equal(ctl.isPaused(), false)
  env.win.emit('pointerdown', ptr(2)); env.run(0.5, 60)
  assert.equal(ctl.isPaused(), true)
  env.win.emit('pointercancel', ptr(2))
  assert.equal(ctl.isPaused(), false)
  env.win.emit('pointerdown', ptr(3)); env.run(0.5, 60)
  assert.equal(ctl.isPaused(), true)
  env.run(STUCK_MS / 1000 + 2, 30)                          // 沒有任何 pointerup：保險把它當成已放開
  assert.equal(ctl.isPaused(), false)
  rt.stop()
})

test('錄影（錄影鈕 disabled）：每 0.5 秒輪詢，暫停 / 恢復', () => {
  const { env, ctl, rt } = setup()
  env.run(1, 60)
  assert.equal(ctl.isPaused(), false)
  env.doc.capturing = true
  env.run(1, 60)
  assert.equal(ctl.isPaused(), true)
  env.doc.capturing = false
  env.run(1, 60)
  assert.equal(ctl.isPaused(), false)
  rt.stop()
})

test('手動模式：store.setMode 通知狀態機；鎖定後不降級也不升級，切回自動保留等級', () => {
  const { env, store, ctl, rt } = setup()
  store.getState().setMode('low')
  assert.equal(ctl.getState(env.now()).mode, 'low')
  env.run(30, 10)
  assert.equal(store.getState().tier, 'low')
  env.run(30, 60)
  assert.equal(store.getState().tier, 'low', '手動鎖定不會被自動升級')
  store.getState().setMode('auto')
  assert.equal(ctl.getState(env.now()).mode, 'auto')
  assert.equal(store.getState().tier, 'low')
  rt.stop()
})

test('?quality= 網址覆寫：以覆寫的模式啟動，自動換級不寫入偏好', () => {
  const { env, store, rt } = setup({ mode: 'medium' })
  assert.equal(store.getState().mode, 'medium')
  assert.equal(store.getState().tier, 'medium')
  env.run(30, 10)
  assert.equal(store.getState().tier, 'medium')
  rt.stop()
})

test('stop()：取消 rAF、計時器與所有監聽，之後不再量測', () => {
  const { env, store, app, rt } = setup()
  env.run(2, 60)
  assert.ok(env.counts().win > 0 && env.counts().doc > 0 && env.counts().raf > 0 && env.counts().timers > 0)
  assert.equal(app.subs.size, 1)
  rt.stop()
  assert.deepEqual(env.counts(), { win: 0, doc: 0, raf: 0, timers: 0 })
  assert.equal(app.subs.size, 0)
  const before = store.getState().fps
  env.run(20, 10)
  assert.equal(store.getState().fps, before)
  assert.equal(store.getState().tier, 'high')
  store.getState().setMode('low')                            // stop 後改模式不會再打到狀態機（不丟例外即可）
  assert.equal(store.getState().tier, 'low')
})

test('沒有瀏覽器環境（node / SSR）：安全 no-op', () => {
  const store = createQualityStore({ storage: null, search: '' })
  const rt = startQualityRuntime({ store })
  assert.equal(rt.controller, null)
  rt.stop()
})

// ---- 觀眾視窗（?audience=1）：自己量 FPS 自己降級，但不寫共用偏好 ----
import { readFileSync } from 'node:fs'
import { LS_KEY } from './quality.js'

function audienceSetup({ search = '?audience=1', prefs } = {}) {
  const env = makeEnv()
  const storage = memStorage()
  if (prefs) storage.mem.set(LS_KEY, JSON.stringify(prefs))
  const store = createQualityStore({ storage, search })
  const rt = startQualityRuntime({ store, win: env.win, doc: env.doc, now: env.now, raf: env.raf, caf: env.caf, setInterval: env.setInterval, clearInterval: env.clearInterval, setTimeout: env.setTimeout, clearTimeout: env.clearTimeout })
  return { env, store, storage, rt }
}

test('觀眾視窗：投影機自己的 FPS 低 → 自己降級；偏好（與主視窗共用的 localStorage）不被覆寫', () => {
  const { env, store, storage, rt } = audienceSetup({ prefs: { mode: 'auto', tier: 'high' } })
  const before = storage.mem.get(LS_KEY)
  env.run(4, 60)
  env.run(30, 20)                                   // 主視窗順暢、投影機 20fps：只有這個視窗量得到
  assert.equal(store.getState().tier, 'low')
  assert.equal(storage.mem.get(LS_KEY), before, '觀眾視窗不寫偏好')
  store.getState().setMode('medium')
  assert.equal(storage.mem.get(LS_KEY), before, 'setMode 也不寫')
  rt.stop()
})

test('對照：一般（主）視窗降級會寫偏好；觀眾視窗仍會「讀」偏好當起跳等級', () => {
  const { env, store, storage, rt } = audienceSetup({ search: '' })
  env.run(4, 60); env.run(30, 20)
  assert.equal(store.getState().tier, 'low')
  assert.equal(JSON.parse(storage.mem.get(LS_KEY)).tier, 'low')
  rt.stop()
  const aud = createQualityStore({ storage, search: '?audience=1' })
  assert.equal(aud.getState().tier, 'low', '觀眾視窗以主視窗記住的等級起跳')
})

test('觀眾視窗網址帶 ?quality= → 鎖定該級，不隨 FPS 降級', () => {
  const { env, store, rt } = audienceSetup({ search: '?audience=1&quality=high' })
  env.run(4, 60); env.run(30, 20)
  assert.equal(store.getState().tier, 'high')
  assert.equal(store.getState().mode, 'high')
  rt.stop()
})

test('接線：AudienceApp 掛載自己的畫質執行期（先前只有主視窗的 Services 有）', () => {
  const src = readFileSync(new URL('../AudienceApp.jsx', import.meta.url), 'utf8')
  assert.match(src, /startQualityRuntime\(/)
})

// ---- 主視窗的畫質模式鏡像到觀眾視窗（已經開著的觀眾視窗也要跟著操作員的選擇）----
import { createQualityMirror } from './qualityStore.js'
import { getMirror } from './mirror.js'

test('鏡像：操作員在主視窗手動選「低」→ 已開著的觀眾視窗鎖定「低」（狀態機也被通知）；改回自動 → 觀眾視窗改用自己的 FPS', () => {
  const host = createQualityStore({ storage: memStorage(), search: '' })
  const hostSlice = createQualityMirror(host)
  const { env, store: aud, storage, rt } = audienceSetup({ prefs: { mode: 'auto', tier: 'high' } })
  const audSlice = createQualityMirror(aud)
  const before = storage.mem.get(LS_KEY)
  let notified = 0; const off = hostSlice.subscribe(() => notified++)
  env.run(4, 60)
  assert.equal(aud.getState().tier, 'high')
  host.getState().setMode('low')                                        // 操作員在「裝置 → 畫質」選低
  assert.equal(notified, 1); assert.deepEqual(hostSlice.get(), { mode: 'low' })
  audSlice.apply(hostSlice.get())                                        // BroadcastChannel 送過去
  assert.equal(aud.getState().mode, 'low'); assert.equal(aud.getState().tier, 'low')
  env.run(30, 60)
  assert.equal(aud.getState().tier, 'low', '鎖定：FPS 再高也不自動升級')
  assert.equal(storage.mem.get(LS_KEY), before, '觀眾視窗不寫偏好')
  host.getState().setMode('auto'); audSlice.apply(hostSlice.get())
  assert.equal(aud.getState().mode, 'auto'); assert.equal(aud.getState().tier, 'low', '改回自動：由目前等級接手')
  env.run(4, 60); env.run(30, 60)
  assert.equal(aud.getState().tier, 'high', '自動模式下觀眾視窗自己量 FPS 升回來（不是被主視窗鎖住）')
  off(); rt.stop()
})

test('鏡像：壞值 / 相同模式 / 空值都不動；已註冊到鏡像註冊表（quality）', () => {
  const s = createQualityStore({ storage: memStorage(), search: '?audience=1' })
  const slice = createQualityMirror(s)
  const ref = s.getState()
  for (const bad of [null, undefined, 'low', {}, { mode: 'ultra' }, { mode: 5 }, { mode: 'auto' }]) slice.apply(bad)
  assert.equal(s.getState(), ref, '狀態物件沒被換掉')
  assert.ok(getMirror('quality'), 'qualityStore 載入時註冊 quality 切片')
})

test('WebXR 期間暫停調整（window 的 midisea:xr 事件），結束後恢復；stop() 會移除這個監聽', () => {
  const { env, rt } = setup()
  const before = env.counts().win
  assert.ok(before >= 1)
  assert.deepEqual(rt.controller.getState(env.now()).pauseReasons, [])
  env.win.emit('midisea:xr', { detail: { active: true } })
  const paused = rt.controller.getState(env.now())
  assert.equal(paused.paused, true)
  assert.deepEqual(paused.pauseReasons, ['xr'])
  env.win.emit('midisea:xr', { detail: { active: false } })
  const resumed = rt.controller.getState(env.now())
  assert.equal(resumed.paused, false)
  assert.deepEqual(resumed.pauseReasons, [])
  env.win.emit('midisea:xr', {})                          // 壞事件（沒有 detail）不炸、視為結束
  assert.equal(rt.controller.getState(env.now()).paused, false)
  rt.stop()
  assert.equal(env.counts().win, 0)
})
