// 調查年表時間軸：SurveyTimeline（畫面 + 文字替代）、series.js 的空窗年 HUD 文字、SurveyCard 的播放說明。
// 「無調查」= 該流域那一年沒有鳥 / 魚調查（資料空窗）；播放時以前後調查年線性內插補上，畫面與 HUD 都明講是內插。
export default {
  // ---- SurveyTimeline ----
  '調查時間軸': 'Survey timeline',
  '無調查 {range}': 'No survey {range}',
  '{a} 到 {b}': '{a} to {b}',
  '調查年度 {years}；{gaps} 無調查': 'Survey years {years}; no survey {gaps}',
  '調查年度 {years}；連續調查，無空窗': 'Survey years {years}; surveyed every year, no gaps',
  '{n} 個調查年 · 空窗 {g} 年': ({ n, g }) => `${n} survey year${n === 1 ? '' : 's'} · ${g} year${g === 1 ? '' : 's'} without survey`,
  '{n} 個調查年 · 連續無空窗': ({ n }) => `${n} survey year${n === 1 ? '' : 's'} · no gaps`,
  '{year} 年 · {v} 種': '{year} · {v} species',
  '{year} 年 · 無調查（內插）': '{year} · no survey (interpolated)',

  // ---- series.js：formatHud 的空窗年（DataHUD / OUT 日誌共用）----
  '{name} {year} 年 · 無調查（內插）': '{name} {year} · no survey (interpolated)',
  '{label} ≈{v}': '{label} ≈{v}',

  // ---- SurveyCard：播放說明（每一步＝一個日曆年）----
  '依年度播放 {basin} 的鳥群調查：每一步＝一年，沒有調查的年份以內插補上並標示「無調查」，鳥群數量隨當年物種數變化':
    'Play the {basin} bird survey year by year: each step is one calendar year. Years without a survey are filled in by interpolation and marked "no survey"; the flock count follows that year\'s species count.',
  '依年度播放 {basin} 的魚群調查：每一步＝一年，沒有調查的年份以內插補上並標示「無調查」，魚群數量隨當年物種數變化':
    'Play the {basin} fish survey year by year: each step is one calendar year. Years without a survey are filled in by interpolation and marked "no survey"; the school count follows that year\'s species count.',
}
