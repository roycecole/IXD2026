// 新手導覽（Onboarding：一步一步的互動引導，取代首次進站彈出的長篇說明）與說明視窗的「重新看新手導覽」按鈕。
// 用語依 GLOSSARY.md：sphere、sea level（海水高度）、Stage mode（演出模式）、Share / AR view / Jam / Devices / Help（工具列鈕）。
// 每一步一個標題 + 一兩句短句；按鈕文字動詞開頭、不加句點。
export default {
  // ---- 步驟（lib/onboarding.js 的 STEPS）----
  '歡迎來到 MidiSea': 'Welcome to MidiSea',
  '一顆裝著海的球，海況來自台灣政府開放資料。按「開始」，一步一步帶你玩。':
    'A sphere with a sea inside, driven by Taiwan government open data. Press Start for a quick, step-by-step tour.',
  '轉動與觸碰': 'Turn and touch',
  '拖曳球體轉動，兩指或滾輪縮放；點一下亮起星星，雙擊進入全螢幕演出模式。':
    'Drag the sphere to turn it; pinch or scroll to zoom. Tap to light up a star, double-tap for full-screen Stage mode.',
  '調整海': 'Shape the sea',
  '拖動滑桿（或轉 MIDI 旋鈕），改變海水高度、洋流與清澈度，球會立刻回應。':
    'Drag a slider (or turn a MIDI knob) to change sea level, current and water clarity. The sphere responds at once.',
  '接上真實資料': 'Plug into real data',
  '選一個資料，例如水庫、潮汐、月亮或揚塵，球就依真實資料變化；再按「▶ 播放」看它一天的起伏。':
    'Pick a dataset such as a reservoir, the tide, the moon or dust, and the sphere follows the real data. Then press "▶ Play" to watch a day unfold.',
  '資料導覽': 'Data tour',
  '按 T 或「▶ 開始導覽」，球會自動巡演今日的水庫、潮汐、月亮、鳥與魚；碰一下就停止。':
    'Press T or "▶ Start tour" and the sphere plays through today\'s reservoir, tide, moon, birds and fish. Touch anything to stop.',
  '更多功能': 'And more',
  '工具列還有分享、實景 AR、多人合奏、裝置、EN / 中文切換與說明。':
    'The toolbar also has Share, AR view, Jam, Devices, the language switch and Help.',
  '準備好了': 'You are ready',
  '隨時按「說明」看完整說明，也能在說明裡選「重新看新手導覽」。':
    'Press Help any time for the full guide, or choose "Replay the quick tour" inside it.',

  // ---- 卡片 ----
  '新手導覽': 'Quick tour',
  '第 {n} / {total} 步': 'Step {n} of {total}',
  '開始': 'Start',
  '下一步': 'Next',
  '上一步': 'Back',
  '略過': 'Skip',
  '略過（Esc）': 'Skip (Esc)',
  '上一步（←）': 'Back (←)',
  '下一步（→ 或 Enter）': 'Next (→ or Enter)',

  // ---- 說明視窗 ----
  '重新看新手導覽': 'Replay the quick tour',
}
