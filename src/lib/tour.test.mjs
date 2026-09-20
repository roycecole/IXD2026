// 資料導覽（lib/tour.js）的單元測試。執行：node --test src/lib/tour.test.mjs
// 涵蓋：buildTour（真實 ocean.json / 缺資料 / 空資料 / 壞資料；8 站含空氣品質）、倍速、字幕（zh / en 都不含 undefined / NaN、en 不含中文、語系切換）、
// 空窗年、揚塵誠實說明、空氣品質站（模型資料、非政府觀測；範圍與「越高…」以 automationFor 的真實對應為準）、
// 執行器（用假 store 測：換站、還原、各種中斷、循環）、導覽員控制（goto / next / prev / pause / resume、start 的 at / hold、暫停中的計時與序列凍結、暫停中被輸入中止）、
// 字幕旁白（假 narrator，方法都檢查 this）、偏好（setAutoIdle / setSpeak 互不洗掉）與鏡像（含 paused）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadEnDict, HAN } from '../../scripts/i18n-check.mjs'
import { registerEn, setLocale, getLocale } from '../i18n/index.js'
import { getMirror } from './mirror.js'
import { LS, loadLS } from './persist.js'
import { automationFor, seriesFromAir } from './series.js'
import { speechText } from './narration.js'
import { TOUR_STOP_IDS } from './tourLink.js'
import { makeNarrator, withStorage } from './tourTestEnv.mjs'
import {
  buildTour, captionText, speedFor, tourTotalMs, createTourRunner, useTourStore, resolveAutoIdle, resolveSpeak, isAudienceSearch, resolveStopIndex,
  setAutoIdle, setSpeak, supportsNarration,
  MIN_SPEED, MAX_SPEED, TOUR_MS, PAUSE_SPEED, NARRATION_MAX_WAIT_MS, SPEAK_DEFAULT,
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

// ---- 合成資料：八站齊全、內容確定（不依賴 CI 每天更新的 ocean.json）----
const PARAMS = { seaLevel: 0.77, current: 0.06, flowX: 0.84, flowY: 0.29, clarity: 0.77, glow: 0.8, hue: 0.5, jellyCount: 0.72, fishCount: 0.64, trashCount: 0.14, swimSpeed: 0.42, spin: 0.28, zoom: 0.5 }
const yearly = (ys) => ys.map((y, i) => ({ y, s: 30 + i * 9, n: 100 + i }))
function mkGov() {
  const tidePts = Array.from({ length: 24 }, (_, h) => ({ h, v: Math.round(150 + 30 * Math.sin((h / 24) * Math.PI * 2)) }))
  const days = ['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22'].map((d, i) => [d, '12:5' + i, 121, '18:1' + i, 38 + i, 'S', i === 1 ? '' : '23:2' + i, 240])
  const hist = (rows) => rows.map(([t, pm10, wind]) => ({ t, pm10, wind, temp: 30, rh: 70 }))
  // 空氣品質（Open-Meteo / CAMS 模型資料）：24 個逐時點，PM2.5 由 12 升到 46.5（四捨五入後 12–47 → 整數 lo=12、hi=47）
  const airHist = Array.from({ length: 24 }, (_, h) => ({ t: `2026-09-20T${two(h)}:00:00+08:00`, pm10: 30 + h, pm25: 12 + h * 1.5, dust: 0, aqi: 50 }))
  return {
    defaultOption: 'feitsui',
    weather: { airTemp: 29, humidity: 80, windSpeed: 1, windDir: 90, precip: 0, weather: '晴' },
    options: [
      { id: 'feitsui', name: '翡翠水庫', level: 77.3, params: { ...PARAMS }, birds: { basin: '淡水河流域', species: 122, monthly: [], yearly: yearly([2005, 2015, 2016, 2017]) }, fish: { basin: '淡水河流域', species: 113, monthly: [], yearly: yearly([2005, 2015, 2016, 2017]) } },
      { id: 'zengwen', name: '曾文水庫', level: 100, params: { ...PARAMS, seaLevel: 1 }, fish: { basin: '曾文溪流域', species: 112, monthly: [], yearly: yearly([2004, 2005, 2006, 2014, 2015]) } },
      { id: 'hualien-tide', name: '花蓮外海', kind: 'tide', level: 68, params: { ...PARAMS, seaLevel: 0.86 }, series: { label: '潮位', unit: 'cm', date: '2026-09-20', target: 'seaLevel', lunar: '2026-08-10', lunarLabel: '農曆八月初十', range: '小', points: tidePts, events: [] } },
      { id: 'dust-yunlin', name: '揚塵 · 雲林縣', kind: 'dust', level: 0, params: { ...PARAMS, clarity: 0.6 } },
      { id: 'moon-hualien', name: '月亮 · 花蓮', kind: 'moon', level: 0, params: { ...PARAMS } },
      { id: 'air-yunlin', name: '空氣品質 · 雲林', kind: 'air', level: 24, params: { ...PARAMS, clarity: 0.75, trashCount: 0.2 } },
    ],
    air: { county: '雲林縣', place: '麥寮', history: airHist },
    dust: { county: '雲林縣', stations: [{ id: 'a', name: 'A', pm10: null, wind: 5.3, temp: 30, rh: 70, t: '2026-09-20T10:00:00+08:00' }], history: hist([['2026-09-20T07:00:00+08:00', null, 3], ['2026-09-20T10:00:00+08:00', null, 6], ['2026-09-20T13:00:00+08:00', null, 4]]) },
    moon: { county: '花蓮縣', from: '2026-09-19', to: '2026-09-22', days },
    stations: { total: 188, active: 100, list: [{ n: '景美', r: '景美溪', x: 0.1, y: 0.4, a: 114.9, s: 1 }, { n: '思源橋', r: '北勢溪', x: 0.2, y: 0.4, a: 0.7, s: 0 }] },
  }
}
const IDS8 = ['reservoir', 'tide', 'moon', 'dust', 'air', 'birds', 'fish', 'stations']
const two = (n) => String(n).padStart(2, '0')

// =============================================================================================
// buildTour
// =============================================================================================
test('buildTour：合成資料 → 八站依序（含空氣品質）、每站欄位齊全、整個導覽 90~120 秒（約 111 秒）', () => {
  const gov = mkGov()
  const stops = buildTour(gov, { now: NOW })
  assert.deepEqual(stops.map((s) => s.id), IDS8)
  for (const s of stops) {
    assert.ok(gov.options.some((o) => o.id === s.optionId), `${s.id} 的 optionId 必須存在`)
    assert.ok(s.kind === 'apply' || s.kind === 'series')
    assert.ok(s.durationMs > 0 && Number.isFinite(s.speed))
    assert.ok(s.caption && typeof s.caption.key === 'string' && s.caption.p && typeof s.caption.p === 'object')
    JSON.parse(JSON.stringify(s.caption))     // 字幕資料必須是純 JSON（鏡像到觀眾視窗）
  }
  const total = tourTotalMs(stops)
  assert.ok(total >= 90000 && total <= 120000, `總長 ${total}`)
  assert.equal(total, 111000, '八站合計 111 秒')
  assert.deepEqual(stops.map((s) => s.series || null), [null, 'tide', 'moon', 'dust', 'air', 'birds', 'fish', null])
  assert.equal(stops[0].optionId, 'feitsui'); assert.equal(stops[1].optionId, 'hualien-tide'); assert.equal(stops[4].optionId, 'air-yunlin'); assert.equal(stops[6].optionId, 'zengwen')
  assert.equal(stops[7].kind, 'apply')
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
  assert.deepEqual(ids, IDS8.filter((id) => ids.includes(id)), '順序固定：水庫 → 潮汐 → 月亮 → 揚塵 → 空氣品質 → 鳥 → 魚 → 測站')
  assert.equal(new Set(ids).size, ids.length)
  for (const s of stops) assert.ok(real.options.some((o) => o.id === s.optionId), s.id)
  const total = tourTotalMs(stops)
  assert.ok(total <= 120000 && total >= 60000, `總長 ${total}`)
  if (stops.length === 8) assert.ok(total >= 90000)
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

  const noAir = clone(real); delete noAir.air
  assert.ok(!buildTour(noAir, { now: NOW }).some((s) => s.id === 'air'))
  const g = mkGov(); delete g.dust; g.options = g.options.filter((o) => o.kind !== 'dust' && o.kind !== 'moon'); delete g.moon
  for (const o of g.options) delete o.fish
  const stops = buildTour(g, { now: NOW })
  assert.deepEqual(stops.map((s) => s.id), ['reservoir', 'tide', 'air', 'birds', 'stations'])
  delete g.air
  assert.deepEqual(buildTour(g, { now: NOW }).map((s) => s.id), ['reservoir', 'tide', 'birds', 'stations'], '沒有空氣品質資料 → 只少那一站')
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
  assert.deepEqual(ids, ['reservoir', 'tide', 'dust', 'air', 'birds', 'fish'], 'AR 實景略過的站不變：moon、stations')
  assert.equal(buildTour(mkGov(), { now: NOW, skip: 'nope' }).length, 8)
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
function harness({ gov = mkGov(), snapOption = 'zengwen', rec = {}, auto = false, remote = false, narrator = null, extra = {} } = {}) {
  const calls = []
  const flags = { remote }                                                // 可在測試中途改（收到第一個 mirror 訊息時觀眾視窗才被標成 remote）
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
    playGovSeries: () => play('tide'), playDust: () => play('dust'), playAir: () => play('air'), playMoon: () => play('moon'), playSurvey: (k) => play(k),
    pushLog: (dir, text) => S.log.push(text),
    persistParams: () => calls.push(['persistParams']),
  })
  const store = { getState: state }
  const runner = createTourRunner({
    store, now: () => clock.t, getActivity: () => act.last, touch: () => { touches++; act.last = clock.t },
    emit: (p) => emitted.push(p), isRemote: () => flags.remote, afterPlay: () => { afterPlays++ },
    ...(narrator ? { narrator } : {}), ...extra,
  })
  const step = (ms, dt = 100) => { for (let x = 0; x < ms; x += dt) { clock.t += dt; runner.tick(clock.t) } }
  const run = (o = {}) => runner.start({ auto, ...o })
  return { S, calls, clock, act, emitted, runner, step, run, flags, touches: () => touches, afterPlays: () => afterPlays, getOpt }
}

test('執行器：開始 → 套用第一站海況、字幕資料寫進 store、寫 OUT 日誌；導覽前狀態被記下', () => {
  const h = harness()
  assert.equal(h.run(), true)
  assert.equal(h.runner.isRunning(), true)
  assert.equal(h.S.govOptionId, 'feitsui'); assert.equal(h.S.params.seaLevel, 0.77)      // 第一站＝今日水庫（翡翠）的基準
  assert.deepEqual(h.calls[0], ['setGovOption', 'feitsui'])
  const e = h.emitted[h.emitted.length - 1]
  assert.equal(e.running, true); assert.equal(e.index, 0); assert.equal(e.total, 8); assert.equal(e.caption.key, 'reservoir'); assert.equal(e.stopMs, TOUR_MS.reservoir); assert.equal(e.paused, false)
  assert.ok(h.S.log.some((l) => l.includes('資料導覽開始（8 站）')))
  assert.ok(h.S.log.some((l) => l.startsWith('導覽 1/8｜今日水庫')))
  assert.equal(h.runner.start({}), false); assert.equal(h.runner.lastFail, 'running')   // 已在導覽中，不可重複開始
})

test('執行器：依序巡演八站——每個 series 站先設倍速再播放、轉站前先 stopPlayback；播完一輪還原導覽前的參數 / 海況選項 / 倍速', () => {
  const h = harness()
  const before = { params: { ...h.S.params }, option: h.S.govOptionId, speed: h.S.rec.speed }
  h.run()
  const stops = buildTour(mkGov(), { now: NOW })
  h.step(tourTotalMs(stops) + 500)
  assert.equal(h.runner.isRunning(), false, '手動啟動的導覽播完一輪就結束')
  const plays = h.calls.filter((c) => c[0] === 'play')
  assert.deepEqual(plays.map((c) => c[1]), ['tide', 'moon', 'dust', 'air', 'birds', 'fish'])
  assert.deepEqual(plays.map((c) => c[2]), stops.filter((s) => s.kind === 'series').map((s) => s.speed), '播放時倍速已設好')
  const opts = h.calls.filter((c) => c[0] === 'setGovOption').map((c) => c[1])
  assert.deepEqual(opts.slice(0, 8), stops.map((s) => s.optionId))
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
  assert.equal(h.afterPlays(), 6, '每個 series 站開始播放後呼叫一次（外層把「演出次數」扣回去）')
})

test('執行器：每一站字幕都依序寫進 store（index / total / seq 遞增；每一站都帶 paused: false）', () => {
  const h = harness()
  h.run(); h.step(120000)
  const running = h.emitted.filter((e) => e.running)
  assert.deepEqual(running.map((e) => e.caption.key), IDS8)
  assert.deepEqual(running.map((e) => e.index), [0, 1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual(running.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.ok(running.every((e) => e.total === 8 && e.stopMs > 0 && e.paused === false))
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
  assert.deepEqual(h.calls.filter((c) => c[0] === 'play').map((c) => c[1]), ['tide', 'moon', 'air', 'birds'])
})

test('執行器：序列沒播起來（play* 什麼都沒做）→ 當成靜態站，字幕照常，不報錯也不誤判成外部播放', () => {
  const gov = mkGov()
  const S = { gov, govOptionId: 'zengwen', params: { ...PARAMS }, rec: { mode: 'idle', speed: 1 }, log: [] }
  const noop = () => {}
  const store = { getState: () => ({ ...S, setGovOption: (id) => { S.govOptionId = id }, applyParams: (p) => { S.params = { ...S.params, ...p } }, setRecSpeed: (v) => { S.rec = { ...S.rec, speed: v } }, stopPlayback: noop, playGovSeries: noop, playDust: noop, playAir: noop, playMoon: noop, playSurvey: noop, pushLog: noop }) }
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
  useTourStore.setState({ running: false, caption: null, index: 0, total: 0, stopMs: 0, seq: 0, paused: false, remote: false, autoIdle: true, speak: false, stopList: [] })
  let n = 0
  const off = m.subscribe(() => { n++ })
  useTourStore.setState({ autoIdle: false })                                        // 偏好不鏡像
  useTourStore.setState({ speak: true })                                            // 旁白偏好不鏡像（旁白只在主視窗出聲）
  useTourStore.setState({ stopList: [{ id: 'air', caption: { key: 'air', p: {} } }] })   // 站清單不鏡像
  assert.equal(n, 0)
  const cap = { key: 'reservoir', p: { name: '翡翠水庫', level: 77.3, sea: 0.77 } }
  useTourStore.setState({ running: true, caption: cap, index: 2, total: 8, stopMs: 11000, seq: 3 })
  assert.equal(n, 1)
  useTourStore.setState({ paused: true })                                           // 暫停會鏡像（觀眾視窗字幕顯示「已暫停」、進度條停住）
  assert.equal(n, 2)
  const v = JSON.parse(JSON.stringify(m.get()))
  assert.deepEqual(v, { running: true, caption: cap, index: 2, total: 8, stopMs: 11000, seq: 3, paused: true })
  // 觀眾視窗：apply
  useTourStore.setState({ running: false, caption: null, seq: 0, paused: false, speak: false })
  n = 0
  m.apply({ running: true, caption: cap, index: 4, total: 8, stopMs: 9000, seq: 12, paused: true })
  const s = useTourStore.getState()
  assert.equal(s.remote, true); assert.equal(s.running, true); assert.deepEqual(s.caption, cap); assert.equal(s.index, 4); assert.equal(s.seq, 12); assert.equal(s.paused, true, '觀眾視窗收到 paused')
  m.apply({ running: true, caption: cap, index: 4, total: 8, stopMs: 9000, seq: 12 })
  assert.equal(useTourStore.getState().paused, false, '沒帶 paused 的舊訊息 → 當作沒暫停')
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

// =============================================================================================
// 空氣品質站（Open-Meteo / CAMS 模型資料，不是政府觀測）
// =============================================================================================
const airStopOf = (g) => buildTour(g, { now: NOW }).find((s) => s.id === 'air')
const cap = (stop, loc) => inLocale(loc, () => captionText(stop.caption))

test('空氣品質站：放在揚塵之後、鳥群之前；series 站（playAir）、選項用 kind === air 的那個、倍速讓序列在時間內播完；站 id 與 tourLink 白名單一致', () => {
  const stops = buildTour(mkGov(), { now: NOW })
  const i = stops.findIndex((s) => s.id === 'air')
  assert.ok(i > 0); assert.equal(stops[i - 1].id, 'dust'); assert.equal(stops[i + 1].id, 'birds')
  const a = stops[i]
  assert.equal(a.kind, 'series'); assert.equal(a.series, 'air'); assert.equal(a.optionId, 'air-yunlin')
  assert.equal(a.durationMs, TOUR_MS.air); assert.equal(TOUR_MS.air, 12000)
  assert.equal(a.seqSec, 4.8, '24 點 × 0.2 秒（seriesFromAir 的 step）')
  assert.ok(a.speed >= MIN_SPEED && a.speed <= MAX_SPEED); assert.ok(a.seqSec / a.speed <= a.durationMs / 1000 + 1e-9)
  assert.deepEqual(a.caption.p, { name: '空氣品質 · 雲林', lo: 12, hi: 47, n: 24, flat: false })
  JSON.parse(JSON.stringify(a.caption))                                            // 純 JSON（鏡像到觀眾視窗）
  assert.deepEqual(stops.map((s) => s.id), TOUR_STOP_IDS, '導覽的站順序 = 連結白名單的順序')
})

test('空氣品質站：真實 ocean.json（有 air 且 ≥2 個有效 PM2.5 時）→ 在揚塵之後、鳥群之前，倍速合理', () => {
  const spec = seriesFromAir(real.air)
  const ids = buildTour(real, { now: NOW }).map((s) => s.id)
  if (!spec || !real.options.some((o) => o.kind === 'air')) { assert.ok(!ids.includes('air')); return }
  assert.ok(ids.includes('air'))
  const at = ids.indexOf('air')
  assert.ok(ids.indexOf('dust') < at && at < ids.indexOf('birds'))
  const a = buildTour(real, { now: NOW }).find((s) => s.id === 'air')
  assert.ok(a.speed >= MIN_SPEED && a.speed <= MAX_SPEED)
  assert.equal(a.caption.p.n, spec.points.length)
  assert.ok(a.caption.p.lo <= a.caption.p.hi)
})

test('空氣品質站字幕誠實：標明「模型資料」「非政府觀測」與來源（Open-Meteo / CAMS）、PM2.5 範圍；中英文都有、都不含 undefined / 沒填的 {placeholder}；en 不含中文', () => {
  const a = airStopOf(mkGov())
  const zh = cap(a, 'zh'), en = cap(a, 'en')
  assert.match(zh.title, /^空氣品質 · 雲林 · 模型資料$/)
  assert.match(zh.body, /模型/); assert.match(zh.body, /非政府觀測/); assert.match(zh.body, /Open-Meteo \/ CAMS/)
  assert.match(zh.body, /PM2\.5 12–47 μg\/m³/); assert.match(zh.body, /越高，海水越混濁、垃圾越多/)
  assert.equal(en.title, 'Air quality · Yunlin · model data')
  assert.match(en.body, /not government observations/); assert.match(en.body, /Open-Meteo \/ CAMS model/)
  assert.match(en.body, /PM2\.5 12–47 μg\/m³/); assert.match(en.body, /higher PM2\.5, murkier sea and more trash/)
  for (const c of [zh, en]) { assert.doesNotMatch(c.title + c.body, BAD); assert.doesNotMatch(c.title + c.body, /\{\w+\}/) }
  assert.doesNotMatch(en.title + en.body, HAN)
  assert.ok(zh.body.length <= 62 && en.body.length <= 118, `${zh.body.length} / ${en.body.length}`)
  for (const c of [zh, en]) assert.doesNotMatch(c.body, /(?<!非)政府(公布|測站|資料)|\bofficial\b/i, '不可說成政府資料 / 官方')
})

test('空氣品質站字幕的「越高，海水越混濁、垃圾越多」與 automationFor(air) 的真實對應一致：PM2.5 最高的那一步清澈度比最低的低、垃圾比最低的多', () => {
  const spec = seriesFromAir(mkGov().air)
  const vs = spec.points.map((p) => p.v)
  const lo = vs.indexOf(Math.min(...vs)), hi = vs.indexOf(Math.max(...vs))
  const at = (i) => Object.fromEntries(automationFor(spec, i))
  assert.ok(at(hi).clarity < at(lo).clarity, '越高 → 越混濁（海水清澈度降低）')
  assert.ok(at(hi).trashCount > at(lo).trashCount, '越高 → 垃圾越多')
  assert.equal(spec.extra.model, true, 'series.js 標為模型資料')
})

test('空氣品質站字幕：範圍收斂成同一個整數 → flat 句型（單一數值、不出現「12–12」）', () => {
  const g = mkGov(); g.air.history = g.air.history.map((h) => ({ ...h, pm25: 30.2 }))
  const a = airStopOf(g)
  assert.equal(a.caption.p.flat, true); assert.equal(a.caption.p.lo, 30); assert.equal(a.caption.p.hi, 30)
  const zh = cap(a, 'zh'), en = cap(a, 'en')
  assert.match(zh.body, /PM2\.5 約 30 μg\/m³/); assert.match(zh.body, /非政府觀測/); assert.match(zh.body, /變化很小/); assert.doesNotMatch(zh.body, /30–30/)
  assert.match(en.body, /PM2\.5 about 30 μg\/m³/); assert.match(en.body, /not government observations/); assert.match(en.body, /little change/)
})

test('空氣品質站：沒有 gov.air / history 不足 2 個有效 PM2.5 / 沒有 kind === air 的選項 / 壞資料 → 只略過這一站，其他 7 站不受影響、不報錯', () => {
  const others = IDS8.filter((id) => id !== 'air')
  const cases = {
    '沒有 gov.air': (g) => { delete g.air },
    'air 不是物件': (g) => { g.air = 'oops' },
    'history 空': (g) => { g.air.history = [] },
    'history 不是陣列': (g) => { g.air.history = 5 },
    '只有 1 個有效 PM2.5': (g) => { g.air.history = g.air.history.map((h, i) => ({ ...h, pm25: i === 3 ? 20 : null })) },
    'PM2.5 全是壞值': (g) => { g.air.history = g.air.history.map((h) => ({ ...h, pm25: 'x' })) },
    '沒有 air 選項': (g) => { g.options = g.options.filter((o) => o.kind !== 'air') },
    '選項沒有 kind': (g) => { for (const o of g.options) if (o.id === 'air-yunlin') delete o.kind },
  }
  for (const [name, mut] of Object.entries(cases)) {
    const g = mkGov(); mut(g)
    let ids; assert.doesNotThrow(() => { ids = buildTour(g, { now: NOW }).map((s) => s.id) }, name)
    assert.deepEqual(ids, others, name)
  }
  const g = mkGov(); g.air.history = g.air.history.map((h, i) => ({ ...h, pm25: i < 2 ? h.pm25 : null }))     // 剛好 2 個有效 → 可播
  assert.ok(airStopOf(g), '2 個有效點就夠')
})

test('空氣品質站：runner 走 PLAY.air（playAir）——先設該站倍速再播放，轉站前先停掉上一站的播放；AR 實景略過的仍只有 moon / stations', () => {
  const h = harness()
  h.run()
  const stops = buildTour(mkGov(), { now: NOW })
  h.runner.goto('air')
  assert.equal(h.S.govOptionId, 'air-yunlin'); assert.equal(h.S.rec.mode, 'playing')
  const play = h.calls.filter((c) => c[0] === 'play').pop()
  assert.deepEqual(play, ['play', 'air', stops[4].speed])
  assert.equal(h.emitted[h.emitted.length - 1].caption.key, 'air')
  assert.deepEqual(buildTour(mkGov(), { now: NOW, skip: ['moon', 'stations'] }).map((s) => s.id), ['reservoir', 'tide', 'dust', 'air', 'birds', 'fish'])
})

// =============================================================================================
// 導覽員控制：goto / next / prev / pause / resume / start 的 at 與 hold
// =============================================================================================
const stops8 = () => buildTour(mkGov(), { now: NOW })
const lastRunning = (h) => h.emitted.filter((e) => e.running).pop()

test('resolveStopIndex：0 起算的整數 / 站 id；範圍外、非整數、找不到、壞輸入 → fallback', () => {
  const st = stops8()
  assert.equal(resolveStopIndex(st, 0), 0); assert.equal(resolveStopIndex(st, 7), 7); assert.equal(resolveStopIndex(st, 4), 4)
  assert.equal(resolveStopIndex(st, 'air'), 4); assert.equal(resolveStopIndex(st, 'stations'), 7)
  for (const bad of [-1, 8, 99, 2.5, NaN, Infinity, '2', 'nope', '', null, undefined, {}, [], true]) { assert.equal(resolveStopIndex(st, bad), 0, String(bad)); assert.equal(resolveStopIndex(st, bad, -1), -1, String(bad)) }
  assert.equal(resolveStopIndex(null, 0, -1), -1); assert.equal(resolveStopIndex([], 0, -1), -1)
})

test('導覽員 goto：跳到指定站（index 或站 id）——先停上一站的播放、套用該站海況、series 站以該站倍速播放、字幕 / 日誌更新；不算「接手」（不會被當成 option / input 中止），也不重置閒置計時', () => {
  const h = harness(), st = stops8()
  h.run(); h.step(500)
  h.calls.length = 0
  const touches0 = h.touches()
  assert.equal(h.runner.goto(4), true)                                            // 空氣品質（series）
  assert.deepEqual(h.calls.map((c) => c[0] + (c[1] != null ? ':' + c[1] : '')), ['setGovOption:air-yunlin', 'setRecSpeed:' + st[4].speed, 'play:air'])
  assert.equal(h.S.govOptionId, 'air-yunlin'); assert.equal(h.S.rec.mode, 'playing')
  const e = lastRunning(h)
  assert.equal(e.index, 4); assert.equal(e.total, 8); assert.equal(e.caption.key, 'air'); assert.equal(e.stopMs, TOUR_MS.air); assert.equal(e.seq, 2); assert.equal(e.paused, false)
  assert.ok(h.S.log.some((l) => l.startsWith('導覽 5/8｜')))
  h.step(3000)                                                                     // tick 不會把「導覽員換的海況」當成使用者換的
  assert.equal(h.runner.isRunning(), true); assert.equal(h.runner.current().stop.id, 'air')
  assert.equal(h.touches(), touches0, 'goto 不算使用者活動')
  // 播放中換站：先 stopPlayback 再播新的
  h.calls.length = 0
  assert.equal(h.runner.goto('fish'), true)
  assert.deepEqual(h.calls.map((c) => c[0]).filter((n) => n === 'stopPlayback' || n === 'play'), ['stopPlayback', 'play'])
  assert.equal(h.runner.current().index, 6); assert.equal(h.S.govOptionId, 'zengwen')
  assert.equal(h.runner.goto(7), true)                                             // 測站（apply）：沒有序列 → 不播
  assert.equal(h.S.rec.mode, 'idle')
})

test('導覽員 goto：跳到「目前這一站」= 重播該站（序列從頭播、計時重算、seq 遞增）；找不到的站 / 壞值 → false，什麼都不動', () => {
  const h = harness()
  h.run(); h.runner.goto('tide'); h.step(15000)
  const seq0 = lastRunning(h).seq, plays0 = h.calls.filter((c) => c[0] === 'play').length
  assert.equal(h.runner.goto(1), true)
  assert.equal(lastRunning(h).seq, seq0 + 1); assert.equal(h.calls.filter((c) => c[0] === 'play').length, plays0 + 1)
  h.step(TOUR_MS.tide - 200)
  assert.equal(h.runner.current().index, 1, '重播後計時從頭算：還沒到 20 秒')
  h.step(300)
  assert.equal(h.runner.current().index, 2)
  const before = { n: h.calls.length, e: h.emitted.length, idx: h.runner.current().index }
  for (const bad of [-1, 8, 2.5, NaN, '2', 'nope', null, undefined, {}]) assert.equal(h.runner.goto(bad), false, String(bad))
  assert.deepEqual({ n: h.calls.length, e: h.emitted.length, idx: h.runner.current().index }, before)
  h.runner.stop('user')
  for (const f of ['goto', 'next', 'prev', 'pause', 'resume']) assert.equal(h.runner[f](1), false, `沒在導覽時 ${f} → false`)
})

test('導覽員 next / prev：依序換站；prev 在第 0 站 = 重播第 0 站；手動導覽最後一站 next = done 並還原；自動（閒置）導覽最後一站 next = 回第 0 站繼續', () => {
  const h = harness(), st = stops8()
  const before = { params: { ...h.S.params }, option: h.S.govOptionId, speed: h.S.rec.speed }
  h.run()
  assert.equal(h.runner.next(), true); assert.equal(h.runner.current().index, 1)
  assert.equal(h.runner.next(), true); assert.equal(h.runner.current().index, 2)
  assert.equal(h.runner.prev(), true); assert.equal(h.runner.current().index, 1)
  h.runner.prev(); assert.equal(h.runner.current().index, 0)
  const seq0 = lastRunning(h).seq
  assert.equal(h.runner.prev(), true); assert.equal(h.runner.current().index, 0); assert.equal(lastRunning(h).seq, seq0 + 1, '第 0 站再 prev = 重播')
  h.runner.goto(7)
  assert.equal(h.runner.next(), true)
  assert.equal(h.runner.isRunning(), false, '手動導覽：最後一站的 next = 結束')
  assert.deepEqual(h.S.params, before.params); assert.equal(h.S.govOptionId, before.option); assert.equal(h.S.rec.speed, before.speed); assert.equal(h.S.rec.mode, 'idle')
  assert.ok(h.S.log.some((l) => l.includes('資料導覽結束，已還原原本的海')))
  assert.equal(lastRunning(h).index, 7); assert.equal(h.emitted[h.emitted.length - 1].running, false)

  const a = harness({ auto: true })
  a.run(); a.runner.goto(7); a.step(300)
  assert.equal(a.runner.next(), true)
  assert.equal(a.runner.isRunning(), true); assert.equal(a.runner.current().index, 0); assert.equal(a.runner.current().auto, true)
  assert.ok(!a.S.log.some((l) => l.includes('資料導覽結束')))
  assert.equal(st.length, 8)
})

test('導覽員換站的順序不變：先寫「導覽 i/n」OUT 日誌 → 套用海況 → 資料播放；每次換站都先停掉上一站的播放（連續兩次 play 之間一定有 stopPlayback）', () => {
  const h = harness()
  h.run()
  for (const i of [1, 2, 3, 4, 5, 4, 1, 1, 6]) h.runner.goto(i)
  const seq = h.calls.filter((c) => c[0] === 'play' || c[0] === 'stopPlayback').map((c) => c[0])
  for (let i = 1; i < seq.length; i++) assert.ok(!(seq[i] === 'play' && seq[i - 1] === 'play'))
  // 日誌先於海況：S.log 的「導覽 n/8」比同一次的 setGovOption 更早（fake store 的 log 與 calls 是兩份，這裡以時序旗標驗證）
  const order = []
  const h2 = harness()
  const orig = h2.S.log.push.bind(h2.S.log)
  h2.S.log.push = (t) => { order.push('log:' + t.slice(0, 2)); return orig(t) }
  h2.run(); order.length = 0
  h2.calls.push = ((push) => function (...a) { order.push('call:' + a[0][0]); return push.apply(this, a) })(h2.calls.push)
  h2.runner.goto(1)
  assert.deepEqual(order.slice(0, 2), ['log:導覽', 'call:setGovOption'])
})

test('暫停：凍結這一站的計時——暫停期間不換站；繼續後從「剩餘時間」接著算（不重新計滿）', () => {
  const h = harness()
  h.run(); h.step(4000)
  assert.equal(h.runner.pause(), true)
  assert.equal(h.runner.isPaused(), true); assert.equal(h.runner.current().paused, true)
  assert.equal(h.emitted.filter((e) => e.paused === true).length, 1, '暫停時 emit 一次 paused: true（會鏡像到觀眾視窗）')
  h.step(120000)                                                                    // 暫停 2 分鐘
  assert.equal(h.runner.isRunning(), true); assert.equal(h.runner.current().index, 0, '暫停期間不換站')
  assert.equal(h.runner.pause(), false, '重複暫停 → false')
  assert.equal(h.runner.resume(), true); assert.equal(h.runner.isPaused(), false); assert.equal(h.runner.resume(), false, '沒暫停時 resume → false')
  assert.equal(h.emitted.filter((e) => e.paused === false && !('running' in e)).length, 1, '繼續時 emit paused: false')
  h.step(6800)                                                                      // 4000 + 6800 = 10800 < 11000
  assert.equal(h.runner.current().index, 0, '剩餘時間沒用完')
  h.step(200)
  assert.equal(h.runner.current().index, 1, '滿 11000ms（含暫停前的 4000）才換站')
  assert.ok(h.S.log.some((l) => l.includes('資料導覽暫停（第 1 站）'))); assert.ok(h.S.log.some((l) => l.includes('資料導覽繼續（第 1 站）')))
})

test('暫停：可以多次暫停 / 繼續，累計的計時不會重置也不會多算', () => {
  const h = harness()
  h.run()
  h.step(3000); h.runner.pause(); h.step(9000); h.runner.resume()
  h.step(3000); h.runner.pause(); h.step(9000); h.runner.resume()
  h.step(4900)                                                                      // 3000 + 3000 + 4900 = 10900
  assert.equal(h.runner.current().index, 0)
  h.step(100)
  assert.equal(h.runner.current().index, 1)
})

test('暫停：凍結序列播放——倍速設成極小值（不是 0：tickPlayback 用 speed || 1，0 會被當成 1），繼續時還原「該站」的倍速；apply 站沒有序列 → 只凍計時、不碰倍速', () => {
  const h = harness(), st = stops8()
  h.run()
  h.calls.length = 0
  h.runner.pause(); h.runner.resume()                                               // 水庫站（apply）
  assert.deepEqual(h.calls.filter((c) => c[0] === 'setRecSpeed'), [], 'apply 站不動倍速')
  h.runner.goto('tide'); h.step(3000)
  assert.equal(h.S.rec.speed, st[1].speed)
  assert.ok(PAUSE_SPEED > 0 && PAUSE_SPEED < 0.001)
  h.runner.pause()
  assert.equal(h.S.rec.speed, PAUSE_SPEED); assert.equal(h.S.rec.mode, 'playing', '序列還在（只是凍住）')
  h.step(30000)
  assert.equal(h.S.rec.mode, 'playing'); assert.equal(h.runner.current().index, 1)
  h.runner.resume()
  assert.equal(h.S.rec.speed, st[1].speed, '繼續：還原該站的倍速（不是導覽前的、也不是上一站的）')
})

test('暫停中「真實輸入」仍會中止導覽（暫停不是鎖定）：還原倍速 / 參數 / 海況選項，paused 歸零、字幕清掉', () => {
  const h = harness()
  const before = { params: { ...h.S.params }, option: h.S.govOptionId, speed: h.S.rec.speed }
  h.run(); h.runner.goto('moon'); h.step(2000)
  h.runner.pause(); h.step(5000)
  assert.equal(h.S.rec.speed, PAUSE_SPEED)
  h.clock.t += 50; h.act.last = h.clock.t                                           // 使用者轉了旋鈕
  h.runner.tick(h.clock.t)
  assert.equal(h.runner.isRunning(), false); assert.equal(h.runner.isPaused(), false)
  assert.equal(h.S.rec.mode, 'idle')
  assert.deepEqual(h.S.params, before.params); assert.equal(h.S.govOptionId, before.option); assert.equal(h.S.rec.speed, before.speed, '不能停在 1e-6')
  const e = h.emitted[h.emitted.length - 1]
  assert.equal(e.running, false); assert.equal(e.paused, false); assert.equal(e.caption, null)
  assert.ok(h.S.log.some((l) => l.includes('資料導覽中止，已還原原本的海')))
})

test('暫停中 stop()（Esc / 按停止 / 分頁隱藏）：同樣完整還原；暫停用的極小倍速一定要還回去', () => {
  for (const reason of ['user', 'hidden', 'input']) {
    const h = harness()
    const before = { params: { ...h.S.params }, option: h.S.govOptionId, speed: h.S.rec.speed }
    h.run(); h.runner.goto(1); h.step(1000); h.runner.pause()
    assert.equal(h.runner.stop(reason), true, reason)
    assert.equal(h.S.rec.speed, before.speed, reason); assert.deepEqual(h.S.params, before.params, reason); assert.equal(h.S.govOptionId, before.option, reason)
    assert.equal(h.runner.isPaused(), false, reason); assert.equal(h.emitted[h.emitted.length - 1].paused, false, reason)
  }
})

test('暫停中被「接手」（開始錄製 / 自己按播放 / 換海況）：不還原使用者的海，但暫停用的極小倍速一定要還回導覽前的倍速（否則使用者自己的播放像當掉一樣不動）', () => {
  const rec = harness()
  rec.run(); rec.runner.goto('tide'); rec.runner.pause()
  rec.S.rec = { ...rec.S.rec, mode: 'recording' }; rec.step(200)
  assert.equal(rec.runner.isRunning(), false); assert.equal(rec.S.rec.mode, 'recording', '不動使用者的錄製'); assert.equal(rec.S.rec.speed, 2)
  const opt = harness()
  opt.run(); opt.runner.goto('moon'); opt.runner.pause()
  opt.S.govOptionId = 'nanhua'; opt.step(200)
  assert.equal(opt.runner.isRunning(), false); assert.equal(opt.S.govOptionId, 'nanhua', '不把使用者選的海況改回去'); assert.equal(opt.S.rec.speed, 2)
  assert.ok(opt.S.log.some((l) => l.includes('改由你接手')))
})

test('暫停中換站（goto / next / prev）：顯示新一站的字幕與海況並保持暫停；序列在該站起點凍結（以極小倍速開播），繼續後才以該站倍速跑、計時從頭算', () => {
  const h = harness(), st = stops8()
  h.run(); h.step(2000); h.runner.pause()
  h.calls.length = 0
  assert.equal(h.runner.goto('air'), true)                                          // series 站，暫停中
  assert.equal(h.runner.isPaused(), true); assert.equal(lastRunning(h).paused, true); assert.equal(lastRunning(h).caption.key, 'air')
  assert.equal(h.S.govOptionId, 'air-yunlin'); assert.equal(h.S.rec.mode, 'playing')
  assert.deepEqual(h.calls.filter((c) => c[0] === 'play'), [['play', 'air', PAUSE_SPEED]], '在該站起點以極小倍速開播（凍結）')
  h.step(60000)
  assert.equal(h.runner.current().index, 4, '暫停中不換站'); assert.equal(h.S.rec.speed, PAUSE_SPEED)
  h.runner.next(); assert.equal(h.runner.current().index, 5); assert.equal(h.runner.isPaused(), true); assert.equal(h.S.rec.speed, PAUSE_SPEED)
  h.runner.prev(); h.runner.prev(); assert.equal(h.runner.current().index, 3); assert.equal(h.runner.isPaused(), true)
  h.runner.goto('stations')                                                         // apply 站：沒有序列
  assert.equal(h.S.rec.mode, 'idle'); assert.equal(h.runner.isPaused(), true)
  h.runner.goto('fish'); assert.equal(h.S.rec.speed, PAUSE_SPEED)
  h.runner.resume()
  assert.equal(h.S.rec.speed, st[6].speed, '繼續：還原「fish 站」的倍速'); assert.equal(h.runner.isPaused(), false)
  h.step(TOUR_MS.fish - 200); assert.equal(h.runner.current().index, 6, '暫停中換站後，計時從新的一站開頭算')
  h.step(300); assert.equal(h.runner.current().index, 7)
})

test('暫停中換到 apply 站再繼續：不留下極小倍速（還原成導覽前的倍速）；再換到 series 站時倍速正確', () => {
  const h = harness(), st = stops8()
  h.run(); h.runner.goto('tide'); h.runner.pause()
  h.runner.goto('reservoir')                                                        // 暫停中換到 apply 站：上一站凍住的倍速還在
  h.runner.resume()
  assert.equal(h.S.rec.speed, 2, '還原成導覽前的倍速，不是 1e-6')
  h.runner.goto('moon')
  assert.equal(h.S.rec.speed, st[2].speed)
})

test('暫停中 next 到最後一站之後：手動導覽 → done 結束並還原（paused 歸零）；自動導覽 → 回第 0 站仍保持暫停', () => {
  const h = harness()
  h.run(); h.runner.goto(7); h.runner.pause()
  assert.equal(h.runner.next(), true); assert.equal(h.runner.isRunning(), false); assert.equal(h.emitted[h.emitted.length - 1].paused, false)
  const a = harness({ auto: true })
  a.run(); a.runner.goto(7); a.runner.pause(); a.runner.next()
  assert.equal(a.runner.current().index, 0); assert.equal(a.runner.isPaused(), true)
})

test('導覽員操作不重置閒置計時（touch 只在開始與結束時呼叫）：goto / next / prev / pause / resume 都不算「使用者活動」', () => {
  const h = harness()
  h.run()
  const t0 = h.touches()
  h.runner.next(); h.runner.prev(); h.runner.pause(); h.runner.goto(3); h.runner.resume(); h.runner.goto('air'); h.step(3000)
  assert.equal(h.touches(), t0)
  assert.equal(h.runner.isRunning(), true)
})

test('start({ at }：0 起算的 index 或站 id；找不到 / 壞值 → 從第 0 站）', () => {
  for (const [at, want] of [[undefined, 0], [0, 0], [4, 4], [7, 7], ['air', 4], ['stations', 7], ['tide', 1], ['nope', 0], [99, 0], [-1, 0], [2.5, 0], ['3', 0], [null, 0]]) {
    const h = harness()
    assert.equal(h.run({ at }), true, String(at))
    assert.equal(h.runner.current().index, want, String(at))
    assert.equal(lastRunning(h).caption.key, IDS8[want], String(at))
    assert.equal(h.S.govOptionId, stops8()[want].optionId, String(at))
    assert.ok(h.S.log.some((l) => l.startsWith(`導覽 ${want + 1}/8｜`)), String(at))
    assert.equal(h.runner.isPaused(), false)
  }
  const h = harness()                                                               // 該站被 skip（AR 實景略過 moon）→ 找不到 → 從 0
  assert.equal(h.run({ at: 'moon', opts: { skip: ['moon'] } }), true); assert.equal(h.runner.current().index, 0)
  assert.equal(h.runner.current().total, 7)
})

test('start({ at, hold })：hold = 到站後立即暫停在該站（導覽員模式）——計時凍結、series 站的序列在起點凍結、字幕 / 海況已套用；繼續後才開始跑', () => {
  const st = stops8()
  const a = harness()
  assert.equal(a.run({ hold: true }), true)                                         // 水庫站（apply）
  assert.equal(a.runner.isPaused(), true); assert.equal(lastRunning(a).paused, true); assert.equal(lastRunning(a).caption.key, 'reservoir')
  assert.deepEqual(a.calls.filter((c) => c[0] === 'setRecSpeed'), [], 'apply 站不動倍速')
  assert.ok(a.S.log.some((l) => l.includes('資料導覽暫停（第 1 站）')))
  a.step(120000); assert.equal(a.runner.current().index, 0)
  a.runner.resume(); a.step(10900); assert.equal(a.runner.current().index, 0); a.step(200); assert.equal(a.runner.current().index, 1)

  const b = harness()
  assert.equal(b.run({ at: 'air', hold: true }), true)                              // series 站
  assert.equal(b.runner.current().index, 4); assert.equal(b.runner.isPaused(), true)
  assert.equal(b.S.rec.mode, 'playing'); assert.deepEqual(b.calls.filter((c) => c[0] === 'play'), [['play', 'air', PAUSE_SPEED]])
  b.step(60000); assert.equal(b.runner.current().index, 4)
  b.runner.resume(); assert.equal(b.S.rec.speed, st[4].speed)
  b.step(TOUR_MS.air + 100); assert.equal(b.runner.current().index, 5)

  const c = harness()
  c.run({ at: 3, hold: true })
  assert.equal(c.runner.current().index, 3)
  c.runner.stop('user'); assert.equal(c.S.rec.speed, 2); assert.equal(c.runner.isPaused(), false)
})

test('current()：含 paused；沒在導覽 → null', () => {
  const h = harness()
  assert.equal(h.runner.current(), null); assert.equal(h.runner.isPaused(), false)
  h.run({ at: 'dust' })
  const c = h.runner.current()
  assert.equal(c.index, 3); assert.equal(c.total, 8); assert.equal(c.stop.id, 'dust'); assert.equal(c.auto, false); assert.equal(c.paused, false)
  h.runner.pause(); assert.equal(h.runner.current().paused, true)
})

test('start 帶 stopList（每站 id + 字幕資料，進度點按鈕的標籤與複製連結的站 id 用）；停止時清空', () => {
  const h = harness()
  h.run()
  const e = h.emitted.find((x) => 'stopList' in x)
  assert.deepEqual(e.stopList.map((x) => x.id), IDS8)
  for (const x of e.stopList) { assert.ok(x.caption && x.caption.key === x.id); JSON.parse(JSON.stringify(x)) }
  h.runner.stop('user')
  assert.deepEqual(h.emitted[h.emitted.length - 1].stopList, [])
})

// =============================================================================================
// 字幕旁白（假 narrator：方法都檢查 this）
// =============================================================================================
function withSpeak(fn) {
  useTourStore.setState({ speak: true, remote: false })
  try { return fn() } finally { useTourStore.setState({ speak: false }); setLocale('zh') }
}
const zhText = (stop) => speechText(inLocale('zh', () => captionText(stop.caption)), 'zh')
const enText = (stop) => speechText(inLocale('en', () => captionText(stop.caption)), 'en')

test('旁白：預設不出聲（speak 偏好為 false）；不支援語音的瀏覽器也不念', () => {
  assert.equal(SPEAK_DEFAULT, false); assert.equal(useTourStore.getState().speak, false)
  const nar = makeNarrator()
  const h = harness({ narrator: nar }); h.run(); h.runner.goto(3); h.step(500)
  assert.equal(nar.count('speak'), 0, '偏好關閉 → 不念')
  withSpeak(() => {
    const off = makeNarrator({ supported: false })
    const h2 = harness({ narrator: off }); h2.run(); h2.runner.next(); h2.step(500)
    assert.equal(off.count('speak'), 0, 'supported() 為 false → 不念'); assert.equal(h2.runner.isRunning(), true)
  })
})

test('旁白：每次 begin 後念這一站的字幕（speechText(captionText, 語系)）；換站（goto / next / prev）→ 取消前一句、念新的一站；speak 只帶一個參數（語言預設依語系）', () => withSpeak(() => {
  const nar = makeNarrator(), st = stops8()
  const h = harness({ narrator: nar })
  h.run()
  assert.deepEqual(nar.spoken(), [zhText(st[0])])
  assert.equal(nar.log[nar.log.length - 1][2], undefined)
  h.runner.next()
  assert.deepEqual(nar.spoken(), [zhText(st[0]), zhText(st[1])])
  assert.ok(nar.count('cancel') >= 1, '換站前先取消前一句')
  const idx = nar.log.findIndex((x) => x[0] === 'cancel'), sp = nar.log.findIndex((x, i) => i > idx && x[0] === 'speak')
  assert.ok(idx >= 0 && sp > idx, '先 cancel 再 speak')
  h.runner.goto('air'); h.runner.prev()
  assert.deepEqual(nar.spoken().slice(2), [zhText(st[4]), zhText(st[3])])
  h.runner.goto(3)                                                                  // 重播同一站 → 再念一次
  assert.equal(nar.spoken().length, 5)
  assert.match(nar.spoken()[2], /空氣品質.*模型資料.*非政府觀測/, '空氣品質站的旁白也誠實')
  assert.match(nar.spoken()[2], /微克每立方公尺/, '單位念出來')
}))

test('旁白：stop（使用者停止 / 輸入 / 分頁隱藏 / 卸載）→ narrator.cancel()；結束後語系 / 開關變化不會再念（訂閱已取消，無洩漏）', () => withSpeak(() => {
  for (const reason of ['user', 'input', 'hidden', 'done', 'rec']) {
    const nar = makeNarrator()
    const localeListeners = new Set(), speakListeners = new Set()
    const h = harness({ narrator: nar, extra: {
      subscribeLocale: (cb) => { localeListeners.add(cb); return () => localeListeners.delete(cb) },
      subscribeSpeak: (cb) => { speakListeners.add(cb); return () => speakListeners.delete(cb) },
    } })
    h.run()
    assert.equal(localeListeners.size, 1); assert.equal(speakListeners.size, 1)
    const c0 = nar.count('cancel')
    h.runner.stop(reason)
    assert.equal(nar.count('cancel'), c0 + 1, reason); assert.equal(nar.speaking(), false, reason)
    assert.equal(localeListeners.size, 0, `${reason}：語系訂閱已取消`); assert.equal(speakListeners.size, 0, `${reason}：旁白開關訂閱已取消`)
    const n0 = nar.count('speak')
    for (const f of [...localeListeners, ...speakListeners]) f()
    assert.equal(nar.count('speak'), n0)
  }
}))

test('旁白：這一輪沒念過就不去 cancel 共用的旁白（可能是別的功能在用）', () => {
  const nar = makeNarrator()
  const h = harness({ narrator: nar }); h.run(); h.runner.next(); h.runner.pause(); h.runner.resume(); h.runner.stop('user')
  assert.equal(nar.log.length, 0, '偏好關閉：完全不碰旁白物件（連 supported 都可以不問）')
})

test('旁白：暫停 → 取消；暫停中不念；繼續 → 從頭重念目前這一站；暫停中換站不念', () => withSpeak(() => {
  const nar = makeNarrator(), st = stops8()
  const h = harness({ narrator: nar })
  h.run(); h.step(3000)
  const c0 = nar.count('cancel')
  h.runner.pause()
  assert.equal(nar.count('cancel'), c0 + 1); assert.equal(nar.speaking(), false)
  h.runner.goto('moon'); h.runner.next(); h.runner.prev()
  assert.equal(nar.count('speak'), 1, '暫停中換站不念')
  h.runner.resume()
  assert.equal(nar.count('speak'), 2); assert.equal(nar.spoken()[1], zhText(st[2]), '從頭重念目前（moon）這一站')
  assert.equal(nar.speaking(), true)
  const h2 = harness({ narrator: makeNarrator() })                                  // hold 開始：暫停中不念，繼續才念
  h2.run({ hold: true }); assert.equal(h2.runner.isPaused(), true)
}))

test('旁白：start 的 hold 模式——到站後暫停、不念；繼續後才念', () => withSpeak(() => {
  const nar = makeNarrator()
  const h = harness({ narrator: nar })
  h.run({ at: 'dust', hold: true })
  assert.equal(nar.count('speak'), 0)
  h.runner.resume()
  assert.deepEqual(nar.spoken(), [zhText(stops8()[3])])
}))

test('旁白：語系切換 → 重念（字幕文字已換成新語言）；預設訂閱走 i18n 的語系 store', () => withSpeak(() => {
  const nar = makeNarrator(), st = stops8()
  const h = harness({ narrator: nar })
  h.run(); h.runner.goto('air')
  assert.equal(nar.count('speak'), 2)
  setLocale('en')
  assert.equal(nar.count('speak'), 3); assert.equal(nar.spoken()[2], enText(st[4]))
  assert.match(nar.spoken()[2], /model data.*not government observations/i); assert.doesNotMatch(nar.spoken()[2], HAN)
  setLocale('zh')
  assert.equal(nar.spoken()[3], zhText(st[4]))
  h.runner.pause(); const n = nar.count('speak'); setLocale('en'); assert.equal(nar.count('speak'), n, '暫停中切語系不念（繼續時才用新語系念）'); setLocale('zh')
  h.runner.stop('user'); const n2 = nar.count('speak'); setLocale('en'); assert.equal(nar.count('speak'), n2, '停止後不再念'); setLocale('zh')
}))

test('旁白：導覽中打開「念出字幕」→ 立刻念目前這一站（此時有使用者手勢，瀏覽器才准）；關閉 → 立刻停；偏好存進 LS.tour.speak', () => {
  useTourStore.setState({ speak: false, remote: false })
  withStorage((data) => {
    try {
      const nar = makeNarrator(), st = stops8()
      const h = harness({ narrator: nar })
      h.run({ at: 'tide' }); assert.equal(nar.count('speak'), 0)
      setSpeak(true)
      assert.deepEqual(nar.spoken(), [zhText(st[1])]); assert.equal(useTourStore.getState().speak, true)
      assert.equal(JSON.parse(data.get(LS.tour)).speak, true)
      const c0 = nar.count('cancel')
      setSpeak(false)
      assert.equal(nar.count('cancel'), c0 + 1); assert.equal(nar.speaking(), false); assert.equal(JSON.parse(data.get(LS.tour)).speak, false)
      h.runner.next(); assert.equal(nar.count('speak'), 1, '關閉後換站不念')
      h.runner.stop('user')
    } finally { useTourStore.setState({ speak: false }) }
  })
})

test('旁白：該站時間到、旁白還沒念完 → 延後換站（最多再等 6 秒）；念完就換；等的期間不算暫停', () => withSpeak(() => {
  assert.equal(NARRATION_MAX_WAIT_MS, 6000)
  const nar = makeNarrator()
  const h = harness({ narrator: nar })
  h.run()
  h.step(TOUR_MS.reservoir + 100)                                                   // 時間到，旁白還在念
  assert.equal(h.runner.current().index, 0, '等旁白'); assert.equal(h.runner.current().paused, false, '等待不是暫停')
  assert.equal(h.runner.isPaused(), false)
  nar.finish(); h.step(100)
  assert.equal(h.runner.current().index, 1, '念完 → 換站')
  // 念不完：時間到後最多再等 6 秒（自等待開始起算）
  h.step(TOUR_MS.tide)                                                              // 剛好時間到的那一個 tick 開始等待
  assert.equal(h.runner.current().index, 1)
  h.step(NARRATION_MAX_WAIT_MS - 100)
  assert.equal(h.runner.current().index, 1, '5.9 秒還在等')
  h.step(100)
  assert.equal(h.runner.current().index, 2, '滿 6 秒不再等，換站')
}))

test('旁白：等待中暫停 / 中止 / 跳站都會結束這段等待；暫停後繼續 = 重念並重新給 6 秒', () => withSpeak(() => {
  const nar = makeNarrator()
  const h = harness({ narrator: nar })
  h.run(); h.step(TOUR_MS.reservoir + 3000)                                         // 等了約 3 秒
  assert.equal(h.runner.current().index, 0)
  h.runner.pause(); h.step(60000)
  assert.equal(h.runner.current().index, 0, '暫停：不換站也不再倒數等待')
  h.runner.resume()
  assert.equal(nar.speaking(), true, '繼續：重念')
  h.step(NARRATION_MAX_WAIT_MS); assert.equal(h.runner.current().index, 0, '這一站的時間本來就到了，但繼續後的旁白重新給 6 秒（從繼續後第一個 tick 起算），不是接續暫停前已經等過的 3 秒')
  h.step(200); assert.equal(h.runner.current().index, 1)
  // 跳站：等待歸零，新的一站照常計時
  h.step(TOUR_MS.tide + 3000); assert.equal(h.runner.current().index, 1)
  h.runner.goto('fish'); assert.equal(h.runner.current().index, 6)
  h.step(TOUR_MS.fish - 200); assert.equal(h.runner.current().index, 6)
  // 中止
  h.step(TOUR_MS.fish); h.runner.stop('user'); assert.equal(h.runner.isRunning(), false)
}))

test('旁白：speak 被瀏覽器擋（\'error\'）/ 同步丟例外 / Promise 被 reject → 靜默略過，導覽照常跑完並還原（不丟例外、沒有 unhandled rejection）', async () => {
  for (const speakMode of ['error', 'throw', 'reject']) {
    await withSpeak(async () => {
      const nar = makeNarrator({ speakMode })
      const h = harness({ narrator: nar })
      const before = { params: { ...h.S.params }, option: h.S.govOptionId, speed: h.S.rec.speed }
      assert.doesNotThrow(() => { h.run(); h.runner.next(); h.runner.pause(); h.runner.resume(); h.runner.goto('air') }, speakMode)
      assert.doesNotThrow(() => h.step(tourTotalMs(stops8()) + 500), speakMode)
      assert.equal(h.runner.isRunning(), false, `${speakMode}：一輪跑完照常結束（沒有被「等旁白」卡住）`)
      assert.deepEqual(h.S.params, before.params); assert.equal(h.S.govOptionId, before.option); assert.equal(h.S.rec.speed, before.speed)
      assert.ok(nar.count('speak') >= 5, speakMode)
      await new Promise((r) => setImmediate(r))                                     // 讓被 reject 的 Promise 有機會冒出 unhandled rejection（有的話 node:test 會判失敗）
    })
  }
})

test('旁白：觀眾視窗（remote）不念——即使偏好開著、旁白支援；remote 是導覽開始「之後」才被標記（收到第一個 mirror 訊息）也一樣', () => withSpeak(() => {
  const nar = makeNarrator()
  const h = harness({ narrator: nar })
  h.run(); assert.equal(nar.count('speak'), 1)
  h.flags.remote = true
  h.runner.next(); h.runner.pause(); h.runner.resume()
  assert.equal(nar.count('speak'), 1, 'remote 之後不再念')
  const r = makeNarrator(); const h2 = harness({ narrator: r, remote: true })
  assert.equal(h2.run(), false); assert.equal(r.log.length, 0)
}))

test('supportsNarration：Node 沒有語音合成 → false；不丟例外、import 時不碰任何全域', () => {
  assert.equal(supportsNarration(), false)
})

test('旁白的假物件會檢查 this（對照組）：脫離原物件呼叫 speak / cancel 會丟 Illegal invocation——tour.js 用的是方法呼叫，所以上面的測試能過', () => {
  const nar = makeNarrator()
  const { speak } = nar
  assert.throws(() => speak('x'), /Illegal invocation/)
  const { cancel } = nar
  assert.throws(() => cancel(), /Illegal invocation/)
})

// =============================================================================================
// 偏好：resolveSpeak / setAutoIdle / setSpeak（LS.tour = { auto, speak } 合併寫入）
// =============================================================================================
test('resolveSpeak：?speak=0/1 > 使用者偏好 > 預設（false，展場也一樣）；壞的偏好值 → 預設', () => {
  assert.equal(resolveSpeak({}), false); assert.equal(resolveSpeak(), false)
  assert.equal(resolveSpeak({ saved: true }), true); assert.equal(resolveSpeak({ saved: false }), false)
  assert.equal(resolveSpeak({ saved: false, search: '?speak=1' }), true)
  assert.equal(resolveSpeak({ saved: true, search: '?speak=0' }), false)
  for (const v of ['1', 'on', 'true', 'yes', 'ON']) assert.equal(resolveSpeak({ search: '?speak=' + v }), true, v)
  for (const v of ['0', 'off', 'false', 'no']) assert.equal(resolveSpeak({ saved: true, search: '?speak=' + v }), false, v)
  assert.equal(resolveSpeak({ saved: 'yes', search: '?x=1' }), false, '壞的偏好值 → 預設')
  assert.equal(resolveSpeak({ search: '?kiosk=1' }), false, '展場模式也預設不出聲')
  assert.equal(resolveSpeak({ saved: true, search: '?speak=maybe' }), true, '不認得的網址值 → 交給偏好')
  assert.equal(resolveSpeak({ search: '?speak' }), false)
})

test('setAutoIdle / setSpeak 互不洗掉：LS.tour 是 { auto, speak } 合併寫入；未知欄位保留；store 同步更新', () => {
  withStorage((data) => {
    const read = () => JSON.parse(data.get(LS.tour))
    setAutoIdle(false)
    assert.deepEqual(read(), { auto: false }); assert.equal(useTourStore.getState().autoIdle, false)
    setSpeak(true)
    assert.deepEqual(read(), { auto: false, speak: true }, '設旁白不會洗掉閒置自動導覽')
    setAutoIdle(true)
    assert.deepEqual(read(), { auto: true, speak: true }, '設閒置自動導覽不會洗掉旁白')
    setSpeak(false); assert.deepEqual(read(), { auto: true, speak: false })
    assert.equal(useTourStore.getState().speak, false); assert.equal(useTourStore.getState().autoIdle, true)
    data.set(LS.tour, JSON.stringify({ auto: false, speak: true, future: 'keep' }))
    setSpeak(true); setAutoIdle(false)
    assert.deepEqual(read(), { auto: false, speak: true, future: 'keep' }, '未知欄位保留')
    for (const bad of ['"str"', '[1,2]', 'null', '5', '{oops']) {                       // 壞的儲存值：當作空物件、不丟錯
      data.set(LS.tour, bad)
      assert.doesNotThrow(() => setSpeak(true), bad)
      assert.deepEqual(read(), { speak: true }, bad)
    }
    assert.deepEqual(loadLS(LS.tour, null), { speak: true })
  })
  useTourStore.setState({ autoIdle: true, speak: false })
})

test('setAutoIdle / setSpeak：localStorage 不可用（隱私模式丟例外）時不丟錯，store 照常更新', () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const boom = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } }
  Object.defineProperty(globalThis, 'localStorage', { value: boom, configurable: true, writable: true })
  try {
    assert.doesNotThrow(() => { setSpeak(true); setAutoIdle(false) })
    assert.equal(useTourStore.getState().speak, true); assert.equal(useTourStore.getState().autoIdle, false)
  } finally { if (desc) Object.defineProperty(globalThis, 'localStorage', desc); else delete globalThis.localStorage; useTourStore.setState({ autoIdle: true, speak: false }) }
})

test('站順序常數：buildTour 的順序 = tourLink 白名單；getLocale 在測試結束時回到 zh', () => {
  assert.deepEqual(stops8().map((s) => s.id), TOUR_STOP_IDS)
  assert.equal(getLocale(), 'zh')
})
