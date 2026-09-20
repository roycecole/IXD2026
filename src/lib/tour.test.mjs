// 資料導覽（lib/tour.js）的單元測試。執行：node --test src/lib/tour.test.mjs
// 涵蓋：buildTour（真實 ocean.json / 缺資料 / 空資料 / 壞資料）、倍速、字幕（zh / en 都不含 undefined / NaN、en 不含中文、語系切換）、
// 空窗年、揚塵誠實說明、執行器（用假 store 測：換站、還原、各種中斷、循環）、偏好與鏡像。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadEnDict, HAN } from '../../scripts/i18n-check.mjs'
import { registerEn, setLocale } from '../i18n/index.js'
import { getMirror } from './mirror.js'
import {
  buildTour, captionText, speedFor, tourTotalMs, createTourRunner, useTourStore, resolveAutoIdle, isAudienceSearch,
  MIN_SPEED, MAX_SPEED, TOUR_MS,
} from './tour.js'

const { dict } = await loadEnDict()
registerEn(dict)

const real = JSON.parse(readFileSync(new URL('../../public/data/ocean.json', import.meta.url), 'utf8'))
const clone = (x) => JSON.parse(JSON.stringify(x))
const NOW = new Date('2026-09-20T12:00:00+08:00')
const BAD = /undefined|NaN|null|\[object/

// 兩種語系各跑一次
function inLocale(loc, fn) { setLocale(loc); try { return fn() } finally { setLocale('zh') } }
function texts(stops, loc) { return inLocale(loc, () => stops.map((s) => ({ id: s.id, ...captionText(s.caption) }))) }

// ---- 合成資料：七站齊全、內容確定（不依賴 CI 每天更新的 ocean.json）----
const PARAMS = { seaLevel: 0.77, current: 0.06, flowX: 0.84, flowY: 0.29, clarity: 0.77, glow: 0.8, hue: 0.5, jellyCount: 0.72, fishCount: 0.64, trashCount: 0.14, swimSpeed: 0.42, spin: 0.28, zoom: 0.5 }
const yearly = (ys) => ys.map((y, i) => ({ y, s: 30 + i * 9, n: 100 + i }))
function mkGov() {
  const tidePts = Array.from({ length: 24 }, (_, h) => ({ h, v: Math.round(150 + 30 * Math.sin((h / 24) * Math.PI * 2)) }))
  const days = ['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22'].map((d, i) => [d, '12:5' + i, 121, '18:1' + i, 38 + i, 'S', i === 1 ? '' : '23:2' + i, 240])
  const hist = (rows) => rows.map(([t, pm10, wind]) => ({ t, pm10, wind, temp: 30, rh: 70 }))
  return {
    defaultOption: 'feitsui',
    weather: { airTemp: 29, humidity: 80, windSpeed: 1, windDir: 90, precip: 0, weather: '晴' },
    options: [
      { id: 'feitsui', name: '翡翠水庫', level: 77.3, params: { ...PARAMS }, birds: { basin: '淡水河流域', species: 122, monthly: [], yearly: yearly([2005, 2015, 2016, 2017]) }, fish: { basin: '淡水河流域', species: 113, monthly: [], yearly: yearly([2005, 2015, 2016, 2017]) } },
      { id: 'zengwen', name: '曾文水庫', level: 100, params: { ...PARAMS, seaLevel: 1 }, fish: { basin: '曾文溪流域', species: 112, monthly: [], yearly: yearly([2004, 2005, 2006, 2014, 2015]) } },
      { id: 'hualien-tide', name: '花蓮外海', kind: 'tide', level: 68, params: { ...PARAMS, seaLevel: 0.86 }, series: { label: '潮位', unit: 'cm', date: '2026-09-20', target: 'seaLevel', lunar: '2026-08-10', lunarLabel: '農曆八月初十', range: '小', points: tidePts, events: [] } },
      { id: 'dust-yunlin', name: '揚塵 · 雲林縣', kind: 'dust', level: 0, params: { ...PARAMS, clarity: 0.6 } },
      { id: 'moon-hualien', name: '月亮 · 花蓮', kind: 'moon', level: 0, params: { ...PARAMS } },
    ],
    dust: { county: '雲林縣', stations: [{ id: 'a', name: 'A', pm10: null, wind: 5.3, temp: 30, rh: 70, t: '2026-09-20T10:00:00+08:00' }], history: hist([['2026-09-20T07:00:00+08:00', null, 3], ['2026-09-20T10:00:00+08:00', null, 6], ['2026-09-20T13:00:00+08:00', null, 4]]) },
    moon: { county: '花蓮縣', from: '2026-09-19', to: '2026-09-22', days },
    stations: { total: 188, active: 100, list: [{ n: '景美', r: '景美溪', x: 0.1, y: 0.4, a: 114.9, s: 1 }, { n: '思源橋', r: '北勢溪', x: 0.2, y: 0.4, a: 0.7, s: 0 }] },
  }
}
const IDS7 = ['reservoir', 'tide', 'moon', 'dust', 'birds', 'fish', 'stations']

// =============================================================================================
// buildTour
// =============================================================================================
test('buildTour：合成資料 → 七站依序、每站欄位齊全、整個導覽 90~120 秒', () => {
  const gov = mkGov()
  const stops = buildTour(gov, { now: NOW })
  assert.deepEqual(stops.map((s) => s.id), IDS7)
  for (const s of stops) {
    assert.ok(gov.options.some((o) => o.id === s.optionId), `${s.id} 的 optionId 必須存在`)
    assert.ok(s.kind === 'apply' || s.kind === 'series')
    assert.ok(s.durationMs > 0 && Number.isFinite(s.speed))
    assert.ok(s.caption && typeof s.caption.key === 'string' && s.caption.p && typeof s.caption.p === 'object')
    JSON.parse(JSON.stringify(s.caption))     // 字幕資料必須是純 JSON（鏡像到觀眾視窗）
  }
  const total = tourTotalMs(stops)
  assert.ok(total >= 90000 && total <= 120000, `總長 ${total}`)
  assert.deepEqual(stops.map((s) => s.series || null), [null, 'tide', 'moon', 'dust', 'birds', 'fish', null])
  assert.equal(stops[0].optionId, 'feitsui'); assert.equal(stops[1].optionId, 'hualien-tide'); assert.equal(stops[5].optionId, 'zengwen')
  assert.equal(stops[6].kind, 'apply')
})

test('buildTour：series 站的倍速讓整段序列（points × step）在 durationMs 內播完；apply 站倍速 1', () => {
  for (const gov of [mkGov(), real]) {
    for (const s of buildTour(gov, { now: NOW })) {
      if (s.kind === 'apply') { assert.equal(s.speed, 1); continue }
      assert.ok(s.speed >= MIN_SPEED && s.speed <= MAX_SPEED, `${s.id} speed ${s.speed}`)
      assert.ok(s.seqSec > 0)
      const playSec = s.seqSec / s.speed
      if (s.speed < MAX_SPEED) assert.ok(playSec <= s.durationMs / 1000 + 1e-9, `${s.id}: ${playSec}s > ${s.durationMs}ms`)
      if (s.speed > MIN_SPEED && s.speed < MAX_SPEED) assert.ok(playSec >= (s.durationMs / 1000) * 0.8, `${s.id}: 播太快 ${playSec}s`)
    }
  }
})

test('speedFor：整數倍速邊界、夾在 [MIN, MAX]、壞輸入回 1', () => {
  assert.equal(speedFor(26.4, 20000), 1.43)
  assert.equal(speedFor(45, 16000), 3.11)
  assert.equal(speedFor(1.4, 12000), MIN_SPEED)      // 稀疏資料：放慢到下限就好，其餘時間停在終點
  assert.equal(speedFor(1000, 10000), MAX_SPEED)
  for (const bad of [0, -3, NaN, undefined, null]) assert.equal(speedFor(bad, 10000), 1)
  assert.equal(speedFor(10, 0), 1)
  for (let seq = 3; seq <= 60; seq += 1.7) for (const ms of [8000, 12000, 20000]) {
    const v = speedFor(seq, ms)
    if (v > MIN_SPEED && v < MAX_SPEED) assert.ok(seq / v <= ms / 1000 && seq / v >= (ms / 1000) * 0.8, `${seq}/${ms}`)
  }
})

test('buildTour：真實 ocean.json → 結構完整、不丟錯、總長合理、optionId 都存在', () => {
  const stops = buildTour(real, { now: NOW })
  assert.ok(stops.length >= 4, `只有 ${stops.length} 站`)
  const ids = stops.map((s) => s.id)
  assert.deepEqual(ids, IDS7.filter((id) => ids.includes(id)), '順序固定：水庫 → 潮汐 → 月亮 → 揚塵 → 鳥 → 魚 → 測站')
  assert.equal(new Set(ids).size, ids.length)
  for (const s of stops) assert.ok(real.options.some((o) => o.id === s.optionId), s.id)
  const total = tourTotalMs(stops)
  assert.ok(total <= 120000 && total >= 60000, `總長 ${total}`)
  if (stops.length === 7) assert.ok(total >= 90000)
  for (const loc of ['zh', 'en']) for (const c of texts(stops, loc)) {
    assert.ok(c.title && c.body, `${loc} ${c.id} 字幕不可為空`)
    assert.doesNotMatch(c.title + c.body, BAD, `${loc} ${c.id}`)
  }
})

test('buildTour：缺資料（無揚塵 / 無月亮 / 無魚）→ 略過那幾站，其餘照常，不報錯', () => {
  const noDust = clone(real); delete noDust.dust; noDust.options = noDust.options.filter((o) => o.kind !== 'dust')
  assert.ok(!buildTour(noDust, { now: NOW }).some((s) => s.id === 'dust'))
  const noMoon = clone(real); delete noMoon.moon
  assert.ok(!buildTour(noMoon, { now: NOW }).some((s) => s.id === 'moon'))
  const noMoonOpt = clone(real); noMoonOpt.options = noMoonOpt.options.filter((o) => o.kind !== 'moon')
  assert.ok(!buildTour(noMoonOpt, { now: NOW }).some((s) => s.id === 'moon'))
  const noFish = clone(real); for (const o of noFish.options) delete o.fish
  assert.ok(!buildTour(noFish, { now: NOW }).some((s) => s.id === 'fish'))

  const g = mkGov(); delete g.dust; g.options = g.options.filter((o) => o.kind !== 'dust' && o.kind !== 'moon'); delete g.moon
  for (const o of g.options) delete o.fish
  const stops = buildTour(g, { now: NOW })
  assert.deepEqual(stops.map((s) => s.id), ['reservoir', 'tide', 'birds', 'stations'])
  for (const loc of ['zh', 'en']) for (const c of texts(stops, loc)) assert.doesNotMatch(c.title + c.body, BAD)
  assert.ok(tourTotalMs(stops) < tourTotalMs(buildTour(mkGov(), { now: NOW })))
})

test('buildTour：空 / 舊格式 / 壞資料 → 空陣列或略過壞的部分，絕不丟錯', () => {
  for (const g of [null, undefined, {}, { options: [] }, { params: { seaLevel: 0.5 } }, { options: [{ id: 'x' }] }, { options: 'nope' }, 42, 'gov']) assert.deepEqual(buildTour(g, { now: NOW }), [], JSON.stringify(g))
  const only = buildTour({ options: [{ id: 'x', name: '翡翠水庫', level: 50, params: { seaLevel: 0.5 } }] }, { now: NOW })
  assert.deepEqual(only.map((s) => s.id), ['reservoir'])
  assert.doesNotThrow(() => buildTour({
    options: [null, 5, 'x', { id: 'a', kind: 'tide', series: { points: 'oops' } }, { id: 'b', kind: 'dust' }, { id: 'c', kind: 'moon' }, { id: 'd', birds: { yearly: 'x' } }, { id: 'e', fish: { yearly: [{ y: 'a', s: 1 }] } }],
    dust: 5, moon: { days: 'x' }, stations: { list: 'x' },
  }, { now: NOW }))
  // 沒有任何水庫 → 沒有「今日水庫」站，但仍能導覽其他站（測站站借用第一個選項當基準）
  const g = mkGov(); g.options = g.options.filter((o) => o.kind); delete g.defaultOption
  const ids = buildTour(g, { now: NOW }).map((s) => s.id)
  assert.ok(!ids.includes('reservoir') && ids.includes('tide') && ids.includes('stations'))
})

test('buildTour：opts.skip 略過指定的站（AR 實景時不導覽看不到的月亮與星座）', () => {
  const ids = buildTour(mkGov(), { now: NOW, skip: ['stations', 'moon'] }).map((s) => s.id)
  assert.deepEqual(ids, ['reservoir', 'tide', 'dust', 'birds', 'fish'])
  assert.equal(buildTour(mkGov(), { now: NOW, skip: 'nope' }).length, 7)
})

test('buildTour：opts.scale 等比例縮放各站時間', () => {
  const a = tourTotalMs(buildTour(mkGov(), { now: NOW })), b = tourTotalMs(buildTour(mkGov(), { now: NOW, scale: 0.5 }))
  assert.ok(Math.abs(b - a / 2) <= 7)
  assert.equal(tourTotalMs(buildTour(mkGov(), { now: NOW, scale: -1 })), a)   // 壞倍率 → 用預設
  assert.equal(a, Object.values(TOUR_MS).reduce((s, v) => s + v, 0))
})

// =============================================================================================
// 字幕
// =============================================================================================
test('字幕：每一站 zh / en 都不含 undefined / NaN / null；en 不含中文；長度不超過手機兩行的預算', () => {
  const stops = buildTour(mkGov(), { now: NOW })
  for (const loc of ['zh', 'en']) for (const c of texts(stops, loc)) {
    const all = c.title + '|' + c.body
    assert.ok(c.title && c.body, `${loc} ${c.id}`)
    assert.doesNotMatch(all, BAD, `${loc} ${c.id}: ${all}`)
    assert.doesNotMatch(all, /\{\w+\}/, `${loc} ${c.id} 有沒填的 {placeholder}`)
    if (loc === 'en') assert.doesNotMatch(all, HAN, `en ${c.id} 含中文：${all}`)
    assert.ok(c.title.length <= 40, `${loc} ${c.id} 標題太長 ${c.title.length}`)
    assert.ok(c.body.length <= (loc === 'zh' ? 60 : 118), `${loc} ${c.id} 說明太長 ${c.body.length}：${c.body}`)
  }
  const zh = Object.fromEntries(texts(stops, 'zh').map((c) => [c.id, c]))
  const en = Object.fromEntries(texts(stops, 'en').map((c) => [c.id, c]))
  // 內容從資料算：水位 / 海水高度 / 潮差 / 農曆 / 月相 / 月出月沒 / 測站數
  assert.equal(zh.reservoir.title, '今日水庫 · 翡翠水庫'); assert.match(zh.reservoir.body, /水位 77\.3% → 海水高度 0\.77/)
  assert.equal(en.reservoir.title, "Today's reservoir · Feitsui Reservoir"); assert.match(en.reservoir.body, /Water level 77\.3% → sea level 0\.77/)
  assert.match(zh.tide.body, /小潮.*農曆八月初十.*上弦月/); assert.match(en.tide.body, /neap tide.*Lunar 8\/10.*first quarter/)
  assert.match(zh.tide.body, /120–180 cm|\d+–\d+ cm/)
  assert.match(zh.moon.body, /今日月出 12:51、月沒 —/); assert.match(en.moon.body, /moonrise 12:51, moonset —/)
  assert.match(zh.stations.body, /188 座.*（100）/); assert.match(en.stations.body, /188 river gauging stations.*\(100\)/)
})

test('字幕：水庫滿庫溢流 → 用溢流版本；潮汐沒有潮差名 → 另一種句型', () => {
  const g = mkGov(); g.options[0].params.seaLevel = 1; g.options[0].level = 100
  const [res] = buildTour(g, { now: NOW })
  assert.match(inLocale('zh', () => captionText(res.caption).body), /滿庫溢流/)
  assert.match(inLocale('en', () => captionText(res.caption).body), /overflowing/)
  const g2 = mkGov(); delete g2.options[2].series.range; delete g2.options[2].series.lunar; delete g2.options[2].series.lunarLabel
  const tide = buildTour(g2, { now: NOW }).find((s) => s.id === 'tide')
  for (const loc of ['zh', 'en']) { const c = inLocale(loc, () => captionText(tide.caption)); assert.doesNotMatch(c.body, BAD); assert.ok(c.body.length > 10) }
})

test('字幕：語系中途切換 → 同一份 caption 立刻換語言，切回中文與原本逐字相同', () => {
  const stops = buildTour(mkGov(), { now: NOW })
  const zh1 = stops.map((s) => captionText(s.caption))
  setLocale('en')
  const en = stops.map((s) => captionText(s.caption))
  setLocale('zh')
  const zh2 = stops.map((s) => captionText(s.caption))
  assert.deepEqual(zh1, zh2)
  en.forEach((c, i) => { assert.notEqual(c.title, zh1[i].title); assert.notEqual(c.body, zh1[i].body) })
})

test('字幕：captionText 對壞輸入回空字串、不丟錯', () => {
  for (const c of [null, undefined, {}, { key: 'nope' }, { key: 'tide' }, { key: 'birds', p: null }, { key: 'dust', p: { mode: 'static' } }, 'x', 5]) {
    let r; assert.doesNotThrow(() => { r = captionText(c) }); assert.equal(typeof r.title, 'string'); assert.equal(typeof r.body, 'string')
  }
})

test('空窗年：魚群 / 鳥群字幕點出「無調查」區間（來自 series.js 的 extra.gaps）；連續調查則不提', () => {
  const g = mkGov()
  const fish = buildTour(g, { now: NOW }).find((s) => s.id === 'fish')
  assert.deepEqual(fish.caption.p.gaps, [[2007, 2013]])
  assert.equal(fish.caption.p.a, 2004); assert.equal(fish.caption.p.b, 2015); assert.equal(fish.caption.p.k, 5)
  const zh = inLocale('zh', () => captionText(fish.caption)), en = inLocale('en', () => captionText(fish.caption))
  assert.match(zh.title, /曾文溪流域/); assert.match(zh.body, /2007–2013 無調查（內插）/)
  assert.match(en.title, /Zengwen River basin/); assert.match(en.body, /no survey 2007–2013 \(interpolated\)/)
  const birds = buildTour(g, { now: NOW }).find((s) => s.id === 'birds')
  assert.deepEqual(birds.caption.p.gaps, [[2006, 2014]])
  // 兩段空窗 → 都列出；單一年空窗 → 只寫一個年份
  const g2 = mkGov(); g2.options[1].fish.yearly = yearly([2004, 2006, 2007, 2010, 2011])
  const f2 = buildTour(g2, { now: NOW }).find((s) => s.id === 'fish')
  assert.deepEqual(f2.caption.p.gaps, [[2005, 2005], [2008, 2009]])
  assert.match(inLocale('zh', () => captionText(f2.caption).body), /2005、2008–2009 無調查/)
  assert.match(inLocale('en', () => captionText(f2.caption).body), /no survey 2005, 2008–2009/)
  const g3 = mkGov(); g3.options[1].fish.yearly = yearly([2004, 2005, 2006])
  const f3 = buildTour(g3, { now: NOW }).find((s) => s.id === 'fish')
  assert.deepEqual(f3.caption.p.gaps, [])
  assert.doesNotMatch(inLocale('zh', () => captionText(f3.caption).body), /無調查/)
  assert.doesNotMatch(inLocale('en', () => captionText(f3.caption).body), /no survey/)
})

test('揚塵：PM10 無效但風速有 ≥2 筆 → 播放（風速）；≥2 筆 PM10 → 播放（PM10）', () => {
  const g = mkGov()
  const wind = buildTour(g, { now: NOW }).find((s) => s.id === 'dust')
  assert.equal(wind.kind, 'series'); assert.equal(wind.series, 'dust'); assert.equal(wind.caption.p.metric, 'wind'); assert.equal(wind.caption.p.frozen, false)
  assert.match(inLocale('zh', () => captionText(wind.caption).body), /PM10 感測器回報無效，改看風速 3–6 m\/s/)
  assert.match(inLocale('en', () => captionText(wind.caption).body), /PM10 sensor invalid, so wind speed 3–6 m\/s/)
  const g2 = mkGov(); g2.dust.history = g2.dust.history.map((h, i) => ({ ...h, pm10: [20, 80, 45][i] }))
  const pm = buildTour(g2, { now: NOW }).find((s) => s.id === 'dust')
  assert.equal(pm.caption.p.metric, 'pm10'); assert.match(inLocale('zh', () => captionText(pm.caption).body), /PM10 20–80 μg\/m³/)
})

test('揚塵：歷史不足 → 只做靜態站 + 誠實的字幕（PM10 感測器無效、改看風速、歷史累積中）', () => {
  const g = mkGov(); g.dust.history = [g.dust.history[0]]        // 只有 1 筆有效
  const s = buildTour(g, { now: NOW }).find((x) => x.id === 'dust')
  assert.equal(s.kind, 'apply'); assert.equal(s.series, undefined); assert.equal(s.speed, 1)
  assert.equal(s.caption.p.mode, 'static'); assert.equal(s.caption.p.metric, 'wind'); assert.equal(s.caption.p.n, 1)
  const zh = inLocale('zh', () => captionText(s.caption)), en = inLocale('en', () => captionText(s.caption))
  assert.match(zh.body, /無效.*風速 5\.3 m\/s.*累積.*（1 筆有效）/); assert.match(en.body, /invalid.*wind speed 5\.3 m\/s.*collecting.*\(1 valid\)/)
  // 完全沒有歷史、PM10 有效 → PM10 靜態說明
  const g2 = mkGov(); g2.dust.history = []; g2.dust.stations[0].pm10 = 61
  const s2 = buildTour(g2, { now: NOW }).find((x) => x.id === 'dust')
  assert.equal(s2.kind, 'apply'); assert.equal(s2.caption.p.metric, 'pm10')
  assert.match(inLocale('zh', () => captionText(s2.caption).body), /PM10 61 μg\/m³.*累積.*（0 筆有效）/)
  // 連風速都沒有 → 誠實說沒有有效讀數
  const g3 = mkGov(); g3.dust.history = []; g3.dust.stations[0].wind = null
  const s3 = buildTour(g3, { now: NOW }).find((x) => x.id === 'dust')
  assert.equal(s3.caption.p.metric, 'none')
  assert.match(inLocale('zh', () => captionText(s3.caption).body), /沒有有效讀數/); assert.match(inLocale('en', () => captionText(s3.caption).body), /no valid readings/)
  for (const x of [s, s2, s3]) for (const loc of ['zh', 'en']) assert.doesNotMatch(inLocale(loc, () => { const c = captionText(x.caption); return c.title + c.body }), BAD)
})

test('揚塵：兩筆數值完全相同（來源疑似凍結）→ 照播，但字幕明講', () => {
  const g = mkGov(); g.dust.history = g.dust.history.slice(0, 2).map((h) => ({ ...h, wind: 5.34 }))
  const s = buildTour(g, { now: NOW }).find((x) => x.id === 'dust')
  assert.equal(s.kind, 'series'); assert.equal(s.caption.p.frozen, true)
  assert.match(inLocale('zh', () => captionText(s.caption).body), /來源疑似凍結/); assert.match(inLocale('en', () => captionText(s.caption).body), /source may be frozen/)
})

test('月亮：表內有今日 → 帶今日月出 / 月沒；不含今日 → 改寫表的天數', () => {
  const s = buildTour(mkGov(), { now: NOW }).find((x) => x.id === 'moon')
  assert.equal(s.caption.p.today, true)
  const late = buildTour(mkGov(), { now: new Date('2027-05-01T12:00:00+08:00') }).find((x) => x.id === 'moon')
  assert.equal(late.caption.p.today, false)
  assert.match(inLocale('zh', () => captionText(late.caption).body), /月出月沒表 4 天/); assert.match(inLocale('en', () => captionText(late.caption).body), /4-day moonrise & moonset table/)
  for (const loc of ['zh', 'en']) assert.doesNotMatch(inLocale(loc, () => { const c = captionText(late.caption); return c.title + c.body }), BAD)
})

// =============================================================================================
// 執行器（假 store）
// =============================================================================================
function harness({ gov = mkGov(), snapOption = 'zengwen', rec = {}, auto = false, remote = false } = {}) {
  const calls = []
  const clock = { t: 100000 }
  const act = { last: 50000 }
  const emitted = []
  let touches = 0, afterPlays = 0
  const S = {
    gov, govOptionId: snapOption, params: { ...PARAMS, seaLevel: 0.31, hue: 0.9, birdCount: 0.55 },
    rec: { mode: 'idle', speed: 2, loop: false, ...rec }, log: [],
  }
  const getOpt = (id) => gov.options.find((o) => o.id === id)
  const play = (name) => {
    if (S.rec.mode !== 'idle') return
    S.rec = { ...S.rec, mode: 'playing' }
    S.params = { ...S.params, fishCount: 0.11, birdCount: 0.99 }       // 模擬序列改了參數
    calls.push(['play', name, S.rec.speed])
  }
  const state = () => ({
    ...S,
    setGovOption: (id) => { S.govOptionId = id; const o = getOpt(id); if (o) S.params = { ...S.params, ...o.params }; calls.push(['setGovOption', id]) },
    applyParams: (p) => { S.params = { ...S.params, ...p }; calls.push(['applyParams']) },
    setRecSpeed: (v) => { S.rec = { ...S.rec, speed: v }; calls.push(['setRecSpeed', v]) },
    stopPlayback: () => { S.rec = { ...S.rec, mode: 'idle' }; calls.push(['stopPlayback']) },
    playGovSeries: () => play('tide'), playDust: () => play('dust'), playMoon: () => play('moon'), playSurvey: (k) => play(k),
    pushLog: (dir, text) => S.log.push(text),
    persistParams: () => calls.push(['persistParams']),
  })
  const store = { getState: state }
  const runner = createTourRunner({
    store, now: () => clock.t, getActivity: () => act.last, touch: () => { touches++; act.last = clock.t },
    emit: (p) => emitted.push(p), isRemote: () => remote, afterPlay: () => { afterPlays++ },
  })
  const step = (ms, dt = 100) => { for (let x = 0; x < ms; x += dt) { clock.t += dt; runner.tick(clock.t) } }
  const run = () => runner.start({ auto })
  return { S, calls, clock, act, emitted, runner, step, run, touches: () => touches, afterPlays: () => afterPlays, getOpt }
}

test('執行器：開始 → 套用第一站海況、字幕資料寫進 store、寫 OUT 日誌；導覽前狀態被記下', () => {
  const h = harness()
  assert.equal(h.run(), true)
  assert.equal(h.runner.isRunning(), true)
  assert.equal(h.S.govOptionId, 'feitsui'); assert.equal(h.S.params.seaLevel, 0.77)      // 第一站＝今日水庫（翡翠）的基準
  assert.deepEqual(h.calls[0], ['setGovOption', 'feitsui'])
  const e = h.emitted[h.emitted.length - 1]
  assert.equal(e.running, true); assert.equal(e.index, 0); assert.equal(e.total, 7); assert.equal(e.caption.key, 'reservoir'); assert.equal(e.stopMs, TOUR_MS.reservoir)
  assert.ok(h.S.log.some((l) => l.includes('資料導覽開始（7 站）')))
  assert.ok(h.S.log.some((l) => l.startsWith('導覽 1/7｜今日水庫')))
  assert.equal(h.runner.start({}), false); assert.equal(h.runner.lastFail, 'running')   // 已在導覽中，不可重複開始
})

test('執行器：依序巡演七站——每個 series 站先設倍速再播放、轉站前先 stopPlayback；播完一輪還原導覽前的參數 / 海況選項 / 倍速', () => {
  const h = harness()
  const before = { params: { ...h.S.params }, option: h.S.govOptionId, speed: h.S.rec.speed }
  h.run()
  const stops = buildTour(mkGov(), { now: NOW })
  h.step(tourTotalMs(stops) + 500)
  assert.equal(h.runner.isRunning(), false, '手動啟動的導覽播完一輪就結束')
  const plays = h.calls.filter((c) => c[0] === 'play')
  assert.deepEqual(plays.map((c) => c[1]), ['tide', 'moon', 'dust', 'birds', 'fish'])
  assert.deepEqual(plays.map((c) => c[2]), stops.filter((s) => s.kind === 'series').map((s) => s.speed), '播放時倍速已設好')
  const opts = h.calls.filter((c) => c[0] === 'setGovOption').map((c) => c[1])
  assert.deepEqual(opts.slice(0, 7), stops.map((s) => s.optionId))
  // 兩次 play 之間一定有 stopPlayback（轉站前先停掉上一站的播放）
  const seq = h.calls.filter((c) => c[0] === 'play' || c[0] === 'stopPlayback').map((c) => c[0])
  for (let i = 1; i < seq.length; i++) assert.ok(!(seq[i] === 'play' && seq[i - 1] === 'play'), '連續兩次 play 之間沒有 stopPlayback')
  // 還原
  assert.deepEqual(h.S.params, before.params); assert.equal(h.S.govOptionId, before.option); assert.equal(h.S.rec.speed, before.speed)
  assert.equal(h.S.rec.mode, 'idle')
  assert.ok(h.calls.some((c) => c[0] === 'persistParams'))
  const last = h.emitted[h.emitted.length - 1]
  assert.equal(last.running, false); assert.equal(last.caption, null)
  assert.ok(h.S.log.some((l) => l.includes('資料導覽結束')))
  assert.ok(h.touches() >= 2, '開始與結束都重置閒置計時')
  assert.equal(h.afterPlays(), 5, '每個 series 站開始播放後呼叫一次（外層把「演出次數」扣回去）')
})

test('執行器：每一站字幕都依序寫進 store（index / total / seq 遞增）', () => {
  const h = harness()
  h.run(); h.step(120000)
  const running = h.emitted.filter((e) => e.running)
  assert.deepEqual(running.map((e) => e.caption.key), IDS7)
  assert.deepEqual(running.map((e) => e.index), [0, 1, 2, 3, 4, 5, 6])
  assert.deepEqual(running.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7])
  assert.ok(running.every((e) => e.total === 7 && e.stopMs > 0))
})

test('執行器：series 站播完後（rec 回 idle）不會被當成中斷，停在終點直到本站時間到', () => {
  const h = harness()
  h.run()
  h.step(TOUR_MS.reservoir + 500)                          // 進入潮汐站（series）
  assert.equal(h.S.rec.mode, 'playing')
  h.S.rec = { ...h.S.rec, mode: 'idle' }                   // 序列自然播完
  h.step(2000)
  assert.equal(h.runner.isRunning(), true)
  assert.equal(h.runner.current().stop.id, 'tide')
})

test('執行器：任何真實輸入（activity 變新）→ 立即中止並還原（同時停掉播放）', () => {
  const h = harness()
  const before = { params: { ...h.S.params }, option: h.S.govOptionId, speed: h.S.rec.speed }
  h.run(); h.step(TOUR_MS.reservoir + 3000)                // 潮汐站播放中
  assert.equal(h.S.rec.mode, 'playing'); assert.notEqual(h.S.govOptionId, before.option)
  h.clock.t += 50; h.act.last = h.clock.t                  // 使用者轉了旋鈕
  h.runner.tick(h.clock.t)
  assert.equal(h.runner.isRunning(), false)
  assert.equal(h.S.rec.mode, 'idle'); assert.ok(h.calls.some((c) => c[0] === 'stopPlayback'))
  assert.deepEqual(h.S.params, before.params); assert.equal(h.S.govOptionId, before.option); assert.equal(h.S.rec.speed, before.speed)
  assert.ok(h.S.log.some((l) => l.includes('資料導覽中止，已還原原本的海')))
  assert.equal(h.emitted[h.emitted.length - 1].running, false)
})

test('執行器：使用者按「錄製」→ 中止；不還原（以使用者的操作為準），也不動錄製狀態', () => {
  const h = harness()
  h.run(); h.step(3000)                                    // 水庫站（apply）
  const paramsNow = { ...h.S.params }
  h.S.rec = { ...h.S.rec, mode: 'recording' }
  h.step(200)
  assert.equal(h.runner.isRunning(), false)
  assert.equal(h.S.rec.mode, 'recording', '不可動到使用者的錄製')
  assert.deepEqual(h.S.params, paramsNow)
  assert.equal(h.S.govOptionId, 'feitsui')
  assert.ok(!h.calls.some((c) => c[0] === 'stopPlayback'))
  assert.ok(h.S.log.some((l) => l.includes('改由你接手')))
})

test('執行器：使用者自己按了播放（不是我們的序列）→ 中止且不還原；播放中的序列被換掉海況選項 → 同樣讓出', () => {
  const h = harness()
  h.run(); h.step(3000)
  h.S.rec = { ...h.S.rec, mode: 'playing' }                // 水庫站是 apply，這個播放不是我們的
  h.step(200)
  assert.equal(h.runner.isRunning(), false); assert.equal(h.S.rec.mode, 'playing'); assert.ok(!h.calls.some((c) => c[0] === 'stopPlayback'))
  const h2 = harness()
  h2.run(); h2.step(3000)
  h2.S.govOptionId = 'nanhua'
  h2.step(200)
  assert.equal(h2.runner.isRunning(), false); assert.equal(h2.S.govOptionId, 'nanhua', '不把使用者選的海況改回去')
})

test('執行器：stop 可重複呼叫；手動 stop 也會還原', () => {
  const h = harness()
  const before = { params: { ...h.S.params }, option: h.S.govOptionId }
  h.run(); h.step(15000)
  assert.equal(h.runner.stop('user'), true)
  assert.equal(h.runner.stop('user'), false)
  assert.deepEqual(h.S.params, before.params); assert.equal(h.S.govOptionId, before.option)
  h.runner.tick(h.clock.t + 1000)                          // 沒在跑時 tick 是 no-op
  assert.equal(h.runner.isRunning(), false)
})

test('執行器：閒置自動啟動（auto）→ 無限循環、不在輪與輪之間還原；有人動時還原成「最初」的狀態', () => {
  const h = harness({ auto: true })
  const before = { params: { ...h.S.params }, option: h.S.govOptionId, speed: h.S.rec.speed }
  h.run()
  const total = tourTotalMs(buildTour(mkGov(), { now: NOW }))
  h.step(total * 2 + 5000)
  assert.equal(h.runner.isRunning(), true)
  assert.equal(h.runner.current().auto, true)
  const starts = h.emitted.filter((e) => e.running && e.index === 0).length
  assert.ok(starts >= 3, `第 ${starts} 輪`)
  assert.ok(!h.S.log.some((l) => l.includes('資料導覽結束')))
  h.clock.t += 10; h.act.last = h.clock.t; h.runner.tick(h.clock.t)
  assert.equal(h.runner.isRunning(), false)
  assert.deepEqual(h.S.params, before.params); assert.equal(h.S.govOptionId, before.option); assert.equal(h.S.rec.speed, before.speed)
})

test('執行器：不能開始的情況（沒資料 / 建不出站 / 錄製播放中 / 觀眾視窗）→ 回 false 並說明原因，什麼都不動', () => {
  const noGov = harness({ gov: null }); assert.equal(noGov.run(), false); assert.equal(noGov.runner.lastFail, 'nogov')
  const empty = harness({ gov: { options: [] } }); assert.equal(empty.run(), false); assert.equal(empty.runner.lastFail, 'empty'); assert.deepEqual(empty.calls, [])
  const busy = harness({ rec: { mode: 'recording' } }); assert.equal(busy.run(), false); assert.equal(busy.runner.lastFail, 'busy'); assert.deepEqual(busy.calls, [])
  const busy2 = harness({ rec: { mode: 'playing' } }); assert.equal(busy2.run(), false); assert.equal(busy2.runner.lastFail, 'busy')
  const remote = harness({ remote: true }); assert.equal(remote.run(), false); assert.equal(remote.runner.lastFail, 'remote'); assert.deepEqual(remote.calls, [])
  assert.equal(noGov.runner.isRunning() || empty.runner.isRunning() || busy.runner.isRunning() || remote.runner.isRunning(), false)
})

test('執行器：缺資料的 gov 也能完整巡演一輪並還原（只有存在的站）', () => {
  const g = mkGov(); delete g.dust; g.options = g.options.filter((o) => o.kind !== 'dust'); for (const o of g.options) delete o.fish
  const h = harness({ gov: g })
  const before = { params: { ...h.S.params }, option: h.S.govOptionId }
  assert.equal(h.run(), true)
  h.step(tourTotalMs(buildTour(g, { now: NOW })) + 500)
  assert.equal(h.runner.isRunning(), false)
  assert.deepEqual(h.S.params, before.params); assert.equal(h.S.govOptionId, before.option)
  assert.deepEqual(h.calls.filter((c) => c[0] === 'play').map((c) => c[1]), ['tide', 'moon', 'birds'])
})

test('執行器：序列沒播起來（play* 什麼都沒做）→ 當成靜態站，字幕照常，不報錯也不誤判成外部播放', () => {
  const gov = mkGov()
  const S = { gov, govOptionId: 'zengwen', params: { ...PARAMS }, rec: { mode: 'idle', speed: 1 }, log: [] }
  const noop = () => {}
  const store = { getState: () => ({ ...S, setGovOption: (id) => { S.govOptionId = id }, applyParams: (p) => { S.params = { ...S.params, ...p } }, setRecSpeed: (v) => { S.rec = { ...S.rec, speed: v } }, stopPlayback: noop, playGovSeries: noop, playDust: noop, playMoon: noop, playSurvey: noop, pushLog: noop }) }
  let t0 = 1000
  const r = createTourRunner({ store, now: () => t0, getActivity: () => 0, emit: noop })
  assert.equal(r.start({}), true)
  for (let i = 0; i < 1300; i++) { t0 += 100; r.tick(t0) }        // 130 秒
  assert.equal(r.isRunning(), false)                               // 一輪跑完正常結束
  assert.equal(S.govOptionId, 'zengwen')                           // 一輪跑完後還原成導覽前的選項
})

// =============================================================================================
// 偏好 / 鏡像
// =============================================================================================
test('resolveAutoIdle：?tour=0/1 > ?kiosk（預設開）> 使用者偏好 > 預設', () => {
  assert.equal(resolveAutoIdle({}), true)                                          // 預設沿用舊吸引模式：閒置就動
  assert.equal(resolveAutoIdle({ saved: false }), false)
  assert.equal(resolveAutoIdle({ saved: true }), true)
  assert.equal(resolveAutoIdle({ saved: false, search: '?kiosk=1' }), true)         // 展場一律開
  assert.equal(resolveAutoIdle({ saved: true, search: '?kiosk=1&tour=0' }), false)
  assert.equal(resolveAutoIdle({ saved: false, search: '?tour=1' }), true)
  assert.equal(resolveAutoIdle({ saved: true, search: '?tour=off' }), false)
  assert.equal(resolveAutoIdle({ saved: 'yes', search: '?x=1' }), true)             // 壞的偏好值 → 預設
})

test('isAudienceSearch：辨識觀眾視窗網址', () => {
  for (const q of ['?audience=1', '?audience', '?view=audience', '?mode=Audience', '?role=viewer', '?a=1&view=spectator']) assert.equal(isAudienceSearch(q), true, q)
  for (const q of ['', '?kiosk=1', '?view=main', '?s=abc', undefined, null]) assert.equal(isAudienceSearch(q), false, String(q))
})

test('鏡像：tour 切片已註冊；get 可 JSON 序列化；apply 只更新字幕 store 並標為 remote（不跑導覽）；subscribe 只在鏡像欄位改變時通知', () => {
  const m = getMirror('tour')
  assert.ok(m && typeof m.get === 'function' && typeof m.apply === 'function' && typeof m.subscribe === 'function')
  useTourStore.setState({ running: false, caption: null, index: 0, total: 0, stopMs: 0, seq: 0, remote: false, autoIdle: true })
  let n = 0
  const off = m.subscribe(() => { n++ })
  useTourStore.setState({ autoIdle: false })                                        // 偏好不鏡像
  assert.equal(n, 0)
  const cap = { key: 'reservoir', p: { name: '翡翠水庫', level: 77.3, sea: 0.77 } }
  useTourStore.setState({ running: true, caption: cap, index: 2, total: 7, stopMs: 11000, seq: 3 })
  assert.equal(n, 1)
  const v = JSON.parse(JSON.stringify(m.get()))
  assert.deepEqual(v, { running: true, caption: cap, index: 2, total: 7, stopMs: 11000, seq: 3 })
  // 觀眾視窗：apply
  useTourStore.setState({ running: false, caption: null, seq: 0 })
  n = 0
  m.apply({ running: true, caption: cap, index: 4, total: 7, stopMs: 9000, seq: 12 })
  const s = useTourStore.getState()
  assert.equal(s.remote, true); assert.equal(s.running, true); assert.deepEqual(s.caption, cap); assert.equal(s.index, 4); assert.equal(s.seq, 12)
  assert.equal(n, 0, 'apply 造成的變化不能再被送回去')
  useTourStore.setState({ seq: 13 }); assert.equal(n, 0)
  // 壞訊息不炸
  assert.doesNotThrow(() => { m.apply(null); m.apply('x'); m.apply({ caption: 5, index: 'a' }) })
  assert.equal(useTourStore.getState().caption, null)
  off()
  // remote（觀眾視窗）不能啟動導覽
  const h = harness({ remote: useTourStore.getState().remote })
  assert.equal(h.run(), false)
  useTourStore.setState({ remote: false })
})
