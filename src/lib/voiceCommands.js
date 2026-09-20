// 語音指令（純函式，可在 Node 測試）：逐字稿正規化 + 指令表 + 寬鬆比對 + 去重 / 冷卻追蹤 + 執行動作。
//   normalize(text)                       全形→半形、轉小寫、標點 → 空白、中文字之間的空白移除
//   matchCommands(text, lang, opts)       → [{ id, index, end, word }]，依出現順序；一句多個指令全部回傳
//   createCommandTracker({ cooldownMs })  處理 SpeechRecognition 的 interim / final 重複事件（見下方說明）
//   runCommand(id, store)                 執行指令（store 是 zustand 的 useStore，或測試用的假物件）
//   heardText(ids) / labelOf(id)          「聽到：鯨魚」這類回饋文字（用當下語系）
// 注意：
//   · 中文同義詞（含常見誤辨、簡體）只出現在 regex 字面量裡——i18n 掃描器不算 regex，其餘顯示用文字都走 T() / t()。
//   · 不使用 lookbehind（舊版 Safari < 16.4 不支援，整個模組會解析失敗）。
//   · 本檔沒有任何瀏覽器 API，測試不需要假物件。
import { T, t, getLocale } from '../i18n/index.js'

export const COOLDOWN_MS = 1500       // 同一指令的冷卻時間
export const PAD_NOTE_BASE = 16       // 打擊墊：note = 16 + 效果索引（bank 1，強度檔位 ×1）→ handleNote → padEvents { ev: 效果索引 }
export const PAD_VELOCITY = 0.9

// Scene3D PadFx 的 16 個效果索引（0 水母 1 浪湧 2 漣漪 3 氣泡 4 亮星 5 海豚 6 鯨魚 7 海龜 8 淨化 9 垃圾 10 轉向 11 閃光 12 衝刺 13 三漣 14 星雨 15 大浪+氣泡）
export const PAD_FX = { sparkle: 4, bigwave: 15 }
export const padNote = (fx) => PAD_NOTE_BASE + fx

// 「安靜」：把這幾個參數朝平靜值移動一段（k = 一次走完剩餘距離的比例；一次性，不是持續動畫）；連說兩次會更平靜。
export const CALM_TARGETS = { current: 0.12, swimSpeed: 0.18, trashCount: 0.05 }
export const CALM_STEP = 0.65
// 「快一點」：洋流與游速朝高值移動一段
export const FAST_TARGETS = { current: 0.95, swimSpeed: 0.95 }
export const FAST_STEP = 0.35
const MIN_STEP = 0.004                // 已經幾乎到位就不動（避免無意義的 input / HUD 閃動）

// 指令表：id、顯示用鍵（label：回饋文字；say：功能列表「說……」；fx：效果說明）、zh / en 同義詞（regex，比對前文字已正規化）、動作。
//   action：{ call, args } 呼叫 store 的動作；{ pad, vel } 觸發打擊墊效果（handleNote）；{ move, k } 把參數朝目標值移動。
export const COMMANDS = [
  {
    id: 'whale', label: T('鯨魚'), say: T('說「鯨魚」'), fx: T('鯨魚出現'),
    zh: /鯨魚|鲸鱼|鯨|鲸|金魚|京魚|驚魚|經魚|精魚|鯨於|鯨餘|鯨漁/,
    en: /\bwh?ales?\b/,
    action: { call: 'spawnWhale' },
  },
  {
    id: 'dolphin', label: T('海豚'), say: T('說「海豚」'), fx: T('海豚出現'),
    zh: /海豚|海屯|海臀|海吞|海頓|海燉|海團/,
    en: /\b(?:dolphins?|dolfins?)\b/,
    action: { call: 'spawnDolphin' },
  },
  {
    id: 'turtle', label: T('海龜'), say: T('說「海龜」'), fx: T('海龜出現'),
    zh: /海龜|海龟|海歸|海归|海規|海规|海貴|海鬼|海櫃|海軌|烏龜|乌龟/,
    en: /\b(?:turtles?|tortoises?|terrapins?)\b/,
    action: { call: 'spawnTurtle' },
  },
  {
    id: 'bigwave', label: T('大浪'), say: T('說「大浪」或「大浪來了」'), fx: T('大浪與氣泡'),
    zh: /巨浪|大浪|大郎|大狼|大朗|浪來了/,
    en: /\bwaves?\b|\btsunamis?\b/,
    action: { pad: PAD_FX.bigwave, vel: PAD_VELOCITY },
  },
  {
    id: 'sparkle', label: T('亮星'), say: T('說「亮星」或「星星」'), fx: T('亮星爆發'),
    zh: /亮星|亮興|星星|閃亮|亮晶晶|星光/,
    en: /\b(?:sparkles?|sparkling|sparkled|stars?|twinkle|twinkling)\b/,
    action: { pad: PAD_FX.sparkle, vel: PAD_VELOCITY },
  },
  {
    id: 'purify', label: T('淨化'), say: T('說「淨化」'), fx: T('淨化波擴散'),
    zh: /淨化|净化|凈化|靜化|淨花|進化/,
    en: /\b(?:purify|purifies|purified|purifying|purification|cleanse|cleansing)\b/,
    action: { call: 'purify', args: [PAD_VELOCITY] },
  },
  {
    id: 'clean', label: T('清垃圾'), say: T('說「清垃圾」或「清理垃圾」'), fx: T('清除垃圾並淨化'),
    zh: /[清青輕](?:理|除|掉|掃|扫|走)?垃圾|[掃扫撿捡收]垃圾|清理|清潔|清洁|清掃|清扫/,
    en: /\bclean(?:s|ed|ing|up)?\b|\bclear(?:ing)?\s+(?:up\s+)?(?:(?:the|all|of|this|that)\s+)*(?:trash|garbage|litter|rubbish|debris|plastic)\b|\b(?:remove|pick\s+up|collect|sweep)\s+(?:(?:the|all)\s+)*(?:trash|garbage|litter|rubbish)\b/,
    action: { call: 'clearTrash' },
  },
  {
    id: 'calm', label: T('安靜'), say: T('說「安靜」「平靜」或「靜一點」'), fx: T('洋流、游速與垃圾一起放緩'),
    zh: /[安平寧冷鎮][靜静淨净井]|[靜静淨净]一[點点下店]|[靜静淨净]下來|靜靜|平息/,
    en: /\b(?:quiet(?:er)?|calm(?:er)?|peace(?:ful)?|hush|silence|shh+|relax)\b/,
    action: { move: CALM_TARGETS, k: CALM_STEP },
  },
  {
    id: 'faster', label: T('快一點'), say: T('說「快一點」'), fx: T('洋流與游速加快'),
    zh: /快一[點点些店]|快[點点]|快些|加快|加速|再快|更快|變快|变快|快快/,
    en: /\b(?:fast(?:er)?|quick(?:er)?|speed\s*up|hurry(?:\s+up)?|accelerate)\b/,
    action: { move: FAST_TARGETS, k: FAST_STEP },
  },
  {
    id: 'stop', label: T('停止'), say: T('說「停」或「停止」'), fx: T('停止播放或錄製'),
    zh: /暫停|暂停|停止|停下|停(?![車车電电留頓顿])/,
    en: /\b(?:stop(?:s|ped|ping)?|halt)\b/,
    action: { call: 'transportStop' },
  },
]

const BY_ID = Object.fromEntries(COMMANDS.map((c) => [c.id, c]))
export const COMMAND_IDS = COMMANDS.map((c) => c.id)
export const getCommand = (id) => BY_ID[id] || null

const langKey = (l) => (/^zh/i.test(String(l || '')) ? 'zh' : 'en')

// 編譯成全域 regex（每個指令 × 兩種語言，載入時一次）
const COMPILED = COMMANDS.map((c) => ({ id: c.id, zh: new RegExp(c.zh.source, 'g'), en: new RegExp(c.en.source, 'g') }))

// ---- 正規化 ----
// NFKC：全形英數 / 標點 → 半形（ＷＨＡＬＥ！ → WHALE!）、全形空白 → 空白；小寫；撇號直接刪（dolphin's → dolphins）；
// 其餘標點 / 符號 → 空白；辨識器偶爾在中文字之間塞空白（「鯨 魚」）→ 移除；不使用 lookbehind。
export function normalize(text) {
  let s = text == null ? '' : String(text)
  try { s = s.normalize('NFKC') } catch (e) { /* 很舊的環境沒有 normalize：略過 */ }
  s = s.toLowerCase()
  s = s.replace(/['’‘`´]/g, '')
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ')
  s = s.replace(/([㐀-鿿豈-﫿])\s+(?=[㐀-鿿豈-﫿])/g, '$1')
  return s.trim()
}

// 比對「已正規化」的文字。cross = true：主要語言以外，另一種語言的詞表也一併比對
// （例如 zh-TW 辨識器有時會把英文詞照拉丁字母寫出來；反過來 en 辨識器不會出現中文，多比對無害）。
export function scanNormalized(norm, lang = 'zh', cross = true) {
  if (!norm) return []
  const main = langKey(lang)
  const langs = cross ? [main, main === 'zh' ? 'en' : 'zh'] : [main]
  const hits = []
  for (const c of COMPILED) {
    for (const L of langs) {
      const re = c[L]
      re.lastIndex = 0
      for (let m = re.exec(norm); m; m = re.exec(norm)) {
        if (m[0].length === 0) { re.lastIndex++; continue }
        hits.push({ id: c.id, index: m.index, end: m.index + m[0].length, word: m[0] })
      }
    }
  }
  hits.sort((a, b) => a.index - b.index || (b.end - b.index) - (a.end - a.index))
  const out = []
  for (const h of hits) {   // 同一指令互相重疊的命中（「亮星星」= 亮星 + 星星、「安靜一點」= 安靜 + 靜一點）只留最先、最長的一個
    if (out.some((o) => o.id === h.id && h.index < o.end && h.end > o.index)) continue
    out.push(h)
  }
  return out
}

export function matchCommands(text, lang = 'zh', opts = {}) {
  return scanNormalized(normalize(text), lang, opts.cross !== false)
}

// ---- 去重 / 冷卻 ----
// SpeechRecognition（continuous + interimResults）會對同一句話反覆送事件：interim 逐字長大、最後再送一次 final，
// 甚至 interim 內容被修正。所以：
//   1) 每個 result index 各自記「已處理過的位置」：同一指令在該段逐字稿裡的第 n 次出現處理過一次就不再處理
//      （被冷卻擋下的也算處理過，之後不會因為冷卻結束而補發）。內容被修正、前面插字時，用「第幾次出現」而不是字元位置，才不會重發。
//   2) 同一指令 cooldownMs（預設 1.5 秒）內只觸發一次。
//   3) 部分瀏覽器（Android Chrome）的逐字稿是累加式：下一段 result 會把上一段整句重複帶進來 → 新段若是「上一段的延伸」，繼承上一段的已處理紀錄。
// feed(items, now)：items = [{ index, transcript, isFinal }]（只需要送有變動的那幾段）→ [{ id, word, index, interim }]（依出現順序）
export function createCommandTracker({ cooldownMs = COOLDOWN_MS, lang = 'zh', cross = true } = {}) {
  let curLang = lang
  const slots = new Map()      // result index → { norm, seen: { id: 已處理過的出現次數 } }
  const lastFire = new Map()   // id → 上次觸發時間（ms）
  return {
    setLang(l) { curLang = l },
    // 新的辨識 session 開始（result index 從 0 重來）：清掉逐段紀錄；冷卻預設保留（重啟後同一句話不會重發）
    reset(opts) { slots.clear(); if (opts && opts.cooldowns) lastFire.clear() },
    feed(items, now) {
      const fired = []
      const arr = Array.isArray(items) ? items : []
      let minIdx = Infinity
      for (const it of arr) {
        const idx = it.index | 0
        if (idx < minIdx) minIdx = idx
        const norm = normalize(it.transcript)
        let slot = slots.get(idx)
        if (!slot) {
          slot = { norm: '', seen: {} }
          const prev = slots.get(idx - 1)
          if (prev && prev.norm && norm.length > prev.norm.length && norm.startsWith(prev.norm)) slot.seen = { ...prev.seen }
          slots.set(idx, slot)
        }
        slot.norm = norm
        const counts = {}
        for (const m of scanNormalized(norm, curLang, cross)) {
          const nth = (counts[m.id] = (counts[m.id] || 0) + 1)
          if (nth <= (slot.seen[m.id] || 0)) continue
          slot.seen[m.id] = nth
          const last = lastFire.get(m.id)
          if (last != null && now - last < cooldownMs) continue
          lastFire.set(m.id, now)
          fired.push({ id: m.id, word: m.word, index: idx, interim: !it.isFinal })
        }
      }
      if (minIdx !== Infinity) for (const k of slots.keys()) if (k < minIdx - 2) slots.delete(k)   // 只留最近幾段（累加式判斷要看前一段）
      return fired
    },
  }
}

// ---- 執行 ----
function moveParams(st, targets, k) {
  if (typeof st.input !== 'function') return
  for (const pid of Object.keys(targets)) {
    const cur = st.params && st.params[pid]
    if (typeof cur !== 'number') continue
    const next = Math.max(0, Math.min(1, cur + (targets[pid] - cur) * k))
    if (Math.abs(next - cur) >= MIN_STEP) st.input(pid, next)   // 走 input()：錄製中會被錄進去、播放中會登記接管、HUD 會顯示
  }
}

// store：useStore（getState() → 動作與 params）或測試用假物件。回傳是否有這個指令。
export function runCommand(id, store) {
  const c = BY_ID[id]
  if (!c) return false
  const st = store.getState()
  const a = c.action
  if (a.pad != null) { if (typeof st.handleNote === 'function') st.handleNote(padNote(a.pad), a.vel) }
  else if (a.call) { if (typeof st[a.call] === 'function') st[a.call](...(a.args || [])) }
  else if (a.move) moveParams(st, a.move, a.k)
  return true
}

// ---- 回饋文字（用當下語系；模組層不存 t() 結果）----
export function labelOf(id) { const c = BY_ID[id]; return c ? t(c.label) : String(id) }
export function joinLabels(ids) { return ids.map(labelOf).join(getLocale() === 'en' ? ', ' : '、') }
export function heardText(ids) { return t('聽到：{cmd}', { cmd: joinLabels(ids) }) }
export function logText(id) { return t('語音指令：{cmd}', { cmd: labelOf(id) }) }   // 寫進 IN 日誌的文字（當下語系的快照）
