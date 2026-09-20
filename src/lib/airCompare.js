// 空氣品質：模型（Open-Meteo / CAMS）與環境部測站觀測的並列比較（純函式，Node 可測；沒有任何依賴，遙控頁也能 import）。
// 【介面契約——導覽字幕 / 資料卡 / 遙控頁都依此使用，不要更動名稱與欄位】
//   airCompare(air) → null | {
//     n: 有「模型與觀測都有值」的小時數（PM2.5）,
//     bias: 模型 − 觀測 的平均（μg/m³，正 = 模型高估；兩位小數）, mae: 平均絕對誤差, rmse: 均方根誤差, corr: 相關係數（任一邊沒有變化 → null）,
//     hours: [ISO 小時字串…]（對齊後的時間軸：從第一個有值的小時到最後一個，逐時遞增、連續，缺的小時 model / obs 為 null）,
//     model: [number|null…], obs: [number|null…]（與 hours 等長）,
//     station: { name, county, id?, lat?, lon?, km? }（觀測站；km = 離模型格點的公里數）, obsFetchedAt: ISO,
//   }
//   沒有 air / 沒有 air.obs / 對齊後不足 3 個小時 → null（呼叫端就當作「沒有觀測可比」，維持只有模型的呈現）。
// gov.air.obs 的形狀（由 scripts/gov/moenv.mjs 產生）：{ source, sourceUrl, license, station:{name,county,id,lat,lon}, fetchedAt, history:[{ t:'YYYY-MM-DDTHH:00:00+08:00', pm25, pm10, aqi, wind }] }
//
// 附加的純函式（同一份說法，字幕 / 資料卡 / 遙控頁共用，避免各說各話）：
//   airCompareVerdict(cmp) → 'over' | 'under' | 'match' | 'mixed' | null
//     over：模型平均高估（bias ≥ 1）；under：平均低估（bias ≤ −1）；match：|bias| < 1 且逐時誤差不大（mae ≤ 5）→ 「大致吻合」；
//     mixed：|bias| < 1 但 mae > 5——高低相消，平均看似吻合、逐時其實有落差，不能說「大致吻合」。
//   airCompareParts(cmp) → null | { verdict, station, bias（帶正負號的字串，一位小數）, absBias, mae, n }（給 t(key, p) 用的字串參數）
//   airObsUsable(air) → boolean：air.obs 有沒有至少 2 個有效的 PM2.5 小時（資料卡「驅動海況的資料」切換要不要出現）
//   hourMs(t) → 該小時起點的絕對毫秒（無時區的字串視為台北時間）；不合法 → null
//   isoHour(ms) → 'YYYY-MM-DDTHH:00:00+08:00'
const HOUR = 3600 * 1000
const TAIPEI = 8 * HOUR
export const AIR_COMPARE_MIN = 3            // 至少要有幾個「兩邊都有值」的小時
export const AIR_COMPARE_MAX_HOURS = 240    // 時間軸最長（保留最近的）；正常資料只有 120 小時
export const AIR_MATCH_BIAS = 1             // |bias| < 1 μg/m³ → 平均上大致吻合
export const AIR_MATCH_MAE = 5              // 但逐時平均絕對誤差 > 5 μg/m³ 就不算「大致吻合」

const PM_MAX = 1000
const val = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= PM_MAX ? v : null)   // 只收有限數字（含 0）；負值 / 哨兵值 / 字串都當缺值
const r2 = (v) => Math.round(v * 100) / 100

/** 時間字串 → 該小時起點的絕對毫秒。'2026-09-20T21:00:00+08:00' / '…Z' / '…+0800' / '2026-09-20 21:00'（無時區 = 台北時間）都收；不合法 → null */
export function hourMs(t) {
  let s = typeof t === 'string' ? t.trim() : ''
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}/.test(s)) return null
  s = s.replace(' ', 'T')
  s = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')   // +0800 → +08:00（已通過上面的格式檢查，結尾一定是時間，不會誤傷日期）
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(s)) s += '+08:00'
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? Math.floor(ms / HOUR) * HOUR : null
}
export const isoHour = (ms) => new Date(ms + TAIPEI).toISOString().slice(0, 13) + ':00:00+08:00'

// history → Map(小時起點 ms → PM2.5)。重複小時：後面的非 null 值蓋掉前面的（null 不蓋掉已有的值）
function byHour(history) {
  const m = new Map()
  for (const x of Array.isArray(history) ? history : []) {
    const ms = x && typeof x === 'object' ? hourMs(x.t) : null
    const v = x && typeof x === 'object' ? val(x.pm25) : null
    if (ms === null || v === null) continue
    m.set(ms, v)
  }
  return m
}

/** air.obs 有沒有可用的觀測（至少 2 個有效的 PM2.5 小時） */
export function airObsUsable(air) {
  return byHour(air && air.obs && air.obs.history).size >= 2
}

export function airCompare(air) {
  if (!air || typeof air !== 'object' || !air.obs || typeof air.obs !== 'object') return null
  const model = byHour(air.history), obs = byHour(air.obs.history)
  const keys = [...new Set([...model.keys(), ...obs.keys()])]
  if (!keys.length) return null
  const first = Math.max(Math.min(...keys), Math.max(...keys) - (AIR_COMPARE_MAX_HOURS - 1) * HOUR), last = Math.max(...keys)
  const hours = [], mv = [], ov = [], diffs = [], ms = [], os = []
  for (let h = first; h <= last; h += HOUR) {
    const a = model.has(h) ? model.get(h) : null, b = obs.has(h) ? obs.get(h) : null
    hours.push(isoHour(h)); mv.push(a); ov.push(b)
    if (a !== null && b !== null) { diffs.push(a - b); ms.push(a); os.push(b) }
  }
  const n = diffs.length
  if (n < AIR_COMPARE_MIN) return null
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length
  const mm = mean(ms), mo = mean(os)
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) { const dx = ms[i] - mm, dy = os[i] - mo; sxy += dx * dy; sxx += dx * dx; syy += dy * dy }
  const corr = sxx > 1e-12 && syy > 1e-12 ? Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy))) : null
  const st = air.obs.station && typeof air.obs.station === 'object' ? air.obs.station : {}
  const station = { name: typeof st.name === 'string' ? st.name : '', county: typeof st.county === 'string' ? st.county : '' }
  for (const k of ['id', 'lat', 'lon', 'km']) if (st[k] !== undefined && st[k] !== null && st[k] !== '') station[k] = st[k]
  return {
    n, bias: r2(mean(diffs)), mae: r2(mean(diffs.map(Math.abs))), rmse: r2(Math.sqrt(mean(diffs.map((d) => d * d)))), corr: corr === null ? null : r2(corr),
    hours, model: mv, obs: ov, station, obsFetchedAt: typeof air.obs.fetchedAt === 'string' ? air.obs.fetchedAt : '',
  }
}

/** 模型相對觀測的一句話結論類別（見檔頭）。null → null */
export function airCompareVerdict(cmp) {
  if (!cmp || typeof cmp.bias !== 'number' || !Number.isFinite(cmp.bias)) return null
  if (Math.abs(cmp.bias) < AIR_MATCH_BIAS) return typeof cmp.mae === 'number' && cmp.mae > AIR_MATCH_MAE ? 'mixed' : 'match'
  return cmp.bias > 0 ? 'over' : 'under'
}

/** 給 t(key, params) 的字串參數：bias 一位小數（match / mixed 帶 + / − 號）、absBias 取絕對值；沒有比較 → null */
export function airCompareParts(cmp) {
  const verdict = airCompareVerdict(cmp)
  if (!verdict) return null
  const f1 = (v) => (Math.round(Math.abs(v) * 10) / 10).toFixed(1)
  const sign = cmp.bias < 0 && Math.round(Math.abs(cmp.bias) * 10) > 0 ? '−' : cmp.bias > 0 && Math.round(cmp.bias * 10) > 0 ? '+' : ''
  return {
    verdict, station: cmp.station && cmp.station.name ? cmp.station.name : '', bias: sign + f1(cmp.bias), absBias: f1(cmp.bias),
    mae: f1(cmp.mae), n: cmp.n,
  }
}
