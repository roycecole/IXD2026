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
