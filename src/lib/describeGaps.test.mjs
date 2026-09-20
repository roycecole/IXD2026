// 資料看板 / 日誌的鳥魚列：調查年首尾之外，中間有空窗要標出來。執行：node --test src/lib/describeGaps.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadEnDict } from '../../scripts/i18n-check.mjs'
import { registerEn, setLocale } from '../i18n/index.js'
import { describeBoard } from './describe.js'

const { dict } = await loadEnDict()
registerEn(dict)
const inEn = (fn) => { setLocale('en'); try { return fn() } finally { setLocale('zh') } }

const monthly = Array.from({ length: 12 }, (_, i) => ({ m: i + 1, s: 30, n: 10 }))
const optOf = (years) => ({ id: 'x', name: '曾文水庫', params: {}, birds: { basin: '曾文溪流域', species: 30, monthly, yearly: years.map((y, i) => ({ y, s: 20 + i, n: 50 })) } })
const rowOf = (years, ctx) => describeBoard({}, optOf(years), ctx).find((r) => r.k === '鳥群' || r.k === 'Bird flocks').v

test('有空窗：在「調查 首–尾」後補「（空窗 …）」（中文 / 英文）', () => {
  const v = rowOf([2004, 2005, 2006, 2014, 2015], { month: 8 })
  assert.match(v, /調查 2004–2015（空窗 2007–2013）$/)
  assert.match(inEn(() => rowOf([2004, 2005, 2006, 2014, 2015], { month: 8 })), /survey 2004–2015 \(no survey 2007–2013\)$/)
})

test('多段空窗以頓號 / 逗號連接；單一年的空窗只寫那一年', () => {
  const years = [2004, 2006, 2010, 2011]                       // 空窗：2005、2007–2009
  assert.match(rowOf(years, { month: 8 }), /（空窗 2005、2007–2009）$/)
  assert.match(inEn(() => rowOf(years, { month: 8 })), /\(no survey 2005, 2007–2009\)$/)
})

test('連續調查、沒有空窗：輸出與以前逐字相同（不加任何字）', () => {
  const v = rowOf([2004, 2005, 2006], { month: 8 })
  assert.match(v, /調查 2004–2006$/); assert.ok(!v.includes('空窗'))
  assert.match(inEn(() => rowOf([2004, 2005, 2006], { month: 8 })), /survey 2004–2006$/)
})

test('只有單一調查年 / 壞資料：不丟錯、不標空窗', () => {
  assert.doesNotThrow(() => rowOf([2010], { month: 8 }))
  assert.ok(!rowOf([2010], { month: 8 }).includes('空窗'))
  const bad = optOf([2004, 2006]); bad.birds.yearly.push({ y: 'x', s: null })
  assert.doesNotThrow(() => describeBoard({}, bad, { month: 8 }))
})
