// 遙控頁專用的輕量螢幕喚醒單元測試。執行：node --test src/lib/wakeLockLite.test.mjs
// 假 navigator.wakeLock / 假 sentinel / 假 document 都會檢查 this（原生方法脫離原物件呼叫會丟 Illegal invocation）；
// 假 sentinel 對「已釋放再 release」會丟例外（偵測有沒有多餘的重複呼叫）；可模擬系統放掉 lock（release 事件）、請求被拒、請求同步丟例外、請求延遲。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { illegal } from './tourTestEnv.mjs'
import { holdScreenAwake, wakeLockSupported } from './wakeLockLite.js'

const flush = () => new Promise((r) => setImmediate(r))

function makeSentinel() {
  const L = new Set()
  const s = {
    released: false, releaseCalls: 0,
    addEventListener(ev, f) { if (this !== s) throw illegal(); if (ev === 'release') L.add(f) },
    removeEventListener(ev, f) { if (this !== s) throw illegal(); if (ev === 'release') L.delete(f) },
    release() {
      if (this !== s) throw illegal()
      s.releaseCalls++
      if (s.released) throw new Error('InvalidStateError: already released')   // 嚴格：重複 release 會丟例外
      s.released = true
      for (const f of [...L]) f({ type: 'release' })
      return Promise.resolve()
    },
    sysRelease() { s.released = true; for (const f of [...L]) f({ type: 'release' }) },   // 系統放掉（分頁進背景 / 省電）：released 變 true 並發 release 事件
    listeners: () => L.size,
  }
  return s
}

function fakeEnv({ visible = true, delay = 0, reject = null, throwSync = false, noListenerApi = false } = {}) {
  const sentinels = []
  const docL = new Set()
  const wakeLock = {
    requests: 0,
    request(type) {
      if (this !== wakeLock) throw illegal()
      wakeLock.requests++
      assert.equal(type, 'screen')
      if (throwSync) throw new Error('boom')
      return new Promise((resolve, rejectP) => {
        const settle = () => {
          if (reject) return rejectP(reject)
          const s = makeSentinel()
          if (noListenerApi) { delete s.addEventListener; delete s.removeEventListener }
          sentinels.push(s); resolve(s)
        }
        if (delay > 0) setTimeout(settle, delay); else queueMicrotask(settle)
      })
    },
  }
  const doc = {
    visibilityState: visible ? 'visible' : 'hidden',
    addEventListener(ev, f) { if (this !== doc) throw illegal(); if (ev === 'visibilitychange') docL.add(f) },
    removeEventListener(ev, f) { if (this !== doc) throw illegal(); if (ev === 'visibilitychange') docL.delete(f) },
  }
  const states = []
  // 瀏覽器行為：分頁隱藏 → 系統自動放掉所有 lock（先設可見性、再發 visibilitychange）
  const setVisible = (v) => {
    doc.visibilityState = v ? 'visible' : 'hidden'
    if (!v) for (const s of sentinels) if (!s.released) s.sysRelease()
    for (const f of [...docL]) f()
  }
  return { nav: { wakeLock }, doc, sentinels, wakeLock, docL, states, onState: (s) => states.push(s), setVisible }
}
const hold = (e) => holdScreenAwake({ nav: e.nav, doc: e.doc, onState: e.onState })

test('wakeLockSupported：有 navigator.wakeLock.request 才算；沒有 / 不是函式 / 壞環境 → false（不丟例外）；沒傳參數時在呼叫當下讀全域 navigator', () => {
  assert.equal(wakeLockSupported({ wakeLock: { request() {} } }), true)
  for (const bad of [null, {}, { wakeLock: null }, { wakeLock: {} }, { wakeLock: { request: 5 } }]) assert.equal(wakeLockSupported(bad), false)
  const evil = { get wakeLock() { throw new Error('getter boom') } }
  assert.equal(wakeLockSupported(evil), false)
  assert.equal(wakeLockSupported(), false, 'Node 沒有 navigator.wakeLock')
})

test('申請 screen wake lock（以方法呼叫）：pending → on；release 放掉 sentinel、移除 visibilitychange 監聽；可重複呼叫、不會對已放掉的 sentinel 再 release', async () => {
  const e = fakeEnv()
  const release = hold(e)
  assert.deepEqual(e.states, ['pending'])
  await flush()
  assert.equal(e.wakeLock.requests, 1)
  assert.deepEqual(e.states, ['pending', 'on'])
  assert.equal(e.docL.size, 1)
  assert.equal(e.sentinels[0].listeners(), 1)
  release()
  assert.equal(e.sentinels[0].released, true)
  assert.equal(e.sentinels[0].releaseCalls, 1)
  assert.equal(e.sentinels[0].listeners(), 0, 'release 事件的監聽也移除')
  assert.equal(e.docL.size, 0)
  release(); release()
  assert.equal(e.sentinels[0].releaseCalls, 1, '重複 release 不會再碰 sentinel')
  assert.deepEqual(e.states, ['pending', 'on'], 'release 之後不再通知')
})

test('已持有 / 請求中時不重複請求（多次 visibilitychange、StrictMode 式重複觸發）', async () => {
  const e = fakeEnv({ delay: 20 })
  const release = hold(e)
  e.setVisible(true); e.setVisible(true)                     // 請求還沒完成：不重複請求
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(e.wakeLock.requests, 1)
  e.setVisible(true); e.setVisible(true)                     // 已持有：不重複請求
  await flush()
  assert.equal(e.wakeLock.requests, 1)
  assert.equal(e.sentinels.length, 1)
  release()
  assert.equal(e.sentinels[0].releaseCalls, 1)
})

test('請求還沒完成就 release（StrictMode 雙掛載 / 連線很快斷）：晚到的 lock 立刻放掉，不洩漏；第二次掛載的保持', async () => {
  const e = fakeEnv({ delay: 20 })
  const r1 = hold(e)                                         // 第一次 effect
  r1()                                                       // 立刻 cleanup
  const r2 = hold(e)                                         // 第二次 effect
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(e.sentinels.length, 2)
  assert.equal(e.sentinels[0].released, true, '第一個（已 cleanup）的被放掉')
  assert.equal(e.sentinels[0].releaseCalls, 1)
  assert.equal(e.sentinels[1].released, false, '第二個保持')
  assert.equal(e.docL.size, 1, '只剩第二個的監聽')
  r2()
  assert.ok(e.sentinels.every((s) => s.released && s.releaseCalls === 1), '全部放掉，沒有殘留')
  assert.equal(e.docL.size, 0)
})

test('系統放掉 lock（分頁進背景 → sentinel 發 release 事件、released=true）→ off；回到前景重新申請 → on；隱藏中不申請；之後 release 不再對舊 sentinel 呼叫 release', async () => {
  const e = fakeEnv()
  const release = hold(e)
  await flush()
  e.setVisible(false)
  assert.equal(e.sentinels[0].released, true)
  assert.equal(e.states.at(-1), 'off')
  await flush()
  assert.equal(e.wakeLock.requests, 1, '隱藏中不申請')
  e.setVisible(true); await flush()
  assert.equal(e.wakeLock.requests, 2, '回到前景重新申請')
  assert.equal(e.states.at(-1), 'on')
  assert.equal(e.sentinels[1].released, false)
  release()
  assert.equal(e.sentinels[0].releaseCalls, 0, '舊的是系統放掉的：我們不再呼叫它的 release')
  assert.equal(e.sentinels[1].releaseCalls, 1)
})

test('沒有 release 事件 API 的實作（舊瀏覽器）：靠 sentinel.released 判斷，回到前景照樣重新申請', async () => {
  const e = fakeEnv({ noListenerApi: true })
  const release = hold(e)
  await flush()
  assert.deepEqual(e.states.at(-1), 'on')
  e.sentinels[0].released = true                             // 系統放掉了、但沒有事件
  e.setVisible(true); await flush()
  assert.equal(e.wakeLock.requests, 2)
  release()
  assert.equal(e.sentinels[1].releaseCalls, 1)
})

test('隱藏狀態下啟動：不申請（也不通知），等到可見才申請', async () => {
  const e = fakeEnv({ visible: false })
  const release = hold(e)
  await flush()
  assert.equal(e.wakeLock.requests, 0)
  assert.deepEqual(e.states, [])
  e.setVisible(true); await flush()
  assert.equal(e.wakeLock.requests, 1)
  assert.equal(e.states.at(-1), 'on')
  release()
})

test('不支援（沒有 navigator.wakeLock / request 不是函式 / nav 是 null）：通知 unsupported、不掛任何監聽、release 是安全的空操作', () => {
  for (const nav of [{}, { wakeLock: {} }, { wakeLock: { request: 1 } }, null]) {
    const states = []
    const doc = { visibilityState: 'visible', addEventListener() { throw new Error('不該掛監聽') }, removeEventListener() {} }
    const release = holdScreenAwake({ nav, doc, onState: (s) => states.push(s) })
    assert.deepEqual(states, ['unsupported'])
    assert.doesNotThrow(() => release())
    assert.doesNotThrow(() => release())
  }
})

test('請求被拒（省電模式 / 權限政策）→ failed，不丟例外；之後回到前景會再試；同步丟例外的舊 API 也一樣', async () => {
  const e = fakeEnv({ reject: Object.assign(new Error('battery saver'), { name: 'NotAllowedError' }) })
  const release = hold(e)
  await flush(); await flush()
  assert.deepEqual(e.states, ['pending', 'failed'])
  assert.equal(e.sentinels.length, 0)
  e.setVisible(true); await flush(); await flush()
  assert.equal(e.wakeLock.requests, 2, '被拒之後回到前景仍會再試（pending 已清掉）')
  release()
  const t = fakeEnv({ throwSync: true })
  let release2
  assert.doesNotThrow(() => { release2 = hold(t) })
  assert.equal(t.states.at(-1), 'failed')
  assert.doesNotThrow(() => release2())
  const n = fakeEnv({ reject: null })
  n.wakeLock.request = function request() { if (this !== n.wakeLock) throw illegal(); return Promise.resolve(null) }   // 回傳空（怪環境）
  const r3 = hold(n); await flush()
  assert.equal(n.states.at(-1), 'failed')
  r3()
})

test('sentinel.release 丟例外 / 回傳被拒的 Promise → 吞掉；onState 丟例外不影響喚醒', async () => {
  const e = fakeEnv()
  const release = holdScreenAwake({ nav: e.nav, doc: e.doc, onState: () => { throw new Error('state boom') } })
  await flush()
  assert.equal(e.sentinels.length, 1)
  e.sentinels[0].release = function release() { throw new Error('release boom') }
  assert.doesNotThrow(() => release())
  const e2 = fakeEnv()
  const r2 = hold(e2)
  await flush()
  e2.sentinels[0].release = function release() { return Promise.reject(new Error('async boom')) }
  assert.doesNotThrow(() => r2())
  await flush()                                              // 沒有 unhandledRejection（測試程序不會被中止）
})

test('原生呼叫以方法呼叫：假 wakeLock / sentinel / document 會檢查 this（對照組：脫離原物件呼叫會丟 Illegal invocation）', async () => {
  const e = fakeEnv()
  const f = e.wakeLock.request
  assert.throws(() => f('screen'), /Illegal invocation/)
  const s = makeSentinel(); const rel = s.release
  assert.throws(() => rel(), /Illegal invocation/)
  const r = hold(e); await flush(); r()                       // 正確寫法不會丟
  assert.equal(e.states.at(-1), 'on')
})

test('接線：遙控頁只在「導覽員模式且已連線」時啟用，離開 / 中止時釋放；一般遙控不啟用；遙控頁不 import 主畫面的 lib/wakeLock.js', () => {
  const app = readFileSync(new URL('../remote/RemoteApp.jsx', import.meta.url), 'utf8')
  assert.match(app, /import \{ holdScreenAwake \} from '\.\.\/lib\/wakeLockLite\.js'/)
  assert.doesNotMatch(app, /lib\/wakeLock\.js/)
  assert.doesNotMatch(app, /navigator\.wakeLock/, '不直接碰 navigator.wakeLock（走 wakeLockLite）')
  assert.match(app, /if \(!\(isGuide && ok\)\) \{ setWake\(''\); return undefined \}\n\s+return holdScreenAwake\(\{ onState: setWake \}\)\n\s+\}, \[isGuide, ok\]\)/)
})
