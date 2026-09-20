// 空氣品質（Open-Meteo / CAMS 模型資料）資料端的測試（離線、內嵌 fixture）。執行：node --test scripts/gov/air.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildAirUrl, parseAir, validate, mergeHistory, latestAirRow, airMap, airParams, airLevel,
  AIR_SOURCE, AIR_SOURCE_URL, AIR_NOTE, AIR_HISTORY_MAX, AIR_PM_SCALE, AIR_INLINE_PATHS, AIR_LAT, AIR_LON, AIR_COUNTY, AIR_PLACE,
} from './air.mjs'
import { dustParams } from './dust.mjs'
import { stringifyOcean, INLINE_PATHS } from './json.mjs'
import {
  GOV_OPTIONS, AIR_OPTION, AIR_OPTION_ID, AIR_MAPPING, AIR_SOURCE_DISCLOSURE, TOP_KEYS, OPTION_KEYS,
  ensureGovOptions, ensureAirOption, syncAirOption, appendParts, orderTop, withSourceParts,
} from './shape.mjs'
import { refreshAir } from '../fetch-ocean-data.mjs'

const NOW = Date.parse('2026-09-20T21:30:00+08:00')
const iso = (h, d = 20) => `2026-09-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00+08:00`
const row = (h, pm25, pm10 = pm25 + 3, dust = 0, aqi = 80, d = 20) => ({ t: iso(h, d), pm10, pm25, dust, aqi })
const api = (hourly = {}, extra = {}) => ({
  latitude: 23.8, longitude: 120.3, utc_offset_seconds: 28800, timezone: 'Asia/Taipei',
  hourly: {
    time: ['2026-09-20T18:00', '2026-09-20T19:00', '2026-09-20T20:00', '2026-09-20T21:00', '2026-09-20T22:00'],
    pm10: [25.1, 26.4, 27, 27, 31.1], pm2_5: [22.8, 22.2, 21.7, 23.8, 28.3], dust: [0, 0, 0, 0, 0], us_aqi: [93, 100, 98, 89, 89], ...hourly,
  },
  ...extra,
})

test('buildAirUrl：與實測可用的請求一致（逗號原樣、台北時區）；座標不合法丟 RangeError；天數夾在 API 允許範圍', () => {
  assert.equal(buildAirUrl(), 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=23.79&longitude=120.25&hourly=pm10,pm2_5,dust,us_aqi&past_days=5&forecast_days=1&timezone=Asia%2FTaipei')
  assert.equal(buildAirUrl({ lat: 25.03, lon: 121.56, pastDays: 2, forecastDays: 3 }), 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=25.03&longitude=121.56&hourly=pm10,pm2_5,dust,us_aqi&past_days=2&forecast_days=3&timezone=Asia%2FTaipei')
  assert.equal(buildAirUrl({ lat: '23.79', lon: '120.25' }), buildAirUrl())            // 數字字串也收
  assert.match(buildAirUrl({ pastDays: 999, forecastDays: 0 }), /past_days=92&forecast_days=1&/)
  assert.match(buildAirUrl({ pastDays: -3, forecastDays: 99 }), /past_days=0&forecast_days=7&/)
  assert.match(buildAirUrl({ pastDays: 'x' }), /past_days=5&/)                          // 不是數字 → 預設
  for (const bad of [{ lat: 91 }, { lat: -91 }, { lon: 181 }, { lon: -181 }, { lat: NaN }, { lat: null }, { lon: 'abc' }, { lat: '' }]) assert.throws(() => buildAirUrl(bad), RangeError, JSON.stringify(bad))
  assert.equal([AIR_LAT, AIR_LON, AIR_COUNTY, AIR_PLACE].join(), '23.79,120.25,雲林縣,麥寮')
})

test('validate：PM / 沙塵 / AQI 的範圍（0–1000 含端點）、型別（只收 number 與數字字串）、四捨五入', () => {
  for (const kind of ['pm10', 'pm25', 'dust', 'aqi']) {
    assert.equal(validate(kind, 0), 0)
    assert.equal(validate(kind, 1000), 1000)
    for (const bad of [-0.1, 1000.1, 4999.4, Infinity, -Infinity, NaN, null, undefined, '', ' ', 'abc', '12abc', true, false, [5], [], {}, () => 1]) assert.equal(validate(kind, bad), null, `${kind} ${String(bad)}`)
  }
  assert.equal(validate('pm25', 23.84), 23.8)
  assert.equal(validate('pm25', ' 21.26 '), 21.3)   // 數字字串（含空白）
  assert.equal(validate('aqi', 71.6), 72)           // AQI 是整數指標
  assert.equal(validate('nope', 5), null)
})

test('parseAir：正常回應 → 時間遞增的逐時列、時間補成 +08:00、值不動', () => {
  const { rows, stats } = parseAir(api())
  assert.deepEqual(rows.map((r) => r.t), [iso(18), iso(19), iso(20), iso(21), iso(22)])
  assert.deepEqual(rows[0], { t: iso(18), pm10: 25.1, pm25: 22.8, dust: 0, aqi: 93 })
  assert.deepEqual(Object.keys(rows[0]), ['t', 'pm10', 'pm25', 'dust', 'aqi'])      // 契約的欄位名與順序
  assert.deepEqual(stats, { points: 5, valid: 5, skipped: 0 })
})

test('parseAir：缺值 / 型別錯誤 / 超出範圍的欄位 → null；全欄位無效的小時略過；重複時間以後者為準；亂序會排好', () => {
  const j = api({
    time: ['2026-09-20T03:00', '2026-09-20T01:00', '2026-09-20T02:00', '2026-09-20T02:00', '2026-09-20T04:00', '2026-09-20T05:00', '2026-09-20T06:00'],
    pm10: [10, '11.5', 4999.4, 12, null, 'oops', 20],
    pm2_5: [8, true, -5, 9, undefined, null, [3]],
    dust: [0, 0, 0, 0, 0, 0, 0],
    us_aqi: [40, 41, 1e9, 42, null, {}, 44],
  })
  j.hourly.dust[5] = null; j.hourly.dust[4] = null     // 04:00、05:00：四個欄位都無效
  const { rows, stats } = parseAir(j)
  assert.deepEqual(rows.map((r) => r.t), [iso(1), iso(2), iso(3), iso(6)])
  assert.deepEqual(rows[0], { t: iso(1), pm10: 11.5, pm25: null, dust: 0, aqi: 41 })    // true 不算數字、'11.5' 收
  assert.deepEqual(rows[1], { t: iso(2), pm10: 12, pm25: 9, dust: 0, aqi: 42 })         // 02:00 重複：後者（第 4 筆）覆蓋
  assert.deepEqual(rows[3], { t: iso(6), pm10: 20, pm25: null, dust: 0, aqi: 44 })      // [3]（陣列）不當 3
  assert.deepEqual(stats, { points: 7, valid: 4, skipped: 2 })
})

test('parseAir：欄位缺失 / 長度不齊 / 全是 null → 不炸；壞外殼 → 空', () => {
  // 沒有 dust / us_aqi 欄位、pm2_5 比 time 短
  const short = parseAir({ hourly: { time: ['2026-09-20T01:00', '2026-09-20T02:00', '2026-09-20T03:00'], pm10: [1, 2, 3], pm2_5: [1] } })
  assert.deepEqual(short.rows.map((r) => [r.pm10, r.pm25, r.dust, r.aqi]), [[1, 1, null, null], [2, null, null, null], [3, null, null, null]])
  // 全是 null
  const allNull = parseAir(api({ pm10: [null, null, null, null, null], pm2_5: [null, null, null, null, null], dust: [null, null, null, null, null], us_aqi: [null, null, null, null, null] }))
  assert.deepEqual(allNull.rows, []); assert.equal(allNull.stats.skipped, 5)
  for (const junk of [null, undefined, 5, 'x', [], {}, { hourly: null }, { hourly: 'x' }, { hourly: {} }, { hourly: { time: 'x' } }, { hourly: { time: {} } }, { hourly: { time: [] } }]) {
    assert.deepEqual(parseAir(junk).rows, [], JSON.stringify(junk))
  }
})

test('parseAir：不合法的時間略過（含不存在的日期 / 25 點）；秒數、空白分隔、每小時內的分鐘都收成整點；utc_offset_seconds 不是 8 小時時換算成台北時間', () => {
  const bad = parseAir(api({ time: ['2026-02-30T01:00', '2026-09-20T25:00', 'nope', null, 12, '2026-13-01T00:00', '2026-09-20T01:00'], pm10: [1, 2, 3, 4, 5, 6, 7], pm2_5: [1, 2, 3, 4, 5, 6, 7], dust: [], us_aqi: [] }))
  assert.deepEqual(bad.rows.map((r) => [r.t, r.pm25]), [[iso(1), 7]]); assert.equal(bad.stats.skipped, 6)
  const odd = parseAir(api({ time: ['2026-09-20 01:00:00', '2026-09-20T02:45', '2026-09-20T03:00:30'], pm2_5: [1, 2, 3], pm10: [], dust: [], us_aqi: [] }))
  assert.deepEqual(odd.rows.map((r) => r.t), [iso(1), iso(2), iso(3)])
  const utc = parseAir(api({ time: ['2026-09-20T00:00', '2026-09-20T16:00'], pm2_5: [5, 6], pm10: [], dust: [], us_aqi: [] }, { utc_offset_seconds: 0 }))   // 回應是 UTC → 台北 +8
  assert.deepEqual(utc.rows.map((r) => r.t), [iso(8), iso(0, 21)])
  const noOff = parseAir(api({}, { utc_offset_seconds: undefined }))      // 沒給偏移 → 視為台北時間
  assert.equal(noOff.rows[0].t, iso(18))
})

test('mergeHistory：依小時去重（新覆蓋舊；新資料缺欄位保留舊值；整列無效的新資料不覆蓋）、遞增、丟掉未來小時、不改動輸入', () => {
  const old = [row(19, 20), row(20, 21), row(21, 22)]
  const fresh = [{ ...row(20, 25, 30) }, { t: iso(21), pm10: null, pm25: 23.8, dust: null, aqi: null }, { t: iso(19), pm10: null, pm25: null, dust: null, aqi: null }, row(22, 40), row(23, 41)]
  const before = structuredClone([old, fresh])
  const out = mergeHistory(old, fresh, { nowMs: NOW })
  assert.deepEqual(before, [old, fresh])                                              // 輸入沒被改
  assert.deepEqual(out.map((r) => r.t), [iso(19), iso(20), iso(21)])                  // 22、23 點是預報（現在 21:30）→ 丟掉
  assert.deepEqual(out[0], row(19, 20))                                               // 全 null 的新資料不覆蓋舊的
  assert.deepEqual(out[1], row(20, 25, 30, 0, 80))                                    // 新覆蓋舊
  assert.deepEqual(out[2], { t: iso(21), pm10: 25, pm25: 23.8, dust: 0, aqi: 80 })    // 新資料缺欄位 → 保留舊值（pm10 的 22+3、aqi 80）
})

test('mergeHistory：「現在」的邊界——現在 21:30 → 21:00 那一小時保留、22:00 丟掉；剛好整點也保留該小時', () => {
  const all = [row(20, 1), row(21, 2), row(22, 3)]
  assert.deepEqual(mergeHistory([], all, { nowMs: NOW }).map((r) => r.t), [iso(20), iso(21)])
  assert.deepEqual(mergeHistory([], all, { nowMs: Date.parse(iso(22)) }).map((r) => r.t), [iso(20), iso(21), iso(22)])
  assert.deepEqual(mergeHistory([], all, { nowMs: Date.parse(iso(22)) - 1 }).map((r) => r.t), [iso(20), iso(21)])
  assert.deepEqual(mergeHistory([], all, { nowMs: Date.parse(iso(0, 19)) }), [])          // 全都在未來
  assert.ok(Array.isArray(mergeHistory([], all, { nowMs: NaN })))                          // nowMs 壞掉 → 退回真正的現在，不炸
})

test('mergeHistory：只留最近 120 筆（預設）；可指定 max；亂序輸入會排好；舊檔裡的壞資料被清掉；時區寫法統一成 +08:00', () => {
  const hours = Array.from({ length: 150 }, (_, i) => ({ t: new Date(Date.parse('2026-09-14T00:00:00+08:00') + i * 3600e3).toISOString(), pm10: 20, pm25: 10 + (i % 7), dust: 0, aqi: 50 }))   // UTC 'Z' 寫法
  const shuffled = [...hours].reverse()
  const out = mergeHistory(shuffled, [], { nowMs: Date.parse('2026-09-21T00:00:00+08:00') })   // 150 小時全在過去
  assert.equal(out.length, AIR_HISTORY_MAX); assert.equal(AIR_HISTORY_MAX, 120)
  assert.equal(out[out.length - 1].t, '2026-09-20T05:00:00+08:00')                            // 第 150 小時（index 149）= 09-14 00:00 + 149h
  assert.match(out[0].t, /\+08:00$/)
  assert.ok(out.every((r, i) => i === 0 || Date.parse(out[i - 1].t) < Date.parse(r.t)), '嚴格遞增')
  assert.equal(mergeHistory(shuffled, [], { nowMs: Date.parse('2026-09-21T00:00:00+08:00'), max: 5 }).length, 5)
  assert.equal(mergeHistory(shuffled, [], { nowMs: Date.parse('2026-09-21T00:00:00+08:00'), max: 0 }).length, 0)      // slice(-0) 陷阱
  assert.equal(mergeHistory(shuffled, [], { nowMs: Date.parse('2026-09-21T00:00:00+08:00'), max: NaN }).length, 120)   // 壞的 max → 預設
  const dirty = mergeHistory([null, 5, 'x', {}, { t: 'bad', pm25: 5 }, { t: iso(1), pm25: 4999.4, pm10: -1 }, { t: iso(2), pm25: '9.44', pm10: 'x' }, { t: `2026-09-20T03:20:00+08:00`, pm25: 7 }], undefined, { nowMs: NOW })
  assert.deepEqual(dirty, [{ t: iso(2), pm10: null, pm25: 9.4, dust: null, aqi: null }, { t: iso(3), pm10: null, pm25: 7, dust: null, aqi: null }])   // 哨兵 / 負值 → null 後整列無效被丟；03:20 收成 03:00
  for (const junk of [undefined, null, 5, 'x', {}]) assert.deepEqual(mergeHistory(junk, junk, { nowMs: NOW }), [])
})

test('latestAirRow：最新一筆有 PM2.5 的小時', () => {
  const h = [row(19, 20), row(20, 21), { t: iso(21), pm10: 30, pm25: null, dust: 0, aqi: 60 }]
  assert.equal(latestAirRow(h).t, iso(20))
  assert.equal(latestAirRow([{ t: iso(1), pm10: 5, pm25: null }]), null)
  assert.equal(latestAirRow(null), null); assert.equal(latestAirRow([null, {}]), null)
})

test('airParams：13 個鍵（與揚塵選項同一組）、皆 0..1、2 位小數；PM2.5 越高越混濁 / 垃圾多 / 色相偏黃綠 / 輝光收斂；風速 → 洋流', () => {
  const keys = ['clarity', 'current', 'fishCount', 'flowX', 'flowY', 'glow', 'hue', 'jellyCount', 'seaLevel', 'spin', 'swimSpeed', 'trashCount', 'zoom']
  assert.deepEqual(Object.keys(airParams({ pm25: 20, wind: 3 })).sort(), keys)
  assert.deepEqual(Object.keys(airParams({})).sort(), Object.keys(dustParams({})).sort())
  const lvls = [0, 5, 12, 20, 35, 55, 80, 100, 250, 1000]
  for (const pm25 of lvls) for (const wind of [0, 0.89, 3, 6, 12, 40]) {
    const p = airParams({ pm25, wind })
    for (const [k, v] of Object.entries(p)) { assert.ok(v >= 0 && v <= 1, `${k}=${v}`); assert.equal(v, Math.round(v * 100) / 100, `${k} 兩位小數`) }
  }
  const ps = lvls.map((pm25) => airParams({ pm25, wind: 3 }))
  for (let i = 1; i < ps.length; i++) {
    assert.ok(ps[i].clarity <= ps[i - 1].clarity && ps[i].glow <= ps[i - 1].glow && ps[i].hue <= ps[i - 1].hue, `PM2.5 ${lvls[i]} 應不比 ${lvls[i - 1]} 更清澈 / 更亮`)
    assert.ok(ps[i].trashCount >= ps[i - 1].trashCount && ps[i].fishCount <= ps[i - 1].fishCount)
  }
  // 動態範圍：台灣常見的 5 → 60 μg/m³ 之間要有明顯視覺差（清澈差 > 0.4、垃圾差 > 0.25、輝光差 > 0.15）
  const lo = airParams({ pm25: 5 }), hi = airParams({ pm25: 60 })
  assert.ok(lo.clarity - hi.clarity > 0.4 && hi.trashCount - lo.trashCount > 0.25 && lo.glow - hi.glow > 0.15 && lo.hue > hi.hue, JSON.stringify([lo, hi]))
  // 風速 → 洋流 / 游速
  assert.ok(airParams({ wind: 8 }).current > airParams({ wind: 1 }).current && airParams({ wind: 8 }).swimSpeed > airParams({ wind: 1 }).swimSpeed)
  assert.equal(airParams({ pm25: 21, wind: 0.89 }).clarity, 0.77)
  // 缺值 / 壞值 → 預設（pm25=15、wind=3），不出 NaN
  for (const bad of [undefined, null, 'x', NaN, [], {}, true]) assert.deepEqual(airParams({ pm25: bad, wind: bad }), airParams({ pm25: 15, wind: 3 }), String(bad))
  assert.deepEqual(airParams(), airParams({}))
  assert.equal(AIR_PM_SCALE, 100)
  assert.deepEqual(airMap(undefined), airMap(15))
})

test('airLevel：最新 PM2.5 四捨五入；沒有 → 0', () => {
  assert.equal(airLevel(23.8), 24); assert.equal(airLevel(23.4), 23); assert.equal(airLevel(0), 0)
  for (const bad of [null, undefined, NaN, 'x', {}, []]) assert.equal(airLevel(bad), 0)
})

test('誠實標示：來源與說明都寫「模型資料、非政府觀測值」、授權 CC BY 4.0 與歸屬', () => {
  for (const s of [AIR_SOURCE, AIR_NOTE]) assert.ok(s.includes('模型資料') && s.includes('非政府') && s.includes('CC BY 4.0'), s)
  assert.ok(AIR_SOURCE.includes('Open-Meteo') && AIR_SOURCE.includes('CAMS'))
  assert.ok(AIR_NOTE.includes('Weather data by Open-Meteo.com') && AIR_NOTE.includes('US AQI') && AIR_NOTE.includes('不是環境部 AQI'))
  assert.ok(AIR_SOURCE_DISCLOSURE.includes('非政府觀測值') && AIR_SOURCE_DISCLOSURE.includes('Weather data by Open-Meteo.com'))
  assert.equal(AIR_SOURCE_URL, 'https://open-meteo.com/en/docs/air-quality-api')
  assert.ok(AIR_MAPPING.includes('模型資料'))
})

test('shape：空氣品質選項不進 GOV_OPTIONS（既有清單與 bake 的 id 不變）；ensureAirOption 只補一次、放最後、鍵順序與 13 個參數正確', () => {
  assert.deepEqual(GOV_OPTIONS.map((o) => o.id), ['dust-yunlin', 'moon-hualien'])
  assert.deepEqual(ensureGovOptions([{ id: 'feitsui' }]).map((o) => o.id), ['feitsui', 'dust-yunlin', 'moon-hualien'])
  const opts = ensureGovOptions([{ id: 'feitsui' }])
  const o = ensureAirOption(opts)
  assert.deepEqual(opts.map((x) => x.id), ['feitsui', 'dust-yunlin', 'moon-hualien', 'air-yunlin'])
  assert.equal(ensureAirOption(opts), o); assert.equal(opts.length, 4)                   // 冪等，回傳同一個物件
  assert.deepEqual(Object.keys(o), OPTION_KEYS.filter((k) => k in o))
  assert.deepEqual([o.id, o.name, o.region, o.kind, o.level], ['air-yunlin', '空氣品質 · 雲林', '中', 'air', 0])
  assert.equal(Object.keys(o.params).length, 13)
  assert.notEqual(o.params, AIR_OPTION.params); assert.equal(AIR_OPTION_ID, 'air-yunlin')   // 是複製，改它不會污染常數
  assert.ok(TOP_KEYS.indexOf('air') > TOP_KEYS.indexOf('moon'))
})

test('shape：syncAirOption 從同流域（揚塵）選項「複製」birds / fish；level / params 有給才寫；同流域沒有就不動', () => {
  const dust = { id: 'dust-yunlin', birds: { basin: '濁水溪流域', species: 89, yearly: [{ y: 2004, s: 60, n: 100 }] }, fish: { basin: '濁水溪流域', species: 30 } }
  const a = { id: 'air-yunlin', level: 0, params: { clarity: 0.5 } }
  syncAirOption(a, dust, { level: 24, params: { clarity: 0.75 } })
  assert.deepEqual(a, { id: 'air-yunlin', level: 24, params: { clarity: 0.75 }, birds: dust.birds, fish: dust.fish })
  assert.notEqual(a.birds, dust.birds); assert.notEqual(a.birds.yearly, dust.birds.yearly)           // 深複製
  a.birds.yearly.push({ y: 2020, s: 1 }); assert.equal(dust.birds.yearly.length, 1)
  const b = { id: 'air-yunlin', level: 5, params: { x: 1 }, birds: { basin: '舊' } }
  syncAirOption(b, { id: 'dust-yunlin' }, {}); assert.deepEqual(b, { id: 'air-yunlin', level: 5, params: { x: 1 }, birds: { basin: '舊' } })
  syncAirOption(b, undefined); assert.equal(b.level, 5)
})

test('shape：mapping / source 的補充冪等；揭露句在授權說明之後（不被讀成政府資料）', () => {
  const m1 = appendParts('A · B', [AIR_MAPPING]); assert.equal(appendParts(m1, [AIR_MAPPING]), m1)
  const src = 'A + B（政府資料 OGDL v1；氣象備援 Open-Meteo CC BY 4.0）' + AIR_SOURCE_DISCLOSURE
  assert.ok(src.indexOf('政府資料 OGDL v1') < src.indexOf('空氣品質') && src.includes('非政府觀測值'))
  assert.equal(withSourceParts(src, ['新標籤']).split('（')[0], 'A + B + 新標籤')   // bake 補標籤仍插在第一個「（」之前，不會插進揭露句
  assert.equal(withSourceParts(src, ['B']), src)
})

test('json：air.history 用 AIR_INLINE_PATHS 收成單行；不影響其他段落', () => {
  const o = { moon: { days: [['2026-09-20', '13:44', 120]] }, air: { county: '雲林縣', history: [row(20, 21), row(21, 22)] } }
  const lines = stringifyOcean(o, [...INLINE_PATHS, ...AIR_INLINE_PATHS]).split('\n')
  assert.ok(lines.includes(`      ${JSON.stringify(row(20, 21))},`) && lines.includes(`      ${JSON.stringify(row(21, 22))}`))
  assert.equal(stringifyOcean(o, INLINE_PATHS).split('\n').length > lines.length, true)     // 不加路徑就會展開成多行
  assert.deepEqual(JSON.parse(stringifyOcean(o, [...INLINE_PATHS, ...AIR_INLINE_PATHS])), o)
})

// ---- refreshAir（fetch-ocean-data.mjs）：注入假的 getJson，不連網 ----
const FAST = { attempts: 2, delayMs: 0, log: () => {} }

test('refreshAir：資料契約（欄位名 / 來源 / 說明）、level / params（用最新 PM2.5 與風速）、只留現在以前、與舊 history 合併', async () => {
  const urls = []
  const cur = { air: { history: [row(17, 18), row(18, 19)] } }
  const curBefore = structuredClone(cur)
  const r = await refreshAir(cur, NOW, { windSpeed: 6 }, { retryOpts: FAST, getJson: async (url, ms) => { urls.push([url, ms]); return api() } })
  assert.equal(urls.length, 1); assert.equal(urls[0][0], buildAirUrl())            // 只有一個請求
  assert.deepEqual(cur, curBefore)                                                  // 不改動輸入
  const a = r.air
  assert.deepEqual(Object.keys(a), ['county', 'place', 'lat', 'lon', 'source', 'sourceUrl', 'note', 'fetchedAt', 'history'])
  assert.deepEqual([a.county, a.place, a.lat, a.lon, a.source, a.sourceUrl, a.note], ['雲林縣', '麥寮', 23.79, 120.25, AIR_SOURCE, AIR_SOURCE_URL, AIR_NOTE])
  assert.equal(a.fetchedAt, '2026-09-20T21:30:00+08:00')
  assert.deepEqual(a.history.map((h) => h.t), [iso(17), iso(18), iso(19), iso(20), iso(21)])   // 22:00（預報）被丟掉；舊的 17、18 點保留；18 點被新資料覆蓋
  assert.deepEqual(a.history[1], { t: iso(18), pm10: 25.1, pm25: 22.8, dust: 0, aqi: 93 })
  assert.deepEqual(a.history[4], { t: iso(21), pm10: 27, pm25: 23.8, dust: 0, aqi: 89 })
  assert.equal(r.level, 24)
  assert.deepEqual(r.params, airParams({ pm25: 23.8, wind: 6 }))
  assert.equal(r.params.current, 0.5)
  assert.equal(r.last.t, iso(21)); assert.equal(r.fetched, 5)
})

test('refreshAir：失敗會重試（暫時性錯誤）；壞內容 / 全空 / 沒有 PM2.5 / 全是未來 → 丟錯（呼叫端保留舊資料）', async () => {
  let n = 0
  const flaky = async () => { if (++n === 1) throw new Error('HTTP 502'); return api() }
  assert.equal((await refreshAir(null, NOW, null, { retryOpts: FAST, getJson: flaky })).level, 24)
  assert.equal(n, 2)
  let calls = 0
  const four = async () => { calls++; throw Object.assign(new Error('HTTP 400 bad'), { status: 400 }) }
  await assert.rejects(refreshAir(null, NOW, null, { retryOpts: FAST, getJson: four }), /HTTP 400/); assert.equal(calls, 1)   // 4xx 不重試
  await assert.rejects(refreshAir(null, NOW, null, { retryOpts: FAST, getJson: async () => ({ error: true, reason: 'nope' }) }), /no valid air rows/)
  await assert.rejects(refreshAir(null, NOW, null, { retryOpts: FAST, getJson: async () => api({ pm2_5: [null, null, null, null, null] }) }), /no PM2.5/)   // pm10 還有值，但沒有 PM2.5 → 視為 schema 變了
  await assert.rejects(refreshAir(null, Date.parse('2026-09-19T00:00:00+08:00'), null, { retryOpts: FAST, getJson: async () => api() }), /no PM2.5 in air history/)   // 全是未來
  // 沒有風速資料 → 預設風速，仍能算
  assert.equal((await refreshAir(null, NOW, undefined, { retryOpts: FAST, getJson: async () => api() })).params.current, airParams({ pm25: 23.8 }).current)
})

// ---- 真實 ocean.json ----
test('真實 public/data/ocean.json：air 區塊符合資料契約、history 100+ 筆有效點且遞增、選項存在且參數合法；既有選項 / 欄位仍在', () => {
  const ocean = JSON.parse(readFileSync(new URL('../../public/data/ocean.json', import.meta.url), 'utf8'))
  const a = ocean.air
  assert.ok(a, 'ocean.json 沒有 air：先跑 node scripts/fetch-ocean-data.mjs')
  assert.deepEqual([a.county, a.place, a.lat, a.lon, a.source, a.sourceUrl], ['雲林縣', '麥寮', 23.79, 120.25, AIR_SOURCE, AIR_SOURCE_URL])
  assert.ok(a.note.includes('模型資料') && a.note.includes('非政府') && !Number.isNaN(Date.parse(a.fetchedAt)))
  const h = a.history
  assert.ok(h.length >= 100 && h.length <= 120, `history ${h.length}`)
  assert.ok(h.filter((x) => typeof x.pm25 === 'number').length >= 100)
  for (const x of h) {
    assert.deepEqual(Object.keys(x).slice(0, 5), ['t', 'pm10', 'pm25', 'dust', 'aqi'])                 // 之後可再接 wind / windDir（逐時風速，見 airWind.test.mjs）
    assert.ok([5, 7].includes(Object.keys(x).length), Object.keys(x).join())
    assert.match(x.t, /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\+08:00$/)
    for (const k of ['pm10', 'pm25', 'dust', 'aqi']) assert.ok(x[k] === null || (typeof x[k] === 'number' && x[k] >= 0 && x[k] <= 1000), `${x.t} ${k}=${x[k]}`)
  }
  assert.ok(h.every((x, i) => i === 0 || Date.parse(h[i - 1].t) < Date.parse(x.t)), '逐時遞增')
  assert.ok(new Set(h.map((x) => x.pm25)).size > 20, '數值會變（不是凍結資料）')
  const opt = ocean.options.find((o) => o.id === 'air-yunlin')
  assert.ok(opt)
  assert.deepEqual([opt.name, opt.region, opt.kind, typeof opt.level], ['空氣品質 · 雲林', '中', 'air', 'number'])
  assert.equal(Object.keys(opt.params).length, 13)
  for (const v of Object.values(opt.params)) assert.ok(v >= 0 && v <= 1 && v === Math.round(v * 100) / 100)
  assert.equal(opt.birds.basin, '濁水溪流域'); assert.equal(opt.fish.basin, '濁水溪流域')       // 雲林 = 濁水溪流域
  assert.deepEqual(opt.birds, ocean.options.find((o) => o.id === 'dust-yunlin').birds)
  for (const id of ['dust-yunlin', 'moon-hualien', 'hualien-tide', 'feitsui']) assert.ok(ocean.options.some((o) => o.id === id), id)   // 既有選項仍在
  for (const k of ['dust', 'stations', 'moon', 'weather', 'mapping', 'rivers']) assert.ok(k in ocean, k)
  assert.ok(ocean.source.includes('非政府觀測值') && ocean.mapping.includes('模型資料'))
})
