// i18n 驗收：node --test src/i18n/i18n.test.mjs（npm test 也會跑）
// 中文是 key、英文在 src/i18n/en/*.js。失敗時訊息會列出檔案與行號；node scripts/i18n-report.mjs 看完整清單。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { scan, loadEnDict, placeholders, HAN } from '../../scripts/i18n-check.mjs'
import { registerEn, setLocale, t, getLocale } from './index.js'

const res = scan()
const { dict, dupes } = await loadEnDict()
registerEn(dict)
const fmt = (a) => a.slice(0, 25).map((x) => `  ${x.file || ''}:${x.line ?? ''} ${x.text ?? x}`).join('\n') + (a.length > 25 ? `\n  …還有 ${a.length - 25} 筆` : '')

// 英文值一律不得含中文（專有名詞若要保留原文，請在此登記完整的 key）
const EN_HAN_ALLOW = new Set([])

test('沒有解析失敗的檔案', () => assert.deepEqual(res.errors, []))

test('所有中文字面量都包在 t() / T() 裡（註解、console、GLSL 不算）', () => {
  assert.equal(res.stray.length, 0, `未包 t() 的中文 ${res.stray.length} 處：\n${fmt(res.stray)}`)
})

test('每個 t() / T() 的 key 都有英文', () => {
  const missing = [...res.keys.entries()].filter(([k]) => !(k in dict)).map(([k, where]) => ({ file: where, text: k }))
  assert.equal(missing.length, 0, `缺英文 ${missing.length} 個：\n${fmt(missing)}`)
})

test('字典檔之間沒有「譯文互相衝突」的重複 key（譯文相同的重複宣告無妨）', () => assert.deepEqual(dupes, []))

test('英文值的 {placeholder} 與中文 key 一致；英文值不含中文', () => {
  const bad = []
  for (const [k, v] of Object.entries(dict)) {
    if (typeof v === 'string') {
      const a = [...placeholders(k)].sort().join(','), b = [...placeholders(v)].sort().join(',')
      if (a !== b) bad.push({ text: `${k.slice(0, 40)} → {${a}} vs {${b}}` })
      if (HAN.test(v) && !EN_HAN_ALLOW.has(k)) bad.push({ text: `英文值含中文：${k.slice(0, 30)} → ${v.slice(0, 40)}` })
    } else if (typeof v !== 'function') bad.push({ text: `英文值型別錯誤：${k.slice(0, 40)}` })
  }
  assert.equal(bad.length, 0, fmt(bad))
})

test('函式型英文值（單複數）能吃參數、回傳不含中文的字串', () => {
  for (const [k, v] of Object.entries(dict)) {
    if (typeof v !== 'function') continue
    const params = Object.fromEntries([...placeholders(k)].map((p) => [p, 2]))
    const out = v(params)
    assert.equal(typeof out, 'string', k)
    assert.ok(!HAN.test(out), `${k} → ${out}`)
  }
})

// ---- 資料層：政府資料裡的名稱（水庫 / 流域 / 縣市 / 天氣 / 農曆 / 潮差）英文模式下不能出現中文 ----
test('ocean.json 的名稱在英文模式下都有譯名（測站與河川名稱是原始專有名詞，不在此列）', async () => {
  const ocean = JSON.parse(readFileSync(new URL('../../public/data/ocean.json', import.meta.url), 'utf8'))
  const data = await import('./data.js')          // 由資料層實作：weatherText / lunarLabelText
  setLocale('en')
  try {
    const names = new Set()
    for (const o of ocean.options) { names.add(o.name); for (const k of ['birds', 'fish']) if (o[k] && o[k].basin) names.add(o[k].basin) }
    names.add(ocean.dust.county); names.add(ocean.moon.county)
    if (ocean.station && ocean.station.name) names.add(ocean.station.name)
    const bad = []
    for (const n of names) { const out = t(n); if (HAN.test(out)) bad.push({ text: `${n} → ${out}` }) }
    const w = ocean.weather && ocean.weather.weather
    if (w) { const out = data.weatherText(w); if (HAN.test(out)) bad.push({ text: `weather ${w} → ${out}` }) }
    for (const o of ocean.options) {
      const s = o.series
      if (s && s.lunarLabel) { const out = data.lunarLabelText(s.lunarLabel); if (HAN.test(out)) bad.push({ text: `lunar ${s.lunarLabel} → ${out}` }) }
      if (s && s.range) { const out = t(s.range); if (HAN.test(out)) bad.push({ text: `range ${s.range} → ${out}` }) }
    }
    assert.equal(bad.length, 0, fmt(bad))
    // 常見 CWA 天氣詞與所有農曆日期（初一到三十、正月到臘月）也要能譯
    for (const zh of ['晴', '多雲', '陰', '短暫陣雨', '多雲時晴', '陰時多雲', '陰短暫雨', '晴時多雲', '多雲午後短暫雷陣雨', '陰有雨', '霧']) assert.ok(!HAN.test(data.weatherText(zh)), `weather ${zh} → ${data.weatherText(zh)}`)
    const months = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '臘']
    const days = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十', '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十']
    for (const m of months) for (const d of days) { const zh = `農曆${m}月${d}`; const out = data.lunarLabelText(zh); assert.ok(!HAN.test(out), `${zh} → ${out}`) }
  } finally { setLocale('zh') }
  assert.equal(getLocale(), 'zh')
})

test('中文模式下 t() 原樣回傳（既有中文輸出不變）', () => {
  setLocale('zh')
  assert.equal(t('分享星球'), '分享星球')
  assert.equal(t('資料 {n} 站', { n: 3 }), '資料 3 站')
})

// =============================================================================================
// 英文字典「動態載入」（第 5 輪）：瀏覽器由 loadEnglish() 載入單一 chunk；Node 沒有載入器、行為完全同步（上面所有測試就是這條路徑）。
// 下面用 __setEnglishLoader 注入假載入器，走瀏覽器的非同步路徑（loader 狀態機本身見 loader.test.mjs）。
// =============================================================================================
import * as i18n from './index.js'
import { parse } from '@babel/parser'
import traverseMod from '@babel/traverse'
import { listSourceFiles } from '../../scripts/i18n-check.mjs'
import * as enDataModule from './en/data.js'
import * as tables from './data-tables.js'

const traverse = (traverseMod.default && traverseMod.default.default) || traverseMod.default || traverseMod
const tick = () => new Promise((r) => setImmediate(r))
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const KEY = '載入器測試用字串甲', KEY2 = '載入器測試用字串乙', KEY3 = '載入器測試用字串丁'   // 每個測試用不同的 key（registerEn 是全域合併，不會自己清掉）
const resetLocale = () => { i18n.__setEnglishLoader(null); i18n.useLocaleStore.setState({ locale: 'zh' }) }
const muteWarn = () => { const real = console.warn; const calls = []; console.warn = (...a) => { calls.push(a) }; return { calls, restore: () => { console.warn = real } } }
function fakeTimers() {   // 會檢查 this 的假計時器（瀏覽器的原生 setTimeout 掛到別的物件上會丟 Illegal invocation）
  let now = 0, seq = 0
  const q = new Map()
  const self = {
    setTimeout(fn, ms) { if (this !== self) throw new TypeError('Illegal invocation'); const id = ++seq; q.set(id, { at: now + ms, fn }); return id },
    clearTimeout(id) { if (this !== self) throw new TypeError('Illegal invocation'); q.delete(id) },
    advance(ms) { now += ms; for (const [id, t] of [...q].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now && q.has(id)) { q.delete(id); t.fn() } },
    get pending() { return q.size },
  }
  return self
}

test('Node 預設：沒有載入器 = 字典視為已就緒；loadEnglish() 立刻 resolve；bootLocale() 不必等（skip）；setLocale 同步生效（既有測試不需要改）', async () => {
  assert.equal(i18n.isEnglishReady(), true)
  await i18n.loadEnglish()
  assert.deepEqual(await i18n.bootLocale(), { status: 'skip', locale: 'zh' })
  assert.equal(setLocale('en'), undefined, 'setLocale 跟以前一樣回傳 undefined')
  assert.equal(getLocale(), 'en', '同步生效')
  assert.equal(i18n.toggleLocale(), 'zh', 'toggleLocale 回傳目前語系')
  assert.equal(i18n.isLocaleLoading(), false)
})

test('setLocale（瀏覽器路徑，字典未載入）：先載入、載完才切；期間 locale 維持原樣、isLocaleLoading = true；toggleLocale 回傳「目前」語系；切回 zh 不必載入', async () => {
  const d = deferred(); let loads = 0
  i18n.__setEnglishLoader(() => { loads += 1; return d.promise.then(() => { registerEn({ [KEY]: 'Loaded string' }) }) })
  try {
    assert.equal(i18n.isEnglishReady(), false)
    assert.equal(setLocale('en'), undefined)
    assert.equal(getLocale(), 'zh', '載入完成前 locale 不變'); assert.equal(t(KEY), KEY); assert.equal(i18n.isLocaleLoading(), true)
    assert.equal(i18n.toggleLocale(), 'zh', 'toggleLocale 回傳「目前」語系（en 還在載入 → 仍是 zh）')
    assert.equal(loads, 1, '連按共用同一次載入')
    d.resolve(); await tick()
    assert.equal(getLocale(), 'en'); assert.equal(t(KEY), 'Loaded string', '切換當下字典已就緒'); assert.equal(i18n.isLocaleLoading(), false)
    assert.equal(i18n.isEnglishReady(), true); assert.equal(loads, 1)
    setLocale('zh'); assert.equal(getLocale(), 'zh'); assert.equal(t(KEY), KEY, '切回 zh 同步、不需要載入')
    setLocale('en'); assert.equal(getLocale(), 'en', '字典已快取 → 之後切 en 是同步的'); assert.equal(loads, 1)
  } finally { resetLocale() }
})

test('setLocale：載入失敗 → 維持中文、不丟例外、console 記一行；再按一次會重試；等字典期間改選 zh 就不切', async () => {
  const w = muteWarn(); let n = 0; const d2 = deferred()
  i18n.__setEnglishLoader(() => { n += 1; return n === 1 ? Promise.reject(new Error('chunk 404')) : d2.promise.then(() => { registerEn({ [KEY2]: 'Second' }) }) })
  try {
    setLocale('en'); await tick()
    assert.equal(getLocale(), 'zh', '維持中文'); assert.equal(i18n.isLocaleLoading(), false); assert.equal(i18n.isEnglishReady(), false)
    assert.equal(w.calls.length, 1); assert.match(String(w.calls[0].join(' ')), /chunk 404/)
    const p = i18n.setLocaleAsync('en')                         // 重試
    assert.equal(n, 2); assert.equal(i18n.isLocaleLoading(), true)
    setLocale('zh')                                             // 等待期間改選 zh → 取消
    d2.resolve(); assert.equal(await p, 'zh'); assert.equal(getLocale(), 'zh')
    assert.equal(i18n.isEnglishReady(), true, '字典仍然載入完成並快取')
    setLocale('en'); assert.equal(getLocale(), 'en'); assert.equal(t(KEY2), 'Second')
  } finally { w.restore(); resetLocale() }
})

test('setLocaleAsync：回傳 Promise<切換後生效的語系>（永遠 resolve）；Node 預設也是', async () => {
  assert.equal(await i18n.setLocaleAsync('en'), 'en'); assert.equal(await i18n.setLocaleAsync('zh'), 'zh'); assert.equal(await i18n.setLocaleAsync('fr'), 'zh')
  const w = muteWarn()
  i18n.__setEnglishLoader(() => Promise.reject(new Error('x')))
  try { assert.equal(await i18n.setLocaleAsync('en'), 'zh', '失敗 = 維持原語系，不 reject') } finally { w.restore(); resetLocale() }
})

test('loadEnglish：載入中共用同一個 promise、失敗 reject 且可重試、成功後快取（不再載入）', async () => {
  const w = muteWarn(); let n = 0; const d = deferred()
  const l = i18n.__setEnglishLoader(() => { n += 1; return n === 1 ? Promise.reject(new Error('offline')) : d.promise })
  try {
    await assert.rejects(i18n.loadEnglish(), /offline/); assert.equal(i18n.isEnglishReady(), false); assert.equal(l.getState(), 'failed')
    const a = i18n.loadEnglish(), b = i18n.loadEnglish(); assert.equal(a, b); assert.equal(n, 2)
    d.resolve(); await a; assert.equal(i18n.isEnglishReady(), true)
    await i18n.loadEnglish(); assert.equal(n, 2)
  } finally { w.restore(); resetLocale() }
})

test('bootLocale：偵測到 en 而字典未就緒 → store 先是 zh；等字典就緒後切到 en（status ready）；逾時 → 先以中文 render、字典之後到了自動切換；失敗 → 維持 zh', async () => {
  // 就緒
  const d = deferred()
  i18n.__setEnglishLoader(() => d.promise.then(() => { registerEn({ [KEY]: 'Boot string' }) }), { desired: 'en' })
  try {
    assert.equal(getLocale(), 'zh', '字典就緒前生效語系是 zh（不變式：en 代表字典已載入）')
    const p = i18n.bootLocale({ timeoutMs: 8000, timers: fakeTimers() })
    d.resolve()
    assert.deepEqual(await p, { status: 'ready', locale: 'en' }); assert.equal(t(KEY), 'Boot string')
  } finally { resetLocale() }
  // 逾時
  const tm = fakeTimers(); const d2 = deferred()
  i18n.__setEnglishLoader(() => d2.promise, { desired: 'en' })
  try {
    const p = i18n.bootLocale({ timeoutMs: 8000, timers: tm })
    tm.advance(8000)
    assert.deepEqual(await p, { status: 'timeout', locale: 'zh' }, '逾時：先以中文 render')
    assert.equal(tm.pending, 0); assert.equal(i18n.isLocaleLoading(), true)
    d2.resolve(); await tick()
    assert.equal(getLocale(), 'en', '字典晚到 → 自動切換（訂閱 useLocaleStore 的元件會重繪）'); assert.equal(i18n.isLocaleLoading(), false)
  } finally { resetLocale() }
  // 失敗
  const w = muteWarn()
  i18n.__setEnglishLoader(() => Promise.reject(new Error('down')), { desired: 'en' })
  try { assert.deepEqual(await i18n.bootLocale({ timeoutMs: 8000, timers: fakeTimers() }), { status: 'failed', locale: 'zh' }); assert.equal(w.calls.length, 1) } finally { w.restore(); resetLocale() }
})

test('安全網：有人直接把 store 設成 en（觀眾視窗跟隨主視窗就是這樣，不走 setLocale）而字典沒載入 → 自動補載；載完 rev + 1（useT 訂閱它 → 元件重繪）', async () => {
  const d = deferred(); let loads = 0
  i18n.__setEnglishLoader(() => { loads += 1; return d.promise.then(() => { registerEn({ [KEY3]: 'Late English' }) }) })
  try {
    const rev0 = i18n.useLocaleStore.getState().rev
    i18n.useLocaleStore.setState({ locale: 'en' })
    assert.equal(loads, 1, '補載'); assert.equal(t(KEY3), KEY3, '字典到之前仍是中文（退回原文）')
    d.resolve(); await tick()
    assert.equal(t(KEY3), 'Late English'); assert.equal(i18n.useLocaleStore.getState().rev, rev0 + 1, 'rev + 1 通知重繪')
    i18n.useLocaleStore.setState({ locale: 'zh' }); i18n.useLocaleStore.setState({ locale: 'en' })
    assert.equal(loads, 1, '已就緒就不再載入')
  } finally { resetLocale() }
  // 補載失敗：不丟例外（只記一行）、locale 不被動
  const w = muteWarn()
  i18n.__setEnglishLoader(() => Promise.reject(new Error('nope')))
  try { i18n.useLocaleStore.setState({ locale: 'en' }); await tick(); assert.equal(getLocale(), 'en'); assert.equal(w.calls.length, 1) } finally { w.restore(); resetLocale() }
})

test('字典未載入時的 translate(en, …) 退回中文原文（不算缺英文、不丟例外）；載入後同一個 key 翻成英文', async () => {
  const d = deferred()
  i18n.__setEnglishLoader(() => d.promise.then(() => { registerEn({ '載入器測試用字串丙 {n}': 'Third {n}' }) }))
  try {
    assert.equal(i18n.translate('en', '載入器測試用字串丙 {n}', { n: 2 }), '載入器測試用字串丙 2')
    void i18n.loadEnglish(); d.resolve(); await tick()
    assert.equal(i18n.translate('en', '載入器測試用字串丙 {n}', { n: 2 }), 'Third 2')
  } finally { resetLocale() }
})

test('公開 API 沒有少（新增的載入 API 只是追加）', () => {
  for (const k of ['t', 'T', 'useT', 'useLocale', 'translate', 'registerEn', 'getEnDict', 'setLocale', 'getLocale', 'toggleLocale', 'localeTag', 'applyDocumentLocale', 'useLocaleStore', 'LOCALES', 'loadEnglish', 'isEnglishReady']) assert.ok(k in i18n, k)
  assert.deepEqual(i18n.LOCALES, ['zh', 'en'])
  assert.equal(i18n.localeTag('zh'), 'zh-TW'); assert.equal(i18n.localeTag('en'), 'en-US')
})

// ---- 結構守則：英文字典不能有任何靜態依賴（否則中文使用者也得下載）----
const SRC_FILES = listSourceFiles()                                     // src 底下的程式檔（不含 *.test.*，也不含 src/i18n/en/）
const rel = (f) => f.split('/src/').pop()

test('結構：除了 src/i18n/en-all.js 自己，沒有任何程式檔（含 data.js）靜態 import ./en/ 底下的字典或 en-all.js——en-all.js 只被 i18n/index.js 動態 import', () => {
  const bad = []
  for (const f of SRC_FILES) {
    const code = readFileSync(f, 'utf8')
    for (const m of code.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"\n]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) {
      const p = m[1] || m[2]
      if (/(^|\/)en\/[^/]+\.js$/.test(p) || /(^|\/)en-all(\.js)?$/.test(p)) bad.push(`${rel(f)} → ${p}`)
    }
  }
  assert.deepEqual(bad, [], '靜態 import 英文字典會讓它變成入口 / 主畫面的靜態依賴：\n' + bad.join('\n'))
  const idx = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  assert.equal((idx.match(/import\('\.\/en-all\.js'\)/g) || []).length, 1, 'index.js 恰好一處動態 import en-all.js')
  const all = readFileSync(new URL('./en-all.js', import.meta.url), 'utf8')
  assert.match(all, /import\.meta\.glob\('\.\/en\/\*\.js', \{ eager: true, import: 'default' \}\)/, 'en-all.js 用 glob 彙整 ./en/*.js 的 default')
  assert.match(all, /export default dict/)
})

test('結構：data-tables.js（天氣 / 農曆詞素表）與 ./en/data.js 的同名匯出逐項相同——data.js 不能 import ./en/，所以有一份副本，改一邊要改另一邊', () => {
  for (const k of ['WX_SKY', 'WX_MOD', 'WX_NOUN', 'LUNAR_MONTH', 'LUNAR_DAY']) {
    assert.ok(k in enDataModule && k in tables, k)
    assert.deepEqual(tables[k], enDataModule[k], `${k} 與 src/i18n/en/data.js 不一致`)
  }
})

test('結構：沒有任何程式檔在「模組頂層」呼叫 t() / translate() / getLocale() / nameText… 等讀當下語系的函式——英文字典是動態載入的，路由 chunk 可能比字典先執行完，頂層呼叫會固定成中文', () => {
  const NAMES = new Set(['t', 'translate', 'getLocale', 'localeTag', 'nameText', 'weatherText', 'lunarLabelText', 'lunarDayText', 'tideRangeText'])
  const hits = []
  for (const f of SRC_FILES) {
    if (/\/src\/i18n\/(index|loader)\.js$/.test(f)) continue                // 定義這些函式的檔案
    let ast
    try { ast = parse(readFileSync(f, 'utf8'), { sourceType: 'module', plugins: ['jsx'] }) } catch (e) { continue }   // 解析失敗另有測試
    traverse(ast, {
      CallExpression(path) {
        const c = path.node.callee
        const named = c.type === 'Identifier' && NAMES.has(c.name)
        const stateRead = c.type === 'MemberExpression' && c.object.type === 'Identifier' && c.object.name === 'useLocaleStore' && c.property.name === 'getState'
        if (!named && !stateRead) return
        if (!path.findParent((p) => p.isFunction() || p.isClassMethod() || p.isClassPrivateMethod() || p.isStaticBlock())) hits.push(`${rel(f)}:${path.node.loc.start.line} ${c.name || 'useLocaleStore.getState'}()`)
      },
    })
  }
  assert.deepEqual(hits, [], '模組頂層讀語系（請改成靜態表用 T() 標記、顯示時再 t()）：\n' + hits.join('\n'))
})
