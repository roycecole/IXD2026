// 空氣品質「模型 vs 環境部觀測」比較（純函式）的測試。執行：node --test src/lib/airCompare.test.mjs
// 觀測資料一律是本檔內的合成 fixture（真實建置沒有金鑰就沒有 air.obs）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { airCompare, airCompareVerdict, airCompareParts, airObsUsable, hourMs, isoHour, AIR_COMPARE_MIN, AIR_COMPARE_MAX_HOURS, AIR_MATCH_BIAS, AIR_MATCH_MAE } from './airCompare.js'

const H = 3600e3
const T0 = Date.parse('2026-09-20T00:00:00+08:00')
const iso = (h) => isoHour(T0 + h * H)                                       // 第 h 小時（相對 09-20 00:00 台北時間）
const mrow = (h, pm25, extra = {}) => ({ t: iso(h), pm10: 30, pm25, dust: 0, aqi: 80, ...extra })
const orow = (h, pm25, extra = {}) => ({ t: iso(h), pm25, pm10: 40, aqi: 60, wind: 2, ...extra })
const STATION = { name: '麥寮', county: '雲林縣', id: '60', lat: 23.753, lon: 120.251, km: 4.1 }
const air = (model, obs, extra = {}) => ({ county: '雲林縣', place: '麥寮', history: model, obs: { source: 's', station: STATION, fetchedAt: '2026-09-20T21:30:00+08:00', history: obs, ...extra } })
const naive = (m, o) => {                                                    // 獨立的算法：逐小時對照
  const d = m.map((x, i) => x - o[i]), n = d.length, mean = (a) => a.reduce((s, x) => s + x, 0) / n
  const mm = mean(m), mo = mean(o)
  const cov = m.reduce((s, x, i) => s + (x - mm) * (o[i] - mo), 0), vm = m.reduce((s, x) => s + (x - mm) ** 2, 0), vo = o.reduce((s, x) => s + (x - mo) ** 2, 0)
  return { n, bias: mean(d), mae: mean(d.map(Math.abs)), rmse: Math.sqrt(mean(d.map((x) => x * x))), corr: vm > 0 && vo > 0 ? cov / Math.sqrt(vm * vo) : null }
}
const close = (a, b, eps = 0.006) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`)

test('契約：欄位 / 型別 / hours 遞增連續 / model、obs 與 hours 等長 / station 與 obsFetchedAt', () => {
  const m = [10, 12, 15, 20, 18, 16], o = [8, 11, 14, 22, 15, 13]
  const r = airCompare(air(m.map((v, i) => mrow(i, v)), o.map((v, i) => orow(i, v))))
  assert.deepEqual(Object.keys(r), ['n', 'bias', 'mae', 'rmse', 'corr', 'hours', 'model', 'obs', 'station', 'obsFetchedAt'])
  assert.equal(r.n, 6)
  assert.deepEqual(r.hours, [0, 1, 2, 3, 4, 5].map(iso)); assert.match(r.hours[0], /^2026-09-20T00:00:00\+08:00$/)
  assert.deepEqual(r.model, m); assert.deepEqual(r.obs, o)
  assert.equal(r.hours.length, r.model.length); assert.equal(r.hours.length, r.obs.length)
  assert.deepEqual(r.station, STATION); assert.equal(r.obsFetchedAt, '2026-09-20T21:30:00+08:00')
  const e = naive(m, o)
  close(r.bias, e.bias); close(r.mae, e.mae); close(r.rmse, e.rmse); close(r.corr, e.corr)
  assert.ok(r.bias > 0, '模型高估 → bias 為正'); assert.ok(r.rmse >= r.mae)
  assert.deepEqual([AIR_COMPARE_MIN, AIR_COMPARE_MAX_HOURS, AIR_MATCH_BIAS, AIR_MATCH_MAE], [3, 240, 1, 5])
})

test('bias 的正負：模型比觀測高 → 正、低 → 負；完全相同 → 0', () => {
  const rows = (vals) => vals.map((v, i) => mrow(i, v)), obs = [10, 10, 10, 10].map((v, i) => orow(i, v))
  assert.equal(airCompare(air(rows([15, 15, 15, 15]), obs)).bias, 5)
  assert.equal(airCompare(air(rows([7, 7, 7, 7]), obs)).bias, -3)
  const same = airCompare(air(rows([10, 10, 10, 10]), obs))
  assert.deepEqual([same.bias, same.mae, same.rmse, same.corr], [0, 0, 0, null])
})

test('不足 3 個「兩邊都有值」的小時 → null；沒有 air / 沒有 obs / 壞輸入 → null，不炸', () => {
  const m = [10, 11, 12, 13].map((v, i) => mrow(i, v))
  assert.equal(airCompare(air(m, [10, 11].map((v, i) => orow(i, v)))), null)                  // 只有 2 小時重疊
  assert.ok(airCompare(air(m, [10, 11, 12].map((v, i) => orow(i, v)))))                        // 3 小時剛好
  assert.equal(airCompare(air(m, [10, 11, 12].map((v, i) => orow(i + 10, v)))), null)          // 時間完全不重疊
  assert.equal(airCompare(air(m, [])), null)
  assert.equal(airCompare({ history: m }), null); assert.equal(airCompare({ history: m, obs: null }), null); assert.equal(airCompare({ history: m, obs: 'x' }), null)
  assert.equal(airCompare({ history: [], obs: { history: [] } }), null)
  for (const junk of [null, undefined, 5, 'x', [], {}, { obs: {} }, { history: 'x', obs: { history: 'y' } }, { history: [null, 5], obs: { history: [null, 'x', {}] } }]) assert.equal(airCompare(junk), null, JSON.stringify(junk))
})

test('缺值：null / undefined / NaN / 字串 / 負值 / 越界都當缺值；0 是有效值；缺值的小時在對應那條線是 null，n 只算兩邊都有的', () => {
  const m = [10, null, 12, undefined, 14, NaN, 16, '18', 1001, -1].map((v, i) => mrow(i, v))
  const o = [10, 11, null, 13, 14, 15, 0, 17, 18, 19].map((v, i) => orow(i, v))
  const r = airCompare(air(m, o))
  assert.deepEqual(r.model, [10, null, 12, null, 14, null, 16, null, null, null])
  assert.deepEqual(r.obs, [10, 11, null, 13, 14, 15, 0, 17, 18, 19])
  assert.equal(r.n, 3)                                                                          // 小時 0、4、6 兩邊都有
  const e = naive([10, 14, 16], [10, 14, 0]); close(r.bias, e.bias); close(r.mae, e.mae)
  assert.equal(r.hours.length, 10)
  // 缺 pm25 鍵 / 型別亂的整列
  assert.ok(airCompare(air([mrow(0, 1), { t: iso(1) }, null, 7, mrow(2, 3), mrow(3, 5)], [orow(0, 1), orow(2, 3), orow(3, 5), 'x'])))
})

test('時間軸：兩邊涵蓋的時段不同 → 取聯集、逐時連續（缺的小時兩邊都是 null）；n 只算重疊；比較只在重疊時段', () => {
  const m = Array.from({ length: 24 }, (_, i) => mrow(i, 20 + (i % 5)))                         // 模型 0–23 時
  const o = [20, 21, 22, 23, 24].map((v, i) => orow(i + 18, v))                                 // 觀測只有 18–22 時
  const r = airCompare(air(m, o))
  assert.equal(r.hours.length, 24); assert.equal(r.hours[0], iso(0)); assert.equal(r.hours[23], iso(23))
  assert.equal(r.n, 5); assert.deepEqual(r.obs.slice(0, 18).filter((x) => x !== null), []); assert.deepEqual(r.obs.slice(18, 23), [20, 21, 22, 23, 24]); assert.equal(r.obs[23], null)
  // 中間有洞（兩邊都缺的小時）→ 時間軸仍連續，不會把 2 小時的空缺壓成 1 格
  const gap = airCompare(air([0, 1, 2, 5, 6, 7].map((h) => mrow(h, 10)), [0, 1, 2, 5, 6, 7].map((h) => orow(h, 12))))
  assert.deepEqual(gap.hours, [0, 1, 2, 3, 4, 5, 6, 7].map(iso)); assert.deepEqual(gap.model, [10, 10, 10, null, null, 10, 10, 10]); assert.equal(gap.n, 6)
  // 遞增（輸入亂序也一樣）
  const shuffled = airCompare(air([...m].reverse(), [...o].reverse()))
  assert.deepEqual(shuffled.hours, r.hours); assert.deepEqual(shuffled.model, r.model)
})

test('重複的小時：後面的非 null 值蓋掉前面的；null 不會蓋掉已有的值', () => {
  const m = [mrow(0, 10), mrow(0, 12), mrow(1, 20), mrow(1, null), mrow(2, 5), mrow(3, 7)]
  const o = [orow(0, 1), orow(1, 2), orow(2, 3), orow(2, 4), orow(3, 9)]
  const r = airCompare(air(m, o))
  assert.deepEqual(r.model, [12, 20, 5, 7]); assert.deepEqual(r.obs, [1, 2, 4, 9]); assert.equal(r.n, 4); assert.equal(r.hours.length, 4)
})

test('時區字串：+08:00 / Z / +0800 / 無時區（台北時間）/ 空白分隔 / 有分鐘秒數，都對到同一個整點', () => {
  const t8 = '2026-09-20T13:00:00+08:00'
  for (const same of ['2026-09-20T05:00:00Z', '2026-09-20T13:00:00+0800', '2026-09-20T13:00', '2026-09-20 13:00', '2026-09-20 13:00:00', '2026-09-20T13:45:30+08:00', '2026-09-20T05:59:59Z', '2026-09-19T21:00:00-08:00']) {
    assert.equal(hourMs(same), Date.parse(t8), same)
  }
  assert.equal(isoHour(hourMs('2026-09-20T05:00:00Z')), t8)
  for (const bad of ['', null, undefined, 5, 'nope', '2026-09-20', '2026-13-01T00:00', '2026-09-20T25:00:00+08:00', {}]) assert.equal(hourMs(bad), null, String(bad))
  // 混用寫法的兩邊仍能對齊
  const r = airCompare(air([{ t: '2026-09-20T05:00:00Z', pm25: 10 }, { t: '2026-09-20T06:00:00Z', pm25: 12 }, { t: '2026-09-20T07:00:00Z', pm25: 14 }], [{ t: '2026-09-20 13:20', pm25: 9 }, { t: '2026-09-20T14:00:00+0800', pm25: 10 }, { t: '2026-09-20T14:00:00+08:00', pm25: 11 }]))
  assert.equal(r, null)                                                                        // 只有 2 小時（13、14 時）重疊 → 不足 3 → null
  const r3 = airCompare(air([{ t: '2026-09-20T05:00:00Z', pm25: 10 }, { t: '2026-09-20T06:00:00Z', pm25: 12 }, { t: '2026-09-20T07:00:00Z', pm25: 14 }], [{ t: '2026-09-20 13:20', pm25: 9 }, { t: '2026-09-20T14:00:00+0800', pm25: 10 }, { t: '2026-09-20T15:10:00+08:00', pm25: 11 }]))
  assert.deepEqual(r3.hours, ['2026-09-20T13:00:00+08:00', '2026-09-20T14:00:00+08:00', '2026-09-20T15:00:00+08:00']); assert.deepEqual([r3.model, r3.obs], [[10, 12, 14], [9, 10, 11]])
})

test('corr：完全同向 = 1、完全反向 = −1、任一邊完全沒變化 → null；夾在 −1..1；rmse ≥ mae', () => {
  const up = [1, 2, 3, 4, 5].map((v, i) => mrow(i, v)), down = [5, 4, 3, 2, 1].map((v, i) => orow(i, v)), flat = [7, 7, 7, 7, 7].map((v, i) => orow(i, v))
  assert.equal(airCompare(air(up, [2, 4, 6, 8, 10].map((v, i) => orow(i, v)))).corr, 1)
  assert.equal(airCompare(air(up, down)).corr, -1)
  assert.equal(airCompare(air(up, flat)).corr, null); assert.equal(airCompare(air(flat.map((x) => ({ ...x })), down)).corr, null)
  const noisy = airCompare(air([3, 9, 4, 8, 6, 2].map((v, i) => mrow(i, v)), [4, 7, 5, 9, 5, 3].map((v, i) => orow(i, v))))
  assert.ok(noisy.corr > 0 && noisy.corr <= 1 && noisy.rmse >= noisy.mae)
})

test('時間軸上限：最長保留最近 240 小時（模型 / 觀測各 300 小時 → 取最近 240）；輸入不被改動', () => {
  const m = Array.from({ length: 300 }, (_, i) => mrow(i, 10 + (i % 7))), o = Array.from({ length: 300 }, (_, i) => orow(i, 12 + (i % 5)))
  const a = air(m, o), before = structuredClone(a)
  const r = airCompare(a)
  assert.deepEqual(a, before)
  assert.equal(r.hours.length, AIR_COMPARE_MAX_HOURS); assert.equal(r.n, AIR_COMPARE_MAX_HOURS)
  assert.equal(r.hours[r.hours.length - 1], iso(299)); assert.equal(r.hours[0], iso(60))
})

test('station：缺欄位 / 缺測站 → 空字串名稱、沒有 id / lat / lon；obsFetchedAt 缺 → 空字串', () => {
  const rows = [1, 2, 3].map((v, i) => mrow(i, v)), obs = [2, 3, 4].map((v, i) => orow(i, v))
  const a = { history: rows, obs: { history: obs } }
  const r = airCompare(a)
  assert.deepEqual(r.station, { name: '', county: '' }); assert.equal(r.obsFetchedAt, '')
  const r2 = airCompare({ history: rows, obs: { history: obs, station: { name: '崙背', county: '雲林縣', id: null, lat: '' } } })
  assert.deepEqual(r2.station, { name: '崙背', county: '雲林縣' })
})

test('airObsUsable：至少 2 個有效的 PM2.5 小時（不看模型）', () => {
  const o = (vals) => ({ obs: { history: vals.map((v, i) => orow(i, v)) } })
  assert.equal(airObsUsable(o([1, 2])), true); assert.equal(airObsUsable(o([1])), false); assert.equal(airObsUsable(o([1, null, 'x', 5000])), false); assert.equal(airObsUsable(o([0, 0])), true)
  for (const junk of [null, undefined, {}, { obs: null }, { obs: {} }, { obs: { history: 'x' } }, 5]) assert.equal(airObsUsable(junk), false, JSON.stringify(junk))
})

test('airCompareVerdict：高估 / 低估 / 大致吻合（|平均差| < 1 且逐時誤差不大）/ 高低相消但逐時落差明顯（mixed）；邊界值', () => {
  const v = (bias, mae) => airCompareVerdict({ bias, mae })
  assert.equal(v(8.2, 9.1), 'over'); assert.equal(v(-8.2, 9.1), 'under')
  assert.equal(v(1, 2), 'over'); assert.equal(v(-1, 2), 'under')                                // 剛好 ±1 → 不算吻合
  assert.equal(v(0.99, 2), 'match'); assert.equal(v(-0.99, 2), 'match'); assert.equal(v(0, 0), 'match')
  assert.equal(v(0.2, 5), 'match'); assert.equal(v(0.2, 5.01), 'mixed')                          // mae 5 是「不大」的上限
  assert.equal(v(-0.4, 12), 'mixed')
  for (const bad of [null, undefined, {}, { bias: NaN }, { bias: 'x' }, 5]) assert.equal(airCompareVerdict(bad), null)
})

test('airCompareParts：字串參數（一位小數、match / mixed 帶正負號、over / under 用 absBias）；沒有比較 → null', () => {
  const st = { name: '麥寮', county: '雲林縣' }
  assert.deepEqual(airCompareParts({ bias: 8.24, mae: 9.06, n: 96, station: st }), { verdict: 'over', station: '麥寮', bias: '+8.2', absBias: '8.2', mae: '9.1', n: 96 })
  assert.deepEqual(airCompareParts({ bias: -3.05, mae: 4, n: 10, station: st }), { verdict: 'under', station: '麥寮', bias: '−3.1', absBias: '3.1', mae: '4.0', n: 10 })   // 3.05 → 浮點誤差下四捨五入的方向不重要，重點是一位小數
  const m = airCompareParts({ bias: 0.4, mae: 2, n: 5, station: st }); assert.equal(m.verdict, 'match'); assert.equal(m.bias, '+0.4')
  const z = airCompareParts({ bias: 0.02, mae: 1, n: 5, station: st }); assert.equal(z.bias, '0.0')                // 四捨五入後是 0.0 → 不帶號
  const n = airCompareParts({ bias: -0.04, mae: 1, n: 5, station: st }); assert.equal(n.bias, '0.0')
  assert.equal(airCompareParts({ bias: 5, mae: 5, n: 5 }).station, '')
  assert.equal(airCompareParts(null), null); assert.equal(airCompareParts({}), null)
})

test('與真實 ocean.json 銜接：沒有金鑰的建置 → air.obs 不存在 → airCompare 為 null；用合成觀測（真實模型序列 + 固定偏移）能比出預期的偏差', () => {
  const real = JSON.parse(readFileSync(new URL('../../public/data/ocean.json', import.meta.url), 'utf8'))
  if (!real.air.obs) assert.equal(airCompare(real.air), null)                                    // 現況：沒有 obs，UI 維持只有模型
  const synthetic = { ...real.air, obs: { source: 'fixture', station: STATION, fetchedAt: real.air.fetchedAt, history: real.air.history.map((x) => ({ t: x.t, pm25: x.pm25 === null ? null : Math.max(0, x.pm25 - 6) })) } }
  const r = airCompare(synthetic)
  assert.ok(r.n >= 100 && r.hours.length === real.air.history.length)
  assert.ok(Math.abs(r.bias - 6) < 0.6, `bias ${r.bias}（偏移 6，只有 max(0, …) 截斷的小時會少一點）`); assert.ok(r.corr > 0.95)
})

test('hourMs / isoHour 往返：任一整點來回不變；台北沒有夏令時間', () => {
  for (const h of [0, 1, 23, 24, 100, 4000]) assert.equal(hourMs(isoHour(T0 + h * H)), T0 + h * H)
  assert.equal(isoHour(Date.parse('2026-01-01T00:00:00Z')), '2026-01-01T08:00:00+08:00')
})
