// 語音旁白（lib/narration.js）：朗讀時把單位 / 符號口語化用的詞。這些不是畫面上的 UI 文字，而是「念出來的字」——
// 中文版念中文詞，英文版念這裡的英文詞（narration.js 內建同一份英文表，測試會核對兩邊一致，所以字典漏了或改了都會被抓到）。
// 用語依 GLOSSARY.md 的英式拼法（metre / centimetre，與其他英文說明一致：Taiwan 資料以公制、英文旁白用 British spelling）。
export default {
  '微克每立方公尺': 'micrograms per cubic metre',
  '立方公尺每秒': 'cubic metres per second',
  '立方公尺': 'cubic metres',
  '平方公里': 'square kilometres',
  '平方公尺': 'square metres',
  '公里每小時': 'kilometres per hour',
  '公尺每秒': 'metres per second',
  '公分每秒': 'centimetres per second',
  '毫米每小時': 'millimetres per hour',
  '公分': 'centimetres',
  '毫米': 'millimetres',
  '微米': 'micrometres',
  '{a}到{b}': '{a} to {b}',
  '上升': 'rising',
  '下降': 'falling',
}
