// 水利署河川情勢調查（鳥類 data.gov.tw 32720、魚類 25799）→ 各流域「相異物種數 / 總隻次 / 逐月 / 逐年」。純函式，無 I/O。
// 兩個資料集欄位相同：basinname、date('YYYY/M/D HH:MM')、number(可空)、speciesuniversename、scientificnamecode、speciesscientificname、remarks…
import { round, toNum } from './util.mjs'

export const BIRD_URL = 'https://opendata.wra.gov.tw/api/v2/9d88fe98-92e0-41dd-8a5e-83f6d3f57f35?sort=_importdate%20asc&format=JSON'
export const FISH_URL = 'https://opendata.wra.gov.tw/api/v2/0a79fde0-a69d-4842-b66b-e51f43ce83f0?sort=_importdate%20asc&format=JSON'
export const BIRD_MIN_RECORDS = 90 // 月 / 年的紀錄數門檻（鳥）
export const FISH_MIN_RECORDS = 40 // （魚）

const str = (v) => String(v ?? '').trim()

// ── 物種身分 ──────────────────────────────────────────────────────────────
// speciesuniversename 是「;」分隔的別名清單，資料上有三個雜訊：① 字面字串 "NULL"（缺值）；
// ② 同一物種別名順序不同（"蛇鵰;大冠鷲" / "大冠鷲;蛇鵰"）；③ 同一中文名對應多個物種代碼（代碼改版）。
// 直接數相異字串會把 NULL 當成一個「物種」、並重複計別名變體。做法：
//   別名排序正規化 → 每個 scientificnamecode 取最常見的名稱（NULL 的列以代碼對回本名）→ 同名不同碼併為一種；
//   全無中文名的物種退回學名。
const NULL_TOKEN = /^(null|n\/a|na|nan|none|-+|無)$/i
const canonName = (s) => {
  const parts = str(s).split(/[;；]/).map((x) => x.trim()).filter((x) => x && !NULL_TOKEN.test(x))
  return [...new Set(parts)].sort().join(';')
}

export function buildSpeciesResolver(rows) {
  const tally = new Map() // code → Map(name → 次數)
  for (const r of rows) {
    const code = str(r.scientificnamecode), name = canonName(r.speciesuniversename)
    if (!code || !name) continue
    let m = tally.get(code)
    if (!m) tally.set(code, (m = new Map()))
    m.set(name, (m.get(name) || 0) + 1)
  }
  const nameOfCode = new Map()
  for (const [code, m] of tally) nameOfCode.set(code, [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0])
  return (r) => {
    const code = str(r.scientificnamecode)
    const name = nameOfCode.get(code) || canonName(r.speciesuniversename)
    if (name) return 'n:' + name
    const sci = str(r.speciesscientificname)
    if (sci) return 's:' + sci
    return code ? 'c:' + code : null
  }
}

export function parseSurveyDate(s) {
  const m = /^\s*(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(str(s))
  if (!m) return null
  const y = +m[1], mo = +m[2]
  return y >= 1900 && y <= 2100 && mo >= 1 && mo <= 12 ? { y, m: mo } : null
}

export function groupByBasin(rows) {
  const g = new Map()
  for (const r of rows) {
    const b = str(r.basinname)
    if (!b) continue
    if (!g.has(b)) g.set(b, [])
    g.get(b).push(r)
  }
  return g
}

// 只記季別、日期是佔位值（例如 2005/1/1）的列：月份不可信，不計入逐月（仍計入逐年）
const DATE_UNKNOWN = /[無未]記錄日期|[無未]紀錄日期/

/**
 * 單一流域的列 → { species, count, records, monthly[12], yearly[] }
 *   有效紀錄 = 認得出物種、且 number 不是 0（number=0 為訪談提及／未採獲，不算觀測；number 空白仍算有觀測、隻次不計）
 *   species：全期相異物種數；count：總隻次（空值忽略）；records：有效紀錄數
 *   monthly[i]（i=0 為 1 月）：該日曆月份（跨年度）相異物種數；該月有效紀錄數 < minRecords → null
 *   yearly：[{ y, s 該年相異物種數, n 該年總隻次（全空 → null） }]，依年遞增；該年有效紀錄數 < minRecords 的年度略過
 */
export function summarizeSurvey(rows, keyOf, { minRecords }) {
  const all = new Set()
  let total = 0, records = 0
  const months = Array.from({ length: 12 }, () => ({ n: 0, sp: new Set() }))
  const years = new Map()
  for (const r of rows) {
    const key = keyOf(r)
    if (key === null) continue
    const num = toNum(r.number)
    if (num === 0) continue
    const cnt = num !== null && num > 0 ? num : null
    records++
    all.add(key)
    if (cnt !== null) total += cnt
    const d = parseSurveyDate(r.date)
    if (!d) continue
    let y = years.get(d.y)
    if (!y) years.set(d.y, (y = { n: 0, sp: new Set(), sum: null }))
    y.n++
    y.sp.add(key)
    if (cnt !== null) y.sum = (y.sum ?? 0) + cnt
    if (!DATE_UNKNOWN.test(str(r.remarks))) {
      const m = months[d.m - 1]
      m.n++
      m.sp.add(key)
    }
  }
  return {
    species: all.size,
    count: round(total, 2),
    records,
    monthly: months.map((m) => (m.n >= minRecords ? m.sp.size : null)),
    yearly: [...years]
      .sort((a, b) => a[0] - b[0])
      .filter(([, v]) => v.n >= minRecords)
      .map(([y, v]) => ({ y, s: v.sp.size, n: v.sum === null ? null : round(v.sum, 2) })),
  }
}
