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

  // ---- 環境部測站觀測（air.obs，政府觀測資料）與「模型 vs 觀測」並列 ----
  // 誠實：模型 = model / modeled / not government observations；環境部測站的數值才叫 observations（MOENV = Taiwan Ministry of Environment）。
  // 「環境部{station}站」與導覽字幕（tourplan.js）同一個 key、同一個英文——兩邊必須一致。
  '環境部{station}站': 'MOENV’s {station} station',
  '環境部空品測站': 'a MOENV air-quality station',
  '環境部觀測': 'MOENV observation',
  '政府資料開放授權條款－第1版': 'Taiwan Open Government Data License v1',
  '模型資料，非政府觀測': 'Model data, not government observations',
  '風速（模型）': 'Wind speed (model)',
  // 資料看板的列名（英文欄寬有限，越短越好）
  '觀測': 'Observed',
  '落差': 'Gap',
  '驅動': 'Driven by',
  '環境部觀測 · 政府資料開放授權條款－第1版': 'MOENV observations · Taiwan Open Government Data License v1',
  // 一句話結論（airCompareText）：高估 / 低估 / 大致吻合（|平均差| < 1 μg/m³ 且逐時誤差不大）/ 平均差小但逐時落差明顯
  '與{where}觀測相比，模型平均高估 {bias} μg/m³（平均絕對誤差 {mae}，共 {n} 小時）':
    ({ where, bias, mae, n }) => `Against observations at ${where}, the model overestimates PM2.5 by ${bias} μg/m³ on average (mean absolute error ${mae}, ${n} hour${n === 1 ? '' : 's'})`,
  '與{where}觀測相比，模型平均低估 {bias} μg/m³（平均絕對誤差 {mae}，共 {n} 小時）':
    ({ where, bias, mae, n }) => `Against observations at ${where}, the model underestimates PM2.5 by ${bias} μg/m³ on average (mean absolute error ${mae}, ${n} hour${n === 1 ? '' : 's'})`,
  '與{where}觀測相比，模型與觀測大致吻合（平均差 {bias} μg/m³，平均絕對誤差 {mae}，共 {n} 小時）':
    ({ where, bias, mae, n }) => `Against observations at ${where}, the model and the observations broadly agree (mean difference ${bias} μg/m³, mean absolute error ${mae}, ${n} hour${n === 1 ? '' : 's'})`,
  '與{where}觀測相比，模型平均差僅 {bias} μg/m³，但逐小時落差明顯（平均絕對誤差 {mae}，共 {n} 小時）':
    ({ where, bias, mae, n }) => `Against observations at ${where}, the mean difference is only ${bias} μg/m³, but the hour-by-hour gaps are large (mean absolute error ${mae}, ${n} hour${n === 1 ? '' : 's'})`,
  '模型平均高估 {bias} μg/m³（平均絕對誤差 {mae}，共 {n} 小時）':
    ({ bias, mae, n }) => `Model overestimates by ${bias} μg/m³ on average (mean absolute error ${mae}, ${n} hour${n === 1 ? '' : 's'})`,
  '模型平均低估 {bias} μg/m³（平均絕對誤差 {mae}，共 {n} 小時）':
    ({ bias, mae, n }) => `Model underestimates by ${bias} μg/m³ on average (mean absolute error ${mae}, ${n} hour${n === 1 ? '' : 's'})`,
  '模型與觀測大致吻合（平均差 {bias} μg/m³，平均絕對誤差 {mae}，共 {n} 小時）':
    ({ bias, mae, n }) => `Model and observations broadly agree (mean difference ${bias} μg/m³, mean absolute error ${mae}, ${n} hour${n === 1 ? '' : 's'})`,
  '模型平均差僅 {bias} μg/m³，但逐小時落差明顯（平均絕對誤差 {mae}，共 {n} 小時）':
    ({ bias, mae, n }) => `Mean difference is only ${bias} μg/m³, but hour-by-hour gaps are large (mean absolute error ${mae}, ${n} hour${n === 1 ? '' : 's'})`,

  // ---- 揚塵：水利署風速凍結 / 無效 → 改用逐時模型風速（Open-Meteo 預報 API，模型資料）----
  '風速為模型資料（Open-Meteo），水利署感測器凍結 · 最新 {v} m/s（{at}）': 'Wind speed is model data (Open-Meteo); the WRA sensor is frozen · latest {v} m/s ({at})',
  '風速為模型資料（Open-Meteo），水利署感測器無有效風速 · 最新 {v} m/s（{at}）': 'Wind speed is model data (Open-Meteo); the WRA sensor has no valid wind reading · latest {v} m/s ({at})',
  '風速為模型資料（Open-Meteo），水利署感測器凍結：歷史播放改用逐時模型風速。': 'Wind speed is model data (Open-Meteo); the WRA sensor is frozen, so the history playback uses hourly modeled wind speed.',
  '風速為模型資料（Open-Meteo），水利署感測器沒有可用的風速：歷史播放改用逐時模型風速。': 'Wind speed is model data (Open-Meteo); the WRA sensor has no usable wind reading, so the history playback uses hourly modeled wind speed.',
  '播放最近的逐時模型風速（Open-Meteo，模型資料）：每一步＝一小時；水利署風速感測器凍結，改以模型風速驅動洋流與海水混濁':
    'Play the recent hourly modeled wind speed (Open-Meteo, model data): each step is one hour. The WRA wind sensor is frozen, so modeled wind drives the current and the murkiness.',

  // ---- DataCard：選項標籤 / 折線 / 小卡 / 切換 ----
  '{name}（PM2.5 {level}，環境部觀測）': '{name} (PM2.5 {level}, MOENV observed)',
  '空氣品質：改用「{src}」驅動海況': 'Air quality: sea now driven by “{src}”',
  '環境部空氣品質監測網的測站觀測：離模型格點最近的測站，最新一小時的逐時值':
    'Station readings from the Taiwan MOENV air-quality monitoring network: the station nearest the model grid point, latest hourly value',
  '模型 vs 觀測': 'Model vs observations',
  '近 {n} 小時 PM2.5（μg/m³）': ({ n }) => `PM2.5 over the last ${n} hour${n === 1 ? '' : 's'} (μg/m³)`,
  '近 {n} 小時 PM2.5（模型）': ({ n }) => `PM2.5 over the last ${n} hour${n === 1 ? '' : 's'} (model)`,
  '模型（非政府觀測）': 'Model (not government observations)',
  '{where}觀測': 'Observations at {where}',
  '模型：Open-Meteo / CAMS（非政府觀測）；觀測：{where}（{license}）': 'Model: Open-Meteo / CAMS (not government observations). Observations: {where} ({license})',
  '環境部資料開放平台': 'MOENV open data platform',
  '測站離模型格點約 {km} 公里；模型是數十公里的粗網格，落差不全是模型的誤差。': 'The station is about {km} km from the model grid point, and the model grid is tens of kilometres wide, so the gap is not all model error.',
  '模型（Open-Meteo / CAMS，非政府觀測）與{where}觀測的 PM2.5 折線圖：近 {n} 小時；模型 {mlo}–{mhi}、觀測 {olo}–{ohi} μg/m³':
    'PM2.5 line chart of the model (Open-Meteo / CAMS, not government observations) and observations at {where}: last {n} hours; model {mlo}–{mhi}, observed {olo}–{ohi} μg/m³',
  '近 {n} 小時的模型 PM2.5 折線圖（Open-Meteo / CAMS，非政府觀測）：{lo}–{hi} μg/m³':
    'Line chart of modeled PM2.5 (Open-Meteo / CAMS, not government observations) over the last {n} hours: {lo}–{hi} μg/m³',
  '驅動海況的資料': 'Data driving the sea',
  '用環境部測站觀測的逐時 PM2.5 驅動海況（政府資料開放授權條款－第1版）': 'Drive the sea with hourly PM2.5 observed at the MOENV station (Taiwan Open Government Data License v1)',
  '用 Open-Meteo / CAMS 模型的逐時 PM2.5 驅動海況（模型資料，非政府觀測）': 'Drive the sea with hourly PM2.5 from the Open-Meteo / CAMS model (model data, not government observations)',
  '播放最近的逐時 PM2.5（環境部測站觀測，政府資料開放授權條款－第1版）：每一步＝一小時；PM2.5 越高，海水越混濁、垃圾越多、色相偏黃綠、輝光收斂':
    'Play the recent hourly PM2.5 observed at the MOENV station (Taiwan Open Government Data License v1): each step is one hour. The higher the PM2.5, the murkier the sea, the more trash, the more yellow-green the hue and the dimmer the glow.',
  '播放空氣品質 {n} 小時（環境部觀測）': ({ n }) => `Play air quality · ${n} hour${n === 1 ? '' : 's'} (MOENV observed)`,
  '播放空氣品質 {n} 小時（模型）': ({ n }) => `Play air quality · ${n} hour${n === 1 ? '' : 's'} (model)`,
}
