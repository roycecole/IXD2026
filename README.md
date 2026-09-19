# IXD2026 — 資料導演台 (Data Director Console)

用 **KORG nanoKONTROL2 / nanoPAD2** 兩台 MIDI 控制器，即時「演奏」一顆**化為海洋的 3D 星球**——透明球殼裡的療癒深海，內含水母、魚群、鯨豚、海龜與海洋垃圾，並有一片逐漸轉化成文字與數字的海。參數可 MIDI Learn 綁定、可錄製回放、可分享、可錄影下載。資料主題可延伸至台灣**政府開放資料**（[Twinkle Hub](https://hub.twinkleai.tw/zh-TW)）。

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
| 3D 海洋球 | Three.js / R3F；透明球殼 + 程序化波浪 + 海洋生物 + 流動文字；**滑鼠拖曳 / 旋鈕改變旋轉** |
| 參數面板 | 分組滑桿，每個參數可 **MIDI Learn** 綁定 CC |
| 錄製 / 播放 | 把整段旋鈕演出錄下並回放；**soft-takeover** 播放中抓旋鈕平順接管、不跳值 |
| 分享 | 產生帶參數的網址（`?s=…`），複製即分享目前視覺狀態 |
| 錄影 | 擷取星球 10 秒，下載 **MP4 / WebM** |
| 匯出 LOG | 下載 IN/OUT 訊息日誌，方便開發者除錯 |
| 舒適背景音 | Tone.js 生成式環境音：海水高度=根音 Hz、清澈=明亮度、洋流=浪速、輝光=空間感、垃圾=失諧、魚群×游速=點綴音、鯨豚龜=叫聲、打擊墊=音階（按「聲音」開啟） |
| 可調版面 | 拖曳分隔線改變面板寬度 / 監看高度 |
| 手機 RWD | 窄螢幕自動改為上下堆疊 + 觸控互動 |
| 本機儲存 | localStorage / sessionStorage 記住參數、綁定、尺寸、錄製、日誌 |

---

## 控制對應（nanoKONTROL2 出廠預設）

**6 推桿 (Slider 1–6, CC0–5)**

| 推桿 | 效果 |
|---|---|
| 1 | 海水高度 |
| 2 | 洋流速度 |
| 3 | 水母數量 |
| 4 | 魚群數量 |
| 5 | 垃圾數量 |
| 6 | 海水清澈程度 |

**2 旋鈕 (Knob 1–2, CC16–17)**：旋轉海洋球 / 生物游動速度。

**4 按鈕 (Button 1–4, Solo CC32–35)**：鯨魚出現 / 海豚出現 / 海龜出現 / 清除垃圾。

> **生態連動**：垃圾增加 → 海水混濁、生物減少；垃圾減少 → 海水變清澈、生物回歸（全程平滑）。
> 若你的裝置 CC 不同：**點參數名稱 → 轉旋鈕**即重綁（Learn），或按「依序對應旋鈕」；`shift+點` 解綁。按鈕也可用畫面上的動作鈕（滑鼠 / 觸控）。綁定存 localStorage。

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
