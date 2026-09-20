// 鳥類調查（水利署 32720）→ 球外鳥群數：依「日曆月份」的鳥種數切分真實季節。
// 資料稀疏且誠實標示：每個流域只有部分月份有調查（每月僅涵蓋 1–3 個年度，近似單一年份快照，非氣候平均），
// 缺月以相鄰有資料月份「環狀線性內插」（12 月與 1 月相連），UI 會標註「內插」。
// monthly：長度 12 的陣列（0=1 月），有效月份為鳥種數、無調查 / 紀錄過少者為 null。

export function birdSeasonal(monthly, month) {
  if (!Array.isArray(monthly) || monthly.length !== 12) return null
  const ok = (i) => typeof monthly[i] === 'number' && monthly[i] > 0
  const valid = []
  for (let i = 0; i < 12; i++) if (ok(i)) valid.push(i)
  if (!valid.length) return null
  const mean = valid.reduce((s, i) => s + monthly[i], 0) / valid.length
  const m = ((month % 12) + 12) % 12
  let value, interpolated = false
  if (ok(m)) value = monthly[m]
  else {
    interpolated = true
    let prev = -1, next = -1, dp = 0, dn = 0
    for (let d = 1; d <= 12 && prev < 0; d++) { const j = (m - d + 12) % 12; if (ok(j)) { prev = j; dp = d } }
    for (let d = 1; d <= 12 && next < 0; d++) { const j = (m + d) % 12; if (ok(j)) { next = j; dn = d } }
    value = prev === next ? monthly[prev] : monthly[prev] + (monthly[next] - monthly[prev]) * (dp / (dp + dn))
  }
  return { value: Math.round(value), mean: Math.round(mean), rel: value / mean, interpolated }
}

// 年度彙總鳥種數 → 基準群數（每 40 種一群，1..5）；季節相對值 rel 每偏離 1 → ±6 群，仍限制 1..5
export function flockCount(species, rel) {
  const base = Math.max(1, Math.min(5, Math.round((species || 80) / 40)))
  return Math.max(1, Math.min(5, Math.round(base + ((rel == null ? 1 : rel) - 1) * 6)))
}
