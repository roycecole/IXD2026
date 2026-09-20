// 迷你折線圖（純 SVG、無依賴、可無障礙）。【介面契約——實作者填入；資料卡 / 導覽字幕依此使用】
//   <Sparkline points={number[]} obs={number[]?} height={number?=28} marker={index?} ariaLabel={string} />
//   points：主要序列（例如模型 PM2.5）；obs：第二條線（例如環境部觀測，可含 null 表示缺值）；marker：目前播放位置（索引）。
//   寬度 100% 自適應；顏色用 CSS 變數（--accent / --amber / --muted）；role="img" + aria-label；points 不足 2 筆 → 不渲染。
export default function Sparkline() {
  return null   // 占位：實作者取代
}
