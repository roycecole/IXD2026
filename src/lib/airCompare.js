// 空氣品質：模型（Open-Meteo / CAMS）與環境部測站觀測的並列比較（純函式，Node 可測）。
// 【介面契約——由 src/lib/airCompare 的實作者填入；導覽字幕 / 資料卡 / 遙控頁都依此使用，不要更動名稱與欄位】
//   airCompare(air) → null | {
//     n: 有「模型與觀測都有值」的小時數（PM2.5）,
//     bias: 模型 − 觀測 的平均（μg/m³，正 = 模型高估）, mae: 平均絕對誤差, rmse?: number, corr?: 相關係數（n < 3 → null）,
//     hours: [ISO 小時字串…]（對齊後的時間軸，遞增）, model: [number|null…], obs: [number|null…]（與 hours 等長）,
//     station: { name, county, id?, lat?, lon? }（觀測站）, obsFetchedAt: ISO,
//   }
//   沒有 air / 沒有 air.obs / 對齊後不足 3 個小時 → null（呼叫端就當作「沒有觀測可比」，維持只有模型的呈現）。
// gov.air.obs 的形狀（由 scripts/gov/moenv.mjs 產生）：{ source, sourceUrl, license, station:{name,county,id,lat,lon}, fetchedAt, history:[{ t:'YYYY-MM-DDTHH:00:00+08:00', pm25, pm10, aqi, wind }] }
export function airCompare(air) {
  void air
  return null   // 占位：實作者取代
}
