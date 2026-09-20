// 資料導覽測試共用的「會檢查 this 的假環境」（不是測試檔：檔名不含 .test.，node --test 不會直接執行它）。
// 為什麼要檢查 this：瀏覽器裡把原生方法存進變數 / 物件屬性再「脫離原物件」呼叫（const f = navigator.clipboard.writeText; f(x)、
// const o = { setTimeout }; o.setTimeout(fn) 、speechSynthesis.speak 同理）會丟 TypeError: Illegal invocation；Node 不會，所以以前 Node 測試全綠、瀏覽器一開就崩潰。
// 這裡的假物件在 this 不對時一樣丟同樣的錯，讓這類寫法在 Node 測試裡就現形。
export const illegal = () => new TypeError('Illegal invocation')

// ---- 假計時器：模仿 window.setTimeout / clearTimeout——只能「裸函式」呼叫（this 是 undefined 或全域），掛在別的物件上呼叫就丟例外 ----
export function makeTimers() {
  let id = 0, clock = 0
  const pending = new Map()
  const okThis = (self) => self === undefined || self === globalThis
  function fakeSetTimeout(fn, ms = 0) { if (!okThis(this)) throw illegal(); const k = ++id; pending.set(k, { fn, at: clock + ms }); return k }
  function fakeClearTimeout(k) { if (!okThis(this)) throw illegal(); pending.delete(k) }
  return {
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    pending: () => pending.size,
    advance(ms) {                                                  // 往前撥並依序執行到期的計時器（先到期的先跑；跑的過程中新排的也算）
      const end = clock + ms
      for (;;) {
        let best = null
        for (const [k, v] of pending) if (v.at <= end && (!best || v.at < best[1].at)) best = [k, v]
        if (!best) break
        pending.delete(best[0]); clock = Math.max(clock, best[1].at); best[1].fn()
      }
      clock = end
    },
  }
}

// 把假計時器暫時裝成全域的 setTimeout / clearTimeout（測預設的「裸函式包一層」寫法用）。回傳還原函式；務必在 finally 呼叫。
export function installTimers(timers) {
  const a = globalThis.setTimeout, b = globalThis.clearTimeout
  globalThis.setTimeout = timers.setTimeout
  globalThis.clearTimeout = timers.clearTimeout
  return () => { globalThis.setTimeout = a; globalThis.clearTimeout = b }
}

// ---- 假 localStorage（Node 25 有內建的 localStorage getter，沒給檔案路徑會警告 / 不可用，測試一律換成自己的 Map 版）----
export function withStorage(fn, init = {}) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const data = new Map(Object.entries(init))
  const fake = { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => { data.set(k, String(v)) }, removeItem: (k) => { data.delete(k) } }
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true, writable: true })
  try { return fn(data) } finally { if (desc) Object.defineProperty(globalThis, 'localStorage', desc); else delete globalThis.localStorage }
}

// ---- 假剪貼簿環境：{ navigator, document } + 呼叫紀錄 ----
//   clipboard：'ok'（writeText 成功）| 'reject'（被拒）| 'throw'（同步丟）| 'none'（沒有 navigator.clipboard，例如非安全環境）
//   exec：'ok'（execCommand 回 true，且確實有選取到那個 textarea）| 'false'（回 false）| 'throw' | 'none'（沒有 execCommand）
export function makeCopyEnv({ clipboard = 'ok', exec = 'ok' } = {}) {
  const calls = []
  const state = { copied: null, focusLog: [] }
  const clip = {
    writeText(text) {
      if (this !== clip) throw illegal()
      calls.push(['clipboard.writeText', text])
      if (clipboard === 'throw') throw new Error('sync boom')
      if (clipboard === 'reject') return Promise.reject(new Error('NotAllowedError'))
      state.copied = text
      return Promise.resolve()
    },
  }
  const opener = { focus() { state.focusLog.push('restore-focus') } }
  const body = {
    children: [],
    appendChild(el) { if (this !== body) throw illegal(); el.parentNode = body; body.children.push(el); calls.push(['append', el.tagName]); return el },
    removeChild(el) { if (this !== body) throw illegal(); body.children = body.children.filter((x) => x !== el); el.parentNode = null; calls.push(['remove', el.tagName]); return el },
  }
  const doc = {
    body, activeElement: opener,
    createElement(tag) {
      if (this !== doc) throw illegal()
      const el = {
        tagName: String(tag).toUpperCase(), value: '', style: {}, attrs: {}, selected: false, tabIndex: 0, parentNode: null,
        setAttribute(k, v) { el.attrs[k] = v }, focus() { calls.push(['textarea.focus']) }, select() { el.selected = true }, setSelectionRange(a, b) { el.range = [a, b] },
      }
      return el
    },
  }
  if (exec !== 'none') {
    doc.execCommand = function execCommand(cmd) {
      if (this !== doc) throw illegal()
      calls.push(['execCommand', cmd])
      if (exec === 'throw') throw new Error('exec boom')
      if (exec === 'false') return false
      const ta = body.children.find((x) => x.tagName === 'TEXTAREA' && x.selected)
      if (cmd !== 'copy' || !ta) return false
      state.copied = ta.value
      return true
    }
  }
  const nav = clipboard === 'none' ? {} : { clipboard: clip }
  return { navigator: nav, document: doc, calls, state, body, opener }
}

// ---- 假旁白：與 narration.js 的 narrator 同介面（supported / speak / cancel / speaking），方法都檢查 this ----
//   speakMode：'ok'（念到 finish() 才結束）| 'error'（被瀏覽器擋：立刻以 'error' 結束、speaking 為 false）| 'throw'（speak 同步丟例外）| 'reject'（Promise 被 reject）
export function makeNarrator({ supported = true, speakMode = 'ok' } = {}) {
  const log = []
  let speaking = false
  let cur = null
  const n = {
    supported() { if (this !== n) throw illegal(); return supported },
    speak(text, opts) {
      if (this !== n) throw illegal()
      log.push(['speak', text, opts])
      if (speakMode === 'throw') throw new Error('speak boom')
      if (cur) cur('cancelled')                                   // 先取消前一句
      if (speakMode === 'error') return Promise.resolve('error')
      if (speakMode === 'reject') return Promise.reject(new Error('rejected'))
      speaking = true
      return new Promise((res) => { cur = (r) => { cur = null; speaking = false; res(r) } })
    },
    cancel() { if (this !== n) throw illegal(); log.push(['cancel']); if (cur) cur('cancelled'); speaking = false },
    speaking() { if (this !== n) throw illegal(); return speaking },
  }
  return Object.assign(n, {
    log,
    finish() { if (cur) cur('done'); speaking = false },          // 這一句自然念完
    spoken: () => log.filter((x) => x[0] === 'speak').map((x) => x[1]),
    count: (name) => log.filter((x) => x[0] === name).length,
  })
}
