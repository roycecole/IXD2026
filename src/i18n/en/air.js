// 空氣品質資料集（Open-Meteo Air Quality / CAMS 全球大氣模型）的英文字典。
// 這是「模型資料」，不是政府觀測值：英文一律寫 modeled / model data / not government observations，不要譯成 official / observed。
export default {
  // ---- 名稱（資料層 nameText 查得到：選項名、序列名、地名）----
  '空氣品質 · 雲林': 'Air quality · Yunlin',
  '空氣品質': 'Air quality',
  '模型資料': 'Model data',
  '麥寮': 'Mailiao',

  // ---- series.js：資料播放 HUD ----
  '沙塵 {v} μg/m³': 'Mineral dust {v} μg/m³',

  // ---- describe.js：資料看板 / OUT 日誌 ----
  '來源': 'Source',
  // 分享圖的資料列有字數上限（英文 64 字元，含「Source｜」8 字元）：超過會被硬截斷，「非政府觀測」正是最不能被截掉的那句——所以「不是政府觀測」放最前面，整列 ≤ 63 字元（src/lib/air.test.mjs 釘住）
  'Open-Meteo（CAMS 全球大氣模型）· 模型資料，非政府觀測值': 'Modeled, not government observations · Open-Meteo CAMS',
  'PM2.5 ↑ → 海水清澈 {clarity} · 垃圾 {trash} · 輝光 {glow}': 'PM2.5 ↑ → water clarity {clarity} · trash {trash} · glow {glow}',

  // ---- DataCard ----
  '{name}（PM2.5 {level}，模型）': '{name} (PM2.5 {level}, modeled)',
  '{name}（模型資料 · 尚無數值）': '{name} (model data · no values yet)',
  '空氣品質 · {where}': 'Air quality · {where}',
  '空氣品質 · 尚無資料': 'Air quality · no data yet',
  '若要看有變化的空品資料，請選「{name}」。': 'For air-quality data that actually changes, pick “{name}”.',
  'Open-Meteo Air Quality（CAMS 全球大氣模型）逐時資料：PM2.5 高 → 海水混濁、垃圾多、色相偏黃綠、輝光收斂；風速 → 洋流。US AQI 是美國 EPA 指標，不是環境部 AQI':
    'Hourly data from the Open-Meteo Air Quality API (CAMS global atmospheric model). High PM2.5 makes the sea murky, adds trash, shifts the hue toward yellow-green and dims the glow; wind speed drives the current. US AQI is the US EPA index, not Taiwan’s MOENV AQI.',
  '模型資料（Open-Meteo / CAMS），非政府觀測': 'Model data (Open-Meteo / CAMS), not government observations',
  '約數十公里的粗網格模型估計，可能與地面測站數值不同，請勿當官方空品判讀': 'A model estimate on a coarse grid tens of kilometres wide. It can differ from ground-station readings, so do not treat it as an official air-quality reading.',
  '播放最近的逐時 PM2.5（Open-Meteo / CAMS 模型資料，非政府觀測）：每一步＝一小時；PM2.5 越高，海水越混濁、垃圾越多、色相偏黃綠、輝光收斂':
    'Play the recent hourly PM2.5 (Open-Meteo / CAMS model data, not government observations): each step is one hour. The higher the PM2.5, the murkier the sea, the more trash, the more yellow-green the hue and the dimmer the glow.',
  '播放空氣品質 {n} 小時': ({ n }) => `Play air quality · ${n} hour${n === 1 ? '' : 's'}`,
  '空氣品質資料還不足（需要至少 2 個有效小時的 PM2.5）：排程每 3 小時向 Open-Meteo 抓取，取得後即可播放。':
    'Not enough air-quality data yet (needs PM2.5 for at least 2 valid hours). The scheduled job fetches from Open-Meteo every 3 hours; playback unlocks once data arrives.',
}
