// 空氣品質（Open-Meteo / CAMS 模型資料）前端側的測試：seriesFromAir / automationFor / formatHud / describeBoard（zh 與 en）/ playAir，
// 以及與資料端 scripts/gov/air.mjs 的映射一致性、真實 ocean.json 的 smoke。執行：node --test src/lib/air.test.mjs
process.env.TZ = 'Asia/Taipei'   // 描述文字裡的時刻直接取字串，不受時區影響；固定它是為了其他讀本地時間的列（月亮等）穩定
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { seriesFromAir, seriesFromDust, automationFor, formatHud, airMapping, AIR_PM_SCALE } from './series.js'
import { describeBoard, describeForLog, airSummary, airWhereText, airPmText } from './describe.js'
import { airMap, airParams, AIR_PM_SCALE as DATA_SCALE, AIR_SOURCE, AIR_NOTE } from '../../scripts/gov/air.mjs'
const AIR_NOTE_TEXT = String(AIR_NOTE)
import { loadEnDict, HAN } from '../../scripts/i18n-check.mjs'
import { registerEn, setLocale, getLocale, translate } from '../i18n/index.js'
import { nameText } from '../i18n/data.js'
import { renderShareCard } from './capture.js'

const { dict: EN_DICT } = await loadEnDict()
registerEn(EN_DICT)
const inEn = (fn) => { setLocale('en'); try { return fn() } finally { setLocale('zh') } }   // 英文語系下執行，結束一定切回中文
const real = JSON.parse(readFileSync(new URL('../../public/data/ocean.json', import.meta.url), 'utf8'))
const inUnit = (v) => typeof v === 'number' && v >= 0 && v <= 1

const T = (h, d = 20) => `2026-09-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00+08:00`
const H = (h, pm25, pm10 = null, dust = null, aqi = null, d = 20) => ({ t: T(h, d), pm10, pm25, dust, aqi })
const AIR = { county: '雲林縣', place: '麥寮', lat: 23.79, lon: 120.25, sourceUrl: 'https://open-meteo.com/en/docs/air-quality-api', history: [H(9, 12, 15, 0, 50), H(10, 21, 25, 0, 71), H(11, 48, 60, 0, 120)] }
const OPT = { id: 'air-yunlin', name: '空氣品質 · 雲林', kind: 'air', level: 48, params: { clarity: 0.54, trashCount: 0.35, glow: 0.52, hue: 0.43, current: 0.3 } }
const GOV = { weather: { weather: '多雲', airTemp: 29, humidity: 80, windSpeed: 3.6 }, air: AIR, options: [OPT] }

test('seriesFromAir：規格契約（kind / label / unit / step / target / 點的欄位）；名稱帶「模型資料」；PM2.5 缺值的小時略過', () => {
  const s = seriesFromAir({ ...AIR, history: [H(9, 12, 15, 0, 50), H(10, null, 30, 0, 60), H(11, 48, 60, 0, 120), H(12, 30)] })
  assert.equal(s.kind, 'air'); assert.equal(s.label, 'PM2.5'); assert.equal(s.unit, 'μg/m³'); assert.equal(s.target, 'clarity'); assert.equal(s.step, 0.2)
  assert.equal(s.name, '空氣品質（雲林縣 · 模型資料）'); assert.deepEqual(s.extra, { model: true })
  assert.deepEqual(s.points.map((p) => p.t), ['09-20 09:00', '09-20 11:00', '09-20 12:00'])            // 10:00 沒有 PM2.5 → 略過；格式 MM-DD HH:00
  assert.deepEqual(s.points[0], { t: '09-20 09:00', v: 12, pm10: 15, dust: 0, aqi: 50 })
  assert.deepEqual(Object.keys(s.points[0]), ['t', 'v', 'pm10', 'dust', 'aqi'])
  assert.deepEqual(s.points[2], { t: '09-20 12:00', v: 30, pm10: null, dust: null, aqi: null })
  assert.equal(s.date, '09-20 09:00 → 09-20 12:00')
  assert.deepEqual(s.stats, { min: 12, max: 48, mean: 30 })
  assert.equal(seriesFromAir({ history: AIR.history }).name, '空氣品質（模型資料）')                       // 沒有縣市
  assert.equal(seriesFromAir(AIR, '空氣').name, '空氣（雲林縣 · 模型資料）')                              // name 參數
  assert.equal(seriesFromAir(AIR).points.length, 3)
})

test('seriesFromAir：歷史不足 2 個有效點 → null；壞輸入不炸', () => {
  assert.equal(seriesFromAir({ history: [H(9, 12)] }), null)
  assert.equal(seriesFromAir({ history: [H(9, 12), H(10, null, 20)] }), null)
  assert.equal(seriesFromAir({ history: [H(9, NaN), H(10, Infinity), H(11, '5'), H(12, undefined)] }), null)   // 只收 number 且有限
  for (const junk of [null, undefined, {}, [], 'x', 5, { history: null }, { history: 'x' }, { history: [] }, { history: [null, 5, 'x', {}] }]) assert.equal(seriesFromAir(junk), null, JSON.stringify(junk))
  assert.equal(seriesFromAir({ history: [null, H(9, 5), 7, H(10, 6)] }).points.length, 2)                    // 夾雜壞列
})

test('automationFor(air)：PM2.5 高 → 混濁、垃圾多、色相偏黃綠、輝光收斂；只寫這四個參數、皆 0..1；範圍夠大', () => {
  const s = seriesFromAir({ history: [H(1, 2), H(2, 15), H(3, 30), H(4, 60), H(5, 100), H(6, 400)] })
  const a = s.points.map((_, i) => automationFor(s, i))
  for (const step of a) { assert.deepEqual(step.map(([pid]) => pid), ['clarity', 'trashCount', 'hue', 'glow']); for (const [, v] of step) assert.ok(inUnit(v), String(v)) }
  const by = (k) => a.map((step) => Object.fromEntries(step)[k])
  for (let i = 1; i < a.length; i++) {
    assert.ok(by('clarity')[i] <= by('clarity')[i - 1] && by('hue')[i] <= by('hue')[i - 1] && by('glow')[i] <= by('glow')[i - 1], `step ${i}`)
    assert.ok(by('trashCount')[i] >= by('trashCount')[i - 1], `step ${i}`)
  }
  assert.ok(by('clarity')[0] - by('clarity')[3] > 0.4 && by('trashCount')[3] - by('trashCount')[0] > 0.3 && by('glow')[0] - by('glow')[3] > 0.2, '2 → 60 μg/m³ 要有明顯視覺差')
  assert.equal(by('clarity')[5], by('clarity')[4]); assert.equal(by('trashCount')[5], by('trashCount')[4])   // 100 與 400 μg/m³ 都夾在上限：規一化到 0..1，不會越界
  assert.equal(AIR_PM_SCALE, 100); assert.equal(AIR_PM_SCALE, DATA_SCALE)
})

test('映射與資料端一致：series.js 的 airMapping / automationFor 與 scripts/gov/air.mjs 的 airMap / airParams（air-yunlin 基準海況）同一組係數', () => {
  for (const pm of [0, 1.3, 5, 12, 21, 23.8, 35, 50.5, 75, 100, 180, 1000]) {
    const m = airMapping(pm), d = airMap(pm)
    for (const k of ['clarity', 'trashCount', 'hue', 'glow']) assert.ok(Math.abs(m[k] - d[k]) < 1e-12, `${k} @ ${pm}`)
    const p = airParams({ pm25: pm })
    for (const [k, v] of Object.entries(m)) assert.ok(Math.abs(p[k] - v) <= 0.0051, `airParams ${k} @ ${pm}: ${p[k]} vs ${v}`)   // 資料端四捨五入到 2 位
    const s = seriesFromAir({ history: [H(1, pm), H(2, pm)] })
    assert.deepEqual(Object.fromEntries(automationFor(s, 0)), m, `automationFor @ ${pm}`)
  }
})

test('formatHud(air)：中文——名稱帶模型資料、PM2.5 / PM10 / US AQI；沒有 PM10 / AQI 就不印；沙塵 > 0 才印；不含 undefined / null / NaN', () => {
  const s = seriesFromAir({ ...AIR, history: [H(9, 12.4, 15, 0, 50), H(10, 21, null, 3.2, null), H(11, 48, 60, 0, 120)] })
  assert.equal(formatHud(s, s.points[0]), '空氣品質（雲林縣 · 模型資料） 09-20 09:00 · PM2.5 12.4μg/m³ · PM10 15 μg/m³ · US AQI 50')
  assert.equal(formatHud(s, s.points[1]), '空氣品質（雲林縣 · 模型資料） 09-20 10:00 · PM2.5 21μg/m³ · 沙塵 3.2 μg/m³')
  for (const p of s.points) assert.doesNotMatch(formatHud(s, p), /undefined|null|NaN/)
  // 播放中的 seriesMeta 形態（與規格同樣的 name / label / unit 頂層欄位）
  assert.equal(formatHud({ kind: 'air', name: s.name, label: s.label, unit: s.unit, points: s.points, extra: s.extra }, s.points[2]), '空氣品質（雲林縣 · 模型資料） 09-20 11:00 · PM2.5 48μg/m³ · PM10 60 μg/m³ · US AQI 120')
})

test('formatHud(air)：英文——名稱與單位翻好、不含中文；「Model data」標示保留', () => inEn(() => {
  const s = seriesFromAir({ ...AIR, history: [H(9, 12.4, 15, 0, 50), H(10, 21, null, 3.2, null)] })
  assert.equal(formatHud(s, s.points[0]), 'Air quality (Yunlin County · Model data) 09-20 09:00 · PM2.5 12.4 μg/m³ · PM10 15 μg/m³ · US AQI 50')
  assert.equal(formatHud(s, s.points[1]), 'Air quality (Yunlin County · Model data) 09-20 10:00 · PM2.5 21 μg/m³ · Mineral dust 3.2 μg/m³')
  assert.equal(nameText('空氣品質 · 雲林'), 'Air quality · Yunlin')
  assert.equal(nameText('麥寮'), 'Mailiao')
}))

test('describe：airSummary / airWhereText / airPmText（中英文）', () => {
  const a = airSummary(AIR)
  assert.deepEqual(a, { county: '雲林縣', place: '麥寮', t: T(11), pm25: 48, pm10: 60, dust: 0, aqi: 120, n: 3 })
  assert.equal(airWhereText(a), '雲林縣麥寮')
  assert.equal(airPmText(a), 'PM2.5 48 · PM10 60 μg/m³ · US AQI 120')
  assert.equal(airPmText({ pm25: 21, pm10: null, aqi: null }), 'PM2.5 21 μg/m³')
  assert.equal(airPmText(null), '')
  // 最新一筆沒有 PM2.5 → 退回前一筆有的
  assert.equal(airSummary({ ...AIR, history: [H(9, 12), H(10, null, 30)] }).t, T(9))
  for (const junk of [null, undefined, {}, { history: [] }, { history: [H(9, null)] }, { history: 'x' }]) assert.equal(airSummary(junk), null)
  inEn(() => assert.equal(airWhereText(a), 'Mailiao, Yunlin County'))
})

const rowsOf = (gov, opt, ctx) => describeBoard(gov, opt, ctx)
const textOf = (rows) => rows.map((r) => `${r.k}｜${r.v}`)

test('describeBoard(air)：中文——資料列、來源列（模型資料）、映射列；沒有資料 → 尚無資料，來源仍標示', () => {
  const rows = rowsOf(GOV, OPT, { now: new Date(2026, 8, 20, 12, 0) })
  assert.deepEqual(rows[0], { k: '空氣品質', v: '雲林縣麥寮 · PM2.5 48 · PM10 60 μg/m³ · US AQI 120 · 09-20 11:00' })
  assert.deepEqual(rows[1], { k: '來源', v: 'Open-Meteo（CAMS 全球大氣模型）· 模型資料，非政府觀測值' })
  assert.deepEqual(rows[2], { k: '映射', v: 'PM2.5 ↑ → 海水清澈 0.54 · 垃圾 0.35 · 輝光 0.52' })
  assert.equal(rows[3].k, '氣象'); assert.match(rows[3].v, /洋流/)                                        // 風速 → 洋流（沿用氣象列）
  const log = describeForLog(GOV, OPT, { now: new Date(2026, 8, 20, 12, 0) })
  assert.ok(log.includes('資料 來源｜Open-Meteo（CAMS 全球大氣模型）· 模型資料，非政府觀測值'), log.join('\n'))
  for (const g of [{ ...GOV, air: null }, { ...GOV, air: { ...AIR, history: [] } }, { ...GOV, air: { ...AIR, history: [H(9, null, 20)] } }, { weather: null, options: [OPT] }]) {
    const r = rowsOf(g, OPT)
    assert.deepEqual(r[0], { k: '空氣品質', v: '尚無資料' }); assert.equal(r[1].k, '來源'); assert.ok(r[1].v.includes('模型資料'))
    assert.ok(!r.some((x) => x.k === '映射'))
  }
  assert.deepEqual(rowsOf(null, OPT), []); assert.deepEqual(rowsOf(GOV, null), [])
})

test('describeBoard(air)：英文——不含中文、措辭固定；切回中文不殘留', () => {
  const zh1 = textOf(rowsOf(GOV, OPT, { now: new Date(2026, 8, 20, 12, 0) }))
  const en = inEn(() => textOf(rowsOf(GOV, OPT, { now: new Date(2026, 8, 20, 12, 0) })))
  assert.deepEqual(en.slice(0, 3), [
    'Air quality｜Mailiao, Yunlin County · PM2.5 48 · PM10 60 μg/m³ · US AQI 120 · 09-20 11:00',
    'Source｜Modeled, not government observations · Open-Meteo CAMS',
    'Mapping｜PM2.5 ↑ → water clarity 0.54 · trash 0.35 · glow 0.52',
  ])
  for (const l of en) assert.ok(!HAN.test(l), l)
  const log = inEn(() => describeForLog(GOV, OPT, { now: new Date(2026, 8, 20, 12, 0) }))
  assert.ok(log.every((l) => !HAN.test(l)) && log.some((l) => /Modeled, not government observations/.test(l)), log.join('\n'))
  assert.equal(getLocale(), 'zh'); assert.deepEqual(textOf(rowsOf(GOV, OPT, { now: new Date(2026, 8, 20, 12, 0) })), zh1)
  const none = inEn(() => textOf(rowsOf({ ...GOV, air: null }, OPT)))
  assert.deepEqual(none.slice(0, 2), ['Air quality｜No data yet', 'Source｜Modeled, not government observations · Open-Meteo CAMS'])
})

// ---- 分享星球圖：資料列有字數上限（中文 40、英文 64），超過會被硬截斷——「模型資料，非政府觀測」不能被截掉（圖貼到社群後脫離 App，那句是唯一的說明）----
function drawShareCard(lines) {
  const drawn = []
  const state = { font: '' }
  const ctx = new Proxy(state, {
    get(t, k) {
      if (k in t) return t[k]
      if (k === 'measureText') return (str) => ({ width: [...str].length * (parseFloat(/(\d+)px/.exec(t.font)?.[1]) || 10) * 0.55 })
      if (k === 'createLinearGradient') return () => ({ addColorStop() {} })
      if (k === 'fillText') return (text) => drawn.push({ text, font: t.font })
      return () => {}
    },
    set(t, k, v) { t[k] = v; return true },
  })
  const saved = globalThis.document
  globalThis.document = { querySelector: () => ({ width: 1200, height: 800, clientWidth: 1200 }), createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) }
  try { renderShareCard({ lines }) } finally { if (saved === undefined) delete globalThis.document; else globalThis.document = saved }
  return drawn.map((d) => d.text)
}

test('分享星球（空氣品質）：來源列不被字數上限截斷——「非政府觀測」在中英文分享圖上都完整保留；來源列在中 / 英文都在上限內', () => {
  const CAP = { zh: 40, en: 64 }   // capture.js 的資料列字數上限
  const rows = () => describeBoard(GOV, OPT, { now: new Date(2026, 8, 20, 12, 0) }).slice(0, 3).map((x) => `${x.k}｜${x.v}`)   // TopBar.jsx doShareImage 的做法：前 3 列
  for (const [loc, tag, disclaimer] of [['zh', '來源｜', /模型資料，非政府觀測值/], ['en', 'Source｜', /Modeled, not government observations/]]) {
    setLocale(loc)
    try {
      const lines = rows()
      const src = lines.find((l) => l.startsWith(tag))
      assert.ok(src, `${loc}：有來源列`); assert.ok([...src].length <= CAP[loc], `${loc}：來源列 ${[...src].length} 字元，上限 ${CAP[loc]}`)
      const drawn = drawShareCard(lines).find((x) => x.startsWith(tag))
      assert.equal(drawn, src, `${loc}：畫上去的與資料列完全相同（沒被截斷、沒被加「…」）`)
      assert.match(drawn, disclaimer)
      assert.ok(!drawn.endsWith('…'))
    } finally { setLocale('zh') }
  }
})

test('資料卡的空間尺度警語：可見文字（不只是 title）說明是「數十公里粗網格的模型估計、可能與地面測站不同」；與資料檔的 air.note 同一個意思；中英文都有、英文不含中文', () => {
  const KEY = '約數十公里的粗網格模型估計，可能與地面測站數值不同，請勿當官方空品判讀'
  const card = readFileSync(new URL('../ui/DataCard.jsx', import.meta.url), 'utf8')
  const src = card.match(/<div className="gov-air-src"[\s\S]*?<\/div>/)[0]
  assert.ok(src.includes(`<span className="gov-air-scale">{t('${KEY}')}</span>`), '在「模型資料」標籤旁的可見 <span>')
  assert.ok(src.indexOf('gov-air-badge') < src.indexOf('gov-air-scale') && src.indexOf('gov-air-scale') < src.indexOf('gov-air-credit'), '標籤 → 警語 → 出處')
  assert.match(readFileSync(new URL('../styles/air.css', import.meta.url), 'utf8'), /\.gov-air-scale \{/)
  assert.match(KEY, /數十公里/); assert.match(KEY, /地面測站/); assert.match(KEY, /官方/)
  assert.match(AIR_NOTE_TEXT, /數十公里/); assert.match(AIR_NOTE_TEXT, /地面測站/); assert.match(AIR_NOTE_TEXT, /官方/)   // 資料端寫的警語（air.mjs）：UI 講的是同一件事
  const en = inEn(() => translate('en', KEY))
  assert.ok(en && !HAN.test(en) && /tens of kilometres/.test(en) && /ground-station/.test(en) && /official/.test(en), en)
  assert.equal(translate('zh', KEY), KEY)
  assert.ok(real.air && typeof real.air.note === 'string' && real.air.note.length > 0, 'ocean.json 仍帶 air.note')
})

test('誠實：任何顯示處都不說它是政府資料——中文出現「政府」只能是「非政府」，英文出現 government 只能是「not government」', () => {
  const s = seriesFromAir(AIR)
  const zh = [...textOf(rowsOf(GOV, OPT)), ...describeForLog(GOV, OPT), s.name, ...s.points.map((p) => formatHud(s, p)), AIR_SOURCE].join('\n')
  assert.ok(zh.includes('模型資料') && zh.includes('非政府'))
  assert.ok(!zh.replaceAll('非政府', '').includes('政府'), zh)
  const en = inEn(() => [...textOf(rowsOf(GOV, OPT)), ...describeForLog(GOV, OPT), nameText(s.name), ...s.points.map((p) => formatHud(s, p))].join('\n'))
  assert.ok(/model/i.test(en) && !/official|observed/i.test(en))
  assert.ok(!en.replaceAll('not government', '').toLowerCase().includes('government'), en)
})

test('氣象列的「→ 洋流」只在洋流真的由花蓮外海風速算出來的選項才印（水庫 / 潮汐 / 空氣品質）；揚塵（測站風速）與月亮（預設值）不印，免得同一面板兩個風速對到同一個洋流值', () => {
  const now = new Date(2026, 8, 20, 12, 0)
  const weatherRow = (o) => describeBoard(real, o, { now }).find((r) => r.k === '氣象')
  const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2)
  for (const o of real.options) {
    const row = weatherRow(o)
    assert.ok(row, o.id)
    if (o.kind === 'dust' || o.kind === 'moon') assert.doesNotMatch(row.v, /洋流/, `${o.id}：洋流不是這個風速算的`)
    else assert.ok(row.v.endsWith(`→ 洋流 ${f2(o.params.current)}`), `${o.id}：${row.v}`)
  }
  const dust = real.options.find((o) => o.kind === 'dust'), moon = real.options.find((o) => o.kind === 'moon')
  assert.ok(dust && moon, '真實資料有揚塵與月亮選項')
  // 矛盾的重現：以前揚塵的映射列（測站風速 → 洋流）與氣象列（花蓮外海風速 → 同一個洋流值）並列
  assert.match(describeBoard(real, dust, { now }).find((r) => r.k === '映射').v, /洋流/)
  // 英文與 OUT 日誌行同步
  inEn(() => {
    for (const o of [dust, moon]) assert.doesNotMatch(describeBoard(real, o, { now }).find((r) => r.k === 'Weather').v, /current/, o.id)
    assert.match(describeBoard(real, real.options.find((o) => o.kind === 'air'), { now }).find((r) => r.k === 'Weather').v, /→ current \d\.\d\d$/)
    for (const o of [dust, moon]) for (const l of describeForLog(real, o, { now })) if (l.includes('Weather')) assert.doesNotMatch(l, /current/, l)
  })
  for (const o of [dust, moon]) for (const l of describeForLog(real, o, { now })) if (l.includes('氣象')) assert.doesNotMatch(l, /洋流/, l)
  assert.equal(weatherRow(real.options.find((o) => o.id === 'feitsui')).v.split(' → ').length, 2, '水庫選項維持原樣')
})

test('與揚塵並存：同一個 gov 的揚塵選項描述 / 序列不受空氣品質影響', () => {
  const dust = { county: '雲林縣', stations: [{ pm10: 30, wind: 3, temp: 28, rh: 70, t: T(9) }], history: [{ t: T(9), pm10: 30, wind: 3, temp: 28, rh: 70 }, { t: T(12), pm10: 80, wind: 6, temp: 30, rh: 65 }] }
  const dustOpt = { id: 'dust-yunlin', name: '揚塵 · 雲林縣', kind: 'dust', level: 30, params: { clarity: 0.8, trashCount: 0.12, current: 0.25 } }
  const g = { ...GOV, dust, options: [dustOpt, OPT] }
  assert.equal(rowsOf(g, dustOpt)[0].k, '揚塵')
  assert.equal(seriesFromDust(dust).kind, 'dust'); assert.equal(seriesFromAir(g.air).kind, 'air')
  assert.ok(!rowsOf(g, dustOpt).some((r) => r.k === '來源'))                                              // 揚塵列不帶模型資料標示（它是政府感測站）
})

// ---- store：playAir ----
test('playAir：走 playSeries——寫入 seriesMeta（kind air、120 步 × 0.2 秒）、日誌一行資料播放；沒有 air 資料時什麼都不做', async () => {
  const { useStore, seriesMeta } = await import('../store/useStore.js')
  const S = () => useStore.getState()
  S().setGov({ defaultOption: 'air-yunlin', ...GOV, air: { ...AIR, history: Array.from({ length: 120 }, (_, i) => H(i % 24, 10 + (i % 30), 12 + (i % 30), 0, 50 + (i % 20), 1 + Math.floor(i / 24))) } })
  S().setGovOption('air-yunlin')
  useStore.setState({ log: [] })
  assert.equal(S().rec.mode, 'idle')
  S().playAir()
  try {
    assert.equal(seriesMeta.active, true); assert.equal(seriesMeta.kind, 'air'); assert.equal(seriesMeta.points.length, 120)
    assert.equal(seriesMeta.step, 0.2); assert.equal(seriesMeta.extra.model, true)
    assert.ok(Math.abs(S().rec.duration - 24) < 1e-9)                                                        // 120 步 × 0.2 秒
    assert.equal(S().rec.mode, 'playing')
    const line = S().log.map((l) => l.text).find((x) => x.includes('資料播放'))
    assert.match(line, /^▶ 資料播放：空氣品質（雲林縣 · 模型資料） 09-01 00:00 → 09-05 23:00 PM2\.5（120 筆，μg\/m³）$/)
    assert.ok(!/undefined|NaN|null/.test(line))
  } finally { S().stopPlayback() }
  // 英文日誌
  inEn(() => {
    useStore.setState({ log: [] }); S().playAir(); S().stopPlayback()
    const en = S().log.map((l) => l.text).find((x) => /Data playback/.test(x))
    assert.equal(en, '▶ Data playback: Air quality (Yunlin County · Model data) 09-01 00:00 → 09-05 23:00 PM2.5 (120 records, μg/m³)')
  })
  // 沒有 air / 資料不足 → 不播放
  S().setGov({ defaultOption: 'air-yunlin', ...GOV, air: null }); S().setGovOption('air-yunlin')
  seriesMeta.active = false
  S().playAir()
  assert.equal(S().rec.mode, 'idle'); assert.equal(seriesMeta.active, false)
  S().setGov({ defaultOption: 'air-yunlin', ...GOV, air: { ...AIR, history: [H(9, 5)] } })
  S().playAir()
  assert.equal(S().rec.mode, 'idle')
  assert.equal(getLocale(), 'zh')
})

// ---- 真實 ocean.json ----
test('真實 ocean.json：seriesFromAir 100+ 點、映射有明顯動態範圍；air-yunlin 選項的看板 / 日誌 / HUD 中英文都乾淨；所有選項仍可描述', () => {
  const s = seriesFromAir(real.air)
  assert.ok(s && s.points.length >= 100 && s.points.length <= 120, `points ${s && s.points.length}`)
  assert.ok(s.points.every((p) => /^\d{2}-\d{2} \d{2}:00$/.test(p.t) && Number.isFinite(p.v)))
  assert.ok(new Set(s.points.map((p) => p.v)).size > 20, '數值會變')
  const cl = s.points.map((_, i) => Object.fromEntries(automationFor(s, i)).clarity)
  assert.ok(Math.max(...cl) - Math.min(...cl) > 0.1, `歷史內清澈度起伏 ${Math.max(...cl) - Math.min(...cl)}（要有肉眼看得出的差）`)
  for (let i = 0; i < s.points.length; i++) for (const [, v] of automationFor(s, i)) assert.ok(inUnit(v))
  const opt = real.options.find((o) => o.id === 'air-yunlin')
  assert.ok(opt && opt.kind === 'air')
  const lines = () => [...describeBoard(real, opt, { now: new Date(2026, 8, 20, 12, 0) }).map((r) => `${r.k}｜${r.v}`), ...describeForLog(real, opt, { now: new Date(2026, 8, 20, 12, 0) }), ...s.points.map((p) => formatHud(s, p))]
  const zh = lines()
  const en = inEn(lines)
  for (const l of zh) assert.doesNotMatch(l, /undefined|NaN|null/, l)
  for (const l of en) { assert.doesNotMatch(l, /undefined|NaN|null/, l); assert.ok(!HAN.test(l), l) }
  assert.ok(zh.some((l) => l.startsWith('來源｜') && l.includes('模型資料')) && en.some((l) => l.startsWith('Source｜') && /Modeled, not government observations/.test(l)))
  assert.notDeepEqual(zh, en)
  for (const o of real.options) assert.ok(describeBoard(real, o).length > 0, o.id)                          // 新選項沒有弄壞其他選項（全選項的英文乾淨度見 i18n-data.test.mjs 的全掃）
  inEn(() => assert.ok(!HAN.test(nameText(opt.name)) && !HAN.test(nameText(s.name)) && !HAN.test(nameText(real.air.place)), 'nameText'))
})
