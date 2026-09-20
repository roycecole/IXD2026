// 裝置備註（lib/diagnosticsNote.js）：只輸出有填的欄位、長度上限、草稿存取（storage 丟例外不崩）、帶入偵測值（高熵值失敗退回 UA）。
// 環境全部用「會檢查 this 的假物件」：原生方法脫離物件呼叫會在瀏覽器丟 Illegal invocation，Node 不會，所以假物件自己檢查。
// 執行：node --test src/lib/diagnosticsNote.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NOTE_FIELDS, NOTE_LIMITS, EMPTY_NOTE, NOTE_KEY, cleanField, clampNote, noteForReport, noteIsEmpty, loadNote, saveNote, clearNote, parseUserAgent, fromClientHints, detectDeviceInfo,
} from './diagnosticsNote.js'
import { LS } from './persist.js'

function strict(obj, label = 'obj') {
  for (const k of Object.keys(obj)) {
    const v = obj[k]
    if (typeof v === 'function' && !v.__strict && !/^[A-Z]/.test(k)) {
      const w = function (...a) { if (this !== obj) throw new TypeError(`Illegal invocation: ${label}.${k}`); return v.apply(obj, a) }
      w.__strict = true
      obj[k] = w
    } else if (v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype) strict(v, `${label}.${k}`)
  }
  return obj
}
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)) }
function makeClock() {
  let t = 0, seq = 0
  const timers = new Map()
  return {
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id },
    clearTimeout: (id) => { timers.delete(id) },
    advance(ms) { const end = t + ms; for (;;) { let pick = null; for (const [id, x] of timers) if (x.at <= end && (!pick || x.at < pick.x.at)) pick = { id, x }; if (!pick) break; timers.delete(pick.id); t = Math.max(t, pick.x.at); pick.x.fn() } t = end },
    pending: () => timers.size,
  }
}
const memStorage = () => {
  const mem = new Map()
  return { mem, get: (k) => (mem.has(k) ? JSON.parse(JSON.stringify(mem.get(k))) : null), set: (k, v) => { mem.set(k, JSON.parse(JSON.stringify(v))) }, remove: (k) => { mem.delete(k) } }
}
const throwing = { get() { throw new Error('SecurityError') }, set() { throw new Error('QuotaExceededError') }, remove() { throw new Error('SecurityError') } }

test('欄位與上限：五個欄位、備註 ≤ 500 字；儲存鍵是 LS.diagnote', () => {
  assert.deepEqual(NOTE_FIELDS, ['model', 'os', 'browser', 'tester', 'memo'])
  assert.equal(NOTE_LIMITS.memo, 500); assert.ok(NOTE_LIMITS.model > 0 && NOTE_LIMITS.tester > 0)
  assert.equal(NOTE_KEY, LS.diagnote); assert.equal(NOTE_KEY, 'ixd2026.diagnote')
  assert.deepEqual({ ...EMPTY_NOTE }, { model: '', os: '', browser: '', tester: '', memo: '' })
  assert.throws(() => { 'use strict'; EMPTY_NOTE.model = 'x' }, TypeError, '空備註是凍結的（不會被誤改）')
})

test('清理：控制字元 / 零寬與雙向控制字元去掉；單行欄位的換行變空白；備註保留換行但壓縮空行；三個以上的反引號改成單引號', () => {
  assert.equal(cleanField('model', 'iPhone\u0000 15\u200B\u202E'), 'iPhone 15')
  assert.equal(cleanField('model', 'a\nb\r\nc\td'), 'a b c d')
  assert.equal(cleanField('memo', 'a\r\nb\rc\n\n\n\nd\te'), 'a\nb\nc\n\nd e')
  assert.equal(cleanField('memo', '```json\n{}\n```'), "'''json\n{}\n'''")
  assert.equal(cleanField('memo', '`一個` ``兩個``'), '`一個` ``兩個``', '一、兩個反引號不動')
  for (const bad of [null, undefined, 5, {}, [], true]) assert.equal(cleanField('memo', bad), '')
  assert.equal(cleanField('nope', 'x'), '', '不認得的欄位')
  assert.equal(cleanField('model', '  前後空白保留（草稿輸入中）  '), '  前後空白保留（草稿輸入中）  ')
})

test('長度上限：依「字」計（不會切壞代理對）；各欄位用自己的上限', () => {
  assert.equal(Array.from(cleanField('memo', 'x'.repeat(600))).length, 500)
  assert.equal(cleanField('memo', 'x'.repeat(500)).length, 500, '剛好 500 不動')
  assert.equal(Array.from(cleanField('tester', '測'.repeat(100))).length, NOTE_LIMITS.tester)
  assert.equal(Array.from(cleanField('model', 'm'.repeat(200))).length, NOTE_LIMITS.model)
  const emoji = cleanField('memo', '😀'.repeat(600))
  assert.equal(Array.from(emoji).length, 500); assert.ok(!/[\uD800-\uDBFF]$/.test(emoji), '結尾不是被切一半的代理對'); assert.equal(emoji.length, 1000)
  const c = clampNote({ model: 'a'.repeat(999), os: 'b', browser: 'c', tester: 'd'.repeat(999), memo: 'e'.repeat(999), extra: '多餘的欄位' })
  assert.deepEqual(Object.keys(c), NOTE_FIELDS); assert.equal(Array.from(c.model).length, NOTE_LIMITS.model); assert.equal(Array.from(c.memo).length, 500); assert.ok(!('extra' in c))
  assert.deepEqual(clampNote(null), { ...EMPTY_NOTE }); assert.deepEqual(clampNote('x'), { ...EMPTY_NOTE }); assert.deepEqual(clampNote([1]), { ...EMPTY_NOTE })
})

test('報告用：只留「有填」的欄位（trim 後非空）；全空 / 全是空白 → null（報告完全沒有「裝置備註」段落）', () => {
  assert.equal(noteForReport(null), null); assert.equal(noteForReport({}), null); assert.equal(noteForReport({ ...EMPTY_NOTE }), null)
  assert.equal(noteForReport({ model: '   ', os: '\n', browser: '\t', tester: '  ', memo: ' \n \n ' }), null)
  assert.equal(noteIsEmpty({ model: '  ' }), true); assert.equal(noteIsEmpty({ tester: 'A' }), false)
  assert.deepEqual(noteForReport({ model: ' iPhone 15 ', os: '', browser: 'Safari 18', tester: '', memo: '' }), { model: 'iPhone 15', browser: 'Safari 18' }, '沒填的欄位不出現（連空字串也沒有）')
  assert.deepEqual(noteForReport({ memo: '  第一行  \n  第二行\n\n' }), { memo: '第一行\n  第二行' }, '備註：每行去尾端空白、整體去頭尾')
  assert.deepEqual(Object.keys(noteForReport({ tester: 'A', model: 'B', memo: 'C' })), ['model', 'tester', 'memo'], '欄位順序固定')
  assert.deepEqual(noteForReport({ model: 'x'.repeat(500), memo: 'y'.repeat(900) }).memo.length, 500)
})

test('草稿：存 / 讀 / 清除；全空 → 移除紀錄；壞資料 → 空備註；只留已知欄位', () => {
  const st = memStorage()
  assert.deepEqual(loadNote(st), { ...EMPTY_NOTE })
  assert.equal(saveNote({ model: 'Pixel 8', os: 'Android 15', memo: '第 2 台' }, st), true)
  assert.deepEqual(st.mem.get(NOTE_KEY), { model: 'Pixel 8', os: 'Android 15', browser: '', tester: '', memo: '第 2 台' })
  assert.deepEqual(loadNote(st), { model: 'Pixel 8', os: 'Android 15', browser: '', tester: '', memo: '第 2 台' })
  assert.equal(saveNote({ ...EMPTY_NOTE }, st), true); assert.equal(st.mem.has(NOTE_KEY), false, '全空 = 不留空殼')
  saveNote({ tester: 'A' }, st); assert.equal(clearNote(st), true); assert.equal(st.mem.has(NOTE_KEY), false)
  for (const bad of ['x', 5, [1, 2], { model: 5, os: { a: 1 }, memo: ['x'] }, null]) { st.mem.set(NOTE_KEY, bad); assert.deepEqual(loadNote(st), { ...EMPTY_NOTE }, String(JSON.stringify(bad))) }
  st.mem.set(NOTE_KEY, { model: 'M', hacker: '<script>', memo: 'x'.repeat(900) })
  const back = loadNote(st); assert.ok(!('hacker' in back)); assert.equal(Array.from(back.memo).length, 500, '讀回來也會依上限截斷')
})

test('草稿存取在 storage 丟例外時不崩（隱私模式 / 額度滿）：讀 → 空備註；存 / 清除 → false', () => {
  assert.deepEqual(loadNote(throwing), { ...EMPTY_NOTE })
  assert.equal(saveNote({ model: 'x' }, throwing), false); assert.equal(saveNote({}, throwing), false)
  assert.equal(clearNote(throwing), false)
  const half = { get: () => ({ model: 'ok' }), set() { throw new Error('QuotaExceededError') }, remove() {} }
  assert.equal(loadNote(half).model, 'ok'); assert.equal(saveNote({ model: 'y' }, half), false)
  // 預設儲存（persist.js）：Node 沒有 localStorage → 不丟例外
  assert.deepEqual(loadNote(), { ...EMPTY_NOTE }); assert.equal(saveNote({ model: 'z' }), true); assert.equal(clearNote(), true)
})

test('由 UA 字串推測：iPhone / iPad / Android / Mac / Windows / Chromebook × Safari / Chrome / Edge / Firefox / 三星 / iOS 版 Chrome、Firefox', () => {
  const ua = {
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    ipad: 'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    pixel: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36',
    galaxy: 'Mozilla/5.0 (Linux; Android 13; SM-S918B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36',
    samsungBrowser: 'Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
    reduced: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.46',
    winFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
    iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1',
    iosFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/128.0 Mobile/15E148 Safari/605.1.15',
    cros: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    opera: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0',
  }
  assert.deepEqual(parseUserAgent(ua.iphone), { model: 'iPhone', os: 'iOS 17.5', browser: 'Safari 17.5' })
  assert.deepEqual(parseUserAgent(ua.ipad), { model: 'iPad', os: 'iPadOS 16.6', browser: 'Safari 16.6' })
  assert.deepEqual(parseUserAgent(ua.pixel), { model: 'Pixel 8', os: 'Android 14', browser: 'Chrome 120.0.6099.144' })
  assert.equal(parseUserAgent(ua.galaxy).model, 'SM-S918B'); assert.equal(parseUserAgent(ua.galaxy).os, 'Android 13')
  assert.equal(parseUserAgent(ua.samsungBrowser).browser, 'Samsung Internet 23.0')
  assert.equal(parseUserAgent(ua.reduced).model, '', 'Chrome 縮減版 UA 的型號是「K」：不是真的型號，不填'); assert.equal(parseUserAgent(ua.reduced).os, 'Android 10')
  assert.deepEqual(parseUserAgent(ua.macSafari), { model: 'Mac', os: 'macOS 10.15.7', browser: 'Safari 17.4' })
  assert.equal(parseUserAgent(ua.macChrome).browser, 'Chrome 130.0.0.0')
  assert.deepEqual(parseUserAgent(ua.macSafari, { maxTouchPoints: 5 }), { model: 'iPad', os: 'iPadOS', browser: 'Safari 17.4' }, '桌面版 Safari 的 iPad：有多點觸控 = iPad')
  assert.equal(parseUserAgent(ua.macSafari, { maxTouchPoints: 0 }).model, 'Mac'); assert.equal(parseUserAgent(ua.macSafari, { maxTouchPoints: 1 }).model, 'Mac')
  assert.deepEqual(parseUserAgent(ua.winEdge), { model: 'PC', os: 'Windows 10 / 11', browser: 'Edge 130.0.2849.46' })
  assert.equal(parseUserAgent(ua.winFirefox).browser, 'Firefox 132.0')
  assert.equal(parseUserAgent(ua.iosChrome).browser, 'Chrome (iOS) 126.0.6478.153'); assert.equal(parseUserAgent(ua.iosFirefox).browser, 'Firefox (iOS) 128.0')
  assert.deepEqual([parseUserAgent(ua.cros).model, parseUserAgent(ua.cros).os], ['Chromebook', 'ChromeOS'])
  assert.equal(parseUserAgent(ua.opera).browser, 'Opera 115.0.0.0')
  for (const bad of ['', null, undefined, 42, {}, 'curl/8.0', 'x'.repeat(5000)]) { const r = parseUserAgent(bad); assert.deepEqual(Object.keys(r), ['model', 'os', 'browser']); for (const v of Object.values(r)) assert.equal(typeof v, 'string') }
  assert.deepEqual(parseUserAgent('curl/8.0'), { model: '', os: '', browser: '' }, '認不出來 = 空字串（使用者自己填）')
})

test('高熵值 → 欄位：型號 / 平台 + 平台版本 / 瀏覽器（略過 GREASE 的 Not A Brand，Chromium 是最後備選）；Windows 11 以主版號 13 判斷', () => {
  const hv = { model: 'Pixel 8', platformVersion: '15.0.0', fullVersionList: [{ brand: 'Not.A/Brand', version: '99.0.0.0' }, { brand: 'Chromium', version: '130.0.6723.58' }, { brand: 'Google Chrome', version: '130.0.6723.58' }] }
  assert.deepEqual(fromClientHints(hv, 'Android'), { model: 'Pixel 8', os: 'Android 15.0.0', browser: 'Google Chrome 130.0.6723.58' })
  assert.equal(fromClientHints({ platformVersion: '15.0.0' }, 'Windows').os, 'Windows 11'); assert.equal(fromClientHints({ platformVersion: '10.0.0' }, 'Windows').os, 'Windows 10')
  assert.equal(fromClientHints({}, 'Windows').os, 'Windows'); assert.equal(fromClientHints({ platformVersion: '14.5.0' }, 'macOS').os, 'macOS 14.5.0')
  assert.equal(fromClientHints({ fullVersionList: [{ brand: 'Chromium', version: '130.1' }, { brand: 'Not A;Brand', version: '8' }] }, '').browser, 'Chromium 130.1')
  assert.equal(fromClientHints({ fullVersionList: [{ brand: 'Not A;Brand', version: '8' }] }, '').browser, '')
  assert.deepEqual(fromClientHints(null, undefined), { model: '', os: '', browser: '' }); assert.deepEqual(fromClientHints('x', 5), { model: '', os: '', browser: '' })
  assert.equal(fromClientHints({ fullVersionList: 'nope' }, '').browser, '')
})

test('帶入偵測值：只在呼叫時才用 getHighEntropyValues（以方法呼叫、只要這三項）；失敗 / 逾時 / 沒有 → 退回 UA；缺的欄位由 UA 補；永遠不丟例外', async () => {
  const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
  const calls = []
  const mk = (impl, extra = {}) => strict({ userAgent: UA, maxTouchPoints: 5, userAgentData: { platform: 'Android', getHighEntropyValues(keys) { calls.push(keys); return impl(keys) } }, ...extra }, 'navigator')
  const clock = makeClock()
  const env = (nav) => ({ nav, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })

  const nav0 = mk(() => Promise.resolve({ model: 'Pixel 8 Pro', platformVersion: '15.0.0', fullVersionList: [{ brand: 'Google Chrome', version: '130.0.6723.58' }] }))
  assert.equal(calls.length, 0, '建立導航物件不會呼叫（只在使用者按「帶入偵測值」時才呼叫）')
  const ok = await detectDeviceInfo(env(nav0))
  assert.deepEqual(calls, [['model', 'platformVersion', 'fullVersionList']])
  assert.deepEqual(ok, { model: 'Pixel 8 Pro', os: 'Android 15.0.0', browser: 'Google Chrome 130.0.6723.58', source: 'client-hints' })
  assert.equal(clock.pending(), 0, '逾時計時器已清掉')

  const partial = await detectDeviceInfo(env(mk(() => Promise.resolve({ model: '', platformVersion: '', fullVersionList: [] }))))
  assert.deepEqual(partial, { model: 'Pixel 8', os: 'Android 14', browser: 'Chrome 130.0.0.0', source: 'ua' }, '高熵值全空 → 用 UA')
  const mixed = await detectDeviceInfo(env(mk(() => Promise.resolve({ model: 'Pixel 8 Pro', platformVersion: '', fullVersionList: [] }))))
  assert.deepEqual(mixed, { model: 'Pixel 8 Pro', os: 'Android 14', browser: 'Chrome 130.0.0.0', source: 'client-hints' }, '有高熵值的欄位用高熵值，缺的由 UA 補')

  for (const [label, impl] of [['reject', () => Promise.reject(new Error('NotAllowedError'))], ['throw', () => { throw new Error('SecurityError') }], ['null', () => Promise.resolve(null)]]) {
    const r = await detectDeviceInfo(env(mk(impl)))
    assert.deepEqual(r, { model: 'Pixel 8', os: 'Android 14', browser: 'Chrome 130.0.0.0', source: 'ua' }, label + '：退回 UA')
  }
  const hang = detectDeviceInfo(env(mk(() => new Promise(() => {}))), 2500)
  await settle(); clock.advance(2500)
  assert.equal((await hang).source, 'ua', '卡住 → 逾時後退回 UA'); assert.equal(clock.pending(), 0)

  const noUad = await detectDeviceInfo(env(strict({ userAgent: UA, maxTouchPoints: 5 })))
  assert.equal(noUad.source, 'ua'); assert.equal(noUad.model, 'Pixel 8')
  const noFn = await detectDeviceInfo(env(strict({ userAgent: UA, userAgentData: { platform: 'Android' } })))
  assert.equal(noFn.source, 'ua')
  for (const bad of [undefined, null, {}, { nav: null }, { nav: {} }, { nav: { userAgent: 5 } }]) {
    const r = await detectDeviceInfo(bad); assert.deepEqual(r, { model: '', os: '', browser: '', source: 'none' })
  }
  const boom = new Proxy({}, { get() { throw new Error('boom') } })
  assert.equal((await detectDeviceInfo({ nav: boom })).source, 'none', '存取 navigator 任何屬性都丟例外也不崩')
  // 預設計時器（沒注入 setTimeout）：以方法呼叫全域計時器，也不丟例外
  assert.equal((await detectDeviceInfo({ nav: nav0 })).source, 'client-hints')
})
