import test from 'node:test'
import assert from 'node:assert/strict'
import { registerMirror, getMirror, listMirrors, clearMirrors } from './mirror.js'

test('registerMirror：註冊 / 列出 / 取消；缺 get 或 apply 會丟錯', () => {
  clearMirrors()
  const s = { get: () => 1, apply: () => {}, subscribe: () => () => {} }
  const off = registerMirror('demo', s)
  assert.equal(getMirror('demo'), s); assert.equal(listMirrors().length, 1)
  off(); assert.equal(getMirror('demo'), undefined)
  assert.throws(() => registerMirror('x', { get() {} }))
  assert.throws(() => registerMirror('', s))
})
test('取消訂閱只會移除自己註冊的那一份（後註冊者不受影響）', () => {
  clearMirrors()
  const a = { get: () => 'a', apply() {} }, b = { get: () => 'b', apply() {} }
  const offA = registerMirror('k', a); registerMirror('k', b)
  offA(); assert.equal(getMirror('k'), b)
})
