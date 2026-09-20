// 語音辨識包裝（lib/voice.js）單元測試。執行：node --test src/lib/voice.test.mjs
// 瀏覽器 API 全部以假物件注入：假 SpeechRecognition（可手動觸發 start / result / error / end 事件）、假時鐘與計時器。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createVoice, getRecognitionCtor, isVoiceSupported, ERROR_TEXT,
  MAX_FAILS, BACKOFF_MS, RESTART_MS, LANG_RESTART_MS, MIN_OK_MS,
} from './voice.js'
import { registerEn, setLocale, t } from '../i18n/index.js'
import voiceEn from '../i18n/en/voice.js'

// ---- 假時鐘：advance(ms) 依時間順序執行到期的計時器 ----
function makeClock() {
  let now = 1000, seq = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimeoutFn: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id },
    clearTimeoutFn: (id) => { timers.delete(id) },
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
  }
}

// ---- 假 SpeechRecognition ----
const mkResults = (arr) => arr.map(([text, fin]) => Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal: !!fin }))
function makeEnv({ supported = true } = {}) {
  const clock = makeClock()
  const instances = []
  class FakeSR {
    constructor() { instances.push(this); this.started = false; this.aborted = 0; this.lang = ''; this.onstart = this.onresult = this.onerror = this.onend = null }
    start() { if (FakeSR.failStart) { const e = new Error('already started'); e.name = 'InvalidStateError'; throw e } this.started = true }
    abort() { this.aborted++; this.started = false }
    // 以下是測試用：模擬瀏覽器觸發事件
    emitStart() { this.onstart && this.onstart() }
    emitResult(list, resultIndex = 0) { this.onresult && this.onresult({ resultIndex, results: mkResults(list) }) }
    emitError(code) { this.onerror && this.onerror({ error: code }) }
    emitEnd() { this.started = false; this.onend && this.onend() }
  }
  FakeSR.failStart = false
  const voice = createVoice({ getCtor: () => (supported ? FakeSR : null), now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn })
  const cmds = []
  voice.onCommand((f) => cmds.push(f.id))
  return { clock, instances, voice, FakeSR, cmds, last: () => instances[instances.length - 1] }
}

test('start：建立辨識器（continuous + interimResults + 語言），onstart 之後才算收音中', () => {
  const { voice, instances, last } = makeEnv()
  assert.equal(voice.getState().enabled, false)
  assert.equal(instances.length, 0)                       // 沒有 start() 之前完全不碰辨識器
  assert.equal(voice.start(), true)
  assert.equal(instances.length, 1)
  const sr = last()
  assert.equal(sr.continuous, true)
  assert.equal(sr.interimResults, true)
  assert.equal(sr.maxAlternatives, 1)
  assert.equal(sr.lang, 'zh-TW')
  assert.equal(sr.started, true)
  assert.equal(voice.getState().enabled, true)
  assert.equal(voice.getState().listening, false)
  sr.emitStart()
  assert.equal(voice.getState().listening, true)
  assert.equal(voice.start(), true)                        // 重複開啟不會多建實例
  assert.equal(instances.length, 1)
})

test('interim 結果就觸發（低延遲）；final 不重複；同一指令 1.5 秒冷卻', () => {
  const { voice, cmds, clock, last } = makeEnv()
  voice.start(); last().emitStart()
  last().emitResult([['鯨魚', false]])
  assert.deepEqual(cmds, ['whale'])
  last().emitResult([['鯨魚', true]])                       // 同一句 final
  assert.deepEqual(cmds, ['whale'])
  clock.advance(500)
  last().emitResult([['鯨魚', true], ['鯨魚', true]], 1)   // 另一段又說了一次，冷卻中
  assert.deepEqual(cmds, ['whale'])
  clock.advance(1500)
  last().emitResult([['鯨魚', true], ['鯨魚', true], ['鯨魚', true]], 2)
  assert.deepEqual(cmds, ['whale', 'whale'])
})

test('一句多個指令依序觸發；lastText 只在 final 更新', () => {
  const { voice, cmds, last } = makeEnv()
  voice.start(); last().emitStart()
  last().emitResult([['鯨魚 大浪', false]])
  assert.deepEqual(cmds, ['whale', 'bigwave'])
  assert.equal(voice.getState().lastText, '')
  last().emitResult([['鯨魚 大浪', true]])
  assert.equal(voice.getState().lastText, '鯨魚 大浪')
})

test('onend 自動重啟：250ms 後換新實例，收音狀態不閃，也不算失敗', () => {
  const { voice, instances, clock, last } = makeEnv()
  voice.start(); last().emitStart()
  clock.advance(5000)
  last().emitEnd()                                          // Chrome 靜音逾時
  assert.equal(voice.getState().listening, true)
  clock.advance(RESTART_MS - 1)
  assert.equal(instances.length, 1)
  clock.advance(1)
  assert.equal(instances.length, 2)
  assert.equal(last().continuous, true)
  last().emitStart()
  assert.equal(voice.getState().enabled, true)
  assert.equal(voice.getState().error, null)
})

test('撐過 MIN_OK_MS 沒有結果也算成功（只是沒人說話）：可以無限重啟', () => {
  const { voice, instances, clock, last } = makeEnv()
  voice.start()
  for (let i = 0; i < 12; i++) { last().emitStart(); clock.advance(MIN_OK_MS); last().emitEnd(); clock.advance(RESTART_MS) }
  assert.equal(instances.length, 13)
  assert.equal(voice.getState().enabled, true)
  assert.equal(voice.getState().error, null)
})

test('no-speech：忽略、不算失敗，即使瞬間結束也照常重啟', () => {
  const { voice, instances, clock, last } = makeEnv()
  voice.start()
  for (let i = 0; i < 10; i++) { last().emitError('no-speech'); last().emitEnd(); clock.advance(RESTART_MS) }
  assert.equal(instances.length, 11)
  assert.equal(voice.getState().enabled, true)
  assert.equal(voice.getState().error, null)
})

test('連續失敗：退避重啟（0.4 / 0.8 / 1.6 / 3.2 秒），第 5 次就停用並提示', () => {
  assert.equal(MAX_FAILS, 5)
  const { voice, instances, clock, last } = makeEnv()
  voice.start()
  for (let n = 1; n < MAX_FAILS; n++) {
    assert.equal(instances.length, n)
    last().emitEnd()                                        // 沒有結果、瞬間結束 = 一次失敗
    assert.equal(voice.getState().enabled, true)
    clock.advance(BACKOFF_MS[n - 1] - 1)
    assert.equal(instances.length, n, `第 ${n} 次失敗後要等 ${BACKOFF_MS[n - 1]}ms`)
    clock.advance(1)
    assert.equal(instances.length, n + 1)
  }
  last().emitEnd()                                          // 第 5 次
  const st = voice.getState()
  assert.equal(st.enabled, false)
  assert.equal(st.error, 'failed')
  assert.equal(st.listening, false)
  assert.equal(clock.pending(), 0)
  clock.advance(60000)
  assert.equal(instances.length, MAX_FAILS)                 // 不再重啟
})

test('network：顯示提示並退避重試，5 次後停用（錯誤仍是 network）；恢復後提示消失', () => {
  const { voice, instances, clock, last } = makeEnv()
  voice.start()
  last().emitError('network'); last().emitEnd()
  assert.equal(voice.getState().error, 'network')
  assert.equal(voice.getState().enabled, true)               // 重試中
  clock.advance(BACKOFF_MS[0])
  assert.equal(instances.length, 2)
  last().emitStart()
  last().emitResult([['你好', false]])                        // 有結果 = 連得上了
  assert.equal(voice.getState().error, null)

  const env2 = makeEnv()
  env2.voice.start()
  for (let n = 1; n < MAX_FAILS; n++) { env2.last().emitError('network'); env2.last().emitEnd(); env2.clock.advance(BACKOFF_MS[n - 1]) }
  env2.last().emitError('network'); env2.last().emitEnd()
  assert.equal(env2.voice.getState().enabled, false)
  assert.equal(env2.voice.getState().error, 'network')
})

for (const [code, expected] of [['not-allowed', 'denied'], ['service-not-allowed', 'service'], ['audio-capture', 'nomic'], ['language-not-supported', 'language']]) {
  test(`${code}：立即停用、不重啟（錯誤碼 ${expected}）`, () => {
    const { voice, instances, clock, last } = makeEnv()
    voice.start()
    const sr = last()
    sr.emitError(code)
    const st = voice.getState()
    assert.equal(st.enabled, false)
    assert.equal(st.error, expected)
    assert.equal(sr.aborted, 1)                              // 確實放掉
    assert.equal(sr.onend, null)
    sr.emitEnd()                                              // 瀏覽器隨後送的 end 不會再觸發任何事
    assert.equal(clock.pending(), 0)
    clock.advance(60000)
    assert.equal(instances.length, 1)
    assert.ok(ERROR_TEXT[expected])
  })
}

test('aborted（被別的 App / 分頁搶走）算失敗、退避重啟；一有辨識結果就把失敗計數歸零', () => {
  const { voice, instances, clock, last } = makeEnv()
  voice.start()
  for (let i = 0; i < 4; i++) { last().emitError('aborted'); last().emitEnd(); clock.advance(BACKOFF_MS[i]) }
  assert.equal(instances.length, 5)
  assert.equal(voice.getState().enabled, true)
  last().emitStart()
  last().emitResult([['你好', true]])
  last().emitEnd(); clock.advance(RESTART_MS)
  assert.equal(instances.length, 6)
  for (let i = 0; i < 4; i++) { last().emitError('aborted'); last().emitEnd(); clock.advance(BACKOFF_MS[i]) }   // 又 4 次失敗：因為歸零過，還撐得住
  assert.equal(voice.getState().enabled, true)
})

test('stop()：abort、拔掉 handler、遲到的事件全部忽略、計時器清空', () => {
  const { voice, cmds, instances, clock, last } = makeEnv()
  voice.start(); last().emitStart()
  const sr = last()
  const late = { onresult: sr.onresult, onend: sr.onend, onerror: sr.onerror, onstart: sr.onstart }
  voice.stop()
  assert.equal(sr.aborted, 1)
  assert.equal(sr.onresult, null); assert.equal(sr.onend, null); assert.equal(sr.onerror, null); assert.equal(sr.onstart, null)
  const st = voice.getState()
  assert.equal(st.enabled, false); assert.equal(st.listening, false); assert.equal(st.error, null)
  late.onresult({ resultIndex: 0, results: mkResults([['鯨魚', true]]) })   // 遲到的結果
  late.onstart(); late.onerror({ error: 'network' }); late.onend()
  assert.deepEqual(cmds, [])
  assert.equal(voice.getState().listening, false)
  assert.equal(clock.pending(), 0)
  clock.advance(60000)
  assert.equal(instances.length, 1)
})

test('stop() 在等待重啟期間也會取消計時器；stop 後可以重新 start', () => {
  const { voice, instances, clock, last } = makeEnv()
  voice.start(); last().emitStart(); clock.advance(5000)
  last().emitEnd()                                          // 排了 250ms 後重啟
  assert.equal(clock.pending(), 1)
  voice.stop()
  assert.equal(clock.pending(), 0)
  clock.advance(1000)
  assert.equal(instances.length, 1)
  voice.start()
  assert.equal(instances.length, 2)
  assert.equal(voice.getState().enabled, true)
})

test('stop() 之後冷卻歸零：重新開始可以立刻再觸發同一指令', () => {
  const { voice, cmds, last } = makeEnv()
  voice.start(); last().emitResult([['鯨魚', true]])
  voice.stop(); voice.start(); last().emitResult([['鯨魚', true]])
  assert.deepEqual(cmds, ['whale', 'whale'])
})

test('setLang：收音中 abort 舊實例、用新語言重啟，指令比對跟著換', () => {
  const { voice, cmds, instances, clock, last } = makeEnv()
  voice.start(); last().emitStart()
  const first = last()
  voice.setLang('en-US')
  assert.equal(voice.getState().lang, 'en-US')
  assert.equal(first.aborted, 1)
  assert.equal(first.onresult, null)
  assert.equal(instances.length, 1)
  clock.advance(LANG_RESTART_MS)
  assert.equal(instances.length, 2)
  assert.equal(last().lang, 'en-US')
  last().emitStart()
  last().emitResult([['big wave', false]])
  assert.deepEqual(cmds, ['bigwave'])
  voice.setLang('en-US')                                    // 沒變就不重啟
  clock.advance(1000)
  assert.equal(instances.length, 2)
})

test('setLang：沒在收音時只記下語言，不建立辨識器', () => {
  const { voice, instances, clock } = makeEnv()
  voice.setLang('en-US')
  clock.advance(1000)
  assert.equal(instances.length, 0)
  voice.start()
  assert.equal(instances[0].lang, 'en-US')
})

test('suspend / resume：分頁進背景就放掉麥克風，回前景接續（不需要手勢）', () => {
  const { voice, instances, clock, last } = makeEnv()
  voice.suspend(); voice.resume()                            // 沒開啟時是 no-op
  assert.equal(instances.length, 0)
  voice.start(); last().emitStart()
  const sr = last()
  voice.suspend()
  assert.equal(sr.aborted, 1)
  assert.equal(voice.getState().suspended, true)
  assert.equal(voice.getState().listening, false)
  assert.equal(voice.getState().enabled, true)               // 仍是「已開啟」，只是暫停
  clock.advance(60000)
  assert.equal(instances.length, 1)
  voice.resume()
  assert.equal(instances.length, 2)
  assert.equal(voice.getState().suspended, false)
  last().emitStart()
  assert.equal(voice.getState().listening, true)
  voice.stop()
  assert.equal(voice.getState().suspended, false)
})

test('不支援 SpeechRecognition：start() 回 false、提示 unsupported、不建立實例', () => {
  const { voice, instances } = makeEnv({ supported: false })
  assert.equal(voice.getState().supported, false)
  assert.equal(voice.start(), false)
  assert.equal(voice.getState().enabled, false)
  assert.equal(voice.getState().error, 'unsupported')
  assert.equal(instances.length, 0)
})

test('start() 同步丟例外（InvalidStateError）：當作失敗退避重試，5 次後停用', () => {
  const { voice, instances, clock, FakeSR } = makeEnv()
  FakeSR.failStart = true
  voice.start()
  assert.equal(instances.length, 1)
  for (let i = 0; i < MAX_FAILS - 1; i++) clock.advance(BACKOFF_MS[i])
  assert.equal(instances.length, MAX_FAILS)
  assert.equal(voice.getState().enabled, false)
  assert.equal(voice.getState().error, 'failed')
  assert.equal(clock.pending(), 0)
})

test('subscribe：狀態真的改變才通知；getState 沒變時是同一個物件；取消訂閱後不再通知', () => {
  const { voice, last } = makeEnv()
  let n = 0
  const off = voice.subscribe(() => { n++ })
  voice.start()
  assert.equal(n, 1)
  const s1 = voice.getState()
  assert.equal(voice.getState(), s1)
  last().emitStart()
  assert.equal(n, 2)
  assert.notEqual(voice.getState(), s1)
  last().emitStart()                                         // 沒有變化
  assert.equal(n, 2)
  off()
  voice.stop()
  assert.equal(n, 2)
})

test('指令訂閱者丟例外不影響其他訂閱者，也不影響辨識', () => {
  const { voice, cmds, last } = makeEnv()
  voice.onCommand(() => { throw new Error('boom') })
  voice.start(); last().emitStart()
  assert.doesNotThrow(() => last().emitResult([['鯨魚', false]]))
  assert.deepEqual(cmds, ['whale'])
  assert.equal(voice.getState().enabled, true)
})

test('destroy：釋放辨識器並清掉所有訂閱', () => {
  const { voice, cmds, last } = makeEnv()
  let n = 0
  voice.subscribe(() => { n++ })
  voice.start()
  const sr = last()
  const n0 = n
  voice.destroy()
  assert.equal(sr.aborted, 1)
  assert.ok(n >= n0)
  const n1 = n
  voice.start(); last().emitResult([['鯨魚', false]])
  assert.equal(n, n1)                                        // 訂閱已清掉
  assert.deepEqual(cmds, [])
})

test('getRecognitionCtor：標準 / webkit 前綴 / 都沒有', () => {
  class A {} class B {}
  assert.equal(getRecognitionCtor({ SpeechRecognition: A }), A)
  assert.equal(getRecognitionCtor({ webkitSpeechRecognition: B }), B)
  assert.equal(getRecognitionCtor({ SpeechRecognition: A, webkitSpeechRecognition: B }), A)
  assert.equal(getRecognitionCtor({}), null)
  assert.equal(isVoiceSupported({}), false)
  assert.equal(isVoiceSupported({ webkitSpeechRecognition: B }), true)
})

test('錯誤提示：每個錯誤碼都有文字，英文模式下沒有中文', () => {
  registerEn(voiceEn)
  for (const code of ['denied', 'service', 'network', 'nomic', 'language', 'unsupported', 'failed']) assert.ok(ERROR_TEXT[code], code)
  setLocale('en')
  try {
    for (const [code, key] of Object.entries(ERROR_TEXT)) assert.ok(!/[㐀-鿿]/.test(t(key)), `${code} → ${t(key)}`)
  } finally { setLocale('zh') }
})
