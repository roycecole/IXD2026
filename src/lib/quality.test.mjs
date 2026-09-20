// 自動畫質（lib/quality.js + lib/qualityStore.js）單元測試。執行：node --test src/lib/quality.test.mjs
// 全部用假時鐘（自己遞增的毫秒數）與假 storage，不碰 DOM / rAF。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TIERS, MODES, TIER_FX, DEFAULTS, LS_KEY,
  tierFx, stepTier, dprRange, normalizeTier, normalizeMode,
  createFpsWindow, createQualityController,
  parsePrefs, serializePrefs, readPrefs, writePrefs, initialTier, parseQueryMode, isFpsDebug,
} from './quality.js'
import { createQualityStore } from './qualityStore.js'

// 以固定 fps 餵 seconds 秒；回傳結束時間與這段期間發生的換級
function feedFor(ctl, t, seconds, fps) {
  const dt = 1000 / fps, end = t + seconds * 1000, events = []
  while (t < end - 1e-6) { t += dt; const r = ctl.feed(t, dt); if (r) events.push({ ...r, t }) }
  return { t, events }
}
// 一直餵到發生換級或超時；回傳 { t, ev }
function feedUntilChange(ctl, t, fps, maxSeconds = 120) {
  const dt = 1000 / fps, end = t + maxSeconds * 1000
  while (t < end) { t += dt; const r = ctl.feed(t, dt); if (r) return { t, ev: r } }
  return { t, ev: null }
}

test('等級表：high = 現況、逐級遞減；tierFx / stepTier / dprRange / normalize', () => {
  assert.deepEqual(TIERS, ['low', 'medium', 'high'])
  assert.deepEqual(MODES, ['auto', 'high', 'medium', 'low'])
  assert.deepEqual({ ...TIER_FX.high }, { dprMax: 2, particles: 1, creatures: 1, shootingStars: true, backdropBlur: true })
  assert.equal(TIER_FX.medium.dprMax, 1.5)
  assert.equal(TIER_FX.medium.particles, 0.7)
  assert.equal(TIER_FX.medium.creatures, 0.7)
  assert.equal(TIER_FX.medium.backdropBlur, true)
  assert.equal(TIER_FX.low.dprMax, 1)
  assert.equal(TIER_FX.low.creatures, 0.5)
  assert.equal(TIER_FX.low.shootingStars, false)
  assert.equal(TIER_FX.low.backdropBlur, false)
  assert.throws(() => { 'use strict'; TIER_FX.high.dprMax = 9 }, TypeError)   // 凍結
  assert.equal(tierFx('nope'), TIER_FX.high)
  assert.equal(stepTier('high', -1), 'medium')
  assert.equal(stepTier('medium', -1), 'low')
  assert.equal(stepTier('low', -1), 'low')
  assert.equal(stepTier('low', +1), 'medium')
  assert.equal(stepTier('high', +1), 'high')
  assert.deepEqual([...dprRange('high')], [1, 2])
  assert.deepEqual([...dprRange('medium')], [1, 1.5])
  assert.deepEqual([...dprRange('low')], [1, 1])
  assert.equal(dprRange('medium'), dprRange('medium'), 'identity 穩定')
  assert.equal(normalizeTier('x'), 'high')
  assert.equal(normalizeMode('x'), 'auto')
  assert.equal(normalizeMode('low'), 'low')
})

test('FPS 視窗：時間加權平均、涵蓋時間、修剪與清除', () => {
  const w = createFpsWindow(5000)
  assert.equal(w.stats(1000, 1000).fps, null)
  let t = 0
  for (let i = 0; i < 120; i++) { t += 1000 / 60; w.push(t, 1000 / 60) }   // 2 秒 60fps
  let s = w.stats(t, 1000)
  assert.ok(Math.abs(s.fps - 60) < 1, `fps ${s.fps}`)
  assert.ok(s.coverageMs >= 980 && s.coverageMs <= 1020)
  for (let i = 0; i < 30; i++) { t += 1000 / 30; w.push(t, 1000 / 30) }    // 1 秒 30fps
  s = w.stats(t, 1000)
  assert.ok(Math.abs(s.fps - 30) < 1)
  s = w.stats(t, 3000)                                                       // 前 2 秒 60 + 後 1 秒 30 → (120+30)/3 = 50
  assert.ok(Math.abs(s.fps - 50) < 1.5, `fps ${s.fps}`)
  // 舊資料超過 maxMs 會被修剪
  for (let i = 0; i < 600; i++) { t += 1000 / 60; w.push(t, 1000 / 60) }
  assert.ok(w.size() <= 5000 / (1000 / 60) + 2)
  w.clear()
  assert.equal(w.size(), 0)
  assert.equal(w.stats(t, 1000).fps, null)
})

test('暖機：前 5 秒（樣本時間）不判斷，之後低 FPS 才降級 high → medium', () => {
  const infos = []
  const ctl = createQualityController({ onChange: (tier, info) => infos.push([tier, info]) })
  let r = feedFor(ctl, 0, 4.9, 20)
  assert.equal(r.events.length, 0, '暖機期間不換級')
  assert.equal(ctl.getState(r.t).tier, 'high')
  r = feedFor(ctl, r.t, 2, 20)
  assert.equal(r.events.length, 1)
  assert.equal(r.events[0].kind, 'down')
  assert.equal(r.events[0].from, 'high')
  assert.equal(r.events[0].to, 'medium')
  assert.ok(Math.abs(r.events[0].fps - 20) < 1)
  assert.equal(r.events[0].windowMs, 3000)
  assert.equal(r.events[0].threshold, 40)
  assert.equal(infos.length, 1)
  assert.equal(infos[0][0], 'medium')
  const st = ctl.getState(r.t)
  assert.equal(st.tier, 'medium')
  assert.equal(st.reason.from, 'high')
  assert.equal(st.reason.to, 'medium')
  assert.equal(st.reason.threshold, 40)
})

test('降級要「連續 3 秒平均 < 40」：短暫掉幀不算，連續變慢才算', () => {
  const ctl = createQualityController()
  let r = feedFor(ctl, 0, 8, 60)                       // 暖機 + 穩定
  assert.equal(r.events.length, 0)
  r = feedFor(ctl, r.t, 1, 20)                          // 1 秒 20fps：3 秒平均 = (120+20)/3 ≈ 46.7 > 40
  assert.equal(r.events.length, 0)
  r = feedFor(ctl, r.t, 4, 60)
  assert.equal(r.events.length, 0)
  const start = r.t
  const res = feedUntilChange(ctl, start, 25)           // 持續 25fps：約 2 秒後 3 秒平均 < 40
  assert.ok(res.ev && res.ev.kind === 'down')
  assert.ok(res.t - start >= 1900 && res.t - start <= 3300, `耗時 ${res.t - start}`)
})

test('連續降到 low 就停；low 不再往下', () => {
  const ctl = createQualityController()
  let t = 0
  const path = []
  for (let i = 0; i < 4; i++) { const r = feedUntilChange(ctl, t, 15, 60); t = r.t; if (r.ev) path.push(r.ev.to) }
  assert.deepEqual(path, ['medium', 'low'])
  const r = feedFor(ctl, t, 30, 10)
  assert.equal(r.events.length, 0)
  assert.equal(ctl.getState(r.t).tier, 'low')
})

test('最短停留 10 秒：換級後即使一直很慢，下一次換級至少隔 10 秒', () => {
  const ctl = createQualityController()
  const a = feedUntilChange(ctl, 0, 15)
  assert.equal(a.ev.to, 'medium')
  const b = feedUntilChange(ctl, a.t, 15)
  assert.equal(b.ev.to, 'low')
  assert.ok(b.t - a.t >= 10000, `隔 ${b.t - a.t}`)
  assert.ok(b.t - a.t < 14000, `不應拖太久：${b.t - a.t}`)
})

test('遲滯：40 ~ 55 FPS 之間什麼都不做（各等級都一樣）', () => {
  for (const startTier of ['high', 'medium', 'low']) {
    const ctl = createQualityController({ startTier })
    const r = feedFor(ctl, 0, 90, 48)
    assert.equal(r.events.length, 0, startTier)
    assert.equal(ctl.getState(r.t).tier, startTier)
  }
})

test('升級：連續 8 秒平均 > 55 才升一級，一次只升一級', () => {
  const ctl = createQualityController({ startTier: 'low' })
  const a = feedUntilChange(ctl, 0, 60)
  assert.equal(a.ev.kind, 'up')
  assert.equal(a.ev.from, 'low')
  assert.equal(a.ev.to, 'medium')
  assert.ok(a.t >= 7600 && a.t <= 9000, `第一次升級時間 ${a.t}`)
  const b = feedUntilChange(ctl, a.t, 60)
  assert.equal(b.ev.to, 'high')
  assert.ok(b.t - a.t >= 10000, `升級後最短停留：${b.t - a.t}`)
  const c = feedFor(ctl, b.t, 60, 60)
  assert.equal(c.events.length, 0, 'high 不再往上')
})

test('升級冷卻：降級後要等 30 秒才嘗試升級（即使 FPS 立刻很好）', () => {
  const ctl = createQualityController()
  const down = feedUntilChange(ctl, 0, 20)
  assert.equal(down.ev.kind, 'down')
  const up = feedUntilChange(ctl, down.t, 60)
  assert.equal(up.ev.kind, 'up')
  assert.ok(up.t - down.t >= 30000, `降級後 ${up.t - down.t} ms 就升級`)
  assert.ok(up.t - down.t <= 33000, `升級不該再拖：${up.t - down.t}`)
})

test('抖動保護：升上去又馬上掉下來 → 下次升級冷卻倍增（30 → 60 秒）', () => {
  const ctl = createQualityController({ startTier: 'medium' })
  const up = feedUntilChange(ctl, 0, 60)
  assert.equal(up.ev.kind, 'up')
  const down = feedUntilChange(ctl, up.t, 15)           // 升級後撐不住
  assert.equal(down.ev.kind, 'down')
  assert.ok(down.t - up.t < DEFAULTS.flapMs)
  assert.equal(ctl.getState(down.t).failedUps, 1)
  const up2 = feedUntilChange(ctl, down.t, 60, 200)
  assert.equal(up2.ev.kind, 'up')
  assert.ok(up2.t - down.t >= 60000, `第二次升級冷卻應為 60 秒，實際 ${up2.t - down.t}`)
})

test('穩定夠久後抖動計數歸零', () => {
  const ctl = createQualityController({ startTier: 'medium' })
  const up = feedUntilChange(ctl, 0, 60)
  const down = feedUntilChange(ctl, up.t, 15)
  assert.equal(ctl.getState(down.t).failedUps, 1)
  const r = feedFor(ctl, down.t, 130, 48)               // 在死區停留 > 2 分鐘，沒有任何換級
  assert.equal(r.events.length, 0)
  const s = ctl.getState(r.t)
  assert.equal(s.tier, 'medium')
  // 下一次評估時歸零：再餵幾個幀即可
  feedFor(ctl, r.t, 1, 48)
  assert.equal(ctl.getState(r.t + 1000).failedUps, 0)
})

test('手動覆寫：鎖定等級、狀態機不動作、只繼續量 FPS；切回自動由目前等級接手', () => {
  const infos = []
  const ctl = createQualityController({ mode: 'low', onChange: (tier, info) => infos.push([tier, info.kind]) })
  assert.equal(ctl.getState(0).tier, 'low')
  assert.equal(ctl.getState(0).mode, 'low')
  let r = feedFor(ctl, 0, 40, 60)                        // 手動 low，FPS 很好也不升
  assert.equal(r.events.length, 0)
  assert.equal(ctl.getState(r.t).tier, 'low')
  assert.equal(ctl.getState(r.t).fps, 60)
  let ev = ctl.setMode('high', r.t)                      // 手動改 high
  assert.equal(ev.kind, 'manual')
  assert.equal(ev.from, 'low')
  assert.equal(ev.to, 'high')
  assert.deepEqual(infos, [['high', 'manual']])
  r = feedFor(ctl, r.t, 40, 10)                          // 手動 high，FPS 再差也不降
  assert.equal(r.events.length, 0)
  assert.equal(ctl.getState(r.t).tier, 'high')
  assert.equal(ctl.setMode('high', r.t), null, '同等級不重複通知')
  assert.equal(ctl.setMode('auto', r.t), null)
  assert.equal(ctl.getState(r.t).mode, 'auto')
  assert.equal(ctl.getState(r.t).tier, 'high')
  const s = r.t
  const res = feedUntilChange(ctl, s, 10)                // 自動接手後 FPS 仍差 → 降級，但要先過最短停留
  assert.equal(res.ev.kind, 'down')
  assert.ok(res.t - s >= 10000, `切回自動後最短停留：${res.t - s}`)
  assert.equal(ctl.getState(res.t).tier, 'medium')
})

test('手動覆寫不算「自動降級」：reason 不被改寫', () => {
  const ctl = createQualityController()
  ctl.setMode('low', 0)
  assert.equal(ctl.getState(0).reason, null)
})

test('暫停：暫停期間的樣本不計入判斷；解除後視窗歸零重量；多個原因要全部解除', () => {
  const ctl = createQualityController({ startTier: 'medium' })
  let r = feedFor(ctl, 0, 4, 60)                          // 未過暖機
  ctl.pause('hidden', r.t)
  ctl.pause('drag', r.t)
  assert.equal(ctl.isPaused(), true)
  const p = feedFor(ctl, r.t, 20, 60)                     // 暫停期間 20 秒好 FPS：不計、不換級
  assert.equal(p.events.length, 0)
  assert.equal(ctl.getState(p.t).sampledMs < 4200, true)
  assert.equal(ctl.getState(p.t).fps, 60, '暫停中仍量得到目前 FPS（顯示用）')
  ctl.resume('hidden', p.t)
  assert.equal(ctl.isPaused(), true, 'drag 還沒解除')
  ctl.resume('drag', p.t)
  assert.equal(ctl.isPaused(), false)
  let q = feedFor(ctl, p.t, 2, 60)                        // 解除後只有 2 秒資料，撐不起 8 秒視窗
  assert.equal(q.events.length, 0)
  q = feedFor(ctl, q.t, 6.5, 60)
  assert.equal(q.events.length, 1, '滿 8 秒後升級')
  assert.equal(q.events[0].kind, 'up')
})

test('暫停期間 FPS 再差也不降級', () => {
  const ctl = createQualityController()
  let r = feedFor(ctl, 0, 8, 60)
  ctl.pause('rec', r.t)
  r = feedFor(ctl, r.t, 30, 10)
  assert.equal(r.events.length, 0)
  ctl.resume('rec', r.t)
  assert.equal(ctl.getState(r.t).tier, 'high')
})

test('斷點：單一幀 dt > 1 秒 → 視窗歸零，不把停頓當成低 FPS', () => {
  const ctl = createQualityController()
  let r = feedFor(ctl, 0, 8, 60)
  r = feedFor(ctl, r.t, 1.5, 25)                           // 1.5 秒慢：3 秒平均 = (90 + 37.5) / 3 ≈ 42.5，還沒到降級門檻
  assert.equal(r.events.length, 0)
  assert.equal(ctl.feed(r.t + 5000, 5000), null)           // 5 秒斷點
  let t = r.t + 5000
  r = feedFor(ctl, t, 2, 25)                               // 斷點後又慢 2 秒：視窗只有 2 秒（斷點前的慢幀已丟棄），還不能判斷
  assert.equal(r.events.length, 0)
  r = feedFor(ctl, r.t, 1.5, 25)                           // 連續滿約 3 秒 → 降級
  assert.equal(r.events.length, 1)
  assert.equal(r.events[0].kind, 'down')
})

test('無效樣本（NaN / 0 / 負數 dt）被忽略', () => {
  const ctl = createQualityController()
  assert.equal(ctl.feed(NaN, 16), null)
  assert.equal(ctl.feed(100, 0), null)
  assert.equal(ctl.feed(100, -5), null)
  assert.equal(ctl.feed(100, NaN), null)
  assert.equal(ctl.getState(100).fps, null)
  assert.equal(ctl.getState(100).sampledMs, 0)
})

test('偏好：parsePrefs / serializePrefs 相容多種格式、壞資料退回預設', () => {
  assert.deepEqual(parsePrefs('{"mode":"auto","tier":"medium"}'), { mode: 'auto', tier: 'medium' })
  assert.deepEqual(parsePrefs('"low"'), { mode: 'low', tier: 'low' })
  assert.deepEqual(parsePrefs('low'), { mode: 'low', tier: 'low' })
  assert.deepEqual(parsePrefs('auto'), { mode: 'auto', tier: 'high' })
  assert.deepEqual(parsePrefs('{"mode":"zzz","tier":"yyy"}'), { mode: 'auto', tier: 'high' })
  assert.deepEqual(parsePrefs(null), { mode: 'auto', tier: 'high' })
  assert.deepEqual(parsePrefs('{壞掉'), { mode: 'auto', tier: 'high' })
  assert.deepEqual(JSON.parse(serializePrefs({ mode: 'auto', tier: 'medium' })), { mode: 'auto', tier: 'medium' })
  assert.deepEqual(JSON.parse(serializePrefs({ mode: 'bad', tier: 'bad' })), { mode: 'auto', tier: 'high' })
  assert.equal(initialTier({ mode: 'auto', tier: 'medium' }), 'medium')
  assert.equal(initialTier({ mode: 'low', tier: 'high' }), 'low')
  assert.equal(LS_KEY, 'ixd2026.quality')
})

test('偏好讀寫：注入假 storage；storage 丟例外 / 不存在都不能壞', () => {
  const mem = new Map()
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) }
  assert.deepEqual(readPrefs(storage), { mode: 'auto', tier: 'high' })
  assert.equal(writePrefs({ mode: 'auto', tier: 'medium' }, storage), true)
  assert.deepEqual(readPrefs(storage), { mode: 'auto', tier: 'medium' })
  assert.ok(mem.has('ixd2026.quality'))
  const bad = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  assert.deepEqual(readPrefs(bad), { mode: 'auto', tier: 'high' })
  assert.equal(writePrefs({ mode: 'low', tier: 'low' }, bad), false)
  assert.deepEqual(readPrefs(null), { mode: 'auto', tier: 'high' })
  assert.equal(writePrefs({ mode: 'low', tier: 'low' }, null), false)
})

test('網址參數：?quality= 與 ?fps=1', () => {
  assert.equal(parseQueryMode('?quality=low'), 'low')
  assert.equal(parseQueryMode('?a=1&quality=HIGH'), 'high')
  assert.equal(parseQueryMode('?quality=ultra'), null)
  assert.equal(parseQueryMode(''), null)
  assert.equal(parseQueryMode(undefined), null)
  assert.equal(isFpsDebug('?fps=1'), true)
  assert.equal(isFpsDebug('?fps=0'), false)
  assert.equal(isFpsDebug(''), false)
})

// ---------- store ----------
const memStorage = (init = {}) => {
  const mem = new Map(Object.entries(init))
  return { mem, getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) }
}

test('store：初始值來自偏好；自動模式從上次的等級起跳；?quality= 覆寫不寫入偏好', () => {
  const s1 = createQualityStore({ storage: memStorage({ 'ixd2026.quality': '{"mode":"auto","tier":"medium"}' }), search: '' })
  assert.equal(s1.getState().mode, 'auto')
  assert.equal(s1.getState().tier, 'medium')
  const s2 = createQualityStore({ storage: memStorage({ 'ixd2026.quality': '"low"' }), search: '' })
  assert.equal(s2.getState().mode, 'low')
  assert.equal(s2.getState().tier, 'low')
  const st = memStorage()
  const s3 = createQualityStore({ storage: st, search: '?quality=low' })
  assert.equal(s3.getState().mode, 'low')
  assert.equal(s3.getState().overridden, true)
  s3.getState().applyChange('medium', { kind: 'up', from: 'low', to: 'medium', fps: 60, windowMs: 8000 })
  assert.equal(st.mem.size, 0, '網址覆寫時，自動換級不寫入偏好')
  s3.getState().setMode('high')
  assert.equal(s3.getState().overridden, false)
  assert.deepEqual(JSON.parse(st.mem.get('ixd2026.quality')), { mode: 'high', tier: 'high' })
})

test('store：setMode 手動鎖等級並存偏好；切回自動保留等級', () => {
  const st = memStorage()
  const s = createQualityStore({ storage: st, search: '' })
  assert.equal(s.getState().tier, 'high')
  s.getState().setMode('low')
  assert.equal(s.getState().tier, 'low')
  assert.deepEqual(JSON.parse(st.mem.get('ixd2026.quality')), { mode: 'low', tier: 'low' })
  s.getState().setMode('auto')
  assert.equal(s.getState().mode, 'auto')
  assert.equal(s.getState().tier, 'low')
  assert.deepEqual(JSON.parse(st.mem.get('ixd2026.quality')), { mode: 'auto', tier: 'low' })
  s.getState().setMode('bogus')
  assert.equal(s.getState().mode, 'auto')
})

test('store：自動降級記下原因（含牆鐘時間）並存下等級；升級只換等級不動原因', () => {
  const st = memStorage()
  const s = createQualityStore({ storage: st, search: '' })
  const before = Date.now()
  s.getState().applyChange('medium', { kind: 'down', from: 'high', to: 'medium', fps: 31.5, windowMs: 3000, threshold: 40 })
  const r = s.getState().reason
  assert.equal(s.getState().tier, 'medium')
  assert.equal(r.from, 'high'); assert.equal(r.to, 'medium'); assert.equal(r.fps, 31.5); assert.equal(r.windowMs, 3000); assert.equal(r.threshold, 40)
  assert.ok(r.at >= before && r.at <= Date.now())
  assert.deepEqual(JSON.parse(st.mem.get('ixd2026.quality')), { mode: 'auto', tier: 'medium' })
  s.getState().applyChange('high', { kind: 'up', from: 'medium', to: 'high', fps: 60, windowMs: 8000, threshold: 55 })
  assert.equal(s.getState().tier, 'high')
  assert.equal(s.getState().reason, r, '升級不改寫「上次自動降級」')
})

test('store：report 只在值改變時通知；同等級重複通知不觸發訂閱', () => {
  const s = createQualityStore({ storage: memStorage(), search: '' })
  let n = 0
  const un = s.subscribe(() => { n++ })
  s.getState().report({ fps: 58, paused: false })
  s.getState().report({ fps: 58, paused: false })
  assert.equal(n, 1)
  s.getState().report({ fps: 57, paused: true })
  assert.equal(n, 2)
  s.getState().applyChange('high', { kind: 'manual', from: 'high', to: 'high' })
  assert.equal(n, 2, '等級沒變 → 不通知')
  un()
})

test('整合：狀態機的換級回呼寫進 store，手動模式改變透過 setMode 傳回狀態機', () => {
  const s = createQualityStore({ storage: memStorage(), search: '' })
  const ctl = createQualityController({ mode: s.getState().mode, startTier: s.getState().tier, onChange: (tier, info) => s.getState().applyChange(tier, info) })
  const r = feedUntilChange(ctl, 0, 20)
  assert.equal(r.ev.kind, 'down')
  assert.equal(s.getState().tier, 'medium')
  assert.equal(s.getState().reason.to, 'medium')
  // 使用者在 UI 選「低」：store 先變，Service 訂閱後呼叫 ctl.setMode
  s.getState().setMode('low')
  ctl.setMode(s.getState().mode, r.t)
  assert.equal(ctl.getState(r.t).tier, 'low')
  assert.equal(s.getState().tier, 'low')
  const rest = feedFor(ctl, r.t, 30, 60)
  assert.equal(rest.events.length, 0, '手動鎖定不會被自動升級')
})
