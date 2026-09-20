// 資料導覽（Data Tour）：面板卡片、畫面下方字幕、OUT 日誌。
// 字幕文字（captionText）由 src/lib/tour.js 依資料組出，資料名稱（水庫 / 流域 / 縣市 / 月相 / 潮差 / 農曆）走資料層字典（./data.js）。
// 用語依 GLOSSARY.md：sphere、sea level（海水高度）、reservoir、gauging station、no survey / interpolated（調查空窗）。
export default {
  // ---- 面板卡片（TourControls）----
  '資料導覽': 'Data tour',
  '共 {n} 站 · 約 {s} 秒': ({ n, s }) => `${n} ${n === 1 ? 'stop' : 'stops'} · about ${s} s`,
  '依序巡演真實資料：水庫、潮汐、月亮、揚塵、鳥、魚、河川測站；畫面下方的字幕說明現在看的是什麼、球為什麼長這樣。':
    'A guided tour through the real data: reservoir, tide, moon, dust, birds, fish and river stations. Captions below the sphere explain what you are looking at and why the sphere looks that way.',
  '▶ 開始導覽': '▶ Start tour',
  '■ 停止導覽': '■ Stop tour',
  '開始 / 停止資料導覽（快速鍵 T）': 'Start / stop the data tour (shortcut T)',
  '導覽需要海況資料，載入完成後才能使用': 'The tour needs the sea data and will be available once it has loaded',
  '等錄製 / 播放結束後才能導覽': 'Available once recording / playback has finished',
  '第 {n} / {total} 站': 'Stop {n} / {total}',
  '導覽中：任何操作都會停止並還原': 'Touring: any input stops it and restores your sea',
  '閒置 {s} 秒自動導覽': 'Auto tour after {s} s idle',
  '沒有動作 {s} 秒就自動開始，碰任何東西立即停止並還原；展場模式（?kiosk=1）預設開啟':
    'Starts after {s} seconds without input, and stops (restoring your sea) as soon as you touch anything. On by default in kiosk mode (?kiosk=1).',

  // ---- 畫面下方字幕（TourCaption）----
  '資料導覽字幕': 'Data tour caption',

  // ---- OUT 日誌 ----
  '▶ 資料導覽開始（{n} 站）': ({ n }) => `▶ Data tour started (${n} ${n === 1 ? 'stop' : 'stops'})`,
  '導覽 {i}/{n}｜{title}': 'Tour {i}/{n} | {title}',
  '■ 資料導覽結束，已還原原本的海': '■ Data tour finished; your sea is restored',
  '■ 資料導覽中止，已還原原本的海': '■ Data tour interrupted; your sea is restored',
  '■ 資料導覽中止（改由你接手）': '■ Data tour stopped (you took over)',

  // ---- 字幕：① 今日水庫 ----
  '今日水庫 · {name}': "Today's reservoir · {name}",
  '水位 {level}% → 海水高度 {sea}：水庫越滿，球裡的海越高': 'Water level {level}% → sea level {sea}: the fuller the reservoir, the higher the sea',
  '水位 {level}% → 海水高度 {sea}（滿庫溢流）：水庫越滿，球裡的海越高': 'Water level {level}% → sea level {sea} (overflowing): the fuller the reservoir, the higher the sea',

  // ---- ② 潮汐 ----
  '潮汐 · {name}': 'Tide · {name}',
  '今天是{range}（{bits}）：潮位 {lo}–{hi} {unit} 一日起落，帶動海水高度': 'A {range} today ({bits}): the tide swings {lo}–{hi} {unit} a day, moving the sea level',
  '潮位 {lo}–{hi} {unit} 一日起落，帶動海水高度（{bits}）': 'The tide swings {lo}–{hi} {unit} a day, moving the sea level ({bits})',

  // ---- ③ 月亮 ----
  '{phase} · 今日月出 {rise}、月沒 {set}：月亮中天越高，海水越高（示意）': "{phase} · today's moonrise {rise}, moonset {set}: the higher the moon, the higher the sea (illustrative)",
  '{phase} · 月出月沒表 {n} 天：每一步一天，月亮中天越高，海水越高（示意）': '{phase} · {n}-day moonrise & moonset table: the higher the moon, the higher the sea (illustrative)',

  // ---- ④ 揚塵 ----
  'PM10 {lo}–{hi} μg/m³：越高，海水越混濁、垃圾越多': 'PM10 {lo}–{hi} μg/m³: the higher it is, the murkier the sea and the more trash',
  'PM10 {v} μg/m³；來源疑似凍結，數值沒有變化': 'PM10 {v} μg/m³; the source may be frozen (value unchanged)',
  'PM10 感測器回報無效，改看風速 {lo}–{hi} m/s：風越大，洋流越急': 'PM10 sensor invalid, so wind speed {lo}–{hi} m/s is used: stronger wind, faster current',
  'PM10 感測器回報無效，改看風速 {v} m/s；來源疑似凍結，數值沒有變化': 'PM10 sensor invalid, so wind speed {v} m/s is used; the source may be frozen (value unchanged)',
  'PM10 {pm} μg/m³：越高，海水越混濁；歷史還在累積（{n} 筆有效）': 'PM10 {pm} μg/m³: the higher, the murkier the sea; history collecting ({n} valid)',
  'PM10 感測器回報無效，改看風速 {wind} m/s 推動洋流；歷史還在累積（{n} 筆有效）': 'PM10 sensor invalid; wind speed {wind} m/s drives the current. History collecting ({n} valid)',
  '這幾座感測站目前沒有有效讀數；歷史還在累積': 'These stations have no valid readings right now; history collecting',

  // ---- ⑤⑥ 鳥群 / 魚群調查年表 ----
  '鳥群調查 · {basin}': 'Bird survey · {basin}',
  '魚群調查 · {basin}': 'Fish survey · {basin}',
  '{a}–{b} 年 {k} 次調查，每年 {lo}–{hi} 種：種數越多，鳥群越多': '{k} surveys {a}–{b}, {lo}–{hi} species each: more species, more flocks',
  '{a}–{b} 年 {k} 次調查，每年 {lo}–{hi} 種：種數越多，魚群越多': '{k} surveys {a}–{b}, {lo}–{hi} species each: more species, more fish schools',
  '；{gaps} 無調查（內插）': '; no survey {gaps} (interpolated)',

  // ---- ⑦ 河川測站星座 ----
  '河川測站星座': 'River station constellation',
  '水利署 {total} 座河川流量測站依真實座標排成台灣島形：亮星現存（{active}）、暗星已廢': '{total} river gauging stations at real coordinates trace Taiwan; bright stars are active ({active})',
}
