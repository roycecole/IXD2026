// 語音旁白（Web Speech API 的 SpeechSynthesis 包裝）：把資料導覽的字幕「念出來」。選用功能，預設不出聲、不請求任何權限。
//   createNarrator(deps)        → 旁白器（狀態全在閉包裡；可注入假的 synth / Utterance / 計時器 / 語系，Node 可測）
//   narrator                    → 共用實例（import 時完全不碰 window / navigator：所有環境存取都延到「呼叫當下」）；pickVoice(lang) 是它的捷徑
//   speechText({ title, body }, locale) → 把字幕轉成適合朗讀的字串（純函式）
//   pickVoiceFrom(voices, lang) → 挑聲音的純函式（narrator.pickVoice 用它）
// narrator 方法：
//   supported()                 synth 與 Utterance 都存在才 true；任何存取丟例外 → false
//   speak(text, opts?)          → Promise<'done' | 'cancelled' | 'error' | 'unsupported'>（永遠 resolve，不會 reject / 丟例外）
//   cancel() / speaking()       speaking() 追蹤「自己」的狀態（從 speak() 被接受到結束），不依賴 synth.speaking（某些瀏覽器不準）
//   onChange(cb) → off          speaking 狀態改變時 cb(boolean)；只在「真的變化」時通知（下一句蓋掉上一句不會閃一次 false）
//   pickVoice(lang)             依 lang 挑聲音（可能是 null）；voices 一開始可能是空的，會監聽 voiceschanged 並快取
//   dispose()                   cancel + 移除 voiceschanged 監聽 + 清所有訂閱。之後仍可再用（會重新掛監聽）——StrictMode 雙掛載 / 熱更新安全
//
// 瀏覽器怪癖（Node 測不到，所以這裡的寫法都刻意防著）：
//   · 原生方法一律「以方法呼叫」（synth.speak(u)、synth.cancel()、synth.addEventListener(…)），絕不存進變數或物件屬性再呼叫，
//     否則 TypeError: Illegal invocation。注入的計時器則相反：用「裸函式」呼叫（this 為 undefined），因為原生 setTimeout 也允許這樣呼叫，
//     但若掛在別的物件上（deps.setTimeout(…)）就會丟 Illegal invocation。
//   · Chrome：cancel() 後立刻 speak() 常被吞掉 → cancel 後延遲 CANCEL_DELAY_MS 再 speak；延遲期間又被 cancel / 蓋掉就不 speak。
//   · Chrome：utterance 若被 GC，onend 永遠不會來 → 進行中的 utterance 由 cur 記錄持有到結束。
//   · 引擎卡住 / 分頁被隱藏時 onend 可能永遠不來 → 預估時長 + 4 秒的安全逾時，逾時就 cancel 並以 'error' 結束。
//   · iOS Safari / 部分瀏覽器：未經使用者手勢的 speak() 會被擋（onerror 'not-allowed'，或安靜地沒聲音）→ 一律以 'error' 結束，不丟例外。
//   · voices 一開始常是空的，之後才觸發 voiceschanged；Firefox / 部分 Safari 可能永遠不觸發 → 快取是空的時每次 pickVoice 都會重讀。
//   · 正規表示式不用 lookbehind（iOS Safari < 16.4 會在「解析」階段就丟 SyntaxError，整個模組載入失敗）。
import { getLocale as currentLocale } from '../i18n/index.js'

export const CANCEL_DELAY_MS = 60                      // cancel 後到 speak 之間的延遲（Chrome 吞字怪癖）
export const MS_PER_CHAR = { zh: 260, en: 75 }         // 預估朗讀時間：每字毫秒（zh 含日韓等 CJK）
export const SAFETY_PAD_MS = 4000                      // 安全逾時 = 預估時長 + 這個寬限

// ---------------------------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------------------------
const clampNum = (v, def, lo, hi) => {
  if (v === null || v === '' || v === undefined) return def
  const x = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : def
}

const isCjkLang = (lang) => /^(?:zh|ja|ko|yue|cmn)(?:$|[-_])/i.test(String(lang || ''))

// 預估朗讀時長（ms）加上安全寬限：字數 × 每字毫秒（÷ 語速）+ 4 秒
export function estimateSpeechMs(text, lang = 'en-US', rate = 1) {
  const n = String(text == null ? '' : text).length
  const per = isCjkLang(lang) ? MS_PER_CHAR.zh : MS_PER_CHAR.en
  return Math.round(n * per / clampNum(rate, 1, 0.1, 10)) + SAFETY_PAD_MS
}

// ---------------------------------------------------------------------------------------------
// 挑聲音（純函式）
// ---------------------------------------------------------------------------------------------
// 'zh_TW' / 'zh-Hant-TW' / 'zh-tw' → { lang:'zh', script:'hant', region:'tw' }
function parseTag(tag) {
  const parts = String(tag == null ? '' : tag).trim().replace(/_/g, '-').toLowerCase().split('-').filter(Boolean)
  let script = '', region = ''
  for (const p of parts.slice(1)) {
    if (/^[a-z]{4}$/.test(p)) script = script || p
    else if (/^(?:[a-z]{2}|\d{3})$/.test(p)) region = region || p
  }
  return { lang: parts[0] || '', script, region }
}

// 同語系、但區域不同時的偏好順序（數字越小越好）：zh 系優先 zh-HK、最後才 zh-CN 系；en 系優先 en-US、en-GB、其他 en-*
function familyRank(v) {
  if (v.lang === 'zh') {
    if (v.region === 'hk') return 0
    if (v.region === 'cn' || v.region === 'sg' || (v.script === 'hans' && v.region !== 'tw')) return 2
    return 1
  }
  if (v.lang === 'en') return v.region === 'us' ? 0 : v.region === 'gb' ? 1 : 2
  return 0
}

const lessThan = (a, b) => { for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] < b[k]; return false }

// 從 voices 裡挑最合適的一個；找不到（含空陣列 / 不同語系）→ null。
// 優先順序：完全符合 lang（zh-TW 也接受 zh_TW、zh-Hant-TW）→ 同語系其他區域（見 familyRank）→ null；同等級偏好 localService === true（離線、延遲低）；再同等就保持原順序。
export function pickVoiceFrom(voices, lang) {
  const want = parseTag(lang)
  if (!want.lang || !voices || typeof voices.length !== 'number') return null
  let best = null, bestScore = null
  for (let i = 0; i < voices.length; i++) {
    const v = voices[i]
    if (!v || typeof v.lang !== 'string') continue
    const have = parseTag(v.lang)
    if (have.lang !== want.lang) continue
    const exact = want.region ? have.region === want.region : (!have.region && (!want.script || !have.script || have.script === want.script))
    const score = [exact ? 0 : 1, exact ? 0 : familyRank(have), v.localService === true ? 0 : 1, i]   // 依序比較：等級 → 家族偏好 → 離線優先 → 原順序
    if (!bestScore || lessThan(score, bestScore)) { best = v; bestScore = score }
  }
  return best
}

// ---------------------------------------------------------------------------------------------
// 字幕 → 朗讀文字（純函式）
// ---------------------------------------------------------------------------------------------
// 標記給 i18n 掃描器：以下中文是「朗讀用的詞」（不是畫面上的 UI 文字）。英文詞在上方 SPOKEN_UNITS 的 en / en1，字典見 src/i18n/en/narration.js（測試會核對兩邊一致）。
const T = (zh) => zh

// 單位：src 是正規表示式來源；zh 一種說法；en1 / en 是英文單數 / 複數（1 → 單數，其餘複數；沒有數字時用複數）
// 順序有意義：長的、有斜線的在前（m³/s 先於 m³，cm/s 先於 cm）。
export const SPOKEN_UNITS = [
  { src: '(?:[μµ]g|ug)\\/m[³3]', zh: T('微克每立方公尺'), en1: 'microgram per cubic metre', en: 'micrograms per cubic metre' },
  { src: 'm³\\/s', zh: T('立方公尺每秒'), en1: 'cubic metre per second', en: 'cubic metres per second' },
  { src: 'm³', zh: T('立方公尺'), en1: 'cubic metre', en: 'cubic metres' },
  { src: 'km²', zh: T('平方公里'), en1: 'square kilometre', en: 'square kilometres' },
  { src: 'm²', zh: T('平方公尺'), en1: 'square metre', en: 'square metres' },
  { src: 'km\\/h', zh: T('公里每小時'), en1: 'kilometre per hour', en: 'kilometres per hour' },
  { src: 'm\\/s', zh: T('公尺每秒'), en1: 'metre per second', en: 'metres per second' },
  { src: 'cm\\/s', zh: T('公分每秒'), en1: 'centimetre per second', en: 'centimetres per second' },
  { src: 'mm\\/h', zh: T('毫米每小時'), en1: 'millimetre per hour', en: 'millimetres per hour' },
  { src: 'cm', zh: T('公分'), en1: 'centimetre', en: 'centimetres' },
  { src: 'mm', zh: T('毫米'), en1: 'millimetre', en: 'millimetres' },
  { src: '[μµ]m', zh: T('微米'), en1: 'micrometre', en: 'micrometres' },
]
const NUM = '\\d[\\d,]*(?:\\.\\d+)?'
const UNIT_TAIL = '(?![A-Za-z0-9\\/])'
const UNIT_RES = SPOKEN_UNITS.map((u) => ({
  u,
  withNum: new RegExp(`(${NUM})(\\s*)${u.src}${UNIT_TAIL}`, 'g'),
  bare: new RegExp(`(^|[^A-Za-z0-9])${u.src}${UNIT_TAIL}`, 'g'),   // 不用 lookbehind：以「前一個字元」當左邊界
}))
const isOne = (n) => /^1(?:\.0+)?$/.test(n)

// 數字範圍（119–175、2005–2017、−5–120）：en dash / em dash / 圖表破折號 / ~ → 「到」/ " to "。只在「數字 破折號 數字」時轉，不動負號與單獨的 —（缺值佔位）。
const RANGE_DASH = new RegExp('(\\d)\\s*[\\u2012\\u2013\\u2014\\u2015~\\uFF5E]\\s*(?=[-\\u2212]?\\.?\\d)', 'g')
const RANGE_ZH = T('{a}到{b}')                                       // 「到」由樣板取出，讓這個詞在字典裡有獨一無二的 key
const RANGE_ZH_WORD = RANGE_ZH.replace('{a}', '').replace('{b}', '')
const RANGE_EN_WORD = ' to '

const ARROW = /\s*(?:→|⇒|➜|➔|⟶|->)\s*/g
const MIDDOT = /\s*[·・•∙]\s*/g
const SPACED_SLASH = /\s+\/\s+/g
const UP = /\s*↑\s*/g
const DOWN = /\s*↓\s*/g
const ZH_UP = T('上升')
const ZH_DOWN = T('下降')

// 朗讀前的符號 / 單位處理（單一語系）。不臆造內容、不改變數字；PM2.5 / PM10 / % 與括號內容原樣保留。
function speakable(input, locale) {
  const en = locale === 'en'
  let s = String(input == null ? '' : input)
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ').replace(/[\r\n\t]+/g, ' ')

  s = s.replace(/\u2014\s*[\u2012\u2013\u2015]\s*\u2014/g, '\u2014')   // 兩端都缺值的範圍（—–—）：合併成一個缺值佔位，不要念成「到」
  for (let i = 0; i < 4; i++) {        // 連續範圍（1–2–3）一次只吃一段，多跑幾輪
    const next = s.replace(RANGE_DASH, en ? '$1' + RANGE_EN_WORD : '$1' + RANGE_ZH_WORD)
    if (next === s) break
    s = next
  }

  for (const { u, withNum, bare } of UNIT_RES) {
    if (en) {
      s = s.replace(withNum, (m, n, sp) => n + sp + (isOne(n) ? u.en1 : u.en))
      s = s.replace(bare, (m, pre) => pre + u.en)
    } else {
      s = s.replace(withNum, (m, n, sp) => n + sp + u.zh)
      s = s.replace(bare, (m, pre) => pre + u.zh)
    }
  }

  // 箭頭與間隔點：zh 一律「，」；en 箭頭讀成 ", giving"（保留「因果 / 換算」的語氣，比單純逗號不會把 A → B 唸成兩個並列的項目），間隔點「,」
  s = s.replace(UP, en ? ' rising ' : ` ${ZH_UP} `).replace(DOWN, en ? ' falling ' : ` ${ZH_DOWN} `)
  s = s.replace(ARROW, en ? ', giving ' : '，').replace(MIDDOT, en ? ', ' : '，')
  s = s.replace(SPACED_SLASH, en ? ', ' : '、')            // 「Open-Meteo / CAMS」這種前後有空白的斜線是並列，念成停頓；沒有空白的（8/10、m/s）不動

  // 其餘落單的 en dash：前後有空白視為停頓，否則視為範圍
  s = s.replace(/\s+\u2013\s+/g, en ? ', ' : '，').replace(/\u2013/g, en ? RANGE_EN_WORD : RANGE_ZH_WORD)

  if (en) {
    s = s.replace(/\s+/g, ' ').replace(/\s+([,;:.!?)])/g, '$1').replace(/([(])\s+/g, '$1').replace(/,(?:\s*,)+/g, ',').replace(/^[,\s]+|[,\s]+$/g, '')
  } else {
    s = s.replace(/\s+/g, ' ').replace(/\s*([，。：；、！？（）「」『』])\s*/g, '$1').replace(/，(?:，)+/g, '，').replace(/^[，、\s]+|[，、\s]+$/g, '')
  }
  return s
}

// 標題與內文接成一段：zh 以「。」、en 以「. 」連接；標題已有句末標點就不重複；任一邊是空的就只念另一邊。
// locale 省略時用目前語系。不做任何內容改寫（只是符號 / 單位口語化，見 speakable）。
export function speechText(caption, locale) {
  const c = caption && typeof caption === 'object' ? caption : {}
  let loc = locale
  if (loc == null) { try { loc = currentLocale() } catch (e) { loc = 'zh' } }
  const en = /^en(?:$|[-_])/i.test(String(loc))
  const lc = en ? 'en' : 'zh'
  const title = speakable(c.title, lc)
  const body = speakable(c.body, lc)
  if (!title || !body) return title || body
  if (en) return /[.!?…]$/.test(title) ? `${title} ${body}` : `${title.replace(/[,;:]$/, '')}. ${body}`
  return /[。！？!?.…]$/.test(title) ? `${title}${body}` : `${title.replace(/[，、；;,：:]$/, '')}。${body}`
}

// ---------------------------------------------------------------------------------------------
// 旁白器
// ---------------------------------------------------------------------------------------------
// deps.Utterance 可以是類別本身，也可以是「回傳類別」的函式：
//   類別（class 語法 / 原生 [native code] 建構子）→ 直接用；箭頭函式（沒有 prototype）→ 一定是工廠；
//   其餘一般 function 無法從外觀分辨 → 先當工廠試呼叫，回傳函式就用它，丟例外或回傳非函式就當建構子。
function resolveCtor(spec) {
  if (typeof spec !== 'function') return null
  let src = ''
  try { src = Function.prototype.toString.call(spec) } catch (e) { /* ignore */ }
  if (/^\s*class\b/.test(src) || /\[native code\]/.test(src)) return spec
  if (!spec.prototype) { const r = spec(); return typeof r === 'function' ? r : null }
  try { const r = spec(); if (typeof r === 'function') return r } catch (e) { /* 建構子不能不加 new 呼叫 */ }
  return spec
}

const readVoices = (synth) => {
  try { const v = synth.getVoices(); return v && typeof v.length === 'number' ? Array.prototype.slice.call(v) : [] } catch (e) { return [] }
}

export function createNarrator(deps = {}) {
  const d = deps && typeof deps === 'object' ? deps : {}
  // 注入的計時器 / 語系函式：取出成區域變數，之後以「裸函式」呼叫（見檔頭說明）；沒注入就在呼叫當下用全域的
  const injSet = d.setTimeout, injClear = d.clearTimeout, injLocale = d.getLocale
  const sched = (fn, ms) => (typeof injSet === 'function' ? injSet(fn, ms) : setTimeout(fn, ms))
  const unsched = (id) => {
    if (id == null) return
    try { if (typeof injClear === 'function') injClear(id); else clearTimeout(id) } catch (e) { /* ignore */ }
  }
  const locale = () => { try { return (typeof injLocale === 'function' ? injLocale() : currentLocale()) === 'en' ? 'en' : 'zh' } catch (e) { return 'zh' } }

  // ---- 環境（每次呼叫當下才讀；任何存取丟例外都當作沒有）----
  const globals = () => (typeof window !== 'undefined' && window ? [window, globalThis] : [globalThis])
  const readSynth = () => {
    try {
      const s = d.synth
      if (typeof s === 'function') return s() || null
      if (s !== undefined) return s || null
      for (const g of globals()) if (g && g.speechSynthesis) return g.speechSynthesis
      return null
    } catch (e) { return null }
  }
  const readUtt = () => {
    try {
      if (d.Utterance !== undefined) return resolveCtor(d.Utterance)
      for (const g of globals()) if (g && g.SpeechSynthesisUtterance) return g.SpeechSynthesisUtterance
      return null
    } catch (e) { return null }
  }
  const env = () => { const synth = readSynth(), Utt = readUtt(); return synth && typeof Utt === 'function' ? { synth, Utt } : null }

  // ---- 狀態 ----
  let cur = null              // 進行中的請求 { resolve, synth, Utt, text, lang, rate, pitch, volume, utt, delayId, safetyId, done }（同時持有 utterance，避免被 GC）
  let flag = false            // speaking 狀態（邊緣觸發通知）
  const subs = new Set()
  let watch = null            // { synth, handler, mode:'listener'|'prop', prev }
  let voices = []             // voices 快取

  const setSpeaking = (v) => {
    if (v === flag) return
    flag = v
    for (const cb of Array.from(subs)) { try { cb(v) } catch (e) { /* 訂閱者的錯不能影響旁白 */ } }
  }

  // ---- voiceschanged 監聽 ----
  function stopWatch() {
    const w = watch
    watch = null
    if (!w) return
    try {
      if (w.mode === 'listener') w.synth.removeEventListener('voiceschanged', w.handler)
      else if (w.synth.onvoiceschanged === w.handler) w.synth.onvoiceschanged = w.prev || null
    } catch (e) { /* ignore */ }
  }
  function startWatch(synth) {
    if (watch && watch.synth === synth) return
    stopWatch()
    voices = []
    const handler = () => { voices = readVoices(synth) }
    try {
      if (typeof synth.addEventListener === 'function') { synth.addEventListener('voiceschanged', handler); watch = { synth, handler, mode: 'listener' } }
      else { const prev = synth.onvoiceschanged; synth.onvoiceschanged = handler; watch = { synth, handler, mode: 'prop', prev } }   // 舊瀏覽器沒有 addEventListener
    } catch (e) { watch = null }
  }

  function pickVoice(lang) {
    const synth = readSynth()
    if (!synth) return null
    startWatch(synth)
    if (!voices.length) voices = readVoices(synth)   // 空的就再讀一次（Chrome 首次 getVoices 才開始載入；Firefox 可能不觸發事件）
    return pickVoiceFrom(voices, lang)
  }

  // ---- 結束一個請求 ----
  function settle(rec, result) {
    if (rec.done) return
    rec.done = true
    unsched(rec.delayId); unsched(rec.safetyId)
    rec.delayId = rec.safetyId = null
    if (rec.utt) { try { rec.utt.onend = null; rec.utt.onerror = null } catch (e) { /* ignore */ } }
    try { rec.resolve(result) } catch (e) { /* ignore */ }
  }
  function finish(rec, result) {
    settle(rec, result)
    if (cur === rec) { cur = null; setSpeaking(false) }
  }

  // 延遲期滿：真的建立 utterance 並交給引擎
  function begin(rec) {
    rec.delayId = null
    if (rec.done || cur !== rec) return
    try {
      const utt = new rec.Utt(rec.text)
      utt.lang = rec.lang
      utt.rate = rec.rate
      utt.pitch = rec.pitch
      utt.volume = rec.volume
      const v = pickVoice(rec.lang)
      if (v) utt.voice = v
      utt.onend = () => finish(rec, 'done')
      utt.onerror = (ev) => {
        const code = String((ev && (ev.error || ev.name)) || '').toLowerCase()
        finish(rec, code === 'interrupted' || code === 'canceled' || code === 'cancelled' ? 'cancelled' : 'error')   // 'not-allowed' 等一律 'error'
      }
      rec.utt = utt
      rec.safetyId = sched(() => {
        if (rec.done) return
        try { rec.synth.cancel() } catch (e) { /* ignore */ }
        finish(rec, 'error')
      }, estimateSpeechMs(rec.text, rec.lang, rec.rate))
      try { if (rec.synth.paused && typeof rec.synth.resume === 'function') rec.synth.resume() } catch (e) { /* ignore */ }
      rec.synth.speak(utt)
    } catch (e) {
      finish(rec, 'error')
    }
  }

  function speak(text, opts) {
    const clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
    if (!clean) return Promise.resolve('unsupported')
    const e = env()
    if (!e) return Promise.resolve('unsupported')
    const o = opts && typeof opts === 'object' ? opts : {}
    const lang = typeof o.lang === 'string' && o.lang.trim() ? o.lang.trim() : (locale() === 'en' ? 'en-US' : 'zh-TW')
    return new Promise((resolve) => {
      const prev = cur
      const rec = { resolve, synth: e.synth, Utt: e.Utt, text: clean, lang, rate: clampNum(o.rate, 1, 0.1, 10), pitch: clampNum(o.pitch, 1, 0, 2), volume: clampNum(o.volume, 1, 0, 1), utt: null, delayId: null, safetyId: null, done: false }
      cur = rec                                   // 先換掉 cur：前一句的 finish 不會把 speaking 閃成 false
      if (prev) settle(prev, 'cancelled')
      setSpeaking(true)
      if (rec.done) return                        // 訂閱者在通知裡就 cancel 了
      try { startWatch(e.synth); pickVoice(lang) } catch (err) { /* 暖身失敗無妨：begin 時會再挑一次 */ }
      try { e.synth.cancel() } catch (err) { /* ignore */ }
      try { rec.delayId = sched(() => begin(rec), CANCEL_DELAY_MS) } catch (err) { finish(rec, 'error') }
    })
  }

  function cancel() {
    if (cur) finish(cur, 'cancelled')
    const synth = readSynth()
    if (synth) { try { synth.cancel() } catch (e) { /* ignore */ } }
  }

  function dispose() {
    cancel()
    stopWatch()
    voices = []
    subs.clear()
  }

  return {
    supported: () => !!env(),
    speak,
    cancel,
    speaking: () => flag,
    onChange: (cb) => {
      if (typeof cb !== 'function') return () => {}
      subs.add(cb)
      return () => { subs.delete(cb) }
    },
    pickVoice,
    dispose,
    // 【iOS Safari 解鎖——介面契約，由旁白模組的實作者填入】
    //   unlock(text?)                 → Promise<'done'|'error'|'unsupported'>：在「使用者手勢」內念一句很短的確認語（預設「旁白已開啟」/ "Narration on"），讓 iOS 之後的 speak() 被允許；成功後 isUnlocked() 為 true
    //   isUnlocked()                  → boolean（這個頁面是否已成功念過一次）
    //   unlockOnFirstGesture(win?)    → off()：註冊一次性的 capture pointerdown / keydown 監聽，第一次使用者手勢時無聲解鎖（念空白 / 極小音量，不出聲）；用於 ?speak=1 沒人碰過頁面的情況
    unlock: () => Promise.resolve('unsupported'),
    isUnlocked: () => false,
    unlockOnFirstGesture: () => () => {},
  }
}

export const narrator = createNarrator()

// 共用實例的 pickVoice 捷徑（等同 narrator.pickVoice(lang)）
export const pickVoice = (lang) => narrator.pickVoice(lang)
