// ocean.json 的「形狀」：新增選項的定義、鍵順序、說明文字。
// fetch-ocean-data.mjs（CI 每次刷新）與 bake-static-data.mjs（一次性烘焙）共用，
// 讓兩支腳本輸出的鍵順序與文字一致，不會互相改來改去而在 git 裡留下無謂的 diff。
import { dustParams } from './dust.mjs'
import { MOON_PARAMS } from './moon.mjs'

export const OPTION_KEYS = ['id', 'name', 'region', 'level', 'params', 'kind', 'birds', 'fish', 'series']
export const TOP_KEYS = [
  'source', 'sourceShort', 'fetchedAt', 'station', 'weather', 'defaultOption', 'options', 'mapping',
  'rivers', 'riversNote', 'birdsNote', 'dust', 'stations', 'moon',
]

const orderBy = (o, keys) => {
  const out = {}
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k]
  for (const k of Object.keys(o)) if (!(k in out)) out[k] = o[k] // 未知鍵保留（放最後），不丟資料
  return out
}
export const orderOption = (o) => orderBy(o, OPTION_KEYS)
export const orderTop = (o) => orderBy(o, TOP_KEYS)

// 新增的兩個海況選項（放在既有選項之後）。params 之後由 CI 依資料重算（揚塵）或固定（月亮）。
export const GOV_OPTIONS = [
  { id: 'dust-yunlin', name: '揚塵 · 雲林縣', region: '中', level: 0, params: dustParams({}), kind: 'dust' },
  { id: 'moon-hualien', name: '月亮 · 花蓮', region: '東', level: 0, params: { ...MOON_PARAMS }, kind: 'moon' },
]
export function ensureGovOptions(options) {
  for (const def of GOV_OPTIONS) if (!options.some((o) => o.id === def.id)) options.push(orderOption(structuredClone(def)))
  return options
}

// ── 說明文字 ──────────────────────────────────────────────────────────────
export const SOURCE_LABEL = {
  dust: '水利署 IoW 揚塵',
  stations: '水利署河川流量測站',
  fish: '水利署魚類調查',
  moon: 'CWA 月出月沒',
}

// source：在結尾括號（授權說明）之前補上資料集標籤；已含者不重複
export function withSourceParts(source, labels) {
  const missing = labels.filter((l) => !source.includes(l))
  if (!missing.length) return source
  const i = source.indexOf('（')
  return i < 0 ? [source, ...missing].join(' + ') : source.slice(0, i) + ' + ' + missing.join(' + ') + source.slice(i)
}

export const BASE_MAPPING = '水庫水位%→海水高度（滿庫=滿球、溢流） · 風速→洋流 · 晴雨→清澈 · 氣溫→水母 · 進流量時序→資料播放'
export const MAPPING_ADDITIONS = [
  '魚類調查→魚群',
  '揚塵（雲林）：PM10→清澈度／魚／垃圾、風速→洋流、氣溫→水母',
  '月出月沒時刻→月亮（花蓮）',
  '河川流量測站座標→台灣島形點雲',
]
export const appendParts = (text, parts, sep = ' · ') => [text, ...parts.filter((p) => !text.includes(p))].join(sep)

// birdsNote：保留既有文字，於固定標記後接上新段落（重跑時先切掉舊段落再接，冪等）
export const BIRDS_NOTE_MARKER = '【逐年與魚類】'
export const BIRDS_NOTE_APPENDIX =
  'yearly＝各調查年度的相異物種數 s 與總隻次 n（該年有效紀錄≥90 筆才收；n 為 null＝該年 number 全空，例如花蓮溪 2017–2019 未記數量，故其 count 只含 2002 年）；各流域僅有 2–5 個調查年度，非連續時間序列。' +
  '魚類調查（水利署，data.gov.tw 25799，2001–2019）fish 結構相同，月／年需≥40 筆，同樣僅部分月份與年度有調查，近似單一年份快照。' +
  '物種以正規化中文名計（已處理字面「NULL」與別名順序），number=0 的訪談紀錄不算觀測。' +
  '對應：翡翠／石門→淡水河、曾文／南化→曾文溪、花蓮外海／月亮→花蓮溪、揚塵→濁水溪、德基→大甲溪。'
export function withBirdsNoteAppendix(note, appendix) {
  const i = note.indexOf(BIRDS_NOTE_MARKER)
  const head = (i < 0 ? note : note.slice(0, i)).trimEnd()
  return head + ' ' + BIRDS_NOTE_MARKER + appendix
}
