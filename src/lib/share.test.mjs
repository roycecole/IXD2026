// 分享連結（視覺參數 + 資料脈絡）與圖片分享文案的單元測試。執行：node --test src/lib/share.test.mjs
// 瀏覽器 API（location / document / navigator / File）一律用假物件注入，不依賴真實環境。
import test from 'node:test'
import assert from 'node:assert/strict'
import { PARAM_ORDER } from '../params/registry.js'
import {
  encodeParams, decodeParams, buildShareUrl, parseShareContext, hasShareContext, applyShareContext,
  shareContextOf, shareCaption, fitText, normalizeMonth, normalizeLang, encodeLinkCode, decodeLinkCode,
} from './share.js'
import { registerEn, setLocale, getLocale } from '../i18n/index.js'
import enShare from '../i18n/en/share.js'
import enAppLib from '../i18n/en/app-lib.js'
import { shareSnapshot, renderShareCard } from './capture.js'
import { useStore } from '../store/useStore.js'

registerEn(enShare); registerEn(enAppLib)

const BASE = 'https://midisea.shyetech.com/'
const allParams = (f) => Object.fromEntries(PARAM_ORDER.map((pid, i) => [pid, f(i)]))
const sample = allParams((i) => (i * 37 % 256) / 255)
const QUANT = 1 / 255 / 2 + 1e-9        // 量化成 1 byte 的最大誤差
const withLocale = async (loc, fn) => { const prev = getLocale(); setLocale(loc); try { return await fn() } finally { setLocale(prev) } }

// ---------------------------------------------------------------- 視覺參數編碼（不得動）
test('編碼位置：前 13 個參數的順序絕不能變（舊分享連結靠它解碼）', () => {
  assert.deepEqual(PARAM_ORDER.slice(0, 13),
    ['seaLevel', 'current', 'clarity', 'flowX', 'flowY', 'jellyCount', 'fishCount', 'swimSpeed', 'trashCount', 'spin', 'zoom', 'glow', 'hue'])
})

test('encode / decode 往返：每個參數誤差在 1 byte 量化內；超出 0..1 會被夾住', () => {
  const back = decodeParams(encodeParams(sample))
  for (const pid of PARAM_ORDER) assert.ok(Math.abs(back[pid] - sample[pid]) <= QUANT, pid)
  const clamped = decodeParams(encodeParams({ seaLevel: 9, current: -3 }))
  assert.equal(clamped.seaLevel, 1); assert.equal(clamped.current, 0)
})

test('舊連結（13 個位元組、只有 ?s=）照常解碼：新增的參數不在其中，不會被亂填', () => {
  // 舊版產生的連結：值 0,51,102,153,204,255,0,51,102,153,204,255,128（依舊參數順序）
  const LEGACY = 'ADNmmcz_ADNmmcz_gA'
  const d = decodeParams(LEGACY)
  assert.equal(Object.keys(d).length, 13)
  assert.equal(d.seaLevel, 0); assert.equal(d.current, 51 / 255); assert.equal(d.jellyCount, 1)
  assert.equal(d.glow, 1); assert.equal(d.hue, 128 / 255)
  assert.equal('birdCount' in d, false)
  const ctx = parseShareContext('?s=' + LEGACY)
  assert.deepEqual(ctx.params, d)
  assert.deepEqual([ctx.optionId, ctx.month, ctx.link, ctx.lang], [null, null, null, null])
  assert.equal(hasShareContext(ctx), true)
})

test('buildShareUrl 不給脈絡 → 輸出與舊版一模一樣（?s=…）', () => {
  assert.equal(buildShareUrl(sample, undefined, BASE), `${BASE}?s=${encodeParams(sample)}`)
  assert.equal(buildShareUrl(sample, null, BASE), `${BASE}?s=${encodeParams(sample)}`)
  assert.equal(buildShareUrl(sample, {}, BASE), `${BASE}?s=${encodeParams(sample)}`)
})

// ---------------------------------------------------------------- 脈絡：組出與解析
test('o / m / sl / lang：各種組合往返一致', () => {
  const cases = [
    { optionId: 'feitsui' },
    { month: 0 }, { month: 11 },
    { link: { birds: true, fish: false } }, { link: { birds: false, fish: true } }, { link: { birds: false, fish: false } },
    { lang: 'en' }, { lang: 'zh' },
    { optionId: 'hualien-tide', month: 8, link: { birds: true, fish: true }, lang: 'en' },
    { optionId: 'dust-yunlin', month: 3, lang: 'zh' },
    { optionId: 'moon-hualien', link: { birds: false, fish: true } },
  ]
  for (const c of cases) {
    const url = buildShareUrl(sample, c, BASE)
    const p = parseShareContext(new URL(url).search)
    assert.equal(p.optionId, c.optionId ?? null, url)
    assert.equal(p.month, c.month ?? null, url)
    assert.deepEqual(p.link, c.link ?? null, url)
    assert.equal(p.lang, c.lang ?? null, url)
    assert.ok(p.params && Math.abs(p.params.seaLevel - sample.seaLevel) <= QUANT, url)
  }
})

test('脈絡的 query 格式：o / m / sl / lang，接在 ?s= 之後', () => {
  const url = buildShareUrl(sample, { optionId: 'feitsui', month: 8, link: { birds: true, fish: false }, lang: 'en' }, BASE)
  assert.ok(url.startsWith(`${BASE}?s=${encodeParams(sample)}&`))
  assert.ok(url.endsWith('&o=feitsui&m=8&sl=b1f0&lang=en'), url)
})

test('month：只有手動選過（0..11）才帶；null / undefined / 越界 / 非整數都不帶', () => {
  for (const m of [null, undefined, -1, 12, 3.5, NaN, 'x', '', '1x']) assert.equal(/[?&]m=/.test(buildShareUrl(sample, { month: m }, BASE)), false, String(m))
  assert.ok(buildShareUrl(sample, { month: 0 }, BASE).endsWith('&m=0'))      // 0 是有效的（1 月），不能被當成「沒選」
  assert.ok(buildShareUrl(sample, { month: '7' }, BASE).endsWith('&m=7'))
})

test('不合法的脈絡欄位在組網址時被丟掉（不會產生壞連結 / 注入其他 query）', () => {
  const url = buildShareUrl(sample, { optionId: 'a&s=evil', lang: 'fr', link: 5 }, BASE)
  assert.equal(url, `${BASE}?s=${encodeParams(sample)}`)                      // id 含 & / = → 丟掉；lang 不是 zh|en → 丟掉；link 不是物件 → 丟掉
})

test('URL 長度合理：完整脈絡 + 目前全部參數 < 200 字元', () => {
  const url = buildShareUrl(sample, { optionId: 'hualien-tide', month: 11, link: { birds: true, fish: true }, lang: 'en' }, BASE)
  assert.ok(url.length < 200, `長度 ${url.length}：${url}`)
  const long = buildShareUrl(sample, { optionId: 'a'.repeat(48), month: 11, link: { birds: true, fish: true }, lang: 'en' }, BASE)   // id 上限 48
  assert.ok(long.length < 200, `長度 ${long.length}`)
})

test('base 可注入：測試不依賴 location；base 已有 query 時用 & 接', () => {
  assert.equal(typeof location, 'undefined')                                  // Node 沒有 location
  assert.equal(buildShareUrl(sample), `?s=${encodeParams(sample)}`)           // 沒給 base 且沒有 location → 空基底，不丟例外
  assert.equal(buildShareUrl(sample, {}, 'http://x.test/a/'), `http://x.test/a/?s=${encodeParams(sample)}`)
  assert.ok(buildShareUrl(sample, {}, 'http://x.test/?kiosk=1').startsWith('http://x.test/?kiosk=1&s='))
  const saved = globalThis.location
  globalThis.location = { origin: 'https://fake.test', pathname: '/sea/' }
  try { assert.equal(buildShareUrl(sample, {}), `https://fake.test/sea/?s=${encodeParams(sample)}`) }   // 沒給 base → 用 location
  finally { if (saved === undefined) delete globalThis.location; else globalThis.location = saved }
})

// ---------------------------------------------------------------- 容錯
test('亂碼容錯：壞的欄位只忽略該欄，其他欄照常', () => {
  const junk = [
    '', '?', '?s=', '?s=!!!', '?s=%%%', '?s=A', '?o=', '?o=%E0%A4%A', '?o=a b', '?o=../../etc', '?o=' + 'x'.repeat(80),
    '?m=', '?m=12', '?m=-1', '?m=abc', '?m=1.5', '?m=99999', '?sl=', '?sl=b2f0', '?sl=xxxx', '?sl=b1', '?lang=', '?lang=fr', '?lang=<script>',
  ]
  for (const q of junk) {
    const p = parseShareContext(q)
    assert.deepEqual(p, { params: null, optionId: null, month: null, link: null, lang: null }, q)
    assert.equal(hasShareContext(p), false, q)
  }
  // 壞 s 不影響好的 o / m
  const p = parseShareContext('?s=!!!&o=feitsui&m=4&sl=b0f1&lang=EN-us')
  assert.equal(p.params, null); assert.equal(p.optionId, 'feitsui'); assert.equal(p.month, 4)
  assert.deepEqual(p.link, { birds: false, fish: true }); assert.equal(p.lang, 'en')
  // 非字串輸入不丟例外
  for (const bad of [undefined, null, 42, {}, []]) assert.deepEqual(parseShareContext(bad), { params: null, optionId: null, month: null, link: null, lang: null })
})

test('parseShareContext：接受完整網址 / 不含問號的 query / 帶 #hash / location 物件', () => {
  const url = buildShareUrl(sample, { optionId: 'zengwen', month: 5, lang: 'zh' }, BASE)
  for (const input of [url, url + '#top', new URL(url).search, new URL(url).search.slice(1), { search: new URL(url).search }]) {
    const p = parseShareContext(input)
    assert.equal(p.optionId, 'zengwen'); assert.equal(p.month, 5); assert.equal(p.lang, 'zh'); assert.ok(p.params)
  }
})

test('不存在的 option id：給了已知清單就忽略該欄（Array / Set 都行）；格式正確但未知的 id 不算分享內容', () => {
  const ids = ['feitsui', 'zengwen']
  assert.equal(parseShareContext('?o=feitsui', { optionIds: ids }).optionId, 'feitsui')
  assert.equal(parseShareContext('?o=nope', { optionIds: ids }).optionId, null)
  assert.equal(parseShareContext('?o=nope', { optionIds: new Set(ids) }).optionId, null)
  assert.equal(parseShareContext('?o=zengwen', { optionIds: new Set(ids) }).optionId, 'zengwen')
  assert.equal(parseShareContext('?o=nope').optionId, 'nope')                  // 沒給清單 → 只驗格式（存在與否由 applyShareContext 對照 gov.options）
  assert.equal(hasShareContext(parseShareContext('?o=nope', { optionIds: ids })), false)
  assert.equal(hasShareContext(parseShareContext('?o=nope&m=2', { optionIds: ids })), true)   // 其他欄仍有效
})

test('hasShareContext：只有 lang 不算分享內容（展場網址常單獨帶 ?lang=）；m=0 算', () => {
  assert.equal(hasShareContext(parseShareContext('?lang=en')), false)
  assert.equal(hasShareContext(parseShareContext('?kiosk=1&hud=0')), false)
  assert.equal(hasShareContext(parseShareContext('?m=0')), true)
  assert.equal(hasShareContext(parseShareContext('?sl=b0f0')), true)
  assert.equal(hasShareContext(parseShareContext('?o=feitsui')), true)
  assert.equal(hasShareContext(null), false)
})

test('normalize / linkCode 小工具', () => {
  assert.equal(normalizeLang('EN'), 'en'); assert.equal(normalizeLang('zh-TW'), 'zh'); assert.equal(normalizeLang('zh_Hant'), 'zh')
  assert.equal(normalizeLang('english'), null); assert.equal(normalizeLang(null), null)
  assert.equal(normalizeMonth(null), null); assert.equal(normalizeMonth('05'), 5); assert.equal(normalizeMonth(11), 11); assert.equal(normalizeMonth(12), null)
  assert.equal(encodeLinkCode({ birds: true, fish: false }), 'b1f0'); assert.equal(encodeLinkCode(null), 'b0f0')
  assert.deepEqual(decodeLinkCode('b0f1'), { birds: false, fish: true }); assert.equal(decodeLinkCode('b1f2'), null)
})

test('shareContextOf：由 store 狀態組脈絡（month 沒手動選過 = null）', () => {
  assert.deepEqual(shareContextOf({ govOptionId: 'feitsui', surveyMonth: null, surveyLink: { birds: true, fish: false } }, 'en'),
    { optionId: 'feitsui', month: null, link: { birds: true, fish: false }, lang: 'en' })
  assert.deepEqual(shareContextOf({ govOptionId: 'x', surveyMonth: 0, surveyLink: { birds: false, fish: false } }, 'zh').month, 0)
  assert.deepEqual(shareContextOf(null, null), { optionId: null, month: null, link: null, lang: null })
  // 端到端：組脈絡 → 組網址 → 解析回來
  const st = { govOptionId: 'nanhua', surveyMonth: 6, surveyLink: { birds: false, fish: true } }
  const p = parseShareContext(buildShareUrl(sample, shareContextOf(st, 'en'), BASE))
  assert.equal(p.optionId, 'nanhua'); assert.equal(p.month, 6); assert.deepEqual(p.link, { birds: false, fish: true }); assert.equal(p.lang, 'en')
})

// ---------------------------------------------------------------- 套用順序
function fakeStore(options) {
  const calls = []
  const st = {
    gov: options ? { options } : null,
    setGovOption: (id) => calls.push(['option', id]), setSurveyMonth: (m) => calls.push(['month', m]),
    applySharedContext: (c) => calls.push(['link', c.link]), applyParams: (p) => calls.push(['params', p]),
  }
  return { calls, store: { getState: () => st } }
}

test('applyShareContext：順序＝海況選項 → 月份 → 連動 → 視覺參數（最後套，蓋掉選項帶來的參數）→ 語系', () => {
  const { calls, store } = fakeStore([{ id: 'feitsui' }, { id: 'zengwen' }])
  const langs = []
  const ctx = parseShareContext('?s=' + encodeParams(sample) + '&o=zengwen&m=8&sl=b1f0&lang=en')
  const done = applyShareContext(store, ctx, { getLocale: () => 'zh', setLocale: (l) => langs.push(l) })
  assert.deepEqual(calls.map((c) => c[0]), ['option', 'month', 'link', 'params'])
  assert.equal(calls[0][1], 'zengwen'); assert.equal(calls[1][1], 8); assert.deepEqual(calls[2][1], { birds: true, fish: false })
  assert.ok(Math.abs(calls[3][1].seaLevel - sample.seaLevel) <= QUANT)
  assert.deepEqual(langs, ['en'])
  assert.deepEqual(done, { option: true, month: true, link: true, params: true, lang: true })
})

test('applyShareContext：不存在的 option id 跳過（其餘照常）；語系相同不重設；沒給 io 不丟例外', () => {
  const { calls, store } = fakeStore([{ id: 'feitsui' }])
  const done = applyShareContext(store, parseShareContext('?o=ghost&m=2&lang=zh'), { getLocale: () => 'zh', setLocale: () => assert.fail('語系相同不該重設') })
  assert.deepEqual(calls, [['month', 2]])
  assert.deepEqual(done, { option: false, month: true, link: false, params: false, lang: false })
  // 舊連結（只有 s）：只套視覺參數，不碰海況選項 / 月份 / 連動
  const old = fakeStore([{ id: 'feitsui' }])
  applyShareContext(old.store, parseShareContext('?s=ADNmmcz_ADNmmcz_gA'))
  assert.deepEqual(old.calls.map((c) => c[0]), ['params'])
  // 資料還沒載入（gov = null）→ 選項跳過、不丟例外
  const nogov = fakeStore(null)
  assert.doesNotThrow(() => applyShareContext(nogov.store, parseShareContext('?o=feitsui&s=ADNm')))
  assert.deepEqual(nogov.calls.map((c) => c[0]), ['params'])
  assert.deepEqual(applyShareContext(null, null), { option: false, month: false, link: false, params: false, lang: false })
})

test('store.applySharedContext：鳥 / 魚連動只進記憶體，不寫 localStorage；只吃布林', () => {
  const writes = []
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: (k, v) => writes.push([k, v]), removeItem: () => {} } })
  try {
    const before = { ...useStore.getState().surveyLink }
    useStore.getState().applySharedContext({ link: { birds: !before.birds, fish: !before.fish } })
    const now = useStore.getState().surveyLink
    assert.equal(now.birds, !before.birds); assert.equal(now.fish, !before.fish)
    assert.deepEqual(writes, [], '分享連結不該改掉對方的偏好（不寫 localStorage）')
    useStore.getState().applySharedContext({ link: { birds: 'yes', fish: 1 } })     // 非布林 → 忽略
    assert.equal(useStore.getState().surveyLink.birds, !before.birds)
    for (const bad of [undefined, null, {}, { link: null }, { link: 'b1f0' }]) assert.doesNotThrow(() => useStore.getState().applySharedContext(bad))
    assert.deepEqual(writes, [])
    useStore.setState({ surveyLink: before })
  } finally {
    if (desc) Object.defineProperty(globalThis, 'localStorage', desc); else delete globalThis.localStorage
  }
})

test('端到端（真的 store）：先選海況、再套分享參數 → 視覺參數不被海況參數蓋掉', () => {
  const gov = { options: [{ id: 'A', name: 'A', params: { seaLevel: 0.9, hue: 0.1 } }, { id: 'B', name: 'B', params: { seaLevel: 0.2 } }], defaultOption: 'A' }
  useStore.getState().setGov(gov)
  const p = { ...sample, seaLevel: 0.5, hue: 0.75 }
  const url = buildShareUrl(p, { optionId: 'B', month: 2, link: { birds: false, fish: false }, lang: 'zh' }, BASE)
  const done = applyShareContext(useStore, parseShareContext(url, { optionIds: gov.options.map((o) => o.id) }), { getLocale, setLocale })
  const st = useStore.getState()
  assert.equal(done.option, true)
  assert.equal(st.govOptionId, 'B'); assert.equal(st.surveyMonth, 2)
  assert.ok(Math.abs(st.params.seaLevel - 0.5) <= QUANT, `seaLevel=${st.params.seaLevel}（不該是 B 的 0.2）`)
  assert.ok(Math.abs(st.params.hue - 0.75) <= QUANT)
  useStore.setState({ surveyMonth: null })
})

// ---------------------------------------------------------------- 圖片分享文案
test('shareCaption：中文「我在 MidiSea 演了一片海 [網址]」、英文 "I played a sea in MidiSea [url]"', async () => {
  const url = buildShareUrl(sample, { optionId: 'feitsui', month: 8, link: { birds: true, fish: false }, lang: 'en' }, BASE)
  assert.equal(await withLocale('zh', () => shareCaption({ url })), `我在 MidiSea 演了一片海 ${url}`)
  assert.equal(await withLocale('en', () => shareCaption({ url })), `I played a sea in MidiSea ${url}`)
})

test('shareCaption：url 內的特殊字元不被插值吃掉；text 優先；缺網址補在後面；都沒給 → 舊文案', async () => {
  const url = `${BASE}?s=AB$&C&o=x$1$&`                      // $& / $1 是 String.replace 的特殊樣式
  assert.equal(shareCaption({ url }), `我在 MidiSea 演了一片海 ${url}`)
  assert.equal(shareCaption({ text: '自訂文案', url: 'http://u.test/' }), '自訂文案 http://u.test/')
  assert.equal(shareCaption({ text: '已含 http://u.test/ 的文案', url: 'http://u.test/' }), '已含 http://u.test/ 的文案')
  assert.equal(shareCaption({ text: '只有文字' }), '只有文字')
  assert.equal(shareCaption({}), '我在 MidiSea 演了一片海')
  assert.equal(shareCaption(), '我在 MidiSea 演了一片海')
  assert.equal(await withLocale('en', () => shareCaption({})), 'I played an ocean on MidiSea')   // 舊文案的既有英文
})

test('英文字典：分享文案的 {url} 佔位符與中文一致', () => {
  for (const [k, v] of Object.entries(enShare)) {
    const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join()
    assert.equal(ph(String(v)), ph(k), k)
    assert.equal(/[㐀-鿿]/.test(String(v)), false, k)
  }
})

// ---------------------------------------------------------------- fitText（分享卡排版）
const measure = (s, px) => [...s].length * px * 0.55
test('fitText：塞得下 → 原樣；太長 → 先縮字級；縮到底還太長 → 截斷加「…」；結果一定塞得進 maxW', () => {
  assert.deepEqual(fitText(measure, 'short', 30, 984, 22), { text: 'short', px: 30 })
  const a = fitText(measure, 'x'.repeat(66), 30, 984, 22)               // 66*30*.55=1089 → 縮到 ≥22
  assert.equal(a.text, 'x'.repeat(66)); assert.ok(a.px < 30 && a.px >= 22 && measure(a.text, a.px) <= 984, JSON.stringify(a))
  const b = fitText(measure, 'y'.repeat(200), 30, 984, 22)              // 縮到 22 也放不下 → 截斷
  assert.equal(b.px, 22); assert.ok(b.text.endsWith('…') && b.text.length < 200 && measure(b.text, b.px) <= 984)
  assert.deepEqual(fitText(measure, '', 30, 984), { text: '', px: 30 })
  assert.equal(fitText(measure, 'z'.repeat(50), 26, 984).px, 26)         // 沒給 minPx 也有預設下限
  assert.ok(fitText(measure, 'z'.repeat(400), 26, 984).px >= 18)
  assert.equal(fitText(measure, '中'.repeat(50), 40, 10, 30).text, '…')   // 極端：連一個字都放不下
})

// ---------------------------------------------------------------- shareSnapshot（假 DOM / navigator）
function installFakeDom({ share, canShare = true, clipboard, canvas = true } = {}) {
  const drawn = []
  const ctx = (() => {
    const state = { font: '' }
    return new Proxy(state, {
      get(t, k) {
        if (k in t) return t[k]
        if (k === 'measureText') return (s) => ({ width: measure(s, parseFloat(/(\d+)px/.exec(t.font)?.[1]) || 10) })
        if (k === 'createLinearGradient') return () => ({ addColorStop() {} })
        if (k === 'fillText') return (text, x, y) => drawn.push({ text, x, y, font: t.font })
        return () => {}
      },
      set(t, k, v) { t[k] = v; return true },
    })
  })()
  const saved = { document: globalThis.document, navigator: globalThis.navigator }
  const downloads = []
  const mkCanvas = () => ({ width: 0, height: 0, getContext: () => ctx, toBlob: (cb) => cb(new Blob(['png'], { type: 'image/png' })) })
  globalThis.document = {
    querySelector: () => (canvas ? { width: 1200, height: 800, clientWidth: 1200 } : null),
    createElement: (tag) => (tag === 'canvas' ? mkCanvas() : { click() { downloads.push(this.download) }, remove() {}, set download(v) { this._d = v }, get download() { return this._d } }),
    body: { appendChild() {} },
  }
  const nav = { canShare: canShare ? () => true : undefined, share, clipboard }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: nav })
  return { drawn, downloads, restore() { globalThis.document = saved.document; Object.defineProperty(globalThis, 'navigator', { configurable: true, value: saved.navigator }) } }
}

test('shareSnapshot 走系統分享：files + title + text（文案含網址），不另傳 url（避免重複）', async () => {
  const shared = []
  const dom = installFakeDom({ share: async (d) => { shared.push(d) } })
  const url = buildShareUrl(sample, { optionId: 'feitsui', lang: 'zh' }, BASE)
  try {
    const r = await shareSnapshot({ lines: ['a｜b'], url })
    assert.deepEqual(r, { ok: true, how: 'share' })
    assert.equal(shared.length, 1)
    assert.deepEqual(Object.keys(shared[0]).sort(), ['files', 'text', 'title'])
    assert.equal(shared[0].text, `我在 MidiSea 演了一片海 ${url}`)
    assert.equal(shared[0].files.length, 1); assert.equal(shared[0].files[0].type, 'image/png')
    assert.equal(shared[0].title, 'MidiSea 資料導演台')
  } finally { dom.restore() }
})

test('shareSnapshot 英文語系：文案 "I played a sea in MidiSea [url]"', async () => {
  const shared = []
  const dom = installFakeDom({ share: async (d) => { shared.push(d) } })
  try {
    await withLocale('en', () => shareSnapshot({ url: BASE + '?s=x' }))
    assert.equal(shared[0].text, `I played a sea in MidiSea ${BASE}?s=x`)
    assert.equal(shared[0].title, 'MidiSea Data Director')
  } finally { dom.restore() }
})

test('shareSnapshot 使用者取消 → cancel（不下載、不複製）', async () => {
  const copied = []
  const dom = installFakeDom({ share: async () => { const e = new Error('x'); e.name = 'AbortError'; throw e }, clipboard: { writeText: async (s) => copied.push(s) } })
  try {
    const r = await shareSnapshot({ url: BASE })
    assert.deepEqual(r, { ok: true, how: 'cancel' }); assert.deepEqual(dom.downloads, []); assert.deepEqual(copied, [])
  } finally { dom.restore() }
})

test('shareSnapshot 不支援檔案分享 → 下載 PNG，同一段文案（含網址）複製到剪貼簿', async () => {
  const copied = []
  const dom = installFakeDom({ canShare: false, clipboard: { writeText: async (s) => { copied.push(s) } } })
  const url = buildShareUrl(sample, { optionId: 'zengwen', month: 1, lang: 'en' }, BASE)
  try {
    const r = await shareSnapshot({ url })
    assert.deepEqual(r, { ok: true, how: 'download', ar: false, copied: true })
    assert.deepEqual(dom.downloads, ['midisea-star.png'])
    assert.deepEqual(copied, [`我在 MidiSea 演了一片海 ${url}`])
  } finally { dom.restore() }
})

test('shareSnapshot 系統分享丟出非取消的錯誤 → 退回下載 + 複製', async () => {
  const copied = []
  const dom = installFakeDom({ share: async () => { const e = new Error('nope'); e.name = 'NotAllowedError'; throw e }, clipboard: { writeText: async (s) => { copied.push(s) } } })
  try {
    const r = await shareSnapshot({ url: BASE + '?s=q' })
    assert.equal(r.how, 'download'); assert.equal(r.copied, true); assert.equal(copied.length, 1)
  } finally { dom.restore() }
})

test('shareSnapshot 剪貼簿失敗 / 不存在：不報錯，copied=false', async () => {
  for (const clipboard of [{ writeText: async () => { throw new Error('denied') } }, undefined, {}]) {
    const dom = installFakeDom({ canShare: false, clipboard })
    try {
      const r = await shareSnapshot({ url: BASE })
      assert.deepEqual(r, { ok: true, how: 'download', ar: false, copied: false })
    } finally { dom.restore() }
  }
})

test('shareSnapshot 向下相容：舊呼叫端不給 url / text → 分享文案維持舊版、下載時不動剪貼簿', async () => {
  const shared = [], copied = []
  const dom = installFakeDom({ share: async (d) => { shared.push(d) }, clipboard: { writeText: async (s) => copied.push(s) } })
  try {
    await shareSnapshot({ lines: [] })
    assert.equal(shared[0].text, '我在 MidiSea 演了一片海')
  } finally { dom.restore() }
  const dom2 = installFakeDom({ canShare: false, clipboard: { writeText: async (s) => copied.push(s) } })
  try {
    const r = await shareSnapshot({ lines: [] })
    assert.equal(r.how, 'download'); assert.equal(r.copied, false); assert.deepEqual(copied, [])
  } finally { dom2.restore() }
})

test('shareSnapshot 自訂 text：以它為準，缺網址時補在後面', async () => {
  const shared = []
  const dom = installFakeDom({ share: async (d) => { shared.push(d) } })
  try {
    await shareSnapshot({ text: 'hello', url: 'http://u.test/?s=1' })
    assert.equal(shared[0].text, 'hello http://u.test/?s=1')
  } finally { dom.restore() }
})

test('shareSnapshot 找不到畫布 → ok:false', async () => {
  const dom = installFakeDom({ canvas: false })
  try { const r = await shareSnapshot({ url: BASE }); assert.equal(r.ok, false); assert.equal(r.why, '找不到畫布') } finally { dom.restore() }
})

test('分享卡：英文語系下每一行文字都塞得進版面（1080 - 左右各 48）；中文版面塞得下的文字維持原字級', async () => {
  const longEn = ['Reservoir｜Feitsui Reservoir water level 77.3% → sea level 0.77 (full)', 'Weather｜Clear · 29.2°C · humidity 83% · wind 0.86 m/s → current speed', 'Bird flocks｜Tamsui River basin · Sep: 79 species (interpolated) → 3 flocks']
  const dom = installFakeDom({})
  try {
    await withLocale('en', () => renderShareCard({ lines: longEn }))
    assert.ok(dom.drawn.length >= 5)
    for (const d of dom.drawn) assert.ok(measure(d.text, parseFloat(/(\d+)px/.exec(d.font)[1])) <= 984 + 1e-6, `溢出：${d.font} ${d.text}`)
    const url = dom.drawn.find((d) => d.text.startsWith('midisea.shyetech.com'))
    assert.ok(url && /^400 \d+px/.test(url.font)); assert.ok(parseFloat(/(\d+)px/.exec(url.font)[1]) < 30, '英文網址列 66 字元 → 應縮字級')
  } finally { dom.restore() }
  const dom2 = installFakeDom({})
  try {
    renderShareCard({ lines: ['水庫｜翡翠水庫 水位 77.3% → 海水高度 0.77'] })
    const px = (txt) => { const d = dom2.drawn.find((x) => x.text.startsWith(txt)); return d && d.font }
    assert.equal(px('水庫｜'), '400 26px system-ui, -apple-system, "Noto Sans TC", sans-serif')
    assert.equal(px('MidiSea 資料導演台'), '600 44px system-ui, -apple-system, "Noto Sans TC", sans-serif')
    assert.equal(px('midisea.shyetech.com'), '400 30px system-ui, -apple-system, "Noto Sans TC", sans-serif')
  } finally { dom2.restore() }
})

test('真實 ocean.json 端到端：套用分享連結時，分享的鳥 / 魚連動狀態不會被寫進 localStorage', async () => {
  const { readFileSync } = await import('node:fs')
  const real = JSON.parse(readFileSync(new URL('../../public/data/ocean.json', import.meta.url), 'utf8'))
  const ids = real.options.map((o) => o.id)
  assert.ok(ids.includes('zengwen') && ids.includes('hualien-tide'))
  const writes = []
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: (k, v) => writes.push([k, v]), removeItem: () => {} } })
  try {
    useStore.setState({ surveyLink: { birds: true, fish: false }, surveyMonth: null })      // 對方自己的偏好
    useStore.getState().setGov(real)
    const p = { ...sample, seaLevel: 0.31, fishCount: 0.9 }
    const url = buildShareUrl(p, { optionId: 'zengwen', month: 8, link: { birds: false, fish: true }, lang: 'zh' }, BASE)
    const share = parseShareContext(url, { optionIds: ids })
    const done = applyShareContext(useStore, share, { getLocale, setLocale })
    const st = useStore.getState()
    assert.deepEqual([done.option, done.month, done.link, done.params], [true, true, true, true])
    assert.equal(st.govOptionId, 'zengwen'); assert.equal(st.surveyMonth, 8)
    assert.deepEqual(st.surveyLink, { birds: false, fish: true })                            // 暫時套用分享者的連動狀態
    assert.ok(Math.abs(st.params.seaLevel - 0.31) <= QUANT); assert.ok(Math.abs(st.params.fishCount - 0.9) <= QUANT)   // 視覺參數贏過選項 / 資料連動
    for (const [k, v] of writes) if (k === 'ixd2026.surveyLink') assert.equal(JSON.parse(v).fish, false, '分享連結的 fish:true 不該被存起來')
  } finally {
    useStore.setState({ surveyLink: { birds: true, fish: false }, surveyMonth: null })
    if (desc) Object.defineProperty(globalThis, 'localStorage', desc); else delete globalThis.localStorage
  }
})
