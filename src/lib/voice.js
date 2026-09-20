// 語音辨識包裝（Web Speech API：SpeechRecognition / webkitSpeechRecognition）。
// 只做「收音 → 逐字稿 → 指令事件」與生命週期管理；指令表與比對在 lib/voiceCommands.js，動作與畫面在 services/VoiceService.jsx。
//   createVoice(deps) → { getState, subscribe, onCommand, start, stop, setLang, suspend, resume, destroy }
//   getVoice()        → 全站唯一的實例（Section 與 Service 共用）
// 設計重點：
//   · continuous + interimResults：用 interim 結果就偵測「新出現」的關鍵詞（低延遲）；重複事件由 voiceCommands 的 tracker 去重 + 同一指令 1.5 秒冷卻。
//   · onend 自動重啟（Chrome 靜音一段時間會結束）；正常結束 250ms 後重啟，失敗用退避（0.4 / 0.8 / 1.6 / 3.2 秒…）；連續失敗 5 次就停用並提示。
//   · 每次 spawn 都有世代編號：stop / 換語言 / 暫停後，舊實例遲到的事件一律忽略；stop() 會拔掉所有 handler 並 abort()，麥克風才會真的放掉。
//   · 只在使用者呼叫 start()（按開關）之後才建立辨識器與請求權限；不持久化「已開啟」，重新整理後一定是關閉。
//   · 不碰 audio/mic.js（吹氣＝風）：這裡不呼叫 getUserMedia，兩者互不干涉。
//   · 全部瀏覽器 API（建構子、時鐘、計時器）都可注入，Node 測試用假物件。
import { T } from '../i18n/index.js'
import { createCommandTracker } from './voiceCommands.js'

export const MAX_FAILS = 5                        // 連續失敗幾次就停用
export const BACKOFF_MS = [400, 800, 1600, 3200, 6400]
export const RESTART_MS = 250                     // 正常結束（Chrome 靜音逾時）後的重啟間隔
export const LANG_RESTART_MS = 250                // 換語言：舊實例 abort 之後等一下再開新的
export const MIN_OK_MS = 1200                     // 一次 session 撐過這麼久（或有辨識結果 / 只是沒人說話）才算成功

// 錯誤碼 → 提示文字（T() 標記，顯示時再 t()）。
//   denied 麥克風權限被拒；service 瀏覽器的辨識服務被擋（Safari 沒開聽寫 / Siri）；network 連不上（Chrome 需要網路）；
//   nomic 找不到麥克風；language 不支援這個語言；unsupported 沒有 SpeechRecognition；failed 連續失敗
export const ERROR_TEXT = {
  denied: T('麥克風權限被拒絕。請在瀏覽器的網站設定允許使用麥克風，再重新開啟。'),
  service: T('瀏覽器的語音辨識服務目前無法使用（Safari 請到系統設定開啟「聽寫」與 Siri）。'),
  network: T('連不上語音辨識服務：Chrome 的語音辨識需要網路連線。'),
  nomic: T('找不到可用的麥克風。'),
  language: T('這個瀏覽器不支援目前語言的語音辨識。'),
  unsupported: T('這個瀏覽器不支援語音辨識（例如 Firefox）；請改用 Chrome、Edge 或 Safari。'),
  failed: T('語音辨識連續失敗，已自動關閉；稍後可以再開啟。'),
}
const FATAL = { 'not-allowed': 'denied', 'service-not-allowed': 'service', 'audio-capture': 'nomic', 'language-not-supported': 'language' }

export function getRecognitionCtor(w) {
  const win = w || (typeof window !== 'undefined' ? window : null)
  return (win && (win.SpeechRecognition || win.webkitSpeechRecognition)) || null
}
export const isVoiceSupported = (w) => !!getRecognitionCtor(w)

const defaultNow = () => { try { return performance.now() } catch (e) { return Date.now() } }

export function createVoice(deps = {}) {
  const {
    getCtor = () => getRecognitionCtor(),
    now = defaultNow,
    setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn = (id) => clearTimeout(id),
    lang: initialLang = 'zh-TW',
    tracker = createCommandTracker({ lang: initialLang }),
  } = deps

  let state = { supported: !!getCtor(), enabled: false, suspended: false, listening: false, lang: initialLang, error: null, lastText: '' }
  const subs = new Set()
  const cmdSubs = new Set()
  let rec = null, timer = 0, gen = 0, fails = 0
  let startedAt = 0, gotResult = false, benign = false, softErr = null

  function set(patch) {
    let changed = false
    for (const k in patch) if (state[k] !== patch[k]) { changed = true; break }
    if (!changed) return
    state = { ...state, ...patch }
    for (const cb of [...subs]) { try { cb() } catch (e) { /* 訂閱者的錯不能拖垮辨識 */ } }
  }
  const clearTimer = () => { if (timer) { clearTimeoutFn(timer); timer = 0 } }
  const schedule = (ms, fn) => { clearTimer(); timer = setTimeoutFn(() => { timer = 0; fn() }, ms) }

  // 放掉目前的辨識實例：世代 +1（遲到事件失效）、拔掉 handler、abort（立即釋放麥克風，不等最後結果）
  function release() {
    gen++
    const r = rec
    rec = null
    if (r) {
      r.onstart = r.onresult = r.onerror = r.onend = null
      try { r.abort() } catch (e) { /* 已結束 */ }
    }
  }

  function giveUp(code) {
    clearTimer(); release(); tracker.reset(); fails = 0
    set({ enabled: false, suspended: false, listening: false, error: code })
  }

  function handleResult(e) {
    const res = e && e.results
    if (!res) return
    const items = []
    for (let i = e.resultIndex || 0; i < res.length; i++) {
      const r = res[i]
      const alt = r && r[0]
      if (!alt) continue
      items.push({ index: i, transcript: alt.transcript || '', isFinal: !!r.isFinal })
      if (r.isFinal && alt.transcript && alt.transcript.trim()) set({ lastText: alt.transcript.trim().slice(0, 80) })
    }
    if (!items.length) return
    if (!gotResult) { gotResult = true; fails = 0; if (state.error) set({ error: null }) }   // 有辨識結果 = 這條路是通的
    const fired = tracker.feed(items, now())
    for (const f of fired) for (const cb of [...cmdSubs]) { try { cb(f) } catch (err) { /* 動作出錯不影響辨識 */ } }
  }

  function handleError(code) {
    if (code === 'no-speech') { benign = true; return }          // 沒人說話：正常，onend 後照常重啟
    if (FATAL[code]) { giveUp(FATAL[code]); return }              // 權限 / 沒麥克風 / 語言不支援：重試沒用
    softErr = code === 'network' ? 'network' : (code || 'failed') // network / aborted（被別的 App 或分頁搶走）/ 其他：退避重試
  }

  function handleEnd() {
    rec = null
    if (!state.enabled || state.suspended) { set({ listening: false }); return }
    const ok = benign || (!softErr && (gotResult || now() - startedAt >= MIN_OK_MS))
    // 正常結束（靜音逾時）：對使用者而言仍是「收音中」，只是內部換一個新實例，所以 listening 維持 true，徽章不閃
    if (ok) { fails = 0; if (state.error) set({ error: null }); schedule(RESTART_MS, spawn); return }
    set({ listening: false })
    fails++
    if (softErr === 'network') set({ error: 'network' })
    if (fails >= MAX_FAILS) { giveUp(softErr === 'network' ? 'network' : 'failed'); return }
    schedule(BACKOFF_MS[Math.min(fails - 1, BACKOFF_MS.length - 1)], spawn)
  }

  function spawn() {
    clearTimer()
    if (!state.enabled || state.suspended || rec) return
    const Ctor = getCtor()
    if (!Ctor) { giveUp('unsupported'); return }
    let r
    try { r = new Ctor() } catch (e) { giveUp('failed'); return }
    const my = ++gen
    rec = r
    startedAt = now(); gotResult = false; benign = false; softErr = null
    tracker.setLang(state.lang)
    tracker.reset()                                                // 新 session 的 result index 從 0 重來（冷卻保留）
    try {
      r.lang = state.lang
      r.continuous = true
      r.interimResults = true
      r.maxAlternatives = 1
    } catch (e) { /* 某些實作屬性唯讀：略過 */ }
    r.onstart = () => { if (my === gen) set({ listening: true }) }
    r.onresult = (e) => { if (my === gen) handleResult(e) }
    r.onerror = (e) => { if (my === gen) handleError(e && e.error) }
    r.onend = () => { if (my === gen) handleEnd() }
    try { r.start() } catch (e) {
      // 同步丟例外（例如 InvalidStateError）：當作一次失敗，退避後重試
      rec = null; r.onstart = r.onresult = r.onerror = r.onend = null
      fails++
      if (fails >= MAX_FAILS) giveUp('failed')
      else schedule(BACKOFF_MS[Math.min(fails - 1, BACKOFF_MS.length - 1)], spawn)
    }
  }

  // 開啟收音。必須在使用者手勢（點開關）裡同步呼叫，瀏覽器才會跳出麥克風權限詢問。
  function start() {
    if (!state.supported || !getCtor()) { set({ supported: false, error: 'unsupported' }); return false }
    if (state.enabled) return true
    fails = 0
    set({ enabled: true, suspended: false, listening: false, error: null })
    spawn()
    return true
  }
  // 關閉收音並「真的」釋放麥克風。
  function stop() {
    clearTimer(); release(); tracker.reset({ cooldowns: true }); fails = 0
    set({ enabled: false, suspended: false, listening: false, error: null, lastText: '' })
  }
  // 辨識語言（'zh-TW' / 'en-US'）：收音中會用新語言重啟。
  function setLang(tag) {
    if (!tag || tag === state.lang) return
    tracker.setLang(tag)
    set({ lang: tag })
    if (state.enabled && !state.suspended) {
      clearTimer(); release(); set({ listening: false })
      schedule(LANG_RESTART_MS, spawn)
    }
  }
  // 分頁進背景 / 螢幕鎖定：先放掉麥克風（隱私），回到前景再接續（權限已給過，不必手勢）。
  function suspend() {
    if (!state.enabled || state.suspended) return
    clearTimer(); release(); tracker.reset()
    set({ suspended: true, listening: false })
  }
  function resume() {
    if (!state.enabled || !state.suspended) return
    fails = 0
    set({ suspended: false })
    spawn()
  }
  function destroy() { stop(); subs.clear(); cmdSubs.clear() }

  return {
    getState: () => state,
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb) },
    onCommand(cb) { cmdSubs.add(cb); return () => cmdSubs.delete(cb) },
    start, stop, setLang, suspend, resume, destroy,
  }
}

let singleton = null
export function getVoice() { return singleton || (singleton = createVoice()) }
