// 空氣品質的「逐時風速 / 風向（模型）」資料端測試：Open-Meteo 預報 API → air.history[].wind / windDir（離線、內嵌 fixture）。
// 執行：node --test scripts/gov/airWind.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildWindUrl, parseWind, applyWind, validate, mergeHistory, buildAirUrl, AIR_NOTE, AIR_INLINE_PATHS, AIR_WIND_LIMITS } from './air.mjs'
import { refreshAir, refreshAirWind } from '../fetch-ocean-data.mjs'

const NOW = Date.parse('2026-09-20T21:30:00+08:00')
const iso = (h, d = 20) => `2026-09-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00+08:00`
const row = (h, pm25, extra = {}) => ({ t: iso(h), pm10: pm25 + 3, pm25, dust: 0, aqi: 80, ...extra })
const wapi = (hourly = {}, extra = {}) => ({
  latitude: 23.8, longitude: 120.3, utc_offset_seconds: 28800, timezone: 'Asia/Taipei',
  hourly: { time: ['2026-09-20T19:00', '2026-09-20T20:00', '2026-09-20T21:00', '2026-09-20T22:00'], wind_speed_10m: [2.4, 3.1, 3.6, 4.2], wind_direction_10m: [40, 45, 50, 55], ...hourly },
  ...extra,
})
const FAST = { attempts: 2, delayMs: 0 }

test('buildWindUrl：與實測可用的請求一致（逗號原樣、台北時區、風速 m/s）；座標不合法丟 RangeError；天數夾在範圍內', () => {
  assert.equal(buildWindUrl(), 'https://api.open-meteo.com/v1/forecast?latitude=23.79&longitude=120.25&hourly=wind_speed_10m,wind_direction_10m&past_days=5&forecast_days=1&timezone=Asia%2FTaipei&wind_speed_unit=ms')
  assert.equal(buildWindUrl({ lat: '23.79', lon: '120.25' }), buildWindUrl())
  assert.match(buildWindUrl({ pastDays: 999, forecastDays: 99 }), /past_days=92&forecast_days=16&/)
  assert.match(buildWindUrl({ pastDays: -1, forecastDays: 0 }), /past_days=0&forecast_days=1&/)
  for (const bad of [{ lat: 91 }, { lon: 181 }, { lat: NaN }, { lat: null }, { lon: 'abc' }]) assert.throws(() => buildWindUrl(bad), RangeError, JSON.stringify(bad))
  assert.ok(!buildAirUrl().includes('wind'))                                   // PM 請求維持不變
})

test('validate：風速 0–100 m/s（1 位小數）、風向 0–360 度（整數）；越界 / 非數字 → null', () => {
  assert.equal(validate('wind', 3.46), 3.5); assert.equal(validate('wind', 0), 0); assert.equal(validate('wind', 100), 100); assert.equal(validate('wind', '2.24'), 2.2)
  for (const bad of [-0.1, 100.1, 5.34e3, NaN, null, undefined, '', 'x', true, [3], {}]) assert.equal(validate('wind', bad), null, String(bad))
  assert.equal(validate('windDir', 44.6), 45); assert.equal(validate('windDir', 360), 360); assert.equal(validate('windDir', 0), 0)
  for (const bad of [-1, 361, null, 'x', {}]) assert.equal(validate('windDir', bad), null, String(bad))
  assert.deepEqual(AIR_WIND_LIMITS, { wind: [0, 100], windDir: [0, 360] })
})

test('parseWind：正常回應 → 時間遞增的逐時列 { t, wind, windDir }；缺值 / 型別錯誤 / 越界 → null；兩個都無效的小時與壞時間略過；重複時間以後者為準', () => {
  const { rows, stats } = parseWind(wapi())
  assert.deepEqual(rows.map((r) => r.t), [iso(19), iso(20), iso(21), iso(22)])
  assert.deepEqual(rows[0], { t: iso(19), wind: 2.4, windDir: 40 }); assert.deepEqual(Object.keys(rows[0]), ['t', 'wind', 'windDir'])
  assert.deepEqual(stats, { points: 4, valid: 4, skipped: 0 })
  const j = wapi({
    time: ['2026-09-20T03:00', '2026-09-20T01:00', '2026-09-20T02:00', '2026-09-20T02:00', '2026-09-20T04:00', 'nope', '2026-09-20T06:00'],
    wind_speed_10m: [1, '2.5', null, 3, null, 9, 500], wind_direction_10m: [10, 20, 30, null, null, 40, 400],
  })
  const p = parseWind(j)
  assert.deepEqual(p.rows.map((r) => [r.t, r.wind, r.windDir]), [[iso(1), 2.5, 20], [iso(2), 3, null], [iso(3), 1, 10]])   // 02:00 重複：後者（3, null）；04:00 兩個都無效；06:00 兩個都越界；'nope' 壞時間
  assert.deepEqual(p.stats, { points: 7, valid: 3, skipped: 3 })   // 略過：04:00、06:00、'nope'（重複的 02:00 不算略過）
  assert.deepEqual(parseWind(wapi({ wind_direction_10m: undefined })).rows.map((r) => r.windDir), [null, null, null, null])   // 沒有風向欄位 → 風速照收
  for (const junk of [null, undefined, 5, 'x', [], {}, { hourly: null }, { hourly: {} }, { hourly: { time: 'x' } }, { hourly: { time: [] } }]) assert.deepEqual(parseWind(junk).rows, [], JSON.stringify(junk))
  const utc = parseWind(wapi({ time: ['2026-09-20T00:00'], wind_speed_10m: [5], wind_direction_10m: [90] }, { utc_offset_seconds: 0 }))
  assert.equal(utc.rows[0].t, iso(8))                                           // 回應是 UTC → 台北 +8
})

test('applyWind：每一列補上 wind / windDir（鍵順序 t, pm10, pm25, dust, aqi, wind, windDir）；PM 欄位與列數 / 順序完全不變；沒有對應小時 → 保持舊值，舊的也沒有 → null；不改動輸入', () => {
  const h = [row(19, 20), row(20, 21, { wind: 9.9, windDir: 180 }), row(21, 22), row(17, 18)]
  const before = structuredClone(h)
  const out = applyWind(h, parseWind(wapi()).rows)
  assert.deepEqual(h, before)
  assert.deepEqual(Object.keys(out[0]), ['t', 'pm10', 'pm25', 'dust', 'aqi', 'wind', 'windDir'])
  assert.deepEqual(out.map((r) => [r.t, r.pm25, r.pm10, r.dust, r.aqi]), h.map((r) => [r.t, r.pm25, r.pm10, r.dust, r.aqi]))
  assert.deepEqual(out.map((r) => [r.wind, r.windDir]), [[2.4, 40], [3.1, 45], [3.6, 50], [null, null]])           // 20:00 的舊值被新資料蓋過；17:00 沒有風資料 → null
  // 請求失敗（空 rows）：舊值保留、補齊鍵
  const kept = applyWind(out, [])
  assert.deepEqual(kept, out)
  const keptOld = applyWind(h, [])
  assert.deepEqual(keptOld.map((r) => [r.wind, r.windDir]), [[null, null], [9.9, 180], [null, null], [null, null]])
  // 新資料某欄位缺值 → 該欄位保持舊值
  const partial = applyWind([row(20, 21, { wind: 9.9, windDir: 180 })], [{ t: iso(20), wind: 2, windDir: null }])
  assert.deepEqual([partial[0].wind, partial[0].windDir], [2, 180])
  // 壞輸入不炸；時間帶分鐘也對得上整點
  for (const junk of [undefined, null, 5, 'x', {}]) assert.deepEqual(applyWind(junk, []), [])
  assert.deepEqual(applyWind([row(20, 21)], [{ t: '2026-09-20T20:00:00+08:00', wind: 1.5, windDir: 10 }]).map((r) => r.wind), [1.5])
  assert.deepEqual(applyWind([null, 5, row(20, 21)], []).slice(0, 2), [null, 5])
})

test('mergeHistory 與風速：有風速的列跨次合併不掉；新資料沒有風速鍵時保留舊風速；沒有風速的資料形狀完全不變；風速越界 → null；只有風速的小時（沒有 PM）丟掉', () => {
  const old = [row(19, 20, { wind: 3, windDir: 90 }), row(20, 21, { wind: 4, windDir: 100 })]
  const fresh = [row(20, 25), row(21, 26)]                                        // 沒有 wind 鍵
  const m = mergeHistory(old, fresh, { nowMs: NOW })
  assert.deepEqual(m.map((r) => [r.t, r.pm25, r.wind, r.windDir]), [[iso(19), 20, 3, 90], [iso(20), 25, 4, 100], [iso(21), 26, undefined, undefined]])
  assert.deepEqual(Object.keys(m[2]), ['t', 'pm10', 'pm25', 'dust', 'aqi'])       // 完全沒有風速資料的列不多出 wind / windDir 鍵
  const m2 = mergeHistory([row(20, 21, { wind: 4, windDir: 100 })], [row(20, 25, { wind: null, windDir: 200 })], { nowMs: NOW })
  assert.deepEqual([m2[0].wind, m2[0].windDir], [4, 200])
  const m3 = mergeHistory([{ ...row(20, 21), wind: 500, windDir: -5 }], [], { nowMs: NOW })
  assert.deepEqual([m3[0].wind, m3[0].windDir], [null, null])
  assert.deepEqual(mergeHistory([{ t: iso(20), pm10: null, pm25: null, dust: null, aqi: null, wind: 3, windDir: 90 }], [], { nowMs: NOW }), [])
  // 舊測試釘住的形狀不變
  assert.deepEqual(mergeHistory([row(19, 20)], [], { nowMs: NOW })[0], row(19, 20))
})

test('refreshAirWind：只有一個請求（風速網址）；併進 history 各小時；PM 欄位不動；回報 fetched / matched', async () => {
  const urls = []
  const h = [row(19, 20), row(20, 21), row(21, 22), row(15, 10)]
  const r = await refreshAirWind(h, { retryOpts: FAST, getJson: async (u, ms) => { urls.push([u, ms]); return wapi() } })
  assert.equal(urls.length, 1); assert.equal(urls[0][0], buildWindUrl())
  assert.equal(r.error, null); assert.equal(r.fetched, 4); assert.equal(r.matched, 3)
  assert.deepEqual(r.history.map((x) => [x.pm25, x.wind, x.windDir]), [[20, 2.4, 40], [21, 3.1, 45], [22, 3.6, 50], [10, null, null]])
})

test('refreshAirWind：請求失敗 / 壞內容 / 全空 → 不丟例外、PM 序列不受影響、風速保持舊值（沒有就 null）；暫時性錯誤會重試，4xx 不重試', async () => {
  const h = [row(19, 20, { wind: 7, windDir: 70 }), row(20, 21)]
  const boom = await refreshAirWind(h, { retryOpts: FAST, getJson: async () => { throw new Error('HTTP 502 https://api.open-meteo.com/...') } })
  assert.match(boom.error, /HTTP 502/); assert.equal(boom.fetched, 0); assert.equal(boom.matched, 1)
  assert.deepEqual(boom.history.map((x) => [x.pm25, x.wind, x.windDir]), [[20, 7, 70], [21, null, null]])
  for (const bad of [{ error: true, reason: 'nope' }, wapi({ wind_speed_10m: [null, null, null, null], wind_direction_10m: [null, null, null, null] }), null, 'x']) {
    const r = await refreshAirWind(h, { retryOpts: FAST, getJson: async () => bad })
    assert.match(r.error, /no valid wind rows/); assert.equal(r.history.length, 2); assert.equal(r.history[0].pm25, 20)
  }
  let n = 0
  const flaky = await refreshAirWind(h, { retryOpts: FAST, getJson: async () => { if (++n === 1) throw new Error('HTTP 503'); return wapi() } })
  assert.equal(n, 2); assert.equal(flaky.error, null); assert.equal(flaky.matched, 2)
  let calls = 0
  const four = await refreshAirWind(h, { retryOpts: FAST, getJson: async () => { calls++; throw Object.assign(new Error('HTTP 400 bad'), { status: 400 }) } })
  assert.equal(calls, 1); assert.match(four.error, /HTTP 400/)
  for (const junk of [undefined, null, 5, 'x']) assert.deepEqual((await refreshAirWind(junk, { retryOpts: FAST, getJson: async () => wapi() })).history, [])
})

test('與 refreshAir 銜接：refreshAir 的 history（無風速）→ refreshAirWind 補上；再跑一次 refreshAir 合併舊 history，風速不掉（下次風速請求失敗也保住）', async () => {
  const pm = (times) => ({ latitude: 23.8, longitude: 120.3, utc_offset_seconds: 28800, hourly: { time: times, pm10: times.map(() => 30), pm2_5: times.map((_, i) => 20 + i), dust: times.map(() => 0), us_aqi: times.map(() => 80) } })
  const t1 = ['2026-09-20T19:00', '2026-09-20T20:00', '2026-09-20T21:00']
  const a1 = await refreshAir(null, NOW, null, { retryOpts: FAST, getJson: async () => pm(t1) })
  assert.ok(a1.air.history.every((x) => !('wind' in x)))                            // refreshAir 本身不管風速
  const w1 = await refreshAirWind(a1.air.history, { retryOpts: FAST, getJson: async () => wapi() })
  assert.deepEqual(w1.history.map((x) => x.wind), [2.4, 3.1, 3.6])
  const a2 = await refreshAir({ air: { history: w1.history } }, NOW + 3600e3, null, { retryOpts: FAST, getJson: async () => pm([...t1, '2026-09-20T22:00']) })
  assert.deepEqual(a2.air.history.map((x) => x.wind), [2.4, 3.1, 3.6, undefined])   // 合併後舊小時的風速還在
  const w2 = await refreshAirWind(a2.air.history, { retryOpts: FAST, getJson: async () => { throw new Error('offline') } })
  assert.deepEqual(w2.history.map((x) => x.wind), [2.4, 3.1, 3.6, null])           // 風速請求失敗：舊值保住，新小時是 null
})

test('說明文字：AIR_NOTE 交代逐時風速是模型資料（非政府觀測）與 obs 是政府觀測、兩者分開；history 與 obs.history 都收成單行', () => {
  assert.ok(AIR_NOTE.includes('windDir') && AIR_NOTE.includes('wind_speed_10m') && AIR_NOTE.includes('obs'))
  assert.ok(AIR_NOTE.includes('模型資料') && AIR_NOTE.includes('非政府'))
  assert.deepEqual(AIR_INLINE_PATHS, ['air.history.*', 'air.obs.history.*'])
})

test('真實 ocean.json：air.history 每列都有 wind / windDir（鍵順序固定）、風速 100+ 個有效值且會變（不是凍結）、風向 0–360；PM 欄位不受影響', () => {
  const ocean = JSON.parse(readFileSync(new URL('../../public/data/ocean.json', import.meta.url), 'utf8'))
  const h = ocean.air.history
  assert.ok(h.length >= 100)
  for (const x of h) {
    assert.deepEqual(Object.keys(x), ['t', 'pm10', 'pm25', 'dust', 'aqi', 'wind', 'windDir'])
    assert.ok(x.wind === null || (typeof x.wind === 'number' && x.wind >= 0 && x.wind <= 100), `${x.t} wind=${x.wind}`)
    assert.ok(x.windDir === null || (typeof x.windDir === 'number' && x.windDir >= 0 && x.windDir <= 360), `${x.t} windDir=${x.windDir}`)
  }
  assert.ok(h.filter((x) => typeof x.wind === 'number').length >= 100, '風速有效小時數')
  assert.ok(new Set(h.map((x) => x.wind)).size > 5, '風速會變')
  assert.ok(h.filter((x) => typeof x.pm25 === 'number').length >= 100)
  assert.ok(ocean.air.note.includes('windDir'))
  // 沒有 MOENV_KEY 的環境：不會有 obs（這是預期）；有的話必須是完整的觀測物件
  if (ocean.air.obs) {
    const o = ocean.air.obs
    assert.deepEqual(Object.keys(o), ['source', 'sourceUrl', 'license', 'station', 'fetchedAt', 'history'])
    assert.ok(o.source.includes('政府資料開放授權條款－第1版') && o.sourceUrl === 'https://data.moenv.gov.tw/')
  }
})
