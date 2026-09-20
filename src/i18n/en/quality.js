// 「裝置」面板的畫質一節（QualitySection）。模式與等級名稱刻意用「高畫質」等完整詞，避免和其他字典的單字 key（'中' 等）撞名。
export default {
  '畫質': 'Graphics quality',
  '依畫面更新速度（FPS）自動調整解析度與特效，保護較舊的手機與 iPad；也可以手動固定在某一級。':
    'Adjusts resolution and effects automatically from the frame rate (FPS) to protect older phones and iPads. You can also lock it to one level.',
  '畫質模式': 'Quality mode',
  '自動選擇': 'Auto',
  '高畫質': 'High',
  '中畫質': 'Medium',
  '低畫質': 'Low',
  '目前等級：{tier}（自動調整）': 'Current level: {tier} (automatic)',
  '目前等級：{tier}（手動固定）': 'Current level: {tier} (locked)',
  '目前 FPS：量測中': 'Current FPS: measuring…',
  '目前 FPS：{fps}': 'Current FPS: {fps}',
  '上次自動降級：{time}，{from} → {to}（{s} 秒平均 {fps} FPS，低於 {threshold}）':
    'Last automatic downgrade: {time}, {from} → {to} (average {fps} FPS over {s} s, below {threshold})',
  '尚未自動降級': 'No automatic downgrade yet',
  '高畫質：完整效果，解析度最高 2 倍像素比。': 'High: all effects, resolution up to 2x pixel ratio.',
  '中畫質：解析度上限 1.5 倍，生物與粒子約減 30%。': 'Medium: resolution capped at 1.5x, about 30% fewer creatures and particles.',
  '低畫質：解析度 1 倍，生物與粒子減半、流星關閉；背景模糊不套用，背景清澈以簡化暗化代替。':
    'Low: 1x resolution, half the creatures and particles, no shooting stars. Background blur is skipped and background clarity uses a simple darkening instead.',
  '目前的背景模糊設定在低畫質下被略過；背景清澈仍有效果，但是簡化版。':
    'Your background blur setting is skipped at low quality. Background clarity still works, in a simplified form.',
  '調整暫停中：拖曳、錄影，或分頁在背景時不會換級。': 'Adjustment is paused: the level does not change while you drag, record, or the tab is in the background.',
  '目前的模式來自網址的 ?quality= 參數；在這裡選擇會改存為偏好。': 'This mode comes from the ?quality= URL parameter. Choosing one here saves it as your preference.',
  '只量測畫面更新速度；偏好只存在這台裝置，不會傳送任何資料。': 'Only the frame rate is measured. Your choice stays on this device; nothing is sent anywhere.',
}
