// 導覽員遙控（手機當導覽員遙控器）的單元 / 整合測試。執行：node --test src/lib/tourRemote.test.mjs
// 涵蓋：token（隨機、格式、拒絕取樣）、網址 hash 解析（&guide=、多餘參數、編碼、壞資料）、協定訊息驗證、
//   host 端 createGuideHost（token 驗證：正確 / 錯誤 / 缺少 / 重複 hello / 暴力猜測；非導覽員指令被忽略；每個指令的行為；150ms 節流；goto 邊界；
//   導覽沒在跑時的指令；touchGuide 有呼叫而 touch 沒有；格式錯誤訊息不丟例外；連線關閉後移出集合）、
//   狀態酬載（白名單 / 備註 ≤120 字 / 站位置不位移）與推送時機（createGuideSync：立即推、變化才推、每 2 秒補推、停止即清）、
//   遙控頁的檢視模型與訊息 reducer、展場 QR 的 G 鍵判斷，以及「真的 runner + 真的 store + 真的活動掛鉤」的整合（導覽員指令不會中止導覽）。
// 連線 / 計時器 / runner 都是「會檢查 this 的假物件」：脫離原物件呼叫會丟 Illegal invocation，跟瀏覽器一樣。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { create } from 'zustand'
import { illegal, withStorage, importJsx } from './tourTestEnv.mjs'
import {
  GUIDE_STOP_IDS, GUIDE_STOP_OTHER, GUIDE_CMDS, GUIDE_NOTE_MAX, GUIDE_MAX_STOPS, GUIDE_MIN_GAP_MS, GUIDE_PUSH_MS, GUIDE_MAX_BAD_HELLO, GUIDE_TOKEN_LEN, GUIDE_QR_MS, GUIDE_HELLO_WAIT_MS,
  isGuideToken, makeGuideToken, parseRemoteHash, buildRemoteUrl, helloMsg, guideCmd, parseGuideCmd, tourPayload, parseTourPayload, reduceGuideMsg, guideView, isGuideQrKey,
  createGuideHost, createGuideSync,
} from './tourRemote.js'
import { TOUR_STOP_IDS } from './tourLink.js'

const TOKEN = 'k3x9a1b7zq'
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const CMD_LOOKALIKES = ['reboot', '__proto__', 'constructor', 'toString', 'NEXT', ' next', 'next ', '']

// ---------------------------------------------------------------------------------------------
// 假物件
// ---------------------------------------------------------------------------------------------
function makeConn(peer = 'peer-a') {
  const c = {
    peer, open: true, sent: [], closed: 0, failSend: false,
    send(m) { if (this !== c) throw illegal(); if (c.failSend) throw new Error('send boom'); if (!c.open) throw new Error('send on closed connection'); c.sent.push(m) },
    close() { if (this !== c) throw illegal(); c.closed++; c.open = false },
  }
  c.last = (t) => [...c.sent].reverse().find((m) => m && m.t === t)
  c.all = (t) => c.sent.filter((m) => m && m.t === t)
  return c
}

function makeRunner({ total = 4, startOk = true } = {}) {
  const st = { run: false, paused: false, i: 0 }
  const calls = []
  const me = () => r
  const r = {
    calls, st,
    isRunning() { if (this !== me()) throw illegal(); return st.run },
    isPaused() { if (this !== me()) throw illegal(); return st.run && st.paused },
    current() { if (this !== me()) throw illegal(); return st.run ? { index: st.i, total, paused: st.paused } : null },
    start(o) { if (this !== me()) throw illegal(); calls.push(['start', o]); if (!startOk || st.run) return false; st.run = true; st.paused = !!(o && o.hold); st.i = 0; return true },
    stop(reason) { if (this !== me()) throw illegal(); calls.push(['stop', reason]); if (!st.run) return false; st.run = false; st.paused = false; return true },
    next() { if (this !== me()) throw illegal(); calls.push(['next']); if (!st.run) return false; st.i = Math.min(total - 1, st.i + 1); return true },
    prev() { if (this !== me()) throw illegal(); calls.push(['prev']); if (!st.run) return false; st.i = Math.max(0, st.i - 1); return true },
    pause() { if (this !== me()) throw illegal(); calls.push(['pause']); if (!st.run || st.paused) return false; st.paused = true; return true },
    resume() { if (this !== me()) throw illegal(); calls.push(['resume']); if (!st.run || !st.paused) return false; st.paused = false; return true },
    goto(i) { if (this !== me()) throw illegal(); calls.push(['goto', i]); if (!st.run) return false; st.i = i; return true },
    names: () => calls.map((c) => c[0]),
  }
  return r
}

const mkTourStore = () => create(() => ({ running: false, paused: false, index: 0, total: 0, stopMs: 0, seq: 0, stopList: [], speak: false }))
const stopList = (ids, notes = {}) => ids.map((id) => ({ id, caption: { key: id, p: { name: 'x', ...(notes[id] !== undefined ? { note: notes[id] } : {}) } } }))

function setup(over = {}) {
  const runner = makeRunner(over.runner)
  const tourStore = mkTourStore()
  const clock = { t: 1000 }
  const rec = { touchGuide: 0, noteActivity: 0, speak: [], logs: [] }
  const host = createGuideHost({
    runner, tourStore, now: () => clock.t,
    touchGuide: () => { rec.touchGuide++ }, noteActivity: () => { rec.noteActivity++ },
    getToken: () => TOKEN, setSpeak: (v) => { rec.speak.push(v) },
    getExtra: () => ({ speak: false, canSpeak: true, ready: true }),
    log: (e, n) => { rec.logs.push([e, n]) },
    ...over.host,
  })
  const changes = { n: 0 }
  host.onChange(() => { changes.n++ })
  const guide = () => { const c = makeConn('g' + Math.random()); host.handle(c, helloMsg(TOKEN)); return c }
  return { runner, tourStore, clock, rec, host, changes, guide }
}

// 假 setInterval / clearInterval（注入給 createGuideSync）
function makeIv() {
  let id = 0
  const live = new Map()
  return {
    setIv(fn, ms) { const k = ++id; live.set(k, { fn, ms }); return k },
    clearIv(k) { live.delete(k) },
    live: () => live.size,
    ms: () => [...live.values()].map((x) => x.ms),
    fire(n = 1) { for (let i = 0; i < n; i++) for (const v of [...live.values()]) v.fn() },
  }
}

// =============================================================================================
// token
// =============================================================================================
test('常數：站 id 白名單與 tourLink 的 TOUR_STOP_IDS 一致；指令清單涵蓋規格的 9 個；節流 150ms、補推 2 秒、備註 120 字、QR 60 秒', () => {
  assert.deepEqual(GUIDE_STOP_IDS, TOUR_STOP_IDS)
  assert.deepEqual([...GUIDE_CMDS].sort(), ['goto', 'next', 'pause', 'prev', 'resume', 'speak', 'start', 'stop', 'toggle'])
  assert.equal(GUIDE_MIN_GAP_MS, 150)
  assert.equal(GUIDE_PUSH_MS, 2000)
  assert.equal(GUIDE_NOTE_MAX, 120)
  assert.equal(GUIDE_QR_MS, 60000)
  assert.ok(GUIDE_TOKEN_LEN >= 6)
  assert.ok(GUIDE_HELLO_WAIT_MS > 1000)
})

test('makeGuideToken：預設用 crypto——10 碼 base36、每次不同；isGuideToken 只認 6~32 碼小寫 base36', () => {
  const a = makeGuideToken(), b = makeGuideToken()
  assert.match(a, /^[0-9a-z]{10}$/)
  assert.match(b, /^[0-9a-z]{10}$/)
  assert.notEqual(a, b)
  assert.ok(isGuideToken(a))
  for (const ok of ['abcdef', 'a1b2c3d4e5', 'z'.repeat(32)]) assert.equal(isGuideToken(ok), true, ok)
  for (const bad of ['', 'abcde', 'a'.repeat(33), 'ABCDEF123', 'abc def12', 'abc-def12', null, undefined, 123456, ['abcdef']]) assert.equal(isGuideToken(bad), false, String(bad))
})

test('makeGuideToken：注入的亂數 → 決定性；≥252 的位元組被拒絕（避免取模偏差）；全被拒絕 / 丟例外 / 不是函式 → 不退回 Math.random', () => {
  const seq = (a) => { for (let i = 0; i < a.length; i++) a[i] = i }
  assert.equal(makeGuideToken(seq), '0123456789')                     // 0..9 → '0'..'9'
  assert.equal(makeGuideToken((a) => { for (let i = 0; i < a.length; i++) a[i] = i % 2 ? 255 : 35 }), 'zzzzzzzzzz', '奇數位 255 被拒、偶數位 35 → z')
  assert.equal(makeGuideToken((a) => a.fill(251)), 'zzzzzzzzzz', '251 是最後一個被接受的位元組（251 % 36 = 35）')
  assert.equal(makeGuideToken((a) => a.fill(252)), '', '252 起全部拒絕')
  assert.equal(makeGuideToken((a) => a.fill(255)), '')                // 永遠被拒 → 空字串（有上限，不會無窮迴圈）
  assert.equal(makeGuideToken(() => { throw new Error('rng boom') }), '')
  const orig = Math.random
  Math.random = () => { throw new Error('Math.random 不可用來產生 token') }
  try { assert.equal(makeGuideToken((a) => a.fill(255)), '') } finally { Math.random = orig }
})

test('makeGuideToken：沒有 crypto（極舊瀏覽器 / 非安全來源以外的怪環境）→ 空字串，導覽員功能停用', () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true })
  try { assert.equal(makeGuideToken(), '') } finally { if (desc) Object.defineProperty(globalThis, 'crypto', desc); else delete globalThis.crypto }
  assert.match(makeGuideToken(), /^[0-9a-z]{10}$/)                    // 還原後恢復正常
})

// =============================================================================================
// 網址 hash
// =============================================================================================
test('parseRemoteHash：一般遙控 #remote=<id> → guide null；hostId 原樣', () => {
  assert.deepEqual(parseRemoteHash('#remote=ms12345678'), { hostId: 'ms12345678', guide: null })
})

test('parseRemoteHash：#remote=<id>&guide=<token> → 帶 token；hostId 只取第一個 & 之前', () => {
  assert.deepEqual(parseRemoteHash(`#remote=ms12345678&guide=${TOKEN}`), { hostId: 'ms12345678', guide: TOKEN })
  assert.equal(parseRemoteHash('#remote=ms1&foo=bar').hostId, 'ms1')       // 以前整段 'ms1&foo=bar' 都當 hostId → 連不上
})

test('parseRemoteHash：多餘參數 / 順序不同 / 無值參數 / 重複的 guide（第一個有效者）', () => {
  assert.deepEqual(parseRemoteHash(`#remote=ms1&foo=bar&guide=${TOKEN}&x`), { hostId: 'ms1', guide: TOKEN })
  assert.deepEqual(parseRemoteHash(`#remote=ms1&x&y=&guide=${TOKEN}`), { hostId: 'ms1', guide: TOKEN })
  assert.equal(parseRemoteHash(`#remote=ms1&guide=${TOKEN}&guide=zzzzzzzzzz`).guide, TOKEN)
  assert.equal(parseRemoteHash(`#remote=ms1&guide=BAD&guide=${TOKEN}`).guide, TOKEN)       // 第一個不合法就略過，取第一個合法的
  assert.equal(parseRemoteHash('#remote=ms1&guidefoo=abcdef123').guide, null)              // 參數名要完全相等
  assert.equal(parseRemoteHash('#remote=ms1&xguide=abcdef123').guide, null)
})

test('parseRemoteHash：編碼（hostId 與 token 都會 decodeURIComponent）；壞編碼不丟例外、退回原字串', () => {
  assert.equal(parseRemoteHash('#remote=%E4%B8%AD%E6%96%87').hostId, '中文')
  assert.equal(parseRemoteHash('#remote=a%20b').hostId, 'a b')
  assert.equal(parseRemoteHash('#remote=ms1&guide=k3x9a1%62%37zq').guide, 'k3x9a1b7zq')     // %62 = b、%37 = 7
  assert.doesNotThrow(() => parseRemoteHash('#remote=%E4%B8&guide=%E4'))
  assert.equal(parseRemoteHash('#remote=%E4%B8').hostId, '%E4%B8')
  assert.equal(parseRemoteHash('#remote=ms1&guide=%E4').guide, null)
})

test('parseRemoteHash：token 不合法（太短 / 大寫 / 符號 / 空）→ guide null，但仍是遙控頁（hostId 有效）', () => {
  for (const bad of ['abc', 'ABCDEFGH12', 'abc-def-12', '', 'a'.repeat(40), '%20%20%20%20%20%20']) {
    assert.deepEqual(parseRemoteHash(`#remote=ms1&guide=${bad}`), { hostId: 'ms1', guide: null }, bad)
  }
})

test('parseRemoteHash：不是遙控頁網址 / hostId 是空的 / 壞輸入 → null（主畫面照常載入）', () => {
  for (const h of ['', '#', '#remote', '#remote=', '#remote=&guide=abcdef123', '#other=ms1', 'remote=ms1', '#Remote=ms1', ' #remote=ms1', null, undefined, 5, {}, []]) assert.equal(parseRemoteHash(h), null, String(h))
})

test('buildRemoteUrl：與 parseRemoteHash 往返；沒有 guide 時與舊格式完全相同（不帶 &）；沒有 id → 空字串', () => {
  assert.equal(buildRemoteUrl('https://midisea.shyetech.com/', 'ms12345678', null), 'https://midisea.shyetech.com/#remote=ms12345678')
  const u = buildRemoteUrl('https://midisea.shyetech.com/', 'ms12345678', TOKEN)
  assert.equal(u, `https://midisea.shyetech.com/#remote=ms12345678&guide=${TOKEN}`)
  assert.deepEqual(parseRemoteHash(u.slice(u.indexOf('#'))), { hostId: 'ms12345678', guide: TOKEN })
  assert.equal(buildRemoteUrl('https://x/', '', TOKEN), '')
  assert.equal(buildRemoteUrl('https://x/', null, null), '')
  assert.equal(buildRemoteUrl('https://x/', 'a b', null), 'https://x/#remote=a%20b')
})

// main.jsx 內聯了一份解析函式（不 import tourRemote.js：免得把導覽員 host 邏輯拉進入口 chunk）。這裡把它從原始碼擷取出來執行，逐案跟 parseRemoteHash 核對——兩份不能走樣。
const HASH_VECTORS = [
  '#remote=ms12345678', `#remote=ms12345678&guide=${TOKEN}`, '#remote=ms1&foo=bar', `#remote=ms1&foo=bar&guide=${TOKEN}&x`, `#remote=ms1&x&y=&guide=${TOKEN}`,
  `#remote=ms1&guide=${TOKEN}&guide=zzzzzzzzzz`, `#remote=ms1&guide=BAD&guide=${TOKEN}`, '#remote=ms1&guidefoo=abcdef123', '#remote=ms1&xguide=abcdef123',
  '#remote=%E4%B8%AD%E6%96%87', '#remote=a%20b', '#remote=ms1&guide=k3x9a1%62%37zq', '#remote=%E4%B8&guide=%E4', '#remote=%E4%B8', '#remote=ms1&guide=%E4',
  '#remote=ms1&guide=abc', '#remote=ms1&guide=ABCDEFGH12', '#remote=ms1&guide=abc-def-12', '#remote=ms1&guide=', `#remote=ms1&guide=${'a'.repeat(40)}`, `#remote=ms1&guide=${'a'.repeat(32)}`, '#remote=ms1&guide=abcdef',
  '', '#', '#remote', '#remote=', '#remote=&guide=abcdef123', '#other=ms1', 'remote=ms1', '#Remote=ms1', ' #remote=ms1', '#remote=ms1&', '#remote=ms1&&&guide=abcdef123', '#remote=ms1&=abcdef123',
  null, undefined, 5, {}, [],
]

test('main.jsx：#remote= 解析內聯（不 import tourRemote.js，入口 chunk 不背導覽員 host 邏輯）、與 parseRemoteHash 對所有案例結果一致、hashchange 重載邏輯維持不變、hostId / guide 傳給 RemoteApp', () => {
  const m = src('../main.jsx')
  assert.doesNotMatch(m, /import[^\n]*tourRemote/, '入口不 import 導覽員模組')
  const fn = m.match(/const parseRemote = \(hash\) => \{[\s\S]*?\n\}\n/)
  assert.ok(fn, '找得到 parseRemote')
  const parseRemote = new Function(`return (${fn[0].replace(/^const parseRemote = /, '').trimEnd()})`)()
  for (const h of HASH_VECTORS) assert.deepEqual(parseRemote(h), parseRemoteHash(h), JSON.stringify(h))
  assert.match(m, /const remoteMatch = parseRemote\(location\.hash\)/)
  assert.doesNotMatch(m, /match\(\/\^#remote=\(\.\+\)\$\/\)/, '不再用舊的 (.+) 正規式')
  assert.doesNotMatch(m, /decodeURIComponent\(remoteMatch/, '不再對整段 hash 直接 decode（壞編碼會丟例外）')
  assert.match(m, /<RemoteApp hostId=\{remoteMatch\.hostId\} guide=\{remoteMatch\.guide\} \/>/)
  assert.match(m, /const initialHash = location\.hash \|\| ''\nwindow\.addEventListener\('hashchange', \(\) => \{\n  if \(\(location\.hash \|\| ''\) !== initialHash\) location\.reload\(\)\n\}\)/)
  assert.match(m, /if \(!remoteMatch && !diagnosticsMode\) import\('\.\/scene\/Scene3D\.jsx'\)/)   // 手機遙控頁仍不預載 3D 場景
})

// =============================================================================================
// 訊息
// =============================================================================================
test('guideCmd / helloMsg：訊息形狀（goto 帶 i、speak 帶 v，其餘只有 t 與 c）', () => {
  assert.deepEqual(helloMsg(TOKEN), { t: 'hello', guide: TOKEN })
  assert.deepEqual(guideCmd('next'), { t: 'g', c: 'next' })
  assert.deepEqual(guideCmd('goto', 3), { t: 'g', c: 'goto', i: 3 })
  assert.deepEqual(guideCmd('speak', true), { t: 'g', c: 'speak', v: true })
  assert.deepEqual(guideCmd('pause', 99), { t: 'g', c: 'pause' })       // 多給的參數不帶
  for (const c of GUIDE_CMDS) JSON.parse(JSON.stringify(guideCmd(c, c === 'speak' ? false : 0)))   // 純 JSON
})

test('parseGuideCmd：9 個指令都認得；多餘欄位被剝掉；goto 要 0 ≤ 整數 < 上限；speak 要 boolean', () => {
  for (const c of ['next', 'prev', 'pause', 'resume', 'toggle', 'start', 'stop']) assert.deepEqual(parseGuideCmd({ t: 'g', c, i: 3, v: true, evil: 1 }), { c })
  assert.deepEqual(parseGuideCmd({ t: 'g', c: 'goto', i: 0 }), { c: 'goto', i: 0 })
  assert.deepEqual(parseGuideCmd({ t: 'g', c: 'goto', i: GUIDE_MAX_STOPS - 1, v: 1 }), { c: 'goto', i: GUIDE_MAX_STOPS - 1 })
  assert.deepEqual(parseGuideCmd({ t: 'g', c: 'speak', v: false, i: 2 }), { c: 'speak', v: false })
})

test('parseGuideCmd：未知 / 格式錯誤一律 null（含原型鏈字串、大小寫 / 空白變體、goto 的非整數 / 越界、speak 的非 boolean）', () => {
  for (const c of CMD_LOOKALIKES) assert.equal(parseGuideCmd({ t: 'g', c }), null, JSON.stringify(c))
  for (const m of [null, undefined, 0, 'g', [], [{ t: 'g', c: 'next' }], {}, { t: 'g' }, { c: 'next' }, { t: 'x', c: 'next' }, { t: 'g', c: 5 }, { t: 'g', c: null }, { t: 'g', c: ['next'] }]) assert.equal(parseGuideCmd(m), null, JSON.stringify(m))
  for (const i of [undefined, null, -1, 1.5, '2', NaN, Infinity, GUIDE_MAX_STOPS, 1e9, true, [1], {}]) assert.equal(parseGuideCmd({ t: 'g', c: 'goto', i }), null, String(i))
  for (const v of [undefined, null, 'true', 1, 0, [], {}]) assert.equal(parseGuideCmd({ t: 'g', c: 'speak', v }), null, String(v))
})

// =============================================================================================
// host：token 驗證
// =============================================================================================
test('hello 正確 token：回 { t:guide, ok:true }、立刻推一次導覽狀態、加入集合、記 join 並通知訂閱者', () => {
  const { host, changes, rec, tourStore } = setup()
  tourStore.setState({ running: true, index: 1, total: 3, stopList: stopList(['reservoir', 'tide', 'moon']) })
  const c = makeConn()
  assert.equal(host.handle(c, helloMsg(TOKEN)), true)
  assert.deepEqual(c.sent[0], { t: 'guide', ok: true })
  assert.equal(c.sent[1].t, 'tour')
  assert.equal(c.sent[1].running, true)
  assert.equal(c.sent[1].index, 1)
  assert.deepEqual(c.sent[1].stops.map((s) => s.id), ['reservoir', 'tide', 'moon'])
  assert.equal(host.has(c), true)
  assert.equal(host.size(), 1)
  assert.deepEqual(host.conns(), [c])
  assert.deepEqual(rec.logs, [['join', 1]])
  assert.equal(changes.n, 1)
  assert.equal(rec.touchGuide, 0, 'hello 不算導覽員操作')
  assert.equal(rec.noteActivity, 0, 'hello（連線）不更新遙控活動')
})

test('hello 錯誤 token：回 ok:false、不加入、不推導覽狀態；之後的導覽員指令被忽略（仍是一般遙控）', () => {
  const { host, changes, rec, runner } = setup()
  const c = makeConn()
  assert.equal(host.handle(c, helloMsg('zzzzzzzzzz')), true)
  assert.deepEqual(c.sent, [{ t: 'guide', ok: false }])
  assert.equal(host.has(c), false)
  assert.equal(host.size(), 0)
  assert.equal(changes.n, 0)
  host.handle(c, guideCmd('start'))
  assert.deepEqual(runner.calls, [])
  assert.equal(rec.touchGuide + rec.noteActivity, 0)
})

test('hello 缺少 / 型別不對的 token（含空、少一碼、大小寫不同、物件）：一律 ok:false', () => {
  const { host } = setup()
  const variants = [{ t: 'hello' }, { t: 'hello', guide: '' }, { t: 'hello', guide: null }, { t: 'hello', guide: 12345 }, { t: 'hello', guide: [TOKEN] }, { t: 'hello', guide: { toString: () => TOKEN } },
    { t: 'hello', guide: TOKEN.slice(0, -1) }, { t: 'hello', guide: TOKEN + 'x' }, { t: 'hello', guide: TOKEN.toUpperCase() }, { t: 'hello', token: TOKEN }]
  for (const m of variants) {
    const c = makeConn()
    host.handle(c, m)
    assert.deepEqual(c.sent, [{ t: 'guide', ok: false }], JSON.stringify(m))
    assert.equal(host.has(c), false)
  }
})

test('host 沒有 token（沒有安全亂數 / host 尚未起來）：任何 hello 都失敗——包括 guide 也是 null / 空字串（不會 null === null 誤放行）', () => {
  for (const tok of [null, undefined, '']) {
    const { host } = setup({ host: { getToken: () => tok } })
    for (const g of [null, undefined, '', 'null', 'undefined', TOKEN]) {
      const c = makeConn()
      host.handle(c, { t: 'hello', guide: g })
      assert.deepEqual(c.sent, [{ t: 'guide', ok: false }], `${String(tok)} / ${String(g)}`)
    }
    assert.equal(host.size(), 0)
  }
})

test('token 換新（host 重建）：舊 token 立即失效、新 token 生效；已通過驗證的連線是否保留由 clear() 決定', () => {
  let tok = TOKEN
  const { host } = setup({ host: { getToken: () => tok } })
  const a = makeConn(); host.handle(a, helloMsg(TOKEN)); assert.equal(host.has(a), true)
  tok = 'newtoken123'
  const b = makeConn(); host.handle(b, helloMsg(TOKEN)); assert.equal(host.has(b), false, '舊 token 失效')
  const c = makeConn(); host.handle(c, helloMsg('newtoken123')); assert.equal(host.has(c), true)
  host.clear()
  assert.equal(host.size(), 0)
})

test('重複 hello（同一連線、同一 token）：冪等——只加入一次、只記一次 join、只通知一次；每次仍回 ok 並補推狀態', () => {
  const { host, rec, changes } = setup()
  const c = makeConn()
  host.handle(c, helloMsg(TOKEN))
  host.handle(c, helloMsg(TOKEN))
  host.handle(c, helloMsg(TOKEN))
  assert.equal(host.size(), 1)
  assert.equal(c.all('guide').length, 3)
  assert.ok(c.all('guide').every((m) => m.ok === true))
  assert.equal(c.all('tour').length, 3)
  assert.deepEqual(rec.logs, [['join', 1]])
  assert.equal(changes.n, 1)
})

test('已驗證的連線再送錯誤 token → 撤銷導覽員身分（回 ok:false、移出集合、記 leave），之後的指令被忽略', () => {
  const { host, rec, runner, guide } = setup()
  const c = guide()
  assert.equal(host.has(c), true)
  host.handle(c, helloMsg('wrongtoken1'))
  assert.equal(c.last('guide').ok, false)
  assert.equal(host.has(c), false)
  assert.deepEqual(rec.logs, [['join', 1], ['leave', 0]])
  host.handle(c, guideCmd('start'))
  assert.deepEqual(runner.calls, [])
})

test('暴力猜測：驗證失敗達 5 次 → 關閉該連線（之前每次仍回 ok:false）；正確的 hello 不受影響', () => {
  const { host } = setup()
  const c = makeConn()
  for (let i = 1; i < GUIDE_MAX_BAD_HELLO; i++) { host.handle(c, helloMsg('guess' + i + 'aaaa')); assert.equal(c.closed, 0, `第 ${i} 次還不關`) }
  host.handle(c, helloMsg('lastguess11'))
  assert.equal(c.closed, 1)
  assert.equal(c.all('guide').length, GUIDE_MAX_BAD_HELLO)
  assert.ok(c.all('guide').every((m) => m.ok === false))
  const good = makeConn()
  host.handle(good, helloMsg(TOKEN))
  assert.equal(good.closed, 0)
  assert.equal(host.has(good), true)
})

test('多支導覽員手機：各自驗證、各自在集合；同時收到 broadcast；錯誤的那支不在', () => {
  const { host, guide } = setup()
  const a = guide(), b = guide()
  const bad = makeConn(); host.handle(bad, helloMsg('nope123456'))
  assert.equal(host.size(), 2)
  assert.equal(host.broadcast({ t: 'tour', ping: 1 }), 2)
  assert.equal(a.last('tour').ping, 1)
  assert.equal(b.last('tour').ping, 1)
  assert.equal(bad.all('tour').length, 0)
})

// =============================================================================================
// host：連線集合
// =============================================================================================
test('連線關閉 / 錯誤 → remove：移出集合、記 leave、通知；重複 remove 無效；clear 一次清空並記 leave', () => {
  const { host, rec, changes, guide } = setup()
  const a = guide(), b = guide()
  assert.equal(host.remove(a), true)
  assert.equal(host.size(), 1)
  assert.equal(host.remove(a), false, '重複 remove 不再通知')
  assert.equal(host.remove(makeConn()), false, '從沒驗證過的連線 remove 無效')
  assert.deepEqual(rec.logs.filter((l) => l[0] === 'leave'), [['leave', 1]])
  const before = changes.n
  host.clear()
  assert.equal(host.size(), 0)
  assert.equal(changes.n, before + 1)
  assert.equal(host.remove(b), false)
  host.clear()                                     // 空集合再 clear：不通知
  assert.equal(changes.n, before + 1)
})

test('broadcast：已關閉（open === false）的連線順手移出集合、不送、不丟例外；send 丟例外的連線不影響其他連線', () => {
  const { host, guide, rec } = setup()
  const a = guide(), b = guide(), c = guide()
  a.open = false
  b.failSend = true
  assert.equal(host.broadcast({ t: 'tour', n: 1 }), 1, '只有 c 送成功')
  assert.equal(host.has(a), false, '已關閉的移出集合')
  assert.equal(host.has(b), true, '單次送失敗不算離線')
  assert.equal(c.last('tour').n, 1)
  assert.deepEqual(rec.logs.filter((l) => l[0] === 'leave'), [['leave', 2]])
  assert.doesNotThrow(() => host.broadcast({ t: 'tour', n: 2 }))
})

test('onChange：可退訂；訂閱者丟例外不影響其他訂閱者與連線', () => {
  const { host, guide } = setup()
  let n = 0
  host.onChange(() => { throw new Error('listener boom') })
  const off = host.onChange(() => { n++ })
  assert.doesNotThrow(() => guide())
  assert.equal(n, 1)
  off()
  guide()
  assert.equal(n, 1)
})

// =============================================================================================
// host：指令
// =============================================================================================
test('非導覽員連線送導覽員指令：全部靜默忽略——runner 沒被呼叫、不記 touchGuide / 遙控活動、集合不變（即使先送過錯誤 hello）', () => {
  const { host, runner, rec } = setup()
  const plain = makeConn('plain')
  const wrong = makeConn('wrong'); host.handle(wrong, helloMsg('nope123456'))
  for (const c of [plain, wrong]) {
    for (const m of [guideCmd('start'), guideCmd('toggle'), guideCmd('next'), guideCmd('goto', 1), guideCmd('speak', true), guideCmd('stop')]) assert.equal(host.handle(c, m), true, '仍算「已處理」：不會當一般遙控訊息派送')
  }
  assert.deepEqual(runner.calls, [])
  assert.deepEqual(rec.speak, [])
  assert.equal(rec.touchGuide, 0)
  assert.equal(rec.noteActivity, 0)
  assert.equal(host.size(), 0)
})

test('指令：next / prev / pause / resume / stop / goto 在導覽進行中會呼叫對應的 runner 方法（以方法呼叫）', () => {
  const { host, runner, guide, clock } = setup()
  const c = guide()
  runner.st.run = true
  const send = (m) => { clock.t += 1000; host.handle(c, m) }
  send(guideCmd('next')); send(guideCmd('prev')); send(guideCmd('pause')); send(guideCmd('resume')); send(guideCmd('goto', 2)); send(guideCmd('stop'))
  assert.deepEqual(runner.calls, [['next'], ['prev'], ['pause'], ['resume'], ['goto', 2], ['stop', 'user']])
})

test('指令：暫停中再 pause / 沒暫停時 resume → 無動作（不重複呼叫）；toggle 依目前狀態暫停 ↔ 繼續', () => {
  const { host, runner, guide, clock } = setup()
  const c = guide()
  runner.st.run = true
  const send = (m) => { clock.t += 1000; host.handle(c, m) }
  send(guideCmd('resume'))
  assert.deepEqual(runner.calls, [], '沒暫停就 resume：無動作')
  send(guideCmd('toggle'))
  assert.equal(runner.st.paused, true)
  send(guideCmd('pause'))
  assert.deepEqual(runner.names(), ['pause'], '已暫停再 pause：無動作')
  send(guideCmd('toggle'))
  assert.equal(runner.st.paused, false)
  assert.deepEqual(runner.names(), ['pause', 'resume'])
})

test('導覽沒在跑：next / prev / pause / resume / stop / goto 全部無動作——不呼叫 runner、不會意外開始導覽（只有 start / toggle 會開始）', () => {
  const { host, runner, guide, clock, rec } = setup()
  const c = guide()
  const send = (m) => { clock.t += 1000; host.handle(c, m) }
  for (const m of [guideCmd('next'), guideCmd('prev'), guideCmd('pause'), guideCmd('resume'), guideCmd('stop'), guideCmd('goto', 0), guideCmd('goto', 2)]) send(m)
  assert.deepEqual(runner.calls, [])
  assert.equal(runner.st.run, false)
  assert.equal(rec.touchGuide, 7, '有人在操作手機這件事本身仍算「導覽員在場」')
})

test('start：沒在跑 → start({ auto:false })；已在跑 → 無動作；start 失敗（沒資料 / 正在錄製）→ 無動作不丟例外', () => {
  const { host, runner, guide, clock } = setup()
  const c = guide()
  const send = (m) => { clock.t += 1000; host.handle(c, m) }
  send(guideCmd('start'))
  assert.deepEqual(runner.calls, [['start', { auto: false }]])
  assert.equal(runner.st.run, true)
  send(guideCmd('start'))
  assert.equal(runner.calls.length, 1, '已在跑：不再 start')
  const f = setup({ runner: { startOk: false } })
  const fc = f.guide()
  assert.doesNotThrow(() => f.host.handle(fc, guideCmd('start')))
  assert.equal(f.runner.st.run, false)
  assert.equal(f.host.exec({ c: 'start' }), 'noop')
})

test('toggle：沒在跑 → 開始（auto:false）；在跑且沒暫停 → 暫停；暫停中 → 繼續', () => {
  const { host, runner, guide, clock } = setup()
  const c = guide()
  const send = (m) => { clock.t += 1000; host.handle(c, m) }
  send(guideCmd('toggle'))
  assert.deepEqual(runner.calls, [['start', { auto: false }]])
  send(guideCmd('toggle'))
  send(guideCmd('toggle'))
  assert.deepEqual(runner.names(), ['start', 'pause', 'resume'])
})

test('goto 邊界：0 ≤ i < 目前這一輪的站數才會跳；等於站數 / 更大 → 無動作（不呼叫 runner.goto）；非整數 / 負數 / 字串在驗證階段就丟掉', () => {
  const { host, runner, guide, clock, rec } = setup({ runner: { total: 4 } })
  const c = guide()
  runner.st.run = true
  const send = (m) => { clock.t += 1000; host.handle(c, m) }
  for (const i of [0, 1, 2, 3]) send(guideCmd('goto', i))
  assert.deepEqual(runner.calls, [['goto', 0], ['goto', 1], ['goto', 2], ['goto', 3]])
  const before = rec.touchGuide
  for (const i of [4, 5, 31]) send(guideCmd('goto', i))
  assert.equal(runner.calls.length, 4, '越界：沒有呼叫')
  assert.equal(rec.touchGuide, before + 3, '合法格式但越界的指令仍算有人在操作')
  for (const i of [-1, 1.5, '2', NaN, null, undefined, 32, 1e9, Infinity]) send({ t: 'g', c: 'goto', i })
  assert.equal(runner.calls.length, 4)
  assert.equal(rec.touchGuide, before + 3, '格式錯誤的指令不記活動')
  runner.st.i = 0
  send(guideCmd('goto', 0))
  assert.deepEqual(runner.calls.at(-1), ['goto', 0], '跳到目前這一站 = 重播該站，仍然執行')
})

test('speak：v 為 boolean → setSpeak(v)；非 boolean 被丟掉；沒有 setSpeak 依賴 → 無動作；導覽沒在跑也能設定偏好', () => {
  const { host, rec, guide, clock } = setup()
  const c = guide()
  const send = (m) => { clock.t += 1000; host.handle(c, m) }
  send(guideCmd('speak', true)); send(guideCmd('speak', false))
  send({ t: 'g', c: 'speak', v: 'yes' }); send({ t: 'g', c: 'speak' }); send({ t: 'g', c: 'speak', v: 1 })
  assert.deepEqual(rec.speak, [true, false])
  const none = setup({ host: { setSpeak: null } })
  const nc = none.guide()
  assert.doesNotThrow(() => none.host.handle(nc, guideCmd('speak', true)))
  assert.equal(none.host.exec({ c: 'speak', v: true }), 'noop')
})

test('每個被受理的指令都先 touchGuide() 與 noteActivity()（各一次，且在 runner 動作之前）；被忽略的（非導覽員 / 格式錯誤）不記', () => {
  const order = []
  const runner = makeRunner()
  const origNext = runner.next
  runner.next = function () { order.push('runner.next'); return origNext.call(this) }
  runner.st.run = true
  const clock = { t: 1000 }
  const h = createGuideHost({ runner, tourStore: mkTourStore(), touchGuide: () => order.push('touchGuide'), noteActivity: () => order.push('noteActivity'), now: () => clock.t, getToken: () => TOKEN })
  const c = makeConn(); h.handle(c, helloMsg(TOKEN))
  h.handle(c, guideCmd('next'))
  assert.deepEqual(order, ['touchGuide', 'noteActivity', 'runner.next'])

  // 其他指令各記一次
  const { host, rec, guide, clock: clock2 } = setup()
  const c2 = guide()
  for (const m of [guideCmd('pause'), guideCmd('resume'), guideCmd('toggle'), guideCmd('goto', 1), guideCmd('speak', true), guideCmd('stop'), guideCmd('start')]) { clock2.t += 1000; host.handle(c2, m) }
  assert.equal(rec.touchGuide, 7)
  assert.equal(rec.noteActivity, 7)
  const before = rec.touchGuide
  host.handle(makeConn(), guideCmd('next'))          // 非導覽員
  host.handle(c2, { t: 'g', c: 'nope' })             // 未知指令
  assert.equal(rec.touchGuide, before)
  assert.equal(rec.noteActivity, before)
})

test('touchGuide / noteActivity 丟例外不影響指令執行', () => {
  const { host, runner, guide } = setup({ host: { touchGuide: () => { throw new Error('a') }, noteActivity: () => { throw new Error('b') } } })
  const c = guide()
  runner.st.run = true
  assert.doesNotThrow(() => host.handle(c, guideCmd('next')))
  assert.deepEqual(runner.calls, [['next']])
})

// ---------------- 節流 ----------------
test('節流：同一連線同一指令 150ms 內的重複丟棄（含不記 touchGuide）；滿 150ms 才再受理；手機連點不會連續跳站', () => {
  const { host, runner, guide, clock, rec } = setup()
  const c = guide()
  runner.st.run = true
  host.handle(c, guideCmd('next'))                    // t=1000 受理
  clock.t += 50;  host.handle(c, guideCmd('next'))    // 1050 丟
  clock.t += 50;  host.handle(c, guideCmd('next'))    // 1100 丟
  clock.t += 49;  host.handle(c, guideCmd('next'))    // 1149 丟（距上次受理 149ms）
  assert.deepEqual(runner.names(), ['next'])
  assert.equal(rec.touchGuide, 1, '被丟棄的重複不記活動')
  clock.t += 1;   host.handle(c, guideCmd('next'))    // 1150：剛好 150ms → 受理
  assert.deepEqual(runner.names(), ['next', 'next'])
  clock.t += 300; host.handle(c, guideCmd('next'))
  assert.equal(runner.names().length, 3)
})

test('節流：以「連線 + 指令」為單位——不同指令、不同連線、不同 goto 目標互不影響；相同 goto 目標才算重複；speak 開 / 關各算各的', () => {
  const { host, runner, guide, clock, rec } = setup({ runner: { total: 8 } })
  const a = guide(), b = guide()
  runner.st.run = true
  host.handle(a, guideCmd('next'))
  host.handle(a, guideCmd('prev'))                    // 不同指令：受理
  host.handle(b, guideCmd('next'))                    // 不同連線：受理
  assert.deepEqual(runner.names(), ['next', 'prev', 'next'])
  host.handle(a, guideCmd('goto', 2))
  host.handle(a, guideCmd('goto', 3))                 // 不同目標：受理
  host.handle(a, guideCmd('goto', 3))                 // 相同目標：丟
  assert.deepEqual(runner.calls.filter((x) => x[0] === 'goto'), [['goto', 2], ['goto', 3]])
  host.handle(a, guideCmd('speak', true))
  host.handle(a, guideCmd('speak', false))
  host.handle(a, guideCmd('speak', false))
  assert.deepEqual(rec.speak, [true, false])
  clock.t += 200
  host.handle(a, guideCmd('goto', 3))
  assert.equal(runner.calls.filter((x) => x[0] === 'goto').length, 3)
})

test('節流：時鐘倒退（例如換用另一個時鐘）不會讓指令永遠被丟棄', () => {
  const { host, runner, guide, clock } = setup()
  const c = guide()
  runner.st.run = true
  host.handle(c, guideCmd('next'))
  clock.t -= 5000
  host.handle(c, guideCmd('next'))
  assert.equal(runner.names().length, 2)
})

test('節流的最小間隔可由 deps 覆寫；預設值 = GUIDE_MIN_GAP_MS', () => {
  const { host, runner, guide, clock } = setup({ host: { minGapMs: 500 } })
  const c = guide()
  runner.st.run = true
  host.handle(c, guideCmd('next')); clock.t += 400; host.handle(c, guideCmd('next'))
  assert.equal(runner.names().length, 1)
  clock.t += 100; host.handle(c, guideCmd('next'))
  assert.equal(runner.names().length, 2)
})

// ---------------- 壞訊息 ----------------
test('格式錯誤 / 怪訊息：handle 永遠不丟例外；只有 hello / g 回傳 true（其他交還給一般遙控派送）', () => {
  const { host, runner, guide } = setup()
  const c = guide()
  const junk = [null, undefined, 0, 1, NaN, '', 'g', 'hello', true, [], [1, 2], () => {}, Symbol('x'), 10n, {}, { t: 5 }, { t: null }, { t: 'p', pid: 'glow', v: 0.5 }, { t: 'a', a: 'spawnWhale' }, { t: 'n', note: 20 }, { t: 'sync', params: {} }, { t: 'role' }]
  const desc = (m) => { try { return JSON.stringify(m) || String(m) } catch (e) { return String(typeof m) } }
  for (const m of junk) { let r; assert.doesNotThrow(() => { r = host.handle(c, m) }, String(typeof m)); assert.equal(r, false, desc(m)) }
  for (const m of [{ t: 'g' }, { t: 'g', c: {} }, { t: 'g', c: 'next', i: {} }, { t: 'hello' }, { t: 'hello', guide: {} }, { t: 'g', c: 'goto', i: 'x' }]) assert.equal(host.handle(c, m), true)
  assert.deepEqual(runner.calls, [])
  const evil = { t: 'g', get c() { throw new Error('getter boom') } }
  assert.doesNotThrow(() => host.handle(c, evil))
  assert.doesNotThrow(() => host.handle(null, { t: 'hello', guide: TOKEN }))
  assert.doesNotThrow(() => host.handle(undefined, { t: 'g', c: 'next' }))
})

test('runner / store 丟例外：handle 不丟例外（服務層自己吞掉，不會讓主迴圈停擺）', () => {
  const { host, runner, guide } = setup()
  const c = guide()
  runner.st.run = true
  runner.next = () => { throw new Error('runner boom') }
  assert.doesNotThrow(() => host.handle(c, guideCmd('next')))
  assert.equal(host.exec({ c: 'next' }), 'noop')
  const broken = createGuideHost({ runner: {}, tourStore: {}, getToken: () => TOKEN })
  const bc = makeConn(); broken.handle(bc, helloMsg(TOKEN))
  assert.doesNotThrow(() => broken.handle(bc, guideCmd('next')))
  assert.doesNotThrow(() => broken.payload())
})

// =============================================================================================
// 狀態酬載
// =============================================================================================
test('tourPayload：只有 t / running / paused / index / total / stops；stops 只有站 id（白名單）與備註；純 JSON', () => {
  const ids = ['reservoir', 'tide', 'moon', 'dust', 'air', 'birds', 'fish', 'stations']
  const m = tourPayload({ running: true, paused: true, index: 3, total: 8, stopList: stopList(ids, { dust: '請看揚塵那條線' }), caption: { key: 'dust', p: {} }, stopMs: 5, seq: 9, speak: true, autoIdle: true, remote: false })
  assert.deepEqual(Object.keys(m).sort(), ['index', 'paused', 'running', 'stops', 't', 'total'])
  assert.equal(m.t, 'tour')
  assert.deepEqual(m.stops.map((s) => s.id), ids)
  assert.deepEqual(m.stops[3], { id: 'dust', note: '請看揚塵那條線' })
  assert.ok(m.stops.filter((s, i) => i !== 3).every((s) => Object.keys(s).join() === 'id'), '沒有備註的站不帶 note')
  assert.equal(m.running, true); assert.equal(m.paused, true); assert.equal(m.index, 3); assert.equal(m.total, 8)
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m)
})

test('tourPayload：沒有導覽 / 壞狀態 → running:false、空 stops、不丟例外', () => {
  const idle = { t: 'tour', running: false, paused: false, index: 0, total: 0, stops: [] }
  assert.deepEqual(tourPayload({ running: false, paused: false, index: 0, total: 0, stopList: [] }), idle)
  for (const bad of [null, undefined, 0, 'x', [], {}, { stopList: 'no' }, { stopList: null, index: NaN, total: -3 }, { index: 'a', total: Infinity }]) {
    const m = tourPayload(bad)
    assert.equal(m.t, 'tour'); assert.equal(m.running, false); assert.deepEqual(m.stops, [])
    assert.ok(Number.isInteger(m.index) && m.index >= 0 && Number.isInteger(m.total) && m.total >= 0)
  }
})

test('tourPayload：備註 ≤ 120 字（以字元計、不切斷 emoji）；空白 / 非字串備註省略；備註原文不翻譯不改動', () => {
  const long = '字'.repeat(300)
  const emoji = '😀'.repeat(130)
  const m = tourPayload({ running: true, stopList: [
    { id: 'tide', caption: { p: { note: long } } },
    { id: 'moon', caption: { p: { note: emoji } } },
    { id: 'dust', caption: { p: { note: '   \n ' } } },
    { id: 'air', caption: { p: { note: 42 } } },
    { id: 'birds', caption: { p: { note: null } } },
    { id: 'fish', caption: { p: { note: 'Hello <b>world</b> & "quotes"\n第二行' } } },
    { id: 'stations', caption: null },
    { id: 'reservoir' },
  ] })
  assert.equal(Array.from(m.stops[0].note).length, GUIDE_NOTE_MAX)
  assert.equal(Array.from(m.stops[1].note).length, GUIDE_NOTE_MAX)
  assert.equal(m.stops[1].note, '😀'.repeat(GUIDE_NOTE_MAX), '代理對沒被切開')
  for (const i of [2, 3, 4, 6, 7]) assert.equal('note' in m.stops[i], false, `stops[${i}] 不帶 note`)
  assert.equal(m.stops[5].note, 'Hello <b>world</b> & "quotes"\n第二行')
  const exactly = '字'.repeat(GUIDE_NOTE_MAX)
  assert.equal(tourPayload({ stopList: [{ id: 'tide', caption: { p: { note: exactly } } }] }).stops[0].note, exactly)
})

test('tourPayload：不在白名單的站 id → \'other\'（保留位置，goto 的 index 不會位移）；站數上限 32；index / total 夾在範圍內', () => {
  const m = tourPayload({ running: true, index: 1, total: 3, stopList: [{ id: 'tide' }, { id: 'future-stop' }, { id: 42 }, null, { id: '__proto__' }] })
  assert.deepEqual(m.stops.map((s) => s.id), ['tide', GUIDE_STOP_OTHER, GUIDE_STOP_OTHER, GUIDE_STOP_OTHER, GUIDE_STOP_OTHER])
  const many = tourPayload({ running: true, index: 99, total: 99, stopList: Array.from({ length: 50 }, () => ({ id: 'tide' })) })
  assert.equal(many.stops.length, GUIDE_MAX_STOPS)
  assert.equal(many.index, GUIDE_MAX_STOPS)
  assert.equal(many.total, GUIDE_MAX_STOPS)
})

test('tourPayload：附加欄位 speak / canSpeak / ready 只收 boolean', () => {
  const m = tourPayload({ running: false }, { speak: true, canSpeak: false, ready: true, evil: 'x' })
  assert.equal(m.speak, true); assert.equal(m.canSpeak, false); assert.equal(m.ready, true)
  assert.equal('evil' in m, false)
  const n = tourPayload({ running: false }, { speak: 'yes', canSpeak: 1, ready: null })
  assert.equal('speak' in n || 'canSpeak' in n || 'ready' in n, false)
  assert.doesNotThrow(() => tourPayload({}, null))
})

test('parseTourPayload：往返、白名單 / 格式驗證（遙控頁不信任主畫面以外的東西：壞資料 → null 沿用舊狀態）', () => {
  const src0 = tourPayload({ running: true, paused: false, index: 1, total: 3, stopList: stopList(['reservoir', 'tide', 'moon'], { tide: '備註' }) }, { speak: true, canSpeak: true, ready: true })
  const p = parseTourPayload(src0)
  assert.deepEqual(p, { running: true, paused: false, index: 1, total: 3, stops: [{ id: 'reservoir' }, { id: 'tide', note: '備註' }, { id: 'moon' }], speak: true, canSpeak: true, ready: true })
  assert.equal(parseTourPayload({ ...src0, stops: [{ id: 'weird' }] }).stops[0].id, GUIDE_STOP_OTHER)
  assert.equal(Array.from(parseTourPayload({ ...src0, stops: [{ id: 'tide', note: 'x'.repeat(500) }] }).stops[0].note).length, GUIDE_NOTE_MAX)
  const bads = [null, undefined, 'tour', [], {}, { ...src0, t: 'x' }, { ...src0, running: 1 }, { ...src0, paused: 'no' }, { ...src0, index: -1 }, { ...src0, index: 1.5 }, { ...src0, total: '3' }, { ...src0, total: GUIDE_MAX_STOPS + 1 },
    { ...src0, stops: 'x' }, { ...src0, stops: [null] }, { ...src0, stops: [{ id: 5 }] }, { ...src0, stops: [{ id: 'A' }] }, { ...src0, stops: [{ id: 'a'.repeat(17) }] }, { ...src0, stops: Array.from({ length: GUIDE_MAX_STOPS + 1 }, () => ({ id: 'tide' })) }]
  for (const b of bads) assert.equal(parseTourPayload(b), null, JSON.stringify(b))
})

test('備註取自 stopList[i].caption.p.note（C7）：note 只出現在有備註的那一站，站位置與 index 對齊', () => {
  const { host, tourStore, guide } = setup()
  tourStore.setState({ running: true, index: 2, total: 3, stopList: stopList(['tide', 'moon', 'dust'], { dust: '這站講 PM10' }) })
  const c = guide()
  const m = c.last('tour')
  assert.equal(m.stops[m.index].note, '這站講 PM10')
  assert.equal(host.payload().stops[2].note, '這站講 PM10')
})

// =============================================================================================
// 狀態推送（createGuideSync）
// =============================================================================================
function syncSetup(over = {}) {
  const tourStore = mkTourStore()
  const iv = makeIv()
  const sent = []
  const sync = createGuideSync({ tourStore, payload: () => tourPayload(tourStore.getState()), broadcast: (m) => { sent.push(m) }, setIv: iv.setIv, clearIv: iv.clearIv, ...over })
  return { tourStore, iv, sent, sync }
}

test('createGuideSync：start 立刻推一次；導覽狀態變化就推（酬載不同才推）；不相干欄位變化（stopMs / seq）不推', () => {
  const { tourStore, sent, sync } = syncSetup()
  sync.start()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].running, false)
  tourStore.setState({ running: true, index: 0, total: 3, stopList: stopList(['tide', 'moon', 'dust']) })
  assert.equal(sent.length, 2)
  assert.equal(sent[1].running, true)
  tourStore.setState({ stopMs: 1234, seq: 5 })                                  // 字幕動畫欄位：酬載沒變
  assert.equal(sent.length, 2)
  tourStore.setState({ index: 1 })
  assert.equal(sent.length, 3)
  assert.equal(sent[2].index, 1)
  tourStore.setState({ paused: true })
  assert.equal(sent[3].paused, true)
})

test('createGuideSync：導覽因輸入中止（runner 把 running 設回 false、清空 stopList）→ 立即推 running:false', () => {
  const { tourStore, sent, sync } = syncSetup()
  sync.start()
  tourStore.setState({ running: true, index: 2, total: 3, stopList: stopList(['tide', 'moon', 'dust']) })
  tourStore.setState({ running: false, paused: false, caption: null, index: 0, total: 0, stopMs: 0, stopList: [] })   // tour.js stop() 的 emit
  const last = sent.at(-1)
  assert.equal(last.running, false)
  assert.equal(last.total, 0)
  assert.deepEqual(last.stops, [])
})

test('createGuideSync：每 2 秒無條件補推（丟包保險）；計時器只有一個、間隔 = GUIDE_PUSH_MS', () => {
  const { iv, sent, sync } = syncSetup()
  sync.start()
  assert.deepEqual(iv.ms(), [GUIDE_PUSH_MS])
  assert.equal(sent.length, 1)
  iv.fire(); iv.fire(); iv.fire()
  assert.equal(sent.length, 4, '酬載沒變也會補推')
})

test('createGuideSync：stop 退訂 + 清計時器（之後導覽狀態變化不再推）；重複 start 只有一個訂閱與一個計時器；stop 後可再 start（StrictMode）', () => {
  const { tourStore, iv, sent, sync } = syncSetup()
  assert.equal(sync.isRunning(), false)
  sync.start(); sync.start(); sync.start()
  assert.equal(iv.live(), 1)
  assert.equal(sent.length, 1)
  tourStore.setState({ running: true, total: 1, stopList: stopList(['tide']) })
  assert.equal(sent.length, 2, '重複 start 不會變成重複訂閱')
  sync.stop()
  assert.equal(iv.live(), 0)
  assert.equal(sync.isRunning(), false)
  const n = sent.length
  tourStore.setState({ index: 0, paused: true })
  iv.fire()
  assert.equal(sent.length, n, '停止後完全沒有推送')
  sync.stop()                                                                   // 重複 stop 無害
  sync.start()
  assert.equal(iv.live(), 1)
  assert.equal(sent.length, n + 1, '重新 start 立刻推一次（不會被 stop 前的舊酬載擋掉）')
  sync.stop()
  assert.equal(iv.live(), 0)
})

test('createGuideSync：broadcast / payload 丟例外不會炸掉訂閱與計時器；預設計時器是「裸函式包一層」（換成會檢查 this 的假 setInterval 也能用）', () => {
  let boom = true
  const { tourStore, sent, sync } = syncSetup({ broadcast: (m) => { if (boom) throw new Error('send boom'); sent.push(m) } })
  assert.doesNotThrow(() => sync.start())
  boom = false
  tourStore.setState({ running: true, total: 1, stopList: stopList(['tide']) })
  assert.equal(sent.length, 1)
  sync.stop()

  const a = globalThis.setInterval, b = globalThis.clearInterval
  const ok = (self) => self === undefined || self === globalThis
  const live = new Set()
  let id = 0
  globalThis.setInterval = function fakeSetInterval(fn, ms) { if (!ok(this)) throw illegal(); const k = ++id; live.add(k); return k }
  globalThis.clearInterval = function fakeClearInterval(k) { if (!ok(this)) throw illegal(); live.delete(k) }
  try {
    const store = mkTourStore()
    const s = createGuideSync({ tourStore: store, payload: () => ({ t: 'tour' }), broadcast: () => {} })
    s.start()
    assert.equal(live.size, 1)
    s.stop()
    assert.equal(live.size, 0)
    // 對照組：把原生風格的方法脫離原物件呼叫，假環境確實會丟 Illegal invocation
    const holder = { setInterval: globalThis.setInterval }
    assert.throws(() => { const f = holder.setInterval; f.call(holder, () => {}, 1) }, /Illegal invocation/)
  } finally { globalThis.setInterval = a; globalThis.clearInterval = b }
  assert.equal(typeof globalThis.setInterval, 'function')
})

test('host + sync：只推給已通過驗證的導覽員連線；連線關閉後不再收到；沒有導覽員時 broadcast 回 0', () => {
  const { host, tourStore } = setup()
  const iv = makeIv()
  const sync = createGuideSync({ tourStore, payload: () => host.payload(), broadcast: (m) => host.broadcast(m), setIv: iv.setIv, clearIv: iv.clearIv })
  const guideC = makeConn('g'); host.handle(guideC, helloMsg(TOKEN))
  const plain = makeConn('p')
  const bad = makeConn('b'); host.handle(bad, helloMsg('wrongwrong1'))
  sync.start()
  tourStore.setState({ running: true, index: 0, total: 2, stopList: stopList(['tide', 'moon']) })
  assert.equal(guideC.last('tour').running, true)
  assert.equal(plain.sent.length, 0)
  assert.equal(bad.all('tour').length, 0)
  host.remove(guideC)
  const n = guideC.sent.length
  tourStore.setState({ index: 1 })
  iv.fire()
  assert.equal(guideC.sent.length, n)
  assert.equal(host.broadcast({ t: 'tour' }), 0)
})

// =============================================================================================
// 遙控頁：檢視模型 / reducer / G 鍵
// =============================================================================================
const T0 = { running: false, paused: false, index: 0, total: 0, stops: [], ready: true, canSpeak: true, speak: false }
const T1 = { running: true, paused: false, index: 1, total: 3, stops: [{ id: 'reservoir' }, { id: 'tide', note: '潮汐備註' }, { id: 'moon' }], ready: true, canSpeak: true, speak: true }

test('guideView：還沒收到狀態 → 只能等（開始 / 導覽按鈕都不可按）', () => {
  const v = guideView(null, true)
  assert.equal(v.known, false)
  assert.deepEqual([v.running, v.canNav, v.canStart, v.canStop, v.noData, v.showSpeak], [false, false, false, false, false, false])
  assert.deepEqual(v.chips, [])
})

test('guideView：導覽沒在跑 → 「開始導覽」可按、上一站 / 暫停 / 下一站不可按；主畫面沒有海況資料（ready:false）→ 提示且不能開始', () => {
  const v = guideView(T0, true)
  assert.deepEqual([v.running, v.paused, v.canNav, v.canStart, v.canStop, v.noData, v.showSpeak], [false, false, false, true, false, false, true])
  const nd = guideView({ ...T0, ready: false }, true)
  assert.deepEqual([nd.noData, nd.canStart], [true, false])
  const older = guideView({ ...T0, ready: undefined }, true)
  assert.deepEqual([older.noData, older.canStart], [false, true], '沒帶 ready 欄位（舊版主畫面）→ 當作可以開始')
})

test('guideView：導覽進行中 → 目前站 id / 第 n 站 / 備註 / 站 chips（標出目前站）；按鈕可按；停止鈕可按、開始鈕不可按', () => {
  const v = guideView(T1, true)
  assert.deepEqual([v.running, v.canNav, v.canStart, v.canStop], [true, true, false, true])
  assert.equal(v.stopId, 'tide')
  assert.equal(v.note, '潮汐備註')
  assert.equal(v.index, 1); assert.equal(v.total, 3)
  assert.deepEqual(v.chips.map((c) => [c.i, c.id, c.current]), [[0, 'reservoir', false], [1, 'tide', true], [2, 'moon', false]])
  assert.equal(v.speak, true)
  assert.equal(guideView({ ...T1, index: 2 }, true).note, '', '沒備註的站不顯示')
  assert.equal(guideView({ ...T1, paused: true }, true).paused, true)
  assert.equal(guideView({ ...T0, paused: true }, true).paused, false, '沒在跑就沒有「暫停」')
  assert.equal(guideView({ ...T1, index: 9 }, true).stopId, null, 'index 超出 stops：不丟例外')
})

test('guideView：連線中斷 → 全部按鈕不可按（狀態仍保留給畫面顯示）；host 回報 canSpeak:false → 不顯示念出字幕開關', () => {
  const v = guideView(T1, false)
  assert.deepEqual([v.connected, v.canNav, v.canStart, v.canStop], [false, false, false, false])
  assert.equal(v.running, true)
  assert.equal(guideView({ ...T0, canSpeak: false }, true).showSpeak, false)
  assert.equal(guideView({ ...T0, canSpeak: true }, true).showSpeak, true)
  assert.doesNotThrow(() => guideView('x', true))
  assert.doesNotThrow(() => guideView({ stops: 5 }, true))
})

test('reduceGuideMsg：沒有 token（none）→ 什麼都不理；ok → 導覽員；tour 只在 ok 之後才收；相同內容回傳同一個物件（避免重繪）', () => {
  const none = { guide: 'none', tour: null }
  assert.equal(reduceGuideMsg(none, { t: 'guide', ok: true }), none)
  assert.equal(reduceGuideMsg(none, { t: 'tour', ...T1 }), none)
  const pending = { guide: 'pending', tour: null }
  assert.equal(reduceGuideMsg(pending, { t: 'tour', ...T1 }), pending, '驗證通過前的 tour 訊息不收')
  const ok = reduceGuideMsg(pending, { t: 'guide', ok: true })
  assert.equal(ok.guide, 'ok')
  const withTour = reduceGuideMsg(ok, { t: 'tour', ...T1 })
  assert.equal(withTour.guide, 'ok')
  assert.deepEqual(withTour.tour.stops.map((s) => s.id), ['reservoir', 'tide', 'moon'])
  const again = reduceGuideMsg(withTour, { t: 'tour', ...T1 })
  assert.equal(again.tour, withTour.tour, '內容沒變 → 同一個 tour 物件')
  const changed = reduceGuideMsg(withTour, { t: 'tour', ...T1, index: 2 })
  assert.notEqual(changed.tour, withTour.tour)
  assert.equal(changed.tour.index, 2)
})

test('reduceGuideMsg：ok:false → denied 並清掉導覽狀態；逾時後晚到的 ok:true 仍可升級；壞訊息沿用舊狀態', () => {
  const ok = { guide: 'ok', tour: parseTourPayload({ t: 'tour', ...T1 }) }
  const denied = reduceGuideMsg(ok, { t: 'guide', ok: false })
  assert.deepEqual(denied, { guide: 'denied', tour: null })
  assert.equal(reduceGuideMsg(denied, { t: 'tour', ...T1 }), denied, 'denied 不收 tour')
  assert.equal(reduceGuideMsg({ guide: 'denied', tour: null }, { t: 'guide', ok: true }).guide, 'ok')
  for (const m of [null, undefined, 'x', 5, [], {}, { t: 'guide' }, { t: 'guide', ok: 'yes' }, { t: 'tour' }, { t: 'tour', running: 'x' }, { t: 'role' }, { t: 'sync', params: {} }]) assert.equal(reduceGuideMsg(ok, m), ok, JSON.stringify(m))
  assert.deepEqual(reduceGuideMsg(null, { t: 'guide', ok: true }), { guide: 'none', tour: null }, 'state 壞掉也不丟例外')
})

test('isGuideQrKey：G / g 通過；忽略 ctrl / meta / alt、輸入法組字、按住不放、其他鍵，以及輸入元件 / 彈窗內（判斷函式由呼叫端注入）', () => {
  const ev = (o) => ({ key: 'g', ctrlKey: false, metaKey: false, altKey: false, isComposing: false, repeat: false, target: { id: 'x' }, ...o })
  assert.equal(isGuideQrKey(ev({})), true)
  assert.equal(isGuideQrKey(ev({ key: 'G' })), true)
  assert.equal(isGuideQrKey(ev({ key: 'G', shiftKey: true })), true, 'Shift / CapsLock 產生的大寫 G 也算')
  for (const o of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { repeat: true }, { key: 'h' }, { key: 'Enter' }, { key: 'gg' }, { key: ' ' }, { key: undefined }]) assert.equal(isGuideQrKey(ev(o)), false, JSON.stringify(o))
  assert.equal(isGuideQrKey(ev({}), { typing: () => true }), false)
  assert.equal(isGuideQrKey(ev({}), { inModal: () => true }), false)
  assert.equal(isGuideQrKey(ev({}), { typing: () => false, inModal: () => false }), true)
  assert.equal(isGuideQrKey(ev({}), { typing: () => { throw new Error('boom') } }), false, '判斷函式出錯 → 保守地不處理')
  const seen = []
  isGuideQrKey(ev({ target: { tag: 'T' } }), { typing: (t) => { seen.push(['typing', t.tag]); return false }, inModal: (t) => { seen.push(['modal', t.tag]); return false } })
  assert.deepEqual(seen, [['typing', 'T'], ['modal', 'T']])
  for (const bad of [null, undefined, 'g', 5]) assert.equal(isGuideQrKey(bad), false)
})

// =============================================================================================
// 整合：真的 runner + 真的 store + 真的活動掛鉤（導覽員指令不會中止導覽）
// =============================================================================================
const { useStore } = await import('../store/useStore.js')
const { activity, touch, touchGuide, onActivity } = await import('../store/activity.js')
const { createTourRunner, useTourStore, setSpeak, buildTour } = await import('./tour.js')
const { attachTourGuards } = await import('../services/tourCore.js')
const { remoteActivity, noteRemoteActivity, dispatch } = await import('./remoteDispatch.js')
const { registerEn } = await import('../i18n/index.js')
const { loadEnDict } = await import('../../scripts/i18n-check.mjs')
registerEn((await loadEnDict()).dict)
const gov = JSON.parse(readFileSync(new URL('../../public/data/ocean.json', import.meta.url), 'utf8'))
const S = () => useStore.getState()

function makeWin() {
  const L = {}
  return { addEventListener(t, f) { (L[t] ||= []).push(f) }, removeEventListener(t, f) { L[t] = (L[t] || []).filter((x) => x !== f) } }
}
function realSetup() {
  S().stopPlayback(); if (S().rec.mode === 'recording') S().stopRecording()
  S().clearRec()
  S().setGov(gov)
  S().setRecSpeed(1)
  useTourStore.setState({ remote: false, running: false, paused: false, caption: null, stopList: [], index: 0, total: 0 })
  const clock = { t: 5e6 }
  const runner = createTourRunner({ store: useStore, getActivity: () => activity.last, touch, now: () => clock.t })
  const detach = attachTourGuards({ win: makeWin(), doc: Object.assign(makeWin(), { hidden: false }), runner })   // 與正式環境一樣的活動掛鉤：任何 touch() 都會中止導覽
  const host = createGuideHost({ runner, tourStore: useTourStore, touchGuide, noteActivity: noteRemoteActivity, now: () => clock.t, getToken: () => TOKEN, setSpeak, getExtra: () => ({ ready: true }) })
  const conn = makeConn('real')
  host.handle(conn, helloMsg(TOKEN))
  const tick = (ms) => { clock.t += ms; runner.tick(clock.t) }
  return { runner, host, conn, clock, tick, detach }
}
const send = (env, m) => { env.clock.t += 1000; env.host.handle(env.conn, m) }

test('整合：導覽員指令走 touchGuide + noteRemoteActivity，不呼叫 touch()——換站 / 暫停 / 繼續 / 跳站 / 停止都不會被活動掛鉤當成輸入而中止；activity.last 不動', () => {
  const env = realSetup()
  try {
    assert.equal(env.conn.last('tour').running, false)
    assert.equal(env.conn.last('tour').ready, true)
    send(env, guideCmd('start'))
    assert.equal(env.runner.isRunning(), true)
    assert.equal(useTourStore.getState().running, true)

    let hooks = 0
    const off = onActivity(() => { hooks++ })
    const lastBefore = activity.last
    const guideBefore = activity.guideAt
    const remoteBefore = remoteActivity.at
    send(env, guideCmd('next'))
    send(env, guideCmd('prev'))
    send(env, guideCmd('pause'))
    assert.equal(env.runner.isPaused(), true)
    send(env, guideCmd('resume'))
    send(env, guideCmd('goto', 3))
    env.tick(100)
    assert.equal(env.runner.isRunning(), true, '導覽員指令沒有中止導覽')
    assert.equal(env.runner.current().index, 3)
    assert.equal(hooks, 0, 'touch() 從沒被呼叫（活動掛鉤沒觸發）')
    assert.equal(activity.last, lastBefore, 'activity.last 沒動（導覽器用它判斷「有人輸入」）')
    assert.ok(activity.guideAt > guideBefore, 'touchGuide 有記時間')
    assert.ok(remoteActivity.at > remoteBefore, '遙控「有人在」有更新')
    off()

    // 對照組：真正的遙控輸入（一般 dispatch）會經 touch() 中止導覽——證明上面的掛鉤是活的
    dispatch({ t: 'p', pid: 'current', v: 0.4 })
    assert.equal(env.runner.isRunning(), false)
    assert.equal(useTourStore.getState().running, false)
  } finally { env.detach() }
})

test('整合：狀態酬載取自真的 useTourStore——站 id 全在白名單、index / total 與 runner 一致；停止後 running:false 且 stops 清空（導覽因輸入中止也一樣）', () => {
  const env = realSetup()
  try {
    send(env, guideCmd('start'))
    const p = env.host.payload()
    const ids = buildTour(S().gov).map((s) => s.id)
    assert.ok(ids.length >= 2, '真實資料至少兩站')
    assert.deepEqual(p.stops.map((s) => s.id), ids)
    assert.ok(p.stops.every((s) => GUIDE_STOP_IDS.includes(s.id)))
    assert.equal(p.total, ids.length)
    assert.equal(p.index, 0)
    assert.equal(p.running, true)
    send(env, guideCmd('next'))
    assert.equal(env.host.payload().index, 1)
    send(env, guideCmd('pause'))
    assert.equal(env.host.payload().paused, true)
    send(env, guideCmd('stop'))
    const q = env.host.payload()
    assert.equal(q.running, false); assert.equal(q.total, 0); assert.deepEqual(q.stops, [])
    // 導覽因輸入中止
    send(env, guideCmd('start'))
    assert.equal(env.host.payload().running, true)
    S().input('glow', 0.3)
    assert.equal(env.host.payload().running, false)
  } finally { env.detach() }
})

test('整合：goto 邊界用真的站數（total = 這一輪的站數）；沒在跑時 next / goto 不會開始導覽', () => {
  const env = realSetup()
  try {
    const n = buildTour(S().gov).length
    send(env, guideCmd('next')); send(env, guideCmd('goto', 0))
    assert.equal(env.runner.isRunning(), false)
    send(env, guideCmd('start'))
    send(env, guideCmd('goto', n))                      // 越界
    assert.equal(env.runner.current().index, 0)
    send(env, guideCmd('goto', n - 1))
    assert.equal(env.runner.current().index, n - 1)
    send(env, guideCmd('stop'))
    assert.equal(env.runner.isRunning(), false)
  } finally { env.detach() }
})

test('整合：speak 指令設定旁白偏好（useTourStore.speak）；toggle 沒在跑時開始導覽', () => {
  const env = realSetup()
  try {
    withStorage(() => {
      send(env, guideCmd('speak', true)); assert.equal(useTourStore.getState().speak, true)
      send(env, guideCmd('speak', false)); assert.equal(useTourStore.getState().speak, false)
    })
    send(env, guideCmd('toggle'))
    assert.equal(env.runner.isRunning(), true)
  } finally { env.detach() }
})

test('端到端（假連線對 + 真的 runner / store）：遙控頁的狀態機（reduceGuideMsg + guideView）↔ host（createGuideHost + createGuideSync）——hello → 開始 → 下一站 → 暫停 → 繼續 → 跳站 → 被輸入中止，每一步遙控頁看到的都對（訊息經 JSON 往返）', () => {
  const env = realSetup()
  const iv = makeIv()
  const sync = createGuideSync({ tourStore: useTourStore, payload: () => env.host.payload(), broadcast: (m) => env.host.broadcast(m), setIv: iv.setIv, clearIv: iv.clearIv })
  const view = () => {                                   // 遙控頁把收到的訊息依序餵給 reducer，再算檢視模型
    let st = { guide: 'pending', tour: null }
    for (const m of env.conn.sent) st = reduceGuideMsg(st, JSON.parse(JSON.stringify(m)))
    assert.equal(st.guide, 'ok')
    return guideView(st.tour, true)
  }
  const press = (c, arg) => { env.clock.t += 1000; env.host.handle(env.conn, JSON.parse(JSON.stringify(guideCmd(c, arg)))) }
  try {
    sync.start()
    const n = buildTour(S().gov).length
    let v = view()
    assert.deepEqual([v.known, v.running, v.canStart, v.canNav, v.noData], [true, false, true, false, false])
    press('start')
    v = view()
    assert.deepEqual([v.running, v.index, v.total, v.chips.length, v.canNav, v.canStop, v.canStart], [true, 0, n, n, true, true, false])
    assert.ok(v.stopId && GUIDE_STOP_IDS.includes(v.stopId))
    press('next')
    v = view(); assert.equal(v.index, 1); assert.equal(v.chips.filter((c) => c.current).map((c) => c.i).join(), '1')
    press('pause')
    v = view(); assert.equal(v.paused, true)
    press('resume')
    v = view(); assert.equal(v.paused, false)
    press('goto', n - 1)
    v = view(); assert.equal(v.index, n - 1)
    press('prev')
    assert.equal(view().index, n - 2)
    press('speak', false)
    assert.equal(view().speak, false)
    S().input('glow', 0.3)                               // 主畫面有人動了旋鈕 → 導覽被輸入中止
    v = view()
    assert.deepEqual([v.running, v.chips.length, v.canNav, v.canStart], [false, 0, false, true])
    press('toggle')                                      // 再從手機開始
    assert.equal(view().running, true)
    press('stop')
    assert.equal(view().running, false)
  } finally { sync.stop(); env.detach() }
  assert.equal(iv.live(), 0)
})

// =============================================================================================
// 接線與樣式（原始碼檢查）
// =============================================================================================
const importsOf = (code) => [...code.matchAll(/(?:^|\n)\s*import\s+(?:[^'"\n]*?from\s+)?['"]([^'"]+)['"]/g)].map((m) => m[1])

test('遙控頁保持輕量：RemoteApp 只 import react / ice / sensors / i18n / tourRemote / guide.css，不碰 three、store、tour.js、tourCore、multiplayer；tourRemote.js 本身沒有任何 import', () => {
  const app = src('../remote/RemoteApp.jsx')
  assert.deepEqual(importsOf(app).sort(), ['../i18n/index.js', '../lib/ice.js', '../lib/sensors.js', '../lib/tourRemote.js', '../styles/guide.css', 'react'])
  for (const bad of ['three', 'zustand', 'store', 'tour.js', 'tourCore', 'multiplayer', 'services', 'scene', 'App.jsx']) assert.equal(importsOf(app).some((s) => s.includes(bad)), false, bad)
  assert.equal(importsOf(src('./tourRemote.js')).length, 0)
})

test('RemoteApp：連線 open 後送 hello（帶 token）、逾時不回應就退回一般遙控；導覽員區塊有大按鈕 / aria-pressed / 站 chips / 念出字幕；演奏控制收進預設收合的 details；震動走功能偵測', () => {
  const app = src('../remote/RemoteApp.jsx')
  assert.match(app, /conn\.send\(helloMsg\(guideToken\)\)/)
  assert.match(app, /GUIDE_HELLO_WAIT_MS/)
  assert.match(app, /b\.guide === 'pending'\) \{ b\.guide = 'denied'/)
  assert.match(app, /reduceGuideMsg/)
  assert.match(app, /<details className="remote-play">/)
  assert.doesNotMatch(app, /<details[^>]*\bopen\b/, '預設收合')
  assert.match(app, /aria-pressed=\{v\.paused\}/)
  assert.match(app, /cmd\('goto', c\.i\)/)
  assert.match(app, /cmd\('speak', !v\.speak\)/)
  assert.match(app, /typeof navigator\.vibrate === 'function'\) navigator\.vibrate\(ms\)/)
  assert.match(app, /const buzz = |function buzz\(ms = 12\)/)
  assert.match(app, /const cmd = \(c, arg\) => \{ buzz\(\); send\(guideCmd\(c, arg\)\) \}/)
  // 一般（非導覽員）遙控頁維持原本完整外觀：wrapPlay 只在有 token 時為真，否則直接渲染 playControls
  assert.match(app, /const wrapPlay = !!guideToken && gs\.guide !== 'denied'/)
  assert.match(app, /\) : playControls\}/)
  // 8 個站名用 T() 標記
  for (const zh of ['今日水庫', '潮汐', '月亮', '揚塵', '空氣品質', '鳥群調查', '魚群調查', '河川測站']) assert.ok(app.includes(`T('${zh}')`), zh)
  // 卸載清理
  assert.match(app, /clearTimeout\(b\.helloTimer\)/)
})

test('樣式：導覽員主要按鈕觸控目標 ≥ 56px（上一站 / 暫停 / 下一站 64px、開始 / 結束 56px）；guide.css 由遙控頁 / 多人視窗 / 展場 QR 各自 import', () => {
  const css = src('../styles/guide.css')
  const minH = (sel) => { const m = css.match(new RegExp(sel.replace(/[.]/g, '\\.') + '\\s*\\{[^}]*?min-height:\\s*(\\d+)px')); return m ? Number(m[1]) : 0 }
  assert.ok(minH('.guide-btn') >= 56)
  assert.ok(minH('.guide-run') >= 56)
  assert.ok(minH('.guide-chip') >= 44)
  for (const f of ['../remote/RemoteApp.jsx', '../ui/MultiModal.jsx', '../ui/KioskQR.jsx']) assert.match(src(f), /import '\.\.\/styles\/guide\.css'/, f)
  assert.doesNotMatch(src('../styles.css'), /\.guide/, '不動 styles.css')
})

test('multiplayer.js 只是薄薄一層接線：hello / g 轉給 guideHost、關閉 / 錯誤 → remove、host 重建 → clear + token 換新、remoteUrl({ guide })；不 import 導覽模組', () => {
  const mp = src('./multiplayer.js')
  assert.match(mp, /if \(guideHost && guideHost\.handle\(c, m\)\) return; dispatch\(m, c\.peer\)/)
  assert.match(mp, /guideHost\.remove\(c\)/)
  assert.match(mp, /multiState\.guide = null/)
  assert.match(mp, /guideHost\.clear\(\)/)
  assert.match(mp, /multiState\.guide = makeGuideToken\(\) \|\| null/)
  assert.match(mp, /export function remoteUrl\(\{ guide = false \} = \{\}\)/)
  assert.match(mp, /export function attachGuideHost/)
  assert.match(mp, /export function sendToGuides/)
  for (const bad of ['tourCore', "tour.js'", 'useTourStore', 'touchGuide']) assert.equal(mp.includes(bad), false, bad)
  assert.match(mp, /export const multiState = \{ on: false, id: null, count: 0, guide: null, guides: 0 \}/)
})

test('TourRemoteService：建立 createGuideHost / createGuideSync、只在有導覽員連線時 start 訂閱與計時、卸載時完整清理；用 touchGuide 與 noteRemoteActivity，不 import touch', () => {
  const s = src('../services/TourRemoteService.jsx')
  assert.match(s, /createGuideHost\(\{/)
  assert.match(s, /touchGuide,/)
  assert.match(s, /noteActivity: noteRemoteActivity/)
  assert.match(s, /import \{ touchGuide \} from '\.\.\/store\/activity\.js'/)
  assert.match(s, /if \(host\.size\(\) > 0\) sync\.start\(\); else sync\.stop\(\)/)
  assert.match(s, /return \(\) => \{ offChange\(\); sync\.stop\(\); detach\(\); host\.clear\(\) \}/)
  assert.match(s, /attachGuideHost\(host\)/)
  assert.match(s, /now: \(\) => performance\.now\(\)/)
  assert.doesNotMatch(s, /import \{[^}]*\btouch\b[^}]*\} from/, '不 import touch（只 import touchGuide）')
  assert.match(src('../services/Services.jsx'), /<TourRemoteService \/>/)
})

test('展場 QR：G 鍵監聽（掛載時加、卸載時移除）、忽略輸入元件 / 彈窗 / 修飾鍵；60 秒自動換回、倒數計時器卸載清除；標示「導覽員 QR」；按 G 記 touchGuide', () => {
  const k = src('../ui/KioskQR.jsx')
  assert.match(k, /window\.addEventListener\('keydown', onKey\)/)
  assert.match(k, /window\.removeEventListener\('keydown', onKey\)/)
  assert.match(k, /isGuideQrKey\(e, \{ typing: isTypingTarget, inModal: isInModal \}\)/)
  assert.match(k, /Date\.now\(\) \+ GUIDE_QR_MS/)
  assert.match(k, /clearInterval\(iv\)/)
  assert.match(k, /touchGuide\(\)/)
  assert.match(k, /remoteUrl\(\{ guide: guideMode \}\)/)
  assert.match(k, /導覽員 QR · 僅供講解者/)
  assert.match(k, /秒後換回一般 QR/)
})

test('多人視窗：「合奏 | 導覽員」分段切換（aria-pressed）、導覽員 QR 與「複製導覽員連結」、只能操控導覽的說明；導覽員手機不算合奏人數', () => {
  const m = src('../ui/MultiModal.jsx')
  assert.match(m, /className="multi-seg" role="group"/)
  assert.match(m, /aria-pressed=\{!guideMode\}/)
  assert.match(m, /aria-pressed=\{guideMode\}/)
  assert.match(m, /remoteUrl\(\{ guide: modeRef\.current === 'guide' \}\)/)
  assert.match(m, /複製導覽員連結/)
  assert.match(m, /只能操控資料導覽/)
  assert.match(m, /state\.count - state\.guides/)
})

test('英文字典：導覽員遙控的 key 都有英文、沒有殘留中文、佔位符與中文一致、沒有 undefined', async () => {
  const { dict } = await loadEnDict()
  const mine = (await import('../i18n/en/guide.js')).default
  const HAN = /[㐀-鿿]/
  for (const [zh, en] of Object.entries(mine)) {
    const params = {}
    for (const p of zh.matchAll(/\{(\w+)\}/g)) params[p[1]] = 2
    const s = typeof en === 'function' ? en(params) : en
    assert.equal(typeof s, 'string', zh)
    assert.doesNotMatch(s, HAN, `英文含中文：${zh}`)
    assert.doesNotMatch(s, /undefined|NaN|\[object/, zh)
    assert.equal(dict[zh] === en || String(dict[zh]) === String(en), true, `${zh} 與合併字典一致`)
    for (const p of Object.keys(params)) if (typeof en !== 'function') assert.ok(en.includes(`{${p}}`), `${zh} 少了 {${p}}`)
  }
  assert.equal((typeof mine['已有 {n} 支導覽員手機連線'] === 'function') && /1 guide phone /.test(mine['已有 {n} 支導覽員手機連線']({ n: 1 })), true)
})

// =============================================================================================
// SSR 標記：遙控頁（導覽員區塊 / 收合的演奏控制 / 一般遙控維持原樣）
// =============================================================================================
const React = (await import('react')).default
const { renderToStaticMarkup } = await import('react-dom/server')
const { translate } = await import('../i18n/index.js')
const RemoteMod = await importJsx(new URL('../remote/RemoteApp.jsx', import.meta.url).href)
const RemoteApp = RemoteMod.default
const GuidePanel = RemoteMod.GuidePanel
const tZh = (zh, p) => translate('zh', zh, p)
const tEn = (zh, p) => translate('en', zh, p)
const panel = (tour, { ok = true, t = tZh } = {}) => renderToStaticMarkup(React.createElement(GuidePanel, { v: guideView(tour, ok), ok, cmd: () => {}, t }))
const count = (html, re) => (html.match(re) || []).length
const HAN_RE = /[㐀-鿿]/

test('SSR·一般遙控（網址沒有 token）：外觀與以前相同——沒有導覽員區塊、沒有 details，滑桿 / 感測器 / 動作 / 打擊墊四個區塊都直接在頁面上', () => {
  const html = renderToStaticMarkup(React.createElement(RemoteApp, { hostId: 'ms1' }))
  assert.doesNotMatch(html, /class="guide|<details|remote-play/)
  for (const c of ['remote-sliders', 'remote-sensors', 'remote-actions', 'remote-pads']) assert.match(html, new RegExp(`class="${c}"`), c)
  assert.match(html, /MidiSea 遙控器/)
  assert.equal(count(html, /<input type="range"/g), 6, '預設 6 支滑桿')
  assert.equal(count(html, /class="remote-pads"[\s\S]*?<\/section>/g), 1)
  assert.equal(count(html.slice(html.indexOf('remote-pads')), /<button/g), 16, '16 顆打擊墊')
})

test('SSR·導覽員連結（有 token、還在驗證）：演奏控制收進預設收合的 details（沒有 open 屬性、滑桿在裡面）；導覽員區塊要驗證通過才出現', () => {
  const html = renderToStaticMarkup(React.createElement(RemoteApp, { hostId: 'ms1', guide: TOKEN }))
  assert.match(html, /<details class="remote-play">/)
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/)
  assert.match(html, /演奏控制/)
  assert.match(html, /操作會中止導覽/)
  assert.doesNotMatch(html, /class="guide( |")/)
  const d0 = html.indexOf('<details'), d1 = html.indexOf('</details>')
  for (const c of ['remote-sliders', 'remote-sensors', 'remote-actions', 'remote-pads']) { const i = html.indexOf(`class="${c}"`); assert.ok(i > d0 && i < d1, `${c} 在 details 裡`) }
  assert.equal(count(html, /<input type="range"/g), 6)
})

test('SSR·導覽員區塊（進行中 + 暫停 + 備註）：站名、第 n / N 站、已暫停、備註、三顆大按鈕（暫停鈕 aria-pressed=true 且顯示「繼續」）、站 chips（只有目前站 aria-current）、結束導覽', () => {
  const html = panel({ ...T1, paused: true })
  assert.match(html, /<section class="guide" aria-label="導覽員">/)
  assert.match(html, /<div class="guide-stop">潮汐<\/div>/)
  assert.match(html, /第 2 \/ 3 站/)
  assert.match(html, /<span class="guide-paused">已暫停<\/span>/)
  assert.match(html, /<p class="guide-note">潮汐備註<\/p>/)
  assert.match(html, /<button class="guide-btn on" aria-pressed="true">繼續<\/button>/)
  assert.match(html, />上一站<\/button>/)
  assert.match(html, />下一站<\/button>/)
  assert.match(html, /guide-run stop"[^>]*>結束導覽<\/button>/)
  assert.equal(count(html, /<button class="guide-chip/g), 3)
  assert.equal(count(html, /aria-current="step"/g), 1)
  assert.match(html, /class="guide-chip cur" aria-current="step"><span class="guide-chip-n">2<\/span>潮汐/)
  assert.match(html, /今日水庫/)
  assert.match(html, /aria-pressed="true">念出字幕：開/)
  assert.equal(count(html, /disabled/g), 0, '連線正常、導覽進行中：沒有任何按鈕被停用')
})

test('SSR·導覽員區塊（進行中、沒暫停、沒備註）：暫停鈕 aria-pressed=false 且顯示「暫停」；沒有備註區塊、沒有「已暫停」', () => {
  const html = panel({ ...T1, index: 2 })
  assert.match(html, /<button class="guide-btn" aria-pressed="false">暫停<\/button>/)
  assert.doesNotMatch(html, /guide-note|guide-paused/)
  assert.match(html, /<div class="guide-stop">月亮<\/div>/)
})

test('SSR·導覽員區塊（導覽沒在跑）：只有「開始導覽」可按；上一站 / 暫停 / 下一站停用；沒有 chips；仍可設定念出字幕', () => {
  const html = panel(T0)
  assert.match(html, /導覽還沒開始/)
  assert.match(html, /guide-run start"[^>]*>開始導覽<\/button>/)
  assert.doesNotMatch(html, /guide-run start"[^>]*disabled/)
  assert.equal(count(html, /<button class="guide-btn"[^>]*disabled/g), 3, '上一站 / 暫停 / 下一站都停用')
  assert.match(html, /aria-pressed="false" disabled="">暫停<\/button>/)
  assert.doesNotMatch(html, /guide-chip/)
  assert.match(html, /念出字幕：關/)
  assert.doesNotMatch(html, /念出字幕：關<\/button>[\s\S]*disabled/)
})

test('SSR·導覽員區塊：主畫面還沒載入海況資料 → 顯示提示、「開始導覽」停用；還沒收到狀態 → 顯示取得中、開始停用', () => {
  const nd = panel({ ...T0, ready: false })
  assert.match(nd, /主畫面還沒載入海況資料/)
  assert.match(nd, /guide-run start"[^>]*disabled/)
  const unknown = panel(null)
  assert.match(unknown, /正在取得導覽狀態…/)
  assert.match(unknown, /guide-run start"[^>]*disabled/)
  assert.doesNotMatch(unknown, /念出字幕/, '還不知道主畫面有沒有語音合成 → 不顯示開關')
})

test('SSR·導覽員區塊：連線中斷 → 標示離線、顯示狀態、所有按鈕（含 chips / 念出字幕）停用', () => {
  const html = panel(T1, { ok: false })
  assert.match(html, /class="guide is-offline"/)
  assert.match(html, /連線中斷 · 按鈕暫時無法使用/)
  assert.equal(count(html, /<button/g), count(html, /<button[^>]*disabled/g), '每顆按鈕都停用')
  assert.ok(count(html, /<button/g) >= 7)
})

test('SSR·導覽員區塊：host 回報不支援語音（canSpeak:false）→ 不顯示念出字幕；未知站 id / other → 「第 n 站」', () => {
  assert.doesNotMatch(panel({ ...T1, canSpeak: false }), /念出字幕/)
  const html = panel({ ...T1, stops: [{ id: 'reservoir' }, { id: 'other' }, { id: 'moon' }] })
  assert.match(html, /<div class="guide-stop">第 2 站<\/div>/)
  assert.match(html, /<span class="guide-chip-n">2<\/span>第 2 站/)
})

test('SSR·備註是純文字：含 HTML 的備註被跳脫、不會變成標記', () => {
  const evil = '<script>alert(1)</script><img src=x onerror=alert(2)> & "q"'
  const html = panel({ ...T1, stops: [{ id: 'reservoir' }, { id: 'tide', note: evil }, { id: 'moon' }] })
  assert.doesNotMatch(html, /<script|<img/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.doesNotMatch(src('../remote/RemoteApp.jsx'), /dangerouslySetInnerHTML|innerHTML/)
})

test('SSR·英文語系：導覽員區塊的介面文字都是英文（站名用資料層譯名；備註是導覽員輸入的原文，不翻）', () => {
  const html = panel({ ...T1, paused: true, stops: [{ id: 'reservoir' }, { id: 'tide' }, { id: 'air' }] }, { t: tEn })
  assert.doesNotMatch(html, HAN_RE)
  for (const en of ['Guide', 'Controls the data tour only', 'Previous stop', 'Next stop', 'Resume', 'End tour', 'Tide', 'Reservoir today', 'Air quality', 'Step 2 of 3', 'Paused', 'Read captions aloud: on']) assert.ok(html.includes(en), en)
  const idle = panel(T0, { t: tEn })
  assert.doesNotMatch(idle, HAN_RE)
  assert.ok(idle.includes('Start tour') && idle.includes('The tour has not started yet') && idle.includes('Pause'))
  const off = panel(T1, { ok: false, t: tEn })
  assert.doesNotMatch(off, HAN_RE)
  const nd = panel({ ...T0, ready: false }, { t: tEn })
  assert.doesNotMatch(nd, HAN_RE)
  const withNote = panel(T1, { t: tEn })
  assert.match(withNote, /潮汐備註/, '備註原文不翻譯')
  assert.equal(withNote.replace('潮汐備註', '').match(HAN_RE), null)
})

