// 環境部空品測站觀測（moenv.mjs / refreshAirObs）的測試：離線、內嵌「真實欄位格式」的合成 fixture（不連網、不使用任何真實金鑰）。
// 執行：node --test scripts/gov/moenv.test.mjs
// 注意：這條管線只用 fixture 驗證過；欄位名稱 / 分頁參數依環境部公開說明，真實回應若有差異，第一次有金鑰時要看 CI 日誌。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MOENV_BASE, MOENV_CURRENT_ID, MOENV_HISTORY_ID, OBS_SOURCE, OBS_SOURCE_URL, OBS_LICENSE, OBS_MAX_KM, OBS_HISTORY_MAX, OBS_STALE_HOURS, OBS_PAGE_LIMIT,
  normalizeKey, maskKey, buildMoenvUrl, haversineKm, pmValue, aqiValue, windValue, obsTimeMs, extractRecords, readMoenvResponse,
  pickStation, filterStationRecords, buildObsHistory, mergeObsHistory, retainObs, fetchAirObs,
} from './moenv.mjs'
import { AIR_LAT, AIR_LON } from './air.mjs'
import { toTaipeiIso } from './util.mjs'
import { stringifyOcean, INLINE_PATHS } from './json.mjs'
import { AIR_INLINE_PATHS } from './air.mjs'
import { refreshAirObs, withoutObsMapping } from '../fetch-ocean-data.mjs'
import { OBS_MAPPING, OBS_SOURCE_DISCLOSURE, AIR_MAPPING, AIR_SOURCE_DISCLOSURE, appendParts } from './shape.mjs'

const KEY = 'TESTKEY-not-a-real-key-0000'        // 測試用假字串（不是任何真實金鑰）
const NOW = Date.parse('2026-09-20T21:30:00+08:00')
const HOUR = 3600e3
const FAST = { attempts: 3, delayMs: 0 }
const hourAgo = (h) => Date.parse('2026-09-20T21:00:00+08:00') - h * HOUR                 // 21:00 往前 h 小時
const dt = (ms) => toTaipeiIso(ms).slice(0, 16).replace('T', ' ')                          // 'YYYY-MM-DD HH:mm'（歷史資料集的格式，台灣時間）
const iso = (ms) => toTaipeiIso(ms)

// ---- 真實欄位格式的合成 fixture ----
const site = (o = {}) => ({
  sitename: '麥寮', county: '雲林縣', aqi: '62', pollutant: '細懸浮微粒', status: '普通', so2: '1.2', co: '0.25', o3: '38.1', o3_8hr: '36', pm10: '40',
  'pm2.5': '21', no2: '5.1', nox: '6.2', no: '1.1', wind_speed: '3.4', wind_direc: '45', publishtime: '2026/09/20 21:00:00', co_8hr: '0.2',
  'pm2.5_avg': '20', pm10_avg: '38', so2_avg: '1', longitude: '120.251', latitude: '23.753', siteid: '60', ...o,
})
const CURRENT = [
  site({ sitename: '基隆', county: '基隆市', aqi: '55', pm10: '25', 'pm2.5': '15', wind_speed: '0.8', wind_direc: '268', publishtime: '2026/09/20 04:00:00', longitude: '121.760056', latitude: '25.129168', siteid: '1' }),
  site({ sitename: '斗六', siteid: '58', longitude: '120.541', latitude: '23.711' }),   // ≈ 31 km
  site({ sitename: '崙背', siteid: '61', longitude: '120.36', latitude: '23.757' }),    // ≈ 12 km
  site({ sitename: '台西', siteid: '59', longitude: '120.202', latitude: '23.704' }),   // ≈ 11 km
  site(),                                                                                 // 麥寮 ≈ 4 km
]
// 歷史資料集：sitename 形如「雲林（麥寮）」、時間 'YYYY-MM-DD HH:mm'、windspeed / winddirec
const hist = (siteid, sitename, county, ms, pm25, o = {}) => ({
  sitename, county, aqi: '55', pollutant: '', status: '普通', so2: '1', so2_avg: '1', co: '0.2', co_8hr: '0.2', o3: '30', o3_8hr: '30', pm10: '30', pm10_avg: '30',
  'pm2.5': pm25, 'pm2.5_avg': pm25, no2: '4', nox: '5', no: '1', windspeed: '2.1', winddirec: '90', datacreationdate: dt(ms),
  longitude: '120.251', latitude: '23.753', siteid, unit: 'μg/m3', ...o,
})
const MAILIAO = (h, pm25 = String(10 + (h % 30)), o = {}) => hist('60', '雲林（麥寮）', '雲林縣', hourAgo(h), pm25, o)

// 假的環境部伺服器：依網址的資料集代碼回應；歷史資料集依 offset / limit 切頁，有 sort=… desc 時最新的在前
function server({ current = CURRENT, history = [], currentWrap = 'records', historyWrap = 'records', rejectSort = false, failHistory = 0, keyError = false, onCall = () => {} } = {}) {
  const calls = []
  const wrap = (arr, how) => (how === 'array' ? arr : { fields: [], resource_id: 'x', total: String(arr.length), records: arr })
  const f = function (url, init) {                                  // 用 function：檢查 this，重現瀏覽器的 Illegal invocation
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
    calls.push(String(url)); onCall(String(url))
    const u = new URL(url)
    const res = (status, body) => ({ status, get ok() { return status >= 200 && status < 300 }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) })
    if (keyError) return Promise.resolve(res(200, 'api_key 不存在'))
    if (u.searchParams.get('api_key') !== KEY) return Promise.resolve(res(200, 'api_key 不存在'))
    const id = u.pathname.split('/').pop()
    if (id === MOENV_CURRENT_ID) return Promise.resolve(res(200, wrap(current, currentWrap)))
    if (id === MOENV_HISTORY_ID) {
      if (failHistory && calls.filter((c) => c.includes(MOENV_HISTORY_ID)).length <= failHistory) return Promise.resolve(res(500, 'oops'))
      if (rejectSort && u.searchParams.has('sort')) return Promise.resolve(res(400, { message: 'unknown parameter sort' }))
      let list = [...history]
      const sort = u.searchParams.get('sort')
      if (sort) list.sort((a, b) => (a.datacreationdate < b.datacreationdate ? 1 : a.datacreationdate > b.datacreationdate ? -1 : 0))
      else list.sort((a, b) => (a.datacreationdate < b.datacreationdate ? -1 : 1))   // 沒有 sort：舊的在前
      const off = Number(u.searchParams.get('offset') || 0), lim = Number(u.searchParams.get('limit') || 1000)
      return Promise.resolve(res(200, wrap(list.slice(off, off + lim), historyWrap)))
    }
    return Promise.resolve(res(404, 'not found'))
  }
  f.calls = calls
  return f
}
const run = (fetch, o = {}) => { const logs = []; return fetchAirObs({ key: KEY, lat: AIR_LAT, lon: AIR_LON, nowMs: NOW, fetch, retryOpts: FAST, log: (m) => logs.push(m), ...o }).then((r) => ({ ...r, logs })) }
const leak = (x) => JSON.stringify(x).includes(KEY)

// ================= 金鑰 =================
test('normalizeKey：未設 / 空字串 / 只有空白 / 非字串 → 空（視為未設定）；前後空白（GitHub Secret 常見的換行）會修掉', () => {
  for (const v of [undefined, null, '', '   ', '\n', 0, {}, []]) assert.equal(normalizeKey(v), '', String(v))
  assert.equal(normalizeKey(`  ${KEY}\n`), KEY)
})

test('maskKey：URL 的 api_key=… 一律遮成 ***；已知金鑰出現在任何位置（含 URL 編碼）也遮；不動其他文字', () => {
  const url = buildMoenvUrl(MOENV_CURRENT_ID, KEY)
  assert.ok(url.includes(KEY))
  const m = maskKey(`HTTP 500 ${url} tail`)
  assert.ok(!m.includes(KEY) && m.includes('api_key=***&limit=1000') && m.endsWith(' tail'), m)
  assert.equal(maskKey('no key here'), 'no key here')
  assert.equal(maskKey(`bad ${KEY} and ${KEY}`, KEY), 'bad *** and ***')
  assert.equal(maskKey('k=a b&c', 'a b&c'), 'k=***'); assert.equal(maskKey('k=a%20b%26c', 'a b&c'), 'k=***')
  assert.equal(maskKey('API_KEY=abc&x=1'), 'API_KEY=***&x=1')       // 大小寫不拘
  assert.equal(maskKey(undefined), ''); assert.equal(maskKey(null, KEY), '')
})

test('buildMoenvUrl：基底 / 參數順序（api_key, limit, offset, sort?, format）；sort 空就不帶；金鑰會 URL 編碼', () => {
  assert.equal(buildMoenvUrl('aqx_p_432', 'K'), `${MOENV_BASE}/aqx_p_432?api_key=K&limit=1000&offset=0&format=json`)
  assert.equal(buildMoenvUrl('aqx_p_488', 'K', { limit: 500, offset: 1000, sort: 'datacreationdate desc' }), `${MOENV_BASE}/aqx_p_488?api_key=K&limit=500&offset=1000&sort=datacreationdate%20desc&format=json`)
  assert.ok(!buildMoenvUrl('aqx_p_488', 'K', { sort: '' }).includes('sort='))
  assert.match(buildMoenvUrl('x', 'a b&c'), /api_key=a%20b%26c&/)
  assert.deepEqual([MOENV_CURRENT_ID, MOENV_HISTORY_ID, OBS_MAX_KM, OBS_HISTORY_MAX, OBS_STALE_HOURS, OBS_PAGE_LIMIT], ['aqx_p_432', 'aqx_p_488', 25, 120, 48, 1000])
})

// ================= 數值 / 時間 =================
test('haversineKm：0 / 對稱 / 麥寮測站離模型格點約 4 km / 基隆到麥寮約 190 km', () => {
  assert.equal(haversineKm(23.79, 120.25, 23.79, 120.25), 0)
  const d = haversineKm(23.79, 120.25, 23.753, 120.251)
  assert.ok(d > 3.8 && d < 4.4, String(d)); assert.ok(Math.abs(d - haversineKm(23.753, 120.251, 23.79, 120.25)) < 1e-9)
  const far = haversineKm(25.129168, 121.760056, 23.753, 120.251)
  assert.ok(far > 180 && far < 220, String(far))
})

test('數值：無效標記（空字串 / ND / NR / - / * / 帶旗標）→ null；有效字串與數字收；範圍外 → null；小數 / 整數的四捨五入', () => {
  for (const bad of ['', ' ', 'ND', 'NR', '-', '*', '#', 'x', '12#', '12x', '1e3', '--', '.5', '5.', 'NaN', 'Infinity', undefined, null, true, [], {}, NaN, Infinity, '-1', -1, '1000.5', 1001]) {
    assert.equal(pmValue(bad), null, `pm ${JSON.stringify(bad)}`)
  }
  assert.equal(pmValue('21'), 21); assert.equal(pmValue(' 21.26 '), 21.3); assert.equal(pmValue(0), 0); assert.equal(pmValue('0'), 0); assert.equal(pmValue('1000'), 1000); assert.equal(pmValue(15.04), 15)
  assert.equal(aqiValue('55'), 55); assert.equal(aqiValue('55.6'), 56); assert.equal(aqiValue('ND'), null); assert.equal(aqiValue('501'), 501); assert.equal(aqiValue('1001'), null)
  assert.equal(windValue('0.8'), 0.8); assert.equal(windValue('2.34'), 2.3); assert.equal(windValue('*'), null); assert.equal(windValue('101'), null); assert.equal(windValue('-0.5'), null)
})

test('obsTimeMs：現在值 / 歷史 / ISO 三種格式；無時區 = 台灣時間；帶時區的換算；不合法（2/30、25 點、亂字）→ null', () => {
  const ref = Date.parse('2026-09-20T04:00:00+08:00')
  assert.equal(obsTimeMs('2026/09/20 04:00:00'), ref)
  assert.equal(obsTimeMs('2026-09-20 04:00'), ref)
  assert.equal(obsTimeMs('2026-09-20T04:00:00+08:00'), ref)
  assert.equal(obsTimeMs('2026-09-19T20:00:00Z'), ref)
  assert.equal(obsTimeMs('2026-09-19T20:00:00+0000'), ref)
  assert.equal(obsTimeMs(' 2026/9/20 4:00 '), ref)
  for (const bad of ['', null, undefined, 5, 'nope', '2026/02/30 04:00:00', '2026-09-20 25:00', '2026-13-01 00:00', '2026-09-20', '2026-09-20 04:99']) assert.equal(obsTimeMs(bad), null, String(bad))
})

// ================= 回應解析 =================
test('extractRecords：{ records: [...] } 與直接陣列都收；其他形狀 → null', () => {
  const r = [{ a: 1 }]
  assert.equal(extractRecords({ records: r }), r); assert.equal(extractRecords(r), r); assert.deepEqual(extractRecords([]), [])
  for (const junk of [null, undefined, 5, 'x', {}, { records: 'x' }, { records: {} }, { data: r }]) assert.equal(extractRecords(junk), null, JSON.stringify(junk))
})

test('readMoenvResponse：金鑰錯誤（200 純文字 / 4xx 帶說明 / JSON 訊息）→ code KEY、不重試（status 401）、訊息不含金鑰；5xx 有 status；非 JSON；網址中的金鑰被遮', async () => {
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => body })
  const url = buildMoenvUrl('aqx_p_432', KEY)
  for (const bad of [res(200, 'api_key 不存在'), res(200, '{"message":"api_key 不存在"}'), res(403, 'Invalid API key'), res(400, '金鑰錯誤'), res(200, 'invalid apikey')]) {
    const e = await readMoenvResponse(bad, url, KEY).catch((x) => x)
    assert.ok(e instanceof Error && e.code === 'KEY' && e.status === 401, String(e && e.message))
    assert.ok(!e.message.includes(KEY) && /api_key/.test(e.message))
  }
  const e5 = await readMoenvResponse(res(502, 'Bad Gateway'), url, KEY).catch((x) => x)
  assert.equal(e5.status, 502); assert.ok(!e5.message.includes(KEY) && e5.message.includes('api_key=***'), e5.message)
  const eText = await readMoenvResponse(res(200, '<html>maintenance</html>'), url, KEY).catch((x) => x)
  assert.match(eText.message, /non-JSON/); assert.equal(eText.status, undefined)                  // 可重試
  assert.deepEqual(await readMoenvResponse(res(200, '{"records":[]}'), url, KEY), { records: [] })
  assert.deepEqual(await readMoenvResponse(res(200, '[]'), url, KEY), [])
  const eRead = await readMoenvResponse({ status: 200, ok: true, text: async () => { throw new Error(`socket hang up ${url}`) } }, url, KEY).catch((x) => x)
  assert.ok(/read failed/.test(eRead.message) && !eRead.message.includes(KEY), eRead.message)
})

// ================= 測站選擇 =================
test('pickStation：在模型格點（麥寮）25 km 內挑最近的測站，回 { name, county, id, lat, lon, km }；不硬編碼', () => {
  const s = pickStation(CURRENT, { lat: AIR_LAT, lon: AIR_LON })
  assert.deepEqual([s.name, s.county, s.id, s.lat, s.lon], ['麥寮', '雲林縣', '60', 23.753, 120.251])
  assert.ok(s.km > 3.5 && s.km < 4.5 && s.km === Math.round(s.km * 10) / 10)
  // 換一個格點 → 挑到別的站（證明不是寫死 siteid）：斗六附近
  assert.equal(pickStation(CURRENT, { lat: 23.71, lon: 120.54 }).name, '斗六')
  assert.equal(pickStation(CURRENT, { lat: 25.1, lon: 121.75 }).name, '基隆')
})

test('pickStation：狀態空白（停測 / 維護）的站不選；退到次近；全部太遠（> 25 km）→ null；maxKm 可調；壞輸入不炸', () => {
  const noMailiao = CURRENT.map((r) => (r.sitename === '麥寮' ? { ...r, status: '' } : r))
  assert.equal(pickStation(noMailiao, { lat: AIR_LAT, lon: AIR_LON }).name, '台西')            // 11 km < 崙背 12 km
  assert.equal(pickStation(noMailiao.map((r) => (r.sitename === '台西' ? { ...r, status: '   ' } : r)), { lat: AIR_LAT, lon: AIR_LON }).name, '崙背')
  const farOnly = CURRENT.filter((r) => ['基隆', '斗六'].includes(r.sitename))                     // 斗六 ≈ 31 km、基隆 ≈ 190 km
  assert.equal(pickStation(farOnly, { lat: AIR_LAT, lon: AIR_LON }), null)
  assert.equal(pickStation(farOnly, { lat: AIR_LAT, lon: AIR_LON, maxKm: 35 }).name, '斗六')
  assert.equal(pickStation(CURRENT, { lat: AIR_LAT, lon: AIR_LON, maxKm: 1 }), null)
  for (const junk of [null, undefined, 'x', {}, [null, 5, 'x', {}], [{ sitename: '', status: 'x', latitude: '23.7', longitude: '120.2' }], [{ sitename: 'A', status: 'x', latitude: '', longitude: '120.2' }], [{ sitename: 'A', status: 'x', latitude: '99', longitude: '120.2' }]]) {
    assert.equal(pickStation(junk, { lat: AIR_LAT, lon: AIR_LON }), null, JSON.stringify(junk))
  }
  assert.equal(pickStation(CURRENT, { lat: NaN, lon: 1 }), null); assert.equal(pickStation(CURRENT, {}), null)
})

test('pickStation：缺 siteid → id 為 null；欄位大小寫不拘（SiteName / Status / Latitude）；同距離取先出現的', () => {
  const s = pickStation([site({ siteid: undefined })], { lat: AIR_LAT, lon: AIR_LON })
  assert.equal(s.id, null); assert.equal(s.name, '麥寮')
  const up = pickStation([{ SiteName: '麥寮', County: '雲林縣', Status: '良好', Latitude: '23.753', Longitude: '120.251', SiteId: '60' }], { lat: AIR_LAT, lon: AIR_LON })
  assert.deepEqual([up.name, up.county, up.id], ['麥寮', '雲林縣', '60'])
  assert.equal(pickStation([site({ sitename: 'A' }), site({ sitename: 'B' })], { lat: AIR_LAT, lon: AIR_LON }).name, 'A')
})

// ================= 歷史過濾 / 組裝 =================
test('filterStationRecords：有 siteid 就依 siteid（其他測站、同名不同 id 都排除）', () => {
  const recs = [MAILIAO(1), hist('61', '雲林（崙背）', '雲林縣', hourAgo(1), '9'), hist('99', '雲林（麥寮）', '雲林縣', hourAgo(1), '99')]   // 99：同名但不同 id
  const st = { name: '麥寮', county: '雲林縣', id: '60' }
  const out = filterStationRecords(recs, st)
  assert.equal(out.length, 1); assert.equal(out[0].siteid, '60')
  assert.deepEqual(filterStationRecords(recs, null), []); assert.deepEqual(filterStationRecords(null, st), [])
})

test('filterStationRecords：缺 siteid 的退路——county + sitename 包含測站名（臺 / 台不拘）；siteid 全對不上也走退路；名字不含的排除', () => {
  const noId = (r) => { const { siteid, ...rest } = r; return rest }
  const recs = [MAILIAO(1), hist('61', '雲林（崙背）', '雲林縣', hourAgo(1), '9'), hist('7', '嘉義（麥寮）', '嘉義縣', hourAgo(1), '77')].map(noId)   // 最後一筆：別縣同名 → 排除
  const st = { name: '麥寮', county: '雲林縣', id: '60' }
  const byName = filterStationRecords(recs, st)
  assert.deepEqual(byName.map((r) => r.sitename), ['雲林（麥寮）'])
  assert.equal(filterStationRecords(recs.map((r) => ({ ...r, county: '臺東縣' })), { name: '麥寮', county: '台東縣', id: null }).length, 2)   // 臺 / 台
  assert.equal(filterStationRecords([MAILIAO(1)], { name: '麥寮', county: '雲林縣', id: '999' }).length, 1)                                  // siteid 存在但對不上 → 依名稱
  assert.equal(filterStationRecords([MAILIAO(1, '9', { county: '' })], { name: '麥寮', county: '雲林縣', id: null }).length, 1)             // 記錄沒有縣市 → 不強求
  assert.equal(filterStationRecords([MAILIAO(1)], { name: '', county: '雲林縣', id: null }).length, 0)
})

test('buildObsHistory：整點對齊、遞增、無效值 → null、全欄位無效的小時略過；欄位鍵順序 t, pm25, pm10, aqi, wind；時區字串統一成 +08:00', () => {
  const rows = [
    MAILIAO(2, '18.4'),                                                                                                           // 19:00
    MAILIAO(1, 'ND', { pm10: '', aqi: '*', windspeed: '-' }),                                                                     // 20:00：四個欄位都無效 → 略過
    MAILIAO(0, '21', { pm10: 'NR', aqi: '62', windspeed: '3.4' }),                                                                // 21:00
    { ...MAILIAO(3, '17'), datacreationdate: '2026-09-20 18:30' },                                                                // 18:30 → 18:00
    { ...MAILIAO(4, '16'), datacreationdate: 'garbage' },                                                                         // 時間不合法 → 略過
  ]
  const h = buildObsHistory(rows, { nowMs: NOW })
  assert.deepEqual(h.map((r) => r.t), [iso(hourAgo(3)), iso(hourAgo(2)), iso(hourAgo(0))])
  assert.deepEqual(h[0].t, '2026-09-20T18:00:00+08:00')
  assert.deepEqual(h[2], { t: '2026-09-20T21:00:00+08:00', pm25: 21, pm10: null, aqi: 62, wind: 3.4 })
  assert.deepEqual(Object.keys(h[0]), ['t', 'pm25', 'pm10', 'aqi', 'wind'])
  assert.deepEqual(h[1], { t: '2026-09-20T19:00:00+08:00', pm25: 18.4, pm10: 30, aqi: 55, wind: 2.1 })
})

test('buildObsHistory：同一小時去重（較晚的記錄優先；缺值不蓋掉已有的值）、丟掉現在以後的小時、最近 max 筆、maxAgeMs、不改動輸入', () => {
  const rows = [
    MAILIAO(1, '10', { datacreationdate: '2026-09-20 20:10' }),
    MAILIAO(1, '', { datacreationdate: '2026-09-20 20:50', pm10: '44' }),         // 較晚但 pm25 缺值 → 保留 10、pm10 用 44
    MAILIAO(2, '9', { datacreationdate: '2026-09-20 19:59' }),
    MAILIAO(2, '12', { datacreationdate: '2026-09-20 19:05' }),                    // 同小時較早的 → 被 19:59 那筆蓋掉（19:59 較晚）
    MAILIAO(0, '30', { datacreationdate: '2026-09-20 22:00' }),                    // 現在 21:30 → 22:00 是未來 → 丟掉
  ]
  const before = structuredClone(rows)
  const h = buildObsHistory(rows, { nowMs: NOW })
  assert.deepEqual(rows, before)
  assert.deepEqual(h.map((r) => [r.t.slice(11, 13), r.pm25, r.pm10]), [['19', 9, 30], ['20', 10, 44]])
  // 現在剛好整點 → 該小時保留
  assert.equal(buildObsHistory(rows, { nowMs: Date.parse('2026-09-20T22:00:00+08:00') }).length, 3)
  // max / maxAgeMs
  const many = Array.from({ length: 150 }, (_, i) => MAILIAO(i))
  const all = buildObsHistory(many, { nowMs: NOW })
  assert.equal(all.length, 120); assert.equal(all[all.length - 1].t, '2026-09-20T21:00:00+08:00'); assert.equal(all[0].t, iso(hourAgo(119)))
  assert.ok(all.every((r, i) => i === 0 || Date.parse(all[i - 1].t) < Date.parse(r.t)), '嚴格遞增')
  assert.equal(buildObsHistory(many, { nowMs: NOW, max: 5 }).length, 5); assert.equal(buildObsHistory(many, { nowMs: NOW, max: 0 }).length, 0)
  assert.equal(buildObsHistory(many, { nowMs: NOW, max: NaN }).length, 120)
  assert.equal(buildObsHistory(many, { nowMs: NOW, maxAgeMs: 10 * HOUR }).length, 10)          // 現在 21:30：12:00（9.5 小時前）到 21:00 共 10 小時
  for (const junk of [undefined, null, 5, 'x', {}, [null, 5, 'x']]) assert.deepEqual(buildObsHistory(junk, { nowMs: NOW }), [])
  assert.ok(Array.isArray(buildObsHistory(many, { nowMs: NaN })))
})

test('buildObsHistory：目前值資料集的記錄（publishtime / wind_speed）也能轉成一列', () => {
  const [h] = buildObsHistory([site()], { nowMs: NOW })
  assert.deepEqual(h, { t: '2026-09-20T21:00:00+08:00', pm25: 21, pm10: 40, aqi: 62, wind: 3.4 })
})

test('mergeObsHistory / retainObs：新蓋舊、缺欄位保留舊值、舊檔的壞列清掉；舊 obs 48 小時內保留、超過移除、未來時鐘 / 壞形狀 → null', () => {
  const old = [{ t: iso(hourAgo(3)), pm25: 5, pm10: 6, aqi: 20, wind: 1 }, { t: iso(hourAgo(2)), pm25: 7, pm10: null, aqi: null, wind: null }, { t: 'bad', pm25: 1 }, null, { t: iso(hourAgo(1)), pm25: 5000 }]
  const neu = [{ t: iso(hourAgo(2)), pm25: 8, pm10: 9, aqi: null, wind: 2 }, { t: iso(hourAgo(0)), pm25: 11, pm10: null, aqi: null, wind: null }]
  const m = mergeObsHistory(old, neu, { nowMs: NOW })
  assert.deepEqual(m.map((r) => [r.t.slice(11, 13), r.pm25, r.pm10, r.wind]), [['18', 5, 6, 1], ['19', 8, 9, 2], ['21', 11, null, null]])   // 20:00 的 pm25=5000 越界 → 整列無效
  const obs = (fetchedAt, extra = {}) => ({ source: OBS_SOURCE, station: { name: '麥寮', id: '60' }, fetchedAt, history: [{ t: iso(hourAgo(2)), pm25: 8 }, { t: iso(hourAgo(-5)), pm25: 9 }], ...extra })
  const h = (n) => iso(NOW - n * HOUR)
  assert.equal(retainObs(obs(h(1)), NOW).history.length, 1)                       // 未來的小時（+5）被清掉
  assert.ok(retainObs(obs(h(47.9)), NOW)); assert.ok(retainObs(obs(h(48)), NOW))  // 48 小時整仍保留
  assert.equal(retainObs(obs(h(48.1)), NOW), null); assert.equal(retainObs(obs(h(500)), NOW), null)
  assert.ok(retainObs(obs(iso(NOW + 60000)), NOW)); assert.equal(retainObs(obs(iso(NOW + 3600e3)), NOW), null)   // 時鐘超前 1 分鐘可、1 小時不行
  for (const bad of [undefined, null, 5, 'x', {}, obs('nope'), obs(h(1), { history: 'x' }), obs(h(1), { history: [] }), obs(h(1), { station: null }), obs(undefined)]) assert.equal(retainObs(bad, NOW), null, JSON.stringify(bad))
  const src = obs(h(1)); const before = structuredClone(src); retainObs(src, NOW); assert.deepEqual(src, before)
})

// ================= 整條管線（假伺服器）=================
test('fetchAirObs：目前值選測站 → 歷史過濾（兩種回應包裝）→ air.obs 形狀（鍵順序、來源 / 授權 / 測站 / 近似時間）；金鑰不進結果與日誌', async () => {
  const H = [...Array.from({ length: 30 }, (_, i) => MAILIAO(i)), ...Array.from({ length: 30 }, (_, i) => hist('61', '雲林（崙背）', '雲林縣', hourAgo(i), '99'))]
  for (const [cw, hw] of [['records', 'records'], ['array', 'array'], ['records', 'array']]) {
    const f = server({ history: H, currentWrap: cw, historyWrap: hw })
    const r = await run(f)
    assert.deepEqual(Object.keys(r.obs), ['source', 'sourceUrl', 'license', 'station', 'fetchedAt', 'history'])
    assert.deepEqual([r.obs.source, r.obs.sourceUrl, r.obs.license], [OBS_SOURCE, OBS_SOURCE_URL, OBS_LICENSE])
    assert.equal(OBS_SOURCE, '環境部空氣品質監測網（政府資料開放授權條款－第1版）')
    assert.deepEqual(Object.keys(r.obs.station), ['name', 'county', 'id', 'lat', 'lon', 'km'])
    assert.deepEqual([r.obs.station.name, r.obs.station.county, r.obs.station.id, r.obs.station.lat, r.obs.station.lon], ['麥寮', '雲林縣', '60', 23.753, 120.251])
    assert.equal(r.obs.fetchedAt, '2026-09-20T21:30:00+08:00')
    assert.equal(r.obs.history.length, 30)                                                                              // 只有麥寮站（崙背站的 99 沒混進來）
    assert.equal(r.obs.history[28].pm25, 11); assert.ok(r.obs.history.every((x) => x.pm25 !== 99) && r.obs.history.every((x, i, a) => i === 0 || Date.parse(a[i - 1].t) < Date.parse(x.t)))
    assert.equal(r.obs.history[29].t, '2026-09-20T21:00:00+08:00'); assert.equal(r.obs.history[29].pm25, 21)             // 同一小時：目前值資料集（21）蓋過歷史資料集（10）；其餘小時來自歷史
    assert.ok(!leak(r) && !leak(r.logs), '金鑰不進結果 / 日誌')
    assert.deepEqual(f.calls.map((u) => new URL(u).pathname.split('/').pop()), [MOENV_CURRENT_ID, MOENV_HISTORY_ID])   // 依序請求：目前值 → 歷史（一頁就夠）
    assert.ok(f.calls[1].includes('sort=datacreationdate%20desc') && f.calls[1].includes('offset=0'))
    assert.equal(r.stats.usedFallback, false); assert.equal(r.stats.pages, 1)
  }
})

test('fetchAirObs：歷史分頁——翻頁直到湊滿 120 小時（每頁 1000 筆、含其他測站）；只留最近 120 筆；sort 被拒絕（400）就去掉 sort 重試（舊的在前，仍能湊齊）', async () => {
  const stations = Array.from({ length: 20 }, (_, k) => (k === 0 ? '60' : String(100 + k)))
  const H = []
  for (let i = 0; i < 150; i++) for (const id of stations) H.push(id === '60' ? MAILIAO(i) : hist(id, `縣市${id}（站${id}）`, '某縣', hourAgo(i), '50', { longitude: '121', latitude: '24' }))
  assert.equal(H.length, 3000)
  const f = server({ history: H })
  const r = await run(f)
  assert.equal(r.obs.history.length, 120); assert.equal(r.stats.pages, 3)                                            // 新→舊：第 1 頁 50 小時、第 2 頁 100 小時、第 3 頁湊滿
  assert.equal(r.obs.history[119].t, '2026-09-20T21:00:00+08:00'); assert.equal(r.obs.history[0].t, iso(hourAgo(119)))
  assert.deepEqual(f.calls.filter((u) => u.includes(MOENV_HISTORY_ID)).map((u) => new URL(u).searchParams.get('offset')), ['0', '1000', '2000'])
  // sort 被拒絕
  const g = server({ history: H, rejectSort: true })
  const r2 = await run(g)
  assert.equal(r2.obs.history.length, 120); assert.equal(r2.obs.history[119].t, '2026-09-20T21:00:00+08:00')
  assert.ok(r2.logs.some((l) => /sort/.test(l)), r2.logs.join('\n'))
  assert.ok(g.calls.filter((u) => u.includes(MOENV_HISTORY_ID)).slice(1).every((u) => !u.includes('sort=')))
  assert.ok(!leak(r2.logs))
})

test('fetchAirObs：歷史資料集抓不到（5xx / 逾時）→ 只用目前值 1 筆並在日誌說明；歷史裡沒有這個測站 → 同樣；歷史晚幾小時更新 → 目前值補在最新一小時', async () => {
  const bad = await run(server({ history: [MAILIAO(1)], failHistory: 99 }))
  assert.equal(bad.obs.history.length, 1); assert.equal(bad.obs.history[0].t, '2026-09-20T21:00:00+08:00'); assert.deepEqual(bad.obs.history[0], { t: '2026-09-20T21:00:00+08:00', pm25: 21, pm10: 40, aqi: 62, wind: 3.4 })
  assert.equal(bad.stats.usedFallback, true); assert.ok(bad.logs.some((l) => /目前值/.test(l)), bad.logs.join('\n')); assert.ok(!leak(bad.logs))
  const none = await run(server({ history: [hist('61', '雲林（崙背）', '雲林縣', hourAgo(1), '9')] }))
  assert.equal(none.obs.history.length, 1); assert.equal(none.stats.usedFallback, true); assert.ok(none.logs.some((l) => /沒有這個測站/.test(l)))
  const lag = await run(server({ history: [MAILIAO(4), MAILIAO(3), MAILIAO(2)] }))                               // 歷史只到 19:00，目前值是 21:00
  assert.deepEqual(lag.obs.history.map((x) => x.t.slice(11, 13)), ['17', '18', '19', '21']); assert.equal(lag.stats.usedFallback, false)
  const flaky = await run(server({ history: [MAILIAO(1), MAILIAO(0)], failHistory: 2 }))                            // 前 2 次 500、第 3 次成功（重試）
  assert.equal(flaky.stats.usedFallback, false); assert.equal(flaky.obs.history.length, 2)
})

test('fetchAirObs：帶 sort 的第一頁失敗（200 但形狀不對 / 一再 5xx）→ 去掉 sort 再試；API 忽略 sort、由舊到新回傳時不會提前結束（一路翻頁）；之後的頁失敗不改排序', async () => {
  const H = []
  for (let i = 0; i < 150; i++) for (let k = 0; k < 8; k++) H.push(k === 0 ? MAILIAO(i) : hist(String(100 + k), `縣${k}（站${k}）`, '某縣', hourAgo(i), '50'))   // 1200 筆：2 頁
  // (a) 帶 sort 時回怪形狀（沒有 records），不帶 sort 才正常
  const base = server({ history: H })
  const f = async function (url, init) {
    if (url.includes(MOENV_HISTORY_ID) && url.includes('sort=')) return { status: 200, ok: true, text: async () => JSON.stringify({ success: false, error: 'bad sort' }) }
    return base(url, init)
  }
  const r = await run(f)
  assert.ok(r.logs.some((l) => /帶 sort 失敗/.test(l)), r.logs.join('\n')); assert.equal(r.stats.usedFallback, false); assert.equal(r.obs.history.length, 120)
  assert.ok(!leak(r.logs))
  // (b) sort 被忽略、資料由舊到新：不能因為「第一頁最舊的資料早於 120 小時前」就停（那一頁全是舊資料）
  const asc = server({ history: H })
  const ignoresSort = async (url, init) => asc(url.replace(/&sort=[^&]*/, ''), init)                                   // 伺服器看不到 sort → 自然順序（舊 → 新）
  const r2 = await run(ignoresSort)
  assert.equal(r2.stats.pages, 2); assert.equal(r2.obs.history[r2.obs.history.length - 1].t, '2026-09-20T21:00:00+08:00'); assert.equal(r2.obs.history.length, 120)
  // (c) 第二頁失敗（sort 仍有效）：保留第一頁已取得的，不會為了重試換排序而把 offset 弄亂
  const H20 = []
  for (let i = 0; i < 150; i++) for (let k = 0; k < 20; k++) H20.push(k === 0 ? MAILIAO(i) : hist(String(100 + k), `縣${k}（站${k}）`, '某縣', hourAgo(i), '50'))   // 3000 筆：第 1 頁只到 50 小時
  const base20 = server({ history: H20 })
  let n = 0
  const flakyPage2 = async (url, init) => { if (url.includes(MOENV_HISTORY_ID) && url.includes('offset=1000')) { n++; return { status: 500, ok: false, text: async () => 'oops' } } return base20(url, init) }
  const r3 = await run(flakyPage2)
  assert.equal(n, 3)                                                                                                    // 第 2 頁重試 3 次後放棄，沒有換成不帶 sort 重來
  assert.ok(r3.logs.some((l) => /抓取中斷/.test(l) && /已取得 50 筆/.test(l)), r3.logs.join('\n')); assert.equal(r3.obs.history.length, 50); assert.equal(r3.obs.history[49].t, '2026-09-20T21:00:00+08:00')
})

test('fetchAirObs：歷史資料若被忽略 sort、回的是很久以前的資料 → 超過 10 天的小時不收，不會把舊資料當現在的', async () => {
  const oldH = Array.from({ length: 5 }, (_, i) => hist('60', '雲林（麥寮）', '雲林縣', Date.parse('2025-01-01T00:00:00+08:00') + i * HOUR, '20'))
  const r = await run(server({ history: oldH }))
  assert.deepEqual(r.obs.history.map((x) => x.t), ['2026-09-20T21:00:00+08:00'])                                     // 只剩目前值
})

test('fetchAirObs：金鑰錯誤（純文字「api_key 不存在」）→ 丟 KEY 錯、不重試、訊息與日誌都不含金鑰', async () => {
  const f = server({ keyError: true })
  const e = await run(f).catch((x) => x)
  assert.equal(e.code, 'KEY'); assert.equal(f.calls.length, 1)                                                        // 4xx 類（status 401）不重試
  assert.ok(!e.message.includes(KEY) && !leak(e.stack || ''), e.message)
  // 用錯的金鑰打（伺服器只認 KEY）
  const f2 = server({ history: [MAILIAO(0)] })
  const e2 = await fetchAirObs({ key: 'WRONG-KEY', lat: AIR_LAT, lon: AIR_LON, nowMs: NOW, fetch: f2, retryOpts: FAST }).catch((x) => x)
  assert.equal(e2.code, 'KEY'); assert.ok(!e2.message.includes('WRONG-KEY'))
  // 歷史那一步才回金鑰錯誤 → 不能被當作「歷史抓不到」吞掉
  let n = 0
  const f3 = server({ history: [MAILIAO(0)], onCall: (u) => { if (u.includes(MOENV_HISTORY_ID)) n++ } })
  const wrapped = async (url, init) => (url.includes(MOENV_HISTORY_ID) ? { status: 200, ok: true, text: async () => 'api_key 不存在' } : f3(url, init))
  const e3 = await run(wrapped).catch((x) => x)
  assert.equal(e3.code, 'KEY')
})

test('fetchAirObs：失敗情境（沒金鑰 / 回應格式不對 / 目前值 5xx / 網路例外 / 附近沒有測站 / 全是無效值）都丟錯，訊息不含金鑰；壞 JSON 會重試', async () => {
  await assert.rejects(fetchAirObs({ key: '', lat: AIR_LAT, lon: AIR_LON, nowMs: NOW, fetch: async () => { throw new Error('should not be called') } }), /no MOENV key/)
  await assert.rejects(fetchAirObs({ key: '  ', lat: AIR_LAT, lon: AIR_LON, nowMs: NOW }), /no MOENV key/)
  const shape = await run(async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ success: true, data: [] }) })).catch((x) => x)
  assert.match(shape.message, /unexpected response shape/)
  let n = 0
  const e5 = await run(async (u) => { n++; return { status: 503, ok: false, text: async () => 'unavailable' } }).catch((x) => x)
  assert.equal(e5.status, 503); assert.equal(n, 3); assert.ok(!e5.message.includes(KEY) && e5.message.includes('api_key=***'), e5.message)   // 5xx 重試 3 次
  let m = 0
  const html = await run(async () => { m++; return { status: 200, ok: true, text: async () => '<html>busy</html>' } }).catch((x) => x)
  assert.match(html.message, /non-JSON/); assert.equal(m, 3)
  const net = await run(async (u) => { throw new Error(`fetch failed for ${u}`) }).catch((x) => x)
  assert.ok(/request failed/.test(net.message) && !net.message.includes(KEY) && net.message.includes('api_key=***'), net.message)
  const far = await run(server({ current: CURRENT.filter((r) => ['基隆', '斗六'].includes(r.sitename)) })).catch((x) => x)
  assert.match(far.message, /no MOENV station/)
  const allBad = await run(server({ current: [site({ status: '' })], history: [] })).catch((x) => x)
  assert.match(allBad.message, /no MOENV station/)
  const invalid = await run(server({ current: [site({ aqi: 'ND', pm10: '*', 'pm2.5': '', wind_speed: '-' })], history: [] })).catch((x) => x)
  assert.match(invalid.message, /no valid MOENV observation rows/)
})

test('fetchAirObs：同一測站 → 與舊 obs 歷史合併（累積）；換了測站不併；舊資料裡的壞列被清掉', async () => {
  const old = { source: OBS_SOURCE, station: { name: '麥寮', id: '60' }, fetchedAt: iso(NOW - 6 * HOUR), history: [{ t: iso(hourAgo(30)), pm25: 33, pm10: 40, aqi: 90, wind: 1 }, { t: 'junk', pm25: 1 }, { t: iso(hourAgo(8)), pm25: 5000 }] }
  const same = await run(server({ history: [MAILIAO(1), MAILIAO(0)] }), { old })
  assert.deepEqual(same.obs.history.map((x) => x.t.slice(8, 13)), ['19T15', '20T20', '20T21']); assert.equal(same.obs.history[0].pm25, 33)
  const other = await run(server({ history: [MAILIAO(1), MAILIAO(0)] }), { old: { ...old, station: { name: '崙背', id: '61' } } })
  assert.equal(other.obs.history.length, 2)
  const noId = await run(server({ history: [MAILIAO(0)] }), { old: { ...old, station: { name: '麥寮', id: null } } })
  assert.equal(noId.obs.history.length, 2)   // 舊的 id 為 null → 改比名稱（麥寮 = 麥寮）→ 舊的一筆 + 新的一筆
})

test('fetchAirObs：obs 寫進 ocean.json 時 history 每列收成單行（AIR_INLINE_PATHS）；JSON 來回不變、不含金鑰', async () => {
  const r = await run(server({ history: [MAILIAO(1), MAILIAO(0)] }))
  const air = { county: '雲林縣', history: [{ t: iso(hourAgo(0)), pm10: 1, pm25: 2, dust: 0, aqi: 3, wind: 1, windDir: 90 }], obs: r.obs }
  const text = stringifyOcean({ air }, [...INLINE_PATHS, ...AIR_INLINE_PATHS])
  assert.ok(text.split('\n').filter((l) => l.startsWith('        {"t":')).length === 2, text)      // obs.history 兩列各一行
  assert.deepEqual(JSON.parse(text), { air }); assert.ok(!text.includes(KEY))
})

// ================= refreshAirObs（fetch-ocean-data.mjs）=================
const withEnv = async (val, fn) => {
  const saved = process.env.MOENV_KEY
  if (val === undefined) delete process.env.MOENV_KEY; else process.env.MOENV_KEY = val
  try { return await fn() } finally { if (saved === undefined) delete process.env.MOENV_KEY; else process.env.MOENV_KEY = saved }
}
const oldObs = (ageH) => ({ source: OBS_SOURCE, sourceUrl: OBS_SOURCE_URL, license: OBS_LICENSE, station: { name: '麥寮', county: '雲林縣', id: '60', lat: 23.753, lon: 120.251 }, fetchedAt: iso(NOW - ageH * HOUR), history: [{ t: iso(hourAgo(2)), pm25: 8, pm10: 9, aqi: 40, wind: 2 }, { t: iso(hourAgo(1)), pm25: 9, pm10: 10, aqi: 41, wind: 2 }] })

test('refreshAirObs：沒有金鑰（未設 / 空字串 / 只有空白）→ 略過並印那一行、不打任何請求、不算失敗（沒有舊 obs → obs 為 null）', async () => {
  for (const v of [undefined, '', '   ']) {
    await withEnv(v, async () => {
      const logs = [], errs = []
      const f = server()
      const r = await refreshAirObs({}, NOW, { fetch: f, log: (m) => logs.push(m), error: (m) => errs.push(m) })
      assert.deepEqual(logs, ['MOENV_KEY 未設定，略過環境部觀測']); assert.deepEqual(errs, [])
      assert.equal(r.status, 'skipped'); assert.equal(r.obs, null); assert.equal(f.calls.length, 0)
    })
  }
  await withEnv(undefined, async () => {                                                                  // 沒金鑰但舊 obs ≤ 48h → 仍保留；過期 → 移除
    const log = () => {}
    assert.equal((await refreshAirObs({ air: { obs: oldObs(10) } }, NOW, { log })).obs.station.name, '麥寮')
    assert.equal((await refreshAirObs({ air: { obs: oldObs(60) } }, NOW, { log })).obs, null)
  })
})

test('refreshAirObs：有金鑰（環境變數或注入）→ 成功回新的 obs；金鑰不進日誌；注入的 key 優先於環境變數', async () => {
  await withEnv('ENV-KEY-should-not-be-used', async () => {
    const logs = []
    const f = server({ history: [MAILIAO(2), MAILIAO(1), MAILIAO(0)] })
    const r = await refreshAirObs({ air: { obs: oldObs(5) } }, NOW, { key: KEY, fetch: f, retryOpts: FAST, log: (m) => logs.push(m) })
    assert.equal(r.status, 'fresh'); assert.equal(r.obs.history.length, 3); assert.equal(r.obs.station.name, '麥寮'); assert.equal(r.stats.km, r.obs.station.km)
    assert.ok(!leak(logs) && logs.some((l) => /moenv station/.test(l)), logs.join('\n'))
  })
  await withEnv(KEY, async () => {                                                                       // 只靠環境變數
    const r = await refreshAirObs({}, NOW, { fetch: server({ history: [MAILIAO(1), MAILIAO(0)] }), retryOpts: FAST, log: () => {} })
    assert.equal(r.status, 'fresh')
  })
})

test('refreshAirObs：有金鑰但失敗（5xx / 逾時 / 格式不對 / 金鑰錯誤）→ 保留舊 obs（≤ 48h），超過 48h 移除；沒有舊的 → null；錯誤訊息不含金鑰；不丟例外', async () => {
  const fails = {
    '5xx': async () => ({ status: 500, ok: false, text: async () => 'boom' }),
    timeout: async (u) => { throw Object.assign(new Error(`The operation was aborted due to timeout ${u}`), { name: 'TimeoutError' }) },
    shape: async () => ({ status: 200, ok: true, text: async () => '{"unexpected":true}' }),
    key: async () => ({ status: 200, ok: true, text: async () => 'api_key 不存在' }),
  }
  for (const [name, fn] of Object.entries(fails)) {
    const errs = []
    const kept = await refreshAirObs({ air: { obs: oldObs(30) } }, NOW, { key: KEY, fetch: fn, retryOpts: FAST, log: () => {}, error: (m) => errs.push(m) })
    assert.equal(kept.status, 'kept', name); assert.equal(kept.obs.station.name, '麥寮'); assert.equal(kept.obs.history.length, 2)
    assert.ok(errs.length === 1 && /keep old obs/.test(errs[0]) && !leak(errs) && !leak(kept.error), `${name}: ${errs}`)
    const dropped = await refreshAirObs({ air: { obs: oldObs(49) } }, NOW, { key: KEY, fetch: fn, retryOpts: FAST, log: () => {}, error: () => {} })
    assert.equal(dropped.status, 'dropped', name); assert.equal(dropped.obs, null)
    const none = await refreshAirObs({}, NOW, { key: KEY, fetch: fn, retryOpts: FAST, log: () => {}, error: () => {} })
    assert.equal(none.status, 'none', name); assert.equal(none.obs, null)
  }
  const k = await refreshAirObs({}, NOW, { key: KEY, fetch: fails.key, retryOpts: FAST, log: () => {}, error: () => {} })
  assert.match(k.error, /api_key/); assert.ok(!k.error.includes(KEY))
})

test('管線的整合形狀：refreshAirObs 的 obs 併進 air 後，airCompare 需要的欄位（station / fetchedAt / history[].pm25）都在', async () => {
  const r = await refreshAirObs({}, NOW, { key: KEY, fetch: server({ history: Array.from({ length: 24 }, (_, i) => MAILIAO(i)) }), retryOpts: FAST, log: () => {} })
  assert.ok(r.obs.station.name && r.obs.station.county && r.obs.fetchedAt && r.obs.history.every((x) => typeof x.pm25 === 'number' && /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\+08:00$/.test(x.t)))
})

test('說明文字：有 obs 才補的 source / mapping 句子（政府觀測與模型分開標示）；沒有 obs（金鑰移除 / 觀測過期）時舊 mapping 裡的那句被拿掉；冪等', () => {
  assert.ok(OBS_SOURCE_DISCLOSURE.includes('環境部空氣品質監測網') && OBS_SOURCE_DISCLOSURE.includes('政府資料開放授權條款－第1版') && OBS_SOURCE_DISCLOSURE.includes('與上述模型資料分開標示'))
  assert.ok(!OBS_SOURCE_DISCLOSURE.includes('非政府') && AIR_SOURCE_DISCLOSURE.includes('非政府觀測值'))       // 模型那句仍是「非政府觀測值」，觀測那句不會被讀成模型
  assert.ok(OBS_MAPPING.includes('環境部測站觀測') && !OBS_MAPPING.includes(' · '))
  const withObs = appendParts(appendParts('A · B', [AIR_MAPPING]), [OBS_MAPPING])
  assert.equal(appendParts(withObs, [AIR_MAPPING, OBS_MAPPING]), withObs)                                     // 重跑不重複
  assert.equal(withoutObsMapping(withObs, false), appendParts('A · B', [AIR_MAPPING]))                        // 沒有 obs → 拿掉
  assert.equal(withoutObsMapping(withObs, true), withObs)                                                     // 有 obs → 保留
  assert.equal(withoutObsMapping(withoutObsMapping(withObs, false), false), appendParts('A · B', [AIR_MAPPING]))
  assert.equal(withoutObsMapping(undefined, false), undefined); assert.equal(withoutObsMapping('A · B', false), 'A · B')
})
