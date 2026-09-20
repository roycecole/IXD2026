// 「點物件看資料出處」卡片（lib/inspect.js 的 describeInspect、ui/InspectCard.jsx）。
// 測站名 / 河川名是政府資料的專有名詞，維持原文（不進字典）；流域 / 縣市 / 潮差等名稱由資料層字典（data.js）處理。
// 已在其他字典檔有英文的 key 直接沿用（月亮 / 月相 / 鳥群 / 鳥種數 / 潮汐 / {n} 群 / 關閉 …），這裡只放新句子。
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const mon = (m) => MON[(((m - 1) % 12) + 12) % 12]

export default {
  // ---- 測站星座 ----
  '河川流量測站': 'River gauging station',
  '所屬河川': 'River',
  '集水面積': 'Catchment area',
  '狀態': 'Status',
  '現存': 'Active',
  '已廢': 'Discontinued',
  '星星亮度依集水面積（取對數）：現存較亮，已廢較暗': 'Star brightness follows catchment area (log scale): active stations are brighter, discontinued ones dimmer.',
  '資料來源：水利署 河川流量測站站況（data.gov.tw 22223）': 'Source: Water Resources Agency, river gauging station list (data.gov.tw 22223)',

  // ---- 月亮 ----
  '月出月沒 · {county} {date}': 'Moonrise & moonset · {county} {date}',
  '潮汐與月亮': 'Tide & moon',
  '月出': 'Moonrise',
  '中天': 'Transit',
  '月沒': 'Moonset',
  '現在': 'Now',
  '當晚 21:00': 'At 21:00',
  '在地平線下': 'Below the horizon',
  '{time} · 方位 {az}°': '{time} · bearing {az}°',
  '{time} · 仰角 {alt}°': '{time} · altitude {alt}°',
  '{time} · 仰角 {alt}°（北方）': '{time} · altitude {alt}° (north)',
  '{time} · 仰角 {alt}°（南方）': '{time} · altitude {alt}° (south)',
  '方位 {az}° · 仰角 {alt}°': 'Bearing {az}° · altitude {alt}°',
  '潮差': 'Tidal range',
  '資料來源：氣象署 月出月沒時刻（A-B0063-001）': 'Source: CWA moonrise & moonset table (A-B0063-001)',
  '資料來源：氣象署 潮汐預報（F-A0021-001）；月齡由農曆日期推算': 'Source: CWA tide forecast (F-A0021-001); moon age is derived from the lunar date',
  '月相以天文公式估算（誤差約 ±0.5 天）': 'Moon phase is estimated from an astronomical formula (about ±0.5 day).',
  '月出月沒表 {from} → {to} 不含今日，月相改用天文公式估算': 'The moonrise & moonset table ({from} → {to}) does not include today, so the phase is estimated from an astronomical formula.',

  // ---- 鳥群 ----
  '鳥類調查': 'Bird survey',
  '流域': 'Basin',
  '調查年': 'Survey years',
  '推算群數': 'Derived flocks',
  '{m} 月 · {v} 種': ({ m, v }) => `${mon(m)} · ${v} species`,
  '{m} 月 · {v} 種（內插）': ({ m, v }) => `${mon(m)} · ${v} species (interpolated)`,
  '{from}–{to}（{n} 個年度）': ({ from, to, n }) => `${from}–${to} (${n} survey year${n === 1 ? '' : 's'})`,
  '此海況沒有對應的鳥類調查資料': 'This sea has no matching bird survey data.',
  '每個月份只涵蓋 1–3 個調查年度，近似單一年份快照；缺月以相鄰月份內插': 'Each month covers only 1–3 survey years (close to a single-year snapshot); missing months are interpolated from neighbouring months.',
  '資料來源：水利署 河川鳥類調查（data.gov.tw 32720）': 'Source: Water Resources Agency, river bird survey (data.gov.tw 32720)',
}
