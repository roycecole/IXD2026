// 資料層 i18n 測試：describeBoard / describeForLog / formatHud / moonPhaseName / store 日誌 / 資料名稱 helper。
// 1. 中文輸出「逐字不變」：合成資料的 golden 字串（由改造前的程式碼產生）。
// 2. 英文輸出不含中文（ocean.json 每個選項 × 各時刻 × 各月份；測站 / 河川專有名詞除外），並釘住幾組英文措辭。
// 3. 語系切換不殘留：zh → en → zh 輸出與原本相同。
// 執行：node --test src/lib/i18n-data.test.mjs
process.env.TZ = 'Asia/Taipei'   // 月齡與時刻計算吃本地時區：固定它，golden 字串才不會隨執行環境變動
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadEnDict, HAN } from '../../scripts/i18n-check.mjs'
import { registerEn, setLocale, getLocale } from '../i18n/index.js'
import { weatherText, lunarLabelText, lunarDayText, tideRangeText, nameText } from '../i18n/data.js'
import { describeBoard, describeForLog } from './describe.js'
import { seriesFromOption, seriesFromSurvey, seriesFromDust, seriesFromMoon, formatHud } from './series.js'
import { moonPhaseName } from './moon.js'

const { dict } = await loadEnDict()
registerEn(dict)
const real = JSON.parse(readFileSync(new URL('../../public/data/ocean.json', import.meta.url), 'utf8'))

// 英文語系下執行，結束一定切回中文
const inEn = (fn) => { setLocale('en'); try { return fn() } finally { setLocale('zh') } }

// ---- 合成資料（不受 ocean.json 每日更新影響）----
// 合成資料（不依賴 ocean.json 的每日變動）：涵蓋各分支，測試與 golden 產生器共用
const T = (h) => `2026-09-20T${String(h).padStart(2, '0')}:00:00+08:00`
const hist = (rows) => rows.map(([t, pm10, wind, temp, rh]) => ({ t, pm10, wind, temp, rh }))
const days = [['2026-09-19', '12:56', 121, '18:12', 38, 'S', '23:29', 240], ['2026-09-20', '13:44', 120, '19:03', 39, 'S', '', null], ['2026-09-21', '', null, '19:52', 40, 'N', '00:22', 241], ['2026-09-22', '14:30', 119, '', null, '', '01:10', 242]]
const monthly = [null, 84, null, null, 82, null, null, 68, null, 90, null, null]
const birds = { basin: '曾文溪流域', species: 100, monthly, yearly: [{ y: 2004, s: 60, n: 100 }, { y: 2014, s: 90, n: null }, { y: 2015, s: 75, n: 300 }] }
const fish = { basin: '南化水庫樣點（曾文溪流域）', species: 40, monthly: [null, 30, null, null, 28, null, null, null, null, 33, null, null], yearly: [{ y: 2004, s: 20, n: 50 }, { y: 2006, s: 31, n: 80 }] }
const govBase = {
  weather: { weather: '多雲午後短暫雷陣雨', airTemp: 25.5, humidity: 70, windSpeed: 3.2 },
  rivers: [{ name: '甲橋', river: '甲溪', level: 1, pct: 0.4 }, { name: '乙橋', river: '乙溪', level: 2, pct: 0.7 }],
  stations: { total: 188, active: 100, list: [{ n: '景美', r: '景美溪', x: 0.1, y: 0.2, s: 1 }] },
  dust: { county: '雲林縣', stations: [{ pm10: 30, wind: 3, temp: 28, rh: 70, t: T(9) }, { pm10: 50, wind: 5, temp: 30, rh: 60, t: T(10) }], history: hist([[T(9), 30, 3, 28, 70], [T(12), 80, 6, 30, 65]]) },
  moon: { county: '花蓮縣', from: '2026-09-19', to: '2026-09-22', days },
}
const tideOpt = { id: 'hualien-tide', name: '花蓮外海', kind: 'tide', level: 0, params: { seaLevel: 0.7, current: 0.3, clarity: 0.6, trashCount: 0.2 }, birds, fish,
  series: { label: '潮位', unit: 'cm', date: '2026-09-20', target: 'seaLevel', lunar: '2026-08-10', lunarLabel: '農曆八月初十', range: '小',
    points: Array.from({ length: 24 }, (_, h) => ({ h, v: 100 + Math.round(60 * Math.sin(h / 3.8)) })), events: [{ h: 8.3, v: 119, type: '乾潮' }, { h: 15.92, v: 162, type: '滿潮' }, { h: 19.65, v: 156, type: '乾潮' }] } }
const resOpt = { id: 'zengwen', name: '曾文水庫', level: 100, params: { seaLevel: 1, current: 0.2, clarity: 0.5, trashCount: 0.1 }, birds, fish,
  series: { label: '進流量', unit: 'm³/s', date: '2026-09-19', target: 'current', points: [{ h: 5, v: 33.4 }, { h: 6, v: 38.1 }, { h: 7, v: 9.9 }] } }
const resLowOpt = { id: 'feitsui', name: '翡翠水庫', level: 77.3, params: { seaLevel: 0.77, current: 0.06, clarity: 0.77, trashCount: 0.14 } }
const dustOpt = { id: 'dust-yunlin', name: '揚塵 · 雲林縣', kind: 'dust', level: 40, params: { clarity: 0.77, trashCount: 0.15, current: 0.45 }, birds, fish }
const moonOpt = { id: 'moon-hualien', name: '月亮 · 花蓮', kind: 'moon', level: 0, params: { seaLevel: 0.6 }, birds, fish }
const nowA = new Date(2026, 8, 20, 16, 30)   // 有月出月沒資料、月亮在天上
const nowB = new Date(2026, 8, 20, 10, 0)    // 月亮還沒升
const nowC = new Date(2027, 5, 1, 12, 0)     // 資料窗之外
const dustInvalid = { county: '雲林縣', stations: [{ pm10: null, wind: null, temp: null, rh: null }], history: [] }
const scenarios = [
  ['tide@A', () => [govBase, tideOpt, { now: nowA }]],
  ['tide@A month0', () => [govBase, tideOpt, { now: nowA, month: 0 }]],
  ['tide@A month1', () => [govBase, tideOpt, { now: nowA, month: 1 }]],
  ['tide@A month5', () => [govBase, tideOpt, { now: nowA, month: 5 }]],
  ['res-full@B', () => [govBase, resOpt, { now: nowB }]],
  ['res-low@B', () => [{ ...govBase, weather: { weather: '晴', airTemp: 29.2, humidity: 83, windSpeed: 0.86 }, rivers: [], stations: null }, resLowOpt, { now: nowB }]],
  ['dust-valid@A', () => [govBase, dustOpt, { now: nowA }]],
  ['dust-invalid@A', () => [{ ...govBase, dust: dustInvalid }, dustOpt, { now: nowA }]],
  ['dust-none@A', () => [{ ...govBase, dust: { county: '', stations: [] } }, dustOpt, { now: nowA }]],
  ['moon-in@A', () => [govBase, moonOpt, { now: nowA }]],
  ['moon-in@B', () => [govBase, moonOpt, { now: nowB }]],
  ['moon-stale@C', () => [govBase, moonOpt, { now: nowC }]],
  ['moon-none@A', () => [{ ...govBase, moon: { county: '花蓮縣', days: [] } }, moonOpt, { now: nowA }]],
]

const kvLines = (rows, sep) => rows.map((r) => `${r.k}${sep}${r.v}`)
const runScenario = (name, sep) => { const [g, o, c] = SCENARIOS.get(name)(); return kvLines(describeBoard(g, o, c), sep) }
const SCENARIOS = new Map(scenarios)
const hudOf = (id) => {
  const s = { tide: seriesFromOption(tideOpt), inflow: seriesFromOption(resOpt), birds: seriesFromSurvey(resOpt, 'birds'), fish: seriesFromSurvey(resOpt, 'fish'),
    'dust-pm': seriesFromDust({ county: '雲林縣', history: hist([[T(9), 33.3, 3, 0, 0], [T(12), 60, 5, null, null]]) }),
    'dust-wind': seriesFromDust({ county: '雲林縣', history: hist([[T(9), null, 3.2, 29, 70], [T(12), null, 6, null, 65]]) }),
    moon: seriesFromMoon(govBase.moon) }[id]
  const ctx = id === 'tide' ? { moonName: moonPhaseName(8) } : undefined
  // 調查年表是逐年稠密序列（含「無調查」年，其文字另在 series.test.mjs 驗）：這裡只釘「調查年」的輸出逐字不變
  const pick = id === 'tide' ? [0, 8, 15, 23] : s.points.map((_, i) => i).filter((i) => !s.points[i].gap)
  return pick.map((i) => formatHud(s, s.points[i], ctx))
}

// ---- golden：中文 ----
const ZH_DESCRIBE = {
    "tide@A": [
      "潮汐｜花蓮外海 2026-09-20 · 農曆 八月初十 · 小潮",
      "潮位｜16:00 47cm → 海水高度 0.48",
      "月亮｜上弦月 · 月齡 9.2 天",
      "氣象｜多雲午後短暫雷陣雨 · 25.5°C · 濕度 70% · 風 3.2 m/s → 洋流 0.30",
      "鳥群｜曾文溪流域 9 月 79 種（內插） → 3 群 · 調查 2004–2015",
      "魚群｜南化水庫樣點（曾文溪流域） 9 月 32 種（內插） · 調查 2004–2006",
      "河川｜2 站即時水位 · 平均警戒比 0.55 → 銀河濃度",
      "測站｜河川流量站 188 站（現存 100）→ 星座",
    ],
    "tide@A month1": [
      "潮汐｜花蓮外海 2026-09-20 · 農曆 八月初十 · 小潮",
      "潮位｜16:00 47cm → 海水高度 0.48",
      "月亮｜上弦月 · 月齡 9.2 天",
      "氣象｜多雲午後短暫雷陣雨 · 25.5°C · 濕度 70% · 風 3.2 m/s → 洋流 0.30",
      "鳥群｜曾文溪流域 2 月 84 種 → 3 群 · 調查 2004–2015",
      "魚群｜南化水庫樣點（曾文溪流域） 2 月 30 種 · 調查 2004–2006",
      "河川｜2 站即時水位 · 平均警戒比 0.55 → 銀河濃度",
      "測站｜河川流量站 188 站（現存 100）→ 星座",
    ],
    "res-full@B": [
      "水庫｜曾文水庫 水位 100% → 海水高度 1.00（滿庫溢流）",
      "氣象｜多雲午後短暫雷陣雨 · 25.5°C · 濕度 70% · 風 3.2 m/s → 洋流 0.20",
      "鳥群｜曾文溪流域 9 月 79 種（內插） → 3 群 · 調查 2004–2015",
      "魚群｜南化水庫樣點（曾文溪流域） 9 月 32 種（內插） · 調查 2004–2006",
      "河川｜2 站即時水位 · 平均警戒比 0.55 → 銀河濃度",
      "測站｜河川流量站 188 站（現存 100）→ 星座",
    ],
    "res-low@B": [
      "水庫｜翡翠水庫 水位 77.3% → 海水高度 0.77",
      "氣象｜晴 · 29.2°C · 濕度 83% · 風 0.86 m/s → 洋流 0.06",
    ],
    "dust-valid@A": [
      "揚塵｜雲林縣 2 站 · PM10 40 μg/m³ · 風 4 m/s · 濕度 65% · 29°C",
      "映射｜PM10 ↑ → 海水清澈 0.77 · 垃圾 0.15 · 洋流 0.45",
      "氣象｜多雲午後短暫雷陣雨 · 25.5°C · 濕度 70% · 風 3.2 m/s → 洋流 0.45",
      "鳥群｜曾文溪流域 9 月 79 種（內插） → 3 群 · 調查 2004–2015",
      "魚群｜南化水庫樣點（曾文溪流域） 9 月 32 種（內插） · 調查 2004–2006",
      "河川｜2 站即時水位 · 平均警戒比 0.55 → 銀河濃度",
      "測站｜河川流量站 188 站（現存 100）→ 星座",
    ],
    "dust-invalid@A": [
      "揚塵｜雲林縣 1 站 · PM10 無效",
      "映射｜PM10 感測器回報無效值 → 以預設 40 μg/m³ 示意（清澈 0.77 · 垃圾 0.15）· 風速 → 洋流 0.45",
      "氣象｜多雲午後短暫雷陣雨 · 25.5°C · 濕度 70% · 風 3.2 m/s → 洋流 0.45",
      "鳥群｜曾文溪流域 9 月 79 種（內插） → 3 群 · 調查 2004–2015",
      "魚群｜南化水庫樣點（曾文溪流域） 9 月 32 種（內插） · 調查 2004–2006",
      "河川｜2 站即時水位 · 平均警戒比 0.55 → 銀河濃度",
      "測站｜河川流量站 188 站（現存 100）→ 星座",
    ],
    "dust-none@A": [
      "揚塵｜尚無資料",
      "氣象｜多雲午後短暫雷陣雨 · 25.5°C · 濕度 70% · 風 3.2 m/s → 洋流 0.45",
      "鳥群｜曾文溪流域 9 月 79 種（內插） → 3 群 · 調查 2004–2015",
      "魚群｜南化水庫樣點（曾文溪流域） 9 月 32 種（內插） · 調查 2004–2006",
      "河川｜2 站即時水位 · 平均警戒比 0.55 → 銀河濃度",
      "測站｜河川流量站 188 站（現存 100）→ 星座",
    ],
    "moon-in@A": [
      "月亮｜花蓮縣 今日 · 月出 13:44 · 中天 19:03（仰角 39°S） · 月沒 —",
      "位置｜現在 方位 151° · 仰角 28°（依月出 / 中天 / 月沒時刻內插）",
      "月相｜上弦月 · 月齡 8.5 天 · 資料 2026-09-19 → 2026-09-22（4 天）",
      "氣象｜多雲午後短暫雷陣雨 · 25.5°C · 濕度 70% · 風 3.2 m/s → 洋流 —",
      "鳥群｜曾文溪流域 9 月 79 種（內插） → 3 群 · 調查 2004–2015",
      "魚群｜南化水庫樣點（曾文溪流域） 9 月 32 種（內插） · 調查 2004–2006",
      "河川｜2 站即時水位 · 平均警戒比 0.55 → 銀河濃度",
      "測站｜河川流量站 188 站（現存 100）→ 星座",
    ],
    "moon-in@B": [
      "月亮｜花蓮縣 今日 · 月出 13:44 · 中天 19:03（仰角 39°S） · 月沒 —",
      "位置｜現在在地平線下",
      "月相｜上弦月 · 月齡 8.2 天 · 資料 2026-09-19 → 2026-09-22（4 天）",
      "氣象｜多雲午後短暫雷陣雨 · 25.5°C · 濕度 70% · 風 3.2 m/s → 洋流 —",
      "鳥群｜曾文溪流域 9 月 79 種（內插） → 3 群 · 調查 2004–2015",
      "魚群｜南化水庫樣點（曾文溪流域） 9 月 32 種（內插） · 調查 2004–2006",
      "河川｜2 站即時水位 · 平均警戒比 0.55 → 銀河濃度",
      "測站｜河川流量站 188 站（現存 100）→ 星座",
    ],
    "moon-stale@C": [
      "月亮｜花蓮縣 月出月沒表 2026-09-19 → 2026-09-22 不含今日，改用天文公式",
      "月相｜殘月 · 月齡 26.1 天 · 資料 2026-09-19 → 2026-09-22（4 天）",
      "氣象｜多雲午後短暫雷陣雨 · 25.5°C · 濕度 70% · 風 3.2 m/s → 洋流 —",
      "鳥群｜曾文溪流域 6 月 77 種（內插） → 3 群 · 調查 2004–2015",
      "魚群｜南化水庫樣點（曾文溪流域） 6 月 29 種（內插） · 調查 2004–2006",
      "河川｜2 站即時水位 · 平均警戒比 0.55 → 銀河濃度",
      "測站｜河川流量站 188 站（現存 100）→ 星座",
    ],
    "moon-none@A": [
      "月亮｜尚無資料",
      "氣象｜多雲午後短暫雷陣雨 · 25.5°C · 濕度 70% · 風 3.2 m/s → 洋流 —",
      "鳥群｜曾文溪流域 9 月 79 種（內插） → 3 群 · 調查 2004–2015",
      "魚群｜南化水庫樣點（曾文溪流域） 9 月 32 種（內插） · 調查 2004–2006",
      "河川｜2 站即時水位 · 平均警戒比 0.55 → 銀河濃度",
      "測站｜河川流量站 188 站（現存 100）→ 星座",
    ],
  }
const ZH_HUD = {
    "tide": [
      "花蓮外海 2026-09-20 00:00 · 潮位 100cm · 農曆八月初十 小潮 · {moon}",
      "花蓮外海 2026-09-20 08:00 · 潮位 152cm ↓乾潮 · 農曆八月初十 小潮 · {moon}",
      "花蓮外海 2026-09-20 15:00 · 潮位 57cm · 農曆八月初十 小潮 · {moon}",
      "花蓮外海 2026-09-20 23:00 · 潮位 86cm · 農曆八月初十 小潮 · {moon}",
    ],
    "inflow": [
      "曾文水庫 2026-09-19 05:00 · 進流量 33.4m³/s",
      "曾文水庫 2026-09-19 06:00 · 進流量 38.1m³/s",
      "曾文水庫 2026-09-19 07:00 · 進流量 9.9m³/s",
    ],
    "birds": [
      "曾文溪流域 2004 年 · 鳥種數 60 · 隻次 100",
      "曾文溪流域 2014 年 · 鳥種數 90",
      "曾文溪流域 2015 年 · 鳥種數 75 · 隻次 300",
    ],
    "fish": [
      "南化水庫樣點（曾文溪流域） 2004 年 · 魚種數 20 · 隻次 50",
      "南化水庫樣點（曾文溪流域） 2006 年 · 魚種數 31 · 隻次 80",
    ],
    "dust-pm": [
      "揚塵（雲林縣） 09-20 09:00 · PM10 33.3μg/m³ · 風 3 m/s · 氣溫 0°C · 濕度 0%",
      "揚塵（雲林縣） 09-20 12:00 · PM10 60μg/m³ · 風 5 m/s",
    ],
    "dust-wind": [
      "揚塵（雲林縣） 09-20 09:00 · 風速 3.2m/s · 氣溫 29°C · 濕度 70%",
      "揚塵（雲林縣） 09-20 12:00 · 風速 6m/s · 濕度 65%",
    ],
    "moon": [
      "月亮 · 花蓮縣 2026-09-19 · 月出 12:56 · 中天 18:12（仰角 38°S）· 月沒 23:29",
      "月亮 · 花蓮縣 2026-09-20 · 月出 13:44 · 中天 19:03（仰角 39°S）· 月沒 —",
      "月亮 · 花蓮縣 2026-09-21 · 月出 — · 中天 19:52（仰角 40°N）· 月沒 00:22",
      "月亮 · 花蓮縣 2026-09-22 · 月出 14:30 · 中天 —（仰角 —）· 月沒 01:10",
    ],
  }
const ZH_PHASES = [[0, "新月"], [2, "眉月"], [5, "眉月"], [7.4, "上弦月"], [11, "盈凸月"], [14.8, "滿月"], [18, "虧凸月"], [22.1, "下弦月"], [25.9, "殘月"], [29.5, "新月"]]
const ZH_LOG = [
    "資料 潮汐｜花蓮外海 2026-09-20 · 農曆 八月初十 · 小潮",
    "資料 潮位｜16:00 47cm → 海水高度 0.48",
    "資料 月亮｜上弦月 · 月齡 9.2 天",
    "資料 氣象｜多雲午後短暫雷陣雨 · 25.5°C · 濕度 70% · 風 3.2 m/s → 洋流 0.30",
    "資料 鳥群｜曾文溪流域 9 月 79 種（內插） → 3 群 · 調查 2004–2015",
    "資料 魚群｜南化水庫樣點（曾文溪流域） 9 月 32 種（內插） · 調查 2004–2006",
    "資料 河川｜2 站即時水位 · 平均警戒比 0.55 → 銀河濃度",
    "資料 測站｜河川流量站 188 站（現存 100）→ 星座",
  ]

// ---- 英文措辭（釘住，避免譯文被無意改壞）----
const EN_DESCRIBE = {
    "tide@A": [
      "Tide | Hualien offshore 2026-09-20 · Lunar 8/10 · neap tide",
      "Tide level | 16:00 · 47 cm → sea level 0.48",
      "Moon | First quarter · moon age 9.2 days",
      "Weather | Cloudy with brief afternoon thundershowers · 25.5°C · humidity 70% · wind 3.2 m/s → current 0.30",
      "Bird flocks | Zengwen River basin · Sep: 79 species (interpolated) → 3 flocks · survey 2004–2015",
      "Fish schools | Nanhua Reservoir sites (Zengwen River basin) · Sep: 32 species (interpolated) · survey 2004–2006",
      "Rivers | 2 live water-level gauges · avg. alert ratio 0.55 → Milky Way density",
      "Stations | River flow gauging stations: 188 (100 active) → constellation",
    ],
    "tide@A month1": [
      "Tide | Hualien offshore 2026-09-20 · Lunar 8/10 · neap tide",
      "Tide level | 16:00 · 47 cm → sea level 0.48",
      "Moon | First quarter · moon age 9.2 days",
      "Weather | Cloudy with brief afternoon thundershowers · 25.5°C · humidity 70% · wind 3.2 m/s → current 0.30",
      "Bird flocks | Zengwen River basin · Feb: 84 species → 3 flocks · survey 2004–2015",
      "Fish schools | Nanhua Reservoir sites (Zengwen River basin) · Feb: 30 species · survey 2004–2006",
      "Rivers | 2 live water-level gauges · avg. alert ratio 0.55 → Milky Way density",
      "Stations | River flow gauging stations: 188 (100 active) → constellation",
    ],
    "res-full@B": [
      "Reservoir | Zengwen Reservoir water level 100% → sea level 1.00 (full-reservoir overflow)",
      "Weather | Cloudy with brief afternoon thundershowers · 25.5°C · humidity 70% · wind 3.2 m/s → current 0.20",
      "Bird flocks | Zengwen River basin · Sep: 79 species (interpolated) → 3 flocks · survey 2004–2015",
      "Fish schools | Nanhua Reservoir sites (Zengwen River basin) · Sep: 32 species (interpolated) · survey 2004–2006",
      "Rivers | 2 live water-level gauges · avg. alert ratio 0.55 → Milky Way density",
      "Stations | River flow gauging stations: 188 (100 active) → constellation",
    ],
    "res-low@B": [
      "Reservoir | Feitsui Reservoir water level 77.3% → sea level 0.77",
      "Weather | Clear · 29.2°C · humidity 83% · wind 0.86 m/s → current 0.06",
    ],
    "dust-valid@A": [
      "Dust | Yunlin County · 2 stations · PM10 40 μg/m³ · wind 4 m/s · humidity 65% · 29°C",
      "Mapping | PM10 ↑ → water clarity 0.77 · trash 0.15 · current 0.45",
      "Weather | Cloudy with brief afternoon thundershowers · 25.5°C · humidity 70% · wind 3.2 m/s → current 0.45",
      "Bird flocks | Zengwen River basin · Sep: 79 species (interpolated) → 3 flocks · survey 2004–2015",
      "Fish schools | Nanhua Reservoir sites (Zengwen River basin) · Sep: 32 species (interpolated) · survey 2004–2006",
      "Rivers | 2 live water-level gauges · avg. alert ratio 0.55 → Milky Way density",
      "Stations | River flow gauging stations: 188 (100 active) → constellation",
    ],
    "dust-invalid@A": [
      "Dust | Yunlin County · 1 station · PM10 invalid",
      "Mapping | PM10 sensor reported an invalid value → using a 40 μg/m³ default for illustration (clarity 0.77 · trash 0.15) · wind speed → current 0.45",
      "Weather | Cloudy with brief afternoon thundershowers · 25.5°C · humidity 70% · wind 3.2 m/s → current 0.45",
      "Bird flocks | Zengwen River basin · Sep: 79 species (interpolated) → 3 flocks · survey 2004–2015",
      "Fish schools | Nanhua Reservoir sites (Zengwen River basin) · Sep: 32 species (interpolated) · survey 2004–2006",
      "Rivers | 2 live water-level gauges · avg. alert ratio 0.55 → Milky Way density",
      "Stations | River flow gauging stations: 188 (100 active) → constellation",
    ],
    "dust-none@A": [
      "Dust | No data yet",
      "Weather | Cloudy with brief afternoon thundershowers · 25.5°C · humidity 70% · wind 3.2 m/s → current 0.45",
      "Bird flocks | Zengwen River basin · Sep: 79 species (interpolated) → 3 flocks · survey 2004–2015",
      "Fish schools | Nanhua Reservoir sites (Zengwen River basin) · Sep: 32 species (interpolated) · survey 2004–2006",
      "Rivers | 2 live water-level gauges · avg. alert ratio 0.55 → Milky Way density",
      "Stations | River flow gauging stations: 188 (100 active) → constellation",
    ],
    "moon-in@A": [
      "Moon | Hualien County today · moonrise 13:44 · transit 19:03 (altitude 39°S) · moonset —",
      "Position | Now: azimuth 151° · altitude 28° (interpolated from moonrise / transit / moonset times)",
      "Moon phase | First quarter · moon age 8.5 days · data 2026-09-19 → 2026-09-22 (4 days)",
      "Weather | Cloudy with brief afternoon thundershowers · 25.5°C · humidity 70% · wind 3.2 m/s → current —",
      "Bird flocks | Zengwen River basin · Sep: 79 species (interpolated) → 3 flocks · survey 2004–2015",
      "Fish schools | Nanhua Reservoir sites (Zengwen River basin) · Sep: 32 species (interpolated) · survey 2004–2006",
      "Rivers | 2 live water-level gauges · avg. alert ratio 0.55 → Milky Way density",
      "Stations | River flow gauging stations: 188 (100 active) → constellation",
    ],
    "moon-in@B": [
      "Moon | Hualien County today · moonrise 13:44 · transit 19:03 (altitude 39°S) · moonset —",
      "Position | Below the horizon now",
      "Moon phase | First quarter · moon age 8.2 days · data 2026-09-19 → 2026-09-22 (4 days)",
      "Weather | Cloudy with brief afternoon thundershowers · 25.5°C · humidity 70% · wind 3.2 m/s → current —",
      "Bird flocks | Zengwen River basin · Sep: 79 species (interpolated) → 3 flocks · survey 2004–2015",
      "Fish schools | Nanhua Reservoir sites (Zengwen River basin) · Sep: 32 species (interpolated) · survey 2004–2006",
      "Rivers | 2 live water-level gauges · avg. alert ratio 0.55 → Milky Way density",
      "Stations | River flow gauging stations: 188 (100 active) → constellation",
    ],
    "moon-stale@C": [
      "Moon | Hualien County moonrise & moonset table 2026-09-19 → 2026-09-22 does not cover today; using the astronomical formula",
      "Moon phase | Waning crescent · moon age 26.1 days · data 2026-09-19 → 2026-09-22 (4 days)",
      "Weather | Cloudy with brief afternoon thundershowers · 25.5°C · humidity 70% · wind 3.2 m/s → current —",
      "Bird flocks | Zengwen River basin · Jun: 77 species (interpolated) → 3 flocks · survey 2004–2015",
      "Fish schools | Nanhua Reservoir sites (Zengwen River basin) · Jun: 29 species (interpolated) · survey 2004–2006",
      "Rivers | 2 live water-level gauges · avg. alert ratio 0.55 → Milky Way density",
      "Stations | River flow gauging stations: 188 (100 active) → constellation",
    ],
    "moon-none@A": [
      "Moon | No data yet",
      "Weather | Cloudy with brief afternoon thundershowers · 25.5°C · humidity 70% · wind 3.2 m/s → current —",
      "Bird flocks | Zengwen River basin · Sep: 79 species (interpolated) → 3 flocks · survey 2004–2015",
      "Fish schools | Nanhua Reservoir sites (Zengwen River basin) · Sep: 32 species (interpolated) · survey 2004–2006",
      "Rivers | 2 live water-level gauges · avg. alert ratio 0.55 → Milky Way density",
      "Stations | River flow gauging stations: 188 (100 active) → constellation",
    ],
  }
const EN_HUD = {
    "tide": [
      "Hualien offshore 2026-09-20 00:00 · Tide level 100 cm · Lunar 8/10, neap tide · {moon}",
      "Hualien offshore 2026-09-20 08:00 · Tide level 152 cm ↓ Low tide · Lunar 8/10, neap tide · {moon}",
      "Hualien offshore 2026-09-20 15:00 · Tide level 57 cm · Lunar 8/10, neap tide · {moon}",
      "Hualien offshore 2026-09-20 23:00 · Tide level 86 cm · Lunar 8/10, neap tide · {moon}",
    ],
    "inflow": [
      "Zengwen Reservoir 2026-09-19 05:00 · Inflow 33.4 m³/s",
      "Zengwen Reservoir 2026-09-19 06:00 · Inflow 38.1 m³/s",
      "Zengwen Reservoir 2026-09-19 07:00 · Inflow 9.9 m³/s",
    ],
    "birds": [
      "Zengwen River basin 2004 · Bird species 60 · individuals 100",
      "Zengwen River basin 2014 · Bird species 90",
      "Zengwen River basin 2015 · Bird species 75 · individuals 300",
    ],
    "fish": [
      "Nanhua Reservoir sites (Zengwen River basin) 2004 · Fish species 20 · individuals 50",
      "Nanhua Reservoir sites (Zengwen River basin) 2006 · Fish species 31 · individuals 80",
    ],
    "dust-pm": [
      "Dust (Yunlin County) 09-20 09:00 · PM10 33.3 μg/m³ · wind 3 m/s · temp 0°C · humidity 0%",
      "Dust (Yunlin County) 09-20 12:00 · PM10 60 μg/m³ · wind 5 m/s",
    ],
    "dust-wind": [
      "Dust (Yunlin County) 09-20 09:00 · Wind speed 3.2 m/s · temp 29°C · humidity 70%",
      "Dust (Yunlin County) 09-20 12:00 · Wind speed 6 m/s · humidity 65%",
    ],
    "moon": [
      "Moon · Hualien County 2026-09-19 · moonrise 12:56 · transit 18:12 (altitude 38°S) · moonset 23:29",
      "Moon · Hualien County 2026-09-20 · moonrise 13:44 · transit 19:03 (altitude 39°S) · moonset —",
      "Moon · Hualien County 2026-09-21 · moonrise — · transit 19:52 (altitude 40°N) · moonset 00:22",
      "Moon · Hualien County 2026-09-22 · moonrise 14:30 · transit — (altitude —) · moonset 01:10",
    ],
  }
const EN_PHASES = [[0, "New moon"], [2, "Waxing crescent"], [5, "Waxing crescent"], [7.4, "First quarter"], [11, "Waxing gibbous"], [14.8, "Full moon"], [18, "Waning gibbous"], [22.1, "Last quarter"], [25.9, "Waning crescent"], [29.5, "New moon"]]
const EN_LOG = [
    "DATA Tide | Hualien offshore 2026-09-20 · Lunar 8/10 · neap tide",
    "DATA Tide level | 16:00 · 47 cm → sea level 0.48",
    "DATA Moon | First quarter · moon age 9.2 days",
    "DATA Weather | Cloudy with brief afternoon thundershowers · 25.5°C · humidity 70% · wind 3.2 m/s → current 0.30",
    "DATA Bird flocks | Zengwen River basin · Sep: 79 species (interpolated) → 3 flocks · survey 2004–2015",
    "DATA Fish schools | Nanhua Reservoir sites (Zengwen River basin) · Sep: 32 species (interpolated) · survey 2004–2006",
    "DATA Rivers | 2 live water-level gauges · avg. alert ratio 0.55 → Milky Way density",
    "DATA Stations | River flow gauging stations: 188 (100 active) → constellation",
  ]

test('中文輸出逐字不變：資料看板各分支（潮汐 / 水庫 / 揚塵 / 月亮）與 OUT 日誌行', () => {
  assert.equal(getLocale(), 'zh')
  for (const [name, want] of Object.entries(ZH_DESCRIBE)) assert.deepEqual(runScenario(name, '｜'), want, name)
  const [g, o, c] = SCENARIOS.get('tide@A')()
  assert.deepEqual(describeForLog(g, o, c), ZH_LOG)
})

test('中文輸出逐字不變：資料播放 HUD（潮汐 / 進流量 / 鳥魚調查 / 揚塵 / 月出月沒）與月相名', () => {
  for (const [id, want] of Object.entries(ZH_HUD)) assert.deepEqual(hudOf(id), want.map((s) => s.replace('{moon}', moonPhaseName(8))), id)
  assert.deepEqual([0, 2, 5, 7.4, 11, 14.8, 18, 22.1, 25.9, 29.5].map((a) => [a, moonPhaseName(a)]), ZH_PHASES)
  assert.equal(formatHud(null, {}), '')
  assert.equal(formatHud({ kind: 'x', name: 'n', label: 'l', unit: 'u' }, { h: 3, v: 1 }), 'n 3 · l 1u')
})

test('英文：資料看板 / 日誌行 / HUD / 月相名的措辭', () => inEn(() => {
  for (const [name, want] of Object.entries(EN_DESCRIBE)) assert.deepEqual(runScenario(name, ' | '), want, name)
  const [g, o, c] = SCENARIOS.get('tide@A')()
  assert.deepEqual(describeForLog(g, o, c), EN_LOG)
  const moon = moonPhaseName(8)
  assert.equal(moon, 'First quarter')
  for (const [id, want] of Object.entries(EN_HUD)) assert.deepEqual(hudOf(id), want.map((s) => s.replace('{moon}', moon)), id)
  assert.deepEqual([0, 2, 5, 7.4, 11, 14.8, 18, 22.1, 25.9, 29.5].map((a) => [a, moonPhaseName(a)]), EN_PHASES)
  assert.equal(formatHud({ kind: 'x', name: 'n', label: 'l', unit: 'u' }, { h: 3, v: 1 }), 'n 3 · l 1u')   // 不認得的 kind：名稱 / 標籤沒有譯名就原樣
}))

// ---- ocean.json 全掃：英文不含中文 ----
// 測站 / 河川名是政府資料的專有名詞，英文版維持原文（describeBoard 目前不會印出它們，仍先剔除以防日後加入）
const PROPER = [...(real.stations && real.stations.list ? real.stations.list.flatMap((s) => [s.n, s.r]) : []), ...(real.rivers || []).flatMap((r) => [r.name, r.river])].filter(Boolean)
const stripProper = (s) => PROPER.reduce((acc, n) => acc.split(n).join(''), s)
const NOWS = [new Date(2026, 8, 20, 10, 0), new Date(2026, 8, 20, 16, 30), new Date(2026, 8, 21, 3, 0), new Date(2027, 5, 1, 12, 0), new Date(2026, 0, 15, 8, 5)]
const realVariants = () => {
  const dustNoPm = { county: real.dust.county, stations: [{ pm10: null, wind: 3, temp: 28, rh: 70 }], history: [] }
  return [['real', real], ['dust-invalid', { ...real, dust: dustNoPm }], ['no-weather', { ...real, weather: null }], ['odd-weather', { ...real, weather: { weather: '多雲時晴', airTemp: 25.5, humidity: 70, windSpeed: 3.2 } }]]
}
const collectReal = () => {
  const out = []
  for (const [vn, g] of realVariants()) for (const o of real.options) for (const now of NOWS) for (const month of [undefined, 0, 5, 11]) {
    const ctx = { now, month }
    out.push([`${vn}/${o.id}/${now.toISOString()}/${month}`, [...kvLines(describeBoard(g, o, ctx), '｜'), ...describeForLog(g, o, ctx)]])
  }
  const specs = []
  for (const o of real.options) {
    const s = seriesFromOption(o); if (s) specs.push([o.id, s])
    for (const kind of ['birds', 'fish']) { const sv = seriesFromSurvey(o, kind); if (sv) specs.push([`${o.id}:${kind}`, sv]) }
  }
  const ds = seriesFromDust(real.dust); if (ds) specs.push(['dust', ds])
  const dsw = seriesFromDust({ county: real.dust.county, history: hist([[T(9), null, 3.2, 29, 70], [T(12), null, 6, null, 65]]) }); specs.push(['dust-wind', dsw])
  specs.push(['moon', seriesFromMoon(real.moon)])
  for (const [id, s] of specs) out.push([`hud/${id}`, s.points.map((p) => formatHud(s, p, { moonName: moonPhaseName(3) }))])
  out.push(['phases', Array.from({ length: 60 }, (_, i) => moonPhaseName(i * 0.5))])
  return out
}

test('ocean.json 全掃：英文語系的資料看板 / 日誌 / HUD / 月相名不含中文', () => {
  const bad = []
  let n = 0
  inEn(() => {
    for (const [label, lines] of collectReal()) for (const l of lines) { n++; if (HAN.test(stripProper(l))) bad.push(`${label}: ${l}`) }
  })
  assert.ok(n > 1000, `檢查行數 ${n}`)
  assert.equal(bad.length, 0, `英文輸出仍含中文 ${bad.length} 行：\n${[...new Set(bad)].slice(0, 12).join('\n')}`)
})

test('語系切換不殘留：中文 → 英文 → 中文，輸出與原本逐字相同；英文與中文確實不同', () => {
  const before = collectReal()
  const en = inEn(collectReal)
  const after = collectReal()
  assert.equal(getLocale(), 'zh')
  assert.deepEqual(after, before)
  let diff = 0
  for (let i = 0; i < before.length; i++) if (JSON.stringify(before[i][1]) !== JSON.stringify(en[i][1])) diff++
  assert.equal(diff, before.length, '每一組英文輸出都應與中文不同')
})

// ---- 資料名稱 helper ----
test('nameText：水庫 / 選項 / 流域 / 縣市 / 組合詞；不認得就原文；中文語系原樣', () => {
  const zh = ['翡翠水庫', '揚塵（雲林縣）', '月亮 · 花蓮縣', '水利署 · CWA潮汐 · Open-Meteo', '未知的名稱', '種', '進流量']
  assert.deepEqual(zh.map(nameText), zh)
  inEn(() => {
    assert.equal(nameText('翡翠水庫'), 'Feitsui Reservoir')
    assert.equal(nameText('花蓮外海'), 'Hualien offshore')
    assert.equal(nameText('揚塵 · 雲林縣'), 'Dust · Yunlin County')
    assert.equal(nameText('揚塵（雲林縣）'), 'Dust (Yunlin County)')
    assert.equal(nameText('月亮 · 花蓮縣'), 'Moon · Hualien County')
    assert.equal(nameText('水利署 · CWA潮汐 · Open-Meteo'), 'WRA · CWA tide · Open-Meteo')
    assert.equal(nameText('南化水庫樣點（曾文溪流域）'), 'Nanhua Reservoir sites (Zengwen River basin)')
    assert.equal(nameText('未知的名稱'), '未知的名稱')
    assert.equal(nameText('PM10'), 'PM10')
    assert.equal(nameText(''), '')
    assert.equal(nameText(undefined), undefined)
  })
})

test('weatherText：CWA 天氣詞與組合詞；不認得退回原文；中文原樣', () => {
  const cases = {
    '晴': 'Clear', '多雲': 'Cloudy', '陰': 'Overcast', '短暫陣雨': 'Brief showers', '多雲時晴': 'Cloudy, partly clear', '陰時多雲': 'Overcast, partly cloudy',
    '陰短暫雨': 'Overcast with brief rain', '晴時多雲': 'Clear, partly cloudy', '多雲午後短暫雷陣雨': 'Cloudy with brief afternoon thundershowers', '陰有雨': 'Overcast with rain', '霧': 'Fog',
    '陰有雨或雷雨': 'Overcast with rain or thunderstorms', '晴時多雲有霧': 'Clear, partly cloudy with fog', '多雲時陰短暫陣雨': 'Cloudy, partly overcast with brief showers',
    '局部大雨': 'Local heavy rain', '陰天': 'Overcast', '—': '—', '': '',
  }
  for (const zh of Object.keys(cases)) assert.equal(weatherText(zh), zh, `zh ${zh}`)
  inEn(() => {
    for (const [zh, en] of Object.entries(cases)) assert.equal(weatherText(zh), en, zh)
    assert.equal(weatherText('外星人入侵'), '外星人入侵')          // 完全不認得 → 原文
    assert.equal(weatherText('晴外星人'), '晴外星人')              // 部分認得也不亂拼
  })
})

test('lunarLabelText / lunarDayText：農曆{正…臘}月{初一…三十}（含「廿」寫法）全部可譯；中文原樣', () => {
  const months = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '臘']
  const days = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十', '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十']
  assert.equal(lunarLabelText('農曆八月初十'), '農曆八月初十')
  assert.equal(lunarDayText('農曆八月初十'), '八月初十')
  assert.equal(lunarDayText(''), '—')
  assert.equal(lunarDayText(undefined), '—')
  inEn(() => {
    assert.equal(lunarLabelText('農曆八月初十'), 'Lunar 8/10')
    assert.equal(lunarDayText('農曆八月初十'), '8/10')
    assert.equal(lunarDayText(''), '—')
    assert.equal(lunarLabelText('農曆閏六月十五'), 'Lunar 6/15 (leap month)')
    const seen = new Set()
    months.forEach((m, mi) => days.forEach((d, di) => {
      const out = lunarLabelText(`農曆${m}月${d}`)
      assert.match(out, /^Lunar \d{1,2}\/\d{1,2}$/, `${m}月${d} → ${out}`)
      const [mo, dy] = out.slice(6).split('/').map(Number)
      assert.equal(mo, m === '臘' ? 12 : mi + 1); assert.equal(dy, di + 1)
      seen.add(out)
    }))
    assert.equal(seen.size, 12 * 30)                               // 臘月 = 十二月，不重複計
    assert.equal(lunarLabelText('農曆不存在月初一'), '農曆不存在月初一')
  })
})

test('tideRangeText：CWA 只給單字（大 / 中 / 小 / 長 / 若），顯示補「潮」；中文與既有輸出相同', () => {
  const zhWant = ['大潮', '中潮', '小潮', '長潮', '若潮']
  assert.deepEqual(['大', '中', '小', '長', '若'].map(tideRangeText), zhWant)
  assert.deepEqual(zhWant.map(tideRangeText), zhWant)              // 已帶「潮」也不重複
  inEn(() => {
    assert.deepEqual(['大', '中', '小', '長', '若'].map(tideRangeText), ['spring tide', 'mid tide', 'neap tide', 'long tide', 'young tide'])
    assert.deepEqual(zhWant.map(tideRangeText), ['spring tide', 'mid tide', 'neap tide', 'long tide', 'young tide'])
  })
})

// ---- store 日誌 ----
const STORE_ZH = {
    "overlays / CC / note": [
      "out:畫面資訊面板：隱藏",
      "out:畫面資訊面板：顯示",
      "in:CC 99 = 64（未綁定）",
      "in:Note 36 vel 102 → 事件",
      "out:/viz pad note=36 power=0.80",
    ],
    "record / actions": [
      "out:● 開始錄製",
      "out:■ 錄製結束（16 事件）",
      "out:▶ 播放錄製",
      "out:⟲ 已清除錄製",
      "out:鯨魚出現",
      "out:海豚出現",
      "out:海龜出現",
      "out:清除垃圾 → 淨化波",
    ],
    "apply sea": [
      "out:套用海況：曾文水庫",
      "out:鳥群 · 曾文溪流域 9 月 79 種（內插） → 鳥群數量 0.60（3 群）",
      "out:套用海況：花蓮外海",
      "out:鳥群 · 曾文溪流域 9 月 79 種（內插） → 鳥群數量 0.60（3 群）",
      "out:套用海況：揚塵 · 雲林縣",
      "out:鳥群 · 曾文溪流域 9 月 79 種（內插） → 鳥群數量 0.60（3 群）",
      "out:套用海況：月亮 · 花蓮",
      "out:鳥群 · 曾文溪流域 9 月 79 種（內插） → 鳥群數量 0.60（3 群）",
    ],
    "survey": [
      "out:鳥群 · 曾文溪流域 9 月 79 種（內插） → 鳥群數量 0.60（3 群）",
      "out:魚群 · 南化水庫樣點（曾文溪流域） 9 月 32 種（內插） → 魚群數量 0.61",
      "out:鳥群 · 曾文溪流域 2 月 84 種 → 鳥群數量 0.60（3 群）",
      "out:鳥群 · 曾文溪流域 9 月 79 種（內插） → 鳥群數量 0.60（3 群）",
    ],
    "play series": [
      "out:▶ 播放錄製",
      "out:▶ 資料播放：花蓮外海 2026-09-20 潮位（24 筆，cm）",
      "out:▶ 播放錄製",
      "out:▶ 資料播放：曾文水庫 2026-09-19 進流量（3 筆，m³/s）",
      "out:▶ 播放錄製",
      "out:▶ 資料播放：曾文溪流域 2004–2015 調查年表 鳥種數（12 筆，種）",
      "out:▶ 播放錄製",
      "out:▶ 資料播放：南化水庫樣點（曾文溪流域） 2004–2006 調查年表 魚種數（3 筆，種）",
      "out:▶ 播放錄製",
      "out:▶ 資料播放：揚塵（雲林縣） 09-20 09:00 → 09-20 12:00 PM10（2 筆，μg/m³）",
      "out:▶ 播放錄製",
      "out:▶ 資料播放：月亮 · 花蓮縣 2026-09-19 → 2026-09-22 中天仰角（4 筆，°）",
    ],
    "markers": [
      "out:Marker 快照 #1（共 1 組）",
      "out:Marker 快照 #2（共 2 組）",
      "out:Marker ◀ 快照 #1",
      "out:Marker ▶ 快照 #2",
    ],
  }
const STORE_EN = {
    "overlays / CC / note": [
      "out:Info panels hidden",
      "out:Info panels shown",
      "in:CC 99 = 64 (unbound)",
      "in:Note 36 vel 102 → event",
      "out:/viz pad note=36 power=0.80",
    ],
    "record / actions": [
      "out:● Recording",
      "out:■ Recording stopped (16 events)",
      "out:▶ Playing recording",
      "out:⟲ Recording cleared",
      "out:Whale appears",
      "out:Dolphin appears",
      "out:Turtle appears",
      "out:Trash cleared → purify wave",
    ],
    "apply sea": [
      "out:Sea applied: Zengwen Reservoir",
      "out:Bird flocks · Zengwen River basin · Sep: 79 species (interpolated) → 0.60 (3 flocks)",
      "out:Sea applied: Hualien offshore",
      "out:Bird flocks · Zengwen River basin · Sep: 79 species (interpolated) → 0.60 (3 flocks)",
      "out:Sea applied: Dust · Yunlin County",
      "out:Bird flocks · Zengwen River basin · Sep: 79 species (interpolated) → 0.60 (3 flocks)",
      "out:Sea applied: Moon · Hualien",
      "out:Bird flocks · Zengwen River basin · Sep: 79 species (interpolated) → 0.60 (3 flocks)",
    ],
    "survey": [
      "out:Bird flocks · Zengwen River basin · Sep: 79 species (interpolated) → 0.60 (3 flocks)",
      "out:Fish schools · Nanhua Reservoir sites (Zengwen River basin) · Sep: 32 species (interpolated) → 0.61",
      "out:Bird flocks · Zengwen River basin · Feb: 84 species → 0.60 (3 flocks)",
      "out:Bird flocks · Zengwen River basin · Sep: 79 species (interpolated) → 0.60 (3 flocks)",
    ],
    "play series": [
      "out:▶ Playing recording",
      "out:▶ Data playback: Hualien offshore 2026-09-20 Tide level (24 records, cm)",
      "out:▶ Playing recording",
      "out:▶ Data playback: Zengwen Reservoir 2026-09-19 Inflow (3 records, m³/s)",
      "out:▶ Playing recording",
      "out:▶ Data playback: Zengwen River basin 2004–2015 survey timeline Bird species (12 records, species)",
      "out:▶ Playing recording",
      "out:▶ Data playback: Nanhua Reservoir sites (Zengwen River basin) 2004–2006 survey timeline Fish species (3 records, species)",
      "out:▶ Playing recording",
      "out:▶ Data playback: Dust (Yunlin County) 09-20 09:00 → 09-20 12:00 PM10 (2 records, μg/m³)",
      "out:▶ Playing recording",
      "out:▶ Data playback: Moon · Hualien County 2026-09-19 → 2026-09-22 Transit altitude (4 records, °)",
    ],
    "markers": [
      "out:Marker snapshot #1 (1 total)",
      "out:Marker snapshot #2 (2 total)",
      "out:Marker ◀ snapshot #1",
      "out:Marker ▶ snapshot #2",
    ],
  }

test('store 日誌（pushLog）：中文逐字不變、英文不含中文且措辭固定；切回中文不殘留', async () => {
  const { useStore } = await import('../store/useStore.js')
  const S = () => useStore.getState()
  const reset = () => useStore.setState({ log: [], markers: [], markerIdx: -1, surveyLink: { birds: true, fish: false } })
  // 每個子動作前清日誌，只收該動作產生的行（避免套用海況的連帶日誌混進來）
  const step = (fns) => { const lines = []; for (const fn of fns) { reset(); fn(); lines.push(...useStore.getState().log.map((l) => `${l.dir}:${l.text}`)) } return lines }
  const steps = () => [
    ['overlays / CC / note', [() => { S().toggleOverlays(); S().toggleOverlays() }, () => S().handleCC(99, 0.5), () => S().handleNote(36, 0.8)]],
    ['record / actions', [() => { S().startRecording(); S().stopRecording(); S().startPlayback(); S().stopPlayback(); S().clearRec() }, () => { S().spawnWhale(); S().spawnDolphin(); S().spawnTurtle(); S().clearTrash() }]],
    ['apply sea', ['zengwen', 'hualien-tide', 'dust-yunlin', 'moon-hualien'].map((id) => () => S().setGovOption(id))],
    ['survey', [() => S().applySurvey('birds'), () => S().applySurvey('fish'), () => { S().setSurveyMonth(1); S().setSurveyMonth(8) }]],
    ['play series', [
      () => { S().setGovOption('hualien-tide'); reset(); S().playGovSeries(); S().stopPlayback() },
      () => { S().setGovOption('zengwen'); reset(); S().playGovSeries(); S().stopPlayback() },
      () => { S().playSurvey('birds'); S().stopPlayback() }, () => { S().playSurvey('fish'); S().stopPlayback() },
      () => { S().setGovOption('dust-yunlin'); reset(); S().playDust(); S().stopPlayback() },
      () => { S().setGovOption('moon-hualien'); reset(); S().playMoon(); S().stopPlayback() },
    ]],
    ['markers', [() => { S().markerSet(); S().markerSet(); S().markerPrev(); S().markerNext() }]],
  ].map(([name, fns]) => [name, step(fns)])
  const run = () => {
    S().setGov({ defaultOption: 'zengwen', ...govBase, options: [tideOpt, resOpt, dustOpt, moonOpt] })
    S().setSurveyMonth(8)
    return Object.fromEntries(steps())
  }
  const zh1 = run()
  assert.deepEqual(zh1, STORE_ZH)
  const en = inEn(run)
  assert.deepEqual(en, STORE_EN)
  for (const [name, lines] of Object.entries(en)) for (const l of lines) assert.ok(!HAN.test(l), `${name}: ${l}`)
  assert.deepEqual(run(), STORE_ZH)
  assert.equal(getLocale(), 'zh')
})
