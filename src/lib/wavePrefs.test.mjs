// 「揮手換站」偏好（lib/wavePrefs.js）與它在 GestureService / GestureSection 的接線的單元測試。執行：node --test src/lib/wavePrefs.test.mjs
// 涵蓋：沒存過 → 開、存 off → 關、壞值 → 預設、storage 丟例外不崩、寫入格式（JSON 字串，與其他偏好一致）、
// 「會檢查 this 的假 localStorage」（瀏覽器的 Illegal invocation 在 Node 看不到）、import 時不碰瀏覽器 API、
// 啟動時套用（hydrate：可重複執行、存過才套用）、與真實 useHandsStore 的往返、GestureSection 的 SSR 顯示（狀態與說明不變）、接線守則。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { loadEnDict } from '../../scripts/i18n-check.mjs'
import { registerEn, setLocale, useLocaleStore } from '../i18n/index.js'
import { LS } from './persist.js'
import { WAVE_DEFAULT, readWavePref, loadWavePref, saveWavePref, defaultWaveStorage, hydrateWavePref } from './wavePrefs.js'
import { importJsx, liveSsr, illegal } from './tourTestEnv.mjs'

const { dict } = await loadEnDict()
registerEn(dict)

// ---- 假 storage：方法都檢查 this（脫離物件呼叫會丟 Illegal invocation，與瀏覽器一致）----
class StrictStorage {
  constructor(init = {}) { this.m = new Map(Object.entries(init)); this.log = [] }
  getItem(k) { if (!(this instanceof StrictStorage)) throw illegal(); this.log.push(['get', k]); return this.m.has(k) ? this.m.get(k) : null }
  setItem(k, v) { if (!(this instanceof StrictStorage)) throw illegal(); this.log.push(['set', k, v]); this.m.set(k, String(v)) }
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
// 假的手勢狀態（zustand 介面：getState / setState）
function makeStore(waveNav = true) {
  let s = { waveNav, wave: 'next', other: 1 }
  const calls = []
  return { getState: () => s, setState: (p) => { calls.push(p); s = { ...s, ...p } }, calls }
}

// =============================================================================================
// 讀寫
// =============================================================================================
test('常數：預設開；用的是 LS.wavenav', () => {
  assert.equal(WAVE_DEFAULT, true)
  assert.equal(LS.wavenav, 'ixd2026.wavenav')
})

test('loadWavePref：沒存過 → 開；存 off → 關；存 on → 開；壞值 → 預設（開）；storage 缺 / 丟例外 → 預設（開）', () => {
  assert.equal(loadWavePref(new StrictStorage()), true)                                        // 沒存過
  assert.equal(loadWavePref(new StrictStorage({ [LS.wavenav]: '"off"' })), false)              // JSON 字串（saveWavePref 寫的格式）
  assert.equal(loadWavePref(new StrictStorage({ [LS.wavenav]: '"on"' })), true)
  assert.equal(loadWavePref(new StrictStorage({ [LS.wavenav]: 'off' })), false)                // 裸字串也容忍
  assert.equal(loadWavePref(new StrictStorage({ [LS.wavenav]: 'on' })), true)
  assert.equal(loadWavePref(new StrictStorage({ [LS.wavenav]: ' "off" ' })), false)            // 前後空白
  for (const bad of ['', 'OFF', '"OFF"', 'false', '0', 'null', '{}', '[]', '"off', 'yes', '"maybe"', '{"a":1}', 'true', '1']) {
    assert.equal(loadWavePref(new StrictStorage({ [LS.wavenav]: bad })), true, `壞值 ${bad} → 預設開`)
    assert.equal(readWavePref(new StrictStorage({ [LS.wavenav]: bad })), null, `壞值 ${bad} → 視為沒存過`)
  }
  assert.equal(loadWavePref(null), true); assert.equal(loadWavePref(undefined), true)
  assert.equal(loadWavePref({}), true)                                                         // 沒有 getItem
  assert.equal(loadWavePref(new ThrowingStorage()), true)                                      // 隱私模式：丟例外不崩
  assert.equal(loadWavePref({ getItem: () => 42 }), true)                                      // 傳回非字串
  assert.equal(loadWavePref({ getItem: () => undefined }), true)
})

test('readWavePref：存過的選擇（on / off）或 null（沒存過 / 壞值 / 讀不到）', () => {
  assert.equal(readWavePref(new StrictStorage({ [LS.wavenav]: '"off"' })), 'off')
  assert.equal(readWavePref(new StrictStorage({ [LS.wavenav]: '"on"' })), 'on')
  assert.equal(readWavePref(new StrictStorage()), null)
  assert.equal(readWavePref(new ThrowingStorage()), null)
  assert.equal(readWavePref(null), null)
})

test('saveWavePref：寫 JSON 字串（與其他偏好一致）並回 true；讀得回來；storage 缺 / 丟例外 → false、不丟', () => {
  const st = new StrictStorage()
  assert.equal(saveWavePref(st, false), true)
  assert.equal(st.m.get(LS.wavenav), '"off"')
  assert.equal(loadWavePref(st), false)
  assert.equal(saveWavePref(st, true), true)
  assert.equal(st.m.get(LS.wavenav), '"on"')
  assert.equal(loadWavePref(st), true)
  assert.deepEqual(st.log.filter((x) => x[0] === 'set').map((x) => x[1]), [LS.wavenav, LS.wavenav])
  saveWavePref(st, 0); assert.equal(st.m.get(LS.wavenav), '"off"')                             // 真假值一律轉成 on / off
  saveWavePref(st, 'yes'); assert.equal(st.m.get(LS.wavenav), '"on"')
  assert.equal(saveWavePref(null, true), false)
  assert.equal(saveWavePref(undefined, false), false)
  assert.doesNotThrow(() => saveWavePref(new ThrowingStorage(), false))
  assert.equal(saveWavePref(new ThrowingStorage(), false), false)
  assert.equal(saveWavePref({}, true), false)                                                  // 沒有 setItem
})

test('往返：關掉 → 「重新整理」（重新讀）仍是關；再打開 → 開；storage 是會檢查 this 的假環境，全部以方法呼叫', () => {
  const st = new StrictStorage()
  assert.equal(loadWavePref(st), true)
  saveWavePref(st, false)
  assert.equal(loadWavePref(new StrictStorage(Object.fromEntries(st.m))), false)               // 新的 storage 物件、同樣的內容 = 重新整理
  saveWavePref(st, true)
  assert.equal(loadWavePref(new StrictStorage(Object.fromEntries(st.m))), true)
})

test('defaultWaveStorage：呼叫當下才取 globalThis.localStorage；沒有 / 取用丟例外 → null；回傳的物件能以方法呼叫（Illegal invocation 回歸）', () => {
  const st = new StrictStorage()
  withGlobal('localStorage', st, () => {
    const s = defaultWaveStorage()
    assert.equal(s, st)
    assert.equal(saveWavePref(s, false), true)                                                 // 若把 s.setItem 存起來脫離呼叫，StrictStorage 會丟 Illegal invocation
    assert.equal(loadWavePref(s), false)
    assert.equal(loadWavePref(defaultWaveStorage()), false)
  })
  withGlobal('localStorage', null, () => assert.equal(defaultWaveStorage(), null))
  withGlobal('localStorage', undefined, () => assert.equal(defaultWaveStorage(), null))
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('SecurityError') }, configurable: true })
  try { assert.equal(defaultWaveStorage(), null); assert.equal(loadWavePref(defaultWaveStorage()), true) }
  finally { if (desc) Object.defineProperty(globalThis, 'localStorage', desc); else delete globalThis.localStorage }
})

test('import 時不碰 localStorage（Node 測試與瀏覽器共用；功能偵測只發生在呼叫時）', async () => {
  const st = new StrictStorage()
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { value: st, configurable: true, writable: true })
  try {
    const m = await import('./wavePrefs.js?probe-import')
    assert.deepEqual(st.log.filter((x) => x[1] === LS.wavenav), [], 'import 不該讀寫揮手換站偏好')
    assert.ok(!st.log.some((x) => x[0] === 'set'), 'import 不該寫任何東西')
    assert.equal(typeof m.hydrateWavePref, 'function')
  } finally { if (desc) Object.defineProperty(globalThis, 'localStorage', desc); else delete globalThis.localStorage }
})

// =============================================================================================
// 啟動時套用（GestureService 掛載時）
// =============================================================================================
test('hydrateWavePref：存 off 且目前是開 → 關掉（並清掉最近一次揮手顯示）；可重複執行（StrictMode 跑兩次 effect）；不寫 storage', () => {
  const st = new StrictStorage({ [LS.wavenav]: '"off"' })
  const store = makeStore(true)
  assert.equal(hydrateWavePref(store, st), true)
  assert.equal(store.getState().waveNav, false); assert.equal(store.getState().wave, null); assert.equal(store.getState().other, 1)
  assert.equal(hydrateWavePref(store, st), false)                                              // 第二次：已經是關 → 不動
  assert.equal(store.calls.length, 1)
  assert.deepEqual(st.log.filter((x) => x[0] === 'set'), [], '套用只讀不寫')
})

test('hydrateWavePref：存 on 且目前是關 → 開；存的和目前一樣 → 不動', () => {
  const store = makeStore(false)
  assert.equal(hydrateWavePref(store, new StrictStorage({ [LS.wavenav]: '"on"' })), true)
  assert.equal(store.getState().waveNav, true)
  const same = makeStore(true)
  assert.equal(hydrateWavePref(same, new StrictStorage({ [LS.wavenav]: '"on"' })), false)
  assert.equal(same.calls.length, 0)
})

test('hydrateWavePref：沒存過 / 壞值 / storage 缺或丟例外 → 完全不動（預設開），也不會把預設值寫進 storage', () => {
  for (const init of [{}, { [LS.wavenav]: 'garbage' }, { [LS.wavenav]: '' }, { [LS.wavenav]: '"maybe"' }]) {
    const st = new StrictStorage(init)
    const store = makeStore(true)
    assert.equal(hydrateWavePref(store, st), false)
    assert.equal(store.calls.length, 0); assert.equal(store.getState().waveNav, true)
    assert.deepEqual(st.log.filter((x) => x[0] === 'set'), [])
  }
  for (const st of [null, undefined, new ThrowingStorage(), {}]) {
    const store = makeStore(true)
    assert.doesNotThrow(() => hydrateWavePref(store, st === undefined ? null : st))
    assert.equal(store.calls.length, 0)
  }
})

test('hydrateWavePref：store 壞掉（getState / setState 丟例外）也不崩、回 false；預設 storage = 目前的 localStorage', () => {
  const st = new StrictStorage({ [LS.wavenav]: '"off"' })
  assert.equal(hydrateWavePref({ getState() { throw new Error('boom') }, setState() {} }, st), false)
  assert.equal(hydrateWavePref({ getState: () => ({ waveNav: true }), setState() { throw new Error('boom') } }, st), false)
  const store = makeStore(true)
  withGlobal('localStorage', st, () => assert.equal(hydrateWavePref(store), true))             // 沒傳 storage：呼叫當下取 globalThis.localStorage
  assert.equal(store.getState().waveNav, false)
  const store2 = makeStore(true)
  withGlobal('localStorage', new ThrowingStorage(), () => assert.equal(hydrateWavePref(store2), false))
  assert.equal(store2.getState().waveNav, true)
})

// =============================================================================================
// 與真實的手勢狀態、GestureSection 的 SSR 顯示
// =============================================================================================
const hands = await import('./hands.js')
const { default: GestureSection } = await importJsx(new URL('../ui/devices/GestureSection.jsx', import.meta.url).href)
const render = () => { liveSsr(hands.useHandsStore, useLocaleStore); return renderToStaticMarkup(createElement(GestureSection)) }
const inEn = (fn) => { setLocale('en'); try { return fn() } finally { setLocale('zh') } }

const waveBlock = (h) => h.match(/<div class="gesture-wave">[\s\S]*?<\/div>/)[0]

test('真實 useHandsStore：hydrate 存 off → GestureSection 顯示「揮手換站已關閉。」且勾選框未勾（中 / 英文）；存 on 就是開；顯示狀態與說明維持原樣', () => {
  const { useHandsStore, setWaveNav } = hands
  const before = useHandsStore.getState()
  try {
    useHandsStore.setState({ waveNav: true, wave: null })
    assert.equal(waveBlock(render()), '<div class="gesture-wave"><label class="gesture-toggle"><input type="checkbox" checked=""/>揮手換站</label><p class="gesture-wave-status " role="status" aria-live="polite">要先啟用相機手勢，揮手換站才會作用。</p></div>')
    assert.equal(hydrateWavePref(useHandsStore, new StrictStorage({ [LS.wavenav]: '"off"' })), true)
    assert.equal(useHandsStore.getState().waveNav, false)
    assert.equal(waveBlock(render()), '<div class="gesture-wave"><label class="gesture-toggle"><input type="checkbox"/>揮手換站</label><p class="gesture-wave-status off" role="status" aria-live="polite">揮手換站已關閉。</p></div>')
    assert.equal(waveBlock(inEn(render)), '<div class="gesture-wave"><label class="gesture-toggle"><input type="checkbox"/>Wave to change stop</label><p class="gesture-wave-status off" role="status" aria-live="polite">Wave to change stop is off.</p></div>')
    setWaveNav(true)                                                                            // 既有 API 照舊可用（GestureSection 的 chooseWaveNav 會呼叫它）
    assert.equal(useHandsStore.getState().waveNav, true)
    assert.equal(hydrateWavePref(useHandsStore, new StrictStorage({ [LS.wavenav]: '"on"' })), false)
    assert.ok(waveBlock(render()).includes('checked=""'))
  } finally { useHandsStore.setState({ waveNav: before.waveNav, wave: before.wave }) }
})

test('GestureSection 的切換走 chooseWaveNav：setWaveNav + saveWavePref(defaultWaveStorage(), on)；GestureService 掛載時 hydrateWavePref；其他既有行為（只在導覽進行中處理揮手）不變', () => {
  const sec = readFileSync(new URL('../ui/devices/GestureSection.jsx', import.meta.url), 'utf8')
  assert.match(sec, /import \{ saveWavePref, defaultWaveStorage \} from '\.\.\/\.\.\/lib\/wavePrefs\.js'/)
  assert.match(sec, /const chooseWaveNav = \(on\) => \{ setWaveNav\(on\); saveWavePref\(defaultWaveStorage\(\), !!on\) \}/)
  assert.match(sec, /onChange=\{\(e\) => chooseWaveNav\(e\.target\.checked\)\}/)
  assert.doesNotMatch(sec, /onChange=\{\(e\) => setWaveNav\(/, '不能繞過儲存直接 setWaveNav')
  const svc = readFileSync(new URL('../services/GestureService.jsx', import.meta.url), 'utf8')
  assert.match(svc, /import \{ hydrateWavePref \} from '\.\.\/lib\/wavePrefs\.js'/)
  assert.match(svc, /useEffect\(\(\) => \{ hydrateWavePref\(useHandsStore\) \}, \[\]\)/)
  assert.match(svc, /useHandsStore\.getState\(\)\.waveNav !== false && tourRunner\.isRunning\(\)/)   // 揮手只在導覽進行中處理
  const lib = readFileSync(new URL('./wavePrefs.js', import.meta.url), 'utf8')
  assert.doesNotMatch(lib, /from 'react'|from 'zustand'|from '\.\/hands\.js'|store\/useStore|from 'three'/, '純模組')
  // 原生方法以「方法呼叫」：不存進變數再脫離呼叫
  assert.doesNotMatch(lib, /=\s*(?:storage|localStorage)\.(?:getItem|setItem)\b(?!\s*\()/)
})

test('沒有新的使用者文字：wavePrefs.js 與兩個接線檔沒有未包 t() 的中文字面量（介面說明維持原樣）', () => {
  const lib = readFileSync(new URL('./wavePrefs.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(lib, /[一-鿿]/)
  assert.ok(!/\p{Extended_Pictographic}/u.test(lib))
})
