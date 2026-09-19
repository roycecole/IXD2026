# IXD2026 — 資料導演台 (Data Director Console)

用 **KORG nanoKONTROL2 / nanoPAD2** 兩台 MIDI 控制器，即時「演奏」一顆 **Google Earth 風格的 3D 資料星球**。參數可 MIDI Learn 綁定、可錄製回放、可分享、可錄影下載。內容資料來源為台灣**政府開放資料**（[Twinkle Hub](https://hub.twinkleai.tw/zh-TW) / 中央氣象署 / 水利署）。

> 核心命題：把抽象的多維資料，變成一台可以用雙手演奏的資料樂器。

---

## 快速開始

```bash
npm install
npm run dev
```

用**桌面版 Chrome / Edge** 開啟 http://localhost:5173，按「連線 MIDI」允許權限。

> Web MIDI 需要 Chrome / Edge + localhost 或 HTTPS。Safari 支援較不穩；內建瀏覽器沙盒會擋 MIDI 權限——實體裝置請用你自己的 Chrome。

---

## 主要功能

| 功能 | 說明 |
|---|---|
| 3D 自轉星球 | Three.js / R3F；**滑鼠拖曳球體改變自轉速度**（觸控亦可） |
| 參數面板 | 分組滑桿，每個參數可 **MIDI Learn** 綁定 CC |
| 錄製 / 播放 | 把整段旋鈕演出錄下並回放；**soft-takeover** 播放中抓旋鈕平順接管、不跳值 |
| 分享 | 產生帶參數的網址（`?s=…`），複製即分享目前視覺狀態 |
| 錄影 | 擷取星球 10 秒，下載 **MP4 / WebM** |
| 匯出 LOG | 下載 IN/OUT 訊息日誌，方便開發者除錯 |
| 可調版面 | 拖曳分隔線改變面板寬度 / 監看高度 |
| 手機 RWD | 窄螢幕自動改為上下堆疊 + 觸控互動 |
| 本機儲存 | localStorage / sessionStorage 記住參數、綁定、尺寸、錄製、日誌 |

---

## 控制對應（nanoKONTROL2 出廠預設）

**8 旋鈕 (CC16–23) → 視覺效果**

| 旋鈕 | CC | 效果 |
|---|---|---|
| 1 | 16 | 自轉速度 |
| 2 | 17 | 球體大小 |
| 3 | 18 | 視角遠近（鏡頭距離） |
| 4 | 19 | 背景亮度（世界光） |
| 5 | 20 | 背景粒子（星空密度） |
| 6 | 21 | 大氣輝光 |
| 7 | 22 | 資料點輝度 |
| 8 | 23 | 地軸傾角 |

**8 推桿 (CC0–7) → 資料混音**：溫度增益 / 降雨 / 風 / 水位 / 進流 / 點密度 / 熱度 / 全域輝度。

> 若你的裝置 CC 不同：**點參數名稱 → 轉一下旋鈕**即重綁（Learn），或按「依序對應旋鈕」逐一掃過；`shift+點` 解綁。綁定存 localStorage。

---

## 錄製 / 播放

1. `● 錄製` → 動旋鈕 / 拖球體 / 拉滑桿演出 → `■ 停止錄製`
2. `▶ 播放` 重現整段；`⟲ 清除` 重錄
3. **soft-takeover**：播放時抓實體旋鈕，需先讓實體值「經過」畫面當下值才接管，避免跳值；手動拉滑桿 / 拖球體則即時接管
4. 錄製自動存 localStorage，重開仍可播放

## 分享

按 `分享` → 複製一條帶目前參數的網址（`?s=<base64>`）。對方開啟即載入你的視覺狀態。

## 錄影

按 `錄影` → 擷取星球 10 秒 → 自動下載 `ixd2026-globe.mp4`（瀏覽器不支援 MP4 時退回 `.webm`）。

## 匯出 LOG

按 `匯出LOG` → 下載 `ixd2026-log.txt`（帶時間戳的 IN/OUT 訊息），供除錯 MIDI / 事件流。

---

## 專案結構

```text
IXD2026/
├─ README.md · SPEC.md              # 說明 · 完整規格（含 Mermaid）
├─ index.html · package.json · vite.config.js
├─ tools/midi-monitor.html          # MIDI 偵測器（實測 CC/Note、匯出映射）
└─ src/
   ├─ main.jsx · App.jsx · styles.css
   ├─ hooks/useMIDI.js              # Web MIDI 連線 + 訊息解析
   ├─ store/useStore.js             # Zustand 單一狀態源（參數/綁定/錄製/soft-takeover）
   ├─ params/registry.js            # 參數分組 + 預設綁定
   ├─ lib/
   │  ├─ persist.js                 # localStorage / sessionStorage
   │  ├─ share.js                   # 參數 ↔ 分享網址
   │  └─ capture.js                 # 畫布錄影 + 下載
   ├─ ui/                           # TopBar · ParamPanel · Monitor · Splitter
   ├─ scene/Scene3D.jsx             # R3F 3D 星球
   └─ timeline/scenes.js            # 場景預設
```

---

## 技術

React + Vite · Three.js + React Three Fiber · Zustand · Web MIDI API。

**效能設計**：3D 場景在 render loop 內以 `useStore.getState()` 讀參數，MIDI 高頻訊息不觸發 React re-render；錄製緩衝與 soft-takeover 狀態放模組層，避免每則訊息重繪。

**開發輔助**：dev 模式下主控台可用 `window.__store` 驅動測試。

---

## 資料 / 授權

政府資料開放授權條款第 1 版 (OGDL v1)。完整資料來源與 schema 見 [SPEC.md](./SPEC.md)。
