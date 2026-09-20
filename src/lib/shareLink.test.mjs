// 分享連結複製 + 分享結果訊息的位置。執行：node --test src/lib/shareLink.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { copyText } from './shareLink.js'

test('剪貼簿可用：直接複製（以方法呼叫 writeText）', async () => {
  const clip = { got: null, writeText(v) { if (this !== clip) throw new TypeError('Illegal invocation'); this.got = v; return Promise.resolve() } }
  assert.equal(await copyText('https://x/?s=1', { clipboard: clip, prompt: () => assert.fail('不該跳輸入框') }), 'copied')
  assert.equal(clip.got, 'https://x/?s=1')
})

test('沒有 navigator.clipboard（非 HTTPS / 內嵌瀏覽器）或 writeText 被擋：跳出輸入框讓使用者手動複製（以前手機上拿不到連結）', async () => {
  const seen = []
  const prompt = (label, value) => { seen.push([label, value]); return null }
  assert.equal(await copyText('https://x/?s=1', { clipboard: null, prompt, promptLabel: '複製此連結' }), 'manual')
  assert.deepEqual(seen, [['複製此連結', 'https://x/?s=1']])
  const blocked = { writeText: () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) }
  assert.equal(await copyText('u', { clipboard: blocked, prompt }), 'manual')
  const thrower = { writeText() { throw new Error('sync throw') } }
  assert.equal(await copyText('u', { clipboard: thrower, prompt }), 'manual')
})

test('兩條路都不行 → failed，不丟例外', async () => {
  assert.equal(await copyText('u', { clipboard: null, prompt: null }), 'failed')
  assert.equal(await copyText('u', { clipboard: null, prompt: () => { throw new Error('blocked') } }), 'failed')
})

test('預設環境（Node：沒有 navigator.clipboard / window.prompt）→ failed 而不是丟錯', async () => {
  assert.equal(await copyText('u'), 'failed')
})

test('TopBar：分享結果訊息在 .toolstrip 外面（手機上工具列橫向捲動，放裡面會被排到畫面外）、是 live region、用共用的 flash（不再各自 setTimeout）', () => {
  const src = readFileSync(new URL('../ui/TopBar.jsx', import.meta.url), 'utf8')
  const toast = src.indexOf('className="toast"')
  assert.ok(toast > 0)
  assert.ok(toast > src.lastIndexOf('</div>', src.indexOf('</header>')), 'toast 在最後一個 </div>（.toolstrip 的結尾）之後')
  assert.match(src, /className="toast" role="status" aria-live="polite"/)
  assert.ok(!/setShareMsg\([^)]*\)[^\n]*\n[^\n]*setTimeout/.test(src))
  assert.match(src, /copyText\(/)
  // 失敗不能記成功：「產生分享連結」只在複製成功 / 手動複製時寫
  assert.match(src, /else \{ flash\(t\('複製失敗（見主控台）'\)\)[^}]*t\('分享連結複製失敗'\)/)
})

test('CSS：toast 是頂欄的直接子元素、絕對定位在頂欄下方、空時不佔位；手機版撐滿寬度', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
  assert.match(css, /\.topbar > \.toast \{[^}]*position: absolute/)
  assert.match(css, /\.topbar > \.toast:empty \{ display: none; \}/)
  assert.match(css, /@media \(max-width: 820px\) \{[\s\S]*\.topbar > \.toast \{ left: 10px; right: 10px;/)
  assert.doesNotMatch(css, /\.toolstrip \.toast/, '舊的「在工具列裡」的規則要拿掉')
})
