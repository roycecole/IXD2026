// 參數登錄表：分組 + 預設值。每個參數皆為 0..1，可被 MIDI Learn 綁定 CC。
// 主畫面（Google Earth 球體）由其中一部分參數即時驅動；其餘保留給資料層。

export const GROUPS = [
  { id: 'GLOBE', label: 'GLOBE', params: [
    { id: 'spin',       label: '自轉速度', value: 0.30 },
    { id: 'globeScale', label: '球體大小', value: 0.50 },
    { id: 'tilt',       label: '地軸傾角', value: 0.40 },
    { id: 'atmosphere', label: '大氣輝光', value: 0.55 },
  ]},
  { id: 'DATA', label: 'DATA', params: [
    { id: 'pointDensity', label: '資料點密度', value: 0.70 },
    { id: 'pointGlow',    label: '資料點輝度', value: 0.60 },
    { id: 'heat',         label: '熱度色偏',   value: 0.35 },
  ]},
  { id: 'WEATHER', label: 'WEATHER', params: [
    { id: 'tempGain', label: '溫度增益', value: 0.60 },
    { id: 'rain',     label: '降雨強度', value: 0.30 },
    { id: 'wind',     label: '風 · 擴散', value: 0.50 },
  ]},
  { id: 'HYDRO', label: 'HYDRO', params: [
    { id: 'level',  label: '水庫水位', value: 0.80 },
    { id: 'inflow', label: '進流量',   value: 0.45 },
  ]},
  { id: 'SIGNAL', label: 'SIGNAL', params: [
    { id: 'glow',   label: '全域輝度', value: 0.70 },
    { id: 'glitch', label: '失真',     value: 0.00 },
    { id: 'master', label: '總輸出',   value: 1.00 },
  ]},
  { id: 'STAGE', label: 'STAGE', params: [
    { id: 'worldLight', label: '世界光',   value: 0.70 },
    { id: 'stars',      label: '星空密度', value: 0.60 },
  ]},
  { id: 'CAMERA', label: 'CAMERA', params: [
    { id: 'zoom',      label: '鏡頭距離', value: 0.50 },
    { id: 'camHeight', label: '視角高度', value: 0.50 },
  ]},
]

// 攤平：paramId -> { id, label, value, group }
export const PARAMS = {}
GROUPS.forEach((g) => g.params.forEach((p) => { PARAMS[p.id] = { ...p, group: g.id } }))
export const PARAM_ORDER = Object.keys(PARAMS)

// 預設建議綁定（nanoKONTROL2 出廠：推桿 CC0-7、旋鈕 CC16-23）。可經 MIDI Learn 重綁。
// 8 個「旋鈕」→ 視覺效果（本次重點）；8 個「推桿」→ 資料混音層。
export const DEFAULT_BINDINGS = {
  // 推桿 fader CC0-7 → 資料混音
  0: 'tempGain', 1: 'rain', 2: 'wind', 3: 'level', 4: 'inflow', 5: 'pointDensity', 6: 'heat', 7: 'glow',
  // 旋鈕 knob CC16-23 → 視覺效果
  16: 'spin', 17: 'globeScale', 18: 'zoom', 19: 'worldLight', 20: 'stars', 21: 'atmosphere', 22: 'pointGlow', 23: 'tilt',
}
