// 導覽腳本（lib/tourPlan.js）與其接線（lib/tour.js 的腳本狀態 / 動作、ui/TourPlanEditor.jsx、ui/TourControls.jsx）的單元測試。執行：node --test src/lib/tourPlan.test.mjs
// 涵蓋：文字清洗、normalizePlan 全部分支（清洗 / 去重 / 白名單 / 長度上限 / 壞輸入）、base64url（與 Buffer 對照）、網址編碼往返（含超長截斷）、
// ?tour= 兩種語意並存（開關 0/1/on/off vs 站 id 清單）與別名 ?tourplan=、buildPlanLink、腳本儲存（LS 丟例外 / 超過 5 份 / active 指向不存在）、
// 編輯器草稿的純邏輯（上下移 / 勾選 / 字數）、store 動作（套用 / 另存 / 切換 / 刪除 / 還原、導覽進行中拒絕）、
// 以及 TourPlanEditor / TourControls 的 SSR 標記（用 tourTestEnv 的載入器在 Node 轉譯 JSX）。
// 注意：這個檔案不寫 \u 跳脫（工具會把它轉成真的字元）——特殊字元一律用 String.fromCharCode / fromCodePoint 組。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { loadEnDict, HAN } from '../../scripts/i18n-check.mjs'
import { registerEn, setLocale, useLocaleStore } from '../i18n/index.js'
import { useStore } from '../store/useStore.js'
import { LS } from './persist.js'
import { TOUR_STOP_IDS, parseTourLink, hasTourLink } from './tourLink.js'
import {
  PLAN_STOP_IDS, PLAN_LIMITS, MAX_SAVED, cleanText, sanitizeTyping, countChars, normalizePlan, planToOptions, isDefaultPlan, planEquals,
  b64urlEncode, b64urlDecode, parseIdList, encodePlan, decodePlan, encode, decode, parsePlanFromSearch, buildPlanLink,
  emptyStore, normalizeStore, defaultIO, loadPlanStore, savePlanStore, findPlan, savePlanAs, updatePlan, removePlan, setActive, resolveInitialPlan,
  draftFromPlan, draftToPlan, moveRow, toggleRow, setRowNote, setDraftName, draftOnCount,
} from './tourPlan.js'
import {
  useTourStore, resolveAutoIdle, applyTourPlan, saveTourPlanAs, activateTourPlan, clearTourPlan, deleteTourPlan, AUTO_IDLE_DEFAULT,
} from './tour.js'
import { withStorage, importJsx, liveSsr } from './tourTestEnv.mjs'

const { dict } = await loadEnDict()
registerEn(dict)

const ZWSP = String.fromCharCode(0x200b), RLO = String.fromCharCode(0x202e), NUL = String.fromCharCode(0), LS_CHAR = String.fromCharCode(0x2028), SHY = String.fromCharCode(0xad), BOM = String.fromCharCode(0xfeff)
const SMILE = String.fromCodePoint(0x1f600)
const zhChars = (n, ch = '字') => ch.repeat(n)
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v) } return o }
const CJK_PLAN = () => ({ name: '空氣與魚', stops: TOUR_STOP_IDS.map((id) => ({ id, note: zhChars(120) })) })   // 8 站 × 120 字：一定放不進 1800 字元的網址

// =============================================================================================
// 站白名單 / 上限
// =============================================================================================
test('白名單與上限：站 id = tourLink 的 TOUR_STOP_IDS（8 站）；名稱 ≤24、備註 ≤120、最多 8 站、最多存 5 份、網址 ~1800', () => {
  assert.deepEqual(PLAN_STOP_IDS, TOUR_STOP_IDS)
  assert.deepEqual(PLAN_STOP_IDS, ['reservoir', 'tide', 'moon', 'dust', 'air', 'birds', 'fish', 'stations'])
  assert.deepEqual(PLAN_LIMITS, { name: 24, note: 120, stops: 8, saved: 5, url: 1800 })
  assert.equal(MAX_SAVED, 5)
})

// =============================================================================================
// 文字清洗
// =============================================================================================
test('cleanText：換行 / tab / 控制字元 → 空白並合併、修剪；零寬與雙向控制字元直接移除；非字串 → \'\'', () => {
  assert.equal(cleanText('  a\n\tb   c  ', 20), 'a b c')
  assert.equal(cleanText('a' + ZWSP + 'b' + RLO + 'c' + SHY + 'd' + BOM, 20), 'abcd', '零寬 / 雙向覆寫（可拿來偽裝文字）/ 軟連字號 / BOM 直接移除')
  assert.equal(cleanText('a' + NUL + 'b' + LS_CHAR + 'c', 20), 'a b c', 'NUL 與行分隔字元換成空白')
  for (const bad of [undefined, null, 5, {}, [], true, () => {}, '', '   ', ZWSP]) assert.equal(cleanText(bad, 10), '', String(bad))
})

test('cleanText：以「字」（code point）截斷——emoji 不會被切成一半；截斷後再修剪尾端空白', () => {
  const out = cleanText(SMILE.repeat(150), 120)
  assert.equal(Array.from(out).length, 120); assert.ok(out.isWellFormed(), '沒有落單的代理字元')
  assert.equal(cleanText('a'.repeat(119) + ' ' + 'b', 120), 'a'.repeat(119), '第 120 個字剛好是空白 → 修剪掉')
  assert.equal(cleanText('x'.repeat(1e6), 24).length, 24, '超長輸入也只處理前面一小段（不會卡住）')
  assert.equal(cleanText('你好世界', 2), '你好')
})

test('sanitizeTyping（輸入框邊打邊清）：不修剪、不合併空白（否則打不出空白）；仍移除隱形 / 控制字元並限制長度', () => {
  assert.equal(sanitizeTyping('a  b ', 10), 'a  b ')
  assert.equal(sanitizeTyping('a\nb' + ZWSP + 'c', 10), 'a bc')
  assert.equal(sanitizeTyping('x'.repeat(50), 24), 'x'.repeat(24))
  assert.equal(sanitizeTyping(undefined, 5), ''); assert.equal(sanitizeTyping(5, 5), '')
})

test('countChars：以 code point 計（中文 1、emoji 1）；非字串 0', () => {
  assert.equal(countChars('你好'), 2); assert.equal(countChars(SMILE), 1); assert.equal(countChars(SMILE + 'a'), 2); assert.equal(countChars(''), 0)
  for (const bad of [undefined, null, 5, {}]) assert.equal(countChars(bad), 0)
})

// =============================================================================================
// normalizePlan / planToOptions
// =============================================================================================
test('normalizePlan：清洗 + 依序去重（先出現者勝）+ 站 id 大小寫 / 空白容忍；名稱、備註空的就不帶 key', () => {
  const p = normalizePlan({ name: '  空氣與魚  ', stops: [{ id: 'AIR ', note: ' hello\nworld ' }, { id: 'fish' }, 'birds', { id: 'air', note: '重複' }, { id: 'fish', note: '也重複' }] })
  assert.deepEqual(p, { name: '空氣與魚', stops: [{ id: 'air', note: 'hello world' }, { id: 'fish' }, { id: 'birds' }] })
  const q = normalizePlan({ name: '   ', stops: [{ id: 'tide', note: '   ' }] })
  assert.deepEqual(q, { stops: [{ id: 'tide' }] })
  assert.ok(!('name' in q)); assert.ok(!('note' in q.stops[0]))
})

test('normalizePlan：只接受白名單站 id（未知 / 原型鏈字 / 空字串 / 非字串全丟）；至少 1 站，否則 null', () => {
  const p = normalizePlan({ stops: ['nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '', ' ', 5, null, undefined, {}, { id: 5 }, { id: ['air'] }, 'moon'] })
  assert.deepEqual(p, { stops: [{ id: 'moon' }] })
  for (const bad of [null, undefined, 0, 'air', true, {}, { stops: [] }, { stops: 'air' }, { stops: [{ id: 'x' }] }, [], ['x'], { stops: [null, 1, {}, { id: 5 }] }, () => {}])
    assert.equal(normalizePlan(bad), null, JSON.stringify(bad))
})

test('normalizePlan：直接給 id 陣列也行（沒有名稱）；stops 是全部 8 站時順序照給的；不超過 8 站', () => {
  assert.deepEqual(normalizePlan(['tide', 'air']), { stops: [{ id: 'tide' }, { id: 'air' }] })
  const all = normalizePlan({ stops: [...TOUR_STOP_IDS].reverse().concat(TOUR_STOP_IDS, TOUR_STOP_IDS) })
  assert.deepEqual(all.stops.map((s) => s.id), [...TOUR_STOP_IDS].reverse())
  assert.equal(all.stops.length, 8)
})

test('normalizePlan：長度上限——名稱 24 字、備註 120 字（以 code point 計）；備註非字串 → 丟掉備註但保留該站', () => {
  const p = normalizePlan({ name: zhChars(60), stops: [{ id: 'air', note: zhChars(500) }, { id: 'fish', note: SMILE.repeat(300) }, { id: 'tide', note: 5 }, { id: 'moon', note: { x: 1 } }, { id: 'dust', note: ['a'] }] })
  assert.equal(countChars(p.name), 24); assert.equal(countChars(p.stops[0].note), 120); assert.equal(countChars(p.stops[1].note), 120); assert.ok(p.stops[1].note.isWellFormed())
  assert.deepEqual(p.stops.slice(2), [{ id: 'tide' }, { id: 'moon' }, { id: 'dust' }])
})

test('normalizePlan：壞輸入不丟例外——只看前 64 個項目（超長陣列不會卡住）、不修改輸入、輸出與輸入無共用參照、冪等', () => {
  assert.equal(normalizePlan(Array(64).fill('x').concat(['air'])), null, '第 65 個之後不看')
  assert.deepEqual(normalizePlan(Array(63).fill('x').concat(['air'])), { stops: [{ id: 'air' }] })
  const input = deepFreeze({ name: ' n ', stops: [{ id: 'air', note: ' a ' }, 'fish'] })
  const out = normalizePlan(input)
  assert.deepEqual(input, { name: ' n ', stops: [{ id: 'air', note: ' a ' }, 'fish'] })
  out.stops.push({ id: 'moon' }); out.stops[0].note = 'changed'
  assert.equal(input.stops.length, 2)
  const once = normalizePlan({ name: '  x ', stops: [{ id: 'AIR', note: ' y\n' }] })
  assert.deepEqual(normalizePlan(once), once)
  const evil = { get stops() { throw new Error('boom') } }
  assert.throws(() => normalizePlan(evil), /boom/, '（對照）getter 丟例外時 normalizePlan 不吞——呼叫端的資料來源都是 JSON，不會有 getter')
})

test('planToOptions：合法 → { plan: 清洗後的腳本 }（給 buildTour 的 opts.plan）；不合法 → {}', () => {
  assert.deepEqual(planToOptions({ name: ' a ', stops: ['AIR', 'nope'] }), { plan: { name: 'a', stops: [{ id: 'air' }] } })
  for (const bad of [null, undefined, {}, { stops: [] }, 'air', 5]) assert.deepEqual(planToOptions(bad), {})
})

test('isDefaultPlan / planEquals：沒有腳本 = 全部 8 站、預設順序、沒有名稱與備註——兩者視為同一件事', () => {
  assert.equal(isDefaultPlan(null), true); assert.equal(isDefaultPlan(undefined), true); assert.equal(isDefaultPlan({ stops: [] }), true, '空腳本清洗後是 null')
  assert.equal(isDefaultPlan({ stops: TOUR_STOP_IDS }), true)
  assert.equal(isDefaultPlan({ stops: [...TOUR_STOP_IDS].reverse() }), false)
  assert.equal(isDefaultPlan({ stops: TOUR_STOP_IDS.slice(0, 7) }), false)
  assert.equal(isDefaultPlan({ name: 'x', stops: TOUR_STOP_IDS }), false)
  assert.equal(isDefaultPlan({ stops: TOUR_STOP_IDS.map((id, i) => (i ? { id } : { id, note: 'n' })) }), false)
  assert.equal(planEquals(null, { stops: TOUR_STOP_IDS }), true)
  assert.equal(planEquals({ stops: ['air'] }, { stops: [{ id: 'AIR' }] }), true, '比的是清洗後的內容')
  assert.equal(planEquals({ stops: ['air'] }, { stops: ['fish'] }), false)
  assert.equal(planEquals({ stops: ['air'] }, null), false)
  assert.equal(planEquals({ name: 'a', stops: ['air'] }, { name: 'b', stops: ['air'] }), false)
})

// =============================================================================================
// base64url
// =============================================================================================
test('base64url：往返（ASCII / 中文 / emoji / 空字串 / 各種位元組對齊）；輸出只含 URL 安全字元、沒有補位 =；與 Node 的 Buffer base64url 完全一致', () => {
  const samples = ['', 'a', 'ab', 'abc', 'abcd', 'hello world', '空氣品質', '空', '模型與觀測 model vs obs', SMILE, SMILE + '中' + 'x', JSON.stringify({ air: '看這裡', fish: 'a"b\\c' }), '~~~???>>>', '\n\t ']
  for (const s of samples) {
    const enc = b64urlEncode(s)
    assert.equal(enc, Buffer.from(s, 'utf8').toString('base64url'), s)
    assert.match(enc, /^[A-Za-z0-9_-]*$/)
    assert.equal(b64urlDecode(enc), s, s)
    assert.equal(b64urlDecode(enc + '=='.slice(0, (4 - (enc.length % 4)) % 4)), s, '容忍補位字元')
  }
  assert.equal(b64urlDecode(Buffer.from('中文備註', 'utf8').toString('base64url')), '中文備註')
})

test('base64url：壞輸入 → null（非字串 / 不是 URL 安全字母表 / 長度不可能 / 不是合法 UTF-8）；編碼非字串 → 當空字串', () => {
  for (const bad of [undefined, null, 5, {}, 'a b', 'a+b/', 'ab$d', 'a', 'abcde', '中文', '%41%42']) assert.equal(b64urlDecode(bad), null, String(bad))
  assert.equal(b64urlDecode(Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url')), null, '不是合法 UTF-8')
  assert.equal(b64urlEncode(undefined), ''); assert.equal(b64urlEncode(null), '')
})

test('parseIdList：逗號分隔、修剪、小寫、去重、只留白名單；開關字（0 / 1 / on / off）不在白名單 → 空；只看前 200 字元', () => {
  assert.deepEqual(parseIdList('air,fish'), ['air', 'fish'])
  assert.deepEqual(parseIdList(' AIR , fish ,,air, nope ,Birds'), ['air', 'fish', 'birds'])
  for (const flag of ['0', '1', 'on', 'off', 'true', 'false', 'yes', 'no', '']) assert.deepEqual(parseIdList(flag), [], flag)
  assert.deepEqual(parseIdList('off,air'), ['air'], '混合：開關字被丟掉，其餘照收')
  assert.deepEqual(parseIdList('air,'.repeat(10000)), ['air'])
  assert.deepEqual(parseIdList('x,'.repeat(150) + 'air'), [], '第 200 字元之後不看')
  for (const bad of [undefined, null, 5, {}, ['air']]) assert.deepEqual(parseIdList(bad), [], String(bad))
})

// =============================================================================================
// 網址：encodePlan / decodePlan / parsePlanFromSearch
// =============================================================================================
test('encodePlan：?tour=站 id 清單（逗號不編碼）＋ tournotes（base64url(JSON { id: 備註 })）＋ tourname（encodeURIComponent）；只帶有內容的欄位', () => {
  assert.deepEqual(encodePlan({ stops: ['air', 'fish'] }), { query: 'tour=air,fish', truncated: false })
  const e = encodePlan({ name: '空氣與魚', stops: [{ id: 'air', note: '看這裡' }, { id: 'fish' }] })
  const params = new URLSearchParams(e.query)
  assert.equal(params.get('tour'), 'air,fish'); assert.equal(params.get('tourname'), '空氣與魚'); assert.equal(e.truncated, false)
  assert.deepEqual(JSON.parse(b64urlDecode(params.get('tournotes'))), { air: '看這裡' }, '只放有備註的站')
  assert.ok(e.query.indexOf('tour=') < e.query.indexOf('tournotes=') && e.query.indexOf('tournotes=') < e.query.indexOf('tourname='))
  assert.ok(!e.query.includes('+') && !e.query.includes('/') && !e.query.includes('='.repeat(2)), '不含會被網址誤解的字元')
  assert.deepEqual(encodePlan(null), { query: '', truncated: false }); assert.deepEqual(encodePlan({ stops: [] }), { query: '', truncated: false })
})

test('encode / decode 是 encodePlan / decodePlan 的別名（規格用語）', () => {
  assert.equal(encode, encodePlan); assert.equal(decode, decodePlan)
})

test('往返：encodePlan → 查詢字串 → parsePlanFromSearch 讀回相同的腳本（名稱 / 備註含中文、emoji、& = # + 空白引號等特殊字元）', () => {
  const plans = [
    { stops: [{ id: 'air' }] },
    { name: '空氣與魚', stops: [{ id: 'air', note: '這裡看「模型」vs 觀測' }, { id: 'fish', note: '曾文溪 2007–2013 空窗' }] },
    { name: 'a&b=c#d+e f', stops: [{ id: 'tide', note: 'x&y=z#w+q %41 "quoted" \'single\' <b>bold</b>' }, { id: 'moon' }] },
    { name: SMILE + '導覽', stops: TOUR_STOP_IDS.map((id, i) => (i % 2 ? { id, note: SMILE + '第' + i + '站' } : { id })) },
    { stops: [...TOUR_STOP_IDS].reverse().map((id) => ({ id, note: zhChars(20) })) },
  ]
  for (const plan of plans) {
    const enc = encodePlan(plan)
    assert.equal(enc.truncated, false)
    assert.deepEqual(parsePlanFromSearch('?' + enc.query), normalizePlan(plan), enc.query)
    assert.deepEqual(parsePlanFromSearch('?x=1&' + enc.query + '&y=2'), normalizePlan(plan), '夾在其他參數之間')
  }
})

test('超長截斷：網址總長超過上限 → 先丟備註（名稱保留）並標 truncated:true；再放不下連名稱也丟；邊界剛好等於上限不算超長', () => {
  const plan = CJK_PLAN()
  const cut = encodePlan(plan, { reserve: 40 })
  assert.equal(cut.truncated, true)
  assert.ok(!cut.query.includes('tournotes='), '備註被丟掉'); assert.ok(cut.query.includes('tourname='), '名稱還在')
  assert.ok(40 + cut.query.length <= PLAN_LIMITS.url)
  assert.deepEqual(parsePlanFromSearch('?' + cut.query), { name: '空氣與魚', stops: TOUR_STOP_IDS.map((id) => ({ id })) }, '站序與名稱照樣讀回')
  const full = encodePlan(plan, { reserve: 0, max: 1e9 })
  assert.equal(full.truncated, false); assert.ok(full.query.length > PLAN_LIMITS.url, '（前提）8 × 120 字的備註真的放不進 1800')
  const small = { stops: [{ id: 'air', note: '短備註' }] }
  const L = encodePlan(small, { reserve: 0, max: 1e9 }).query.length
  assert.equal(encodePlan(small, { reserve: 0, max: L }).truncated, false, '剛好等於上限')
  assert.equal(encodePlan(small, { reserve: 0, max: L - 1 }).truncated, true, '多一個字元就超長')
  assert.equal(encodePlan(small, { reserve: 0, max: L - 1 }).query, 'tour=air')
  const named = { name: '很長的名稱測試', stops: ['air', 'fish'] }
  assert.equal(encodePlan(named, { reserve: 0, max: 1e9 }).truncated, false)
  assert.deepEqual(encodePlan(named, { reserve: 0, max: 13 }), { query: 'tour=air,fish', truncated: true }, '連名稱也放不下：只剩站序')
  assert.deepEqual(encodePlan(named, { reserve: 5000 }), { query: 'tour=air,fish', truncated: true }, '骨架本身就超長：仍回傳站序，不丟例外')
})

test('decodePlan：壞的備註參數只是被忽略（站序照樣讀回）；備註只認站 id 為 key；__proto__ 與不在腳本裡的 key 不會進來；沒有站 → null', () => {
  const ok = b64urlEncode(JSON.stringify({ air: '好備註', fish: '不在腳本裡' }))
  assert.deepEqual(decodePlan({ ids: 'air,tide', notes: ok, name: 'n' }), { name: 'n', stops: [{ id: 'air', note: '好備註' }, { id: 'tide' }] })
  assert.deepEqual(decodePlan({ ids: ['air', 'nope', 'AIR'] }), { stops: [{ id: 'air' }] }, 'ids 也可以是陣列')
  const junk = ['not base64!', '', null, undefined, 'AAAA', b64urlEncode('[1,2]'), b64urlEncode('"str"'), b64urlEncode('null'), b64urlEncode('{"air":5}'), b64urlEncode('{'), Buffer.from([0xff, 0xfe]).toString('base64url'), 'a'.repeat(9000), 5, {}]
  for (const notes of junk) assert.deepEqual(decodePlan({ ids: 'air', notes }), { stops: [{ id: 'air' }] }, String(notes).slice(0, 20))
  const evil = decodePlan({ ids: 'air', notes: b64urlEncode('{"__proto__":{"polluted":1},"constructor":"x","air":"ok"}') })
  assert.deepEqual(evil, { stops: [{ id: 'air', note: 'ok' }] }); assert.equal({}.polluted, undefined)
  for (const bad of [undefined, null, {}, { ids: '' }, { ids: 'nope' }, { ids: [] }, { notes: ok }]) assert.equal(decodePlan(bad), null)
  assert.equal(decodePlan(), null)
  assert.deepEqual(decodePlan({ ids: 'air', notes: b64urlEncode(JSON.stringify({ air: zhChars(500) })), name: zhChars(90) }), { name: zhChars(24), stops: [{ id: 'air', note: zhChars(120) }] }, '解出來的也重新清洗與截斷')
})

test('parsePlanFromSearch：?tour=站 id 清單；?tourplan= 是同義別名；兩個都是清單時 ?tour= 優先；?tournotes= / ?tourname= 帶備註與名稱', () => {
  assert.deepEqual(parsePlanFromSearch('?tour=air,fish'), { stops: [{ id: 'air' }, { id: 'fish' }] })
  assert.deepEqual(parsePlanFromSearch('tour=air'), { stops: [{ id: 'air' }] }, '沒有前導 ? 也行；單一站也是腳本')
  assert.deepEqual(parsePlanFromSearch('?tourplan=fish,air'), { stops: [{ id: 'fish' }, { id: 'air' }] }, '別名')
  assert.deepEqual(parsePlanFromSearch('?tour=air&tourplan=fish'), { stops: [{ id: 'air' }] }, '兩個都是清單：?tour= 優先')
  assert.deepEqual(parsePlanFromSearch('?tour=1&tourplan=fish'), { stops: [{ id: 'fish' }] }, '?tour=1 是開關 → 改看別名')
  assert.deepEqual(parsePlanFromSearch('?tour=air%2Cfish'), { stops: [{ id: 'air' }, { id: 'fish' }] }, '逗號被編碼成 %2C 也行')
  assert.deepEqual(parsePlanFromSearch('?tour=%20AIR%20,%20Fish'), { stops: [{ id: 'air' }, { id: 'fish' }] })
  assert.deepEqual(parsePlanFromSearch('?tour=air&tournotes=' + b64urlEncode('{"air":"備註"}') + '&tourname=%E5%90%8D%E7%A8%B1'), { name: '名稱', stops: [{ id: 'air', note: '備註' }] })
  assert.deepEqual(parsePlanFromSearch('?tour=air&tournotes=@@@&tourname='), { stops: [{ id: 'air' }] }, '壞備註 / 空名稱')
})

test('?tour= 兩種語意並存：開關 0 / 1 / on / off 不是腳本（parsePlanFromSearch 回 null）；站 id 清單是腳本、且不影響閒置自動導覽開關的判斷', () => {
  for (const v of ['0', '1', 'on', 'off', 'ON', 'Off', 'true', 'false', 'nope', '']) assert.equal(parsePlanFromSearch('?tour=' + v), null, v)
  assert.equal(parsePlanFromSearch('?tour'), null); assert.equal(parsePlanFromSearch('?kiosk=1'), null); assert.equal(parsePlanFromSearch(''), null)
  // 開關語意不變
  assert.equal(resolveAutoIdle({ saved: true, search: '?tour=0' }), false); assert.equal(resolveAutoIdle({ saved: false, search: '?tour=1' }), true)
  assert.equal(resolveAutoIdle({ saved: true, search: '?tour=off' }), false); assert.equal(resolveAutoIdle({ saved: false, search: '?tour=on' }), true)
  // 站 id 清單 = 沒指定開關：依 ?kiosk > 偏好 > 預設
  assert.equal(resolveAutoIdle({ saved: false, search: '?tour=air,fish' }), false, '尊重使用者存的「關閉」')
  assert.equal(resolveAutoIdle({ saved: true, search: '?tour=air,fish' }), true)
  assert.equal(resolveAutoIdle({ saved: null, search: '?tour=air,fish' }), AUTO_IDLE_DEFAULT)
  assert.equal(resolveAutoIdle({ saved: false, search: '?kiosk=1&tour=air,fish' }), true, '展場模式預設開')
  // 同時要開關與腳本：?tour=0&tourplan=… / ?tour=1&tourplan=…
  assert.equal(resolveAutoIdle({ saved: true, search: '?tour=0&tourplan=air,fish' }), false); assert.deepEqual(parsePlanFromSearch('?tour=0&tourplan=air,fish'), { stops: [{ id: 'air' }, { id: 'fish' }] })
  assert.equal(resolveAutoIdle({ saved: false, search: '?tour=1&tourplan=air' }), true); assert.deepEqual(parsePlanFromSearch('?tour=1&tourplan=air'), { stops: [{ id: 'air' }] })
})

test('parsePlanFromSearch：壞輸入不丟例外（undefined / null / 數字 / 物件 / 超長 / 大寫參數名）', () => {
  for (const bad of [undefined, null, 5, {}, [], () => {}]) { let r; assert.doesNotThrow(() => { r = parsePlanFromSearch(bad) }); assert.equal(r, null) }
  assert.equal(parsePlanFromSearch('?TOUR=air'), null, '參數名區分大小寫')
  assert.deepEqual(parsePlanFromSearch('?tour=' + 'air,'.repeat(50000)), { stops: [{ id: 'air' }] })
  assert.equal(parsePlanFromSearch('?tour=%E0%A4%A'), null, '壞的百分比編碼不丟例外')
})

// =============================================================================================
// buildPlanLink
// =============================================================================================
test('buildPlanLink：只保留 origin + 路徑；帶 tour / tournotes / tourname；不帶原網址的一次性旗標、hash、帳密與分享參數；產生的連結能被 parsePlanFromSearch 原樣讀回', () => {
  const plan = { name: '空氣與魚', stops: [{ id: 'air', note: '看這裡' }, { id: 'fish' }] }
  const r = buildPlanLink({ href: 'https://midisea.shyetech.com/?kiosk=1#remote=x', plan })
  assert.ok(r.url.startsWith('https://midisea.shyetech.com/?tour=air,fish&tournotes=')); assert.equal(r.truncated, false); assert.equal(r.length, r.url.length)
  assert.deepEqual(parsePlanFromSearch(new URL(r.url).search), plan)
  const dirty = 'https://user:secret@midisea.shyetech.com/x/?tourstop=1&tourhold=1&audience=1&kiosk=1&tour=0&speak=1&s=abc&o=feitsui&token=SEKRET#remote=peer-123'
  const out = buildPlanLink({ href: dirty, plan: { stops: ['air'] } }).url
  assert.equal(out, 'https://midisea.shyetech.com/x/?tour=air')
  for (const leak of ['secret', 'user', 'SEKRET', 'audience', 'kiosk', 'remote', 'peer-123', 'feitsui', 's=abc', '#', 'tour=0']) assert.ok(!out.includes(leak), leak)
  assert.equal(buildPlanLink({ href: 'http://localhost:5173/', plan: { stops: ['moon'] } }).url, 'http://localhost:5173/?tour=moon')
})

test('buildPlanLink：可另帶 tourstop（收到的人直接到那一站）/ tourhold / lang=en；hold 只在有站時才有意義；不合法的站 id 忽略', () => {
  const base = 'https://a.test/'
  const plan = { stops: ['air', 'fish'] }
  assert.equal(buildPlanLink({ href: base, plan, stopId: 'fish' }).url, 'https://a.test/?tour=air,fish&tourstop=fish')
  assert.equal(buildPlanLink({ href: base, plan, stopId: 'fish', hold: true }).url, 'https://a.test/?tour=air,fish&tourstop=fish&tourhold=1')
  assert.equal(buildPlanLink({ href: base, plan, stopId: 'fish', hold: true, locale: 'en' }).url, 'https://a.test/?tour=air,fish&tourstop=fish&tourhold=1&lang=en')
  assert.equal(buildPlanLink({ href: base, plan, locale: 'en' }).url, 'https://a.test/?tour=air,fish&lang=en')
  assert.equal(buildPlanLink({ href: base, plan, hold: true }).url, 'https://a.test/?tour=air,fish', '沒有站就沒有 hold')
  assert.equal(buildPlanLink({ href: base, plan, stopId: 'nope' }).url, 'https://a.test/?tour=air,fish')
  const u = new URL(buildPlanLink({ href: base, plan, stopId: 'FISH', hold: true }).url)
  assert.deepEqual(parseTourLink(u.search), { stop: { id: 'fish' }, hold: true }); assert.equal(hasTourLink(u.search), true)
  assert.deepEqual(parsePlanFromSearch(u.search), { stops: [{ id: 'air' }, { id: 'fish' }] }, '腳本與每站連結同時存在、互不干擾')
})

test('buildPlanLink：備註太長放不進網址 → 連結只帶站序 + 名稱，回報 truncated:true；整條連結 ≤ 1800 字元；壞輸入 → url 為 \'\'', () => {
  const r = buildPlanLink({ href: 'https://midisea.shyetech.com/', plan: CJK_PLAN(), stopId: 'air', hold: true, locale: 'en' })
  assert.equal(r.truncated, true); assert.ok(r.url.length <= PLAN_LIMITS.url); assert.equal(r.length, r.url.length)
  assert.ok(!r.url.includes('tournotes=')); assert.deepEqual(parsePlanFromSearch(new URL(r.url).search).stops.map((s) => s.id), TOUR_STOP_IDS)
  const ok = buildPlanLink({ href: 'https://midisea.shyetech.com/', plan: { stops: [{ id: 'air', note: zhChars(100) }] } })
  assert.equal(ok.truncated, false); assert.ok(ok.url.includes('tournotes=')); assert.ok(ok.url.length <= PLAN_LIMITS.url)
  for (const href of [undefined, null, '', 'not a url', '/relative', 'http://']) assert.deepEqual(buildPlanLink({ href, plan: { stops: ['air'] } }), { url: '', truncated: false, length: 0 }, String(href))
  for (const plan of [undefined, null, {}, { stops: [] }, { stops: ['nope'] }]) assert.equal(buildPlanLink({ href: 'https://a.test/', plan }).url, '')
  assert.equal(buildPlanLink().url, '')
})

// =============================================================================================
// 儲存
// =============================================================================================
const P = (id, name, ...ids) => ({ id, name, stops: ids.map((x) => ({ id: x })) })

test('normalizeStore：讀進來的東西一律當不可信——壞形狀 → 空；每份重新清洗；id 不合法 / 重複的丟掉；超過 5 份只留前 5 份；active 指向不存在 → null', () => {
  for (const bad of [null, undefined, 5, 'x', [], {}, { plans: 'x' }, { plans: null, active: 'p1' }]) assert.deepEqual(normalizeStore(bad), emptyStore(), JSON.stringify(bad))
  const raw = {
    active: 'p2',
    plans: [P('p1', ' 甲 ', 'air'), { id: 'p2', name: zhChars(60), stops: [{ id: 'FISH', note: zhChars(300) }, { id: 'nope' }] }, P('p2', '重複', 'tide'), P('bad id!', 'x', 'air'), P('', 'x', 'air'), { id: 5, stops: ['air'] }, { id: 'p9', stops: [] }, null, 'x', P('p3', 'c', 'moon')],
  }
  const s = normalizeStore(raw)
  assert.deepEqual(s.plans.map((p) => p.id), ['p1', 'p2', 'p3'])
  assert.equal(s.plans[0].name, '甲'); assert.equal(countChars(s.plans[1].name), 24); assert.equal(countChars(s.plans[1].stops[0].note), 120); assert.deepEqual(s.plans[1].stops.map((x) => x.id), ['fish'])
  assert.equal(s.active, 'p2')
  assert.equal(normalizeStore({ active: 'zzz', plans: [P('p1', 'a', 'air')] }).active, null, 'active 指向不存在')
  assert.equal(normalizeStore({ active: 7, plans: [P('p1', 'a', 'air')] }).active, null)
  const many = { active: 'p6', plans: Array.from({ length: 9 }, (_, i) => P('p' + (i + 1), 'n' + i, 'air')) }
  const cut = normalizeStore(many)
  assert.equal(cut.plans.length, 5); assert.deepEqual(cut.plans.map((p) => p.id), ['p1', 'p2', 'p3', 'p4', 'p5']); assert.equal(cut.active, null, '第 6 份被截掉了 → active 失效')
  assert.deepEqual(normalizeStore(normalizeStore(raw)), normalizeStore(raw), '冪等')
})

test('loadPlanStore / savePlanStore（注入 io）：讀寫 LS.tourplan；io.get / io.set 丟例外 → 空 / false，不丟例外；寫入的一定是清洗過的；io.set 回 false → false', () => {
  const mem = new Map()
  const io = { get: (k) => (mem.has(k) ? mem.get(k) : null), set: (k, v) => { mem.set(k, JSON.parse(JSON.stringify(v))); return true } }
  assert.deepEqual(loadPlanStore(io), emptyStore(), '沒存過 → 空')
  assert.equal(savePlanStore({ active: 'p1', plans: [P('p1', ' 甲 ', 'air', 'nope')] }, io), true)
  assert.ok(mem.has(LS.tourplan)); assert.equal(LS.tourplan, 'ixd2026.tourplan')
  assert.deepEqual(mem.get(LS.tourplan), { active: 'p1', plans: [{ id: 'p1', name: '甲', stops: [{ id: 'air' }] }] })
  assert.deepEqual(loadPlanStore(io), { active: 'p1', plans: [{ id: 'p1', name: '甲', stops: [{ id: 'air' }] }] })
  mem.set(LS.tourplan, { active: 'nope', plans: 'garbage' }); assert.deepEqual(loadPlanStore(io), emptyStore(), '存的東西壞了 → 空，不丟例外')
  const boom = { get() { throw new Error('SecurityError') }, set() { throw new Error('QuotaExceededError') } }
  assert.deepEqual(loadPlanStore(boom), emptyStore()); assert.equal(savePlanStore({ active: null, plans: [] }, boom), false)
  assert.equal(savePlanStore(emptyStore(), { get: () => null, set: () => false }), false, '寫入失敗回 false')
  assert.equal(savePlanStore(null, io), true, '壞的 store 也不丟（存成空）'); assert.deepEqual(mem.get(LS.tourplan), emptyStore())
})

test('defaultIO：用 localStorage（呼叫當下才讀全域）；setItem 丟例外（隱私模式 / 額滿）→ false；getItem 丟例外或內容不是 JSON → 空', () => {
  withStorage((data) => {
    assert.equal(savePlanStore({ active: null, plans: [P('p1', 'a', 'air')] }), true)
    assert.equal(JSON.parse(data.get(LS.tourplan)).plans[0].name, 'a')
    assert.equal(loadPlanStore().plans[0].id, 'p1')
    data.set(LS.tourplan, '{not json'); assert.deepEqual(loadPlanStore(), emptyStore())
    data.set(LS.tourplan, 'null'); assert.deepEqual(loadPlanStore(), emptyStore())
  })
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem() { throw new Error('SecurityError') }, setItem() { throw new Error('QuotaExceededError') } }, configurable: true, writable: true })
  try {
    assert.equal(defaultIO.set(LS.tourplan, { a: 1 }), false); assert.equal(defaultIO.get(LS.tourplan), null)
    assert.equal(savePlanStore(emptyStore()), false); assert.deepEqual(loadPlanStore(), emptyStore())
  } finally { if (desc) Object.defineProperty(globalThis, 'localStorage', desc); else delete globalThis.localStorage }
})

test('腳本庫操作（不可變）：savePlanAs 依序給 p1、p2…（刪掉的編號會被重用）；滿 5 份 → reason:full 且原封不動；壞腳本 → invalid；updatePlan / removePlan / setActive / findPlan', () => {
  let s = emptyStore()
  const before = deepFreeze(JSON.parse(JSON.stringify(s)))
  const r1 = savePlanAs(before, { name: '甲', stops: ['air', 'fish'] })
  assert.equal(r1.ok, true); assert.equal(r1.id, 'p1'); assert.deepEqual(r1.store.plans, [{ id: 'p1', name: '甲', stops: [{ id: 'air' }, { id: 'fish' }] }]); assert.deepEqual(before, emptyStore(), '不改傳入的 store')
  s = r1.store
  for (const n of ['乙', '丙', '丁', '戊']) { const r = savePlanAs(s, { name: n, stops: ['tide'] }); assert.equal(r.ok, true); s = r.store }
  assert.deepEqual(s.plans.map((p) => p.id), ['p1', 'p2', 'p3', 'p4', 'p5'])
  const full = savePlanAs(s, { name: '己', stops: ['tide'] })
  assert.deepEqual({ ok: full.ok, reason: full.reason }, { ok: false, reason: 'full' }); assert.equal(full.store, s, '滿了：原封不動（同一個參照）')
  assert.deepEqual({ ...savePlanAs(emptyStore(), { stops: ['nope'] }) }, { ok: false, reason: 'invalid', store: emptyStore() })
  s = setActive(s, 'p3'); assert.equal(s.active, 'p3'); assert.equal(setActive(s, 'zzz').active, null); assert.equal(setActive(s, null).active, null)
  assert.equal(findPlan(s, 'p2').name, '乙'); assert.equal(findPlan(s, 'zzz'), null); assert.equal(findPlan(null, 'p1'), null); assert.equal(findPlan(s, 5), null)
  const up = updatePlan(s, 'p2', { name: '乙2', stops: ['birds'] })
  assert.equal(up.ok, true); assert.deepEqual(findPlan(up.store, 'p2'), { id: 'p2', name: '乙2', stops: [{ id: 'birds' }] }); assert.equal(findPlan(s, 'p2').name, '乙', '原 store 不變')
  assert.equal(updatePlan(s, 'zzz', { stops: ['air'] }).reason, 'missing'); assert.equal(updatePlan(s, 'p2', { stops: [] }).reason, 'invalid')
  const rm = removePlan(s, 'p3')
  assert.equal(rm.plans.length, 4); assert.equal(rm.active, null, '刪掉啟用中的 → active 清掉'); assert.equal(removePlan(s, 'p1').active, 'p3', '刪別份不影響 active')
  assert.equal(removePlan(s, 'zzz'), s, '刪不存在的：原封不動')
  const again = savePlanAs(rm, { name: '新', stops: ['moon'] })
  assert.equal(again.id, 'p3', '刪掉的編號被重用')
})

test('resolveInitialPlan：網址腳本（本次有效）> 上次啟用的已存腳本 > 沒有；已存腳本的 active 指向不存在 → 沒有', () => {
  const lib = { active: 'p2', plans: [P('p1', 'a', 'air'), P('p2', 'b', 'fish', 'tide')] }
  assert.deepEqual(resolveInitialPlan({ search: '', lib }), { plan: { name: 'b', stops: [{ id: 'fish' }, { id: 'tide' }] }, planSrc: 'saved', planId: 'p2' })
  assert.deepEqual(resolveInitialPlan({ search: '?tour=moon', lib }), { plan: { stops: [{ id: 'moon' }] }, planSrc: 'url', planId: null }, '網址優先')
  assert.deepEqual(resolveInitialPlan({ search: '?tour=1', lib }).planSrc, 'saved', '?tour=1 是開關，不是腳本')
  assert.deepEqual(resolveInitialPlan({ search: '', lib: { active: null, plans: lib.plans } }), { plan: null, planSrc: null, planId: null })
  assert.deepEqual(resolveInitialPlan({ search: '', lib: { active: 'zzz', plans: lib.plans } }), { plan: null, planSrc: null, planId: null })
  assert.deepEqual(resolveInitialPlan(), { plan: null, planSrc: null, planId: null }); assert.deepEqual(resolveInitialPlan({ lib: null }), { plan: null, planSrc: null, planId: null })
})

// =============================================================================================
// 編輯器草稿（上下移 / 勾選 / 字數）
// =============================================================================================
test('draftFromPlan：沒有腳本 → 8 列全勾、預設順序；有腳本 → 勾選的站在前（依腳本順序、帶備註）、其餘未勾選接在後面（預設順序）；名稱帶入', () => {
  const d0 = draftFromPlan(null)
  assert.deepEqual(d0.rows.map((r) => r.id), TOUR_STOP_IDS); assert.ok(d0.rows.every((r) => r.on && r.note === '')); assert.equal(d0.name, '')
  const d = draftFromPlan({ name: '空氣與魚', stops: [{ id: 'fish', note: '魚' }, { id: 'air' }] })
  assert.deepEqual(d.rows.map((r) => [r.id, r.on]), [['fish', true], ['air', true], ['reservoir', false], ['tide', false], ['moon', false], ['dust', false], ['birds', false], ['stations', false]])
  assert.equal(d.rows[0].note, '魚'); assert.equal(d.name, '空氣與魚'); assert.equal(d.rows.length, 8)
  assert.deepEqual(draftFromPlan({ stops: [] }), d0, '壞腳本 = 沒有腳本'); assert.deepEqual(draftFromPlan(undefined), d0)
})

test('draftToPlan：只取勾選的列、依列順序、帶備註與名稱（並清洗）；一列都沒勾 → null；壞草稿 → null；與 draftFromPlan 互為反向', () => {
  const plan = { name: '空氣與魚', stops: [{ id: 'fish', note: '魚' }, { id: 'air' }] }
  assert.deepEqual(draftToPlan(draftFromPlan(plan)), plan)
  assert.equal(planEquals(draftToPlan(draftFromPlan(null)), null), true, '預設草稿 = 沒有腳本')
  let d = draftFromPlan(null)
  for (let i = 0; i < 8; i++) d = { ...d, rows: toggleRow(d.rows, i) }
  assert.equal(draftToPlan(d), null); assert.equal(draftOnCount(d), 0)
  assert.deepEqual(draftToPlan({ name: '  x  ', rows: [{ id: 'air', on: true, note: '  a\nb  ' }, { id: 'fish', on: false, note: 'ignored' }] }), { name: 'x', stops: [{ id: 'air', note: 'a b' }] })
  for (const bad of [null, undefined, {}, { rows: 'x' }]) assert.equal(draftToPlan(bad), null)
  assert.equal(draftOnCount(null), 0)
})

test('moveRow：上移 / 下移一格（不可變；回傳新陣列）；移出範圍 / 非整數 / delta 為 0 → 原陣列（同一個參照）', () => {
  const rows = draftFromPlan(null).rows
  const up = moveRow(rows, 3, -1)
  assert.deepEqual(up.map((r) => r.id), ['reservoir', 'tide', 'dust', 'moon', 'air', 'birds', 'fish', 'stations']); assert.notEqual(up, rows); assert.equal(rows[2].id, 'moon', '原陣列不變')
  const down = moveRow(rows, 0, 1)
  assert.deepEqual(down.map((r) => r.id).slice(0, 3), ['tide', 'reservoir', 'moon'])
  for (const [i, d] of [[0, -1], [7, 1], [-1, 1], [8, -1], [2, 0], [1.5, 1], [NaN, 1]]) assert.equal(moveRow(rows, i, d), rows, `${i},${d}`)
  assert.equal(moveRow(null, 0, 1), null); assert.equal(moveRow(undefined, 0, 1), undefined)
  let cur = rows                                                    // 連續上移：同一站一路移到最上面，之後再按不動
  for (let k = 0; k < 10; k++) cur = moveRow(cur, cur.findIndex((r) => r.id === 'fish'), -1)
  assert.equal(cur[0].id, 'fish')
})

test('toggleRow / setRowNote / setDraftName：只改指定那一列（不可變）；備註 ≤120 字、名稱 ≤24 字（以字計）、邊打邊清但不修剪；找不到那一列 → 原陣列', () => {
  const rows = draftFromPlan(null).rows
  const t = toggleRow(rows, 2)
  assert.equal(t[2].on, false); assert.equal(rows[2].on, true); assert.equal(t[1], rows[1], '沒動的列是同一個物件'); assert.equal(toggleRow(t, 2)[2].on, true)
  assert.equal(toggleRow(rows, 8), rows); assert.equal(toggleRow(rows, -1), rows); assert.equal(toggleRow(null, 0), null)
  const n = setRowNote(rows, 4, 'a  b ')
  assert.equal(n[4].note, 'a  b ', '不修剪（打得出空白）')
  assert.equal(countChars(setRowNote(rows, 4, zhChars(300))[4].note), 120); assert.equal(countChars(setRowNote(rows, 4, SMILE.repeat(200))[4].note), 120)
  assert.equal(setRowNote(rows, 4, 'x\ny')[4].note, 'x y'); assert.equal(setRowNote(rows, 4, undefined)[4].note, ''); assert.equal(setRowNote(rows, 99, 'x'), rows)
  assert.equal(countChars(setDraftName({ name: '', rows }, zhChars(80)).name), 24); assert.equal(setDraftName({ name: 'a', rows }, 'ab').rows, rows)
})

// =============================================================================================
// store 動作（lib/tour.js）：套用 / 另存 / 切換 / 還原 / 刪除
// =============================================================================================
const resetStore = (over = {}) => useTourStore.setState({ plan: null, planSrc: null, planId: null, planLib: emptyStore(), running: false, remote: false, ...over })
function inStore(fn, init = {}) { return withStorage((data) => { resetStore(); try { return fn(data) } finally { resetStore() } }, init) }
const S = () => useTourStore.getState()

test('初始狀態：網址與 localStorage 都沒有腳本 → plan 為 null（預設完整導覽）；狀態欄位齊全', () => {
  const s = useTourStore.getState()
  for (const k of ['plan', 'planSrc', 'planId', 'planLib']) assert.ok(k in s, k)
  assert.equal(s.plan, null); assert.equal(s.planSrc, null); assert.deepEqual(s.planLib, emptyStore())
})

test('applyTourPlan：沒選已存腳本 → 「自訂」（本次有效，不寫入儲存）；剛好是預設完整導覽 → 當作沒有腳本；不合法 → invalid', () => inStore((data) => {
  const r = applyTourPlan({ name: '空氣與魚', stops: [{ id: 'air', note: '看這裡' }, 'fish'] })
  assert.deepEqual(r, { ok: true, saved: false })
  assert.deepEqual(S().plan, { name: '空氣與魚', stops: [{ id: 'air', note: '看這裡' }, { id: 'fish' }] }); assert.equal(S().planSrc, 'custom'); assert.equal(S().planId, null)
  assert.ok(!data.has(LS.tourplan), '自訂腳本不寫入儲存')
  assert.equal(applyTourPlan({ stops: TOUR_STOP_IDS }).ok, true); assert.equal(S().plan, null); assert.equal(S().planSrc, null, '預設完整導覽 = 沒有腳本')
  assert.deepEqual(applyTourPlan({ stops: [] }), { ok: false, reason: 'invalid' }); assert.deepEqual(applyTourPlan(null), { ok: false, reason: 'invalid' })
}))

test('saveTourPlanAs：存成新的一份並啟用（寫入 LS.tourplan）；最多 5 份，滿了 → full 且不動；儲存失敗（隱私模式）仍在本次生效（persisted:false）', () => inStore((data) => {
  const r = saveTourPlanAs({ name: '甲', stops: ['air', 'fish'] })
  assert.deepEqual(r, { ok: true, id: 'p1', persisted: true })
  assert.deepEqual(S().plan, { name: '甲', stops: [{ id: 'air' }, { id: 'fish' }] }); assert.equal(S().planSrc, 'saved'); assert.equal(S().planId, 'p1')
  assert.equal(JSON.parse(data.get(LS.tourplan)).active, 'p1'); assert.equal(JSON.parse(data.get(LS.tourplan)).plans.length, 1)
  for (const n of ['乙', '丙', '丁', '戊']) assert.equal(saveTourPlanAs({ name: n, stops: ['tide'] }).ok, true)
  assert.equal(S().planLib.plans.length, 5)
  const full = saveTourPlanAs({ name: '己', stops: ['tide'] })
  assert.deepEqual(full, { ok: false, reason: 'full' }); assert.equal(S().planLib.plans.length, 5); assert.equal(S().planId, 'p5', '滿了：原本啟用的不變')
  assert.deepEqual(saveTourPlanAs({ stops: ['nope'] }), { ok: false, reason: 'invalid' })
}))

test('saveTourPlanAs：localStorage 寫入失敗 → persisted:false，腳本仍套用在本次（不丟例外）', () => {
  resetStore()
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem() { throw new Error('SecurityError') }, setItem() { throw new Error('QuotaExceededError') } }, configurable: true, writable: true })
  try {
    const r = saveTourPlanAs({ name: '甲', stops: ['air'] })
    assert.deepEqual(r, { ok: true, id: 'p1', persisted: false }); assert.deepEqual(S().plan, { name: '甲', stops: [{ id: 'air' }] }); assert.equal(S().planLib.plans.length, 1)
    assert.equal(applyTourPlan({ name: '甲', stops: ['air', 'fish'] }).persisted, false, '就地更新已存腳本也一樣')
    assert.equal(deleteTourPlan('p1').persisted, false)
  } finally { if (desc) Object.defineProperty(globalThis, 'localStorage', desc); else delete globalThis.localStorage; resetStore() }
})

test('applyTourPlan：目前用的是已存腳本 → 就地更新該腳本並保持啟用（寫入儲存）；activateTourPlan 切換啟用；clearTourPlan 還原預設（已存腳本都還在）', () => inStore((data) => {
  saveTourPlanAs({ name: '甲', stops: ['air'] }); saveTourPlanAs({ name: '乙', stops: ['fish', 'tide'] })
  assert.equal(S().planId, 'p2')
  const up = applyTourPlan({ name: '乙改', stops: [{ id: 'moon', note: 'n' }] })
  assert.deepEqual(up, { ok: true, saved: true, id: 'p2', persisted: true })
  assert.deepEqual(S().planLib.plans[1], { id: 'p2', name: '乙改', stops: [{ id: 'moon', note: 'n' }] }); assert.equal(S().planLib.plans.length, 2)
  assert.deepEqual(JSON.parse(data.get(LS.tourplan)).plans[1].stops, [{ id: 'moon', note: 'n' }])
  assert.deepEqual(activateTourPlan('p1'), { ok: true, id: 'p1', persisted: true })
  assert.deepEqual(S().plan, { name: '甲', stops: [{ id: 'air' }] }); assert.equal(S().planSrc, 'saved'); assert.equal(S().planId, 'p1'); assert.equal(JSON.parse(data.get(LS.tourplan)).active, 'p1')
  assert.deepEqual(activateTourPlan('zzz'), { ok: false, reason: 'missing' }); assert.equal(S().planId, 'p1', '找不到：什麼都不動')
  assert.deepEqual(clearTourPlan(), { ok: true, persisted: true })
  assert.equal(S().plan, null); assert.equal(S().planSrc, null); assert.equal(S().planId, null); assert.equal(S().planLib.plans.length, 2, '已存腳本都還在')
  assert.equal(JSON.parse(data.get(LS.tourplan)).active, null)
  applyTourPlan({ stops: ['birds'] })                                                       // 沒選已存腳本 → 自訂，不會動到已存的
  assert.equal(S().planSrc, 'custom'); assert.equal(S().planLib.plans.length, 2); assert.equal(S().planLib.plans[0].name, '甲')
}))

test('deleteTourPlan：刪除已存腳本；刪的是啟用中的 → 回到預設完整導覽；刪別份不影響；找不到 → missing', () => inStore((data) => {
  saveTourPlanAs({ name: '甲', stops: ['air'] }); saveTourPlanAs({ name: '乙', stops: ['fish'] })
  assert.deepEqual(deleteTourPlan('p1'), { ok: true, persisted: true }); assert.equal(S().planId, 'p2'); assert.equal(S().planLib.plans.length, 1)
  assert.deepEqual(deleteTourPlan('zzz'), { ok: false, reason: 'missing' })
  assert.deepEqual(deleteTourPlan('p2'), { ok: true, persisted: true }); assert.equal(S().plan, null); assert.equal(S().planLib.plans.length, 0); assert.equal(JSON.parse(data.get(LS.tourplan)).active, null)
}))

test('導覽進行中不能改腳本：所有動作一律 { ok:false, reason:\'running\' }，什麼都不動、也不寫入儲存', () => inStore((data) => {
  saveTourPlanAs({ name: '甲', stops: ['air'] })
  const snapshot = JSON.stringify([S().plan, S().planSrc, S().planId, S().planLib]); const stored = data.get(LS.tourplan)
  useTourStore.setState({ running: true })
  for (const r of [applyTourPlan({ stops: ['fish'] }), saveTourPlanAs({ stops: ['fish'] }), activateTourPlan('p1'), clearTourPlan(), deleteTourPlan('p1')]) assert.deepEqual(r, { ok: false, reason: 'running' })
  assert.equal(JSON.stringify([S().plan, S().planSrc, S().planId, S().planLib]), snapshot); assert.equal(data.get(LS.tourplan), stored)
  useTourStore.setState({ running: false })
  assert.equal(applyTourPlan({ stops: ['fish'] }).ok, true, '導覽結束後又可以改')
}))

test('腳本狀態不進 mirror（觀眾視窗只看字幕）；備註在 caption.p.note 裡，隨字幕鏡像', async () => {
  const { getMirror } = await import('./mirror.js')
  const slice = getMirror('tour')
  assert.ok(slice)
  inStore(() => {
    useTourStore.setState({ plan: { stops: [{ id: 'air', note: '秘密備註' }] }, planSrc: 'custom', caption: { key: 'air', p: { name: 'x', note: '給觀眾看的備註' } } })
    const snap = JSON.stringify(slice.get())
    assert.ok(!snap.includes('planLib') && !snap.includes('planSrc') && !snap.includes('秘密備註'), '腳本本身不鏡像')
    assert.ok(snap.includes('給觀眾看的備註'), 'caption.p.note 隨字幕鏡像')
    useTourStore.setState({ caption: null })
  })
})

// =============================================================================================
// SSR 標記：TourPlanEditor / TourControls
// =============================================================================================
const { default: TourPlanEditor, STOP_LABEL, planDisplayName } = await importJsx(new URL('../ui/TourPlanEditor.jsx', import.meta.url).href)
const { default: TourControls } = await importJsx(new URL('../ui/TourControls.jsx', import.meta.url).href)
const html = (el) => { liveSsr(useTourStore, useStore, useLocaleStore); return renderToStaticMarkup(el) }   // SSR 讀「目前」狀態（見 tourTestEnv.liveSsr）
const editor = (props = {}) => html(createElement(TourPlanEditor, props))
const count = (s, re) => (s.match(re) || []).length
const MINI_GOV = { defaultOption: 'feitsui', options: [{ id: 'feitsui', name: '翡翠水庫', level: 77.3, params: { seaLevel: 0.77 } }], stations: { total: 2, active: 1, list: [{ n: 'a', r: 'b', x: 0, y: 0, a: 1, s: 1 }] } }   // 只有「今日水庫」與「河川測站星座」兩站有資料
function withGov(gov, fn) { const prev = useStore.getState().gov; useStore.setState({ gov }); try { return fn() } finally { useStore.setState({ gov: prev }) } }

test('SSR·編輯器：預設收合——只有標題按鈕（aria-expanded=false、aria-controls），沒有編輯內容；defaultOpen 才展開', () => inStore(() => {
  const closed = editor()
  assert.match(closed, /<button type="button" class="tour-plan-head" data-tour-ui="true" aria-expanded="false" aria-controls="[^"]+-body"/)
  assert.ok(closed.includes('導覽腳本')); assert.ok(!closed.includes('tour-plan-body')); assert.ok(!closed.includes('<input')); assert.ok(!closed.includes('tour-plan-badge'), '沒有腳本 → 沒有「使用中」')
  const open = editor({ defaultOpen: true })
  assert.match(open, /aria-expanded="true"/); assert.ok(open.includes('tour-plan-body'))
  assert.equal(closed.match(/aria-controls="([^"]+)"/)[1], closed.match(/aria-controls="([^"]+)"/)[1]); assert.ok(open.includes('id="' + open.match(/aria-controls="([^"]+)"/)[1] + '"'), 'aria-controls 指向的元素存在')
}))

test('SSR·編輯器（展開）：8 列（預設順序、全勾）；每列有核取方塊（aria-label「納入…」）、上移 / 下移按鈕（明確的 aria-label；第一列不能上移、最後一列不能下移）、備註輸入（maxLength 120、字數 0 / 120）；每個按鈕 type=button 且 data-tour-ui', () => inStore(() => {
  const h = editor({ defaultOpen: true })
  const rowIds = [...h.matchAll(/data-row="([a-z]+)"/g)].map((m) => m[1])
  assert.deepEqual(rowIds, TOUR_STOP_IDS)
  assert.equal(count(h, /type="checkbox"/g), 8); assert.equal(count(h, /type="checkbox"[^>]*checked=""|checked=""[^>]*type="checkbox"/g), 8, '預設全部勾選')
  assert.equal(count(h, /data-act="up"/g), 8); assert.equal(count(h, /data-act="down"/g), 8)
  for (const id of TOUR_STOP_IDS) {
    const name = STOP_LABEL[id]
    assert.ok(h.includes('aria-label="納入「' + name + '」"'), '納入 ' + id); assert.ok(h.includes('aria-label="上移「' + name + '」"')); assert.ok(h.includes('aria-label="下移「' + name + '」"')); assert.ok(h.includes('aria-label="「' + name + '」的備註（選填）"'))
  }
  const up0 = h.match(/<button[^>]*data-act="up"[^>]*>/)[0]; assert.match(up0, /disabled=""/, '第一列不能再上移')
  const ups = [...h.matchAll(/<button[^>]*data-act="up"[^>]*>/g)].map((m) => m[0]); const downs = [...h.matchAll(/<button[^>]*data-act="down"[^>]*>/g)].map((m) => m[0])
  assert.equal(ups.filter((b) => b.includes('disabled=""')).length, 1); assert.equal(downs.filter((b) => b.includes('disabled=""')).length, 1); assert.match(downs[7], /disabled=""/, '最後一列不能再下移')
  assert.equal(count(h, /maxLength="120"/g), 8); assert.equal(count(h, /maxLength="24"/g), 1); assert.equal(count(h, />0 \/ 120</g), 8); assert.ok(h.includes('>0 / 24<'))
  for (const b of h.match(/<button\b[^>]*>/g)) { assert.match(b, /type="button"/); assert.match(b, /data-tour-ui="true"/) }
  for (const name of ['套用', '另存新腳本', '刪除', '還原預設', '複製腳本連結']) assert.ok(h.includes('>' + name + '</button>'), name)
  assert.match(h, /role="status" aria-live="polite"/, '結果訊息是 live region（一直存在）')
  assert.match(h, /<ol class="tour-plan-list" aria-label="導覽站序">/)
  assert.ok(h.includes('<option value="" selected="">預設完整導覽（8 站）</option>'))
  const del = h.match(/<button[^>]*>刪除<\/button>/)[0]; assert.match(del, /disabled=""/, '沒選已存腳本 → 不能刪除')
}))

test('SSR·編輯器：有生效的腳本 → 列順序 / 勾選 / 備註 / 名稱照腳本；標題有「使用中」；已存腳本進選單並選取；「刪除」可用', () => inStore(() => {
  saveTourPlanAs({ name: '空氣與魚', stops: [{ id: 'fish', note: '曾文溪' }, { id: 'air' }] })
  saveTourPlanAs({ name: '第二份', stops: ['tide'] })
  activateTourPlan('p1')
  const h = editor({ defaultOpen: true })
  const rowIds = [...h.matchAll(/data-row="([a-z]+)"/g)].map((m) => m[1])
  assert.deepEqual(rowIds.slice(0, 2), ['fish', 'air']); assert.equal(rowIds.length, 8)
  assert.equal(count(h, /checked=""/g), 2, '只勾腳本裡的兩站'); assert.ok(h.includes('value="曾文溪"')); assert.ok(h.includes('value="空氣與魚"')); assert.ok(h.includes('>3 / 120<'), '備註字數')
  assert.ok(h.includes('tour-plan-badge')); assert.ok(h.includes('<option value="p1" selected="">空氣與魚（2 站）</option>')); assert.ok(h.includes('<option value="p2">第二份（1 站）</option>'))
  assert.doesNotMatch(h.match(/<button[^>]*>刪除<\/button>/)[0], /disabled=""/)
  assert.match(h.match(/<button[^>]*data-act="up"[^>]*>/)[0], /disabled=""/)
}))

test('SSR·編輯器：導覽進行中 → 唯讀（fieldset disabled + 提示先結束導覽；套用 / 另存 / 刪除 / 還原都停用）；已存滿 5 份 → 「另存新腳本」停用並說明', () => inStore(() => {
  useTourStore.setState({ running: true })
  const h = editor({ defaultOpen: true })
  assert.match(h, /<fieldset class="tour-plan-fs" disabled="">/); assert.ok(h.includes('導覽進行中，腳本暫時唯讀。先結束導覽')); assert.match(h, /role="note"/)
  for (const name of ['套用', '另存新腳本', '刪除', '還原預設']) assert.match(h.match(new RegExp('<button[^>]*>' + name + '</button>'))[0], /disabled=""/, name)
  assert.doesNotMatch(h.match(/<button[^>]*>複製腳本連結<\/button>/)[0], /disabled=""/, '複製連結是唯讀動作，導覽中仍可用')
  useTourStore.setState({ running: false })
  for (const n of ['a', 'b', 'c', 'd', 'e']) saveTourPlanAs({ name: n, stops: ['air'] })
  const full = editor({ defaultOpen: true })
  assert.match(full.match(/<button[^>]*>另存新腳本<\/button>/)[0], /disabled=""/); assert.ok(full.includes('已存滿 5 份，先刪除一份'))
}))

test('SSR·編輯器：資料已載入時，沒有資料的站標「目前無資料」（導覽會略過）；資料還沒載入 → 不標', () => inStore(() => {
  assert.ok(!editor({ defaultOpen: true }).includes('目前無資料'))
  withGov(MINI_GOV, () => {
    const h = editor({ defaultOpen: true })
    assert.equal(count(h, /class="tour-plan-nodata"/g), 6, '8 站裡只有水庫與測站有資料')
    const reservoirRow = h.match(/<li[^>]*data-row="reservoir"[\s\S]*?<\/li>/)[0]; assert.ok(!reservoirRow.includes('目前無資料')); assert.ok(h.match(/<li[^>]*data-row="air"[\s\S]*?<\/li>/)[0].includes('目前無資料'))
  })
}))

test('SSR·編輯器：英文語系 → 介面文字都是英文（除了導覽員輸入的備註 / 名稱原文）；站名用資料層的譯文；語系切回中文恢復', () => inStore(() => {
  saveTourPlanAs({ name: '我的腳本', stops: [{ id: 'air', note: '中文備註' }, 'tide', 'reservoir'] })
  setLocale('en')
  try {
    const h = editor({ defaultOpen: true })
    const visible = h.replace(/value="[^"]*"/g, '').replace(/<option[^>]*>[^<]*我的腳本[^<]*<\/option>/, '')
    assert.doesNotMatch(visible, HAN, '英文語系不含中文（備註 / 名稱是使用者的原文，不在此限）')
    assert.ok(h.includes('Tour plan')); assert.ok(h.includes('aria-label="Move “Air quality (model data)” up"')); assert.ok(h.includes('aria-label="Include “Tide”"')); assert.ok(h.includes('>Save as new plan</button>')); assert.ok(h.includes('>Restore default</button>')); assert.ok(h.includes('>4 / 120<'), '備註字數')
    assert.ok(h.includes('value="中文備註"'), '備註原樣，不翻譯')
    assert.ok(h.includes('我的腳本 (3 stops)'), '已存腳本選單的站數是英文複數')
  } finally { setLocale('zh') }
  assert.ok(editor({ defaultOpen: true }).includes('>另存新腳本</button>'))
}))

test('SSR·編輯器：備註是純文字——含 HTML 的備註被跳脫、不會變成標記；原始碼沒有 dangerouslySetInnerHTML / innerHTML', () => inStore(() => {
  saveTourPlanAs({ name: '<script>alert(1)</script>', stops: [{ id: 'air', note: '<img src=x onerror=alert(1)>' }] })
  const h = editor({ defaultOpen: true })
  assert.ok(!h.includes('<script>') && !h.includes('<img src=x')); assert.ok(h.includes('&lt;img src=x onerror=alert(1)&gt;'))
  const src = (f) => readFileSync(new URL(f, import.meta.url), 'utf8')
  for (const f of ['../ui/TourPlanEditor.jsx', '../ui/TourCaption.jsx', '../ui/TourControls.jsx', '../ui/TourNav.jsx']) assert.doesNotMatch(src(f), /dangerouslySetInnerHTML|innerHTML/, f)
}))

test('planDisplayName：有名字用名字；沒名字依來源（網址 / 已存 / 自訂）給稱呼', () => {
  const t = (zh) => zh
  assert.equal(planDisplayName({ name: '空氣與魚', stops: [] }, 'saved', t), '空氣與魚')
  assert.equal(planDisplayName({ stops: [] }, 'url', t), '網址腳本'); assert.equal(planDisplayName({ stops: [] }, 'saved', t), '未命名腳本'); assert.equal(planDisplayName({ stops: [] }, 'custom', t), '自訂腳本'); assert.equal(planDisplayName(null, null, t), '自訂腳本')
})

test('SSR·資料導覽卡片：有生效的腳本 → 顯示「目前腳本：名稱（n 站）」、站數與時間以腳本為準；腳本裡缺資料的站有提示；全都缺資料 → 開始鈕停用並說明；沒有腳本時卡片與以前相同（沒有這一行）', () => inStore(() => {
  withGov(MINI_GOV, () => {
    const plain = html(createElement(TourControls))
    assert.ok(!plain.includes('目前腳本')); assert.ok(plain.includes('共 2 站 · 約 22 秒'), '沒有腳本：資料裡有的站都導覽（水庫 11 秒 + 測站 11 秒）'); assert.ok(plain.includes('導覽腳本'), '可摺疊的編輯器在卡片裡（收合）'); assert.ok(!plain.includes('tour-plan-body'))
    applyTourPlan({ name: '只講水庫', stops: [{ id: 'reservoir', note: '這是備註' }, 'air'] })
    const h = html(createElement(TourControls))
    assert.ok(h.includes('目前腳本：只講水庫（2 站）')); assert.ok(h.includes('1 站目前沒有資料，會略過')); assert.ok(h.includes('共 1 站 · 約 11 秒')); assert.ok(h.includes('tour-plan-badge'))
    applyTourPlan({ stops: ['air', 'fish'] })
    const empty = html(createElement(TourControls))
    assert.ok(empty.includes('目前腳本：自訂腳本（2 站）')); assert.ok(empty.includes('腳本內的站目前都沒有資料，導覽無法開始')); assert.match(empty.match(/<button[^>]*tour-btn[^>]*>/)[0], /disabled=""/)
    assert.ok(!empty.includes('共 0 站'))
    setLocale('en')
    try { assert.ok(html(createElement(TourControls)).includes('Current plan: Custom plan (2 stops)')) } finally { setLocale('zh') }
  })
}))

test('SSR·資料導覽卡片：網址腳本（來源 url）沒有名字 → 顯示「網址腳本」；data-src 標明來源', () => inStore(() => {
  withGov(MINI_GOV, () => {
    useTourStore.setState({ plan: { stops: [{ id: 'reservoir' }] }, planSrc: 'url' })
    const h = html(createElement(TourControls))
    assert.ok(h.includes('目前腳本：網址腳本（1 站）')); assert.match(h, /class="tour-plan-now" data-src="url"/)
  })
}))
