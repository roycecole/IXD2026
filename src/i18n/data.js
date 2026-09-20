// 資料層文字（純函式，可在 Node 測試）：政府開放資料裡的名稱與詞彙 → 「當下語系」文字。
// 中文語系一律原樣回傳（不改變既有輸出）；英文語系查 src/i18n/en/data.js。
//   nameText(zh)          水庫 / 海況選項 / 流域 / 縣市 / 序列標籤與單位 / 來源簡稱；認得「甲（乙）」與「甲 · 乙」的組合詞
//   weatherText(zh)       CWA 天氣現象詞（含「多雲午後短暫雷陣雨」這類組合詞）→ "Cloudy with brief afternoon thundershowers"
//   lunarLabelText(zh)    '農曆八月初十' → 'Lunar 8/10'
//   lunarDayText(zh)      不含「農曆」前綴的部分（'八月初十' / '8/10'），給「農曆 {lunar}」這類句型用
//   tideRangeText(range)  潮差（'小' 或 '小潮'）→ '小潮' / 'neap tide'
// 注意：本檔的中文只能出現在 regex 字面量裡（i18n 掃描器不算）。名稱的中文↔英文對照在 ./en/data.js（字典，動態載入）；
// 組詞用的詞素表（天氣 / 農曆）在 ./data-tables.js——不能靜態 import ./en/data.js：i18n/en/ 底下都是動態載入的英文字典 chunk，
// 靜態 import 會讓中文使用者也得下載整包英文字典（見 vite.config.js 的 manualChunk）。data-tables.js 與 ./en/data.js 的同名匯出由 i18n.test.mjs 核對一致。
import { t, getLocale, getEnDict } from './index.js'
import { WX_SKY, WX_MOD, WX_NOUN, LUNAR_MONTH, LUNAR_DAY } from './data-tables.js'

const HAN = /[㐀-鿿豈-﫿]/
const isEn = () => getLocale() === 'en'
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s)
const byLenDesc = (obj) => Object.keys(obj).sort((a, b) => b.length - a.length)

// ---- 名稱 ----
export function nameText(zh) {
  if (typeof zh !== 'string' || !zh || !isEn() || !HAN.test(zh)) return zh
  if (zh in getEnDict()) return t(zh)
  const paren = /^(.+?)（(.+)）$/.exec(zh)                                   // 揚塵（雲林縣）
  if (paren) return `${nameText(paren[1])} (${nameText(paren[2])})`
  if (zh.includes(' · ')) return zh.split(' · ').map(nameText).join(' · ')    // 月亮 · 花蓮縣 / 水利署 · CWA潮汐 · Open-Meteo
  return t(zh)                                                                // 不認得 → 退回原文（DEV 主控台會記缺譯）
}

// ---- 天氣現象詞 ----
const SKY_RE = /^(晴|多雲|陰)(?:時(晴|多雲|陰))?天?(.*)$/
const MOD_RE = new RegExp('^(' + byLenDesc(WX_MOD).join('|') + ')')
const SEP_RE = /(或|及|、|和)/
const sepEn = (sep) => (/^或$/.test(sep) ? ' or ' : ' and ')

function parsePrecipSeg(seg) {
  let s = seg
  const mods = []
  for (let m = MOD_RE.exec(s); m; m = MOD_RE.exec(s)) { mods.push(WX_MOD[m[1]]); s = s.slice(m[1].length) }
  const noun = WX_NOUN[s]
  if (!noun) return null
  return [...mods].sort((a, b) => a[0] - b[0]).map((x) => x[1]).filter(Boolean).concat(noun).join(' ')
}

function parsePrecip(rest) {
  const parts = rest.split(SEP_RE)                                            // 段落與連接詞交錯：[seg, sep, seg…]
  let out = ''
  for (let i = 0; i < parts.length; i++) {
    if (i % 2) { out += sepEn(parts[i]); continue }
    const seg = parsePrecipSeg(parts[i])
    if (seg == null) return null
    out += seg
  }
  return out
}

export function weatherText(zh) {
  if (typeof zh !== 'string' || !zh || !isEn() || !HAN.test(zh)) return zh
  let sky = '', sky2 = '', rest = zh
  const m = SKY_RE.exec(zh)
  if (m) { sky = WX_SKY[m[1]]; sky2 = m[2] ? WX_SKY[m[2]] : ''; rest = m[3] }
  let precip = ''
  if (rest) { precip = parsePrecip(rest); if (precip == null) return zh }      // 完全不認得 → 原文
  if (!sky && !precip) return zh
  if (!sky) return cap(precip)
  let out = cap(sky)
  if (sky2) out += `, partly ${sky2}`
  if (precip) out += ` with ${precip}`
  return out
}

// ---- 農曆 ----
const LUNAR_RE = /^農曆\s*(閏)?(.+?)月\s*(.+)$/
export function lunarLabelText(zh) {
  if (typeof zh !== 'string' || !zh || !isEn() || !HAN.test(zh)) return zh
  const m = LUNAR_RE.exec(zh)
  if (m) {
    const mo = LUNAR_MONTH[m[2]], dy = LUNAR_DAY[m[3]]
    if (mo && dy) return `Lunar ${mo}/${dy}${m[1] ? ' (leap month)' : ''}`
  }
  return zh
}
// 「農曆 {lunar}」句型用：中文 '八月初十'（去掉「農曆」二字，與既有輸出逐字相同）、英文 '8/10'；沒有資料 → '—'
export function lunarDayText(zh) {
  if (!zh) return '—'
  if (!isEn()) return zh.replace(/農曆/, '')
  const out = lunarLabelText(zh)
  return out === zh ? zh.replace(/農曆/, '') : out.replace(/^Lunar\s*/, '')
}

// ---- 潮差 ----
// '小'（CWA 原值）或 '小潮' → 中文 '小潮'、英文 'neap tide'
export function tideRangeText(range) {
  const r = String(range == null ? '' : range).replace(/潮$/, '')
  return t('{range}潮', { range: r })
}
