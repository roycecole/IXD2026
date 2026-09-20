// 資料相關 UI：DataCard（含 SurveyCard 調查卡）、DataBoard、DataHUD、ParamHUD、TakeoverHint、KioskQR。
// 政府資料裡的專有名詞（水庫 / 流域 / 縣市 / 天氣 / 農曆 / 潮差）由資料層字典（data.js）負責。
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export default {
  // ---- DataCard：海況選單 / 套用 ----
  '今日海況': "Today's sea",
  '風 {n} m/s': 'Wind {n} m/s',
  '選擇海況資料': 'Choose sea data',
  '套用此海況': 'Apply this sea',
  '{name}（潮汐）': '{name} (tide)',
  '{name}（PM10 {level}）': '{name} (PM10 {level})',
  '{name}（PM10 無效 · 看風速）': '{name} (PM10 invalid · using wind speed)',
  '{name}（月出月沒）': '{name} (moonrise & moonset)',
  '{name}（水位 {level}%）': '{name} (water level {level}%)',

  // ---- DataCard：揚塵 / 月亮摘要 ----
  '揚塵 · {county} {n} 站 · PM10 {v} μg/m³': ({ county, n, v }) => `Dust · ${county} · ${n} station${n === 1 ? '' : 's'} · PM10 ${v} μg/m³`,
  '揚塵 · {county} {n} 站 · PM10 無效': ({ county, n }) => `Dust · ${county} · ${n} station${n === 1 ? '' : 's'} · PM10 invalid`,
  '濕度 {n}%': 'Humidity {n}%',
  '水資源物聯網（IoW）揚塵感測站最新值：PM10 高 → 海水混濁、垃圾多、色相偏黃綠；風速 → 洋流。PM10 感測器常回傳無效的哨兵值，此時海況以預設 40 μg/m³ 示意、歷史播放改用風速':
    'Latest readings from the Water Resources IoT (IoW) dust sensor stations. High PM10 makes the sea murky, adds trash and shifts the hue toward yellow-green; wind speed drives the current. The PM10 sensor often returns an invalid placeholder value; when that happens the sea falls back to an illustrative default of 40 μg/m³ and history playback switches to wind speed.',
  '{phase} · 月齡 {age} 天': '{phase} · moon age {age} days',
  '月亮 · {v}': 'Moon · {v}',
  '潮汐是月亮的引力：背景月亮的盈虧與位置對應當日月齡與時刻':
    "Tides come from the moon's gravity: the phase and position of the background moon follow today's moon age and time of day.",

  // ---- DataCard：播放按鈕 / 提示 ----
  '把 {name} {date} 的{label}時間序列轉成自動化播放': 'Turn the time series for {name} {date} ({label}) into automated playback',
  '播放 24h {label}資料': 'Play 24h data ({label})',
  '播放 CI 累積的揚塵歷史（{label}）：每一步＝一次 3 小時取樣': 'Play the dust history collected by the scheduled job ({label}): each step is one 3-hour sample.',
  '播放 CI 累積的揚塵歷史（{label}）：每一步＝一次 3 小時取樣；PM10 感測器目前無效，改以風速驅動洋流與海水混濁':
    'Play the dust history collected by the scheduled job ({label}): each step is one 3-hour sample. The PM10 sensor is currently invalid, so wind speed drives the current and water turbidity instead.',
  '播放揚塵歷史（{label}）{n} 筆': ({ label, n }) => `Play dust history (${label}) · ${n} reading${n === 1 ? '' : 's'}`,
  '揚塵歷史累積中（{n} 筆有效）：資料來源只提供「最新值」，排程每 3 小時累積一筆，累積 2 筆有效資料後即可播放（PM10 無效時改用風速）。':
    'Dust history is still collecting ({n} valid so far). The source only provides the latest value, so a scheduled job adds one reading every 3 hours. Playback unlocks after 2 valid readings (wind speed is used when PM10 is invalid).',
  '目前累積的 {n} 筆{label}數值完全相同（來源疑似凍結：時戳前進、數值不變），播放看不到變化，等來源更新後才會動。':
    'The {n} readings collected so far ({label}) are all identical (the source may be frozen: timestamps advance but values do not change), so playback shows no change until the source updates.',
  'CWA 月出月沒表：每一步＝一天；月亮依真實月出 / 中天 / 月沒時刻與方位在天空移動，中天越高海水越高（示意）':
    'CWA moonrise & moonset table: each step is one day. The moon crosses the sky at its real rise, transit and set times and bearings, and the higher it climbs at transit, the higher the sea (illustrative).',
  '播放月出月沒 {n} 天': ({ n }) => `Play moonrise & moonset · ${n} day${n === 1 ? '' : 's'}`,
  '資料播放設定': 'Data playback settings',
  '播放倍速 ×{v}': 'Playback speed ×{v}',
  '播完自動從頭循環': 'Loop back to the start when playback ends',
  '循環': 'Loop',

  // ---- DataCard：畫面顯示 ----
  '畫面顯示': 'Overlays',
  '畫面顯示（快速鍵 I：全部隱藏 / 顯示）': 'Overlays (shortcut I: hide / show all)',
  '畫布左上角：目前海況背後的真實資料與映射（展場很好用）': 'Top left of the canvas: the real data behind the current sea and how it maps to the visuals (handy at exhibitions)',
  '資料看板': 'Data board',
  '畫布上緣 / 下緣：資料播放進度、參數數值、待接管旋鈕提示、AR 調整鈕、聲音提示':
    'Top and bottom of the canvas: playback progress, parameter values, knob pickup hints, AR controls and sound hints',
  '播放與參數提示': 'Playback & parameter hints',
  '演出模式（H / 雙擊）：角落的掃碼 QR 與合奏統計；關閉後不會自動啟動多人主機':
    'Stage mode (H / double-click): the corner QR code and jam stats. When this is off, the multiplayer host does not start automatically.',
  '掃碼 QR（演出模式）': 'QR code (stage mode)',

  // ---- SurveyCard：鳥 / 魚調查卡 ----
  '鳥群': 'Bird flocks',
  '魚群': 'Fish schools',
  '鳥群數量': 'Bird flocks',
  '魚群數量': 'Fish schools',
  '鳥群資料：{basin}': 'Bird survey data: {basin}',
  '魚群資料：{basin}': 'Fish survey data: {basin}',
  '鳥群逐月物種數，點擊預覽該月': 'Bird species per month; select a bar to preview that month',
  '魚群逐月物種數，點擊預覽該月': 'Fish species per month; select a bar to preview that month',
  '該流域鳥類調查的物種數越多，球外的鳥群越多。點長條預覽各月份（斜線＝內插）。':
    "The more bird species this basin's surveys record, the more flocks appear outside the sphere. Select a bar to preview each month (hatched = interpolated).",
  '該流域魚類調查的物種數越多，海裡的魚群越多。點長條預覽各月份（斜線＝內插）。':
    "The more fish species this basin's surveys record, the more schools swim in the sea. Select a bar to preview each month (hatched = interpolated).",
  '鳥群數量（獨立控制）': 'Bird flocks (independent control)',
  '魚群數量（獨立控制）': 'Fish schools (independent control)',
  '依年度播放 {basin} 的鳥群調查：每一步＝一個調查年度，鳥群數量隨當年物種數變化':
    "Play the {basin} bird survey year by year: each step is one survey year, and the flock count follows that year's species count.",
  '依年度播放 {basin} 的魚群調查：每一步＝一個調查年度，魚群數量隨當年物種數變化':
    "Play the {basin} fish survey year by year: each step is one survey year, and the school count follows that year's species count.",
  '連動資料': 'Linked to data',
  '獨立控制': 'Independent',
  '{m} 月': ({ m }) => MON[m - 1] || String(m),
  '{m} 月：{v}': ({ m, v }) => `${MON[m - 1] || m}: ${v}`,
  '{m} 月：無資料': ({ m }) => `${MON[m - 1] || m}: no data`,
  '{m} 月 {v}': ({ m, v }) => `${MON[m - 1] || m}: ${v}`,
  '{v}（現在）': '{v} (now)',
  '{n} 種': '{n} species',
  '{n} 種（內插）': '{n} species (interpolated)',
  '年均 {n}': 'yearly avg. {n}',
  '建議 {v}': 'suggested {v}',
  '{n} 群': ({ n }) => `${n} flock${n === 1 ? '' : 's'}`,
  '把資料建議值寫入「{p}」，並開啟連動': 'Write the suggested value into "{p}" and turn on linking',
  '套用資料': 'Apply data',
  '連動：換海況 / 換月份時自動更新；手動拖曳滑桿會自動脫鉤（獨立控制）':
    'Link: updates automatically when you change the sea or the month. Dragging the slider unlinks it (independent control).',
  '連動中': 'Linked',
  '連動': 'Link',
  '回到現在': 'Back to now',
  '播放調查年表 {a}–{b}': 'Play survey timeline {a}–{b}',

  // ---- DataBoard ----
  '資料 · {name}': 'Data · {name}',
  '隱藏資料看板': 'Hide data board',
  '隱藏資料看板（快速鍵 I 全部隱藏 / 顯示；面板「畫面顯示」可單獨開關）':
    'Hide the data board (shortcut I hides / shows all overlays; the "Overlays" option in the panel toggles it on its own)',

  // ---- TakeoverHint ----
  '待接管　{list}': 'Pick up: {list}',

  // ---- KioskQR ----
  '離線': 'Offline',
  '掃碼加入合奏': 'Scan to join the jam',
  '掃碼一起演奏': 'Scan to play along',
  '離線中 · 重試中…': 'Offline · retrying…',
  '{n} 人合奏中': ({ n }) => `${n} ${n === 1 ? 'person' : 'people'} jamming`,
  '用手機演奏這片海': 'Play this sea with your phone',
}
