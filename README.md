# IXD2026 — MIDI × 政府開放資料互動系統

用 **KORG nanoKONTROL2 + nanoPAD2** 兩台 MIDI 實體控制器，透過瀏覽器原生 **Web MIDI API**，即時「演奏」台灣**政府開放資料**（Twinkle Hub / CWA / 水利署）的 **React.js** 互動視覺化專案。

> 核心命題：把抽象的多維資料，變成一台可以用雙手演奏的資料樂器。

## 技術棧
- 前端：React.js + Vite
- 輸入：Web MIDI API（nanoKONTROL2 推桿/旋鈕/按鈕、nanoPAD2 打擊墊/X-Y 觸控板）
- 資料：台灣政府開放資料（經代理層處理 CORS / API Key）
- 視覺：路線 A（D3 / Canvas / SVG，主力）+ 路線 B（Three.js / R3F，選用）

## 文件
- 完整規格與架構、Mermaid 圖：見 [SPEC.md](./SPEC.md)

## 開發狀態
🚧 規劃中 — 詳見 SPEC.md 的開發里程碑。
