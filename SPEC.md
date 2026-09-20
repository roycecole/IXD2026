# IXD2026 — MIDI 實體控制器 × 政府開放資料互動系統｜規格文件

| 項目 | 內容 |
|---|---|
| 專案代號 | IXD2026 |
| 文件版本 | v0.2 |
| 最後更新 | 2026-09-20 |
| 技術主軸 | React.js · Web MIDI API · 政府開放資料 (Twinkle Hub / CWA / 水利署) |
| 硬體 | KORG nanoKONTROL2、KORG nanoPAD2 |

> 本文件所有 Mermaid 圖皆為標準語法，可直接在 GitHub / VS Code Markdown Preview / Mermaid Live Editor 獨立渲染。

---

## 1. 專案概述 (Overview)

本專案以 **KORG nanoKONTROL2 + nanoPAD2 兩台 MIDI 控制器**作為實體輸入，透過瀏覽器原生 **Web MIDI API** 即時操作以 **React.js** 建構的網頁介面，內容資料來源為 **台灣政府開放資料**（透過 [Twinkle Hub](https://hub.twinkleai.tw/zh-TW) 及各部會開放平台）。

核心命題：**把抽象的多維資料，變成一台可以用雙手「演奏」的資料樂器**。實體控制器最強的能力是「同時多路、連續、盲操作」；政府開放資料的價值是「多維、有時間、有空間」。兩者交集即為本專案的設計核心。

### 1.1 設計目標
- 證明「實體控制器 vs 滑鼠鍵盤」在資料探索上的體驗差異。
- 建立可重用的 `useMIDI` / `useGovData` React 架構。
- 完成一個可現場操作展示的資料視覺化「儀表台 / 演出台」。

---

## 2. 需求規格 (Requirements)

### 2.1 功能性需求 (Functional Requirements)

| 編號 | 需求 | 優先級 |
|---|---|---|
| FR-01 | 系統能連線並辨識 nanoKONTROL2 與 nanoPAD2 兩台裝置 | P0 |
| FR-02 | 推桿 / 旋鈕（CC）即時連續控制視覺參數 | P0 |
| FR-03 | 打擊墊（Note）觸發事件，並讀取 velocity 力度 | P0 |
| FR-04 | X-Y 觸控板作為 2D 地理探針，查詢對應測站資料 | P1 |
| FR-05 | 走帶鍵（Transport）播放 / 捲動時間序列資料 | P1 |
| FR-06 | 由政府開放資料 API 取得即時資料並依頻率輪詢更新 | P0 |
| FR-07 | 螢幕即時鏡像控制器狀態（解決實體/畫面跳值） | P1 |
| FR-08 | 反向送 MIDI 點亮 nanoKONTROL2 的 LED 作為狀態回饋 | P2 |
| FR-09 | 支援裝置熱插拔（中途拔線/接線自動重連） | P2 |
| FR-10 | 版面採左右分欄（左：視覺主畫面；右：UI 控制面板） | P0 |
| FR-11 | 裝置選擇：列出偵測到的 MIDI 輸入，指派 KONTROL2 / PAD2 角色 | P0 |
| FR-12 | 連線狀態指示 + 手動「連線 MIDI」觸發 Web MIDI 權限 | P0 |
| FR-13 | 無硬體降級：右側控制項可用滑鼠操作（螢幕控制 / demo 模式） | P1 |
| FR-14 | 參數以 MIDI Learn 動態綁定 CC（可解綁、存檔），非寫死映射 | P0 |
| FR-15 | 時間軸場景 keyframe 自動演化參數 + 手動覆寫（soft-takeover） | P1 |
| FR-16 | 主畫面採 3D 生成場景（Three.js / R3F），由參數即時驅動 | P0 |
| FR-17 | nanoPAD2 打擊墊 → 資料事件（velocity=強度）；X-Y → 探針 / 鏡頭 | P1 |
| FR-18 | 資料導覽：依序巡演八站真實資料（含空氣品質）並以字幕說明；導覽員可點進度點跳站、上一站 / 下一站 / 暫停（`←` `→` `P`）、複製每站連結（`?tourstop=`），並可選用語音旁白 | P1 |
| FR-19 | 裝置診斷頁（`?diagnostics=1`）：25 項快速檢查 + 12 項互動檢查，展前逐項確認實際硬體並匯出報告；不上傳任何東西 | P1 |
| FR-20 | 「空氣品質」海況：有變化的空品資料（Open-Meteo / CAMS 模型資料），介面一律標示「模型資料、非政府觀測」 | P1 |
| FR-21 | 首次進站的一步一步互動新手導覽（取代長篇說明）；輸入輸出（系統事件）監看可隱藏（`L` / Footer 開關 / `?log=`） | P2 |
| FR-22 | 視角依畫布長寬比自動取景，手機直式全螢幕看得到整顆球；寬螢幕取景不變（`?fit=0` 可關） | P2 |

### 2.2 非功能性需求 (Non-Functional Requirements)

| 編號 | 需求 | 指標 |
|---|---|---|
| NFR-01 | 互動延遲 | MIDI 輸入到畫面反應 < 50ms |
| NFR-02 | 畫面流暢度 | 維持 60 FPS（大量元素時容許 30 FPS） |
| NFR-03 | 瀏覽器支援 | Chrome / Edge（主要）；Firefox / Safari 16.4+（次要） |
| NFR-04 | 安全性 | API Key 不得出現在前端；需 HTTPS 或 localhost |
| NFR-05 | 資料時效 | 輪詢頻率對齊資料源真實更新頻率，不過度請求 |
| NFR-06 | 展場穩定性（整天不關機、無人看管） | 畫面錯誤自動倒數重載（退避 5 → 15 → 60 秒，10 分鐘內 5 次熔斷停手）；WebGL 遺失 4 秒未恢復即重載；渲染看門狗（可見卻 10 秒無動畫幀；展場與觀眾視窗預設啟用）；新版（`dist/version.json`）與新資料只在閒置時自動更新；`?reload=HH` 每日重載；崩潰紀錄只存本機 |
| NFR-07 | 資料誠實與標示 | 模型資料一律標示、不冒充政府觀測；CC BY 4.0 的 Open-Meteo 標示出處；沒驗證過的事如實揭露（見 README〈驗證狀態〉） |
| NFR-08 | 可驗證性 | 純邏輯以 `node --test` 驗證（撰寫本文時 954 項：953 通過、1 跳過），瀏覽器 / 真機專屬行為以裝置診斷頁與真機驗證日補足（見 README〈測試〉〈裝置診斷頁〉） |

---

## 3. 資料規格 (Data)

### 3.1 資料來源與結構（實測欄位）

| 資料集 | 來源 | 真實結構 | 更新頻率 | 適合的控制 |
|---|---|---|---|---|
| 36 小時縣市預報 | CWA F-C0032-001 | 22 縣市 × {Wx 天氣碼, PoP 降雨機率%, MinT/MaxT 溫度, CI 舒適度} × 3 時段 | 6 小時 | 推桿/Pad = 縣市；Transport = 時段 |
| 即時自動氣象站 | CWA O-A0001-001 | ~700 站 × {經緯度 WGS84, 氣溫, 濕度, 風速/風向, 雨量, 氣壓} | 10 分鐘 | X-Y 觸控板 = 地理座標探針 |
| 水庫即時水情 | 水利署 45501 | 逐小時 time-series × {水位, 有效蓄水量, 進流量, 出流量} | 1 小時 | Transport 播放鍵 = 時間軸捲動 |
| IoW 揚塵 | 水利署 `ae7bd821-a879-4b65-ad34-b3dac36874e0`（+ 基本資料 `a2ea1f32-…`） | 雲林縣 3 站 × {PM10, 風速, 氣溫, 相對濕度} **最新值**（PM10 常為哨兵值 4999.4 → 視為缺值） | 約 1 小時（歷史由 CI 每 3 小時累積） | 海水清澈 / 垃圾 / 洋流；Transport = 歷史播放（PM10 無效時用風速） |
| 河川流量測站站況 | 水利署 `9332bd66-0213-4380-a5d5-a43e7be49255` | 188 站 × {河川, TWD97 座標, 集水面積, 現存 / 已廢}，僅站點目錄 | 靜態 | 背景星座 |
| 魚類調查 | 水利署 `0a79fde0-a69d-4842-b66b-e51f43ce83f0` | 樣點 × 物種 × 日期 × 數量 → 逐月 / 逐年物種數 | 靜態（歷史調查） | 魚群數量；Transport = 調查年表 |
| 月出月沒時刻 | CWA A-B0063-001 | 縣市 × 逐日 {月出 / 中天 / 月沒時刻、月出月沒方位角、中天仰角}（單次最多 180 天，需帶 `timeFrom` / `timeTo`） | 每日 | 月亮方位 / 高度；Transport = 逐日播放 |
| 空氣品質（**模型資料，非政府觀測值**） | Open-Meteo Air Quality API（CAMS 全球大氣模型；CC BY 4.0） | 雲林縣麥寮（約 23.79°N、120.25°E）× 逐時 {PM2.5、PM10、沙塵、US AQI}；每次抓過去 5 天，保留「現在以前」最近 120 小時；US AQI 是美國 EPA 指標，不是環境部 AQI | 逐時（CI 每 3 小時刷新，失敗保留舊資料） | 海水清澈 / 垃圾 / 色相 / 輝光；Transport = 逐時播放 |

> 實作備註：實際採「靜態快照 `public/data/ocean.json` + GitHub Actions 定時刷新」而非代理層（見 README〈資料集 → 畫面〉），因此瀏覽器不需直連政府 API，CORS 與金鑰外洩問題不存在。
>
> 空氣品質備註：水利署 IoW 揚塵的 PM10 感測器仍回傳無效哨兵值、風速疑似凍結（截至 2026-09-20），所以另加有變化的空品資料。環境部空品 API 需要使用者自己申請的 API key，本專案沒有代為申請，目前**沒有**接；可選的後續：有 key 之後以 CI secret（例如 `MOENV_KEY`）接入政府觀測值。在那之前，空氣品質一律當作模型資料看待。

- 授權：政府資料開放授權條款第 1 版 (OGDL v1) + 各平台使用規範。空氣品質來自 Open-Meteo，授權 CC BY 4.0，需標示「Weather data by Open-Meteo.com」並連結 <https://open-meteo.com/>；其免費 API 限非商業使用。
- 資料另可透過 Twinkle Hub 跨 28 domain、53,000+ dataset 擴充（不動產、採購、交通、環境、醫療…）。

### 3.2 資料正規化原則
- 所有 0–127 的 MIDI 值統一正規化為 `0.0–1.0` 再對應到資料範圍。
- API 回傳的字串數值一律 `parseFloat` 轉數字，`-99` 等哨兵值視為缺值。
- 代理層統一輸出扁平化 JSON，前端不處理各 API 的巢狀差異。

### 3.3 資料取得的關鍵風險（務必先解決）
- **CORS**：多數政府 API 不允許瀏覽器跨域直接請求 → 需經由代理層。
- **API Key**：CWA 開放平台需免費註冊授權碼，**不可寫死在前端** → 放代理層環境變數。
- **Twinkle Hub REST 可用性**：需先確認是否提供可供瀏覽器直接呼叫（CORS 開放）的公開 REST API；若否，一律走自建代理層。

---

## 4. 硬體規格 (Hardware)

### 4.1 裝置能力

| 裝置 | 控制元件 | 訊息類型 | 值域 | 特性 |
|---|---|---|---|---|
| nanoKONTROL2 | 推桿 ×8 | Control Change | 0–127 | 絕對值、多路並行 |
| nanoKONTROL2 | 旋鈕 ×8 | Control Change | 0–127 | 絕對值 |
| nanoKONTROL2 | S/M/R 按鈕 ×24 | CC（可設 Note） | 0 / 127 | 開關、LED 可回控 |
| nanoKONTROL2 | 走帶鍵 ×13 | CC | 0 / 127 | 播放/停止/上下頁 |
| nanoPAD2 | 打擊墊 ×16（×4 Scene） | Note On/Off | velocity 0–127 | **力度感應** |
| nanoPAD2 | X-Y 觸控板 ×1 | CC（X 軸 + Y 軸） | 各 0–127 | **2D 連續手勢** |

### 4.2 預設 MIDI 映射（KORG 出廠值，**須以實測為準**）

| 控制 | 預設 CC / Note |
|---|---|
| 推桿 1–8 | CC 0–7 |
| 旋鈕 1–8 | CC 16–23 |
| Solo 1–8 | CC 32–39 |
| Mute 1–8 | CC 48–55 |
| Rec 1–8 | CC 64–71 |
| nanoPAD2 打擊墊 | Note（依 Scene 起始音高遞增） |
| nanoPAD2 X-Y | CC（可用 KORG Kontrol Editor 設定） |

> ⚠ 不同韌體 / 設定檔的 CC 號可能不同，**開發第一步必須做 MIDI Monitor 實測建表**。

### 4.3 LED 回饋
- nanoKONTROL2 需以 KORG Kontrol Editor 切換至 **External LED mode**。
- 之後由程式 `output.send([0xB0, ccNum, 127])` 點亮 / `0` 熄滅，用於指示：目前選中軌、錄製中閃爍、圖層開關狀態。

---

## 5. 互動設計 (Interaction Design)

### 5.1 設計哲學：為什麼非用實體控制器？
| 實體控制器優勢 | 對應到本專案的場景 |
|---|---|
| 同時多路控制 | 8 推桿同時混合 8 個縣市/維度 |
| 連續 + 力度 | 觸控板連續探針、Pad 力度做強調爆發 |
| 盲操作 / 肌肉記憶 | 眼睛專注畫面，手憑記憶操作 |

### 5.2 映射總表 —「島嶼氣象調音台」

> **映射方式已定案升級為 MIDI Learn 動態綁定**（見 §5.5）。下表為「預設建議綁定」，實際以執行時 Learn 綁定並存檔為準。

**nanoKONTROL2（資料混音台）**

| 控制 | 資料操作 | 畫面回饋 |
|---|---|---|
| 推桿 ×8 | 8 縣市的權重（強度） | 8 軌即時長高 |
| 旋鈕 ×8 | 視覺參數（色彩範圍、密度、閾值、縮放） | 參數環 |
| Solo ×8 | 獨奏某縣市（其餘變暗） | LED 亮 + highlight |
| Mute ×8 | 隱藏某圖層 | LED 亮 + 變灰 |
| Rec ×8 | 快照 / 釘選數值 | LED 閃爍 |
| ▶ / ■ | 時間序列播放 / 停止 | 時間軸游標 |
| ◀◀ / ▶▶ | 逐格捲動時間 | — |
| Track ◀ ▶ | 切換資料集（天氣→水庫→空品） | 標題切換 |

**nanoPAD2（演出 / 探針）**

| 控制 | 資料操作 | 畫面回饋 |
|---|---|---|
| Pad ×16 | 觸發 16 縣市，velocity = 強調程度 | 縣市脈衝動畫 |
| X-Y 觸控板 | 地理探針：X=經度、Y=緯度 → 最近測站即時值 | 地圖游標 + 數值卡 |

### 5.3 MIDI 訊息解碼流程

```mermaid
flowchart LR
    MSG["MIDI 訊息 status/d1/d2"] --> T{"訊息類型 判斷高位元組"}
    T -->|"0xB0 Control Change"| C{"CC 號是否為 X-Y?"}
    C -->|是| XY["X-Y 觸控板：地理探針"]
    C -->|否| CTRL["推桿 / 旋鈕：連續參數"]
    T -->|"0x90 力度大於0"| NOTE["Pad 按下：讀 velocity"]
    T -->|"0x80 或 力度等於0"| OFF["Pad 放開"]
```

### 5.4 頁面版面與裝置連線 (Layout & Device Connection)

**版面：左右分欄（FR-10）**
- **左欄（主畫面，約 70%）**：資料視覺化主舞台（D3 / Canvas / R3F）+ 底部時間軸與走帶控制。
- **右欄（控制面板，約 30%）**：裝置連線、資料選擇、控制鏡像（兼作無硬體時的螢幕控制項）。

```text
┌───────────────────────────────────────┬──────────────────────┐
│  資料視覺化主畫面 (左 ~70%)             │  控制面板 (右 ~30%)   │
│                                        │                      │
│   ┌───────────────────────────────┐    │  [裝置 Devices]      │
│   │                               │    │   ● nanoKONTROL2 連線 │
│   │        D3 / Canvas / R3F      │    │   ○ nanoPAD2 未連線   │
│   │        資料視覺主舞台         │    │   [ 連線 MIDI ] 按鈕  │
│   │                               │    │                      │
│   └───────────────────────────────┘    │  [資料 Data]         │
│                                        │   ▼ 天氣預報 / 水庫…  │
│   ◀◀  ▶  ■  ▶▶    ●───────────         │   更新於 3 分鐘前      │
│   [=======|=================] 時間軸    │                      │
│                                        │  [控制鏡像 / 螢幕控制]│
│                                        │   推桿 ▮▮▮▮▮▮▮▮       │
│                                        │   旋鈕 ◔◔◔◔◔◔◔◔       │
│                                        │   S / M / R  ▢▢▢     │
└───────────────────────────────────────┴──────────────────────┘
```

**右欄控制面板分區**

| 區塊 | 內容 | 對應需求 |
|---|---|---|
| 裝置 Devices | 「連線 MIDI」按鈕、偵測到的輸入清單、各裝置連線狀態燈、角色指派（KONTROL2=混音台 / PAD2=演出探針） | FR-11 / FR-12 |
| 資料 Data | 資料集下拉選擇、最後更新時間、輪詢狀態 | FR-06 |
| 控制鏡像 Mirror | 8 推桿 / 8 旋鈕 / S・M・R 即時鏡像；**無硬體時可用滑鼠拖曳操作** | FR-07 / FR-13 |
| 播放 Playback | ▶ / ■、時間軸位置（也可由走帶鍵控制） | FR-05 |

**無硬體降級（FR-13）**：使用者可能連、也可能不連硬體，因此 App 啟動時**不預設有裝置**。未連線時，右欄「控制鏡像」即化身為可用滑鼠操作的螢幕控制器（demo 模式），確保無硬體也能完整體驗；連上硬體後兩者即時同步。

**裝置連線狀態機**

```mermaid
stateDiagram-v2
    state "未連線" as A
    state "請求權限" as B
    state "已授權 (列出裝置)" as C
    state "已選裝置" as D
    state "運作中" as E
    state "裝置中斷" as F
    state "螢幕控制模式" as G
    [*] --> A
    A --> B: 點擊 連線 MIDI
    B --> C: requestMIDIAccess 成功
    B --> A: 使用者拒絕權限
    C --> D: 指派 KONTROL2 / PAD2 角色
    D --> E: 綁定 onmidimessage
    E --> E: 收送 MIDI 與 LED
    E --> F: 拔線 onstatechange
    F --> E: 重新接上 自動重連
    A --> G: 略過硬體 用滑鼠操作
    G --> D: 之後接上硬體
```

### 5.5 控制面板模型（參考 The Last Input · 分鏡導演台）

版面升級為三區「導演台」：**頂部場景時間軸 + 左資料動畫主畫面（3D）+ 右分組參數面板 + 底部 MIDI 監看**。核心機制：

- **參數分組**：WORLD / WEATHER / HYDRO / LIFE / SIGNAL / STAGE / CAMERA…每個參數 = 滑桿 + 數值 + 綁定的 CC 徽章。
- **MIDI Learn 動態綁定**：不寫死映射。兩種綁法：①「依序對應」逐一把推桿 / 旋鈕綁到參數；②點某參數 → 轉一下旋鈕即綁；shift+點 = 解綁。綁定存 `localStorage`。
- **時間軸場景（keyframe）**：時間軸上的場景點自動演化參數；播放時在場景間內插，讓「資料 → 系統演化」自己走出劇情。
- **手動覆寫（soft-takeover）**：時間軸驅動參數的同時，演出者一抓實體旋鈕即接管該參數（實體值需先經過畫面值才接手，避免跳值）。
- **nanoPAD2 演奏對應**：打擊墊 → 資料事件（velocity = 強度）；X-Y 觸控板 → 地理探針 / 鏡頭。
- **雙向監看**：底部即時顯示 IN（演奏者 CC / Note）與 OUT（系統查詢 / 視覺事件）。

**MIDI Learn 綁定流程**

```mermaid
flowchart LR
    P["點選參數 進入 Learn"] --> W["等待 CC 輸入"]
    W --> R["轉動推桿 / 旋鈕 收到 CC"]
    R --> B["綁定 參數 ↔ CC 並存檔"]
    B --> RUN["之後該 CC 即時控制此參數"]
    RUN -->|"shift+點參數"| U["解綁"]
```

---

## 6. 系統架構 (System Architecture)

```mermaid
flowchart TB
    subgraph HW["硬體層 Hardware"]
        K["nanoKONTROL2 推桿/旋鈕/按鈕/走帶鍵"]
        P["nanoPAD2 打擊墊 + X-Y 觸控板"]
    end
    subgraph BROWSER["瀏覽器 React App"]
        MIDI["Web MIDI API｜useMIDI()"]
        STORE["狀態層 Zustand｜控制狀態 + 資料狀態"]
        VIZ["視覺層｜D3 / Canvas / R3F"]
        LED["LED 回饋｜output.send()"]
    end
    subgraph PROXY["代理層 Proxy / Serverless"]
        CACHE["正規化 + 快取 + API Key 保護"]
    end
    subgraph DATA["政府開放資料"]
        CWA["中央氣象署 CWA"]
        WRA["水利署"]
        GOV["data.gov.tw / Twinkle Hub"]
    end
    K -->|"MIDI CC/Note"| MIDI
    P -->|"MIDI CC/Note"| MIDI
    MIDI --> STORE
    STORE --> VIZ
    STORE --> LED
    LED -->|"MIDI Out 點燈"| K
    STORE -->|"useGovData"| CACHE
    CACHE --> STORE
    CACHE --> CWA
    CACHE --> WRA
    CACHE --> GOV
```

---

## 7. 資料流 (Data Flow)

```mermaid
sequenceDiagram
    participant U as 使用者
    participant D as MIDI 裝置
    participant R as React App
    participant X as 代理層
    participant G as 政府 API

    Note over R,G: 啟動時載入資料
    R->>X: GET /api/weather
    X->>G: fetch + API Key
    G-->>X: 原始 JSON
    X-->>R: 正規化資料

    loop 即時操作 (每秒上百次)
        U->>D: 推桿 / 敲擊 / 觸控
        D->>R: MIDI 訊息
        R->>R: requestAnimationFrame 統一渲染
        R->>D: LED 回饋 (可選)
    end

    loop 定時輪詢
        R->>X: refetchInterval
        X-->>R: 最新資料
    end
```

---

## 8. 開發技術 (Technology)

基礎框架：**React.js + Vite**（開發快、內建 dev proxy 解 CORS）。狀態：**Zustand**。資料請求：**TanStack Query (React Query)**。視覺層則依需求在下列兩條路線中選擇。**本專案已定案採「路線 B（3D 生成場景）」為主畫面**，路線 A 作為 2D 資料圖表 / HUD 疊層輔助。

### 8.1 路線 A — 資料驅動的 2D 互動【輔助：圖表 / HUD 疊層】
核心概念是「把資料綁到視覺元素上，資料變、畫面跟著變」：
- **D3.js** — 最經典，適合知識圖譜、地圖、自訂圖表。門檻較高但控制力最強。
- **SVG + CSS/JS 動畫** — 向量圖形，無限縮放不失真，適合示意圖、path morphing。
- **Canvas 2D** — 元素數量很多時（上千節點）比 SVG 流暢。
- **GSAP** — 專門做時間軸動畫、進場過渡，常和上面搭配。
- **圖表懶人包**：Chart.js / ECharts / Recharts，不用自己刻。

### 8.2 路線 B — 真正的 3D（WebGL 家族）【★ 本專案主力 · 已定案】
當需要立體場景、光影、相機視角才用：
- **Three.js** — WebGL 的事實標準，做 3D 模型、粒子、地球儀等。
- **React Three Fiber (R3F)** — 用 React 寫 Three.js，元件化。
- **原生 WebGL / WebGPU** — 最底層，效能極限但開發成本高。
- **地理類 3D**：deck.gl / Mapbox GL 適合 3D 地圖與大量地理資料。

### 8.3 技術路線決策

```mermaid
flowchart TD
    Q1{"需要立體場景 / 光影 / 相機視角?"}
    Q1 -->|否| A["路線 A：2D 資料驅動 D3 / SVG / Canvas / GSAP / 圖表庫"]
    Q1 -->|是| Q2{"大量地理資料?"}
    Q2 -->|是| B1["deck.gl / Mapbox GL"]
    Q2 -->|否| B2["Three.js / React Three Fiber"]
    A --> AUX["輔助層：2D 圖表 / HUD 疊層"]
    B1 --> REC2["地理資料量大時採用"]
    B2 --> REC["★ 本專案主力（已定案）：R3F 生成場景"]
```

### 8.4 React 實作三大關鍵決定
1. **MIDI 訊息不要直接 setState**：推桿一拖噴出數十筆訊息，逐筆 setState 會掉幀。改用 `useRef` 暫存 + `requestAnimationFrame` 統一渲染，或 Zustand transient 更新。
2. **控制狀態與資料狀態分家**：前者每秒上百次、後者數分鐘一次，混在一起互相拖累。
3. **輪詢頻率對齊資料源**：氣象站 10 分、預報 6 時、水庫 1 時；用 React Query `refetchInterval` 設對。

---

## 9. 專案結構 (Project Structure)

```text
IXD2026/
├─ README.md
├─ SPEC.md                  # 本規格文件
├─ .gitignore
├─ index.html
├─ package.json
├─ vite.config.js           # 含 dev proxy 解 CORS
├─ api/                      # serverless / proxy（選用）
│  └─ weather.js
├─ public/
└─ src/
   ├─ main.jsx
   ├─ App.jsx               # 左右分欄版面：<Visualizer/> + <Sidebar/>
   ├─ hooks/
   │  ├─ useMIDI.js         # Web MIDI 連線 + 訊息解析
   │  └─ useGovData.js      # React Query 資料輪詢
   ├─ store/
   │  └─ useControlStore.js # Zustand 控制狀態
   ├─ midi/
   │  ├─ mapping.js         # CC/Note → 動作映射表
   │  └─ led.js             # LED 回饋
   ├─ ui/                   # 右欄控制面板
   │  ├─ Sidebar.jsx        # 控制面板容器
   │  ├─ DevicePanel.jsx    # 裝置選擇 + 連線狀態 + 角色指派
   │  ├─ ControlMirror.jsx  # 控制鏡像 / 無硬體螢幕控制
   │  └─ Timeline.jsx       # 時間軸 + 走帶控制
   ├─ viz/
   │  ├─ WeatherMixer.jsx   # 路線 A：D3 / Canvas
   │  └─ Globe3D.jsx        # 路線 B：R3F（選用）
   └─ data/
      └─ normalize.js       # 資料正規化
```

> 以上是規劃期的結構草圖。實際的專案結構（`src/lib`、`src/services`、`src/ui/devices`、`scripts/gov`、診斷頁 `src/DiagnosticsApp.jsx`、錯誤邊界 `src/ErrorBoundary.jsx`、`vite.config.js` 的 version.json 外掛…）見 README〈專案結構〉。

---

## 10. 開發里程碑 (Milestones)

```mermaid
gantt
    title IXD2026 開發里程碑
    dateFormat YYYY-MM-DD
    section 基礎建設
    MIDI 偵測器 + 映射表實測   :m1, 2026-09-22, 5d
    資料代理層 + 正規化        :m2, after m1, 4d
    section 核心功能
    useMIDI / useGovData hooks :m3, after m2, 5d
    2D 視覺層 v1 (路線 A)      :m4, after m3, 7d
    section 進階
    LED 回饋迴路              :m5, after m4, 3d
    3D 演出層 (路線 B 選用)    :m6, after m4, 7d
    section 收尾
    整合測試 + 現場展示        :m7, after m5, 5d
```

---

## 11. 風險與對策 (Risks)

| 風險 | 影響 | 對策 |
|---|---|---|
| 政府 API CORS 阻擋 | 前端無法直接取資料 | Vite dev proxy（開發）+ serverless（上線） |
| API Key 外洩 | 帳號被濫用 | Key 只放代理層環境變數，前端不接觸 |
| MIDI 高頻訊息造成掉幀 | 體驗卡頓 | rAF 統一渲染 + 控制/資料狀態分離 |
| 實體與畫面數值跳值 | 誤操作 | soft-takeover（pick-up）+ 螢幕鏡像 |
| 瀏覽器相容性 | Safari/FF 行為差異 | 主推 Chrome/Edge 展示；偵測 + 提示 |
| Pad 放開送 velocity=0 | 誤判觸發未結束 | 同時判 `0x80` 與 `0x90 velocity=0` |
| 展場整天無人看管，畫面出錯或卡死沒人發現 | 展場中斷 | ErrorBoundary 倒數重載（退避 + 熔斷）、WebGL 遺失復原、渲染看門狗、版本與資料自動更新、每日重載；「裝置 → 維運」可查看（見 README〈展場防呆與維運〉） |
| 空品資料是模型資料而非觀測值 | 被誤當成官方空品 | 資料卡、資料看板、日誌、導覽字幕一律標示「模型資料」；資料檔 `air.note` 寫明；日後有環境部 key 再接政府觀測值 |
| 相機 / 麥克風 / 語音旁白 / iOS Safari 等真機行為無法在開發環境驗證 | 到現場才發現問題 | 裝置診斷頁逐項檢查 + 真機驗證日，並在 README〈驗證狀態〉如實列出尚未驗證的項目 |

---

## 12. 參考資源 (References)

- Web MIDI API — MDN Web Docs
- KORG nanoKONTROL2 / nanoPAD2 使用手冊、KORG Kontrol Editor
- Twinkle Hub 開放資料：https://hub.twinkleai.tw/zh-TW
- 中央氣象署開放資料平台、水利署防災資訊服務網
- D3.js / Three.js / React Three Fiber / deck.gl 官方文件
