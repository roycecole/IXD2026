// 資料 → 播放序列 / 輸出顯示文字 的單元測試。執行：node --test src/lib/series.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { seriesFromOption, seriesFromSurvey, seriesFromDust, seriesFromMoon, automationFor, formatHud, gapRangeText, timelineLayout, timelineAxis, timelineAlt, playheadAt, isSameSeries } from './series.js'
import { describeBoard, describeForLog, dustSummary } from './describe.js'
import { loadEnDict, HAN } from '../../scripts/i18n-check.mjs'
import { registerEn, setLocale } from '../i18n/index.js'
import { flockCount } from './birds.js'

const { dict: EN_DICT } = await loadEnDict()
registerEn(EN_DICT)
const inEn = (fn) => { setLocale('en'); try { return fn() } finally { setLocale('zh') } }   // 英文語系下執行，結束一定切回中文

const real = JSON.parse(readFileSync(new URL('../../public/data/ocean.json', import.meta.url), 'utf8'))
const inUnit = (v) => typeof v === 'number' && v >= 0 && v <= 1

const hist = (rows) => rows.map(([t, pm10, wind, temp, rh]) => ({ t, pm10, wind, temp, rh }))
const T = (h) => `2026-09-20T${String(h).padStart(2, '0')}:00:00+08:00`

test('dust：PM10 有效 → 以 PM10 播放；PM10 全無效 → 退回風速；有效筆數不足 → null', () => {
  const pm = seriesFromDust({ county: '雲林縣', history: hist([[T(9), 30, 3, 28, 70], [T(12), 80, 6, 30, 65], [T(15), 55, 4, 31, 60]]) })
  assert.equal(pm.label, 'PM10'); assert.equal(pm.extra.metric, 'pm10'); assert.equal(pm.points.length, 3); assert.equal(pm.target, 'clarity')

  const wd = seriesFromDust({ county: '雲林縣', history: hist([[T(9), null, 3, null, 70], [T(12), null, 6, 30, 65], [T(15), null, 4, null, 60]]) })
  assert.equal(wd.label, '風速'); assert.equal(wd.unit, 'm/s'); assert.equal(wd.extra.metric, 'wind'); assert.equal(wd.target, 'current')
  assert.deepEqual(wd.points.map((p) => p.v), [3, 6, 4]); assert.equal(wd.points[0].pm, null)

  assert.equal(seriesFromDust({ history: hist([[T(9), null, 3, null, 70]]) }), null)             // 只有 1 筆
  assert.equal(seriesFromDust({ history: hist([[T(9), null, null, null, 70], [T(12), null, null, null, 71]]) }), null) // 風 / PM10 都沒有
  assert.equal(seriesFromDust(null), null)
  // 只有 1 筆 PM10 有效、另有 2 筆風 → 風速
  assert.equal(seriesFromDust({ history: hist([[T(9), 40, 3, 0, 0], [T(12), null, 5, 0, 0]]) }).label, '風速')
})

test('dust 自動化：PM10 模式 PM10 越高越混濁；風速模式風越大洋流越急、海水越混；輸出都在 0..1', () => {
  const pm = seriesFromDust({ history: hist([[T(9), 10, 3], [T(12), 200, 3]]) })
  const lo = Object.fromEntries(automationFor(pm, 0)), hi = Object.fromEntries(automationFor(pm, 1))
  assert.ok(hi.clarity < lo.clarity && hi.trashCount > lo.trashCount)

  const wd = seriesFromDust({ history: hist([[T(9), null, 0.5], [T(12), null, 11]]) })
  const calm = Object.fromEntries(automationFor(wd, 0)), gale = Object.fromEntries(automationFor(wd, 1))
  assert.ok(gale.current > calm.current && gale.clarity < calm.clarity && gale.trashCount > calm.trashCount)
  for (const a of [calm, gale, lo, hi]) for (const v of Object.values(a)) assert.ok(inUnit(v), String(v))
  assert.deepEqual(Object.keys(calm).sort(), ['clarity', 'current', 'hue', 'trashCount'])
})

test('formatHud：dust 依主變數顯示（PM10 帶風速；風速帶 PM10 / 濕度 / 氣溫），文字不含 undefined / null / NaN', () => {
  const wd = seriesFromDust({ county: '雲林縣', history: hist([[T(9), null, 3.2, 29, 70], [T(12), null, 6, null, 65]]) })
  const t0 = formatHud(wd, wd.points[0]), t1 = formatHud(wd, wd.points[1])
  assert.match(t0, /風速 3\.2m\/s/); assert.match(t0, /氣溫 29°C/); assert.match(t0, /濕度 70%/); assert.doesNotMatch(t1, /氣溫/)
  const pm = seriesFromDust({ county: '雲林縣', history: hist([[T(9), 33.3, 3, 0, 0], [T(12), 60, 5, 0, 0]]) })
  assert.match(formatHud(pm, pm.points[0]), /PM10 33\.3μg\/m³ · 風 3 m\/s/)
  for (const s of [t0, t1, formatHud(pm, pm.points[1])]) assert.doesNotMatch(s, /undefined|null|NaN/)
})

test('moon：滾動視窗 → 每天一點；無月出 / 月沒的日子（空字串、null）不會炸；HUD 文字完整', () => {
  const days = [['2026-09-18', '12:04', 121, '17:21', 37, 'S', '22:36', 239], ['2026-09-19', '12:56', 121, '18:12', 38, 'S', '23:29', 240], ['2026-09-20', '13:44', 120, '19:03', 39, 'S', '', null], ['2026-09-21', '', null, '19:52', 40, 'S', '00:22', 241]]
  const s = seriesFromMoon({ county: '花蓮縣', from: '2026-09-18', to: '2026-09-21', days })
  assert.equal(s.points.length, 4); assert.equal(s.kind, 'moon'); assert.equal(s.date, '2026-09-18 → 2026-09-21')
  assert.match(formatHud(s, s.points[2]), /月出 13:44 · 中天 19:03（仰角 39°S）· 月沒 —/)
  assert.match(formatHud(s, s.points[3]), /月出 — /)
  for (let i = 0; i < 4; i++) for (const [, v] of automationFor(s, i)) assert.ok(inUnit(v))
  assert.equal(seriesFromMoon({ days: days.slice(0, 2) }), null)
})

test('survey：至少 2 個年度才能播放；魚 / 鳥各有自己的參數；不含 NaN', () => {
  const o = { name: 'x', birds: { basin: '甲', species: 100, yearly: [{ y: 2005, s: 60, n: 100 }, { y: 2006, s: 90, n: null }] }, fish: { basin: '甲', species: 40, yearly: [{ y: 2005, s: 10, n: 5 }] } }
  const b = seriesFromSurvey(o, 'birds')
  assert.equal(b.target, 'birdCount'); assert.equal(b.points.length, 2)
  assert.ok(automationFor(b, 1)[0][1] > automationFor(b, 0)[0][1])       // 種數多 → 鳥群多
  assert.equal(seriesFromSurvey(o, 'fish'), null)                          // 只有 1 個年度
  assert.match(formatHud(b, b.points[1]), /2006 年 · 鳥種數 90/)
  for (let i = 0; i < b.points.length; i++) for (const [, v] of automationFor(b, i)) assert.ok(inUnit(v) && !Number.isNaN(v))
})

// ---- 調查空窗：逐年稠密序列 ----
// 曾文溪型：連續 3 年、空窗 7 年、連續 2 年
const gapObj = (yearly, extra = {}) => ({ name: '曾文水庫', birds: { basin: '曾文溪流域', species: 100, yearly, ...extra }, fish: { basin: '曾文溪流域', species: 100, yearly, ...extra } })
const Y = (...rows) => rows.map(([y, s, n = null]) => ({ y, s, n }))
const ZW = Y([2004, 69, 3585], [2005, 64, 3248], [2006, 26, 872], [2014, 52, 2171], [2015, 59, 2954])

test('survey 空窗：從第一個到最後一個調查年，每個日曆年一個 point；空窗年 gap=true、n=null、v 為前後調查年線性內插', () => {
  const s = seriesFromSurvey(gapObj(Y([2004, 60, 100], [2005, 90, 200], [2008, 30, 50], [2009, 30])), 'birds')
  assert.deepEqual(s.points.map((p) => p.t), ['2004', '2005', '2006', '2007', '2008', '2009'])
  assert.deepEqual(s.points.map((p) => p.gap), [false, false, true, true, false, false])
  assert.deepEqual(s.points.map((p) => p.n), [100, 200, null, null, 50, null])
  // 2005:90 → 2008:30，共 3 年 → 每年 -20
  assert.ok(Math.abs(s.points[2].v - 70) < 1e-9 && Math.abs(s.points[3].v - 50) < 1e-9, JSON.stringify(s.points.map((p) => p.v)))
  assert.deepEqual([s.points[0].v, s.points[1].v, s.points[4].v, s.points[5].v], [60, 90, 30, 30])   // 調查年的值原樣，不被內插動到
  assert.deepEqual(s.extra.years, [2004, 2005, 2008, 2009])
  assert.deepEqual(s.extra.gaps, [[2006, 2007]])
  assert.equal(s.extra.species, 100)
})

test('survey 空窗：gaps 是「連續空窗年」的區間；多段空窗與單一年空窗都對', () => {
  const s = seriesFromSurvey(gapObj(Y([2000, 10], [2003, 40], [2005, 20], [2006, 20], [2012, 80])), 'fish')
  assert.deepEqual(s.extra.gaps, [[2001, 2002], [2004, 2004], [2007, 2011]])
  assert.deepEqual(s.extra.years, [2000, 2003, 2005, 2006, 2012])
  assert.equal(s.points.length, 13)
  assert.deepEqual(s.points.filter((p) => p.gap).map((p) => p.t), ['2001', '2002', '2004', '2007', '2008', '2009', '2010', '2011'])
  assert.equal(s.points[4].v, 30)   // 2004：2003:40 與 2005:20 的正中間
  const z = seriesFromSurvey(gapObj(ZW), 'fish')
  assert.deepEqual(z.extra.gaps, [[2007, 2013]])   // 規格例：曾文溪 2006 → 2014 空窗 8 年（2007–2013 共 7 個空窗年）
  assert.equal(z.points.length, 12)
})

test('survey 空窗：min / max / mean 只用真實調查年，內插值不影響基準', () => {
  const s = seriesFromSurvey(gapObj(Y([2004, 10], [2005, 100], [2010, 40], [2011, 40])), 'birds')
  assert.deepEqual(s.stats, { min: 10, max: 100, mean: (10 + 100 + 40 + 40) / 4 })
  // 若把內插年（2006–2009）也算進去，mean 會是 (10+100+88+76+64+52+40+40)/8 = 58.75，不等於 47.5
  assert.notEqual(s.stats.mean, 58.75)
  const z = seriesFromSurvey(gapObj(ZW), 'fish')
  assert.ok(Math.abs(z.stats.mean - (69 + 64 + 26 + 52 + 59) / 5) < 1e-9)
  assert.equal(z.stats.min, 26); assert.equal(z.stats.max, 69)
})

test('survey 空窗：automationFor 對空窗年用內插後的 v；rel 用真實年的 mean；輸出都在 0..1', () => {
  const s = seriesFromSurvey(gapObj(Y([2004, 60], [2008, 100])), 'birds')   // mean=80；2006 內插 = 80
  assert.equal(s.points[2].v, 80); assert.equal(s.stats.mean, 80)
  assert.deepEqual(automationFor(s, 2), [['birdCount', flockCount(100, 1) / 5]])    // rel = 80/80 = 1
  const f = seriesFromSurvey(gapObj(Y([2004, 20], [2008, 100])), 'fish')            // 2005 內插 = 40，mean = 60
  const at = (i) => Object.fromEntries(automationFor(f, i)).fishCount
  assert.ok(at(0) < at(1) && at(1) < at(2) && at(2) < at(3) && at(3) < at(4))       // 種數上升 → 魚群量單調上升（含空窗年）
  for (const sp of [s, f]) for (let i = 0; i < sp.points.length; i++) for (const [, v] of automationFor(sp, i)) assert.ok(inUnit(v) && !Number.isNaN(v))
})

test('survey 空窗：formatHud 空窗年帶「無調查（內插）」與整段空窗區間；調查年輸出維持原樣', () => {
  const s = seriesFromSurvey(gapObj(ZW), 'fish')
  const i2010 = s.points.findIndex((p) => p.t === '2010')
  const txt = formatHud(s, s.points[i2010])
  assert.match(txt, /^曾文溪流域 2010 年 · 無調查（內插）/)
  assert.match(txt, / · 無調查 2007–2013$/)
  assert.match(txt, /魚種數 ≈\d+/)
  assert.equal(formatHud(s, s.points[0]), '曾文溪流域 2004 年 · 魚種數 69 · 隻次 3585')      // 調查年：與改造前逐字相同
  assert.equal(formatHud(s, s.points[2]), '曾文溪流域 2006 年 · 魚種數 26 · 隻次 872')
  assert.equal(formatHud(s, s.points[s.points.length - 1]), '曾文溪流域 2015 年 · 魚種數 59 · 隻次 2954')
  // 執行期 seriesMeta 形態（extra 展開在同一物件 / 帶 extra）也能讀到空窗區間
  const meta = { kind: s.kind, name: s.name, label: s.label, unit: s.unit, extra: s.extra, points: s.points, step: s.step }
  assert.equal(formatHud(meta, s.points[i2010]), txt)
  // 單一年空窗只寫該年；沒有 gaps 資訊的殘缺 meta 不會炸也不會出現 undefined
  const one = seriesFromSurvey(gapObj(Y([2003, 40], [2005, 20])), 'birds')
  assert.match(formatHud(one, one.points[1]), / · 無調查 2004$/)
  assert.doesNotMatch(formatHud({ kind: s.kind, name: s.name, label: s.label, unit: s.unit }, s.points[i2010]), /undefined|NaN|null/)
  for (const p of s.points) assert.doesNotMatch(formatHud(s, p), /undefined|null|NaN/)
})

test('survey 空窗：英文語系的 HUD 與時間軸文字替代都有譯文、不含中文', () => {
  const s = seriesFromSurvey(gapObj(ZW), 'fish')
  inEn(() => {
    const p = s.points.find((x) => x.t === '2010')
    assert.equal(formatHud(s, p), 'Zengwen River basin 2010 · no survey (interpolated) · Fish species ≈' + Math.round(p.v) + ' · No survey 2007–2013')
    assert.equal(formatHud(s, s.points[0]), 'Zengwen River basin 2004 · Fish species 69 · individuals 3585')
    assert.equal(timelineAlt(s), 'Survey years 2004, 2005, 2006, 2014, 2015; no survey 2007 to 2013')
    const flat = seriesFromSurvey(gapObj(Y([2012, 20], [2013, 18])), 'birds')
    assert.equal(timelineAlt(flat), 'Survey years 2012, 2013; surveyed every year, no gaps')
    for (const x of [...s.points.map((q) => formatHud(s, q)), timelineAlt(s), timelineAlt(flat)]) assert.ok(!HAN.test(x.replace(/曾文溪流域/g, '')), x)
  })
  assert.match(formatHud(s, s.points[5]), /無調查（內插）/)      // 切回中文不殘留
})

test('survey 連續年份（沒有空窗）：輸出與舊行為等價（每個調查年一點、v / n 原樣、stats 相同），gaps 為空', () => {
  const rows = Y([2012, 77, 4630], [2013, 62, 1955], [2014, 70], [2015, 55, 100])
  const s = seriesFromSurvey(gapObj(rows), 'birds')
  assert.deepEqual(s.points, rows.map((r) => ({ t: String(r.y), v: r.s, n: r.n, gap: false })))
  assert.deepEqual(s.extra.gaps, []); assert.deepEqual(s.extra.years, [2012, 2013, 2014, 2015])
  assert.deepEqual(s.stats, { min: 55, max: 77, mean: (77 + 62 + 70 + 55) / 4 })
  assert.equal(s.date.startsWith('2012–2015 '), true)
  assert.deepEqual(timelineLayout(s).bands, [])
  assert.equal(timelineAlt(s), '調查年度 2012、2013、2014、2015；連續調查，無空窗')
})

test('survey：單一調查年、空資料仍回 null；壞資料（同年重複 / 亂序 / 非數值 / 年份離譜）被整理或略過', () => {
  assert.equal(seriesFromSurvey(gapObj(Y([2005, 10])), 'birds'), null)
  assert.equal(seriesFromSurvey(gapObj(Y([2005, 10], [2005, 12])), 'birds'), null)            // 同一年兩筆 = 只有 1 個調查年
  assert.equal(seriesFromSurvey(gapObj([]), 'birds'), null)
  assert.equal(seriesFromSurvey({ name: 'x' }, 'birds'), null)
  assert.equal(seriesFromSurvey(null, 'birds'), null)
  assert.equal(seriesFromSurvey(gapObj(Y([1800, 5], [2015, 5])), 'birds'), null)             // 首尾差 > 120 年：資料異常
  const s = seriesFromSurvey(gapObj([{ y: 2007, s: 30, n: 3 }, { y: 2005, s: 10, n: 1 }, { y: 2006, s: NaN }, { y: 'x', s: 4 }, null, { y: 2005, s: 20, n: 2 }]), 'fish')
  assert.deepEqual(s.points.map((p) => [p.t, p.v, p.gap]), [['2005', 20, false], ['2006', 25, true], ['2007', 30, false]])   // 亂序排好、同年以後者為準、NaN / 非年份略過
})

test('survey 步進：逐年小步進（連續 13 年 ≈ 9 秒、5 年 ≈ 3.5 秒），空窗年不會把播放拖成冗長等待', () => {
  const dur = (years) => { const s = seriesFromSurvey(gapObj(years.map((y) => ({ y, s: 50, n: null }))), 'birds'); return s.points.length * s.step }
  const d13 = dur(Array.from({ length: 13 }, (_, i) => 2005 + i))
  assert.ok(d13 >= 8 && d13 <= 10, String(d13))
  const d5 = dur([2011, 2012, 2013, 2014, 2015])
  assert.ok(d5 >= 3 && d5 <= 4, String(d5))
  assert.ok(dur([2005, 2017]) === d13)                      // 只有頭尾兩個調查年、中間全是空窗：時長仍以日曆年計
})

// ---- 時間軸版面（SurveyTimeline 用的純函式）----
test('timelineLayout：依真實年份等比例（每年一格）；空窗區間成為 band；柱高依物種數', () => {
  const s = seriesFromSurvey(gapObj(ZW), 'fish')
  const L = timelineLayout(s)
  assert.equal(L.n, 12); assert.equal(L.first, 2004); assert.equal(L.last, 2015)
  assert.equal(L.slots.length, 12)
  L.slots.forEach((sl, i) => { assert.equal(sl.year, 2004 + i); assert.ok(Math.abs(sl.x - (i / 12) * 100) < 0.01); assert.ok(Math.abs(sl.w - 100 / 12) < 0.01) })
  assert.deepEqual(L.slots.map((sl) => sl.gap), [false, false, false, true, true, true, true, true, true, true, false, false])
  assert.equal(L.bands.length, 1)
  const b = L.bands[0]
  assert.deepEqual([b.a, b.b, b.i, b.len], [2007, 2013, 3, 7])
  assert.ok(Math.abs(b.x - 25) < 0.01 && Math.abs(b.w - (7 / 12) * 100) < 0.01)
  assert.equal(L.slots[0].h, 100)                                   // 2004 的 69 種是最大值
  assert.ok(L.slots[2].h < L.slots[0].h && L.slots.every((sl) => sl.h >= 8 && sl.h <= 100))
  assert.equal(timelineLayout(null), null); assert.equal(timelineLayout({ points: [{ t: '1', v: 1 }] }), null)
  assert.equal(timelineLayout(seriesFromDust({ history: hist([[T(9), 10, 1], [T(12), 20, 2]]) })), null)   // 不是調查年表
})

test('timelineAxis：頭尾年份一定在；標籤彼此不重疊；依年份排序', () => {
  const L = timelineLayout(seriesFromSurvey(gapObj(ZW), 'fish'))
  const ax = timelineAxis(L)
  assert.equal(ax[0].year, 2004); assert.equal(ax[ax.length - 1].year, 2015)
  assert.ok(ax.some((k) => k.year === 2006))
  for (let i = 1; i < ax.length; i++) assert.ok(ax[i].x - ax[i - 1].x >= 10 && ax[i].i > ax[i - 1].i)
  const dense = timelineAxis(timelineLayout(seriesFromSurvey(gapObj(Y([2002, 39], [2003, 21], [2017, 36], [2018, 24], [2019, 20])), 'fish')))
  assert.equal(dense[0].year, 2002); assert.equal(dense[dense.length - 1].year, 2019)
  for (let i = 1; i < dense.length; i++) assert.ok(dense[i].x - dense[i - 1].x >= 10)
  assert.deepEqual(timelineAxis(null), [])
})

test('playheadAt：游標隨播放頭連續掃過各年，idx 落在目前年份格、超出範圍時夾住', () => {
  const s = seriesFromSurvey(gapObj(ZW), 'fish'), L = timelineLayout(s)
  assert.deepEqual(playheadAt(L, 0, s.step), { idx: 0, x: 0 })
  const mid = playheadAt(L, s.step * 5.5, s.step)                   // 第 6 格（2009）走到一半
  assert.equal(mid.idx, 5); assert.ok(Math.abs(mid.x - (5.5 / 12) * 100) < 0.01)
  assert.deepEqual(playheadAt(L, s.step * 12, s.step), { idx: 11, x: 100 })
  assert.deepEqual(playheadAt(L, 999, s.step), { idx: 11, x: 100 })
  assert.deepEqual(playheadAt(L, -3, s.step), { idx: 0, x: 0 })
  assert.deepEqual(playheadAt(L, NaN, s.step), { idx: 0, x: 0 })
  assert.deepEqual(playheadAt(L, 1, 0), { idx: 0, x: 0 })
  // 與播放引擎同一公式：idx = floor(playhead / step)（DataHUD / 主迴圈用同一個）
  for (const ph of [0.1, 0.7, 1.39, 2.8, 7.7]) assert.equal(playheadAt(L, ph, s.step).idx, Math.floor(ph / s.step))
})

test('isSameSeries：執行期 seriesMeta 與調查卡的 spec 是不同物件，靠 kind / 名稱 / 頭尾年份對得起來', () => {
  const s = seriesFromSurvey(gapObj(ZW), 'fish')
  const meta = { kind: s.kind, name: s.name, points: s.points.slice() }
  assert.equal(isSameSeries(meta, seriesFromSurvey(gapObj(ZW), 'fish')), true)
  assert.equal(isSameSeries(meta, seriesFromSurvey(gapObj(ZW), 'birds')), false)                 // 鳥 / 魚不同
  assert.equal(isSameSeries(meta, seriesFromSurvey(gapObj(Y([2004, 1], [2015, 2])), 'fish')), false)   // 頭尾年份與年數相同、但數值不同
  assert.equal(isSameSeries(meta, seriesFromSurvey(gapObj(Y([2004, 69], [2006, 26])), 'fish')), false)  // 年數不同
  assert.equal(isSameSeries({ ...meta, name: '別條溪' }, s), false)
  assert.equal(isSameSeries(null, s), false); assert.equal(isSameSeries(meta, null), false); assert.equal(isSameSeries({ points: [] }, s), false)
})

test('timelineAlt / gapRangeText：文字替代 = 調查年度 + 空窗區間（多段 / 單年 / 無空窗）', () => {
  assert.equal(gapRangeText([2007, 2013]), '2007–2013'); assert.equal(gapRangeText([2010, 2010]), '2010')
  assert.equal(timelineAlt(seriesFromSurvey(gapObj(ZW), 'fish')), '調查年度 2004、2005、2006、2014、2015；2007 到 2013 無調查')
  assert.equal(timelineAlt(seriesFromSurvey(gapObj(Y([2000, 10], [2003, 40], [2005, 20])), 'fish')), '調查年度 2000、2003、2005；2001 到 2002、2004 無調查')
  assert.equal(timelineAlt(null), ''); assert.equal(timelineAlt({ extra: {} }), '')
})

// ---- 用真實的 public/data/ocean.json 做 smoke test（資料內容會隨 CI 改變，只驗結構與「不會炸」）----
test('real ocean.json：每個選項的海況參數 0..1、資料看板每一列都有文字且不含 undefined / NaN', () => {
  assert.ok(real.options.length >= 8)
  for (const o of real.options) {
    for (const [k, v] of Object.entries(o.params)) assert.ok(inUnit(v), `${o.id}.${k}=${v}`)
    const rows = describeBoard(real, o)
    assert.ok(rows.length >= 3, o.id)
    for (const r of rows) { assert.ok(r.k && r.v, `${o.id} ${JSON.stringify(r)}`); assert.doesNotMatch(r.v, /undefined|NaN|\[object/, `${o.id} ${r.k}`) }
    assert.equal(describeForLog(real, o).length, rows.length)
  }
})

test('real ocean.json：魚 / 鳥調查年表、月出月沒、測站目錄都能組成序列或清單', () => {
  for (const o of real.options) for (const kind of ['birds', 'fish']) {
    const d = o[kind]; assert.ok(d, `${o.id}.${kind}`)
    assert.equal(d.monthly.length, 12)
    const s = seriesFromSurvey(o, kind)
    if (d.yearly && d.yearly.length >= 2) {
      // 逐年稠密：從第一個到最後一個調查年，每個日曆年剛好一點；gaps 與 yearly 吻合
      const ys = [...new Set(d.yearly.map((y) => y.y))].sort((a, b) => a - b)
      assert.ok(s, `${o.id}.${kind}`)
      assert.equal(s.points.length, ys[ys.length - 1] - ys[0] + 1, `${o.id}.${kind}`)
      s.points.forEach((p, i) => { assert.equal(p.t, String(ys[0] + i), `${o.id}.${kind}[${i}]`); assert.equal(p.gap, !ys.includes(ys[0] + i)) })
      assert.deepEqual(s.extra.years, ys)
      const want = []
      for (let i = 1; i < ys.length; i++) if (ys[i] - ys[i - 1] > 1) want.push([ys[i - 1] + 1, ys[i] - 1])
      assert.deepEqual(s.extra.gaps, want, `${o.id}.${kind} gaps`)
      assert.equal(s.points.filter((p) => p.gap).length, want.reduce((n, [a, b]) => n + b - a + 1, 0))
      // 調查年的值 / 隻次原樣；統計只含真實調查年
      for (const y of d.yearly) { const p = s.points[y.y - ys[0]]; assert.equal(p.v, y.s); assert.equal(p.n, y.n == null ? null : y.n) }
      const real = ys.map((yr) => d.yearly.filter((y) => y.y === yr).pop().s)
      assert.ok(Math.abs(s.stats.mean - real.reduce((a, b) => a + b, 0) / real.length) < 1e-9, `${o.id}.${kind} mean`)
      assert.equal(s.stats.min, Math.min(...real)); assert.equal(s.stats.max, Math.max(...real))
      for (const p of s.points) if (p.gap) assert.ok(p.v >= s.stats.min && p.v <= s.stats.max && p.n === null)
      for (let i = 0; i < s.points.length; i++) for (const [, v] of automationFor(s, i)) assert.ok(inUnit(v), `${o.id}.${kind}[${i}]=${v}`)
      for (const p of s.points) assert.doesNotMatch(formatHud(s, p), /undefined|null|NaN/)
      const L = timelineLayout(s); assert.ok(L && L.n === s.points.length && L.bands.length === want.length, `${o.id}.${kind} layout`)
      assert.match(timelineAlt(s), /^調查年度 /)
    } else assert.equal(s, null)
  }
  const m = seriesFromMoon(real.moon)
  assert.ok(m && m.points.length === real.moon.days.length && m.points.length >= 100)
  assert.ok(real.moon.from <= real.moon.to)
  for (let i = 0; i < m.points.length; i += 7) for (const [, v] of automationFor(m, i)) assert.ok(inUnit(v))
  assert.ok(real.stations.list.length >= 100 && real.stations.list.every((s) => Math.abs(s.x) <= 0.51 && Math.abs(s.y) <= 0.51 && (s.s === 0 || s.s === 1)))
  const d = dustSummary(real.dust); assert.ok(d && d.n >= 1)
  const ds = seriesFromDust(real.dust)              // 歷史筆數會隨 CI 累積：null 或可播放序列都合法
  if (ds) for (let i = 0; i < ds.points.length; i++) for (const [, v] of automationFor(ds, i)) assert.ok(inUnit(v))
  for (const o of real.options) if (o.series) assert.ok(seriesFromOption(o), o.id)
})

test('describeBoard：月亮海況 → 今日月出 / 中天 / 月沒 + 由資料內插的現在位置；資料窗不含今日時誠實標示', () => {
  const days = [['2026-09-19', '12:56', 121, '18:12', 38, 'S', '23:29', 240], ['2026-09-20', '13:44', 120, '19:03', 39, 'S', '', null], ['2026-09-21', '14:30', 119, '19:52', 40, 'S', '00:22', 241]]
  const gov = { moon: { county: '花蓮縣', from: '2026-09-19', to: '2026-09-21', days } }
  const opt = { id: 'moon-hualien', name: '月亮 · 花蓮', kind: 'moon', params: {} }
  const rows = describeBoard(gov, opt, { now: new Date(2026, 8, 20, 16, 30) })
  const by = Object.fromEntries(rows.map((r) => [r.k, r.v]))
  assert.match(by['月亮'], /今日 · 月出 13:44 · 中天 19:03（仰角 39°S） · 月沒 —/)
  assert.match(by['位置'], /方位 \d+° · 仰角 \d+°/)
  assert.match(by['月相'], /月齡 \d+\.\d 天 · 資料 2026-09-19 → 2026-09-21（3 天）/)
  assert.match(describeBoard(gov, opt, { now: new Date(2026, 8, 20, 10, 0) }).find((r) => r.k === '位置').v, /地平線下/)   // 10:00 月還沒升
  const stale = describeBoard(gov, opt, { now: new Date(2027, 5, 1, 12, 0) })
  assert.match(stale.find((r) => r.k === '月亮').v, /不含今日，改用天文公式/)
  assert.equal(stale.some((r) => r.k === '位置'), false)
})

test('dust：來源凍結（時戳前進、數值不變）時序列仍可播放，但 stats 顯示無變化（UI 據此提示）', () => {
  const frozen = seriesFromDust({ county: '雲林縣', history: hist([[T(9), null, 5.34, 30, 71.5], [T(10), null, 5.34, 30, 71.5]]) })
  assert.ok(frozen); assert.equal(frozen.stats.max, frozen.stats.min)
  const moving = seriesFromDust({ county: '雲林縣', history: hist([[T(9), null, 5.34, 30, 71.5], [T(10), null, 6.1, 30, 71.5]]) })
  assert.ok(moving.stats.max > moving.stats.min)
})
