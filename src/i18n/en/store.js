// store 與資料層純函式的文字：OUT / IN 日誌（useStore）、資料看板 / 分享卡資料列 / 日誌資料行（describe）、
// 資料播放 HUD（series formatHud）。資料本身的名稱（水庫 / 流域 / 縣市 / 月相…）在 ./data.js。
// 日誌風格：短句、現在式；資料播放行以 "DATA" / "Data playback" 開頭。
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const plural = (n, one, many) => (n === 1 ? one : many)

export default {
  // ---- useStore：OUT / IN 日誌 ----
  '畫面資訊面板：隱藏': 'Info panels hidden',
  '畫面資訊面板：顯示': 'Info panels shown',
  'CC {cc} ⇄ 綁定 {param}': 'CC {cc} ⇄ bound to {param}',
  'CC {cc} ⇄ {param}（依序完成）': 'CC {cc} ⇄ {param} (mapping complete)',
  'CC {cc} = {v}（未綁定）': 'CC {cc} = {v} (unbound)',
  'CC {cc} 待接管 {param}（soft-takeover）': 'CC {cc} pick up {param} (pickup mode)',
  'Note {note} vel {vel} → 事件': 'Note {note} vel {vel} → event',
  '● 開始錄製': '● Recording',
  '■ 錄製結束（{n} 事件）': ({ n }) => `■ Recording stopped (${n} ${plural(n, 'event', 'events')})`,
  '▶ 播放錄製': '▶ Playing recording',
  '⟲ 已清除錄製': '⟲ Recording cleared',
  '鯨魚出現': 'Whale appears',
  '海豚出現': 'Dolphin appears',
  '海龜出現': 'Turtle appears',
  '清除垃圾 → 淨化波': 'Trash cleared → purify wave',
  '套用海況：{name}': 'Sea applied: {name}',
  '真實資料': 'live data',
  '鳥群': 'Bird flocks',
  '魚群': 'Fish schools',
  '鳥群 · {seg} → 鳥群數量 {val}（{n} 群）': ({ seg, val, n }) => `Bird flocks · ${seg} → ${val} (${n} ${plural(n, 'flock', 'flocks')})`,
  '鳥群 · {seg} → 鳥群數量 {val}': 'Bird flocks · {seg} → {val}',
  '魚群 · {seg} → 魚群數量 {val}': 'Fish schools · {seg} → {val}',
  '▶ 資料播放：{name} {date} {label}（{n} 筆，{unit}）': ({ name, date, label, n, unit }) => `▶ Data playback: ${[name, date, label].filter(Boolean).join(' ')} (${n} ${plural(n, 'record', 'records')}, ${unit})`,
  '▶ 資料播放：{name} {date} {label}（{n} 筆）': ({ name, date, label, n }) => `▶ Data playback: ${[name, date, label].filter(Boolean).join(' ')} (${n} ${plural(n, 'record', 'records')})`,
  '場景 ◀ {label}': 'Scene ◀ {label}',
  '場景 ▶ {label}': 'Scene ▶ {label}',
  'Marker 快照 #{n}（共 {total} 組）': 'Marker snapshot #{n} ({total} total)',
  'Marker ◀ 快照 #{n}': 'Marker ◀ snapshot #{n}',
  'Marker ▶ 快照 #{n}': 'Marker ▶ snapshot #{n}',

  // ---- describe：資料列標籤（資料看板 / 分享卡）----
  '潮汐': 'Tide',
  // 潮位 / 月亮 / 揚塵 這幾個標籤在 ./data.js
  '映射': 'Mapping',
  '位置': 'Position',
  '月相': 'Moon phase',
  '水庫': 'Reservoir',
  '氣象': 'Weather',
  '河川': 'Rivers',
  '測站': 'Stations',
  '尚無資料': 'No data yet',
  '無效': 'invalid',

  // ---- describe：資料列內容 ----
  '{name} {date} · 農曆 {lunar}': '{name} {date} · Lunar {lunar}',
  '{hr}:00 {v}{unit} → 海水高度 {sea}（滿潮溢流）': '{hr}:00 · {v} {unit} → sea level {sea} (high-tide overflow)',
  '{hr}:00 {v}{unit} → 海水高度 {sea}': '{hr}:00 · {v} {unit} → sea level {sea}',
  '{phase} · 月齡 {age} 天': '{phase} · moon age {age} days',
  '{county} {n} 站 · PM10 {pm}': ({ county, n, pm }) => `${county ? county + ' · ' : ''}${n} ${plural(n, 'station', 'stations')} · PM10 ${pm}`,
  '風 {v} m/s': 'wind {v} m/s',
  '濕度 {v}%': 'humidity {v}%',
  '氣溫 {v}°C': 'temp {v}°C',
  'PM10 ↑ → 海水清澈 {clarity} · 垃圾 {trash} · 洋流 {current}': 'PM10 ↑ → water clarity {clarity} · trash {trash} · current {current}',
  'PM10 感測器回報無效值 → 以預設 40 μg/m³ 示意（清澈 {clarity} · 垃圾 {trash}）· 風速 → 洋流 {current}':
    'PM10 sensor reported an invalid value → using a 40 μg/m³ default for illustration (clarity {clarity} · trash {trash}) · wind speed → current {current}',
  '{county} 今日 · 月出 {rise} · 中天 {transit}（仰角 {alt}°{dir}） · 月沒 {set}': '{county} today · moonrise {rise} · transit {transit} (altitude {alt}°{dir}) · moonset {set}',
  '{county} 今日 · 月出 {rise} · 中天 {transit} · 月沒 {set}': '{county} today · moonrise {rise} · transit {transit} · moonset {set}',
  '現在 方位 {az}° · 仰角 {alt}°（依月出 / 中天 / 月沒時刻內插）': 'Now: azimuth {az}° · altitude {alt}° (interpolated from moonrise / transit / moonset times)',
  '現在在地平線下': 'Below the horizon now',
  '{county} 月出月沒表 {from} → {to} 不含今日，改用天文公式': '{county} moonrise & moonset table {from} → {to} does not cover today; using the astronomical formula',
  '{phase} · 月齡 {age} 天 · 資料 {from} → {to}（{n} 天）': ({ phase, age, from, to, n }) => `${phase} · moon age ${age} days · data ${from} → ${to} (${n} ${plural(n, 'day', 'days')})`,
  '{name} 水位 {level}% → 海水高度 {sea}（滿庫溢流）': '{name} water level {level}% → sea level {sea} (full-reservoir overflow)',
  '{name} 水位 {level}% → 海水高度 {sea}': '{name} water level {level}% → sea level {sea}',
  '{weather} · {temp}°C · 濕度 {rh}% · 風 {wind} m/s → 洋流 {current}': '{weather} · {temp}°C · humidity {rh}% · wind {wind} m/s → current {current}',
  '{basin} {m} 月': ({ basin, m }) => `${basin} · ${MON[m - 1] || m}`,
  '{basin} {m} 月 {v} 種': ({ basin, m, v }) => `${basin} · ${MON[m - 1] || m}: ${v} species`,
  '{basin} {m} 月 {v} 種（內插）': ({ basin, m, v }) => `${basin} · ${MON[m - 1] || m}: ${v} species (interpolated)`,
  '調查 {span}': 'survey {span}',
  '{n} 站即時水位': ({ n }) => `${n} live water-level ${plural(n, 'gauge', 'gauges')}`,
  '平均警戒比 {v}': 'avg. alert ratio {v}',
  '銀河濃度': 'Milky Way density',
  '河川流量站 {total} 站（現存 {active}）→ 星座': 'River flow gauging stations: {total} ({active} active) → constellation',
  '資料 {k}｜{v}': 'DATA {k} | {v}',

  // ---- series：資料播放 HUD / 日誌 ----
  '調查年表': 'survey timeline',
  '{name} {date} {time} · {label} {v}{unit}': ({ name, date, time, label, v, unit }) => `${name} ${date} ${time} · ${label} ${v}${unit ? ' ' + unit : ''}`,
  '{name} {time} · {label} {v}{unit}': ({ name, time, label, v, unit }) => `${name} ${time} · ${label} ${v}${unit ? ' ' + unit : ''}`,
  '{name} {year} 年 · {label} {v}': '{name} {year} · {label} {v}',
  '隻次 {n}': 'individuals {n}',
  '{lunar} {range}': '{lunar}, {range}',   // 沒有中文的鍵：中文語系原樣串接（農曆八月初十 小潮）
  '{name} {date} · 月出 {rise} · 中天 {transit}（仰角 {alt}）· 月沒 {set}': '{name} {date} · moonrise {rise} · transit {transit} (altitude {alt}) · moonset {set}',
}
