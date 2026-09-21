// 裝置診斷頁的「裝置備註」（選填）：純邏輯，node 可測。
//   展前「真機驗證日」要在很多支手機 / 平板上各跑一輪，報告裡得有「這是哪一支手機」。欄位：裝置型號、作業系統與版本、瀏覽器與版本、測試人、備註。
//   · 只有使用者填了的欄位才會進報告（noteForReport）；全空 → 報告完全沒有「裝置備註」段落。
//   · 草稿存在 localStorage（LS.diagnote，只在這台裝置；不上傳）。儲存介面可注入；讀寫全部 try/catch：隱私模式 / 額度滿 / 沒有 localStorage 都不會丟例外。
//   · 「帶入偵測值」（detectDeviceInfo）：先試 navigator.userAgentData.getHighEntropyValues(['model','platformVersion','fullVersionList'])，
//     不支援 / 失敗 / 逾時 → 退回解析 UA 字串（parseUserAgent，純函式）。只在使用者按下按鈕時才呼叫；函式一律以「方法」呼叫（避免 Illegal invocation）。
//   · 清理：控制字元與雙向控制字元一律去掉（避免把報告的排版弄亂 / 偽裝文字），三個以上的反引號改成單引號（不會破壞 Markdown 的程式碼區塊），長度依欄位上限截斷（以「字」計，不會切壞代理對）。
import { LS, loadLS, saveLS, removeLS } from './persist.js'

export const NOTE_FIELDS = ['model', 'os', 'browser', 'tester', 'memo']
export const NOTE_LIMITS = { model: 80, os: 80, browser: 80, tester: 40, memo: 500 }
export const EMPTY_NOTE = Object.freeze({ model: '', os: '', browser: '', tester: '', memo: '' })
export const NOTE_KEY = LS.diagnote
export const DETECT_TIMEOUT_MS = 2500

const isFn = (v) => typeof v === 'function'
const isObj = (v) => v !== null && typeof v === 'object'
const safe = (fn, fb) => { try { return fn() } catch (e) { return fb } }

// ───────────────────────────── 清理 ─────────────────────────────
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g           // 保留 \t \n \r（後面各欄位再處理）
const FORMAT = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g                    // 零寬字元與雙向控制字元
const clipChars = (s, n) => { const a = Array.from(s); return a.length > n ? a.slice(0, n).join('') : s }

// 單一欄位：非字串 → ''；不 trim（草稿要保留使用者正在輸入的空白）
export function cleanField(field, v) {
  if (typeof v !== 'string' || !(field in NOTE_LIMITS)) return ''
  let s = v.replace(CONTROL, '').replace(FORMAT, '').replace(/`{3,}/g, "'''")
  if (field === 'memo') s = s.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/\n{3,}/g, '\n\n')
  else s = s.replace(/[\r\n\t]+/g, ' ')
  return clipChars(s, NOTE_LIMITS[field])
}

// 整份備註：一律回傳完整的五個欄位（缺的 = ''），多餘的欄位丟掉
export function clampNote(note) {
  const src = isObj(note) ? note : {}
  const out = {}
  for (const f of NOTE_FIELDS) out[f] = cleanField(f, src[f])
  return out
}

export function noteIsEmpty(note) { return noteForReport(note) == null }

// 「帶入偵測值」的合併（純函式）：偵測到的裝置型號 / 系統 / 瀏覽器 → 併進目前的備註（model / os / browser 三個欄位；tester / memo 一律不碰）。
//   client-hints（瀏覽器主動提供、精確）：有偵測到的欄位就覆寫（讓過期的草稿——系統或瀏覽器更新過——能被刷新）。
//   ua（由 UA 字串推測、粗略：型號常常只有「iPhone」）：只補「空白的欄位」，不覆蓋使用者已經填好的（否則精確的「iPhone 15 Pro」會被蓋成「iPhone」，而且沒有復原）。
//   none / 沒有 info → 原樣（clampNote 過）。回傳一定是完整的五個欄位。
export function mergeDetected(note, info) {
  const cur = clampNote(note)
  if (!isObj(info) || info.source === 'none') return cur
  const keepTyped = info.source === 'ua'
  const pick = (f) => {
    const d = typeof info[f] === 'string' ? info[f] : ''
    if (!d) return cur[f]
    return keepTyped && cur[f].trim() ? cur[f] : d
  }
  return clampNote({ ...cur, model: pick('model'), os: pick('os'), browser: pick('browser') })
}

// 報告用：只留「有填」的欄位（trim 後非空）；全空 → null（報告不出現該段落）
export function noteForReport(note) {
  const c = clampNote(note)
  const out = {}
  for (const f of NOTE_FIELDS) {
    let s = c[f]
    s = f === 'memo' ? s.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/^\s+|\s+$/g, '') : s.trim()
    if (s) out[f] = s
  }
  return Object.keys(out).length ? out : null
}

// ───────────────────────────── 草稿存取 ─────────────────────────────
const defaultStorage = { get: (k) => loadLS(k, null), set: (k, v) => saveLS(k, v), remove: (k) => removeLS(k) }

export function loadNote(storage = defaultStorage) {
  try { return clampNote(storage.get(NOTE_KEY)) } catch (e) { return { ...EMPTY_NOTE } }
}
// 全空 → 直接移除紀錄（不留空殼）。回傳是否成功（隱私模式 / 額度滿 → false，不丟例外）。
export function saveNote(note, storage = defaultStorage) {
  try {
    const c = clampNote(note)
    if (noteIsEmpty(c)) { storage.remove(NOTE_KEY); return true }
    storage.set(NOTE_KEY, c)
    return true
  } catch (e) { return false }
}
export function clearNote(storage = defaultStorage) {
  try { storage.remove(NOTE_KEY); return true } catch (e) { return false }
}

// ───────────────────────────── 由 UA 字串推測（純函式）─────────────────────────────
// 只做「常見瀏覽器 / 系統」的判讀，認不出來的欄位回 ''（使用者自己填）。opts：{ maxTouchPoints }（桌面版 Safari 的 iPad 靠它辨認）
export function parseUserAgent(ua, opts = {}) {
  const s = typeof ua === 'string' ? ua : ''
  const touch = typeof opts.maxTouchPoints === 'number' ? opts.maxTouchPoints : 0
  let model = '', os = ''
  let m
  if ((m = /\b(iPhone|iPad|iPod)\b[^)]*?\bOS (\d+)[_.](\d+)(?:[_.](\d+))?/.exec(s))) {
    model = m[1]
    os = `${m[1] === 'iPad' ? 'iPadOS' : 'iOS'} ${m[2]}.${m[3]}${m[4] ? '.' + m[4] : ''}`
  } else if (/\b(iPhone|iPad|iPod)\b/.test(s)) {
    model = /\b(iPhone|iPad|iPod)\b/.exec(s)[1]
    os = model === 'iPad' ? 'iPadOS' : 'iOS'
  } else if ((m = /\bAndroid (\d+(?:\.\d+)*)(?:; ([^;)]+?))?(?: Build\/[^;)]*)?[;)]/.exec(s))) {
    os = `Android ${m[1]}`
    const name = (m[2] || '').trim()
    if (name && !/^(K|wv|U|Mobile|Linux)$/i.test(name)) model = name
  } else if (/\bAndroid\b/.test(s)) os = 'Android'
  else if (/\bCrOS\b/.test(s)) { model = 'Chromebook'; os = 'ChromeOS' }
  else if (/\bMacintosh\b/.test(s)) {
    if (touch > 1) { model = 'iPad'; os = 'iPadOS' }                       // iPad 的 Safari 預設回報成 Mac：有多點觸控 = iPad
    else { model = 'Mac'; os = (m = /Mac OS X (\d+)[_.](\d+)(?:[_.](\d+))?/.exec(s)) ? `macOS ${m[1]}.${m[2]}${m[3] ? '.' + m[3] : ''}` : 'macOS' }
  } else if ((m = /\bWindows NT (\d+)\.(\d+)/.exec(s))) {
    os = m[1] === '10' ? 'Windows 10 / 11' : `Windows NT ${m[1]}.${m[2]}`
    model = 'PC'
  } else if (/\bLinux\b/.test(s)) os = 'Linux'

  let browser = ''
  if ((m = /\bEdgA?\/([\d.]+)/.exec(s)) || (m = /\bEdgiOS\/([\d.]+)/.exec(s))) browser = `Edge ${m[1]}`
  else if ((m = /\bOPR\/([\d.]+)/.exec(s))) browser = `Opera ${m[1]}`
  else if ((m = /\bSamsungBrowser\/([\d.]+)/.exec(s))) browser = `Samsung Internet ${m[1]}`
  else if ((m = /\bFxiOS\/([\d.]+)/.exec(s))) browser = `Firefox (iOS) ${m[1]}`
  else if ((m = /\bCriOS\/([\d.]+)/.exec(s))) browser = `Chrome (iOS) ${m[1]}`
  else if ((m = /\bFirefox\/([\d.]+)/.exec(s))) browser = `Firefox ${m[1]}`
  else if ((m = /\bChrome\/([\d.]+)/.exec(s))) browser = `Chrome ${m[1]}`
  else if ((m = /\bVersion\/([\d.]+)[^)]*\bSafari\//.exec(s)) || (m = /\bVersion\/([\d.]+).*\bSafari\//.exec(s))) browser = `Safari ${m[1]}`
  return { model: clipChars(model, NOTE_LIMITS.model), os: clipChars(os, NOTE_LIMITS.os), browser: clipChars(browser, NOTE_LIMITS.browser) }
}

// 高熵值（User-Agent Client Hints）→ 欄位。platform / platformVersion 合成作業系統（Windows 的 platformVersion 主版號 ≥ 13 = Windows 11）。
export function fromClientHints(values, platform) {
  const v = isObj(values) ? values : {}
  const model = typeof v.model === 'string' ? v.model.trim() : ''
  const plat = typeof v.platform === 'string' && v.platform ? v.platform : (typeof platform === 'string' ? platform : '')
  const pv = typeof v.platformVersion === 'string' ? v.platformVersion.trim() : ''
  let os = ''
  if (plat) {
    if (plat === 'Windows' && pv) { const major = parseInt(pv, 10); os = Number.isFinite(major) ? (major >= 13 ? 'Windows 11' : 'Windows 10') : 'Windows' }
    else os = pv ? `${plat} ${pv}` : plat
  }
  let browser = ''
  const list = Array.isArray(v.fullVersionList) ? v.fullVersionList.filter((b) => isObj(b) && typeof b.brand === 'string' && typeof b.version === 'string') : []
  const real = list.filter((b) => !/not.?a.?brand|^chromium$/i.test(b.brand))
  const pick = real[0] || list.find((b) => /^chromium$/i.test(b.brand)) || null
  if (pick) browser = `${pick.brand} ${pick.version}`
  return { model: clipChars(model, NOTE_LIMITS.model), os: clipChars(os, NOTE_LIMITS.os), browser: clipChars(browser, NOTE_LIMITS.browser) }
}

// 「帶入偵測值」：env = { nav, setTimeout, clearTimeout }（可注入假物件）。永遠 resolve（不丟例外）：
//   → { model, os, browser, source: 'client-hints' | 'ua' | 'none' }；source 說明值從哪來，欄位認不出來 = ''。
export async function detectDeviceInfo(env = {}, timeoutMs = DETECT_TIMEOUT_MS) {
  const nav = env && env.nav
  const ua = safe(() => (nav && typeof nav.userAgent === 'string' ? nav.userAgent : ''), '')
  const touch = safe(() => (nav && typeof nav.maxTouchPoints === 'number' ? nav.maxTouchPoints : 0), 0)
  const fromUa = parseUserAgent(ua, { maxTouchPoints: touch })
  const uad = safe(() => (nav ? nav.userAgentData : null), null)
  if (uad && isFn(safe(() => uad.getHighEntropyValues, null))) {
    try {
      const values = await withTimeout(env, uad.getHighEntropyValues(['model', 'platformVersion', 'fullVersionList']), timeoutMs)   // 以方法呼叫
      const hints = fromClientHints(values, safe(() => uad.platform, ''))
      // 只有「平台名稱」（沒有版本號）的作業系統不比 UA 好：UA 有版本就用 UA 的；高熵值真的提供了型號 / 版本 / 瀏覽器才算「來自裝置資訊」
      const osOk = /\d/.test(hints.os)
      const merged = { model: hints.model || fromUa.model, os: osOk ? hints.os : (fromUa.os || hints.os), browser: hints.browser || fromUa.browser }
      if (hints.model || osOk || hints.browser) return { ...merged, source: 'client-hints' }
    } catch (e) { /* 被拒 / 逾時 / 不支援：退回 UA */ }
  }
  const any = fromUa.model || fromUa.os || fromUa.browser
  return { ...fromUa, source: any ? 'ua' : 'none' }
}

function withTimeout(env, promise, ms) {
  return new Promise((resolve, reject) => {
    // 一律「以方法呼叫」（env.setTimeout(…) / globalThis.setTimeout(…)）：原生計時器脫離 window 呼叫會丟 Illegal invocation
    const set = (fn, t) => (env && isFn(env.setTimeout) ? env.setTimeout(fn, t) : globalThis.setTimeout(fn, t))
    const clear = (id) => { if (env && isFn(env.clearTimeout)) env.clearTimeout(id); else globalThis.clearTimeout(id) }
    let done = false
    const timer = set(() => { if (done) return; done = true; reject(new Error('timeout')) }, ms)
    Promise.resolve(promise).then(
      (v) => { if (done) return; done = true; clear(timer); resolve(v) },
      (e) => { if (done) return; done = true; clear(timer); reject(e) },
    )
  })
}
