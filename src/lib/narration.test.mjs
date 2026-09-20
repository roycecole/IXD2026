// 語音旁白（lib/narration.js）單元測試。執行：node --test src/lib/narration.test.mjs
// 環境全部以「會檢查 this 的假物件」注入，模擬瀏覽器的 TypeError: Illegal invocation：
//   · FakeSynth / FakeUtterance 用私有欄位當「品牌」——方法若被脫離原物件呼叫（存進變數再呼叫）就丟 TypeError
//   · 假計時器是「裸函式」：this 只能是 undefined / globalThis；掛在別的物件上呼叫（deps.setTimeout(…)）就丟 TypeError（和原生 setTimeout 一樣）
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { loadEnDict } from '../../scripts/i18n-check.mjs'
import { registerEn, setLocale } from '../i18n/index.js'
import narrationEn from '../i18n/en/narration.js'
import {
  createNarrator, narrator, speechText, pickVoice, pickVoiceFrom, estimateSpeechMs,
  CANCEL_DELAY_MS, SAFETY_PAD_MS, MS_PER_CHAR, SPOKEN_UNITS,
} from './narration.js'

const flush = () => new Promise((r) => setImmediate(r))   // 讓已 resolve 的 Promise 的 then 都跑完（用真的 setImmediate，不受假計時器影響）

// ---- 假 speechSynthesis ----
class FakeSynth {
  #brand = true
  static #check(o) { if (o === null || typeof o !== 'object' || !(#brand in o)) throw new TypeError('Illegal invocation') }
  constructor({ voices = [] } = {}) {
    this.voices = voices; this.spoken = []; this.cancels = 0; this.resumes = 0; this.paused = false
    this.speakError = null; this.listeners = new Map(); this.adds = 0; this.removes = 0
  }
  speak(u) { FakeSynth.#check(this); if (this.speakError) throw this.speakError; this.spoken.push(u) }
  cancel() { FakeSynth.#check(this); this.cancels++ }
  resume() { FakeSynth.#check(this); this.resumes++ }
  getVoices() { FakeSynth.#check(this); return this.voices }
  addEventListener(type, fn) { FakeSynth.#check(this); this.adds++; if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn) }
  removeEventListener(type, fn) { FakeSynth.#check(this); this.removes++; const s = this.listeners.get(type); if (s) s.delete(fn) }
  listenerCount(type = 'voiceschanged') { const s = this.listeners.get(type); return s ? s.size : 0 }
  dispatch(type) { for (const fn of [...(this.listeners.get(type) || [])]) fn({ type }) }
  get last() { return this.spoken[this.spoken.length - 1] }
}

// ---- 假 SpeechSynthesisUtterance ----
class FakeUtterance {
  #brand = true
  constructor(text) {
    if (new.target !== FakeUtterance) throw new TypeError('Illegal constructor')
    this.text = text; this.lang = ''; this.rate = 1; this.pitch = 1; this.volume = 1; this.voice = null
    this.onend = null; this.onerror = null; this.onstart = null
  }
  get brand() { return this.#brand }
}

// ---- 假計時器（裸函式；this 不對就丟 TypeError）----
function makeClock() {
  let now = 0, seq = 0
  const timers = new Map()
  const bare = (fn) => function (...a) { if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation'); return fn(...a) }
  return {
    setTimeout: bare((fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id }),
    clearTimeout: bare((id) => { timers.delete(id) }),
    advance(ms) {
      const end = now + ms
      for (;;) {
        let pick = null
        for (const [id, x] of timers) if (x.at <= end && (!pick || x.at < pick.x.at)) pick = { id, x }
        if (!pick) break
        timers.delete(pick.id); now = Math.max(now, pick.x.at); pick.x.fn()
      }
      now = end
    },
    pending: () => timers.size,
    now: () => now,
  }
}

function makeEnv({ voices = [], locale = 'zh' } = {}) {
  const clock = makeClock()
  const synth = new FakeSynth({ voices })
  const state = { locale }
  const n = createNarrator({ synth: () => synth, Utterance: () => FakeUtterance, getLocale: () => state.locale, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
  return { n, synth, clock, state }
}
// 送出一句並等過「cancel 後的延遲」，讓 utterance 真的交給引擎
const startSpeak = (env, text, opts) => { const p = env.n.speak(text, opts); env.clock.advance(CANCEL_DELAY_MS); return p }
const V = (lang, localService = false, name = '') => ({ lang, localService, name: name || `${lang}${localService ? '-local' : ''}`, voiceURI: `uri:${lang}:${localService}:${name}`, default: false })

// ===============================================================================================
// 假環境自己要會抓 this（否則後面的測試沒有意義）
// ===============================================================================================
test('假環境：脫離原物件呼叫會丟 Illegal invocation（模擬瀏覽器），正常呼叫不會', () => {
  const synth = new FakeSynth(), clock = makeClock()
  const { speak } = synth
  assert.throws(() => speak(new FakeUtterance('x')), /Illegal invocation/)
  assert.throws(() => { const g = synth.getVoices; g() }, TypeError)
  assert.doesNotThrow(() => synth.speak(new FakeUtterance('x')))
  const holder = { st: clock.setTimeout }
  assert.throws(() => holder.st(() => {}, 1), /Illegal invocation/)
  assert.doesNotThrow(() => { const st = clock.setTimeout; st(() => {}, 1) })
  assert.throws(() => FakeUtterance('x'), TypeError)
})

// ===============================================================================================
// supported()
// ===============================================================================================
test('supported：synth 與 Utterance 都在才 true；缺任何一個、或存取丟例外 → false', () => {
  const synth = new FakeSynth()
  assert.equal(createNarrator({ synth: () => synth, Utterance: () => FakeUtterance }).supported(), true)
  assert.equal(createNarrator({ synth: () => null, Utterance: () => FakeUtterance }).supported(), false)
  assert.equal(createNarrator({ synth: () => synth, Utterance: () => null }).supported(), false)
  assert.equal(createNarrator({ synth: null, Utterance: () => FakeUtterance }).supported(), false)
  assert.equal(createNarrator({ synth: () => synth, Utterance: null }).supported(), false)
  assert.equal(createNarrator({ synth: () => { throw new Error('denied') }, Utterance: () => FakeUtterance }).supported(), false)
  assert.equal(createNarrator({ synth: () => synth, Utterance: () => { throw new Error('denied') } }).supported(), false)
  const boom = { get speechSynthesis() { throw new Error('blocked') } }
  assert.equal(createNarrator({ synth: () => boom.speechSynthesis, Utterance: () => FakeUtterance }).supported(), false)
})

test('supported：Utterance 可以是類別、箭頭工廠、一般函式工廠，也可以是 ES5 風格建構子；synth 也可以直接給物件', async () => {
  const synth = new FakeSynth()
  function factory() { return FakeUtterance }
  function Es5Utterance(text) { this.text = text; this.onend = null; this.onerror = null }
  for (const [name, Utterance] of [['class', FakeUtterance], ['arrow', () => FakeUtterance], ['function 工廠', factory], ['ES5 建構子', Es5Utterance]]) {
    const clock = makeClock()
    const s = new FakeSynth()
    const n = createNarrator({ synth: s, Utterance, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
    assert.equal(n.supported(), true, name)
    const p = n.speak('測試'); clock.advance(CANCEL_DELAY_MS)
    assert.equal(s.spoken.length, 1, name); assert.equal(s.last.text, '測試', name)
    s.last.onend(); assert.equal(await p, 'done', name)
  }
  assert.equal(createNarrator({ synth, Utterance: () => 42 }).supported(), false)
})

test('supported：未注入時，在「呼叫當下」才讀 window / globalThis 的 speechSynthesis（先建立、後出現也行）', () => {
  const clock = makeClock()
  const n = createNarrator({ setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
  assert.equal(n.supported(), false)
  const synth = new FakeSynth()
  globalThis.window = { speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance }
  try {
    assert.equal(n.supported(), true)
    const p = n.speak('你好'); clock.advance(CANCEL_DELAY_MS)
    assert.equal(synth.spoken.length, 1)
    synth.last.onend()
    return p.then((r) => assert.equal(r, 'done'))
  } finally { delete globalThis.window; assert.equal(n.supported(), false) }
})

test('supported：只有 globalThis.speechSynthesis（沒有 window）也認得', () => {
  const n = createNarrator()
  globalThis.speechSynthesis = new FakeSynth(); globalThis.SpeechSynthesisUtterance = FakeUtterance
  try { assert.equal(n.supported(), true) } finally { delete globalThis.speechSynthesis; delete globalThis.SpeechSynthesisUtterance }
  assert.equal(n.supported(), false)
})

test('所有方法可以脫離 narrator 物件呼叫（不依賴 this）', async () => {
  const { n, synth, clock } = makeEnv()
  const { supported, speak, cancel, speaking, onChange, pickVoice, dispose } = n
  assert.equal(supported(), true)
  const off = onChange(() => {})
  const p = speak('你好'); clock.advance(CANCEL_DELAY_MS)
  assert.equal(speaking(), true); assert.equal(pickVoice('zh-TW'), null)
  cancel(); assert.equal(await p, 'cancelled')
  off(); dispose()
  assert.equal(synth.spoken.length, 1)
})

// ===============================================================================================
// speak：done / lang / 參數
// ===============================================================================================
test('speak：成功 → onend → done；utterance 的 lang / rate / pitch / volume 正確、計時器全清', async () => {
  const { n, synth, clock } = makeEnv()
  const p = n.speak('  水位 63.4%，\n海水高度 0.63  ')
  assert.equal(n.speaking(), true)
  assert.equal(synth.spoken.length, 0)                  // 還在 cancel 後的延遲裡
  clock.advance(CANCEL_DELAY_MS)
  assert.equal(synth.spoken.length, 1)
  const u = synth.last
  assert.equal(u.text, '水位 63.4%， 海水高度 0.63')     // 首尾空白去掉、空白折成一格
  assert.deepEqual([u.lang, u.rate, u.pitch, u.volume], ['zh-TW', 1, 1, 1])
  assert.equal(u.voice, null)                           // 沒有聲音清單 → 不設 voice，只靠 lang
  u.onend()
  assert.equal(await p, 'done')
  assert.equal(n.speaking(), false)
  assert.equal(clock.pending(), 0)
})

test('speak：lang 依語系（zh → zh-TW、en → en-US）；opts.lang / rate / pitch / volume 覆寫並限制範圍', async () => {
  const env = makeEnv({ locale: 'en' })
  let p = startSpeak(env, 'Hello sea'); assert.equal(env.synth.last.lang, 'en-US'); env.synth.last.onend(); await p
  env.state.locale = 'zh'
  p = startSpeak(env, '你好'); assert.equal(env.synth.last.lang, 'zh-TW'); env.synth.last.onend(); await p
  p = startSpeak(env, 'Bonjour', { lang: 'fr-FR', rate: 1.5, pitch: 0.5, volume: 0.25 })
  assert.deepEqual([env.synth.last.lang, env.synth.last.rate, env.synth.last.pitch, env.synth.last.volume], ['fr-FR', 1.5, 0.5, 0.25]); env.synth.last.onend(); await p
  p = startSpeak(env, '極端值', { rate: 99, pitch: -3, volume: 7 })
  assert.deepEqual([env.synth.last.rate, env.synth.last.pitch, env.synth.last.volume], [10, 0, 1]); env.synth.last.onend(); await p
  p = startSpeak(env, '壞值', { rate: 'fast', pitch: null, volume: NaN, lang: 42 })
  assert.deepEqual([env.synth.last.lang, env.synth.last.rate, env.synth.last.pitch, env.synth.last.volume], ['zh-TW', 1, 1, 1]); env.synth.last.onend(); await p
  env.state.locale = 'ja'                                // 不認得的語系當 zh 處理（getLocale 只有 zh / en）
  p = startSpeak(env, '日本'); assert.equal(env.synth.last.lang, 'zh-TW'); env.synth.last.onend(); await p
})

test('speak：空白文字或不支援 → unsupported（不丟例外、不碰引擎）', async () => {
  const { n, synth, clock } = makeEnv()
  for (const bad of ['', '   ', '\n\t', null, undefined]) assert.equal(await n.speak(bad), 'unsupported')
  const okp = n.speak('x', null); clock.advance(CANCEL_DELAY_MS); synth.last.onend()   // opts 給 null 也行
  assert.equal(await okp, 'done')
  assert.equal(synth.cancels, 1)                        // 只有上面那句真的送出的一次
  const off = createNarrator({ synth: () => null, Utterance: () => FakeUtterance })
  assert.equal(await off.speak('你好'), 'unsupported')
  assert.equal(off.speaking(), false)
  assert.doesNotThrow(() => { off.cancel(); off.dispose() })
  const noUtt = createNarrator({ synth: () => synth, Utterance: () => null })
  assert.equal(await noUtt.speak('你好'), 'unsupported')
})

test('speak：數字以外的輸入（數字 / 物件）也不丟例外', async () => {
  const { n, synth, clock } = makeEnv()
  const p = startSpeak({ n, clock }, 12345)
  assert.equal(synth.last.text, '12345'); synth.last.onend(); assert.equal(await p, 'done')
})

// ===============================================================================================
// speak：cancel / 蓋掉 / 錯誤 / 逾時
// ===============================================================================================
test('cancel：進行中的 speak 解決為 cancelled；synth.cancel 被呼叫；狀態與計時器清乾淨；沒有進行中也可安全呼叫', async () => {
  const { n, synth, clock } = makeEnv()
  assert.doesNotThrow(() => n.cancel())                 // 沒有進行中
  const before = synth.cancels
  const p = startSpeak({ n, clock }, '你好，海洋')
  const c1 = synth.cancels
  n.cancel()
  assert.equal(await p, 'cancelled')
  assert.ok(synth.cancels > c1 && c1 > before)
  assert.equal(n.speaking(), false)
  assert.equal(clock.pending(), 0)
  n.cancel(); n.cancel()                                // 重複呼叫也沒事
})

test('下一句蓋掉上一句：上一句 cancelled、下一句照常完成；speaking 不會閃一次 false', async () => {
  const { n, synth, clock } = makeEnv()
  const events = []; n.onChange((v) => events.push(v))
  const p1 = startSpeak({ n, clock }, '第一句')
  const u1 = synth.last
  const staleErr = u1.onerror, staleEnd = u1.onend          // 模擬「瀏覽器晚一步才送來的舊事件」
  const p2 = startSpeak({ n, clock }, '第二句')
  assert.equal(await p1, 'cancelled')
  assert.equal(synth.spoken.length, 2)
  assert.equal(n.speaking(), true)
  staleErr({ error: 'interrupted' }); staleEnd()             // 舊 utterance 的遲到事件不能影響新的一句
  await flush()
  assert.equal(n.speaking(), true)
  synth.last.onend()
  assert.equal(await p2, 'done')
  assert.deepEqual(events, [true, false])
  assert.equal(clock.pending(), 0)
})

test('onerror：interrupted / canceled → cancelled；not-allowed 與其他錯誤 → error（不丟例外）；每條路徑都清計時器', async () => {
  for (const [code, want] of [['interrupted', 'cancelled'], ['canceled', 'cancelled'], ['not-allowed', 'error'], ['synthesis-failed', 'error'], ['audio-busy', 'error'], ['network', 'error'], [undefined, 'error']]) {
    const { n, synth, clock } = makeEnv()
    const p = startSpeak({ n, clock }, '你好')
    assert.doesNotThrow(() => synth.last.onerror(code === undefined ? undefined : { error: code }))
    assert.equal(await p, want, String(code))
    assert.equal(n.speaking(), false, String(code))
    assert.equal(clock.pending(), 0, String(code))
  }
})

test('安全逾時：預估時長（zh 260ms/字、en 75ms/字）+ 4 秒仍沒有 onend → cancel 並以 error 解決', async () => {
  const { n, synth, clock } = makeEnv()
  assert.equal(estimateSpeechMs('你好', 'zh-TW'), 2 * MS_PER_CHAR.zh + SAFETY_PAD_MS)
  assert.equal(estimateSpeechMs('hello', 'en-US'), 5 * MS_PER_CHAR.en + SAFETY_PAD_MS)
  assert.equal(estimateSpeechMs('你好', 'zh-TW', 2), 1 * MS_PER_CHAR.zh + SAFETY_PAD_MS)   // 語速越快、預估越短
  assert.equal(MS_PER_CHAR.zh, 260); assert.equal(MS_PER_CHAR.en, 75); assert.equal(SAFETY_PAD_MS, 4000)

  let res = null
  const p = startSpeak({ n, clock }, '你好'); p.then((r) => { res = r })
  const c0 = synth.cancels
  clock.advance(2 * 260 + 4000 - 1); await flush()
  assert.equal(res, null); assert.equal(n.speaking(), true)
  clock.advance(1); await flush()
  assert.equal(res, 'error'); assert.equal(await p, 'error')
  assert.equal(synth.cancels, c0 + 1)                       // 逾時時有 cancel 引擎
  assert.equal(n.speaking(), false); assert.equal(clock.pending(), 0)

  res = null                                                // 英文
  const p2 = startSpeak({ n, clock }, 'hello', { lang: 'en-US' }); p2.then((r) => { res = r })
  clock.advance(5 * 75 + 4000 - 1); await flush(); assert.equal(res, null)
  clock.advance(1); await flush(); assert.equal(res, 'error')
  assert.equal(clock.pending(), 0)
})

test('逾時前收到 onend → done，逾時計時器被清掉（之後推進時間不會誤觸發）', async () => {
  const { n, synth, clock } = makeEnv()
  const p = startSpeak({ n, clock }, '你好')
  clock.advance(1000); synth.last.onend()
  assert.equal(await p, 'done'); assert.equal(clock.pending(), 0)
  const c = synth.cancels; clock.advance(60000); assert.equal(synth.cancels, c)
})

// ===============================================================================================
// Chrome 怪癖：cancel 後要延遲再 speak
// ===============================================================================================
test('speak 先 cancel 前一句，再延遲 CANCEL_DELAY_MS（60ms）才真的 speak', () => {
  const { n, synth, clock } = makeEnv()
  assert.equal(CANCEL_DELAY_MS, 60)
  n.speak('你好')
  assert.equal(synth.cancels, 1); assert.equal(synth.spoken.length, 0)
  clock.advance(CANCEL_DELAY_MS - 1); assert.equal(synth.spoken.length, 0)
  clock.advance(1); assert.equal(synth.spoken.length, 1)
})

test('延遲期間又被 cancel → 不 speak、解決 cancelled、沒有殘留計時器', async () => {
  const { n, synth, clock } = makeEnv()
  const p = n.speak('你好')
  clock.advance(30)
  n.cancel()
  clock.advance(500)
  assert.equal(synth.spoken.length, 0)
  assert.equal(await p, 'cancelled'); assert.equal(n.speaking(), false); assert.equal(clock.pending(), 0)
})

test('延遲期間又來一句 → 只念最後一句；前一句 cancelled', async () => {
  const { n, synth, clock } = makeEnv()
  const p1 = n.speak('第一句'); clock.advance(30)
  const p2 = n.speak('第二句'); clock.advance(CANCEL_DELAY_MS)
  assert.deepEqual(synth.spoken.map((u) => u.text), ['第二句'])
  assert.equal(await p1, 'cancelled')
  synth.last.onend(); assert.equal(await p2, 'done'); assert.equal(clock.pending(), 0)
})

test('引擎 paused 時先 resume（Chrome 有時卡在暫停狀態）', async () => {
  const { n, synth, clock } = makeEnv()
  synth.paused = true
  const p = startSpeak({ n, clock }, '你好'); assert.equal(synth.resumes, 1); synth.last.onend(); await p
})

test('引擎 / 建構子 / 計時器出錯 → error（不丟例外），狀態不卡在 speaking', async () => {
  let env = makeEnv(); env.synth.speakError = new Error('engine down')
  let p = startSpeak(env, '你好')
  assert.equal(await p, 'error'); assert.equal(env.n.speaking(), false); assert.equal(env.clock.pending(), 0)

  const clock = makeClock(), synth = new FakeSynth()
  class BadUtt { constructor() { throw new Error('nope') } }
  const n1 = createNarrator({ synth: () => synth, Utterance: BadUtt, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
  p = n1.speak('你好'); clock.advance(CANCEL_DELAY_MS)
  assert.equal(await p, 'error'); assert.equal(n1.speaking(), false); assert.equal(clock.pending(), 0)

  const n2 = createNarrator({ synth: () => synth, Utterance: () => FakeUtterance, setTimeout: () => { throw new Error('no timers') }, clearTimeout: clock.clearTimeout })
  assert.equal(await n2.speak('你好'), 'error'); assert.equal(n2.speaking(), false)
})

// ===============================================================================================
// speaking / onChange / dispose
// ===============================================================================================
test('speaking / onChange：只在真的變化時通知；取消訂閱後不再收到；訂閱者丟例外不影響其他人', async () => {
  const { n, synth, clock } = makeEnv()
  const a = [], b = []
  const offA = n.onChange((v) => a.push(v))
  n.onChange(() => { throw new Error('bad subscriber') })
  n.onChange((v) => b.push(v))
  assert.equal(n.speaking(), false)
  n.cancel(); assert.deepEqual(a, [])                       // 閒置 cancel 不通知
  const p = startSpeak({ n, clock }, '你好'); assert.equal(n.speaking(), true)
  synth.last.onend(); await p
  assert.deepEqual(a, [true, false]); assert.deepEqual(b, [true, false])
  offA()
  const p2 = startSpeak({ n, clock }, '再一次'); n.cancel(); await p2
  assert.deepEqual(a, [true, false]); assert.deepEqual(b, [true, false, true, false])
  assert.equal(typeof n.onChange(null), 'function')          // 壞輸入回傳可呼叫的空函式
})

test('訂閱者在通知裡就 cancel（reentrant）也不會留下殘留計時器', async () => {
  const { n, synth, clock } = makeEnv()
  n.onChange((v) => { if (v) n.cancel() })
  const p = n.speak('你好')
  assert.equal(await p, 'cancelled'); assert.equal(clock.pending(), 0); assert.equal(n.speaking(), false); assert.equal(synth.spoken.length, 0)
})

test('dispose：cancel 進行中的句子、移除 voiceschanged 監聽、清掉所有訂閱；之後仍可再用（StrictMode 雙掛載安全）', async () => {
  const { n, synth, clock } = makeEnv({ voices: [V('zh-TW')] })
  const events = []
  n.onChange((v) => events.push(v))
  n.pickVoice('zh-TW'); n.pickVoice('en-US')
  const p = startSpeak({ n, clock }, '你好')
  assert.equal(synth.listenerCount(), 1); assert.equal(synth.adds, 1)      // 多次呼叫不重複掛
  n.dispose()
  assert.equal(await p, 'cancelled')
  assert.equal(synth.listenerCount(), 0); assert.equal(synth.removes, 1)
  assert.equal(n.speaking(), false); assert.equal(clock.pending(), 0)
  n.dispose()                                                              // 重複 dispose 安全
  assert.equal(synth.removes, 1)
  // 訂閱已清空：再念一句不會通知舊的 callback
  const seen = events.length
  const p2 = startSpeak({ n, clock }, '再念一句'); assert.equal(synth.listenerCount(), 1)
  synth.last.onend(); assert.equal(await p2, 'done'); assert.equal(events.length, seen)
  n.dispose(); assert.equal(synth.listenerCount(), 0); assert.equal(synth.adds, synth.removes)
})

// ===============================================================================================
// pickVoice
// ===============================================================================================
test('pickVoiceFrom：完全符合最優先（zh_TW / zh-Hant-TW 也算符合）', () => {
  assert.equal(pickVoiceFrom([V('zh-CN', true, 'cn'), V('zh-TW', false, 'tw'), V('zh-HK', true, 'hk')], 'zh-TW').name, 'tw')
  assert.equal(pickVoiceFrom([V('en-US'), V('zh_TW', false, 'underscore')], 'zh-TW').name, 'underscore')
  assert.equal(pickVoiceFrom([V('zh-CN', true), V('zh-Hant-TW', false, 'hant')], 'zh-TW').name, 'hant')
  assert.equal(pickVoiceFrom([V('zh-tw', false, 'lower')], 'zh-TW').name, 'lower')
  assert.equal(pickVoiceFrom([V('en_US', false, 'en')], 'en-US').name, 'en')
  assert.equal(pickVoiceFrom([V('zh-TW', false, 'x')], 'zh_TW').name, 'x')            // 要求端寫成 zh_TW 也行
})

test('pickVoiceFrom：同等級偏好 localService（離線、延遲低）；其次保持原順序', () => {
  assert.equal(pickVoiceFrom([V('zh-TW', false, 'remote'), V('zh-TW', true, 'local')], 'zh-TW').name, 'local')
  assert.equal(pickVoiceFrom([V('zh-TW', true, 'a'), V('zh-TW', true, 'b')], 'zh-TW').name, 'a')
  assert.equal(pickVoiceFrom([V('zh-TW', false, 'a'), V('zh-TW', false, 'b')], 'zh-TW').name, 'a')
  // 等級比 localService 重要：完全符合的遠端聲音，勝過其他區域的離線聲音
  assert.equal(pickVoiceFrom([V('zh-CN', true, 'cn'), V('zh-TW', false, 'tw')], 'zh-TW').name, 'tw')
})

test('pickVoiceFrom：沒有完全符合 → 同語系其他區域；zh 系 zh-HK 優先、zh-CN 最後', () => {
  assert.equal(pickVoiceFrom([V('zh-CN', true, 'cn'), V('zh-HK', false, 'hk')], 'zh-TW').name, 'hk')
  assert.equal(pickVoiceFrom([V('zh-CN', true, 'cn'), V('zh', false, 'bare'), V('en-US', true)], 'zh-TW').name, 'bare')
  assert.equal(pickVoiceFrom([V('zh-Hans-CN', true, 'hans'), V('zh-Hant', false, 'hant')], 'zh-TW').name, 'hant')
  assert.equal(pickVoiceFrom([V('en-US', true), V('zh-CN', false, 'cn')], 'zh-TW').name, 'cn')
  assert.equal(pickVoiceFrom([V('zh-CN', false, 'remote'), V('zh-CN', true, 'local')], 'zh-TW').name, 'local')
})

test('pickVoiceFrom：en 系優先 en-US、en-GB、其他 en-*；不同語系 / 空清單 / 壞資料 → null', () => {
  assert.equal(pickVoiceFrom([V('en-AU', true, 'au'), V('en-GB', false, 'gb'), V('en-IN', true, 'in')], 'en-US').name, 'gb')
  assert.equal(pickVoiceFrom([V('en-AU', false, 'au-remote'), V('en-IN', true, 'in-local')], 'en-US').name, 'in-local')
  assert.equal(pickVoiceFrom([V('en-AU', false, 'au'), V('en-US', false, 'us')], 'en-GB').name, 'us')
  assert.equal(pickVoiceFrom([V('en-AU', false, 'au'), V('en-GB', false, 'gb')], 'en-US').name, 'gb')
  assert.equal(pickVoiceFrom([V('en-US', true)], 'zh-TW'), null)
  assert.equal(pickVoiceFrom([V('zh-TW', true)], 'en-US'), null)
  assert.equal(pickVoiceFrom([], 'zh-TW'), null)
  assert.equal(pickVoiceFrom(null, 'zh-TW'), null)
  assert.equal(pickVoiceFrom(undefined, 'zh-TW'), null)
  assert.equal(pickVoiceFrom([V('zh-TW')], ''), null)
  assert.equal(pickVoiceFrom([V('zh-TW')], undefined), null)
  assert.equal(pickVoiceFrom([null, {}, { lang: 42 }, V('zh-TW', false, 'ok')], 'zh-TW').name, 'ok')
  assert.equal(pickVoiceFrom([V('ja-JP', false, 'ja')], 'ja-JP').name, 'ja')          // 其他語系也通用
  assert.equal(pickVoiceFrom([V('zh', false, 'bare'), V('zh-TW', false, 'tw')], 'zh').name, 'bare')   // 要求端不帶區域：最單純的 zh 優先
})

test('narrator.pickVoice：voices 一開始是空的，voiceschanged 之後才有；voices 有東西之後以事件更新快取', () => {
  const { n, synth } = makeEnv({ voices: [] })
  assert.equal(n.pickVoice('zh-TW'), null)
  assert.equal(synth.listenerCount(), 1)                                 // 用 addEventListener 監聽
  synth.voices = [V('zh-TW', true, 'later')]
  synth.dispatch('voiceschanged')
  assert.equal(n.pickVoice('zh-TW').name, 'later')

  const e2 = makeEnv({ voices: [V('en-US', true, 'us')] })
  assert.equal(e2.n.pickVoice('zh-TW'), null)                            // 快取非空：沒事件就不重讀
  e2.synth.voices = [V('en-US', true, 'us'), V('zh-TW', true, 'tw')]
  assert.equal(e2.n.pickVoice('zh-TW'), null)
  e2.synth.dispatch('voiceschanged')
  assert.equal(e2.n.pickVoice('zh-TW').name, 'tw')

  const e3 = makeEnv({ voices: [] })                                     // 事件永遠不來（Firefox 等）：快取是空的就每次重讀
  assert.equal(e3.n.pickVoice('zh-TW'), null)
  e3.synth.voices = [V('zh-TW', false, 'polled')]
  assert.equal(e3.n.pickVoice('zh-TW').name, 'polled')
})

test('speak 會設 utterance.voice（有合適聲音時）；沒有就只設 lang；延遲期間 voiceschanged 也趕得上', async () => {
  const e1 = makeEnv({ voices: [V('en-US', true), V('zh-TW', true, 'tw'), V('zh-CN', true, 'cn')] })
  let p = startSpeak(e1, '你好'); assert.equal(e1.synth.last.voice.name, 'tw'); assert.equal(e1.synth.last.lang, 'zh-TW'); e1.synth.last.onend(); await p
  p = startSpeak(e1, 'Hello', { lang: 'en-US' }); assert.equal(e1.synth.last.voice.name, 'en-US-local'); e1.synth.last.onend(); await p
  p = startSpeak(e1, 'Bonjour', { lang: 'fr-FR' }); assert.equal(e1.synth.last.voice, null); assert.equal(e1.synth.last.lang, 'fr-FR'); e1.synth.last.onend(); await p

  const e2 = makeEnv({ voices: [] })
  p = e2.n.speak('你好'); e2.clock.advance(30)
  e2.synth.voices = [V('zh-TW', true, 'late')]; e2.synth.dispatch('voiceschanged')
  e2.clock.advance(30)
  assert.equal(e2.synth.last.voice.name, 'late'); e2.synth.last.onend(); await p
})

test('沒有 addEventListener 的舊 synth：退回 onvoiceschanged，dispose 時還原', () => {
  const clock = makeClock()
  const old = { voices: [V('en-US', true)], getVoices() { return this.voices }, speak() {}, cancel() {}, onvoiceschanged: null }
  const n = createNarrator({ synth: () => old, Utterance: () => FakeUtterance, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
  assert.equal(n.pickVoice('zh-TW'), null)
  assert.equal(typeof old.onvoiceschanged, 'function')
  old.voices = [V('en-US', true), V('zh-TW', true, 'tw')]; old.onvoiceschanged()
  assert.equal(n.pickVoice('zh-TW').name, 'tw')
  n.dispose(); assert.equal(old.onvoiceschanged, null)
})

test('synth 物件換了 → 監聽跟著換（舊的移除、新的掛上）', () => {
  const clock = makeClock()
  const a = new FakeSynth({ voices: [V('zh-TW', true, 'a')] }), b = new FakeSynth({ voices: [V('zh-TW', true, 'b')] })
  let cur = a
  const n = createNarrator({ synth: () => cur, Utterance: () => FakeUtterance, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
  assert.equal(n.pickVoice('zh-TW').name, 'a'); assert.equal(a.listenerCount(), 1)
  cur = b
  assert.equal(n.pickVoice('zh-TW').name, 'b'); assert.equal(a.listenerCount(), 0); assert.equal(b.listenerCount(), 1)
  n.dispose(); assert.equal(b.listenerCount(), 0)
})

// ===============================================================================================
// import 時不碰 window / navigator
// ===============================================================================================
test('import 時完全不存取 window / navigator / speechSynthesis 等全域；createNarrator() 不丟例外；沒有環境時安全降級', () => {
  const file = pathToFileURL(new URL('./narration.js', import.meta.url).pathname).href
  const i18nFile = pathToFileURL(new URL('../i18n/index.js', import.meta.url).pathname).href
  const code = `
    const hits = []
    for (const k of ['window', 'navigator', 'document', 'speechSynthesis', 'SpeechSynthesisUtterance', 'localStorage', 'sessionStorage']) {
      try { delete globalThis[k] } catch (e) {}
      Object.defineProperty(globalThis, k, { configurable: true, get() { hits.push(k); return undefined } })
    }
    await import(${JSON.stringify(i18nFile)})        // i18n 自己的環境偵測不算：先載入、清掉紀錄，再載入旁白模組
    hits.length = 0
    const mod = await import(${JSON.stringify(file)})
    const atImport = [...hits]
    const n = mod.createNarrator()
    const atCreate = [...hits]
    const out = {
      atImport, atCreate,
      exports: Object.keys(mod).sort(),
      supported: n.supported(), shared: mod.narrator.supported(),
      speak: await mod.narrator.speak('你好'), pick: mod.narrator.pickVoice('zh-TW'),
      speaking: mod.narrator.speaking(),
      text: mod.speechText({ title: 'a', body: 'b' }, 'zh'),
    }
    mod.narrator.cancel(); mod.narrator.dispose()
    console.log(JSON.stringify(out))
  `
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }).trim().split('\n').pop())
  assert.deepEqual(out.atImport, [], 'import 時碰了全域：' + out.atImport)
  assert.deepEqual(out.atCreate, [], 'createNarrator() 時碰了全域：' + out.atCreate)
  for (const name of ['createNarrator', 'narrator', 'speechText']) assert.ok(out.exports.includes(name), name)
  assert.equal(out.supported, false); assert.equal(out.shared, false)
  assert.equal(out.speak, 'unsupported'); assert.equal(out.pick, null); assert.equal(out.speaking, false)
  assert.equal(out.text, 'a。b')
})

test('共用實例 narrator 在 Node（沒有 speechSynthesis）也能安全呼叫', async () => {
  assert.equal(narrator.supported(), false)
  assert.equal(await narrator.speak('你好'), 'unsupported')
  assert.doesNotThrow(() => { narrator.cancel(); narrator.dispose() })
  assert.equal(narrator.speaking(), false); assert.equal(narrator.pickVoice('zh-TW'), null); assert.equal(pickVoice('zh-TW'), null)
})

test('原始碼不含 lookbehind 正規式（iOS Safari < 16.4 在解析階段就會整個模組載入失敗）', () => {
  const src = readFileSync(new URL('./narration.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /\(\?<[=!]/)
})

// ===============================================================================================
// speechText
// ===============================================================================================
const FORBIDDEN = /[→⇒➜·・μµ³²–↑↓]/
const digitsOf = (s) => String(s).match(/\d+(?:\.\d+)?/g) || []

// 實際字幕的樣本（來自 tour.js 的 CAPTIONS 與 src/i18n/en/tour.js、air.js 的實際句型）：水庫 / 潮汐 / 月亮 / 揚塵 / 空氣品質 / 鳥魚 / 測站
const SAMPLES = {
  reservoir: {
    zh: { title: '今日水庫 · 翡翠水庫', body: '水位 63.4% → 海水高度 0.63（滿庫溢流）：水庫越滿，球裡的海越高' },
    en: { title: "Today's reservoir · Feitsui", body: 'Water level 63.4% → sea level 0.63 (overflowing): the fuller the reservoir, the higher the sea' },
  },
  tide: {
    zh: { title: '潮汐 · 高雄港', body: '今天是大潮（農曆八月初十 · 上弦月）：潮位 12–168 cm 一日起落，帶動海水高度' },
    en: { title: 'Tide · Kaohsiung', body: 'A spring tide today (Lunar 8/10 · first quarter moon): the tide swings 12–168 cm a day, moving the sea level' },
  },
  moon: {
    zh: { title: '月亮 · 臺北', body: '上弦月 · 今日月出 12:34、月沒 00:12：月亮中天越高，海水越高（示意）' },
    en: { title: 'Moon · Taipei', body: "First quarter moon · today's moonrise 12:34, moonset 00:12: the higher the moon, the higher the sea (illustrative)" },
  },
  dust: {
    zh: { title: '揚塵 · 雲林', body: 'PM10 45–120 μg/m³：越高，海水越混濁、垃圾越多' },
    en: { title: 'Dust · Yunlin', body: 'PM10 45–120 μg/m³: the higher it is, the murkier the sea and the more trash' },
  },
  wind: {
    zh: { title: '揚塵 · 雲林', body: 'PM10 感測器回報無效，改看風速 3.2–5.1 m/s：風越大，洋流越急' },
    en: { title: 'Dust · Yunlin', body: 'PM10 sensor invalid, so wind speed 3.2–5.1 m/s is used: stronger wind, faster current' },
  },
  air: {
    zh: { title: '空氣品質 · 雲林', body: 'PM2.5 ↑ → 海水清澈 0.62 · 垃圾 0.30 · 輝光 0.4' },
    en: { title: 'Air quality · Yunlin', body: 'PM2.5 ↑ → water clarity 0.62 · trash 0.30 · glow 0.4' },
  },
  birds: {
    zh: { title: '鳥群調查 · 淡水河', body: '2005–2017 年 13 次調查，每年 21–44 種：種數越多，鳥群越多；2008–2009 無調查（內插）' },
    en: { title: 'Bird survey · Tamsui', body: '13 surveys 2005–2017, 21–44 species each: more species, more flocks; no survey 2008–2009 (interpolated)' },
  },
  model: {
    zh: { title: '雲林 · 模型資料', body: 'PM2.5 12–35 μg/m³（Open-Meteo / CAMS 模型，非政府觀測）：越高，海水越混濁、垃圾越多' },
    en: { title: 'Yunlin · modeled data', body: 'PM2.5 12–35 μg/m³ (Open-Meteo / CAMS model, not government observations): the higher, the murkier the sea and the more trash' },
  },
  stations: {
    zh: { title: '河川測站星座', body: '水利署 210 座河川流量測站依真實座標排成台灣島形：亮星現存（158）、暗星已廢' },
    en: { title: 'River station constellation', body: '210 river gauging stations at real coordinates trace Taiwan; bright stars are active (158)' },
  },
}

test('speechText：實際字幕樣本（水庫 / 潮汐 / 月亮 / 揚塵 / 空氣品質 / 鳥魚 / 測站，中英文）不含會念錯的符號、數字完全不變、不含殘留的原始單位', () => {
  for (const [key, byLoc] of Object.entries(SAMPLES)) {
    for (const [loc, cap] of Object.entries(byLoc)) {
      const out = speechText(cap, loc)
      const label = `${key}/${loc}: ${out}`
      assert.equal(typeof out, 'string', label)
      assert.ok(out.length > 10, label)
      assert.doesNotMatch(out, FORBIDDEN, label)
      assert.doesNotMatch(out, /\bm\/s\b|\bcm\b|μg|m3\b/, label)
      assert.deepEqual(digitsOf(out), digitsOf(cap.title + ' ' + cap.body), '數字被改動：' + label)
      assert.ok(out.includes(loc === 'zh' ? '。' : '. '), label)             // 標題與內文以句號隔開
      assert.doesNotMatch(out, /\s{2,}/, label)
      assert.doesNotMatch(out, loc === 'zh' ? /\s[，。：；、）]|，，|。。/ : /\s[,.;:)]|,,|\.\./, label)
    }
  }
})

test('speechText：實際輸出（固定樣本逐字核對）', () => {
  const S = SAMPLES
  assert.equal(speechText(S.reservoir.zh, 'zh'), '今日水庫，翡翠水庫。水位 63.4%，海水高度 0.63（滿庫溢流）：水庫越滿，球裡的海越高')
  assert.equal(speechText(S.reservoir.en, 'en'), "Today's reservoir, Feitsui. Water level 63.4%, giving sea level 0.63 (overflowing): the fuller the reservoir, the higher the sea")
  assert.equal(speechText(S.tide.zh, 'zh'), '潮汐，高雄港。今天是大潮（農曆八月初十，上弦月）：潮位 12到168 公分 一日起落，帶動海水高度')
  assert.equal(speechText(S.tide.en, 'en'), 'Tide, Kaohsiung. A spring tide today (Lunar 8/10, first quarter moon): the tide swings 12 to 168 centimetres a day, moving the sea level')
  assert.equal(speechText(S.moon.zh, 'zh'), '月亮，臺北。上弦月，今日月出 12:34、月沒 00:12：月亮中天越高，海水越高（示意）')
  assert.equal(speechText(S.dust.zh, 'zh'), '揚塵，雲林。PM10 45到120 微克每立方公尺：越高，海水越混濁、垃圾越多')
  assert.equal(speechText(S.dust.en, 'en'), 'Dust, Yunlin. PM10 45 to 120 micrograms per cubic metre: the higher it is, the murkier the sea and the more trash')
  assert.equal(speechText(S.wind.zh, 'zh'), '揚塵，雲林。PM10 感測器回報無效，改看風速 3.2到5.1 公尺每秒：風越大，洋流越急')
  assert.equal(speechText(S.wind.en, 'en'), 'Dust, Yunlin. PM10 sensor invalid, so wind speed 3.2 to 5.1 metres per second is used: stronger wind, faster current')
  assert.equal(speechText(S.air.zh, 'zh'), '空氣品質，雲林。PM2.5 上升，海水清澈 0.62，垃圾 0.30，輝光 0.4')
  assert.equal(speechText(S.air.en, 'en'), 'Air quality, Yunlin. PM2.5 rising, giving water clarity 0.62, trash 0.30, glow 0.4')
  assert.equal(speechText(S.birds.zh, 'zh'), '鳥群調查，淡水河。2005到2017 年 13 次調查，每年 21到44 種：種數越多，鳥群越多；2008到2009 無調查（內插）')
  assert.equal(speechText(S.birds.en, 'en'), 'Bird survey, Tamsui. 13 surveys 2005 to 2017, 21 to 44 species each: more species, more flocks; no survey 2008 to 2009 (interpolated)')
  assert.equal(speechText(S.model.zh, 'zh'), '雲林，模型資料。PM2.5 12到35 微克每立方公尺（Open-Meteo、CAMS 模型，非政府觀測）：越高，海水越混濁、垃圾越多')
  assert.equal(speechText(S.model.en, 'en'), 'Yunlin, modeled data. PM2.5 12 to 35 micrograms per cubic metre (Open-Meteo, CAMS model, not government observations): the higher, the murkier the sea and the more trash')
  assert.equal(speechText(S.stations.zh, 'zh'), '河川測站星座。水利署 210 座河川流量測站依真實座標排成台灣島形：亮星現存（158）、暗星已廢')
})

test('speechText：連接方式——zh 以「。」、en 以「. 」；標題已有句末標點不重複；標題以逗號結尾改成句號', () => {
  assert.equal(speechText({ title: '標題', body: '內文' }, 'zh'), '標題。內文')
  assert.equal(speechText({ title: '標題。', body: '內文' }, 'zh'), '標題。內文')
  assert.equal(speechText({ title: '標題！', body: '內文' }, 'zh'), '標題！內文')
  assert.equal(speechText({ title: '標題？', body: '內文' }, 'zh'), '標題？內文')
  assert.equal(speechText({ title: '標題，', body: '內文' }, 'zh'), '標題。內文')
  assert.equal(speechText({ title: 'Title', body: 'Body text' }, 'en'), 'Title. Body text')
  assert.equal(speechText({ title: 'Title.', body: 'Body text' }, 'en'), 'Title. Body text')
  assert.equal(speechText({ title: 'Title?', body: 'Body text' }, 'en'), 'Title? Body text')
  assert.equal(speechText({ title: 'Title,', body: 'Body text' }, 'en'), 'Title. Body text')
  assert.equal(speechText({ title: 'Title', body: 'Body' }, 'en-US'), 'Title. Body')       // 區域碼也認得
  assert.equal(speechText({ title: 'Title', body: 'Body' }, 'fr'), 'Title。Body')            // 不認得的語系 → 當 zh 處理
})

test('speechText：空 title / 空 body / 壞輸入都安全（只念有的那邊、不加多餘標點）', () => {
  for (const loc of ['zh', 'en']) {
    assert.equal(speechText({ title: '', body: '內文 12' }, loc), '內文 12')
    assert.equal(speechText({ title: '只有標題', body: '' }, loc), '只有標題')
    assert.equal(speechText({ title: '', body: '' }, loc), '')
    assert.equal(speechText({}, loc), '')
    assert.equal(speechText(null, loc), '')
    assert.equal(speechText(undefined, loc), '')
    assert.equal(speechText({ title: null, body: undefined }, loc), '')
    assert.equal(speechText({ title: '   ', body: '\n' }, loc), '')
    assert.equal(speechText('字串不是物件', loc), '')
    assert.equal(speechText({ title: 12, body: 3.5 }, loc), loc === 'zh' ? '12。3.5' : '12. 3.5')
  }
  assert.equal(speechText({ title: '標題', body: '內文' }), '標題。內文')                    // 語系省略：Node 預設 zh
})

test('speechText：單位口語化（zh）—— μg/m³、m/s、cm 等；PM2.5 / PM10 / % 與括號內容保持原樣', () => {
  const z = (body) => speechText({ title: '', body }, 'zh')
  assert.equal(z('45 μg/m³'), '45 微克每立方公尺')
  assert.equal(z('45 µg/m³'), '45 微克每立方公尺')                                        // U+00B5 微符號
  assert.equal(z('45 ug/m3'), '45 微克每立方公尺')
  assert.equal(z('風速 3 m/s'), '風速 3 公尺每秒')
  assert.equal(z('潮位 120 cm'), '潮位 120 公分')
  assert.equal(z('潮位 120cm'), '潮位 120公分')
  assert.equal(z('潮位 cm'), '潮位 公分')                                                 // 缺值時單位獨立出現也口語化
  assert.equal(z('流速 30 cm/s'), '流速 30 公分每秒')
  assert.equal(z('流量 12.5 m³/s'), '流量 12.5 立方公尺每秒')
  assert.equal(z('水量 8 m³'), '水量 8 立方公尺')
  assert.equal(z('面積 3 km²、2 m²'), '面積 3 平方公里、2 平方公尺')
  assert.equal(z('時速 40 km/h'), '時速 40 公里每小時')
  assert.equal(z('雨量 5 mm，降雨 8 mm/h'), '雨量 5 毫米，降雨 8 毫米每小時')
  assert.equal(z('粒徑 2.5 μm'), '粒徑 2.5 微米')
  assert.equal(z('PM2.5 與 PM10：水位 63.4%'), 'PM2.5 與 PM10：水位 63.4%')
  assert.equal(z('（滿庫溢流）括號內容照念'), '（滿庫溢流）括號內容照念')
  assert.equal(z('cmd 與 mms 與 xm/s 不是單位'), 'cmd 與 mms 與 xm/s 不是單位')            // 單位要有邊界，不誤傷英文字
})

test('speechText：單位口語化（en）—— 1 用單數、其餘與沒有數字時用複數', () => {
  const e = (body) => speechText({ title: '', body }, 'en')
  assert.equal(e('45 μg/m³'), '45 micrograms per cubic metre')
  assert.equal(e('1 μg/m³'), '1 microgram per cubic metre')
  assert.equal(e('wind 3 m/s'), 'wind 3 metres per second')
  assert.equal(e('wind 1 m/s'), 'wind 1 metre per second')
  assert.equal(e('wind 1.0 m/s'), 'wind 1.0 metre per second')
  assert.equal(e('wind 11 m/s'), 'wind 11 metres per second')
  assert.equal(e('tide 120 cm'), 'tide 120 centimetres')
  assert.equal(e('tide 1 cm'), 'tide 1 centimetre')
  assert.equal(e('tide 0.5 cm'), 'tide 0.5 centimetres')
  assert.equal(e('unit cm'), 'unit centimetres')
  assert.equal(e('30 cm/s'), '30 centimetres per second')
  assert.equal(e('12.5 m³/s'), '12.5 cubic metres per second')
  assert.equal(e('40 km/h'), '40 kilometres per hour')
  assert.equal(e('hmm 5 mm'), 'hmm 5 millimetres')
  assert.equal(e('PM2.5 and PM10 at 63.4%'), 'PM2.5 and PM10 at 63.4%')
  assert.equal(e('the (bracketed) part stays'), 'the (bracketed) part stays')
})

test('speechText：數字範圍的破折號 → 到 / to（en dash、em dash、~、連續範圍）；負號與缺值佔位不動', () => {
  const z = (body) => speechText({ title: '', body }, 'zh'), e = (body) => speechText({ title: '', body }, 'en')
  assert.equal(z('119–175'), '119到175')
  assert.equal(z('2005–2017 年'), '2005到2017 年')
  assert.equal(z('2005—2017'), '2005到2017')
  assert.equal(z('119 – 175'), '119到175')
  assert.equal(z('119~175'), '119到175')
  assert.equal(z('3.2–5.1'), '3.2到5.1')
  assert.equal(z('12:30–13:00'), '12:30到13:00')
  assert.equal(z('潮位 -12–120'), '潮位 -12到120')
  assert.equal(z('1–2–3'), '1到2到3')
  assert.equal(e('119–175'), '119 to 175')
  assert.equal(e('2005–2017'), '2005 to 2017')
  assert.equal(e('1–2–3'), '1 to 2 to 3')
  assert.equal(e('tide -12–120'), 'tide -12 to 120')
  assert.equal(z('水位 —%'), '水位 —%')                                                    // 單獨的 — 是「缺值」佔位，原樣保留
  assert.equal(z('PM10 —–— μg/m³'), 'PM10 — 微克每立方公尺')                              // 兩端都缺值的範圍：合併成一個佔位，不念成「到」
  assert.equal(e('PM10 —–— μg/m³'), 'PM10 — micrograms per cubic metre')
  assert.equal(z('潮位 —–— cm'), '潮位 — 公分')
  assert.equal(z('45–—'), '45到—')                                                       // 只缺一端：照範圍念，但不留下 en dash
  assert.equal(z('甲 – 乙'), '甲，乙')                                                    // 前後有空白的 en dash 是停頓
  assert.equal(e('A – B'), 'A, B')
})

test('speechText：→、·、↑↓ 的口語化；相鄰標點不會疊成重複', () => {
  const z = (body) => speechText({ title: '', body }, 'zh'), e = (body) => speechText({ title: '', body }, 'en')
  assert.equal(z('甲 / 乙'), '甲、乙')                                                   // 前後有空白的斜線是並列
  assert.equal(e('A / B'), 'A, B')
  assert.equal(z('農曆 8/10、3 m/s'), '農曆 8/10、3 公尺每秒')                                 // 沒有空白的斜線不動
  assert.equal(z('甲 → 乙'), '甲，乙')
  assert.equal(z('甲→乙'), '甲，乙')
  assert.equal(z('甲 · 乙 · 丙'), '甲，乙，丙')
  assert.equal(z('甲， → 乙'), '甲，乙')
  assert.equal(z('PM2.5 ↑'), 'PM2.5 上升')
  assert.equal(z('PM2.5 ↓ → 海水'), 'PM2.5 下降，海水')
  assert.equal(e('A → B'), 'A, giving B')
  assert.equal(e('A → B → C'), 'A, giving B, giving C')
  assert.equal(e('A · B · C'), 'A, B, C')
  assert.equal(e('A, → B'), 'A, giving B')
  assert.equal(e('PM2.5 ↑ → clarity'), 'PM2.5 rising, giving clarity')
  assert.equal(e('PM2.5 ↓'), 'PM2.5 falling')
  assert.equal(e('→ leading and trailing ·'), 'giving leading and trailing')
})

test('speechText：特殊空白與零寬字元被清掉；換行折成空格', () => {
  assert.equal(speechText({ title: '標題\u00A0', body: '第一行\n第二行\u200B  結尾' }, 'zh'), '標題。第一行 第二行 結尾')
  assert.equal(speechText({ title: 'Title\u3000', body: 'a\tb' }, 'en'), 'Title. a b')
})

test('speechText：i18n 字典（src/i18n/en/narration.js）與內建的口語化英文詞一致，沒有多餘或缺漏的 key', () => {
  const keys = new Set(Object.keys(narrationEn))
  for (const u of SPOKEN_UNITS) {
    assert.ok(keys.has(u.zh), `缺 ${u.zh}`); keys.delete(u.zh)
    assert.equal(narrationEn[u.zh], u.en, u.zh)
    assert.ok(u.en1 && u.en1 !== u.en, `${u.zh} 缺英文單數`)
    assert.equal(speechText({ title: '', body: `9 ${u.zh}` }, 'zh'), `9 ${u.zh}`)         // 已經是中文詞的不會被再處理
  }
  // 範圍、上升、下降：字典值要真的出現在口語化輸出裡
  assert.equal(speechText({ title: '', body: '1–2' }, 'en'), narrationEn['{a}到{b}'].replace('{a}', '1').replace('{b}', '2'))
  assert.equal(speechText({ title: '', body: '1–2' }, 'zh'), '{a}到{b}'.replace('{a}', '1').replace('{b}', '2'))
  assert.ok(speechText({ title: '', body: 'x ↑' }, 'en').includes(narrationEn['上升'])); assert.ok(speechText({ title: '', body: 'x ↑' }, 'zh').includes('上升'))
  assert.ok(speechText({ title: '', body: 'x ↓' }, 'en').includes(narrationEn['下降'])); assert.ok(speechText({ title: '', body: 'x ↓' }, 'zh').includes('下降'))
  for (const k of ['{a}到{b}', '上升', '下降']) { assert.ok(keys.has(k), k); keys.delete(k) }
  assert.deepEqual([...keys], [], '字典裡有程式沒用到的 key')
})

test('speechText：與 tour.js 實際的 captionText 整合（中英文皆無殘留符號、數字不變）；tour.js 載入不了就略過', async (t) => {
  let tour
  try {
    const { dict } = await loadEnDict(); registerEn(dict)
    tour = await import('./tour.js')
  } catch (e) { t.skip('tour.js 載入失敗：' + e.message); return }
  const captions = [
    { key: 'reservoir', p: { name: '翡翠水庫', level: 63.4, sea: 0.63 } },
    { key: 'reservoir', p: { name: '石門水庫', level: 100, sea: 0.98 } },
    { key: 'tide', p: { name: '高雄港', lo: -12, hi: 168, unit: 'cm', age: 8.5, lunar: '農曆八月初十', range: '大潮' } },
    { key: 'tide', p: { name: '高雄港', lo: 12, hi: 168, unit: 'cm', age: 8.5 } },
    { key: 'moon', p: { name: '臺北', age: 8.5, today: true, rise: '12:34', set: '00:12', n: 30 } },
    { key: 'moon', p: { name: '臺北', age: 8.5, today: false, rise: '12:34', set: '00:12', n: 30 } },
    { key: 'dust', p: { name: '雲林', mode: 'play', metric: 'pm10', lo: 45, hi: 120 } },
    { key: 'dust', p: { name: '雲林', mode: 'play', metric: 'wind', lo: 3.2, hi: 5.1 } },
    { key: 'dust', p: { name: '雲林', mode: 'play', metric: 'pm10', lo: 61, hi: 61, frozen: true } },
    { key: 'dust', p: { name: '雲林', mode: 'apply', metric: 'pm10', pm: 61, n: 4 } },
    { key: 'dust', p: { name: '雲林', mode: 'apply', metric: 'wind', wind: 4.2, n: 4 } },
    { key: 'birds', p: { basin: '淡水河', a: 2005, b: 2017, k: 13, lo: 21, hi: 44, gaps: [[2008, 2009], [2011, 2011]] } },
    { key: 'fish', p: { basin: '淡水河', a: 2005, b: 2017, k: 13, lo: 21, hi: 44 } },
    { key: 'air', p: { name: '雲林', lo: 12, hi: 35 } },
    { key: 'air', p: { name: '雲林', lo: 12, hi: 12, flat: true } },
    { key: 'stations', p: { total: 210, active: 158 } },
  ]
  try {
    let checked = 0
    for (const loc of ['zh', 'en']) {
      setLocale(loc)
      for (const c of captions) {
        const cap = tour.captionText(c)
        if (!cap.title && !cap.body) continue
        const out = speechText(cap, loc)
        const label = `${c.key}/${loc}: ${out}`
        assert.ok(out.length > 0, label)
        assert.doesNotMatch(out, FORBIDDEN, label)
        assert.doesNotMatch(out, /\bm\/s\b|\bcm\b|μg/, label)
        assert.deepEqual(digitsOf(out), digitsOf(cap.title + ' ' + cap.body), '數字被改動：' + label)
        checked++
      }
    }
    assert.ok(checked >= captions.length, `只檢查了 ${checked} 段字幕`)
  } finally { setLocale('zh') }
})

// ===============================================================================================
// iOS 解鎖：unlock() / isUnlocked() / unlockOnFirstGesture()
// ===============================================================================================
import guidecmdEn from '../i18n/en/guidecmd.js'
import { UNLOCK_TEXT, SILENT_TEXT, SILENT_WORD, GESTURE_UNLOCK_EVENTS, MAX_GESTURE_TRIES } from './narration.js'

// 假 window：方法會檢查 this；removeEventListener 和真的一樣要「type + 函式 + capture 旗標」都相同才移得掉
class FakeWindow {
  #brand = true
  static #check(o) { if (o === null || typeof o !== 'object' || !(#brand in o)) throw new TypeError('Illegal invocation') }
  constructor() { this.list = []; this.adds = 0; this.removes = 0; this.failAdd = false }
  addEventListener(type, fn, opts) {
    FakeWindow.#check(this)
    if (this.failAdd) throw new Error('nope')
    const capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture)
    if (!this.list.some((x) => x.type === type && x.fn === fn && x.capture === capture)) this.list.push({ type, fn, capture })
    this.adds++
  }
  removeEventListener(type, fn, opts) {
    FakeWindow.#check(this)
    const capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture)
    this.list = this.list.filter((x) => !(x.type === type && x.fn === fn && x.capture === capture))
    this.removes++
  }
  count(type) { return this.list.filter((x) => !type || x.type === type).length }
  dispatch(type, ev = {}) { for (const x of [...this.list]) if (x.type === type) x.fn({ type, ...ev }) }
}

test('假 window：脫離原物件呼叫會丟 Illegal invocation；capture 旗標不同就移不掉', () => {
  const w = new FakeWindow()
  const { addEventListener } = w
  assert.throws(() => addEventListener('keydown', () => {}, true), /Illegal invocation/)
  const fn = () => {}
  w.addEventListener('keydown', fn, { capture: true, passive: true })
  w.removeEventListener('keydown', fn, false); assert.equal(w.count(), 1)
  w.removeEventListener('keydown', fn, true); assert.equal(w.count(), 0)
})

test('確認語：預設「旁白已開啟」/ "Narration on"，字典與內建英文一致；監聽事件是 pointerdown / keydown / touchend', () => {
  assert.equal(UNLOCK_TEXT.zh, '旁白已開啟'); assert.equal(UNLOCK_TEXT.en, 'Narration on')
  assert.equal(guidecmdEn[UNLOCK_TEXT.zh], UNLOCK_TEXT.en)
  assert.deepEqual(GESTURE_UNLOCK_EVENTS, ['pointerdown', 'keydown', 'touchend'])
  assert.equal(MAX_GESTURE_TRIES, 3)
})

test('unlock：「同步」speak——不 cancel、不經 CANCEL_DELAY_MS 延遲（延遲會讓 speak 落在使用者手勢視窗之外）', async () => {
  const { n, synth, clock } = makeEnv()
  const p = n.unlock()
  assert.equal(synth.spoken.length, 1, '呼叫 unlock 的同一個呼叫堆疊內就已經交給引擎')
  assert.equal(synth.cancels, 0, '不先 cancel')
  assert.equal(clock.now(), 0, '沒有等任何時間')
  const u = synth.last
  assert.deepEqual([u.text, u.lang, u.volume, u.rate, u.pitch], ['旁白已開啟', 'zh-TW', 1, 1, 1])
  assert.equal(n.isUnlocked(), false)
  u.onend()
  assert.equal(await p, 'done')
  assert.equal(n.isUnlocked(), true)
  assert.equal(clock.pending(), 0, '逾時計時器已清掉')
})

test('unlock：英文語系念 "Narration on"（en-US）；自訂文字覆寫；語系用注入的 getLocale', async () => {
  const env = makeEnv({ locale: 'en' })
  let p = env.n.unlock(); assert.deepEqual([env.synth.last.text, env.synth.last.lang], ['Narration on', 'en-US']); env.synth.last.onend(); assert.equal(await p, 'done')
  p = env.n.unlock('  Hello   there '); assert.equal(env.synth.last.text, 'Hello there'); env.synth.last.onend(); await p
  env.state.locale = 'zh'
  p = env.n.unlock('   '); assert.equal(env.synth.last.text, '旁白已開啟'); env.synth.last.onend(); await p          // 空白 → 預設
  p = env.n.unlock(42); assert.equal(env.synth.last.text, '旁白已開啟'); env.synth.last.onend(); await p              // 非字串 → 預設
})

test('unlock：onstart 就算成功（不必等念完）；之後的 onend 不會重複作用', async () => {
  const { n, synth } = makeEnv()
  let res = null
  const p = n.unlock(); p.then((r) => { res = r })
  synth.last.onstart(); await flush()
  assert.equal(res, 'done'); assert.equal(n.isUnlocked(), true)
  assert.equal(synth.last.onend, null, '結束後 handler 已清掉')
})

test('unlock：被擋（not-allowed 等）→ error，旗標維持 false；不丟例外、沒有殘留計時器', async () => {
  for (const code of ['not-allowed', 'synthesis-failed', 'audio-busy', undefined]) {
    const { n, synth, clock } = makeEnv()
    const p = n.unlock()
    assert.doesNotThrow(() => synth.last.onerror(code === undefined ? undefined : { error: code }))
    assert.equal(await p, 'error', String(code)); assert.equal(n.isUnlocked(), false, String(code)); assert.equal(clock.pending(), 0)
  }
})

test('unlock：speak() 已被接受、之後才被別句 cancel（interrupted / canceled）→ 仍算解鎖（WebKit 在手勢內呼叫 speak 的當下就解除限制）', async () => {
  for (const code of ['interrupted', 'canceled', 'cancelled']) {
    const { n, synth } = makeEnv()
    const p = n.unlock(); synth.last.onerror({ error: code })
    assert.equal(await p, 'done', code); assert.equal(n.isUnlocked(), true, code)
  }
})

test('unlock：引擎丟例外 / 建構子丟例外 / 計時器丟例外 → error，不丟例外', async () => {
  const a = makeEnv(); a.synth.speakError = new Error('engine down')
  assert.equal(await a.n.unlock(), 'error'); assert.equal(a.n.isUnlocked(), false); assert.equal(a.clock.pending(), 0)
  const clock = makeClock(), synth = new FakeSynth()
  class BadUtt { constructor() { throw new Error('nope') } }
  assert.equal(await createNarrator({ synth: () => synth, Utterance: BadUtt, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }).unlock(), 'error')
  assert.equal(await createNarrator({ synth: () => synth, Utterance: () => FakeUtterance, setTimeout: () => { throw new Error('no timers') }, clearTimeout: clock.clearTimeout }).unlock(), 'error')
  assert.equal(synth.spoken.length, 0)
})

test('unlock：沒有 speechSynthesis / Utterance → unsupported（不碰引擎）', async () => {
  const synth = new FakeSynth()
  assert.equal(await createNarrator({ synth: () => null, Utterance: () => FakeUtterance }).unlock(), 'unsupported')
  assert.equal(await createNarrator({ synth: () => synth, Utterance: () => null }).unlock(), 'unsupported')
  assert.equal(await createNarrator({ synth: () => { throw new Error('blocked') }, Utterance: () => FakeUtterance }).unlock(), 'unsupported')
  assert.equal(synth.spoken.length, 0)
  assert.equal(await narrator.unlock(), 'unsupported')          // 共用實例在 Node（沒有 speechSynthesis）
  assert.equal(narrator.isUnlocked(), false)
})

test('unlock：引擎沒有任何事件（iOS 被擋時可能靜悄悄）→ 逾時 error；沒有別句進行中才 cancel 引擎', async () => {
  const { n, synth, clock } = makeEnv()
  let res = null
  const p = n.unlock(); p.then((r) => { res = r })
  clock.advance(estimateSpeechMs('旁白已開啟', 'zh-TW') - 1); await flush(); assert.equal(res, null)
  clock.advance(1); await flush()
  assert.equal(res, 'error'); assert.equal(synth.cancels, 1); assert.equal(n.isUnlocked(), false); assert.equal(clock.pending(), 0)
  // 逾時時正好有一句字幕在念：不能被解鎖的逾時 cancel 掉
  const e2 = makeEnv()
  e2.n.unlock()
  const sp = e2.n.speak('這是一句比較長的字幕，念得比確認語久很多，所以確認語的逾時會先到'); e2.clock.advance(CANCEL_DELAY_MS)
  const c0 = e2.synth.cancels
  e2.clock.advance(estimateSpeechMs('旁白已開啟', 'zh-TW')); await flush()
  assert.equal(e2.synth.cancels, c0, '字幕進行中：不 cancel')
  assert.equal(e2.n.speaking(), true)
  e2.synth.last.onend(); assert.equal(await sp, 'done')
})

test('unlock 不動 cur / speaking：字幕進行中呼叫不會把字幕變成 cancelled；unlock 自己也不讓 speaking 變 true', async () => {
  const { n, synth, clock } = makeEnv()
  const events = []; n.onChange((v) => events.push(v))
  const up = n.unlock()
  assert.equal(n.speaking(), false); assert.deepEqual(events, [], '確認語不算「旁白進行中」')
  const sp = startSpeak({ n, clock }, '字幕')                 // speak 會 cancel 引擎：解鎖那句被 interrupted
  synth.spoken[0].onerror({ error: 'interrupted' })
  assert.equal(await up, 'done'); assert.equal(n.isUnlocked(), true)
  assert.equal(n.speaking(), true)
  synth.last.onend(); assert.equal(await sp, 'done')
  assert.deepEqual(events, [true, false])
})

test('unlock：旁白正在念且已經出過聲 → 直接 done（不念確認語、不排在字幕後面）', async () => {
  const { n, synth, clock } = makeEnv()
  const sp = startSpeak({ n, clock }, '字幕'); synth.last.onstart()
  assert.equal(n.isUnlocked(), true); assert.equal(n.speaking(), true)
  const before = synth.spoken.length
  assert.equal(await n.unlock(), 'done'); assert.equal(synth.spoken.length, before)
  synth.last.onend(); await sp
  assert.equal(await (async () => { const p = n.unlock(); synth.last.onend(); return p })(), 'done')   // 沒在念時照常念確認語
})

test('isUnlocked：一般 speak() 的 onstart / onend 也算「念過一次」；被擋的 speak 不算', async () => {
  const a = makeEnv()
  assert.equal(a.n.isUnlocked(), false)
  const p = startSpeak(a, '你好'); a.synth.last.onstart(); assert.equal(a.n.isUnlocked(), true); a.synth.last.onend(); await p
  const b = makeEnv()
  const q = startSpeak(b, '你好'); b.synth.last.onerror({ error: 'not-allowed' }); assert.equal(await q, 'error'); assert.equal(b.n.isUnlocked(), false)
  const c = makeEnv()
  const r = startSpeak(c, '你好'); c.synth.last.onend(); await r; assert.equal(c.n.isUnlocked(), true)
})

test('unlock / isUnlocked / unlockOnFirstGesture 可以脫離 narrator 物件呼叫（不依賴 this）', async () => {
  const { n, synth } = makeEnv()
  const { unlock, isUnlocked, unlockOnFirstGesture } = n
  const p = unlock(); synth.last.onend(); assert.equal(await p, 'done'); assert.equal(isUnlocked(), true)
  assert.equal(typeof unlockOnFirstGesture(new FakeWindow()), 'function')
})

test('dispose：進行中的解鎖 utterance 被結束（error）、計時器清乾淨；已解鎖的事實不會被重設', async () => {
  const { n, synth, clock } = makeEnv()
  const p = n.unlock()
  n.dispose()
  assert.equal(await p, 'error'); assert.equal(clock.pending(), 0)
  const p2 = n.unlock(); synth.last.onend(); assert.equal(await p2, 'done')
  n.dispose(); assert.equal(n.isUnlocked(), true)
})

// ---- unlockOnFirstGesture ----
const gestureEnv = (o) => { const e = makeEnv(o); e.win = new FakeWindow(); return e }

test('unlockOnFirstGesture：掛 pointerdown / keydown / touchend 三個 capture 監聽；沒有手勢就完全不出聲、不碰引擎', () => {
  const { n, synth, win } = gestureEnv()
  const off = n.unlockOnFirstGesture(win)
  assert.equal(typeof off, 'function')
  assert.deepEqual(win.list.map((x) => x.type).sort(), ['keydown', 'pointerdown', 'touchend'])
  assert.ok(win.list.every((x) => x.capture === true))
  assert.equal(synth.spoken.length, 0); assert.equal(synth.cancels, 0)
  assert.equal(n.isUnlocked(), false)
  off(); assert.equal(win.count(), 0)
})

test('unlockOnFirstGesture：第一次手勢「同步」無聲解鎖（音量 0 的空白 utterance，不 cancel），立刻拆掉所有監聽（一次性）；念完後 isUnlocked', async () => {
  const { n, synth, win, clock } = gestureEnv()
  n.unlockOnFirstGesture(win)
  win.dispatch('pointerdown', { pointerType: 'mouse' })
  assert.equal(synth.spoken.length, 1, '手勢事件的同一個呼叫堆疊內就 speak')
  assert.equal(synth.cancels, 0)
  const u = synth.last
  assert.deepEqual([u.text, u.volume], [SILENT_TEXT, 0]); assert.equal(SILENT_TEXT.trim(), '')
  assert.equal(win.count(), 0, '第一次手勢後全部拆掉')
  win.dispatch('keydown', { key: 'a' }); win.dispatch('touchend')
  assert.equal(synth.spoken.length, 1, '一次性：之後的手勢不再處理')
  assert.equal(n.isUnlocked(), false)
  u.onend(); await flush()
  assert.equal(n.isUnlocked(), true); assert.equal(win.count(), 0); assert.equal(clock.pending(), 0)
  assert.equal(n.speaking(), false, '無聲解鎖不算旁白進行中')
})

test('unlockOnFirstGesture：觸控的 pointerdown 不算啟用手勢（iOS 要等 touchend）；鍵盤只有修飾鍵 / Esc 不算', () => {
  const a = gestureEnv()
  a.n.unlockOnFirstGesture(a.win)
  a.win.dispatch('pointerdown', { pointerType: 'touch' }); a.win.dispatch('pointerdown', { pointerType: 'pen' })
  assert.equal(a.synth.spoken.length, 0); assert.equal(a.win.count(), 3, '監聽還在等下一個手勢')
  a.win.dispatch('touchend'); assert.equal(a.synth.spoken.length, 1); assert.equal(a.win.count(), 0)

  const b = gestureEnv()
  b.n.unlockOnFirstGesture(b.win)
  for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Escape']) b.win.dispatch('keydown', { key })
  assert.equal(b.synth.spoken.length, 0)
  b.win.dispatch('keydown', { key: 'Enter' }); assert.equal(b.synth.spoken.length, 1); assert.equal(b.win.count(), 0)

  const c = gestureEnv()                                        // 沒有 pointerType 的事件（舊瀏覽器 / 合成事件）當滑鼠
  c.n.unlockOnFirstGesture(c.win); c.win.dispatch('pointerdown'); assert.equal(c.synth.spoken.length, 1)
})

test('unlockOnFirstGesture：off() 移除所有監聽、之後手勢不再解鎖；off() 可重複呼叫', () => {
  const { n, synth, win } = gestureEnv()
  const off = n.unlockOnFirstGesture(win)
  off(); assert.equal(win.count(), 0)
  win.dispatch('pointerdown'); assert.equal(synth.spoken.length, 0)
  assert.doesNotThrow(() => { off(); off() })
  assert.equal(win.adds, win.removes)                          // 無洩漏：掛幾個拆幾個
})

test('unlockOnFirstGesture：重複註冊安全——同一個 window 只掛一組，以參照計數；StrictMode 雙掛載（掛 → 拆 → 掛）正常', () => {
  const { n, synth, win } = gestureEnv()
  const off1 = n.unlockOnFirstGesture(win), off2 = n.unlockOnFirstGesture(win)
  assert.equal(win.count(), 3, '沒有重複掛')
  off1(); assert.equal(win.count(), 3, '還有人需要')
  off1(); assert.equal(win.count(), 3, '同一個 off 只算一次')
  off2(); assert.equal(win.count(), 0)
  const off3 = n.unlockOnFirstGesture(win)                     // 雙掛載的第二次
  assert.equal(win.count(), 3)
  win.dispatch('keydown', { key: 'x' }); assert.equal(synth.spoken.length, 1); assert.equal(win.count(), 0)
  assert.doesNotThrow(() => off3())                            // 觸發後才呼叫舊的 off：安全
  assert.equal(win.adds, win.removes)
})

test('unlockOnFirstGesture：不支援（沒有 speechSynthesis）或已經解鎖 → 直接回 no-op，不掛任何監聽', async () => {
  const win = new FakeWindow()
  const off = createNarrator({ synth: () => null, Utterance: () => FakeUtterance }).unlockOnFirstGesture(win)
  assert.equal(typeof off, 'function'); assert.equal(win.count(), 0); assert.doesNotThrow(off)
  const { n, synth } = makeEnv()
  const p = n.unlock(); synth.last.onend(); await p
  const w2 = new FakeWindow(); n.unlockOnFirstGesture(w2); assert.equal(w2.count(), 0, '已解鎖不必再等手勢')
  assert.doesNotThrow(() => n.unlockOnFirstGesture(null)); assert.doesNotThrow(() => n.unlockOnFirstGesture({}))   // 壞的 window
})

test('unlockOnFirstGesture：被擋（第一下可能不是瀏覽器認可的手勢）→ 重新掛監聽，最多再試到 MAX_GESTURE_TRIES 次；成功就停', async () => {
  const { n, synth, win } = gestureEnv()
  n.unlockOnFirstGesture(win)
  for (let i = 1; i <= MAX_GESTURE_TRIES; i++) {
    assert.equal(win.count(), 3, `第 ${i} 次嘗試前監聽在`)
    win.dispatch('touchend'); assert.equal(synth.spoken.length, i)
    assert.deepEqual([synth.last.text, synth.last.volume], [i === 1 ? SILENT_TEXT : SILENT_WORD, 0], '第一次空白；被擋後改用音量 0 的單字（引擎不接受空白時的退路）')
    assert.equal(win.count(), 0, '嘗試當下先拆')
    synth.last.onerror({ error: 'not-allowed' }); await flush()
  }
  assert.equal(win.count(), 0, '試滿就放棄，不再監聽'); assert.equal(n.isUnlocked(), false)
  // 第二次成功的情形
  const e = gestureEnv(); e.n.unlockOnFirstGesture(e.win)
  e.win.dispatch('touchend'); e.synth.last.onerror({ error: 'not-allowed' }); await flush(); assert.equal(e.win.count(), 3)
  e.win.dispatch('touchend'); e.synth.last.onend(); await flush()
  assert.equal(e.win.count(), 0); assert.equal(e.n.isUnlocked(), true); assert.equal(e.synth.spoken.length, 2)
})

test('unlockOnFirstGesture：等結果的期間被 off() / dispose() / 別條路徑解鎖 → 不會再重新掛監聽（無洩漏）', async () => {
  const a = gestureEnv(); const offA = a.n.unlockOnFirstGesture(a.win)
  a.win.dispatch('touchend'); offA(); a.synth.last.onerror({ error: 'not-allowed' }); await flush()
  assert.equal(a.win.count(), 0)
  const b = gestureEnv(); b.n.unlockOnFirstGesture(b.win)
  b.win.dispatch('touchend'); b.n.dispose(); await flush(); assert.equal(b.win.count(), 0)
  const c = gestureEnv(); c.n.unlockOnFirstGesture(c.win)
  const up = c.n.unlock(); c.synth.last.onend(); await up                  // 按鈕的解鎖先成功：等手勢的監聽跟著拆掉
  assert.equal(c.n.isUnlocked(), true); assert.equal(c.win.count(), 0)
  const d = gestureEnv(); d.n.unlockOnFirstGesture(d.win); d.n.dispose(); assert.equal(d.win.count(), 0)
  for (const e of [a, b, c, d]) assert.equal(e.win.adds, e.win.removes)
})

test('unlockOnFirstGesture：監聽掛到一半丟例外 → 撤掉已掛的、回 no-op、不丟例外', () => {
  const { n, win } = gestureEnv()
  win.failAdd = true
  let off
  assert.doesNotThrow(() => { off = n.unlockOnFirstGesture(win) })
  assert.equal(win.count(), 0); assert.doesNotThrow(off)
  win.failAdd = false
  n.unlockOnFirstGesture(win); assert.equal(win.count(), 3)        // 之後仍可正常註冊
})

test('unlockOnFirstGesture：win 省略 → 在「呼叫當下」才讀全域 window（先建立、後出現也行）', () => {
  const { n, synth } = makeEnv()
  const w = new FakeWindow()
  globalThis.window = w
  try {
    const off = n.unlockOnFirstGesture()
    assert.equal(w.count(), 3)
    w.dispatch('keydown', { key: 'a' }); assert.equal(synth.spoken.length, 1)
    off()
  } finally { delete globalThis.window }
  assert.doesNotThrow(() => n.unlockOnFirstGesture())              // 沒有 window：no-op
})

test('unlock 與 unlockOnFirstGesture：無聲解鎖的 utterance 用語系對應的 lang；不設 voice（音量 0 不需要）', () => {
  const { n, synth, win, state } = gestureEnv({ voices: [V('zh-TW', true, 'tw')] })
  state.locale = 'en'
  n.unlockOnFirstGesture(win); win.dispatch('touchend')
  assert.equal(synth.last.lang, 'en-US'); assert.equal(synth.last.voice, null)
})

test('unlock 的確認語會挑聲音（有合適的聲音時）', async () => {
  const { n, synth } = makeEnv({ voices: [V('zh-TW', true, 'tw'), V('en-US', true)] })
  const p = n.unlock(); assert.equal(synth.last.voice.name, 'tw'); synth.last.onend(); await p
})
