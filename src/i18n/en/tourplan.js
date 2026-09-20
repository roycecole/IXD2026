// 資料導覽 · 導覽腳本（TourPlanEditor / 目前腳本 / 備註）＋ 導覽字幕接上的新資料：模型風速（水利署風速凍結時）、模型 vs 環境部測站觀測。
// 用語依 GLOSSARY.md：stop（導覽的「站」）、caption（字幕）、sphere；腳本 = plan。
// 資料誠實：模型資料（Open-Meteo / CAMS）一律寫 model / modeled / not government observations；環境部測站的數值才叫 observations，且寫明是 MOENV 的測站。
// 備註（caption.p.note）是導覽員輸入的原文，不在字典裡、不翻譯。
export default {
  // ---- 站名（編輯器每一列；「潮汐」「月亮」「揚塵」「河川測站星座」沿用資料層 / 導覽字幕既有的譯文）----
  '水庫（今日水位）': 'Reservoir (today’s level)',
  '空氣品質（模型資料）': 'Air quality (model data)',
  '鳥群調查': 'Bird survey',
  '魚群調查': 'Fish survey',

  // ---- 卡片（TourControls）----
  '目前腳本：{name}（{n} 站）': ({ name, n }) => `Current plan: ${name} (${n} ${n === 1 ? 'stop' : 'stops'})`,
  '{m} 站目前沒有資料，會略過': ({ m }) => `${m} ${m === 1 ? 'stop has' : 'stops have'} no data right now and will be skipped`,
  '腳本內的站目前都沒有資料，導覽無法開始；請改選其他站或還原預設': 'None of the stops in this plan has data right now, so the tour cannot start. Pick other stops or restore the default.',
  '網址腳本': 'URL plan',
  '未命名腳本': 'Untitled plan',
  '自訂腳本': 'Custom plan',

  // ---- 編輯器（TourPlanEditor）----
  '導覽腳本': 'Tour plan',
  '導覽腳本：自訂要講哪幾站、順序與每站的備註': 'Tour plan: choose which stops to cover, their order and a note for each',
  '使用中': 'In use',
  '自訂要講哪幾站、順序與每站的備註（例如只講空氣品質與魚）。備註會顯示在字幕上並被旁白念出；它是你輸入的原文，不會翻譯。':
    'Choose which stops to cover, their order and a note for each (for example, only air quality and fish). Notes appear on the caption and are read aloud; they are your own text and are not translated.',
  '導覽進行中，腳本暫時唯讀。先結束導覽（按 T 或「停止導覽」）再修改。': 'A tour is running, so the plan is read-only for now. Stop the tour (press T or “Stop tour”) to edit it.',
  '導覽腳本編輯': 'Tour plan editor',
  '已存腳本': 'Saved plans',
  '切換啟用的腳本：不同觀眾用不同版本': 'Switch the active plan: a different version for each audience',
  '預設完整導覽（{n} 站）': ({ n }) => `Default full tour (${n} stops)`,
  '{name}（{n} 站）': ({ name, n }) => `${name} (${n} ${n === 1 ? 'stop' : 'stops'})`,
  '目前：網址腳本（未儲存）': 'Current: plan from the URL (not saved)',
  '目前：自訂腳本（未儲存）': 'Current: custom plan (not saved)',
  '腳本名稱': 'Plan name',
  '例如：空氣與魚': 'e.g. Air and fish',
  '導覽站序': 'Tour stop order',
  '納入「{name}」': 'Include “{name}”',
  '目前無資料': 'No data now',
  '上移「{name}」': 'Move “{name}” up',
  '下移「{name}」': 'Move “{name}” down',
  '上移一格': 'Move up one place',
  '下移一格': 'Move down one place',
  '備註（選填）': 'Note (optional)',
  '「{name}」的備註（選填）': 'Note for “{name}” (optional)',
  '已納入 {on} / {n} 站': 'Included {on} of {n} stops',
  '腳本操作': 'Plan actions',
  '套用': 'Apply',
  '套用：之後的導覽都用這份腳本（目前選的是已存腳本時，會一併更新它）': 'Apply: later tours use this plan (if a saved plan is selected, it is updated too)',
  '另存新腳本': 'Save as new plan',
  '已存滿 {max} 份，先刪除一份': 'Already {max} saved: delete one first',
  '另存新腳本：存成新的一份並啟用（最多 {max} 份）': 'Save as new plan: keeps it as a new plan and activates it (up to {max})',
  '刪除': 'Delete',
  '確定刪除？': 'Delete it?',
  '刪除目前選的已存腳本': 'Delete the selected saved plan',
  '先在「已存腳本」選一份要刪除的腳本': 'Pick a saved plan in “Saved plans” first',
  '還原預設': 'Restore default',
  '還原預設：不用腳本，導覽全部 {n} 站（已存的腳本不會被刪掉）': 'Restore default: no plan, the tour covers all {n} stops (saved plans are kept)',
  '複製腳本連結': 'Copy plan link',
  '複製腳本連結：貼給別人，開啟後就是這份站序與備註': 'Copy plan link: share it and it opens with this order and these notes',
  '腳本連結（點一下全選，再自行複製）': 'Plan link (tap to select all, then copy it yourself)',
  '腳本 {n}': 'Plan {n}',

  // ---- 操作結果（狀態列與 OUT 日誌）----
  '已套用腳本（{n} 站），只在這次有效；要保留請按「另存新腳本」': ({ n }) => `Plan applied (${n} ${n === 1 ? 'stop' : 'stops'}) for this session only. To keep it, press “Save as new plan”.`,
  '已套用，並更新「{name}」（{n} 站）': ({ name, n }) => `Applied, and updated “${name}” (${n} ${n === 1 ? 'stop' : 'stops'})`,
  '已套用預設完整導覽': 'Applied the default full tour',
  '已另存為「{name}」（{n} 站）並啟用': ({ name, n }) => `Saved as “${name}” (${n} ${n === 1 ? 'stop' : 'stops'}) and activated`,
  '最多只能存 {max} 份腳本，請先刪除一份': 'You can save up to {max} plans; delete one first',
  '已刪除「{name}」': 'Deleted “{name}”',
  '再按一次「刪除」確認刪除「{name}」': 'Press “Delete” again to delete “{name}”',
  '已還原預設：使用完整導覽（已存的腳本都還在）': 'Restored the default: the full tour (your saved plans are still there)',
  '至少要納入一站': 'Include at least one stop',
  '導覽進行中，先結束導覽再修改腳本': 'A tour is running: stop it before editing plans',
  '這個瀏覽器無法儲存（可能是隱私模式）：腳本只在這次有效': 'This browser cannot save data (private mode?): the plan only lasts for this session',
  '已複製腳本連結': 'Plan link copied',
  '已複製腳本連結，但備註太長放不進網址，連結沒有帶備註': 'Plan link copied, but the notes were too long for a URL, so the link has no notes',
  '複製失敗：請手動選取下方的連結來複製': 'Copy failed: select the link below and copy it yourself',
  '無法產生連結': 'Could not build a link',
  '已複製第 {n} 站連結（備註太長，連結沒有帶備註）': ({ n }) => `Copied the link to stop ${n} (the notes were too long, so the link has none)`,

  // ---- 字幕：揚塵站改用模型風速（水利署感測器風速凍結時；Open-Meteo 逐時模型資料，非政府觀測）----
  '水利署感測器回報凍結，改看 Open-Meteo 模型風速 {lo}–{hi} m/s：風越大，洋流越急（模型資料，非政府觀測）':
    'The WRA sensor reports frozen readings, so Open-Meteo modeled wind speed {lo}–{hi} m/s is used: stronger wind, faster current (model data, not government observations)',
  '水利署感測器回報凍結，改看 Open-Meteo 模型風速約 {v} m/s：這段時間變化很小（模型資料，非政府觀測）':
    'The WRA sensor reports frozen readings, so Open-Meteo modeled wind speed of about {v} m/s is used: little change over this period (model data, not government observations)',

  '水利署感測器沒有有效的風速，改看 Open-Meteo 模型風速 {lo}–{hi} m/s：風越大，洋流越急（模型資料，非政府觀測）':
    'The WRA sensor has no valid wind reading, so Open-Meteo modeled wind speed {lo}–{hi} m/s is used: stronger wind, faster current (model data, not government observations)',
  '水利署感測器沒有有效的風速，改看 Open-Meteo 模型風速約 {v} m/s：這段時間變化很小（模型資料，非政府觀測）':
    'The WRA sensor has no valid wind reading, so Open-Meteo modeled wind speed of about {v} m/s is used: little change over this period (model data, not government observations)',

  // ---- 字幕：空氣品質站的「模型 vs 環境部測站觀測」----
  '環境部{station}站': 'MOENV’s {station} station',
  '環境部測站': 'MOENV station',
  '與{who}觀測相比，模型平均大致吻合（逐時平均誤差 {mae} μg/m³）': 'Versus {who} observations, the model roughly matches on average (mean hourly error {mae} μg/m³)',
  '與{who}觀測相比，模型平均差僅 {v} μg/m³，但逐時落差明顯（平均絕對誤差 {mae} μg/m³）': 'Versus {who} observations, the mean gap is only {v} μg/m³, but hour-by-hour gaps are large (mean absolute error {mae} μg/m³)',
  '資料來源：環境部測站觀測（政府資料開放授權條款－第1版）': 'Observations: MOENV stations (Taiwan Open Government Data License v1)',
  '與{who}觀測相比，模型平均高估 {v} μg/m³': 'Versus {who} observations, the model overestimates by {v} μg/m³ on average',
  '與{who}觀測相比，模型平均低估 {v} μg/m³': 'Versus {who} observations, the model underestimates by {v} μg/m³ on average',
}
