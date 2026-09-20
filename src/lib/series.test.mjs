// 資料 → 播放序列 / 輸出顯示文字 的單元測試。執行：node --test src/lib/series.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { seriesFromOption, seriesFromSurvey, seriesFromDust, seriesFromMoon, automationFor, formatHud } from './series.js'
import { describeBoard, describeForLog, dustSummary } from './describe.js'

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
      assert.ok(s && s.points.length === d.yearly.length, `${o.id}.${kind}`)
      for (let i = 0; i < s.points.length; i++) for (const [, v] of automationFor(s, i)) assert.ok(inUnit(v), `${o.id}.${kind}[${i}]=${v}`)
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
