// 參數登錄表：分組 + 預設值（皆 0..1），可被 MIDI Learn 綁定 CC。
// 海洋主題：nanoKONTROL2 推桿/旋鈕控制連續參數；Solo 按鈕觸發動作（見 ACTION_BINDINGS）。

export const GROUPS = [
  { id: 'OCEAN', label: 'OCEAN', params: [
    { id: 'seaLevel', label: '海水高度', value: 0.55 },
    { id: 'current',  label: '洋流速度', value: 0.45 },
    { id: 'clarity',  label: '海水清澈', value: 0.60 },
    { id: 'flowX',    label: '洋流向 X', value: 0.50 },
    { id: 'flowY',    label: '洋流向 Y', value: 0.50 },
  ]},
  { id: 'LIFE', label: 'LIFE', params: [
    { id: 'jellyCount', label: '水母數量', value: 0.50 },
    { id: 'fishCount',  label: '魚群數量', value: 0.55 },
    { id: 'swimSpeed',  label: '游動速度', value: 0.50 },
  ]},
  { id: 'IMPACT', label: 'IMPACT', params: [
    { id: 'trashCount', label: '垃圾數量', value: 0.25 },
  ]},
  { id: 'VIEW', label: 'VIEW', params: [
    { id: 'spin', label: '旋轉海洋球', value: 0.30 },
    { id: 'zoom', label: '視角遠近',   value: 0.50 },
    { id: 'glow', label: '夢幻輝光',   value: 0.60 },
    { id: 'hue',  label: '海色色相',   value: 0.50 }, // 場景配色：0 墨綠 ← 0.5 湛藍 → 1 紫粉
  ]},
]

export const PARAMS = {}
GROUPS.forEach((g) => g.params.forEach((p) => { PARAMS[p.id] = { ...p, group: g.id } }))
export const PARAM_ORDER = Object.keys(PARAMS)

// 推桿 Slider 1-6 (CC0-5) + 旋鈕 Knob 1-2 (CC16-17)，依使用者規格。可經 MIDI Learn 重綁。
export const DEFAULT_BINDINGS = {
  0: 'seaLevel',   // Slider 1 海水高度
  1: 'current',    // Slider 2 洋流速度
  2: 'jellyCount', // Slider 3 水母數量
  3: 'fishCount',  // Slider 4 魚群數量
  4: 'trashCount', // Slider 5 垃圾數量
  5: 'clarity',    // Slider 6 海水清澈
  16: 'spin',      // Knob 1 旋轉海洋球
  17: 'swimSpeed', // Knob 2 生物游動速度
  18: 'zoom',
  19: 'glow',
  // nanoPAD2 X-Y 觸控板：X（出廠 Pitch Bend → 偽 CC128）→ 洋流向 X。
  // Y 出廠常為 CC1，與 nanoKONTROL2 推桿2(CC1=洋流速度) 撞號 → 預設不綁，
  // 需要時點「洋流向 Y」→ 滑觸控板 Y 即 Learn 綁定。
  128: 'flowX',
}

// 按鈕動作綁定（nanoKONTROL2 出廠 CC）。按下 (value>0.5) 觸發。
export const ACTION_BINDINGS = {
  32: 'spawnWhale',      // Solo 1 鯨魚出現
  33: 'spawnDolphin',    // Solo 2 海豚出現
  34: 'spawnTurtle',     // Solo 3 海龜出現
  35: 'clearTrash',      // Solo 4 清除垃圾
  // 走帶鍵 → 錄製/播放（演出不碰滑鼠）
  41: 'transportPlay',   // ▶ 播放/停止切換
  42: 'transportStop',   // ■ 停止（錄製或播放）
  45: 'transportRecord', // ● 錄製開始/結束切換
  46: 'clearRec',        // Cycle 清除錄製
}
