// 政府資料純函式的測試（離線、內嵌小型 fixture）。執行：node --test scripts/gov/gov.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeEntities, toNum, parseTaipeiTime, toTaipeiIso, addDays } from './util.mjs'
import { sensorKind, isValidReading, buildDust, dustParams, dustLevel, appendHistory } from './dust.mjs'
import { buildStations, parseTwd97 } from './stations.mjs'
import { buildSpeciesResolver, summarizeSurvey } from './survey.mjs'
import { buildMoon, moonWindow } from './moon.mjs'
import { stringifyOcean } from './json.mjs'
import { retry } from './http.mjs'
import { withSourceParts, appendParts, withBirdsNoteAppendix, ensureGovOptions } from './shape.mjs'
import { bakeStatic } from '../bake-static-data.mjs'

test('util：HTML 實體、嚴格數字、台北時間', () => {
  assert.equal(decodeEntities('許厝寮&#40;10號&#41;&amp;&#x41;&nbsp;&bogus;'), '許厝寮(10號)&A &bogus;')
  assert.equal(toNum(''), null)
  assert.equal(toNum('12abc'), null)
  assert.equal(toNum(' 4999.4 '), 4999.4)
  assert.equal(parseTaipeiTime('2026-09-20T14:50:00+08:00'), Date.parse('2026-09-20T06:50:00Z'))
  assert.equal(parseTaipeiTime('2026-09-20 14:50:00'), Date.parse('2026-09-20T06:50:00Z')) // 無時區 → 視為台北時間，不吃本機時區
  assert.equal(toTaipeiIso(Date.parse('2026-09-20T06:50:00Z')), '2026-09-20T14:50:00+08:00')
  assert.equal(addDays('2026-09-18', 180), '2027-03-17')
})

test('dust：sensorname + unit 對映物理量，不看 sensorfullname、單位矛盾則略過', () => {
  assert.equal(sensorKind('Pm10', 'μg／m3'), 'pm10') // 全形斜線
  assert.equal(sensorKind('風速', 'm/s'), 'wind')
  assert.equal(sensorKind('氣溫', '℃'), 'temp')
  assert.equal(sensorKind('相對溼度', '%'), 'rh')
  assert.equal(sensorKind('風速', '℃'), null)
  assert.equal(sensorKind('風向', '°'), null)
})

test('dust：有效範圍（哨兵值 4999.4、1957℃ 為無效）', () => {
  for (const [k, v, ok] of [
    ['pm10', 4999.4, false], ['pm10', 0, false], ['pm10', 3000, false], ['pm10', 2999, true], ['pm10', 0.5, true],
    ['wind', 0, true], ['wind', 60, true], ['wind', 60.1, false], ['wind', -1, false],
    ['temp', 1956.96, false], ['temp', -20, true], ['temp', 50, true], ['temp', 50.1, false],
    ['rh', 100, true], ['rh', 100.1, false], ['rh', -1, false],
  ]) assert.equal(isValidReading(k, v), ok, `${k}=${v}`)
})

const meta = (id, kind, unit, obs, extra = {}) => ({
  sensorid: id, sensorname: kind, unit, observatoryidentifier: obs.id, observatoryname: obs.name,
  longitude: '120.257266', latitude: '23.818382', countyname: '雲林縣', townname: '麥寮鄉', isenable: 'true', ...extra,
})
const A1 = { id: 'A1', name: '許厝寮&#40;10號&#41;堤防站' }, A2 = { id: 'A2', name: '中興村站' }
const T = '2026-09-20T14:50:00+08:00'

test('dust：join、依站合併、無效值為 null、統計', () => {
  const metaRows = [
    meta('S1', 'Pm10', 'μg／m3', A1), meta('S2', '風速', 'm/s', A1), meta('S3', '氣溫', '℃', A1), meta('S4', '相對溼度', '%', A1),
    meta('T1', 'Pm10', 'μg／m3', A2), meta('T2', '風速', 'm/s', A2),
    meta('X1', 'Pm10', 'μg／m3', { id: 'A3', name: '外縣市' }, { countyname: '嘉義縣' }),
    meta('D1', 'Pm10', 'μg／m3', { id: 'A4', name: '停用' }, { isenable: 'false' }),
  ]
  const latest = [
    { sensorid: 'S1', latestvalue: '4999.4', timestamp: T }, { sensorid: 'S2', latestvalue: '6.66', timestamp: T },
    { sensorid: 'S3', latestvalue: '1957.02', timestamp: T }, { sensorid: 'S4', latestvalue: '71.89', timestamp: T },
    { sensorid: 'T1', latestvalue: '80', timestamp: T }, { sensorid: 'T2', latestvalue: '4', timestamp: '2026-09-20T14:40:00+08:00' },
    { sensorid: 'ZZ', latestvalue: '1', timestamp: T }, { sensorid: 'X1', latestvalue: '50', timestamp: T }, { sensorid: 'D1', latestvalue: '50', timestamp: T },
  ]
  const { stations, summary, stats } = buildDust(latest, metaRows)
  assert.deepEqual(stations.map((s) => s.id), ['A1', 'A2'])
  assert.deepEqual(stations[0], { id: 'A1', name: '許厝寮(10號)堤防站', town: '麥寮鄉', lon: 120.2573, lat: 23.8184, pm10: null, wind: 6.66, temp: null, rh: 71.89, t: T })
  assert.deepEqual([stations[1].pm10, stations[1].wind, stations[1].temp, stations[1].rh, stations[1].t], [80, 4, null, null, T]) // 站 t = 該站最新時戳
  assert.deepEqual(summary, { t: T, pm10: 80, wind: 5.33, temp: null, rh: 71.89 })
  assert.deepEqual(stats, { sensors: 6, invalid: { pm10: 1, wind: 0, temp: 1, rh: 0 }, invalidTotal: 2, unmatched: 3 })
})

test('dust：level 與海況參數（缺值用預設 pm=40 / wind=3 / temp=25）', () => {
  assert.equal(dustLevel(null), 0)
  assert.equal(dustLevel(100.25), 100)
  const keys = ['seaLevel', 'current', 'flowX', 'flowY', 'clarity', 'glow', 'hue', 'jellyCount', 'fishCount', 'trashCount', 'swimSpeed', 'spin', 'zoom']
  const d = dustParams({})
  assert.deepEqual(Object.keys(d), keys)
  assert.deepEqual(d, dustParams({ pm10: 40, wind: 3, temp: 25 }))
  const p = dustParams({ pm10: 44, wind: 6, temp: 25 })
  assert.deepEqual([p.current, p.clarity, p.hue, p.jellyCount, p.fishCount, p.trashCount, p.swimSpeed], [0.5, 0.75, 0.43, 0.55, 0.59, 0.16, 0.64])
  const x = dustParams({ pm10: 5000, wind: 100, temp: 90 }) // 一律夾在 0..1
  assert.deepEqual([x.clarity, x.hue, x.fishCount, x.trashCount, x.current, x.jellyCount], [0, 0, 0, 1, 1, 1])
})

test('dust：history 滾動累積（同時戳不重複、依時間排序、保留最近 120 筆）', () => {
  const at = (h, v = 1) => ({ t: toTaipeiIso(Date.parse('2026-09-01T00:00:00Z') + h * 3600e3), pm10: v, wind: null, temp: null, rh: null })
  let h = []
  for (let i = 0; i < 125; i++) h = appendHistory(h, at(i * 3))
  assert.equal(h.length, 120)
  assert.equal(h.at(-1).t, at(124 * 3).t)
  assert.equal(appendHistory(h, at(124 * 3, 999)).length, 120) // 已有同時戳 → 不追加
  assert.equal(appendHistory(h, at(124 * 3, 999)).at(-1).pm10, 1) // 也不覆寫
  const mid = appendHistory(h, at(100 * 3 - 1)) // 插在中間
  assert.deepEqual(mid.map((x) => Date.parse(x.t)), mid.map((x) => Date.parse(x.t)).sort((a, b) => a - b))
  assert.deepEqual(Object.keys(appendHistory(undefined, at(0))[0]), ['t', 'pm10', 'wind', 'temp', 'rh'])
})

test('stations：座標解析、略過 0／無效座標、以較大邊為基準置中正規化', () => {
  assert.deepEqual(parseTwd97('304914.84 2764490.51'), { x: 304914.84, y: 2764490.51 })
  assert.equal(parseTwd97('0 0'), null)
  assert.equal(parseTwd97(''), null)
  assert.equal(parseTwd97('abc def'), null)
  const row = (n, xy, s, a) => ({ observatoryname: n, rivername: n + '溪', observationstatus: s, locationbytwd97_xy: xy, watershedarea: a })
  const r = buildStations([
    row('甲&#40;1&#41;', '100000.00 2500000.00', '現存', '12.34'),
    row('乙', '200000 2700000', '已廢', ''),
    row('丙', '0 0', '現存', '5'),
    row('丁', '', '現存', '5'),
    row('戊', '150000 2600000', '現存', '0.00'),
  ])
  assert.deepEqual([r.total, r.active, r.skipped], [3, 2, 2])
  assert.deepEqual(r.list, [
    { n: '甲(1)', r: '甲(1)溪', x: -0.25, y: -0.5, a: 12.34, s: 1 }, // Y 範圍較大 → 以 Y 為基準：y ∈ [-0.5, 0.5]，x 只佔 ±0.25
    { n: '乙', r: '乙溪', x: 0.25, y: 0.5, a: null, s: 0 },
    { n: '戊', r: '戊溪', x: 0, y: 0, a: null, s: 1 }, // 集水面積 0 → null
  ])
})

const mk = (i, date, number, extra = {}) => ({ basinname: 'B', date, number, scientificnamecode: 'C' + i, speciesuniversename: 'sp' + i, speciesscientificname: 'Sci ' + i, remarks: '', ...extra })

test('survey：物種身分（字面 NULL、別名順序、同名不同碼、退回學名）', () => {
  const r = (o) => ({ scientificnamecode: 'C1', speciesuniversename: '蛇鵰;大冠鷲', speciesscientificname: 'Spilornis cheela', ...o })
  const keyOf = buildSpeciesResolver([
    r({}), r({ speciesuniversename: '大冠鷲;蛇鵰' }), r({ speciesuniversename: 'NULL' }),
    r({ scientificnamecode: 'C2', speciesuniversename: '灰鶺鴒' }), r({ scientificnamecode: 'C3', speciesuniversename: '灰鶺鴒' }),
    r({ scientificnamecode: 'C4', speciesuniversename: 'NULL', speciesscientificname: 'Foo bar' }),
  ])
  const k1 = keyOf(r({}))
  assert.equal(keyOf(r({ speciesuniversename: '大冠鷲;蛇鵰' })), k1)
  assert.equal(keyOf(r({ speciesuniversename: 'NULL' })), k1) // NULL 的列以代碼對回本名，不被當成一個「物種」
  assert.equal(keyOf(r({ scientificnamecode: 'C2', speciesuniversename: '灰鶺鴒' })), keyOf(r({ scientificnamecode: 'C3', speciesuniversename: '灰鶺鴒' })))
  assert.equal(keyOf(r({ scientificnamecode: 'C4', speciesuniversename: 'NULL', speciesscientificname: 'Foo bar' })), 's:Foo bar')
  assert.equal(keyOf({ speciesuniversename: 'NULL' }), null)
})

test('survey：number=0 不算觀測、空白 number 算物種但不計隻次、月／年門檻、未記錄日期不入逐月', () => {
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => mk(i, '2016/2/10 00:00', '2')),
    mk(6, '2016/2/11 00:00', '0'), // 0 隻（訪談提及）→ 不計
    mk(7, '2016/2/12 00:00', ''), // 空白 → 物種 +1、隻次不加
    ...Array.from({ length: 3 }, (_, i) => mk(10 + i, '2016/3/5 00:00', '1')), // 3 筆 < 門檻 5
    ...Array.from({ length: 5 }, (_, i) => mk(i, '2018/2/1 00:00', '3')),
    mk(20, '2018/6/1 00:00', '4', { remarks: '春季(無記錄日期)' }), // 日期是佔位值：不入逐月，仍入逐年
  ]
  const s = summarizeSurvey(rows, buildSpeciesResolver(rows), { minRecords: 5 })
  assert.deepEqual([s.species, s.count, s.records], [11, 34, 16])
  assert.deepEqual(s.monthly, [null, 7, null, null, null, null, null, null, null, null, null, null])
  assert.deepEqual(s.yearly, [{ y: 2016, s: 10, n: 15 }, { y: 2018, s: 6, n: 19 }])
  const blank = Array.from({ length: 5 }, (_, i) => mk(i, '2019/4/1 00:00', ''))
  assert.deepEqual(summarizeSurvey(blank, buildSpeciesResolver(blank), { minRecords: 5 }).yearly, [{ y: 2019, s: 5, n: null }]) // 全空 → null
})

test('moon：拆 "41S"、空字串、排序去重、找不到縣市回 null、視窗以台北日期計', () => {
  const day = (Date, rise, riseAz, transit, alt, set, setAz) => ({ Date, MoonRiseTime: rise, MoonRiseAZ: riseAz, MoonTransitTime: transit, MoonTransitAlt: alt, MoonSetTime: set, MoonSetAZ: setAz })
  const loc = [
    { CountyName: '臺北市', time: [day('2026-01-01', '01:00', '90', '07:00', '10S', '13:00', '270')] },
    { CountyName: '花蓮縣', time: [
      day('2026-09-21', '14:29', '119', '19:53', '41S', '00:29', '241'),
      day('2026-09-20', '13:44', '120', '19:03', '39S', '', ''),
      day('2026-10-04', '', '', '06:12', '88N', '13:17', '298'),
      day('2026-09-20', '13:44', '120', '19:03', '39S', '', ''), // 重複日期
      day('not-a-date', '', '', '', '', '', ''),
    ] },
  ]
  const expected = {
    county: '花蓮縣', from: '2026-09-20', to: '2026-10-04',
    days: [
      ['2026-09-20', '13:44', 120, '19:03', 39, 'S', '', null],
      ['2026-09-21', '14:29', 119, '19:53', 41, 'S', '00:29', 241],
      ['2026-10-04', '', null, '06:12', 88, 'N', '13:17', 298],
    ],
  }
  assert.deepEqual(buildMoon({ records: { locations: { location: loc } } }), expected) // datastore API 外殼
  assert.deepEqual(buildMoon({ cwaopendata: { dataset: { location: loc } } }), expected) // 公開檔外殼
  assert.equal(buildMoon({ records: { locations: { location: loc } } }, '不存在縣'), null)
  assert.equal(buildMoon({ records: { locations: { location: [] } } }), null)
  assert.deepEqual(moonWindow(Date.parse('2026-09-20T12:00:00+08:00')), { from: '2026-09-18', to: '2027-03-17' })
  assert.deepEqual(moonWindow(Date.parse('2026-09-20T00:10:00+08:00')), { from: '2026-09-18', to: '2027-03-17' }) // 台北 00:10 = UTC 前一天，仍以台北日期計
})

test('http：retry 對空內容 / 5xx 類錯誤重試，4xx 不重試，用盡次數後丟出最後一個錯誤', async () => {
  const quiet = { delayMs: 1, log: () => {} }
  let n = 0
  assert.equal(await retry(async () => { if (++n < 3) throw new Error('Unexpected end of JSON input'); return 'ok' }, { attempts: 3, ...quiet }), 'ok')
  assert.equal(n, 3)
  n = 0
  await assert.rejects(retry(async () => { n++; throw Object.assign(new Error('HTTP 401'), { status: 401 }) }, { attempts: 3, ...quiet }), /401/)
  assert.equal(n, 1) // 金鑰錯誤等 4xx：不重試，交給呼叫端換備援
  n = 0
  await assert.rejects(retry(async () => { n++; throw Object.assign(new Error('HTTP 503'), { status: 503 }) }, { attempts: 2, ...quiet }), /503/)
  assert.equal(n, 2)
})

test('json：等同 JSON.stringify(v,null,2)，只把指定路徑的資料列收成單行', () => {
  const obj = { a: 1, gone: undefined, rows: [[1, 'x', null], [2, 'y', 3]], moon: { days: [['2026-09-20', '13:44', 120, '19:03', 39, 'S', '', null]] }, e: [], o: {}, n: null, arr: [1, undefined] }
  assert.equal(stringifyOcean(obj, []), JSON.stringify(obj, null, 2) + '\n')
  const s = stringifyOcean(obj)
  assert.deepEqual(JSON.parse(s), JSON.parse(JSON.stringify(obj)))
  assert.match(s, /\n {6}\["2026-09-20","13:44",120,"19:03",39,"S","",null\]\n/) // moon.days.* 單行
  assert.match(s, /"rows": \[\n {4}\[\n/) // 其他路徑維持展開
})

test('shape：說明文字補充皆為冪等，新選項只補一次', () => {
  const src = 'A + B（政府資料 OGDL v1）'
  assert.equal(withSourceParts(src, ['C', 'B']), 'A + B + C（政府資料 OGDL v1）')
  assert.equal(withSourceParts(withSourceParts(src, ['C']), ['C']), 'A + B + C（政府資料 OGDL v1）')
  assert.equal(withSourceParts('A + B', ['C']), 'A + B + C')
  assert.equal(appendParts('x · y', ['y', 'z']), 'x · y · z')
  assert.equal(withBirdsNoteAppendix(withBirdsNoteAppendix('舊文', '新1'), '新2'), '舊文 【逐年與魚類】新2')
  const opts = ensureGovOptions([{ id: 'feitsui' }])
  assert.deepEqual(opts.map((o) => o.id), ['feitsui', 'dust-yunlin', 'moon-hualien'])
  assert.equal(ensureGovOptions(opts).length, 3)
  for (const o of opts.slice(1)) assert.equal(Object.keys(o.params).length, 13)
})

test('bake：既有 birds 原值不動只補 yearly、同流域新選項沿用同一組、筆數不足不附、冪等、不改動輸入', () => {
  const legacy = { basin: '花蓮溪流域', species: 129, count: 1395, monthly: [82, 39, null, 74, null, null, 41, null, null, null, null, null], monthlyBasin: '花蓮溪' }
  const cur = {
    source: 'S（授權）', mapping: 'm', birdsNote: '舊',
    options: [
      { id: 'hualien-tide', name: '花蓮外海', region: '東', level: 68, params: {}, kind: 'tide', birds: structuredClone(legacy) },
      { id: 'deji', name: '德基水庫', region: '中', level: 98.5, params: {} },
    ],
  }
  const rowsFor = (basin, n, year, number) => Array.from({ length: n }, (_, i) => ({
    basinname: basin, date: `${year}/${(i % 3) + 1}/5 00:00`, number, scientificnamecode: 'C' + (i % 30),
    speciesuniversename: 'sp' + (i % 30), speciesscientificname: 'Sci ' + (i % 30), remarks: '',
  }))
  const data = {
    flowRows: [{ observatoryname: '甲', rivername: '甲溪', observationstatus: '現存', locationbytwd97_xy: '250000 2600000', watershedarea: '1' }],
    birdRows: [...rowsFor('花蓮溪', 100, 2017, '2'), ...rowsFor('大甲溪', 10, 2012, '2')], // 大甲溪只有 10 筆 → 不附
    fishRows: [...rowsFor('花蓮溪', 80, 2018, '2'), ...rowsFor('大甲溪', 10, 2012, '2')],
  }
  const frozen = structuredClone(cur)
  const { ocean } = bakeStatic(cur, data)
  assert.deepEqual(cur, frozen) // 輸入不被改動

  const byId = (id) => ocean.options.find((o) => o.id === id)
  assert.deepEqual(ocean.options.map((o) => o.id), ['hualien-tide', 'deji', 'dust-yunlin', 'moon-hualien'])
  const yearly = [{ y: 2017, s: 30, n: 200 }]
  assert.deepEqual(byId('hualien-tide').birds, { ...legacy, yearly }) // 原值一律不動
  assert.deepEqual(byId('moon-hualien').birds, { ...legacy, yearly }) // 同流域 → 沿用同一組（不會出現兩個不同的花蓮溪數字）
  const fish = { basin: '花蓮溪流域', species: 30, count: 160, monthly: Array(12).fill(null), yearly: [{ y: 2018, s: 30, n: 160 }] }
  assert.deepEqual(byId('hualien-tide').fish, fish)
  assert.deepEqual(byId('moon-hualien').fish, fish)
  assert.equal(byId('deji').birds, undefined)
  assert.equal(byId('deji').fish, undefined)
  assert.equal(byId('dust-yunlin').fish, undefined) // 濁水溪沒有資料
  assert.deepEqual([ocean.stations.total, ocean.stations.active], [1, 1])
  assert.ok(ocean.mapping.includes('魚類調查→魚群') && ocean.source.includes('水利署魚類調查') && ocean.birdsNote.startsWith('舊 【逐年與魚類】'))
  assert.deepEqual(bakeStatic(ocean, data).ocean, ocean) // 冪等
})
