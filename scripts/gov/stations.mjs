// 水利署「河川流量測站站況」（data.gov.tw 22223，站況目錄，無時間序列）→ 島形站點座標。純函式，無 I/O。
//   locationbytwd97_xy = "X Y"（公尺，TWD97 二度分帶、中央經線 121°E）。X 向東、Y 向北皆為正。
import { round, toNum, decodeEntities } from './util.mjs'

export const STATIONS_URL = 'https://opendata.wra.gov.tw/api/v2/9332bd66-0213-4380-a5d5-a43e7be49255?sort=_importdate%20asc&format=JSON'

// 台灣本島 + 離島（澎湖 X≈1e5）在 zone 121 座標下的寬鬆範圍；只用來擋掉明顯錯誤的座標，避免一個離群值拉歪整張圖的縮放
const X_RANGE = [0, 500000]
const Y_RANGE = [2200000, 2900000]

export function parseTwd97(s) {
  const p = String(s ?? '').trim().split(/[\s,]+/).map(Number)
  const [x, y] = p
  const ok = p.length >= 2 && Number.isFinite(x) && Number.isFinite(y) && x > X_RANGE[0] && x < X_RANGE[1] && y > Y_RANGE[0] && y < Y_RANGE[1]
  return ok ? { x, y } : null
}

/**
 * 站況列 → { total, active, skipped, extent, list }
 *   list[]：{ n 站名, r 河川, x, y（-0.5..0.5；以 X、Y 範圍中較大者為縮放基準、置中）, a 集水面積 km²（空值/0 → null）, s 1 現存 | 0 已廢 }
 *   total = list.length（有有效座標者），skipped = 被略過的無效/0 座標站數
 */
export function buildStations(rows) {
  const pts = []
  let skipped = 0
  for (const r of Array.isArray(rows) ? rows : []) {
    const xy = parseTwd97(r?.locationbytwd97_xy)
    if (!xy) { skipped++; continue }
    const a = toNum(r.watershedarea)
    pts.push({
      n: decodeEntities(String(r.observatoryname ?? '').trim()),
      r: decodeEntities(String(r.rivername ?? '').trim()),
      X: xy.x, Y: xy.y,
      a: a !== null && a > 0 ? round(a, 2) : null,
      s: String(r.observationstatus ?? '').trim() === '現存' ? 1 : 0,
    })
  }
  if (!pts.length) return { total: 0, active: 0, skipped, extent: null, list: [] }

  const xs = pts.map((p) => p.X), ys = pts.map((p) => p.Y)
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  const scale = Math.max(maxX - minX, maxY - minY) || 1
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  const list = pts.map((p) => ({ n: p.n, r: p.r, x: round((p.X - cx) / scale, 4), y: round((p.Y - cy) / scale, 4), a: p.a, s: p.s }))
  return {
    total: list.length,
    active: list.filter((p) => p.s === 1).length,
    skipped,
    extent: { minX, maxX, minY, maxY, scale },
    list,
  }
}

export const stationsNote = ({ total, active, skipped }) =>
  `水利署河川流量測站站況（data.gov.tw 22223）：${total} 站，現存 ${active}／已廢 ${total - active}${skipped ? `（另有 ${skipped} 站座標無效已略過）` : ''}；僅為站點目錄，無流量時間序列。` +
  '座標取 TWD97 二度分帶（121°E）X/Y，以全體 X、Y 範圍中較大者為基準置中縮放到約 ±0.5（保持島形長寬比；x 向東、y 向北為正）；a 為集水面積 km²（空值或 0 為 null），s：1 現存、0 已廢。'
