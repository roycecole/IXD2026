// 取景偏好（lib/viewPrefs.js）與「裝置 → 取景」一節（ui/devices/ViewSection.jsx）的單元測試。執行：node --test src/lib/viewPrefs.test.mjs
// 涵蓋：?fit= 解析、網址 / 偏好 / 預設的優先序、非法值、儲存丟例外、訂閱式狀態（setMode / setCanvas / 通知）、
// 「會檢查 this 的假 localStorage / location」（瀏覽器的 Illegal invocation 在 Node 看不到）、import 時不碰瀏覽器 API、
// 以及 ViewSection 的 SSR 標記（中 / 英文；預設 / 網址覆寫 / ?fit=0 / 寬螢幕 / 窄畫布 / 無障礙）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { loadEnDict } from '../../scripts/i18n-check.mjs'
import { registerEn, setLocale, useLocaleStore } from '../i18n/index.js'
import { LS } from './persist.js'
import { fitEnabled } from './cameraFit.js'
import {
  VIEW_MODES, DEFAULT_VIEW, isViewMode, parseFitParam, readViewPref, saveViewPref, resolveView, viewMattersAt, createViewState, getViewState,
} from './viewPrefs.js'
import { importJsx, liveSsr, illegal } from './tourTestEnv.mjs'

const { dict } = await loadEnDict()
registerEn(dict)

// ---- 假 storage：方法都檢查 this（脫離物件呼叫會丟 Illegal invocation，與瀏覽器一致）----
class StrictStorage {
  constructor(init = {}) { this.m = new Map(Object.entries(init)); this.log = [] }
  getItem(k) { if (!(this instanceof StrictStorage)) throw illegal(); this.log.push(['get', k]); return this.m.has(k) ? this.m.get(k) : null }
  setItem(k, v) { if (!(this instanceof StrictStorage)) throw illegal(); this.log.push(['set', k, v]); this.m.set(k, String(v)) }
  removeItem(k) { if (!(this instanceof StrictStorage)) throw illegal(); this.m.delete(k) }
}
class ThrowingStorage {                                    // 隱私模式 / 被擋：讀寫都丟例外
  getItem() { throw new Error('SecurityError') }
  setItem() { throw new Error('QuotaExceededError') }
}
function withGlobal(name, value, fn) {                     // 暫時替換全域（Node 25 內建 localStorage getter 不可用，所以一律換成假的）
  const desc = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  try { return fn() } finally { if (desc) Object.defineProperty(globalThis, name, desc); else delete globalThis[name] }
}
const stripHtml = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

// =============================================================================================
// 常數與 ?fit= 解析
// =============================================================================================
test('常數：兩種模式（完整 / 填滿），預設 full；isViewMode 只認 full / fill（區分大小寫）', () => {
  assert.deepEqual(VIEW_MODES, ['full', 'fill'])
  assert.equal(DEFAULT_VIEW, 'full')
  for (const m of VIEW_MODES) assert.equal(isViewMode(m), true)
  for (const v of ['FULL', 'Fill', '', 'auto', 0, 1, null, undefined, {}, [], true, NaN]) assert.equal(isViewMode(v), false, String(v))
  assert.equal(LS.view, 'ixd2026.view')
})

test('parseFitParam：?fit=full|1 → full；?fit=fill → fill；?fit=0/false/off/no → 關閉；其他值 / 沒有參數 = 沒有覆寫（不分大小寫）', () => {
  const none = { off: false, mode: null, param: null }
  assert.deepEqual(parseFitParam('?fit=fill'), { off: false, mode: 'fill', param: 'fill' })
  assert.deepEqual(parseFitParam('?fit=FILL'), { off: false, mode: 'fill', param: 'fill' })
  assert.deepEqual(parseFitParam('?x=1&fit=full'), { off: false, mode: 'full', param: 'full' })
  assert.deepEqual(parseFitParam('?fit=Full'), { off: false, mode: 'full', param: 'full' })
  assert.deepEqual(parseFitParam('?fit=1'), { off: false, mode: 'full', param: '1' })              // ?fit=1 視為 full
  assert.deepEqual(parseFitParam('fit=fill'), { off: false, mode: 'fill', param: 'fill' })          // 沒有 ? 也行（URLSearchParams）
  for (const [s, p] of [['?fit=0', '0'], ['?fit=false', 'false'], ['?fit=OFF', 'off'], ['?fit=No', 'no'], ['?a=b&fit=0', '0']]) assert.deepEqual(parseFitParam(s), { off: true, mode: null, param: p }, s)
  for (const s of ['', '?', '?x=1', '?fit', '?fit=', '?fit=on', '?fit=true', '?fit=yes', '?fit=2', '?fit=fullscreen', '?fit=fill2', '?fits=fill', '?FIT=fill', '?fit=%20fill']) assert.deepEqual(parseFitParam(s), none, s)
  for (const s of [undefined, null, 0, NaN, {}, [], false]) assert.doesNotThrow(() => parseFitParam(s), String(s))
  assert.deepEqual(parseFitParam(undefined), none)
})

test('parseFitParam 的「關閉」判斷與 cameraFit.fitEnabled 是同一份（不會各說各話）', () => {
  for (const s of ['?fit=0', '?fit=false', '?fit=OFF', '?fit=No', '', '?fit', '?fit=1', '?fit=on', '?fit=full', '?fit=fill', '?fit=2', '?x=1', '?fit=%200', undefined, null]) {
    assert.equal(parseFitParam(s).off, !fitEnabled(s), String(s))
  }
})

test('parseFitParam：param 只會是白名單值（可安全顯示在面板上）——即使網址塞了奇怪的字元', () => {
  for (const s of ['?fit=<script>', '?fit=fill"onload=x', '?fit=%3Cb%3E', '?fit=fill%00']) assert.equal(parseFitParam(s).param, null, s)
  for (const s of ['?fit=0', '?fit=FALSE', '?fit=Off', '?fit=nO', '?fit=fill', '?fit=1', '?fit=full']) assert.match(parseFitParam(s).param, /^(0|false|off|no|fill|full|1)$/, s)
})

// =============================================================================================
// 偏好讀寫
// =============================================================================================
test('readViewPref：合法值原樣回傳；沒存過 / 非法值 / 型別錯誤 → 預設 full；load 丟例外 → 預設 full；讀的是 LS.view', () => {
  const seen = []
  const load = (v) => (k, fb) => { seen.push([k, fb]); return v }
  assert.equal(readViewPref(load('fill')), 'fill')
  assert.equal(readViewPref(load('full')), 'full')
  assert.deepEqual(seen[0], [LS.view, null])
  for (const v of [null, undefined, 'FILL', 'auto', '', 1, 0, {}, [], true, NaN, 'fill ']) assert.equal(readViewPref(load(v)), 'full', String(v))
  assert.equal(readViewPref(() => { throw new Error('boom') }), 'full')
})

test('readViewPref / saveViewPref 預設路徑（persist.js 的 loadLS / saveLS）：以會檢查 this 的假 localStorage 往返；壞掉的 JSON / 被擋的 storage 都退回預設', () => {
  const st = new StrictStorage()
  withGlobal('localStorage', st, () => {
    assert.equal(readViewPref(), 'full')
    assert.equal(saveViewPref('fill'), true)
    assert.equal(st.m.get(LS.view), '"fill"')                                  // JSON 字串（與 loadLS 的 JSON.parse 對得上）
    assert.equal(readViewPref(), 'fill')
    assert.equal(saveViewPref('full'), true)
    assert.equal(readViewPref(), 'full')
    assert.equal(saveViewPref('bogus'), false)                                 // 非法值不寫
    assert.equal(st.m.get(LS.view), '"full"')
    st.m.set(LS.view, 'fill')                                                  // 壞掉的 JSON（沒有引號）
    assert.equal(readViewPref(), 'full')
    st.m.set(LS.view, '"weird"')
    assert.equal(readViewPref(), 'full')
  })
  withGlobal('localStorage', new ThrowingStorage(), () => {
    assert.equal(readViewPref(), 'full')                                       // 隱私模式：讀丟例外 → 預設
    assert.doesNotThrow(() => saveViewPref('fill'))                            // 寫丟例外 → 不崩潰
  })
})

test('saveViewPref：合法值 → 呼叫 save(LS.view, mode) 並回 true；非法值 → 不呼叫、回 false；save 丟例外 → 回 false（不丟）', () => {
  const calls = []
  assert.equal(saveViewPref('fill', (k, v) => calls.push([k, v])), true)
  assert.equal(saveViewPref('full', (k, v) => calls.push([k, v])), true)
  assert.deepEqual(calls, [[LS.view, 'fill'], [LS.view, 'full']])
  for (const v of ['x', '', null, undefined, 1, {}, 'FILL']) assert.equal(saveViewPref(v, () => calls.push('bad')), false, String(v))
  assert.equal(calls.length, 2)
  assert.equal(saveViewPref('fill', () => { throw new Error('quota') }), false)
})

// =============================================================================================
// 優先序：網址 > 偏好 > 預設
// =============================================================================================
test('resolveView 優先序：網址 ?fit=full|fill|1 > 偏好 > 預設；?fit=0 關閉自動取景（模式仍是偏好）；非法偏好 → 預設', () => {
  const r = (search, pref) => resolveView({ search, pref })
  // 沒有網址參數：偏好
  assert.deepEqual(r('', 'fill'), { mode: 'fill', pref: 'fill', enabled: true, override: null, param: null })
  assert.deepEqual(r('', 'full'), { mode: 'full', pref: 'full', enabled: true, override: null, param: null })
  assert.deepEqual(r('', undefined), { mode: 'full', pref: 'full', enabled: true, override: null, param: null })
  for (const bad of ['x', null, 1, {}, 'FILL']) assert.equal(r('', bad).mode, 'full', String(bad))
  assert.equal(r('', 'x').pref, 'full')
  // 網址覆寫偏好（兩個方向）
  assert.deepEqual(r('?fit=fill', 'full'), { mode: 'fill', pref: 'full', enabled: true, override: 'fill', param: 'fill' })
  assert.deepEqual(r('?fit=full', 'fill'), { mode: 'full', pref: 'fill', enabled: true, override: 'full', param: 'full' })
  assert.deepEqual(r('?fit=1', 'fill'), { mode: 'full', pref: 'fill', enabled: true, override: 'full', param: '1' })
  // ?fit=0：關閉，偏好不變
  assert.deepEqual(r('?fit=0', 'fill'), { mode: 'fill', pref: 'fill', enabled: false, override: 'off', param: '0' })
  assert.equal(r('?fit=off', 'full').enabled, false)
  // 其他網址值 = 沒有覆寫
  assert.deepEqual(r('?fit=on', 'fill'), { mode: 'fill', pref: 'fill', enabled: true, override: null, param: null })
  assert.doesNotThrow(() => resolveView())
  assert.deepEqual(resolveView(), { mode: 'full', pref: 'full', enabled: true, override: null, param: null })
})

test('viewMattersAt：寬螢幕（>= 約 0.95）兩種取景沒有差別；窄畫布有；量不到 → null', () => {
  for (const a of [0.9516, 1, 4 / 3, 16 / 9, 3]) assert.equal(viewMattersAt(a), false, String(a))
  for (const a of [0.9, 0.8, 0.75, 375 / 812, 0.3, 0.2]) assert.equal(viewMattersAt(a), true, String(a))
  assert.equal(viewMattersAt(0.05), false)                                   // 極端窄（< 約 0.09）兩種都撞到倍率上限 6 → 一樣
  for (const a of [0, -1, NaN, Infinity, undefined, null, '1', {}]) assert.equal(viewMattersAt(a), null, String(a))
})

// =============================================================================================
// 訂閱式狀態
// =============================================================================================
const mkSave = () => { const calls = []; const save = (k, v) => calls.push([k, v]); save.calls = calls; return save }
const mkLoad = (v) => () => v

test('createViewState 初始：偏好 / 網址 / 預設的組合；建立時絕不寫入偏好（網址只覆寫這一次）', () => {
  const save = mkSave()
  const s1 = createViewState({ search: '', load: mkLoad('fill'), save })
  assert.deepEqual({ ...s1.get() }, { mode: 'fill', pref: 'fill', enabled: true, override: null, param: null, affects: null })
  const s2 = createViewState({ search: '?fit=fill', load: mkLoad('full'), save })
  assert.deepEqual({ ...s2.get() }, { mode: 'fill', pref: 'full', enabled: true, override: 'fill', param: 'fill', affects: null })
  const s3 = createViewState({ search: '?fit=0', load: mkLoad('fill'), save })
  assert.deepEqual({ ...s3.get() }, { mode: 'fill', pref: 'fill', enabled: false, override: 'off', param: '0', affects: false })
  const s4 = createViewState({ search: '', load: () => { throw new Error('boom') }, save })
  assert.equal(s4.get().mode, 'full')
  const s5 = createViewState({ search: '?fit=bogus', load: mkLoad('garbage'), save })
  assert.equal(s5.get().mode, 'full'); assert.equal(s5.get().override, null)
  assert.equal(save.calls.length, 0, '只是建立不能寫任何偏好')
  assert.ok(Object.isFrozen(s1.get()), '快照不可變')
})

test('setMode：立即生效 + 存偏好 + 通知；同值再選不重複通知；非法值被拒且狀態不變；快照在沒變化時是同一個物件', () => {
  const save = mkSave()
  const v = createViewState({ search: '', load: mkLoad(null), save })
  let n = 0
  const off = v.subscribe(() => { n++ })
  const before = v.get()
  assert.equal(v.get(), before)                                              // 穩定（useSyncExternalStore 需要）
  assert.equal(v.setMode('fill'), true)
  assert.equal(v.get().mode, 'fill'); assert.equal(v.get().pref, 'fill')
  assert.deepEqual(save.calls, [[LS.view, 'fill']])
  assert.equal(n, 1)
  assert.notEqual(v.get(), before)
  const cur = v.get()
  assert.equal(v.setMode('fill'), true)                                      // 同值：接受但不通知、快照不變
  assert.equal(n, 1); assert.equal(v.get(), cur)
  const saved = save.calls.length
  for (const bad of ['FILL', 'x', '', null, undefined, 1, {}]) assert.equal(v.setMode(bad), false, String(bad))
  assert.equal(n, 1); assert.equal(v.get(), cur); assert.equal(save.calls.length, saved, '非法值不寫偏好')
  assert.equal(v.setMode('full'), true)
  assert.equal(v.get().mode, 'full'); assert.equal(n, 2)
  off()
  v.setMode('fill')
  assert.equal(n, 2, '取消訂閱後不再通知')
})

test('setMode 與網址覆寫：?fit=fill 時選「完整」→ 改存偏好、解除覆寫；選「填滿」（與覆寫相同）→ 也存成偏好並解除覆寫；?fit=0 維持關閉（選擇只存偏好）', () => {
  const save = mkSave()
  const a = createViewState({ search: '?fit=fill', load: mkLoad('full'), save })
  assert.equal(a.get().mode, 'fill')
  a.setMode('full')
  assert.deepEqual({ ...a.get() }, { mode: 'full', pref: 'full', enabled: true, override: null, param: 'fill', affects: null })
  assert.deepEqual(save.calls, [[LS.view, 'full']])
  const b = createViewState({ search: '?fit=fill', load: mkLoad('full'), save })
  let n = 0; b.subscribe(() => { n++ })
  b.setMode('fill')                                                          // 點已選中的覆寫值：存成偏好、覆寫解除（通知一次）
  assert.equal(b.get().override, null); assert.equal(b.get().pref, 'fill'); assert.equal(n, 1)
  assert.deepEqual(save.calls[1], [LS.view, 'fill'])
  const c = createViewState({ search: '?fit=0', load: mkLoad('full'), save })
  c.setMode('fill')
  assert.equal(c.get().enabled, false); assert.equal(c.get().override, 'off')      // 除錯開關維持關閉
  assert.equal(c.get().pref, 'fill'); assert.equal(c.get().mode, 'fill')
  assert.deepEqual(save.calls[2], [LS.view, 'fill'])
})

test('setMode：save 丟例外（儲存被擋）→ 這次仍然生效、不丟例外、不崩潰', () => {
  const v = createViewState({ search: '', load: mkLoad(null), save: () => { throw new Error('quota') } })
  assert.doesNotThrow(() => v.setMode('fill'))
  assert.equal(v.get().mode, 'fill')
})

test('setCanvas：只有「兩種取景有沒有差別」改變才通知（拖曳分隔線不會每幀重繪面板）；量不到 → null；?fit=0 → 恆為 false', () => {
  const v = createViewState({ search: '', load: mkLoad(null), save: mkSave() })
  let n = 0; v.subscribe(() => { n++ })
  assert.equal(v.get().affects, null)
  v.setCanvas(1600, 900); assert.equal(v.get().affects, false); assert.equal(n, 1)
  v.setCanvas(1600, 900); v.setCanvas(1500, 900); v.setCanvas(1200, 900); assert.equal(n, 1, '同一個結論不再通知')
  v.setCanvas(375, 812); assert.equal(v.get().affects, true); assert.equal(n, 2)
  for (let w = 300; w < 360; w += 3) v.setCanvas(w, 812)
  assert.equal(n, 2)
  v.setCanvas(0, 0); assert.equal(v.get().affects, null); assert.equal(n, 3)         // 畫布消失 / 尚未量到
  v.setCanvas(NaN, 5); assert.equal(n, 3)
  const off = createViewState({ search: '?fit=0', load: mkLoad(null), save: mkSave() })
  off.setCanvas(375, 812); assert.equal(off.get().affects, false)
})

test('訂閱者丟例外不影響其他訂閱者與狀態；unsubscribe 冪等', () => {
  const v = createViewState({ search: '', load: mkLoad(null), save: mkSave() })
  let ok = 0
  v.subscribe(() => { throw new Error('壞訂閱者') })
  const off = v.subscribe(() => { ok++ })
  assert.doesNotThrow(() => v.setMode('fill'))
  assert.equal(ok, 1); assert.equal(v.get().mode, 'fill')
  off(); off()
  v.setMode('full'); assert.equal(ok, 1)
})

test('方法脫離物件呼叫也能用（React 的 useSyncExternalStore 會把 subscribe / get 當裸函式傳）', () => {
  const v = createViewState({ search: '', load: mkLoad(null), save: mkSave() })
  const { get, subscribe, setMode, setCanvas } = v
  let n = 0
  const off = subscribe(() => { n++ })
  setMode('fill'); setCanvas(375, 812)
  assert.equal(get().mode, 'fill'); assert.ok(n >= 2)
  off()
})

test('預設路徑（不注入）：讀 globalThis.location.search 與 localStorage（會檢查 this 的假環境）；沒有 location / storage 被擋 → 預設，不丟例外', () => {
  const st = new StrictStorage({ [LS.view]: '"fill"' })
  withGlobal('localStorage', st, () => withGlobal('location', { search: '?fit=full' }, () => {
    const v = createViewState()
    assert.equal(v.get().mode, 'full'); assert.equal(v.get().pref, 'fill'); assert.equal(v.get().override, 'full')
    v.setMode('full')
    assert.equal(st.m.get(LS.view), '"full"')
  }))
  withGlobal('localStorage', new StrictStorage(), () => {
    const v = createViewState()                                             // Node 沒有 location
    assert.equal(typeof globalThis.location, 'undefined')
    assert.equal(v.get().mode, 'full'); assert.equal(v.get().override, null)
  })
  withGlobal('localStorage', new ThrowingStorage(), () => {
    const v = createViewState()
    assert.equal(v.get().mode, 'full')
    assert.doesNotThrow(() => v.setMode('fill'))
    assert.equal(v.get().mode, 'fill')
  })
})

test('getViewState：全站共用的單例（第一次用到才建立）；import 時不碰 localStorage / location', async () => {
  const st = new StrictStorage()
  const mod = await withGlobal('localStorage', st, async () => {
    const m = await import('./viewPrefs.js?probe-import')
    assert.equal(st.log.length, 0, 'import 不該讀寫 localStorage')
    return m
  })
  assert.equal(typeof mod.getViewState, 'function')
  withGlobal('localStorage', st, () => {
    const a = mod.getViewState(), b = mod.getViewState()
    assert.equal(a, b)
    assert.deepEqual(st.log.map((x) => x[0]), ['get'], '建立時才讀一次偏好')
  })
  assert.equal(getViewState(), getViewState())
})

// =============================================================================================
// ViewSection：SSR 標記
// =============================================================================================
const { default: ViewSection } = await importJsx(new URL('../ui/devices/ViewSection.jsx', import.meta.url).href)
// zustand 的 SSR 讀的是「建立當下的初始狀態」：每次渲染前把目前語系複製進去（見 tourTestEnv.liveSsr）
const render = (view) => { liveSsr(useLocaleStore); return renderToStaticMarkup(createElement(ViewSection, { view })) }
const mk = ({ search = '', pref = null, canvas } = {}) => {
  const v = createViewState({ search, load: mkLoad(pref), save: mkSave() })
  if (canvas) v.setCanvas(canvas[0], canvas[1])
  return v
}
const inEn = (fn) => { setLocale('en'); try { return fn() } finally { setLocale('zh') } }

test('ViewSection（中文，預設）：標題「取景」、說明、單選群組 role=radiogroup（有名稱與說明）、兩個原生 radio（完整已選）、目前取景', () => {
  const h = render(mk())
  assert.match(h, /<section class="dev-sec view-sec" aria-labelledby="view-title">/)
  assert.match(h, /<h3 class="dev-sec-title" id="view-title">取景<\/h3>/)
  assert.match(h, /<p class="dev-sec-desc" id="view-desc">手機直式時「填滿」會讓球更大、光暈被邊緣裁掉；寬螢幕沒有差別。<\/p>/)
  assert.match(h, /<div class="view-opts" role="radiogroup" aria-labelledby="view-title" aria-describedby="view-desc">/)
  assert.equal((h.match(/<input type="radio"/g) || []).length, 2)
  assert.equal((h.match(/name="view-mode"/g) || []).length, 2)
  assert.match(h, /<label class="view-opt on"><input type="radio" name="view-mode" checked="" value="full"\/><span>完整（含光暈）<\/span><\/label>/)
  assert.match(h, /<label class="view-opt"><input type="radio" name="view-mode" value="fill"\/><span>填滿（球填滿寬度）<\/span><\/label>/)
  assert.equal((h.match(/checked=""/g) || []).length, 1, '只有一個選中')
  assert.match(h, /<p class="dev-sec-hint view-current" aria-live="polite">目前取景：完整（含光暈）<\/p>/)
  assert.ok(h.includes('取景偏好只存在這台裝置，不會傳送任何資料。'))
  assert.ok(!h.includes('本次由網址'), '沒有網址覆寫就沒有提示')
  assert.ok(!h.includes('不受影響') && !h.includes('偏窄'), '還沒量到畫布 → 不說有沒有影響')
  assert.ok(!/\{[a-z]+\}/i.test(h), '沒有殘留的 {placeholder}')
})

test('ViewSection：偏好 fill → 填滿已選；點選（setMode）後重新渲染反映新的選擇', () => {
  const v = mk({ pref: 'fill' })
  let h = render(v)
  assert.match(h, /<label class="view-opt on"><input type="radio" name="view-mode" checked="" value="fill"\/>/)
  assert.ok(h.includes('目前取景：填滿（球填滿寬度）'))
  v.setMode('full')
  h = render(v)
  assert.match(h, /checked="" value="full"/)
  assert.ok(h.includes('目前取景：完整（含光暈）'))
})

test('ViewSection：寬螢幕顯示「目前的視窗比例不受影響」；窄畫布顯示「偏窄」提示；畫布尺寸變了會跟著變', () => {
  const v = mk({ canvas: [1600, 900] })
  let h = render(v)
  assert.ok(h.includes('目前的視窗比例不受影響（兩種取景看起來一樣）。'))
  assert.ok(!h.includes('偏窄'))
  v.setCanvas(375, 812)
  h = render(v)
  assert.ok(h.includes('目前的視窗比例偏窄：兩種取景的球大小不同。'))
  assert.ok(!h.includes('不受影響'))
})

test('ViewSection：網址覆寫 ?fit=fill → 填滿已選 + 提示「本次由網址 ?fit=fill 指定」；選了別的 → 提示消失', () => {
  const v = mk({ search: '?fit=fill', pref: 'full' })
  let h = render(v)
  assert.match(h, /checked="" value="fill"/)
  assert.ok(h.includes('本次由網址 ?fit=fill 指定；在這裡選擇會改存為偏好。'))
  assert.ok(h.includes('目前取景：填滿（球填滿寬度）'))
  v.setMode('full')
  h = render(v)
  assert.ok(!h.includes('本次由網址'))
  assert.match(h, /checked="" value="full"/)
  // ?fit=1 → 顯示 ?fit=1
  assert.ok(render(mk({ search: '?fit=1', pref: 'fill' })).includes('本次由網址 ?fit=1 指定'))
})

test('ViewSection：?fit=0 → 警示（warn）說明自動取景已關閉、不顯示「不受影響 / 偏窄」；選項仍可選（存成偏好）', () => {
  const v = mk({ search: '?fit=0', pref: 'fill', canvas: [375, 812] })
  const h = render(v)
  assert.match(h, /<p class="dev-sec-hint warn view-current" aria-live="polite">本次由網址 \?fit=0 關閉自動取景（除錯用），球維持預設距離；這裡的選擇只會存成偏好。<\/p>/)
  assert.ok(!h.includes('目前取景：'), '關閉時不說「目前取景：填滿」')
  assert.ok(!h.includes('不受影響') && !h.includes('偏窄'))
  assert.equal((h.match(/<input type="radio"/g) || []).length, 2)
  assert.match(h, /checked="" value="fill"/)                                  // 仍顯示偏好
  assert.ok(!h.includes('disabled'))
})

test('ViewSection（英文）：全部有英文、沒有殘留中文 / placeholder', () => {
  const hs = inEn(() => [
    render(mk()),
    render(mk({ canvas: [1600, 900] })),
    render(mk({ canvas: [375, 812], pref: 'fill' })),
    render(mk({ search: '?fit=fill' })),
    render(mk({ search: '?fit=0' })),
  ])
  const [d, wide, narrow, url, off] = hs
  assert.ok(d.includes('>View framing<'))
  assert.ok(d.includes('On a phone held upright, "Fill" makes the sphere larger and lets the edges crop the glow. Wide screens look the same either way.'.replace(/"/g, '&quot;')))
  assert.ok(d.includes('<span>Full (with glow)</span>') && d.includes('<span>Fill (sphere fills the width)</span>'))
  assert.ok(d.includes('Current framing: Full (with glow)'))
  assert.ok(d.includes('Your framing choice stays on this device; nothing is sent anywhere.'))
  assert.ok(wide.includes('Your current window shape is not affected (both framings look the same).'))
  assert.ok(narrow.includes('Your current window is narrow: the two framings show the sphere at different sizes.'))
  assert.ok(narrow.includes('Current framing: Fill (sphere fills the width)'))
  assert.ok(url.includes('Set for this visit by ?fit=fill in the URL. Choosing one here saves it as your preference instead.'))
  assert.ok(off.includes('Auto-framing is turned off for this visit by ?fit=0 in the URL (a debug switch)'))
  for (const h of hs) {
    assert.ok(!/[一-鿿]/.test(stripHtml(h)), '英文模式不該殘留中文：' + stripHtml(h).match(/[一-鿿]+/))
    assert.ok(!/\{[a-z]+\}/i.test(h))
  }
})

test('ViewSection：語系切換即時重繪（同一個 view，zh → en）；不放 emoji；沒有 view 屬性時用全站共用的那一份、不丟例外', () => {
  const v = mk()
  assert.ok(render(v).includes('>取景<'))
  assert.ok(inEn(() => render(v)).includes('>View framing<'))
  for (const h of [render(v), inEn(() => render(v))]) assert.ok(!/\p{Extended_Pictographic}/u.test(h), '介面不放 emoji')
  withGlobal('localStorage', new StrictStorage(), () => { assert.doesNotThrow(() => renderToStaticMarkup(createElement(ViewSection))) })
})

test('ViewSection 原始碼：radio 有 onChange 與 onClick（已選中的再點也要處理）、用 useSyncExternalStore、不 import three / store / tour', () => {
  const src = readFileSync(new URL('../ui/devices/ViewSection.jsx', import.meta.url), 'utf8')
  assert.match(src, /onChange=\{\(\) => choose\(m\)\} onClick=\{\(\) => choose\(m\)\}/)
  assert.match(src, /useSyncExternalStore\(src\.subscribe, src\.get, src\.get\)/)
  assert.doesNotMatch(src, /from 'three'|store\/useStore|lib\/tour|@react-three/)
  assert.match(src, /import '\.\.\/\.\.\/styles\/view\.css'/)
  const lib = readFileSync(new URL('./viewPrefs.js', import.meta.url), 'utf8')
  assert.doesNotMatch(lib, /from 'three'|from 'react'|store\/useStore|zustand/)                      // 純邏輯：不依賴 React / three / store
  const modal = readFileSync(new URL('../ui/DevicesModal.jsx', import.meta.url), 'utf8')
  assert.match(modal, /import ViewSection from '\.\/devices\/ViewSection\.jsx'/)
  assert.match(modal, /<ViewSection \/>/)
})

test('view.css：手機不溢出（min-width: 0、overflow-wrap、窄螢幕直排）、觸控目標 >= 44px、焦點可見；只用既有的 CSS 變數', () => {
  const css = readFileSync(new URL('../styles/view.css', import.meta.url), 'utf8')
  assert.match(css, /\.view-sec \.view-opt \{[^}]*min-height: 44px/)
  assert.match(css, /min-width: 0/)
  assert.match(css, /overflow-wrap: anywhere/)
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*flex-basis: 100%/)
  assert.match(css, /\.view-opt:has\(input:focus-visible\) \{[^}]*outline/)                       // 鍵盤焦點可見（滑鼠點擊不出現外框）
  assert.match(css, /@supports selector\(:has\(\*\)\)/)                                            // 不支援 :has 的瀏覽器退回全站 :focus-visible
  assert.match(css, /accent-color: var\(--accent\)/)
  assert.ok(!/\{[^}]*(position: *(fixed|absolute))/.test(css), '不用絕對定位 / 固定定位（不擋畫面）')
  for (const m of css.matchAll(/var\((--[\w-]+)\)/g)) assert.match(m[1], /^--(accent|panel2|line2|muted|text)$/)
})

test('英文字典：view.js 的 key 都被 ViewSection 用到、沒有多餘也沒有缺；不與其他字典重複', async () => {
  const en = (await import('../i18n/en/view.js')).default
  const src = readFileSync(new URL('../ui/devices/ViewSection.jsx', import.meta.url), 'utf8')
  for (const k of Object.keys(en)) assert.ok(src.includes(k), '字典有但 ViewSection 沒用：' + k)
  const used = [...src.matchAll(/(?:t|T)\('([^']+)'/g)].map((m) => m[1])
  assert.ok(used.length >= 8)
  for (const k of used) assert.ok(k in en, '缺英文：' + k)
  const others = new Map()
  const fs = await import('node:fs')
  for (const f of fs.readdirSync(new URL('../i18n/en/', import.meta.url))) {
    if (f === 'view.js') continue
    const m = (await import('../i18n/en/' + f)).default
    for (const k of Object.keys(m)) others.set(k, f)
  }
  for (const k of Object.keys(en)) assert.ok(!others.has(k), `key 與 ${others.get(k)} 重複：${k}`)
})
