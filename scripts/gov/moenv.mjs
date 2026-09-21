// 環境部（MOENV）空氣品質監測網「測站觀測」→ air.obs（與 Open-Meteo / CAMS 模型並列，做「模型 vs 觀測」的敘事）。純函式 + 可注入 fetch，Node 可測。
//   環境部資料開放平台的 API 需要「使用者自己申請」的金鑰（MOENV_KEY）：金鑰只從環境變數（CI 為 GitHub Secret）傳進來，
//   絕不寫進程式 / 日誌 / ocean.json——所有錯誤訊息與日誌都經過 maskKey()，URL 中的 api_key 一律遮成 ***。
//   沒有金鑰 → 整條管線不啟動（呼叫端印「MOENV_KEY 未設定，略過環境部觀測」），現有畫面完全不變。
//
// 資料集（欄位格式依環境部資料集目錄的公開說明；本模組只用 fixture 驗證，尚未用真實金鑰驗證——第一次有金鑰時請看 CI 日誌）：
//   目前值 aqx_p_432：sitename, county, aqi, pollutant, status, so2, co, o3, o3_8hr, pm10, pm2.5, no2, nox, no, wind_speed, wind_direc,
//                    publishtime 'YYYY/MM/DD HH:mm:ss', co_8hr, pm2.5_avg, pm10_avg, so2_avg, longitude, latitude, siteid
//   歷史 aqx_p_488：sitename（例如「屏東（枋山）」）, county, aqi, pollutant, status, …, pm10, pm2.5, no2, nox, no, windspeed, winddirec,
//                    datacreationdate 'YYYY-MM-DD HH:mm'（台灣時間）, longitude, latitude, siteid, unit
//   值都是字串；空字串 / 'ND' / 'NR' / '-' / '*'（或帶旗標的 '12#'）表示無效。
//   API 基底 https://data.moenv.gov.tw/api/v2/<代碼>?api_key=…；OpenAPI（https://data.moenv.gov.tw/swagger/openapi.yaml）只列 language / offset / limit / api_key，
//   沒有 filters——所以歷史資料用 limit + offset 分頁（另帶 sort / format，若 API 拒絕就去掉重試），並在客戶端依測站過濾。
//   回應是 { records: [...] } 或直接陣列，兩種都收。
import { toNum, toTaipeiIso, round } from './util.mjs'
import { retry } from './http.mjs'

export const MOENV_BASE = 'https://data.moenv.gov.tw/api/v2'
export const MOENV_CURRENT_ID = 'aqx_p_432'   // 空氣品質指標(AQI)：各測站最新一小時
export const MOENV_HISTORY_ID = 'aqx_p_488'   // 空氣品質指標(AQI)(歷史資料)：各測站逐時
export const OBS_LICENSE = '政府資料開放授權條款－第1版'
export const OBS_SOURCE = `環境部空氣品質監測網（${OBS_LICENSE}）`
export const OBS_SOURCE_URL = 'https://data.moenv.gov.tw/'
export const OBS_MAX_KM = 25          // 測站離模型格點最遠 25 公里；超過就不比（距離太遠，比較沒有意義）
export const OBS_HISTORY_MAX = 120    // 與模型 history 同長：最近 120 小時
export const OBS_STALE_HOURS = 48     // 抓不到新的時，舊觀測最多再撐 48 小時；超過就移除（過期的觀測不能當現在的）
export const OBS_PAGE_LIMIT = 1000    // API 預設 / 單次上限
export const OBS_MAX_PAGES = 14       // 歷史分頁最多幾頁（1000 筆 ≈ 12 小時 × 全國 80+ 站：120 小時約 10–11 頁）
export const OBS_MAX_AGE_HOURS = 240  // 歷史裡比這更舊的小時不收（例如 API 忽略 sort、回的是很久以前的資料）
export const OBS_FRESH_HOURS = 12      // 抓到的觀測，最新的有效 PM2.5 小時必須在 12 小時內：測站停測多日（歷史還留著舊小時）時，不能把幾天前的觀測當「現在」用
export const OBS_TIMEOUT_MS = 60000
const HOUR = 3600 * 1000

// ---- 金鑰處理 ----
/** 環境變數 → 金鑰字串；未設 / 空字串 / 只有空白（GitHub 沒設 secret 時是空字串）→ ''。 */
export const normalizeKey = (v) => (typeof v === 'string' ? v.trim() : '')

/** 遮蔽文字裡的金鑰：URL 的 api_key=… 一律 → api_key=***；若知道金鑰本身，出現在任何位置（含 URL 編碼形式）也遮掉。 */
export function maskKey(text, key = '') {
  let s = String(text ?? '').replace(/(api_key=)[^&\s"'<>]*/gi, '$1***')
  const k = normalizeKey(key)
  if (k) for (const form of new Set([k, encodeURIComponent(k)])) s = s.split(form).join('***')
  return s
}

/** 請求網址。金鑰只出現在這裡（呼叫端不要印它，要印請先 maskKey）。sort 為 null / '' 則不帶。 */
export function buildMoenvUrl(dataset, key, { limit = OBS_PAGE_LIMIT, offset = 0, sort = '', format = 'json' } = {}) {
  const q = [['api_key', normalizeKey(key)], ['limit', String(limit)], ['offset', String(offset)]]
  if (sort) q.push(['sort', sort])
  if (format) q.push(['format', format])
  return `${MOENV_BASE}/${encodeURIComponent(dataset)}?` + q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
}

// ---- 距離 / 欄位 / 數值 ----
/** 兩點（度）的大圓距離（公里） */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)))
}

// 一列記錄 → 鍵一律小寫的物件（不同端點的欄位大小寫可能不同：sitename / SiteName / PM2.5 / pm2.5）
function lower(rec) {
  const o = {}
  if (rec && typeof rec === 'object' && !Array.isArray(rec)) for (const [k, v] of Object.entries(rec)) o[String(k).toLowerCase()] = v
  return o
}
const first = (r, ...names) => { for (const n of names) if (r[n] !== undefined && r[n] !== null && String(r[n]).trim() !== '') return r[n]; return undefined }
const text = (v) => (v === undefined || v === null ? '' : String(v).trim())

// 只收「純數字」的字串或有限數字；'' / 'ND' / 'NR' / '-' / '*' / '12#' / '1e3' 都是無效。範圍外 → null。
const PLAIN_NUM = /^-?\d+(?:\.\d+)?$/
function value(v, lo, hi) {
  const n = typeof v === 'number' ? (Number.isFinite(v) ? v : null) : typeof v === 'string' && PLAIN_NUM.test(v.trim()) ? toNum(v) : null
  return n === null || n < lo || n > hi ? null : n
}
export const pmValue = (v) => { const n = value(v, 0, 1000); return n === null ? null : round(n, 1) }
export const aqiValue = (v) => { const n = value(v, 0, 1000); return n === null ? null : Math.round(n) }
export const windValue = (v) => { const n = value(v, 0, 100); return n === null ? null : round(n, 1) }   // m/s

/** 時間字串 → 絕對毫秒。'2026/09/20 04:00:00'、'2026-09-20 21:00'、'2026-09-20T21:00:00+08:00' 都收；沒時區 = 台灣時間；不合法（含 2/30、25 點）→ null */
export function obsTimeMs(s) {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(text(s))
  if (!m) return null
  const [y, mo, d, h, mi, sec] = [m[1], m[2], m[3], m[4], m[5], m[6] || '0'].map(Number)
  const ms = Date.UTC(y, mo - 1, d, h, mi, sec)
  const back = new Date(ms)
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || sec > 59 || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  let offMin = 8 * 60
  if (m[7]) offMin = /^z$/i.test(m[7]) ? 0 : (m[7][0] === '-' ? -1 : 1) * (Number(m[7].slice(1, 3)) * 60 + Number(m[7].slice(-2)))
  return ms - offMin * 60000
}
const hourFloor = (ms) => Math.floor(ms / HOUR) * HOUR

// ---- 回應解析 ----
/** JSON → 記錄陣列。{ records: [...] } 或直接陣列都收；其他形狀 → null（呼叫端當作格式不對） */
export function extractRecords(json) {
  if (Array.isArray(json)) return json
  if (json && typeof json === 'object' && Array.isArray(json.records)) return json.records
  return null
}

const KEY_ERROR_RE = /api[_ ]?key|金鑰|apikey/i
/** 一個 fetch 回應 →（已解析的）JSON。錯誤一律不含金鑰：HTTP 非 2xx（有 status，4xx 不重試）、金鑰錯誤（純文字「api_key 不存在」之類 → status 401、code 'KEY'）、非 JSON。 */
export async function readMoenvResponse(res, url, key = '') {
  let body = ''
  try { body = await res.text() } catch (e) { throw new Error(`MOENV read failed: ${maskKey(e && e.message, key)}`) }
  const keyErr = () => Object.assign(new Error('MOENV api_key 無效或不存在（請確認 GitHub Secret MOENV_KEY 是環境部會員專區取得的金鑰）'), { status: 401, code: 'KEY' })
  if (!res.ok) {
    if (KEY_ERROR_RE.test(body) && res.status >= 400 && res.status < 500) throw keyErr()
    throw Object.assign(new Error(`HTTP ${res.status} ${maskKey(url, key)}`), { status: res.status })
  }
  let json
  try { json = JSON.parse(body) } catch (e) {
    if (KEY_ERROR_RE.test(body)) throw keyErr()
    throw new Error(`MOENV non-JSON response: ${maskKey(body.slice(0, 60).replace(/\s+/g, ' '), key)}`)
  }
  if (!extractRecords(json) && KEY_ERROR_RE.test(body.slice(0, 400))) throw keyErr()   // 200 但回 { "message": "api_key 不存在" } 之類
  return json
}

// ---- 測站選擇 ----
/**
 * 目前值資料集的記錄 → 距離模型格點最近、且在 maxKm 內、狀態非空的測站；沒有 → null。不硬編碼任何測站 / siteid。
 * 優先挑「目前 PM2.5 有效」的測站：最近的站掛著「設備維護」之類非空狀態、PM2.5 卻是空的（停測中）時，改用次近且有值的站；
 * 範圍內沒有任何一站有有效的目前 PM2.5，才退回最近的有狀態測站（是否過期由 fetchAirObs 的新鮮度檢查決定）。
 * 回傳 { name, county, id, lat, lon, km }（id 為字串或 null；km 一位小數）。
 */
export function pickStation(records, { lat, lon, maxKm = OBS_MAX_KM } = {}) {
  if (!Array.isArray(records) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null
  let bestValid = null, bestAny = null   // bestValid：目前 PM2.5 有效的最近站；bestAny：不論有沒有值的最近站（退路）
  for (const rec of records) {
    const r = lower(rec)
    const name = text(first(r, 'sitename', 'site_name'))
    const status = text(r.status)
    const la = toNum(first(r, 'latitude', 'lat')), lo = toNum(first(r, 'longitude', 'lon', 'lng'))
    if (!name || !status || la === null || lo === null || la < -90 || la > 90 || lo < -180 || lo > 180) continue   // 狀態空白 = 停測 / 維護中
    const km = haversineKm(lat, lon, la, lo)
    if (km > maxKm) continue
    const id = text(first(r, 'siteid', 'site_id'))
    const cand = { name, county: text(r.county), id: id || null, lat: la, lon: lo, km }
    if (!bestAny || km < bestAny.km) bestAny = cand                                                      // 同距離取先出現的
    if (pmValue(first(r, 'pm2.5', 'pm25', 'pm2_5')) !== null && (!bestValid || km < bestValid.km)) bestValid = cand
  }
  const best = bestValid || bestAny
  return best && { ...best, km: round(best.km, 1) }
}

// ---- 歷史 ----
const normCounty = (s) => text(s).replace(/臺/g, '台')
/** 歷史記錄裡屬於該測站的列：有 siteid 就依 siteid；沒有（或全都對不上）就依 county + sitename 包含測站名（歷史的 sitename 形如「雲林（麥寮）」） */
export function filterStationRecords(records, station) {
  const recs = Array.isArray(records) ? records.map(lower) : []
  if (!station) return []
  if (station.id != null) {
    const bySite = recs.filter((r) => text(first(r, 'siteid', 'site_id')) === String(station.id))
    if (bySite.length) return bySite
  }
  const name = text(station.name), county = normCounty(station.county)
  if (!name) return []
  return recs.filter((r) => {
    const sn = text(first(r, 'sitename', 'site_name'))
    if (!sn || !sn.includes(name)) return false
    const c = normCounty(r.county)
    return !county || !c || c === county
  })
}

// 一列（小寫鍵）→ { ms, row }；時間不合法 / 四個欄位都無效 → null。歷史用 datacreationdate / windspeed，目前值用 publishtime / wind_speed
function obsRow(r) {
  const at = obsTimeMs(first(r, 'datacreationdate', 'publishtime', 'monitordate', 'time'))
  if (at === null) return null
  const ms = hourFloor(at)
  const row = {
    t: toTaipeiIso(ms), pm25: pmValue(first(r, 'pm2.5', 'pm25', 'pm2_5')), pm10: pmValue(r.pm10), aqi: aqiValue(r.aqi),
    wind: windValue(first(r, 'windspeed', 'wind_speed')),
  }
  return row.pm25 === null && row.pm10 === null && row.aqi === null && row.wind === null ? null : { ms, row, at }
}
const OBS_FIELDS = ['pm25', 'pm10', 'aqi', 'wind']

/**
 * 歷史記錄（已過濾成單一測站）→ history 列：t 對齊整點（'YYYY-MM-DDTHH:00:00+08:00'）、遞增、依小時去重（同一小時較晚的記錄優先；缺值不蓋掉已有的值）、
 * 丟掉「現在以後」的小時（與比 maxAgeMs 更舊的小時）、最近 max 筆。欄位 { t, pm25, pm10, aqi, wind }，無效值 → null；全欄位無效的小時略過。
 */
export function buildObsHistory(rows, { nowMs = Date.now(), max = OBS_HISTORY_MAX, maxAgeMs = Infinity } = {}) {
  const byMs = new Map()
  const seq = (Array.isArray(rows) ? rows : []).map((x) => (x && x.ms !== undefined && x.row ? x : obsRow(lower(x)))).filter(Boolean)
  seq.sort((a, b) => (a.at ?? a.ms) - (b.at ?? b.ms))   // 同一小時：較晚的記錄後處理、覆蓋前面的（缺值除外）
  for (const { ms, row } of seq) {
    const prev = byMs.get(ms)
    byMs.set(ms, prev ? Object.fromEntries(Object.entries(row).map(([k, v]) => [k, k === 't' ? v : (v ?? prev[k])])) : row)
  }
  const limit = Number.isFinite(nowMs) ? nowMs : Date.now()
  const cap = Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : OBS_HISTORY_MAX
  const list = [...byMs].filter(([ms]) => ms <= limit && limit - ms <= maxAgeMs).sort((a, b) => a[0] - b[0]).map(([, r]) => r)
  return cap === 0 ? [] : list.slice(-cap)
}

/** 舊 obs.history + 新的 → 依小時合併（新的覆蓋舊的，新資料缺欄位保留舊值）。舊資料裡的壞列（時間不合法 / 欄位越界）在這裡清掉 */
export function mergeObsHistory(oldHistory, newHistory, opts = {}) {
  const clean = (list) => (Array.isArray(list) ? list : []).map((x) => {
    if (!x || typeof x !== 'object') return null
    const at = obsTimeMs(x.t)
    if (at === null) return null
    const row = { t: toTaipeiIso(hourFloor(at)), pm25: pmValue(x.pm25), pm10: pmValue(x.pm10), aqi: aqiValue(x.aqi), wind: windValue(x.wind) }
    return OBS_FIELDS.every((k) => row[k] === null) ? null : { ms: hourFloor(at), row, at: 0 }
  }).filter(Boolean)
  const older = clean(oldHistory), newer = clean(newHistory).map((x) => ({ ...x, at: 1 }))
  return buildObsHistory([...older, ...newer], opts)
}

// history（已整理過、遞增）裡最新一個有效 PM2.5 的小時（絕對毫秒）；沒有 → null
function newestPmHourMs(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const x = history[i]
    if (x && typeof x.pm25 === 'number') { const ms = obsTimeMs(x.t); if (ms !== null) return ms }
  }
  return null
}

// ---- 舊 obs 的去留 ----
/**
 * 舊 obs 是否還能用：形狀對、fetchedAt 距今 ≤ 48 小時（時鐘稍微超前 5 分鐘內也算），而且「最新的有效 PM2.5 小時」距今也 ≤ 48 小時
 * （fetchedAt 只代表「什麼時候抓的」，不代表資料有多新——測站停測時抓得再勤，資料還是幾天前的）。不能用 → null。回傳的是複本（歷史清掉壞列與未來小時）。
 */
export function retainObs(old, nowMs, maxHours = OBS_STALE_HOURS) {
  if (!old || typeof old !== 'object' || !Array.isArray(old.history) || !old.station || typeof old.station !== 'object') return null
  const at = obsTimeMs(old.fetchedAt)
  if (at === null || !Number.isFinite(nowMs)) return null
  const age = nowMs - at
  if (age > maxHours * HOUR || age < -5 * 60000) return null
  const history = mergeObsHistory(old.history, [], { nowMs })
  if (!history.length) return null
  const newest = newestPmHourMs(history)
  if (newest === null || nowMs - newest > maxHours * HOUR) return null
  return { ...old, history }
}

// ---- 整條管線 ----
/**
 * 抓環境部觀測 → { obs, stats }；任何一步失敗 → 丟錯（訊息不含金鑰）。呼叫端決定要不要保留舊 obs。
 *   opts：{ key, lat, lon（模型格點）, nowMs, old（舊 obs，同一測站時歷史合併）, fetch（可注入，(url, init) => Response）, retryOpts, log }
 *   流程（依序請求，不並行）：目前值資料集 → 選測站 →（歷史資料集分頁 + 客戶端過濾；失敗就退回目前值 1 筆）→ 組成 air.obs。
 */
export async function fetchAirObs(opts = {}) {
  const key = normalizeKey(opts.key)
  if (!key) throw new Error('no MOENV key')
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now()
  const log = typeof opts.log === 'function' ? (m) => opts.log(maskKey(m, key)) : () => {}
  const injected = opts.fetch
  const doFetch = typeof injected === 'function' ? (u, i) => injected(u, i) : (u, i) => fetch(u, i)   // 一律「裸呼叫」（this 為 undefined）：原生 fetch 以物件方法的形式呼叫（opts.fetch(...)）在瀏覽器會 Illegal invocation
  const retryOpts = { attempts: 3, delayMs: 5000, ...(opts.retryOpts || {}) }
  const request = (url, label) => retry(async () => {
    let res
    try { res = await doFetch(url, { signal: AbortSignal.timeout(OBS_TIMEOUT_MS) }) } catch (e) { throw new Error(`MOENV ${label} request failed: ${maskKey(e && e.message, key)}`) }
    const json = await readMoenvResponse(res, url, key)
    const recs = extractRecords(json)
    if (!recs) throw new Error(`MOENV ${label}: unexpected response shape (no records array)`)
    return recs
  }, { ...retryOpts, label: `moenv ${label}`, log: (m) => log(m) })

  // 1) 目前值 → 選測站
  const current = await request(buildMoenvUrl(MOENV_CURRENT_ID, key), 'current')
  const station = pickStation(current, { lat: opts.lat, lon: opts.lon })
  if (!station) throw new Error(`no MOENV station with a status within ${OBS_MAX_KM} km of (${opts.lat}, ${opts.lon}) among ${current.length} records`)
  log(`moenv station: ${station.county}${station.name} id=${station.id} ${station.km} km from the model grid point`)

  // 2) 歷史（分頁 + 客戶端過濾）；失敗（金鑰錯誤除外）→ 只用目前值 1 筆
  let rows = [], pages = 0, usedFallback = false, failedHistory = false
  try {
    let sort = 'datacreationdate desc'
    const cutoff = nowMs - OBS_HISTORY_MAX * HOUR
    for (let page = 0; page < OBS_MAX_PAGES; page++) {
      let recs
      try { recs = await request(buildMoenvUrl(MOENV_HISTORY_ID, key, { limit: OBS_PAGE_LIMIT, offset: page * OBS_PAGE_LIMIT, sort }), `history p${page + 1}`) }
      catch (e) {
        // sort 不是 OpenAPI 列出的參數：第一頁就失敗（4xx / 回應形狀不對 / 一再逾時…）時，先去掉 sort 再試一次；之後的頁不改（換排序會讓 offset 對不上）
        if (e.code === 'KEY' || !sort || page > 0) throw e
        log(`moenv history: 帶 sort 失敗（${maskKey(e.message, key)}），改不帶 sort 重試`); sort = ''; page--; continue
      }
      pages++
      const mine = filterStationRecords(recs, station)
      rows.push(...mine)
      if (recs.length < OBS_PAGE_LIMIT) break
      const times = recs.map((r) => obsTimeMs(first(lower(r), 'datacreationdate'))).filter((x) => x !== null)
      // 提前結束只在「實際看到的順序是新 → 舊」（這一頁第一筆不早於最後一筆；不管 sort 有沒有被 API 採納）時才成立：
      // 已湊滿 120 小時、或這一頁已經翻到 120 小時以前。由舊到新的回傳，最新的資料在最後面，要一路翻到短頁 / 頁數上限。
      const newestFirst = times.length >= 2 && times[0] >= times[times.length - 1]
      if (newestFirst) {
        const hours = new Set(rows.map((r) => { const z = obsTimeMs(first(r, 'datacreationdate')); return z === null ? null : hourFloor(z) }).filter((x) => x !== null))
        if (hours.size >= OBS_HISTORY_MAX || Math.min(...times) < cutoff) break
      }
    }
  } catch (e) {
    if (e.code === 'KEY') throw e
    log(`moenv history 抓取中斷（${maskKey(e.message, key)}）：${rows.length ? `已取得 ${rows.length} 筆，其餘只用目前值` : '改只用目前值 1 筆'}`)
    failedHistory = true
  }
  // 目前值那一筆一律併進來（歷史資料集可能比目前值晚幾個小時更新；同一小時兩邊都有時，較晚的記錄優先）
  if (!rows.length) { usedFallback = true; if (!failedHistory) log('moenv history 中沒有這個測站的有效逐時資料，改只用目前值 1 筆') }
  let history = buildObsHistory([...rows, ...filterStationRecords(current, station)], { nowMs, maxAgeMs: OBS_MAX_AGE_HOURS * HOUR })
  if (!history.length) throw new Error(`no valid MOENV observation rows for ${station.name}`)
  // 新鮮度：最新的「有效 PM2.5」小時要在 OBS_FRESH_HOURS 內。測站停測多日、但狀態欄仍非空（例如「設備維護」）時，歷史資料集裡還留著幾天前的小時，
  // 歷史 / 舊 obs 合併之後看起來像有資料；不擋的話「自動」會拿幾天前的觀測驅動海況、當成現在。丟錯 → refreshAirObs 走「保留舊 obs（≤ 48h）/ 移除」的既有路徑。檢查放在與舊歷史合併之前：舊資料只會更舊，不能讓它「救」過期的新抓結果。
  const newestPm = newestPmHourMs(history)
  if (newestPm === null || nowMs - newestPm > OBS_FRESH_HOURS * HOUR) throw new Error(`MOENV observation for ${station.name} is stale (latest PM2.5 hour ${newestPm === null ? 'none' : toTaipeiIso(newestPm)})`)

  // 3) 同一測站 → 與舊歷史合併（一次抓不滿 120 小時時逐次累積）；換了測站就不併
  const old = opts.old && opts.old.station && (opts.old.station.id != null ? String(opts.old.station.id) === String(station.id) : opts.old.station.name === station.name) ? opts.old : null
  if (old) history = mergeObsHistory(old.history, history, { nowMs })
  const { km, ...st } = station
  return {
    obs: { source: OBS_SOURCE, sourceUrl: OBS_SOURCE_URL, license: OBS_LICENSE, station: { name: st.name, county: st.county, id: st.id, lat: st.lat, lon: st.lon, km }, fetchedAt: toTaipeiIso(nowMs), history },
    stats: { station: station.name, km, pages, rows: rows.length, hours: history.length, usedFallback, last: history[history.length - 1] },
  }
}
