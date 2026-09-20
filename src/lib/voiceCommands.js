// 語音指令（純函式，可在 Node 測試）：逐字稿正規化 + 指令表 + 寬鬆比對 + 去重 / 冷卻追蹤 + 執行動作。
//   normalize(text)                       全形→半形、轉小寫、標點 → 空白、中文字之間的空白移除
//   matchCommands(text, lang, opts)       → [{ id, index, end, word }]，依出現順序；一句多個指令全部回傳
//   createCommandTracker({ cooldownMs })  處理 SpeechRecognition 的 interim / final 重複事件（見下方說明）
//   runCommand(id, store)                 執行「海」的指令（store 是 zustand 的 useStore，或測試用的假物件）；導覽員指令（下一站…）不在這裡，見 routeTourCommand
//   routeTourCommand({ id, runner, touchGuide, log })   導覽員語音指令（下一站 / 上一站 / 暫停導覽 / 繼續導覽 / 開始導覽 / 結束導覽）：
//                                         一律呼叫 touchGuide()（不是 touch()：touch 會讓導覽以 'input' 中止）；只有導覽進行中才對 next / prev / pause / resume / stop 生效，
//                                         沒在跑就無動作但寫一行 IN 日誌讓使用者知道有聽到；start 才會開始導覽
//   createVoiceRouter({...})              VoiceService 的接線（純函式，可測）：導覽員指令走 routeTourCommand、海的指令走注入的 runSea；
//                                         導覽進行中，interim 的「停」會延後一小段時間（interim 逐字出現時「暫停」會先於「暫停導覽」被聽到，不延後的話會先中止導覽）
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
  // ---- 導覽員指令（action.tour）----
  // 詞表刻意保守，避免展場環境音誤觸發：中文一定要「站」或「導覽」字樣，英文一律兩個字以上的片語（不接受單獨的 next / stop / pause / resume / start）。
  // 含「導覽」的片語不會同時觸發既有指令（「暫停導覽」「停止導覽」不會被當成「停止」；「stop tour」「next stop」不會被當成 stop）：
  //   scanNormalized 讓導覽指令「佔用」它命中的文字範圍，與該範圍重疊的其他指令命中一律捨棄；反過來，沒有「導覽」字樣的句子（「暫停」「停止」）不會觸發導覽指令。
  // 「導覽」的常見誤辨（導览 / 道覽 / 倒覽）與簡體、「資料導覽」全名都算。倒裝說法只收規格列的「導覽暫停」「導覽繼續」（「導覽結束了」是講解常用語，不能拿來結束導覽）。
// 「結束」類同義詞刻意不收講解裡常出現的說法（離開導覽區 / 取消導覽行程 / after we finish the tour / cancel）：誤結束導覽比多說一個字的代價大。
  {
    id: 'tourNext', label: T('下一站'), say: T('說「下一站」'), fx: T('導覽跳到下一站'),
    zh: /下一[站占佔]|下一?[個个]站/,
    en: /\bnext\s*stops?\b/,
    action: { tour: 'next' },
  },
  {
    id: 'tourPrev', label: T('上一站'), say: T('說「上一站」'), fx: T('導覽回到上一站'),
    zh: /[上前]一[站占佔]|[上前]一[個个]站|上[個个]站/,
    en: /\b(?:previous|prev|preview|pervious|privious)\s*stops?\b/,
    action: { tour: 'prev' },
  },
  {
    id: 'tourPause', label: T('暫停導覽'), say: T('說「暫停導覽」或「導覽暫停」'), fx: T('導覽停在這一站（可繼續）'),
    zh: /[暫暂]停(?:資料|资料)?[導导道倒][覽览攬揽]|[導导道倒][覽览攬揽][暫暂]停/,
    en: /\b(?:pause|paused|pauses|paws|pose)\s+(?:the\s+)?(?:tours?|tore)\b/,
    action: { tour: 'pause' },
  },
  {
    id: 'tourResume', label: T('繼續導覽'), say: T('說「繼續導覽」或「導覽繼續」'), fx: T('導覽從這一站接著走'),
    zh: /[繼继接恢][續续復复](?:資料|资料)?[導导道倒][覽览攬揽]|[導导道倒][覽览攬揽][繼继][續续]/,
    en: /\b(?:resum[eé]s?|resumed|continues?)\s+(?:the\s+)?(?:tours?|tore)\b/,
    action: { tour: 'resume' },
  },
  {
    id: 'tourStart', label: T('開始導覽'), say: T('說「開始導覽」'), fx: T('開始資料導覽'),
    zh: /(?:[開开][始啟启啓]|[啟启啓][動动])(?:資料|资料)?[導导道倒][覽览攬揽]/,
    en: /\b(?:starts?|started|star|begin|begins)\s+(?:the\s+|a\s+|this\s+)?(?:tours?|tore)\b/,
    action: { tour: 'start' },
  },
  {
    id: 'tourStop', label: T('結束導覽'), say: T('說「結束導覽」或「停止導覽」'), fx: T('結束導覽並還原原本的海'),
    zh: /(?:[結结]束|停止|[關关][閉闭]|退出|[終终]止)(?:資料|资料)?[導导道倒][覽览攬揽]/,
    en: /\b(?:stop|stops|stopped|end|ends|ended|exit|quit)\s+(?:the\s+|this\s+)?(?:tours?|tore)\b/,
    action: { tour: 'stop' },
  },
]

export const TOUR_COMMAND_IDS = COMMANDS.filter((c) => c.action.tour).map((c) => c.id)
const TOUR_ID_SET = new Set(TOUR_COMMAND_IDS)
export const isTourCommand = (id) => TOUR_ID_SET.has(id)

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
  // 導覽員指令「佔用」它命中的範圍：與它重疊的其他指令命中捨棄（「暫停導覽」的「暫停」、「stop tour」的 stop 不算另一個指令）
  const tours = out.filter((h) => TOUR_ID_SET.has(h.id))
  if (!tours.length) return out
  return out.filter((h) => TOUR_ID_SET.has(h.id) || !tours.some((o) => h.index < o.end && h.end > o.index))
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
  if (!c || c.action.tour) return false   // 導覽員指令要有 runner，走 routeTourCommand
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

// ---- 導覽員語音指令的執行 ----
// runner：tourCore 的 tourRunner（或測試用假物件；方法一律「以方法呼叫」）。log(text)：寫一行 IN 日誌。
// 回傳 'ran'（已執行）| 'idle'（導覽沒在進行，無動作）| 'noop'（已經是那個狀態，無動作）| 'failed'（start 起不來）| 'unknown'（不是導覽員指令）。
// 沒有任何路徑會丟例外（runner 出錯 → 'failed'）。
export function routeTourCommand({ id, runner, touchGuide, log } = {}) {
  const c = BY_ID[id]
  const act = c && c.action.tour
  if (!act) return 'unknown'
  const say = (text) => { try { if (typeof log === 'function') log(text) } catch (e) { /* 日誌失敗不影響導覽 */ } }
  const cmd = labelOf(id)
  try { if (typeof touchGuide === 'function') touchGuide() } catch (e) { /* 只是記時間 */ }   // 導覽員操作：只記時間、不中止導覽（touch() 會讓導覽以 'input' 中止）
  try {
    const running = !!(runner && runner.isRunning())
    if (act === 'start') {
      if (running) { say(t('語音：{cmd}（導覽已在進行）', { cmd })); return 'noop' }
      if (runner.start({ auto: false })) { say(logText(id)); return 'ran' }
      say(t('語音：{cmd}（目前無法開始導覽）', { cmd })); return 'failed'
    }
    if (!running) { say(t('語音：{cmd}（導覽沒在進行）', { cmd })); return 'idle' }
    if (act === 'pause' && runner.isPaused()) { say(t('語音：{cmd}（已經暫停）', { cmd })); return 'noop' }
    if (act === 'resume' && !runner.isPaused()) { say(t('語音：{cmd}（導覽沒有暫停）', { cmd })); return 'noop' }
    say(logText(id))   // 先寫「聽到」的日誌，再執行（執行時導覽自己會寫換站 / 暫停的日誌）
    if (act === 'next') runner.next()
    else if (act === 'prev') runner.prev()
    else if (act === 'pause') runner.pause()
    else if (act === 'resume') runner.resume()
    else if (act === 'stop') runner.stop('user')
    return 'ran'
  } catch (e) {
    return 'failed'
  }
}

// VoiceService 的接線（純函式，可測）。f = tracker 送出的 { id, word, index, interim }。
//   runSea(f)：海的指令的執行（VoiceService 在那裡先 touch() 再 runCommand，順序有測試守著）；show(f)：畫布下方「聽到：…」的提示（導覽員指令、海的指令都會呼叫）。
//   導覽進行中，interim 的 'stop'（「停」「暫停」「停止」「stop」）延後 deferMs 才執行：辨識器逐字出現，「暫停導覽」會先聽到「暫停」——
//   如果立刻執行，touch() 會先把導覽中止，後面的「導覽」才到。延後期間同一段逐字稿出現導覽員指令就取消它；沒有就照常執行（final 結果不延後）。
export const STOP_DEFER_MS = 900
export function createVoiceRouter({ runner, touchGuide, log, runSea, show, schedule, cancel, deferMs = STOP_DEFER_MS } = {}) {
  let pending = null   // { f, timer }
  const safe = (fn, ...a) => { try { if (typeof fn === 'function') fn(...a) } catch (e) { /* 動作出錯不影響辨識 */ } }
  const running = () => { try { return !!(runner && runner.isRunning()) } catch (e) { return false } }
  function runSeaNow(f) { safe(runSea, f); safe(show, f) }
  function drop() {
    const p = pending
    pending = null
    if (p && p.timer != null) { try { cancel(p.timer) } catch (e) { /* ignore */ } }
    return p
  }
  return {
    handle(f) {
      if (!f || !BY_ID[f.id]) return
      const tour = TOUR_ID_SET.has(f.id)
      if (pending) {
        const p = drop()
        if (tour && f.index === p.f.index) { /* 同一段逐字稿：那個「停」其實是導覽員指令的前半，捨棄 */ }
        else runSeaNow(p.f)                                             // 別的指令來了：先把延後的「停」照常執行，維持原本的先後順序
      }
      if (tour) { routeTourCommand({ id: f.id, runner, touchGuide, log }); safe(show, f); return }
      if (f.id === 'stop' && f.interim && running() && typeof schedule === 'function') {
        const entry = { f, timer: null }
        pending = entry
        entry.timer = schedule(() => { if (pending === entry) { pending = null; runSeaNow(f) } }, deferMs)
        return
      }
      runSeaNow(f)
    },
    // 卸載：取消延後中的「停」（不執行）
    dispose() { drop() },
  }
}
