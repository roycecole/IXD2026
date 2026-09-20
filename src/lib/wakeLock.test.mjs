// 螢幕喚醒鎖單元測試。執行：node --test src/lib/wakeLock.test.mjs
// 瀏覽器專屬：navigator.wakeLock.request 是原生方法，拆開呼叫會丟 Illegal invocation → 假物件也要檢查 this。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { keepAwake } from './wakeLock.js'

const flush = () => new Promise((r) => setImmediate(r))

function fakeEnv({ visible = true, delay = 0, reject = null } = {}) {
  const locks = []          // 曾經發出的 sentinel
  const listeners = new Set()
  const wakeLock = {
    requests: 0,
    request(type) {
      if (this !== wakeLock) throw new TypeError('Illegal invocation')   // 原生函式必須以方法呼叫
      wakeLock.requests++
      assert.equal(type, 'screen')
      return new Promise((resolve, rejectP) => {
        const settle = () => {
          if (reject) return rejectP(reject)
          const l = { released: false, release() { this.released = true; return Promise.resolve() } }
          locks.push(l); resolve(l)
        }
        if (delay > 0) setTimeout(settle, delay); else queueMicrotask(settle)
      })
    },
  }
  const doc = {
    visibilityState: visible ? 'visible' : 'hidden',
    addEventListener(ev, f) { if (ev === 'visibilitychange') listeners.add(f) },
    removeEventListener(ev, f) { if (ev === 'visibilitychange') listeners.delete(f) },
  }
  const setVisible = (v) => { doc.visibilityState = v ? 'visible' : 'hidden'; for (const f of [...listeners]) f() }
  // 瀏覽器行為：分頁隱藏 → 自動放掉所有 lock
  const uaHide = () => { for (const l of locks) l.released = true }
  return { nav: { wakeLock }, doc, locks, wakeLock, listeners, setVisible, uaHide }
}

test('申請 screen wake lock（以方法呼叫）；release 放掉並移除監聽', async () => {
  const e = fakeEnv()
  const release = keepAwake(e)
  await flush(); await flush()
  assert.equal(e.wakeLock.requests, 1)
  assert.equal(e.locks.length, 1); assert.equal(e.locks[0].released, false)
  assert.equal(e.listeners.size, 1)
  release()
  assert.equal(e.locks[0].released, true); assert.equal(e.listeners.size, 0)
  release()   // 可重複呼叫
})

test('請求還沒完成就 release（StrictMode 雙跑）：晚到的 lock 立刻放掉，不會洩漏', async () => {
  const e = fakeEnv({ delay: 20 })
  const r1 = keepAwake(e)     // StrictMode：第一次 effect
  r1()                        // 立刻 cleanup
  const r2 = keepAwake(e)     // 第二次 effect
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(e.locks.length, 2)
  assert.equal(e.locks[0].released, true, '第一個（已 cleanup）的 lock 要被放掉')
  assert.equal(e.locks[1].released, false, '第二個保持')
  r2()
  assert.ok(e.locks.every((l) => l.released), '全部放掉，沒有殘留')
})

test('分頁隱藏後 UA 放掉 lock → 回到前景重新申請；隱藏中不申請；已持有時不重複申請', async () => {
  const e = fakeEnv()
  const release = keepAwake(e)
  await flush(); await flush()
  e.setVisible(true); await flush()
  assert.equal(e.wakeLock.requests, 1, '已持有：不重複申請')
  e.setVisible(false); e.uaHide()
  await flush()
  assert.equal(e.wakeLock.requests, 1, '隱藏中不申請')
  e.setVisible(true); await flush(); await flush()
  assert.equal(e.wakeLock.requests, 2, '回到前景重新申請')
  assert.equal(e.locks[1].released, false)
  release()
  assert.ok(e.locks.every((l) => l.released))
})

test('隱藏狀態下啟動：不申請，等到可見再申請', async () => {
  const e = fakeEnv({ visible: false })
  const release = keepAwake(e)
  await flush()
  assert.equal(e.wakeLock.requests, 0)
  e.setVisible(true); await flush(); await flush()
  assert.equal(e.wakeLock.requests, 1)
  release()
})

test('不支援 / 被拒絕 / request 同步丟例外：都不丟錯，之後仍可再申請', async () => {
  assert.doesNotThrow(() => keepAwake({ nav: {}, doc: null })())                       // 沒有 wakeLock
  assert.doesNotThrow(() => keepAwake({ nav: null, doc: null })())
  const e = fakeEnv({ reject: Object.assign(new Error('battery saver'), { name: 'NotAllowedError' }) })
  const release = keepAwake(e)
  await flush(); await flush()
  assert.equal(e.locks.length, 0)
  e.setVisible(true); await flush(); await flush()   // 被拒絕之後 visible 事件仍會再試（pending 已清掉）
  assert.ok(e.wakeLock.requests >= 2)
  release()
  const thrower = { nav: { wakeLock: { request() { throw new Error('boom') } } }, doc: null }
  assert.doesNotThrow(() => keepAwake(thrower)())
})

test('接線：觀眾視窗（投影機）自己持有 wake lock；App 的演出模式改用同一個 helper（不再各寫一份會洩漏的版本）', () => {
  const aud = readFileSync(new URL('../AudienceApp.jsx', import.meta.url), 'utf8')
  assert.match(aud, /keepAwake\(/, '觀眾視窗要呼叫 keepAwake')
  const app = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8')
  assert.match(app, /keepAwake\(/)
  assert.doesNotMatch(app, /wakeLock\.request/, 'App.jsx 不再直接呼叫 wakeLock.request（.then 沒檢查 released 的舊寫法會洩漏 lock）')
})
