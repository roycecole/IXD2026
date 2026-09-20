import test from 'node:test'
import assert from 'node:assert/strict'
import { createEchoGuard, ECHO_TAIL_MS } from './echoGuard.js'

// 假旁白：方法會檢查 this（模擬瀏覽器原生物件的 Illegal invocation）
function fakeNarrator() {
  const subs = new Set()
  let on = false
  const n = {
    speaking() { if (this !== n) throw new TypeError('Illegal invocation'); return on },
    onChange(cb) { if (this !== n) throw new TypeError('Illegal invocation'); subs.add(cb); return () => subs.delete(cb) },
    set(v) { on = v; for (const cb of [...subs]) cb(v) },
    count: () => subs.size,
  }
  return n
}

test('旁白進行中忽略語音指令；念完後還要再靜音 ECHO_TAIL_MS 才恢復', () => {
  const n = fakeNarrator(); let t = 1000
  const g = createEchoGuard({ narrator: n, now: () => t })
  assert.equal(g.shouldIgnore(), false, '沒在念 → 不忽略')
  n.set(true); assert.equal(g.shouldIgnore(), true)
  t += 5000; assert.equal(g.shouldIgnore(), true, '念多久都忽略')
  n.set(false); assert.equal(g.shouldIgnore(), true, '剛念完：喇叭餘音還在')
  t += ECHO_TAIL_MS - 1; assert.equal(g.shouldIgnore(), true)
  t += 2; assert.equal(g.shouldIgnore(), false, '餘音過後恢復')
})

test('下一句接著念（speaking 沒有閃 false）不會提早解除；dispose 會取消訂閱', () => {
  const n = fakeNarrator(); let t = 0
  const g = createEchoGuard({ narrator: n, now: () => t })
  n.set(true); n.set(true)
  assert.equal(g.shouldIgnore(), true)
  assert.equal(n.count(), 1)
  g.dispose(); assert.equal(n.count(), 0); g.dispose()   // 可重複呼叫
})

test('沒有旁白 / 旁白壞掉：一律不忽略，也不丟例外', () => {
  assert.equal(createEchoGuard({}).shouldIgnore(), false)
  assert.equal(createEchoGuard({ narrator: null }).shouldIgnore(), false)
  const broken = { speaking() { throw new Error('boom') }, onChange() { throw new Error('boom') } }
  const g = createEchoGuard({ narrator: broken, now: () => 0 })
  assert.equal(g.shouldIgnore(), false); g.dispose()
})
