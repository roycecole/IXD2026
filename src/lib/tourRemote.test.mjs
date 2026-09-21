// 導覽員遙控（手機當導覽員遙控器）的單元 / 整合測試。執行：node --test src/lib/tourRemote.test.mjs
// 涵蓋：token（隨機、格式、拒絕取樣）、網址 hash 解析（&guide=、多餘參數、編碼、壞資料）、協定訊息驗證、
//   host 端 createGuideHost（token 驗證：正確 / 錯誤 / 缺少 / 重複 hello / 暴力猜測；非導覽員指令被忽略；每個指令的行為；150ms 節流；goto 邊界；
//   導覽沒在跑時的指令；touchGuide 有呼叫而 touch 沒有；格式錯誤訊息不丟例外；連線關閉後移出集合）、
//   狀態酬載（白名單 / 備註 ≤120 字 / 站位置不位移）與推送時機（createGuideSync：立即推、變化才推、每 2 秒補推、停止即清）、
//   遙控頁的檢視模型與訊息 reducer、展場 QR 的 G 鍵判斷，以及「真的 runner + 真的 store + 真的活動掛鉤」的整合（導覽員指令不會中止導覽）。
//   第 5 輪補強：倒數欄位（remainMs / stopMs）的酬載與相容、guideView 的倒數 / 下一站預告、本機內插（校準 / 暫停凍結）、tourRunner.remainingMs()（真的 runner + 假時鐘）、
//   推送時機（換站 / 暫停 / 繼續即時推、其餘 2 秒補推）、host 端同一支手機的連線取代（peer id 去重、舊連線的 close 不影響新連線）、
//   遙控頁連線單例（createBoot / ensurePeer / releasePeer：自動重連、重送 hello、StrictMode 雙掛載）與狀態文字、導覽員區塊的倒數 / 預告 / 喚醒標示的 SSR 標記。
// 連線 / 計時器 / runner 都是「會檢查 this 的假物件」：脫離原物件呼叫會丟 Illegal invocation，跟瀏覽器一樣。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { create } from 'zustand'
import { illegal, withStorage, importJsx, makeTimers } from './tourTestEnv.mjs'
import {
  GUIDE_STOP_IDS, GUIDE_STOP_OTHER, GUIDE_CMDS, GUIDE_NOTE_MAX, GUIDE_MAX_STOPS, GUIDE_MAX_STOP_MS, GUIDE_MIN_GAP_MS, GUIDE_PUSH_MS, GUIDE_MAX_BAD_HELLO, GUIDE_TOKEN_LEN, GUIDE_QR_MS, GUIDE_HELLO_WAIT_MS,
  isGuideToken, makeGuideToken, parseRemoteHash, buildRemoteUrl, helloMsg, guideCmd, parseGuideCmd, tourPayload, parseTourPayload, reduceGuideMsg, guideView, countdownView, countdownExtra, isGuideQrKey,
  createGuideHost, createGuideSync,
} from './tourRemote.js'
import { TOUR_STOP_IDS } from './tourLink.js'
import { backoffMs } from './remoteReconnect.js'

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
function realSetup(over = {}) {
  S().stopPlayback(); if (S().rec.mode === 'recording') S().stopRecording()
  S().clearRec()
  S().setGov(gov)
  S().setRecSpeed(1)
  useTourStore.setState({ remote: false, running: false, paused: false, caption: null, stopList: [], index: 0, total: 0 })
  const clock = { t: 5e6 }
  const runner = createTourRunner({ store: useStore, getActivity: () => activity.last, touch, now: () => clock.t })
  const detach = attachTourGuards({ win: makeWin(), doc: Object.assign(makeWin(), { hidden: false }), runner })   // 與正式環境一樣的活動掛鉤：任何 touch() 都會中止導覽
  const host = createGuideHost({ runner, tourStore: useTourStore, touchGuide, noteActivity: noteRemoteActivity, now: () => clock.t, getToken: () => TOKEN, setSpeak, getExtra: over.getExtra || (() => ({ ready: true })) })
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

test('遙控頁保持輕量：RemoteApp 只 import react / ice / sensors / i18n / tourRemote / remoteReconnect / wakeLockLite / guide.css，不碰 three、store、tour.js、tourCore、multiplayer、主畫面的 wakeLock.js；tourRemote / remoteReconnect / wakeLockLite 本身沒有任何 import', () => {
  const app = src('../remote/RemoteApp.jsx')
  assert.deepEqual(importsOf(app).sort(), ['../i18n/LangNotice.jsx', '../i18n/index.js', '../lib/ice.js', '../lib/remoteReconnect.js', '../lib/sensors.js', '../lib/tourRemote.js', '../lib/wakeLockLite.js', '../styles/guide.css', 'react'])
  assert.deepEqual(importsOf(src('../i18n/LangNotice.jsx')).sort(), ['../styles/langnotice.css', './index.js'], '語言鈕的載入 / 失敗提示（很小）：只 import i18n 與自己的 CSS，不會把別的東西拉進遙控頁')
  for (const bad of ['three', 'zustand', 'store', 'tour.js', 'tourCore', 'multiplayer', 'services', 'scene', 'App.jsx', 'lib/wakeLock.js']) assert.equal(importsOf(app).some((s) => s.includes(bad)), false, bad)
  for (const f of ['./tourRemote.js', './remoteReconnect.js', './wakeLockLite.js']) assert.equal(importsOf(src(f)).length, 0, f)
})

test('RemoteApp：連線 open 後送 hello（帶 token）、逾時不回應就退回一般遙控；導覽員區塊有大按鈕 / 站 chips / 念出字幕（暫停鈕文字會換，不設 aria-pressed）；演奏控制收進預設收合的 details；震動走功能偵測', () => {
  const app = src('../remote/RemoteApp.jsx')
  assert.match(app, /conn\.send\(helloMsg\(guideToken\)\)/)
  assert.match(app, /GUIDE_HELLO_WAIT_MS/)
  assert.match(app, /b\.guide === 'pending'\) \{ b\.guide = 'denied'/)
  assert.match(app, /reduceGuideMsg/)
  assert.match(app, /<details className="remote-play">/)
  assert.doesNotMatch(app, /<details[^>]*\bopen\b/, '預設收合')
  assert.doesNotMatch(app, /aria-pressed=\{v\.paused\}/, '暫停 ⇄ 繼續 的可見文字會換：再設 aria-pressed 會讀成「繼續，已按下」（暫停中被讀反）；暫停狀態由 aria-live 區的「已暫停」念出')
  assert.match(app, /aria-pressed=\{v\.speak\}/, '念出字幕的開關維持不變')
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
  // 卸載清理（計時器一律經注入的 setTimer / clearTimer：測試用假計時器、預設是「裸函式包一層」）
  assert.match(app, /clearTimer\(b\.helloTimer\)/)
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

test('SSR·導覽員區塊（進行中 + 暫停 + 備註）：站名、第 n / N 站、已暫停、備註、三顆大按鈕（暫停鈕顯示「繼續」、on 樣式、沒有 aria-pressed）、站 chips（只有目前站 aria-current）、結束導覽', () => {
  const html = panel({ ...T1, paused: true })
  assert.match(html, /<section class="guide" aria-label="導覽員">/)
  assert.match(html, /<div class="guide-stop">潮汐<\/div>/)
  assert.match(html, /第 2 \/ 3 站/)
  assert.match(html, /<span class="guide-paused">已暫停<\/span>/)
  assert.match(html, /<p class="guide-note">潮汐備註<\/p>/)
  assert.match(html, /<button class="guide-btn on">繼續<\/button>/)
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

test('SSR·導覽員區塊（進行中、沒暫停、沒備註）：暫停鈕顯示「暫停」（沒有 on 樣式、沒有 aria-pressed）；沒有備註區塊、沒有「已暫停」', () => {
  const html = panel({ ...T1, index: 2 })
  assert.match(html, /<button class="guide-btn">暫停<\/button>/)
  assert.doesNotMatch(html, /guide-note|guide-paused/)
  assert.match(html, /<div class="guide-stop">月亮<\/div>/)
})

test('SSR·導覽員區塊：暫停 / 繼續鈕在任何狀態都沒有 aria-pressed（文字會換的動作鈕；念出字幕的開關才是 aria-pressed）', () => {
  for (const tour of [T0, T1, { ...T1, paused: true }, { ...T0, ready: false }, { ...T0, busy: true }, null]) {
    const html = panel(tour)
    assert.doesNotMatch(html, /aria-pressed="(true|false)"[^>]*>(暫停|繼續)</, JSON.stringify(tour))
  }
  assert.match(panel(T1), /aria-pressed="true">念出字幕：開/); assert.match(panel({ ...T1, speak: false }), /aria-pressed="false">念出字幕：關/)
})

test('SSR·導覽員區塊（導覽沒在跑）：只有「開始導覽」可按；上一站 / 暫停 / 下一站停用；沒有 chips；仍可設定念出字幕', () => {
  const html = panel(T0)
  assert.match(html, /導覽還沒開始/)
  assert.match(html, /guide-run start"[^>]*>開始導覽<\/button>/)
  assert.doesNotMatch(html, /guide-run start"[^>]*disabled/)
  assert.equal(count(html, /<button class="guide-btn"[^>]*disabled/g), 3, '上一站 / 暫停 / 下一站都停用')
  assert.match(html, /<button class="guide-btn" disabled="">暫停<\/button>/)
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


// =============================================================================================
// 第 5 輪：倒數（remainMs / stopMs）— 酬載、相容、檢視模型、本機內插
// =============================================================================================
const RUN3 = { running: true, paused: false, index: 1, total: 3, stopList: stopList(['tide', 'moon', 'dust'], { dust: '這站講 PM10' }) }

test('tourPayload：倒數欄位 remainMs / stopMs 只在導覽進行中、且是有限非負數時才帶（四捨五入成整數、夾上限；stopMs 要 > 0）；0 是合法的', () => {
  const m = tourPayload(RUN3, { speak: false, canSpeak: true, ready: true, remainMs: 8123.6, stopMs: 16000 })
  assert.equal(m.remainMs, 8124)
  assert.equal(m.stopMs, 16000)
  assert.equal(Number.isInteger(m.remainMs), true)
  assert.equal(tourPayload(RUN3, { remainMs: 0 }).remainMs, 0, '剩 0 毫秒是合法的')
  assert.equal('stopMs' in tourPayload(RUN3, { remainMs: 5, stopMs: 0 }), false, 'stopMs 要 > 0')
  assert.equal(tourPayload(RUN3, { remainMs: 1e12, stopMs: 1e12 }).remainMs, GUIDE_MAX_STOP_MS)
  assert.equal(tourPayload(RUN3, { remainMs: 1e12, stopMs: 1e12 }).stopMs, GUIDE_MAX_STOP_MS)
  for (const bad of [-1, NaN, Infinity, -Infinity, '5', null, undefined, {}, [], true]) {
    const q = tourPayload(RUN3, { remainMs: bad, stopMs: bad })
    assert.equal('remainMs' in q, false, String(bad))
    assert.equal('stopMs' in q, false, String(bad))
  }
  const idle = tourPayload({ running: false }, { remainMs: 5000, stopMs: 9000 })
  assert.equal('remainMs' in idle || 'stopMs' in idle, false, '沒在跑就沒有倒數')
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m, '純 JSON')
})

test('tourPayload：舊欄位相容——沒給倒數欄位時，酬載的鍵與以前完全相同（舊版遙控頁 / 舊測試不受影響）；附加欄位與倒數欄位互不干擾', () => {
  assert.deepEqual(Object.keys(tourPayload(RUN3)).sort(), ['index', 'paused', 'running', 'stops', 't', 'total'])
  assert.deepEqual(Object.keys(tourPayload(RUN3, { speak: true, canSpeak: true, ready: true })).sort(), ['canSpeak', 'index', 'paused', 'ready', 'running', 'speak', 'stops', 't', 'total'])
  assert.deepEqual(Object.keys(tourPayload(RUN3, { speak: true, canSpeak: true, ready: true, remainMs: 1, stopMs: 2, evil: 'x' })).sort(), ['canSpeak', 'index', 'paused', 'ready', 'remainMs', 'running', 'speak', 'stopMs', 'stops', 't', 'total'])
  const withFields = tourPayload(RUN3, { remainMs: 100, stopMs: 200 })
  const without = tourPayload(RUN3)
  const { remainMs, stopMs, ...rest } = withFields
  assert.deepEqual(rest, without, '除了那兩個欄位，其餘逐欄相同')
})

test('parseTourPayload：倒數欄位是選用的——往返保留；缺 / 格式不對只丟掉那個欄位（整則狀態仍有效）；沒在跑的狀態不帶；舊版主畫面的酬載解出來與以前逐欄相同', () => {
  const wire = JSON.parse(JSON.stringify(tourPayload(RUN3, { ready: true, remainMs: 8123.6, stopMs: 16000 })))
  const p = parseTourPayload(wire)
  assert.equal(p.remainMs, 8124); assert.equal(p.stopMs, 16000)
  assert.deepEqual(p.stops.map((s) => s.id), ['tide', 'moon', 'dust'])
  const old = parseTourPayload(JSON.parse(JSON.stringify(tourPayload(RUN3, { ready: true }))))
  assert.equal('remainMs' in old || 'stopMs' in old, false)
  for (const bad of [-5, NaN, Infinity, '9', null, {}, [], true]) {
    const q = parseTourPayload({ ...wire, remainMs: bad, stopMs: bad })
    assert.ok(q, `整則狀態仍有效：${String(bad)}`)
    assert.equal('remainMs' in q || 'stopMs' in q, false, String(bad))
    assert.equal(q.index, 1)
  }
  assert.equal('stopMs' in parseTourPayload({ ...wire, stopMs: 0 }), false)
  assert.equal(parseTourPayload({ ...wire, remainMs: 1e12 }).remainMs, GUIDE_MAX_STOP_MS)
  const idle = parseTourPayload({ ...wire, running: false })
  assert.equal('remainMs' in idle || 'stopMs' in idle, false, '沒在跑：不帶')
  const extra = parseTourPayload({ ...wire, evil: 1, remain: 3 })
  assert.equal('evil' in extra, false)
})

test('reduceGuideMsg：每次新推送（remainMs 不同）都是新的 tour 物件（遙控頁據此重新校準倒數）；完全相同的推送回傳同一個物件', () => {
  const ok = { guide: 'ok', tour: null }
  const a = reduceGuideMsg(ok, { t: 'tour', ...T1, remainMs: 9000, stopMs: 16000 })
  assert.equal(a.tour.remainMs, 9000)
  const b = reduceGuideMsg(a, { t: 'tour', ...T1, remainMs: 7000, stopMs: 16000 })
  assert.notEqual(b.tour, a.tour)
  assert.equal(b.tour.remainMs, 7000)
  const c = reduceGuideMsg(b, { t: 'tour', ...T1, remainMs: 7000, stopMs: 16000 })
  assert.equal(c.tour, b.tour)
})

test('guideView：舊版主畫面（沒有 remainMs）→ timed:false、next:null（畫面整段不顯示）；有 remainMs → timed、remainMs / stopMs、下一站預告（站 id + 備註）', () => {
  const v0 = guideView(T1, true)
  assert.deepEqual([v0.timed, v0.remainMs, v0.stopMs, v0.next], [false, null, null, null])
  const t = { ...T1, index: 0, stops: [{ id: 'reservoir' }, { id: 'tide', note: '潮汐備註' }, { id: 'moon' }], remainMs: 8000, stopMs: 11000 }
  const v = guideView(t, true)
  assert.deepEqual([v.timed, v.remainMs, v.stopMs], [true, 8000, 11000])
  assert.deepEqual(v.next, { last: false, id: 'tide', index: 1, note: '潮汐備註' })
  assert.deepEqual(guideView({ ...t, index: 1 }, true).next, { last: false, id: 'moon', index: 2, note: '' })
  assert.deepEqual(guideView({ ...t, index: 2 }, true).next, { last: true, id: null, index: 3, note: '' }, '最後一站')
  assert.equal(guideView({ ...t, stopMs: undefined }, true).stopMs, null, '沒有總長：只有文字倒數、沒有進度條')
  assert.equal(guideView({ ...t, stopMs: 0 }, true).stopMs, null)
  assert.equal(guideView({ ...t, index: 9 }, true).next, null, 'index 超出 stops：沒有預告（不丟例外）')
  const idle = guideView({ ...T0, remainMs: 5000 }, true)
  assert.deepEqual([idle.timed, idle.next], [false, null], '沒在跑：沒有倒數')
  assert.equal(guideView({ ...t, remainMs: NaN }, true).timed, false)
  assert.equal(guideView({ ...t, remainMs: '8' }, true).timed, false)
  assert.equal(guideView(t, false).timed, true, '連線中斷時模型仍保留（畫面自己決定不顯示）')
})

test('countdownView：進行中 = remainMs −（now − at）（不會小於 0、進位到整秒）；暫停時凍結；進度比例 = 已過 / 總長；沒有總長 → frac:null；不是 timed → null', () => {
  const v = guideView({ ...T1, remainMs: 12000, stopMs: 16000 }, true)
  const at = 5000
  assert.deepEqual(countdownView(v, at, 5000), { remainMs: 12000, secs: 12, frac: 0.25, paused: false })
  assert.equal(countdownView(v, at, 6000).secs, 11)
  assert.equal(countdownView(v, at, 6001).secs, 11, '進位到整秒：10999ms → 11')
  assert.equal(countdownView(v, at, 5500).secs, 12, '11500ms → 12')
  assert.equal(countdownView(v, at, 17000).remainMs, 0)
  assert.equal(countdownView(v, at, 17000).secs, 0)
  assert.equal(countdownView(v, at, 17000).frac, 1)
  assert.equal(countdownView(v, at, 99999999).remainMs, 0, '很久之後：停在 0，不會變負數')
  assert.equal(countdownView(v, at, 4000).remainMs, 12000, '時鐘倒退：不會多出時間')
  assert.equal(countdownView(guideView({ ...T1, remainMs: 12000 }, true), at, 5000).frac, null)
  assert.equal(countdownView(guideView(T1, true), at, 5000), null, '舊版主畫面')
  assert.equal(countdownView(null, at, 5000), null)
  for (const bad of [undefined, NaN, null, 'x']) assert.equal(countdownView(v, bad, 6000).remainMs, 12000, `at 壞掉 → 不內插：${String(bad)}`)
  assert.equal(countdownView(v, at, NaN).remainMs, 12000)
})

test('countdownView：暫停時凍結——本機時間再怎麼走剩餘時間都不動，進度條也不動', () => {
  const v = guideView({ ...T1, paused: true, remainMs: 6500, stopMs: 16000 }, true)
  for (const now of [5000, 6000, 60000, 1e9]) {
    const c = countdownView(v, 5000, now)
    assert.deepEqual([c.remainMs, c.secs, c.paused], [6500, 7, true])
    assert.equal(c.frac, 1 - 6500 / 16000)
  }
})

test('倒數校準（避免漂移）：每 2 秒收到新的推送就以新的 remainMs 與收到時間重設；本機時鐘偏快 / 偏慢都不會累積誤差', () => {
  // 主畫面的真實剩餘時間：16000 起、每 2000ms 推一次；手機本機時鐘偏快 5%（100ms 的時鐘跑 105）
  let remain = 16000, at = 0, local = 0
  const worst = []
  for (let push = 0; push < 7; push++) {
    const v = guideView({ ...T1, remainMs: remain, stopMs: 16000 }, true)         // 收到推送：重設基準
    at = local
    for (const step of [500, 1000, 1500, 1999]) {                                 // 兩次推送之間，手機以自己（偏快的）時鐘內插
      const shown = countdownView(v, at, at + step * 1.05).remainMs
      worst.push(Math.abs(shown - (remain - step)))
    }
    remain -= 2000; local += 2000 * 1.05
  }
  assert.ok(Math.max(...worst) <= 105, `任何時刻的誤差都不會超過一個推送週期內的 5%（實際最大 ${Math.max(...worst)}ms）`)
  // 對照：不校準（只用第一次的基準）→ 誤差會一路累積
  const v0 = guideView({ ...T1, remainMs: 16000, stopMs: 16000 }, true)
  assert.ok(Math.abs(countdownView(v0, 0, 12 * 1000 * 1.05).remainMs - (16000 - 12000)) >= 600, '不校準的話 12 秒後誤差已 ≥ 600ms')
})

// =============================================================================================
// countdownExtra（runner → 酬載欄位）與 tourRunner.remainingMs()
// =============================================================================================
test('countdownExtra：remainMs = runner.remainingMs()、stopMs = runner.current().stop.durationMs；以方法呼叫 runner；沒在跑 / 舊 runner / 丟例外 → {}', () => {
  const runner = {
    remainingMs() { if (this !== runner) throw illegal(); return 8123 },
    current() { if (this !== runner) throw illegal(); return { index: 0, total: 3, stop: { durationMs: 16000 } } },
  }
  assert.deepEqual(countdownExtra(runner), { remainMs: 8123, stopMs: 16000 })
  assert.deepEqual(countdownExtra({ remainingMs: () => null, current: () => null }), {}, '沒在跑')
  assert.deepEqual(countdownExtra({ remainingMs: () => NaN }), {})
  assert.deepEqual(countdownExtra({ remainingMs: () => 5000, current: () => ({ stop: null }) }), { remainMs: 5000 }, '有剩餘時間但沒有總長：只帶 remainMs')
  assert.deepEqual(countdownExtra({ remainingMs: () => 5000, current: () => ({ stop: { durationMs: 0 } }) }), { remainMs: 5000 })
  assert.deepEqual(countdownExtra({ current: () => ({}) }), {}, '舊版 runner（沒有 remainingMs）')
  assert.deepEqual(countdownExtra({ remainingMs: () => { throw new Error('boom') } }), {})
  assert.deepEqual(countdownExtra({ remainingMs: () => 5000, current: () => { throw new Error('boom') } }), {})
  for (const bad of [null, undefined, 0, 'x', []]) assert.deepEqual(countdownExtra(bad), {})
})

test('runner.remainingMs：沒在跑 → null；開始後 = 該站總長、隨（假）時鐘遞減、超過就停在 0；停止後又是 null', () => {
  const env = realSetup()
  try {
    assert.equal(env.runner.remainingMs(), null)
    assert.equal(env.runner.start({ auto: false }), true)
    const stops = buildTour(S().gov)
    const dur0 = stops[0].durationMs
    assert.equal(typeof dur0, 'number')
    assert.equal(env.runner.remainingMs(), dur0)
    assert.equal(env.runner.current().stop.durationMs, dur0)
    env.clock.t += 3000
    assert.equal(env.runner.remainingMs(), dur0 - 3000)
    env.clock.t += 1e6                                                       // 沒有 tick：時間早就過了，但還沒換站（例如旁白還在念）
    assert.equal(env.runner.remainingMs(), 0)
    env.runner.stop('user')
    assert.equal(env.runner.remainingMs(), null)
  } finally { env.detach() }
})

test('runner.remainingMs：暫停時凍結、暫停期間時鐘再走也不動；繼續後從凍結的值接著倒數（不重新計滿）；唯讀（不改任何狀態）', () => {
  const env = realSetup()
  try {
    env.runner.start({ auto: false })
    const dur0 = buildTour(S().gov)[0].durationMs
    env.clock.t += 3000
    env.runner.pause()
    const frozen = env.runner.remainingMs()
    assert.equal(frozen, dur0 - 3000)
    env.clock.t += 20000
    assert.equal(env.runner.remainingMs(), frozen, '暫停中不動')
    env.clock.t += 5000
    assert.equal(env.runner.remainingMs(), frozen)
    env.runner.resume()
    assert.equal(env.runner.remainingMs(), frozen, '繼續的那一刻不變')
    env.clock.t += 1000
    assert.equal(env.runner.remainingMs(), frozen - 1000, '繼續後接著倒數')
    // 唯讀：反覆呼叫不影響導覽（狀態 / 計時都不變）
    const before = { ...env.runner.current() }
    for (let i = 0; i < 50; i++) env.runner.remainingMs()
    assert.deepEqual({ ...env.runner.current() }, before)
    assert.equal(env.runner.remainingMs(), frozen - 1000)
  } finally { env.detach() }
})

test('runner.remainingMs：換站（goto / next / prev）重新計滿該站；暫停中換站 = 新一站的整段總長且凍結；最後一站 / 從頭開始暫停（hold）也正確', () => {
  const env = realSetup()
  try {
    const stops = buildTour(S().gov)
    const n = stops.length
    assert.ok(n >= 3)
    env.runner.start({ auto: false })
    env.clock.t += 4000
    env.runner.next()
    assert.equal(env.runner.remainingMs(), stops[1].durationMs, '換站：重新計滿')
    env.clock.t += 2500
    assert.equal(env.runner.remainingMs(), stops[1].durationMs - 2500)
    env.runner.goto(n - 1)
    assert.equal(env.runner.remainingMs(), stops[n - 1].durationMs, '最後一站')
    env.clock.t += 1000
    assert.equal(env.runner.remainingMs(), stops[n - 1].durationMs - 1000)
    env.runner.prev()
    assert.equal(env.runner.remainingMs(), stops[n - 2].durationMs)
    env.runner.pause()
    env.clock.t += 3000
    env.runner.goto(0)                                                       // 暫停中跳站：新一站在起點凍結
    assert.equal(env.runner.isPaused(), true)
    assert.equal(env.runner.remainingMs(), stops[0].durationMs)
    env.clock.t += 60000
    assert.equal(env.runner.remainingMs(), stops[0].durationMs, '暫停中：整段總長，不動')
    env.runner.stop('user')
    // hold：導覽員模式（一開始就暫停在第 0 站）
    assert.equal(env.runner.start({ auto: false, hold: true }), true)
    assert.equal(env.runner.isPaused(), true)
    assert.equal(env.runner.remainingMs(), stops[0].durationMs)
    env.clock.t += 10000
    assert.equal(env.runner.remainingMs(), stops[0].durationMs)
    env.runner.resume()
    env.clock.t += 2000
    assert.equal(env.runner.remainingMs(), stops[0].durationMs - 2000)
    env.runner.stop('user')
  } finally { env.detach() }
})

test('runner.remainingMs：start() 內第一次通知站表時還沒進入任何一站 → null（不丟例外）；之後每次通知都是數字；自動導覽循環回第 0 站也重新計滿', () => {
  const env = realSetup()
  const seen = []
  const off = useTourStore.subscribe(() => { seen.push(env.runner.remainingMs()) })
  try {
    assert.doesNotThrow(() => env.runner.start({ auto: false }))
    off()
    assert.equal(seen[0], null, '站表就緒、還沒進站（run.i = -1）：null')
    assert.equal(typeof seen.at(-1), 'number')
    env.runner.stop('user')
    assert.equal(env.runner.start({ auto: true }), true)
    const stops = buildTour(S().gov)
    env.runner.goto(stops.length - 1)
    env.clock.t += 5000
    env.runner.next()                                                        // 自動導覽：最後一站 → 回第 0 站
    assert.equal(env.runner.current().index, 0)
    assert.equal(env.runner.remainingMs(), env.runner.current().stop.durationMs)
    env.runner.stop('user')
  } finally { off(); env.detach() }
})

test('整合：倒數欄位隨換站 / 暫停 / 繼續即時推、其餘由每 2 秒補推帶著（remainMs 隨時間遞減）；兩次補推之間沒有額外流量；stopMs = 該站總長', () => {
  let runnerRef
  const env = realSetup({ getExtra: () => ({ ready: true, ...countdownExtra(runnerRef) }) })
  runnerRef = env.runner
  const iv = makeIv()
  const sync = createGuideSync({ tourStore: useTourStore, payload: () => env.host.payload(), broadcast: (m) => env.host.broadcast(m), setIv: iv.setIv, clearIv: iv.clearIv })
  try {
    sync.start()
    const stops = buildTour(S().gov)
    const pushes = () => env.conn.all('tour')
    const last = () => pushes().at(-1)
    assert.equal('remainMs' in last(), false, '導覽沒在跑：沒有倒數欄位')
    send(env, guideCmd('start'))
    assert.equal(last().running, true)
    assert.equal(last().remainMs, stops[0].durationMs, '開始：即時推，剩餘 = 整站')
    assert.equal(last().stopMs, stops[0].durationMs)
    // 兩次補推之間時間在走，但沒有額外流量
    const n0 = pushes().length
    env.clock.t += 500
    assert.equal(pushes().length, n0, '沒有計時器就沒有推送')
    env.clock.t += 1500
    iv.fire()                                                                // 每 2 秒補推
    assert.equal(pushes().length, n0 + 1)
    assert.equal(last().remainMs, stops[0].durationMs - 2000, '補推帶著最新的剩餘時間')
    // 換站：即時推、重新計滿
    send(env, guideCmd('next'))
    assert.equal(last().index, 1)
    assert.equal(last().remainMs, stops[1].durationMs)
    assert.equal(last().stopMs, stops[1].durationMs)
    // 暫停：即時推、凍結
    env.clock.t += 3000
    send(env, guideCmd('pause'))
    assert.equal(last().paused, true)
    const frozen = last().remainMs
    assert.equal(frozen, Math.round(env.runner.remainingMs()))
    env.clock.t += 10000
    iv.fire()
    assert.equal(last().remainMs, frozen, '暫停中補推：剩餘時間凍結')
    // 繼續：即時推
    send(env, guideCmd('resume'))
    assert.equal(last().paused, false)
    assert.equal(last().remainMs, frozen)
    env.clock.t += 1000
    iv.fire()
    assert.equal(last().remainMs, frozen - 1000)
    // 跳到目前這一站 = 重播：倒數重新計滿（同一站、同 index 也立刻推）
    send(env, guideCmd('goto', 1))
    assert.equal(last().remainMs, stops[1].durationMs)
    // 停止：倒數欄位消失
    send(env, guideCmd('stop'))
    assert.equal(last().running, false)
    assert.equal('remainMs' in last() || 'stopMs' in last(), false)
    // 遙控頁看到的一路都對（訊息經 JSON 往返）
    let st = { guide: 'pending', tour: null }
    for (const m of env.conn.sent) st = reduceGuideMsg(st, JSON.parse(JSON.stringify(m)))
    assert.equal(st.guide, 'ok')
  } finally { sync.stop(); env.detach() }
})

// =============================================================================================
// host 端：同一支手機以新連線取代舊連線
// =============================================================================================
test('host：同一支手機（同一個 peer id）以新連線取代舊連線——舊連線移出集合並關閉、人數不重複、只推給新連線；舊連線之後才發的 close 不會把新連線移出集合', () => {
  const { host, rec, changes, runner } = setup()
  const oldC = makeConn('phone-1'); host.handle(oldC, helloMsg(TOKEN))
  assert.equal(host.size(), 1)
  const newC = makeConn('phone-1'); host.handle(newC, helloMsg(TOKEN))       // 鎖屏後自動重連：新連線 + 重送 hello
  assert.equal(host.size(), 1, '同一支手機不會有兩條連線')
  assert.deepEqual(host.conns(), [newC])
  assert.equal(host.has(oldC), false)
  assert.equal(oldC.closed, 1, '舊連線被關掉')
  assert.equal(newC.last('guide').ok, true)
  assert.equal(newC.last('tour').t, 'tour', '新連線立刻拿到最新狀態')
  assert.deepEqual(rec.logs, [['join', 1], ['join', 1]], '取代不是離線 + 加入兩次人數起伏：人數維持 1')
  assert.equal(changes.n, 2)
  // multiplayer.js 的 close / error 處理會呼叫 host.remove(舊連線)：只移除它自己
  assert.equal(host.remove(oldC), false)
  assert.equal(host.has(newC), true)
  assert.equal(host.size(), 1)
  assert.equal(changes.n, 2, '舊連線的殘留 close 不再通知')
  // 只推給新連線
  const before = oldC.sent.length
  assert.equal(host.broadcast({ t: 'tour', ping: 1 }), 1)
  assert.equal(oldC.sent.length, before)
  assert.equal(newC.last('tour').ping, 1)
  // 舊連線再送的指令一律忽略；新連線的指令照常
  runner.st.run = true
  host.handle(oldC, guideCmd('next'))
  assert.deepEqual(runner.calls, [])
  host.handle(newC, guideCmd('next'))
  assert.deepEqual(runner.names(), ['next'])
})

test('host：舊連線的 close 先到（新連線還沒 hello）→ 正常移除；新連線 hello 後是新的成員；舊連線的 close() 丟例外也不影響取代', () => {
  const { host, rec } = setup()
  const oldC = makeConn('phone-2'); host.handle(oldC, helloMsg(TOKEN))
  assert.equal(host.remove(oldC), true)
  assert.equal(host.size(), 0)
  const newC = makeConn('phone-2'); host.handle(newC, helloMsg(TOKEN))
  assert.deepEqual(host.conns(), [newC])
  assert.equal(oldC.closed, 0, '舊連線早就不在集合：不必再關')
  assert.deepEqual(rec.logs, [['join', 1], ['leave', 0], ['join', 1]])
  const third = makeConn('phone-2'); newC.close = function () { throw new Error('close boom') }
  assert.doesNotThrow(() => host.handle(third, helloMsg(TOKEN)))
  assert.deepEqual(host.conns(), [third])
})

test('host：不同手機（不同 peer id）各自保留；沒有 peer id 的連線不去重；重複 hello（同一條連線）仍是冪等', () => {
  const { host } = setup()
  const a = makeConn('phone-a'), b = makeConn('phone-b')
  host.handle(a, helloMsg(TOKEN)); host.handle(b, helloMsg(TOKEN))
  assert.equal(host.size(), 2)
  const x = makeConn(); delete x.peer
  const y = makeConn(); delete y.peer
  host.handle(x, helloMsg(TOKEN)); host.handle(y, helloMsg(TOKEN))
  assert.equal(host.size(), 4, '沒有 peer id 無從判斷是不是同一支手機')
  host.handle(a, helloMsg(TOKEN))
  assert.equal(host.size(), 4)
  assert.equal(a.closed, 0)
  const z = makeConn(''); host.handle(z, helloMsg(TOKEN))
  assert.equal(host.size(), 5, '空字串 peer id 也不去重')
})

test('host：換成錯誤的 token 才是撤銷；新連線用錯誤 token hello 不會擠掉同一支手機的舊連線', () => {
  const { host } = setup()
  const oldC = makeConn('phone-3'); host.handle(oldC, helloMsg(TOKEN))
  const bad = makeConn('phone-3'); host.handle(bad, helloMsg('wrongtoken1'))
  assert.equal(host.has(bad), false)
  assert.equal(host.has(oldC), true, '驗證失敗的連線不取代任何人')
  assert.equal(oldC.closed, 0)
})

// =============================================================================================
// 遙控頁連線單例（createBoot / ensurePeer / releasePeer）：假 Peer + 假計時器
// =============================================================================================
const { statusForLink, createBoot, ensurePeer, releasePeer } = RemoteMod

function mkNet() {
  const timers = makeTimers()
  const st = timers.setTimeout, ct = timers.clearTimeout
  const listeners = { doc: new Map(), win: new Map() }
  const mkTarget = (name, vis) => {
    const d = {
      visibilityState: vis ? 'visible' : undefined,
      addEventListener(ev, f) { if (this !== d) throw illegal(); if (!listeners[name].has(ev)) listeners[name].set(ev, new Set()); listeners[name].get(ev).add(f) },
      removeEventListener(ev, f) { if (this !== d) throw illegal(); if (listeners[name].has(ev)) listeners[name].get(ev).delete(f) },
      fire(ev) { for (const f of [...(listeners[name].get(ev) || [])]) f({ type: ev }) },
    }
    return d
  }
  const doc = mkTarget('doc', 'visible'), win = mkTarget('win')
  const peers = []
  const mkConn = (host, o) => {
    const L = {}
    const c = {
      peer: host, opts: o, open: false, dead: false, sent: [],
      on(ev, f) { if (this !== c) throw illegal(); (L[ev] ||= []).push(f); return c },
      send(m) { if (this !== c) throw illegal(); if (!c.open) throw new Error('not open'); c.sent.push(m) },
      close() { if (this !== c) throw illegal(); c.dead = true; if (c.open) { c.open = false; c.fire('close') } },
      fire(ev, ...a) { for (const f of [...(L[ev] || [])]) f(...a) },
      doOpen() { c.open = true; c.fire('open') }, doData(m) { c.fire('data', m) }, doClose() { c.open = false; c.dead = true; c.fire('close') },
    }
    return c
  }
  const mkPeer = () => {
    const L = {}
    const conns = []
    const p = {
      open: false, disconnected: false, destroyed: false, conns,
      on(ev, f) { if (this !== p) throw illegal(); (L[ev] ||= []).push(f); return p },
      connect(host, o) { if (this !== p) throw illegal(); const c = mkConn(host, o); conns.push(c); return c },
      reconnect() { if (this !== p) throw illegal(); p.disconnected = false },
      destroy() { if (this !== p) throw illegal(); if (p.destroyed) return; for (const c of conns) c.close(); p.destroyed = true; p.fire('close') },
      fire(ev, ...a) { for (const f of [...(L[ev] || [])]) f(...a) },
      doOpen() { p.open = true; p.fire('open') },
      doUnavailable() { p.fire('error', { type: 'peer-unavailable' }) },
      last: () => conns[conns.length - 1],
    }
    return p
  }
  const deps = { makePeer: () => { const p = mkPeer(); peers.push(p); return Promise.resolve(p) }, env: { doc, win }, setTimer: (fn, ms) => st(fn, ms), clearTimer: (id) => ct(id) }
  const flush = () => new Promise((r) => setImmediate(r))
  const lis = () => [...listeners.doc.values(), ...listeners.win.values()].reduce((a, x) => a + x.size, 0)
  return { timers, deps, peers, doc, win, flush, listenerCount: lis, async up(b) { b.link.start(); await flush(); peers.at(-1).doOpen(); const c = peers.at(-1).last(); c.doOpen(); return c } }
}

const bootStatus = (b) => translate('zh', b.status, b.statusP)

test('createBoot（導覽員）：連上後送 hello；host 回 ok + 狀態 → guide=ok、tour 與收到時間；連線掉了 → 「重新連線中…（第 1 次）」、按鈕停用（ok=false）但保留導覽員身分與最後的狀態；1 秒後同一個 Peer 重連、重送 hello、清掉過時的狀態；新狀態一到就恢復', async () => {
  const net = mkNet()
  const b = createBoot('host1', TOKEN, net.deps)
  const emits = []
  b.subs.add(() => emits.push([b.ok, bootStatus(b)]))
  assert.equal(bootStatus(b), '連線中…')
  b.link.start(); await net.flush()
  net.peers[0].doOpen()
  const c1 = net.peers[0].last(); c1.doOpen()
  assert.equal(b.ok, true); assert.equal(bootStatus(b), '已連上主畫面 · 一起合奏')
  assert.deepEqual(c1.sent, [helloMsg(TOKEN)], 'open 後立刻送 hello')
  assert.equal(b.guide, 'pending')
  c1.doData({ t: 'guide', ok: true })
  c1.doData({ t: 'tour', ...T1, remainMs: 8000, stopMs: 16000 })
  assert.equal(b.guide, 'ok'); assert.equal(b.tour.remainMs, 8000)
  assert.ok(typeof b.tourAt === 'number' && b.tourAt > 0, '記下收到的本機時間（倒數內插的基準）')
  const at1 = b.tourAt
  c1.doData({ t: 'tour', ...T1, remainMs: 6000, stopMs: 16000 })
  assert.equal(b.tour.remainMs, 6000); assert.ok(b.tourAt >= at1, '每次新推送都重設基準')
  c1.doClose()
  assert.equal(b.ok, false)
  assert.deepEqual([b.status, b.statusP], ['重新連線中…（第 {n} 次）', { n: 1 }])
  assert.equal(bootStatus(b), '重新連線中…（第 1 次）')
  assert.equal(translate('en', b.status, b.statusP), 'Reconnecting… (attempt 1)')
  assert.equal(b.guide, 'ok', '導覽員身分維持（面板留著、按鈕停用）')
  assert.notEqual(b.tour, null, '斷線期間保留最後的狀態給畫面顯示')
  net.timers.advance(999); assert.equal(net.peers[0].conns.length, 1)
  net.timers.advance(1)
  assert.equal(net.peers.length, 1, '同一個 Peer 重連')
  const c2 = net.peers[0].last(); assert.notEqual(c2, c1)
  assert.equal(b.ok, false); assert.equal(bootStatus(b), '重新連線中…（第 1 次）')
  c2.doOpen()
  assert.equal(b.ok, true); assert.equal(bootStatus(b), '已連上主畫面 · 一起合奏')
  assert.deepEqual(c2.sent, [helloMsg(TOKEN)], '重連成功後重送 hello')
  assert.equal(b.tour, null, '過時的導覽狀態清掉（等主畫面的新狀態）')
  assert.equal(b.guide, 'ok')
  c2.doData({ t: 'guide', ok: true })
  c2.doData({ t: 'tour', ...T1, remainMs: 15000, stopMs: 16000 })
  assert.equal(b.tour.remainMs, 15000)
  assert.ok(emits.length > 4)
  b.destroy()
})

test('createBoot：hello 逾時沒回應 → denied（當一般遙控）；重連後重送 hello 仍有機會升級為 ok；重連成功時的 hello 計時器也會重新起算、掉線時清掉', async () => {
  const net = mkNet()
  const b = createBoot('host1', TOKEN, net.deps)
  const c1 = await net.up(b)
  assert.equal(b.guide, 'pending')
  net.timers.advance(GUIDE_HELLO_WAIT_MS - 1); assert.equal(b.guide, 'pending')
  net.timers.advance(1)
  assert.equal(b.guide, 'denied')
  c1.doClose()
  net.timers.advance(1000)
  const c2 = net.peers[0].last(); c2.doOpen()
  assert.deepEqual(c2.sent, [helloMsg(TOKEN)], 'denied 之後重連也再問一次（可能只是主畫面當時太忙）')
  c2.doData({ t: 'guide', ok: true })
  assert.equal(b.guide, 'ok')
  net.timers.advance(GUIDE_HELLO_WAIT_MS * 2)
  assert.equal(b.guide, 'ok', '回覆後 hello 計時器已清掉')
  // 等待回覆時掉線：計時器被清掉（不會在離線時把 pending 誤判成 denied）
  const net2 = mkNet()
  const b2 = createBoot('host1', TOKEN, net2.deps)
  const d1 = await net2.up(b2)
  d1.doClose()
  net2.timers.advance(GUIDE_HELLO_WAIT_MS - 1000 + 500)   // 離線期間（重連前）
  assert.equal(b2.guide, 'pending')
  b.destroy(); b2.destroy()
})

test('createBoot（一般遙控，沒有 token）：不送 hello；重連後 role / 滑桿同步值保留、送出走新連線（感測器的 send 不必重新綁定）', async () => {
  const net = mkNet()
  const b = createBoot('host1', null, net.deps)
  const c1 = await net.up(b)
  assert.deepEqual(c1.sent, [], '一般遙控不送 hello')
  assert.equal(b.guide, 'none')
  c1.doData({ t: 'role', id: 'ocean', label: '海', pids: ['seaLevel'] })
  c1.doData({ t: 'sync', params: { seaLevel: 0.7 } })
  c1.doData({ t: 'tour', ...T1 })                                            // 一般遙控不理導覽狀態
  assert.equal(b.tour, null)
  assert.equal(b.link.send({ t: 'p', pid: 'flowX', v: 0.5 }), true)
  assert.deepEqual(c1.sent, [{ t: 'p', pid: 'flowX', v: 0.5 }])
  c1.doClose()
  assert.equal(b.ok, false)
  assert.equal(b.link.send({ t: 'p', pid: 'flowX', v: 0.6 }), false, '重連期間送出是空操作（不丟例外）')
  assert.equal(b.role.id, 'ocean'); assert.equal(b.syncParams.seaLevel, 0.7)
  net.timers.advance(1000)
  const c2 = net.peers[0].last(); c2.doOpen()
  assert.equal(b.ok, true)
  assert.deepEqual(c2.sent, [], '重連後一般遙控仍不送 hello')
  assert.equal(b.link.send({ t: 'p', pid: 'flowX', v: 0.6 }), true)
  assert.deepEqual(c2.sent, [{ t: 'p', pid: 'flowX', v: 0.6 }], '走新連線')
  assert.equal(b.role.id, 'ocean', 'role / sync 保留到主畫面送新的來')
  b.destroy()
})

test('createBoot：主畫面已重新載入（peer-unavailable 連續 6 次）→ 停止、狀態「主畫面已重新載入，請重新掃描 QR」、沒有殘留計時器；中英文都有字', async () => {
  const net = mkNet()
  const b = createBoot('oldhost', TOKEN, net.deps)
  b.link.start(); await net.flush()
  const p = net.peers[0]; p.doOpen()
  for (let i = 1; i <= 6; i++) {
    p.doUnavailable()
    if (i < 6) { assert.equal(bootStatus(b), `重新連線中…（第 ${i} 次）`, '從沒連上過但失敗原因是「主畫面不存在」：不是 Wi-Fi 問題，不顯示 Wi-Fi 提示'); net.timers.advance(backoffMs(b.ls.n)) }
  }
  assert.equal(b.ls.phase, 'gaveup'); assert.equal(b.ok, false)
  assert.equal(bootStatus(b), '主畫面已重新載入，請重新掃描 QR')
  assert.equal(translate('en', b.status, b.statusP), 'The main screen was reloaded. Please scan the QR code again')
  net.timers.advance(600000)
  assert.equal(p.conns.length, 6)
  assert.equal(net.timers.pending(), 0, '沒有任何重試 / 逾時計時器')
  b.destroy()
  assert.equal(net.timers.pending(), 0)
})

test('createBoot：第一次連線超過 15 秒還沒連上 → 提示場地 Wi-Fi 可能擋 P2P（只在從沒連上過時）；連上之後不再提示', async () => {
  const net = mkNet()
  const b = createBoot('host1', null, net.deps)
  b.link.start(); await net.flush()
  net.peers[0].doOpen()                                                      // 已向訊號伺服器註冊，但 P2P 一直打不通（場地 Wi-Fi 擋 WebRTC）
  net.timers.advance(14999)
  assert.equal(bootStatus(b), '連線中…')
  net.timers.advance(1)
  assert.match(bootStatus(b), /^連線偏慢…/)
  net.timers.advance(1000)                                                   // 逾時後自動再試一次
  assert.match(bootStatus(b), /^連線偏慢…/, '還沒連上過：持續提示 Wi-Fi')
  net.peers[0].last().doOpen()
  assert.equal(bootStatus(b), '已連上主畫面 · 一起合奏')
  net.peers[0].last().doClose()
  assert.equal(bootStatus(b), '重新連線中…（第 1 次）', '連上過之後掉線：顯示重連次數，不是 Wi-Fi 提示')
  b.destroy()
  const net2 = mkNet()
  const c = createBoot('host1', null, net2.deps)
  const cc = await net2.up(c)
  assert.equal(net2.timers.pending(), 0, '連上後提示計時器已清掉')
  c.destroy()
})

test('ensurePeer / releasePeer（StrictMode 雙掛載）：cleanup 後排一個 macrotask 拆除、立刻重掛載就取消；只有一個 Peer；真的卸載才拆（Peer 銷毀、監聽 / 計時器全清、單例清空）；之後重新進入是全新連線', async () => {
  const net = mkNet()
  const sub = () => {}
  const b1 = ensurePeer('h', null, net.deps)
  b1.subs.add(sub)                                                           // 第一次 effect
  b1.subs.delete(sub); releasePeer(b1)                                       // StrictMode 的模擬卸載
  assert.notEqual(b1.teardown, null, '拆除已排程')
  const b2 = ensurePeer('h', null, net.deps)                                 // 第二次 effect（同一個 tick 內）
  assert.equal(b2, b1, '沿用同一個單例')
  assert.equal(b1.teardown, null, '取消了尚未執行的拆除')
  b2.subs.add(sub)
  net.timers.advance(0)
  await net.flush()
  assert.equal(net.peers.length, 1, '只建了一個 Peer')
  assert.equal(net.peers[0].destroyed, false)
  net.peers[0].doOpen(); net.peers[0].last().doOpen()
  assert.equal(b2.ok, true)
  assert.equal(net.listenerCount(), 3, '只有一組可見性 / 網路監聽')
  // 重複 ensurePeer（例如重新渲染）不會多建連線
  ensurePeer('h', null, net.deps)
  assert.equal(net.peers.length, 1)
  // 真的卸載
  b2.subs.delete(sub); releasePeer(b2)
  releasePeer(b2)                                                            // 重複 release 不會排兩個拆除
  net.timers.advance(0)
  assert.equal(net.peers[0].destroyed, true)
  assert.equal(net.listenerCount(), 0, '監聽全部移除')
  assert.equal(net.timers.pending(), 0, '計時器全部清掉')
  assert.equal(b2.subs.size, 0)
  const b3 = ensurePeer('h', null, net.deps)
  assert.notEqual(b3, b1, '單例已清空：重新進入是全新連線')
  await net.flush()
  assert.equal(net.peers.length, 2)
  b3.subs.add(sub); b3.subs.delete(sub); releasePeer(b3); net.timers.advance(0)
  assert.equal(net.peers[1].destroyed, true)
})

test('ensurePeer：網址參數不同（理論上整頁會重載）→ 拆掉舊連線再建新的；卸載時還有訂閱者的話不拆', async () => {
  const net = mkNet()
  const a = ensurePeer('hostA', null, net.deps)
  await net.flush()
  const c = ensurePeer('hostB', TOKEN, net.deps)
  assert.notEqual(c, a)
  assert.equal(net.peers[0].destroyed, true, '舊連線被拆掉')
  await net.flush()
  assert.equal(net.peers.length, 2)
  c.subs.add(() => {})
  releasePeer(c)
  assert.equal(c.teardown, null, '還有訂閱者：不排拆除')
  c.subs.clear(); releasePeer(c); net.timers.advance(0)
  assert.equal(net.peers[1].destroyed, true)
})

test('createBoot：destroy 完整拆除——連線層停止（Peer 銷毀、監聽移除）、hello / 提示 / 拆除計時器全清；destroy 後晚到的事件不再通知訂閱者', async () => {
  const net = mkNet()
  const b = createBoot('host1', TOKEN, net.deps)
  let notified = 0
  b.subs.add(() => { notified++ })
  const c1 = await net.up(b)
  assert.equal(net.timers.pending(), 1, 'hello 計時器（提示計時器已在連上時清掉）')
  b.teardown = b.setTimer(() => {}, 5)
  b.destroy()
  assert.equal(net.timers.pending(), 0)
  assert.equal(net.listenerCount(), 0)
  assert.equal(net.peers[0].destroyed, true)
  const n = notified
  c1.fire('data', { t: 'tour', ...T1 }); c1.fire('close')
  net.peers[0].fire('open')
  assert.equal(notified, n)
})

test('statusForLink：連線層狀態 → 中文 key（T 標記）＋ 插值參數；中英文都有字、沒有殘留 {n}', () => {
  const z = (ls, o) => { const s = statusForLink(ls, o); return translate('zh', s.key, s.params) }
  const e = (ls, o) => { const s = statusForLink(ls, o); return translate('en', s.key, s.params) }
  assert.deepEqual(statusForLink(null), { key: '連線中…', params: null })
  assert.deepEqual(statusForLink({ phase: 'connecting', n: 0, ever: false }), { key: '連線中…', params: null })
  assert.match(z({ phase: 'connecting', n: 0, ever: false }, { slow: true }), /^連線偏慢…/)
  assert.match(z({ phase: 'waiting', n: 2, ever: false }, { slow: true }), /^連線偏慢…/, '從沒連上過：一直顯示 Wi-Fi 提示')
  assert.equal(z({ phase: 'waiting', n: 3, ever: true }, { slow: true }), '重新連線中…（第 3 次）', '連上過就不顯示 Wi-Fi 提示')
  assert.equal(z({ phase: 'connecting', n: 1, ever: true }), '重新連線中…（第 1 次）')
  assert.equal(z({ phase: 'connected', n: 0, ever: true }), '已連上主畫面 · 一起合奏')
  assert.equal(z({ phase: 'paused', n: 1, ever: true }), '連線中斷 · 回到這個畫面會自動重連')
  assert.equal(z({ phase: 'gaveup', reason: 'unavailable' }), '主畫面已重新載入，請重新掃描 QR')
  assert.equal(z({ phase: 'gaveup', reason: 'load', detail: 'chunk failed' }), '載入失敗：chunk failed')
  assert.equal(z({ phase: 'gaveup', reason: 'fatal', detail: 'browser-incompatible' }), '無法連線：browser-incompatible')
  assert.equal(z('壞輸入'), '連線中…')
  assert.equal(e({ phase: 'waiting', n: 3, ever: true }), 'Reconnecting… (attempt 3)')
  assert.equal(e({ phase: 'paused', n: 1, ever: true }), 'Disconnected · will reconnect when you come back to this screen')
  assert.equal(e({ phase: 'gaveup', reason: 'unavailable' }), 'The main screen was reloaded. Please scan the QR code again')
  assert.equal(e({ phase: 'connected' }), 'Connected to the main screen · jamming together')
  for (const ls of [{ phase: 'waiting', n: 4, ever: true }, { phase: 'gaveup', reason: 'unavailable' }, { phase: 'paused', n: 1 }]) assert.doesNotMatch(e(ls), /\{|[㐀-鿿]/)
})

// =============================================================================================
// SSR：導覽員區塊的倒數 / 下一站預告 / 螢幕喚醒標示
// =============================================================================================
const panel2 = (tour, { ok = true, t = tZh, at = 1000, now = 1000, wake = '' } = {}) => renderToStaticMarkup(React.createElement(GuidePanel, { v: guideView(tour, ok), ok, cmd: () => {}, t, at, now, wake }))
const TT = { ...T1, index: 1, stops: [{ id: 'reservoir' }, { id: 'tide' }, { id: 'moon', note: '看月亮的起落' }], remainMs: 12000, stopMs: 16000 }

test('SSR·倒數（進行中）：細進度條（已過比例）+「剩 12 秒」；隨本機時間內插（過 3.5 秒 → 剩 9 秒、進度往前）；role="timer" 不吵螢幕閱讀器；不在任何按鈕裡', () => {
  const html = panel2(TT, { at: 1000, now: 1000 })
  assert.match(html, /<div class="guide-time"><div class="guide-bar" aria-hidden="true"><i style="transform:scaleX\(0\.250\)"><\/i><\/div><span class="guide-left" role="timer" aria-live="off">剩 12 秒<\/span><\/div>/)
  const later = panel2(TT, { at: 1000, now: 4500 })
  assert.match(later, /剩 9 秒/)
  assert.match(later, /scaleX\(0\.469\)/)
  assert.doesNotMatch(later, /<button[^>]*>[^<]*剩/)
  assert.equal(count(html, /disabled/g), 0, '連線正常、導覽進行中：沒有按鈕被停用')
  // 進度條放在站名 / 第幾站之後（導覽員視線由上往下：站名 → 進度 → 倒數）
  assert.ok(html.indexOf('guide-stop') < html.indexOf('guide-meta') && html.indexOf('guide-meta') < html.indexOf('guide-time'))
  assert.match(panel2({ ...TT, remainMs: 100, stopMs: 16000 }, { at: 0, now: 5000 }), /剩 0 秒/)
  assert.match(panel2({ ...TT, stopMs: undefined }), /剩 12 秒/)
  assert.doesNotMatch(panel2({ ...TT, stopMs: undefined }), /guide-bar/, '沒有總長：只有文字倒數')
})

test('SSR·倒數（暫停）：凍結——本機時間再走剩餘時間也不動、標成 is-paused；已暫停標示與「繼續」鈕照舊', () => {
  const p = { ...TT, paused: true, remainMs: 6500 }
  for (const now of [1000, 60000, 1e7]) {
    const html = panel2(p, { at: 1000, now })
    assert.match(html, /<div class="guide-time is-paused">/)
    assert.match(html, /剩 7 秒/)
    assert.match(html, /<span class="guide-paused">已暫停<\/span>/)
    assert.match(html, /<button class="guide-btn on">繼續<\/button>/)
    assert.doesNotMatch(html, /aria-pressed="(true|false)"[^>]*>(繼續|暫停)</)
  }
})

test('SSR·下一站預告：「下一站：<站名>」+ 備註（若有）；最後一站 →「最後一站」；未知站 id →「下一站：第 n 站」；備註是純文字（HTML 被跳脫）', () => {
  const html = panel2(TT)
  assert.match(html, /<p class="guide-next"><span class="guide-next-k">下一站：月亮<\/span><span class="guide-next-note">看月亮的起落<\/span><\/p>/)
  const noNote = panel2({ ...TT, index: 0 })
  assert.match(noNote, /<p class="guide-next"><span class="guide-next-k">下一站：潮汐<\/span><\/p>/)
  assert.doesNotMatch(noNote, /guide-next-note/)
  const last = panel2({ ...TT, index: 2 })
  assert.match(last, /<p class="guide-next"><span class="guide-next-k">最後一站<\/span><\/p>/)
  assert.doesNotMatch(last, /下一站：/)
  assert.match(panel2({ ...TT, stops: [{ id: 'reservoir' }, { id: 'tide' }, { id: 'other' }] }), /下一站：第 3 站/)
  const evil = panel2({ ...TT, stops: [{ id: 'reservoir' }, { id: 'tide' }, { id: 'moon', note: '<img src=x onerror=alert(1)>' }] })
  assert.doesNotMatch(evil, /<img/)
  assert.match(evil, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.ok(html.indexOf('guide-time') < html.indexOf('guide-next'))
})

test('SSR·舊版主畫面（沒有 remainMs / stopMs）：倒數與下一站預告整段不顯示、其餘與以前逐字相同；沒在跑 / 連線中斷 / 還沒收到狀態也沒有', () => {
  const oldHtml = panel2(T1)
  assert.doesNotMatch(oldHtml, /guide-time|guide-next|guide-bar|guide-left|role="timer"|下一站：|最後一站|剩 /)
  assert.equal(oldHtml, panel(T1), '與第一波的輸出逐字相同')
  assert.equal(panel2({ ...T0, remainMs: 3000, stopMs: 9000 }).includes('guide-time'), false, '沒在跑')
  const off = panel2(TT, { ok: false })
  assert.doesNotMatch(off, /guide-time|guide-next|role="timer"/)
  assert.match(off, /class="guide is-offline"/)
  assert.equal(count(off, /<button/g), count(off, /<button[^>]*disabled/g), '重連期間每顆按鈕都停用')
  assert.doesNotMatch(panel2(null), /guide-time|guide-next/)
})

test('SSR·英文：倒數 / 預告 / 喚醒標示都是英文（站名用資料層譯名；備註是導覽員的原文）', () => {
  const html = panel2(TT, { t: tEn, wake: 'on' })
  assert.match(html, /9 s left|12 s left/)
  assert.ok(html.includes('Up next: Moon'))
  assert.ok(html.includes('Screen kept awake'))
  assert.equal(html.replace('看月亮的起落', '').match(HAN_RE), null)
  assert.ok(panel2({ ...TT, index: 2 }, { t: tEn }).includes('Last stop'))
  assert.ok(panel2(TT, { t: tEn, wake: 'unsupported' }).includes('This browser cannot keep the screen awake (set your phone’s auto-lock to a longer time)'))
  assert.match(panel2(TT, { t: tEn, at: 0, now: 2500 }), /10 s left/)
})

test('SSR·螢幕喚醒標示：持有中「螢幕保持喚醒中」；不支援 / 被拒 →「此瀏覽器無法保持喚醒（請把手機的自動鎖定調長）」；請求中 / 已放掉 / 空 / 連線中斷 → 不顯示', () => {
  assert.match(panel2(TT, { wake: 'on' }), /<p class="guide-wake">螢幕保持喚醒中<\/p>/)
  for (const w of ['unsupported', 'failed']) assert.match(panel2(TT, { wake: w }), /<p class="guide-wake is-off">此瀏覽器無法保持喚醒（請把手機的自動鎖定調長）<\/p>/, w)
  for (const w of ['pending', 'off', '', undefined]) assert.doesNotMatch(panel2(TT, { wake: w }), /guide-wake/, String(w))
  assert.doesNotMatch(panel2(TT, { ok: false, wake: 'on' }), /guide-wake/, '連線中斷：沒有持有 lock，不顯示')
  assert.ok(panel2(TT, { wake: 'on' }).indexOf('guide-head') < panel2(TT, { wake: 'on' }).indexOf('guide-wake'))
})

test('SSR·一般遙控與導覽員（驗證中）的頁面維持原樣：沒有倒數 / 預告 / 喚醒標示 / 重新整理鈕', () => {
  for (const props of [{ hostId: 'ms1' }, { hostId: 'ms1', guide: TOKEN }]) {
    const html = renderToStaticMarkup(React.createElement(RemoteApp, props))
    assert.doesNotMatch(html, /guide-time|guide-next|guide-wake|remote-retry/)
    assert.match(html, /<span class="remote-status">連線中…<\/span>/)
  }
})

// =============================================================================================
// 原始碼接線檢查
// =============================================================================================
test('RemoteApp：連線交給 createRemoteLink（不再自己 new Peer / 在 close 時清單例）、每次連線 open 都送 hello、卸載走 releasePeer、按鈕停用條件與重新整理鈕條件', () => {
  const app = src('../remote/RemoteApp.jsx')
  assert.match(app, /createRemoteLink\(\{/)
  assert.doesNotMatch(app, /peer\.connect\(/, '連線流程在 lib/remoteReconnect.js')
  assert.doesNotMatch(app, /conn\.on\('close'/)
  assert.match(app, /onOpen: \(conn, \{ reconnect \}\) => \{/)
  assert.match(app, /if \(reconnect\) b\.tour = null/)
  assert.match(app, /return \(\) => \{ b\.subs\.delete\(sync\); releasePeer\(b\) \}/)
  assert.match(app, /\{!ok && stuck && \(/, '只有連線層放棄時才顯示「重新連線」（重新整理）鈕；自動重連期間不顯示')
  assert.match(app, /setStuck\(!!b\.ls && b\.ls\.phase === 'gaveup'\)/)
  assert.match(app, /const send = \(m\) => \{ if \(boot\) boot\.link\.send\(m\) \}/, '送出永遠走目前的連線（重連後自動換成新的）')
  assert.equal(count(app, /disabled=\{!ok\}/g) >= 6, true, '滑桿 / 感測器 / 動作 / 打擊墊 / chips / 念出字幕在 ok=false 時都停用')
  // 感測器：只有 toggle 與卸載會停它；連線狀態變化（ok）不會
  assert.equal(count(app, /tiltRef\.current && tiltRef\.current\.stop\(\)/g), 2)
  assert.equal(count(app, /shakeStop\.current && shakeStop\.current\(\)/g), 2)
  assert.doesNotMatch(app, /useEffect\(\(\) => \{[^}]*sensorsOn[^}]*\}, \[[^\]]*\bok\b/, '感測器不隨連線狀態重建')
  // 倒數元件：只在「有在倒數」時才有計時器、清乾淨
  assert.match(app, /const live = !fixed && !v\.paused && v\.remainMs > 0/)
  assert.match(app, /const id = setInterval\(\(\) => setTick\(nowMs\(\)\), 250\)\n\s+return \(\) => clearInterval\(id\)/)
})

test('multiplayer.js：同一支手機重連 → 收掉同 peer id 的舊連線（含移出導覽員集合）、聲部沿用、不重複計入加入人數；host 重建時清空記憶；仍不 import 導覽模組', () => {
  const mp = src('./multiplayer.js')
  assert.match(mp, /import \{ createPeerMemory, staleConns \} from '\.\/remoteReconnect\.js'/)
  assert.match(mp, /const peerRoles = createPeerMemory\(\)/)
  assert.match(mp, /const again = !!c\.peer && peerRoles\.has\(c\.peer\)/)
  assert.match(mp, /for \(const old of staleConns\(conns, c\)\) \{\n\s+if \(guideHost\) \{ try \{ guideHost\.remove\(old\) \} catch \(e\) \{\}? \}\n\s+conns = conns\.filter\(\(x\) => x !== old\)\n\s+try \{ old\.close\(\) \} catch \(e\) \{\}\n\s+\}/)
  assert.match(mp, /if \(!again\) bumpStat\('joins'\)/)
  assert.match(mp, /let role = c\.peer \? peerRoles\.get\(c\.peer\) : null/)
  assert.match(mp, /peerRoles\.clear\(\)/)
  assert.match(mp, /遙控器重新連線 · 聲部「\{part\}」（\{n\} 人連線）/)
  for (const bad of ['tourCore', "tour.js'", 'useTourStore', 'touchGuide']) assert.equal(mp.includes(bad), false, bad)
  // 既有接線不變
  assert.match(mp, /if \(guideHost && guideHost\.handle\(c, m\)\) return; dispatch\(m, c\.peer\)/)
  assert.match(mp, /const drop = \(\) => \{ if \(guideHost\) \{ try \{ guideHost\.remove\(c\) \} catch \(e\) \{\} \} conns = conns\.filter\(\(x\) => x !== c\)/)
})

test('TourRemoteService：狀態酬載的倒數欄位來自 tourRunner（countdownExtra）；tour.js 的 createTourRunner 回傳 remainingMs（唯讀）', () => {
  const s = src('../services/TourRemoteService.jsx')
  assert.match(s, /import \{ createGuideHost, createGuideSync, countdownExtra \} from '\.\.\/lib\/tourRemote\.js'/)
  assert.match(s, /\.\.\.countdownExtra\(tourRunner\)/)
  const t = src('./tour.js')
  assert.match(t, /remainingMs: \(\) => \{\n\s+const r = run\n\s+if \(!r\) return null/)
  assert.match(t, /const spent = r\.paused \? r\.frozenMs : now\(\) - r\.at/)
  assert.doesNotMatch(t.slice(t.indexOf('remainingMs: () => {'), t.indexOf('remainingMs: () => {') + 500), /run\s*=|emit\(|st\(\)\.set/, '唯讀：不改任何狀態')
})

test('樣式：進度條 / 倒數 / 預告 / 喚醒標示；動效偏好「減少動態」時進度條不做過場；不動 styles.css', () => {
  const css = src('../styles/guide.css')
  for (const sel of ['.guide-wake', '.guide-wake.is-off', '.guide-time', '.guide-bar', '.guide-bar > i', '.guide-time.is-paused .guide-bar > i', '.guide-left', '.guide-next', '.guide-next-k', '.guide-next-note']) assert.ok(css.includes(sel + ' {') || css.includes(sel + ','), sel)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[^\n]*\.guide-bar > i \{ transition: none; \}/)
  assert.match(css, /\.guide-bar > i \{[^}]*transform-origin: left center/)
  assert.doesNotMatch(src('../styles.css'), /\.guide-(bar|time|next|wake)/)
})

test('英文字典：第 5 輪新增的 key 都有英文、單複數 / 插值正確', async () => {
  const mine = (await import('../i18n/en/guide.js')).default
  const keys = ['重新連線中…（第 {n} 次）', '連線中斷 · 回到這個畫面會自動重連', '主畫面已重新載入，請重新掃描 QR', '螢幕保持喚醒中', '此瀏覽器無法保持喚醒（請把手機的自動鎖定調長）', '剩 {n} 秒', '下一站：{name}', '最後一站', '遙控器重新連線 · 聲部「{part}」（{n} 人連線）']
  for (const k of keys) assert.ok(k in mine, k)
  assert.equal(mine['剩 {n} 秒']({ n: 3 }), '3 s left')
  assert.equal(translate('en', '剩 {n} 秒', { n: 12 }), '12 s left')
  assert.equal(translate('en', '下一站：{name}', { name: 'Moon' }), 'Up next: Moon')
  assert.equal(translate('zh', '下一站：{name}', { name: '月亮' }), '下一站：月亮')
  assert.equal(translate('en', '遙控器重新連線 · 聲部「{part}」（{n} 人連線）', { part: 'Ocean', n: 2 }), 'Remote reconnected · part "Ocean" (2 connected)')
})

// =============================================================================================
// React 執行期整合（沒有 DOM 的極簡 renderer：react-reconciler + 假樹）：真的掛載 <StrictMode><RemoteApp/>，跑完整的 effect 順序，
//   假 Peer / 假計時器 / 假 navigator.wakeLock——涵蓋 SSR 測不到的部分（effect 內的 sync、雙掛載、喚醒 lock、倒數計時器、重連、卸載清理）。
// =============================================================================================
const Reconciler = (await import('react-reconciler')).default
const { DefaultEventPriority } = await import('react-reconciler/constants.js')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeTreeRenderer() {
  const host = {
    supportsMutation: true, isPrimaryRenderer: true, supportsPersistence: false, supportsHydration: false, noTimeout: -1,
    now: () => Date.now(), scheduleTimeout: (fn, ms) => setTimeout(fn, ms), cancelTimeout: (id) => clearTimeout(id),
    getRootHostContext: () => ({}), getChildHostContext: (p) => p, prepareForCommit: () => null, resetAfterCommit() {},
    createInstance: (type, props) => ({ type, props, children: [], dataset: {}, querySelectorAll: () => [], querySelector: () => null }),
    createTextInstance: (text) => ({ type: '#text', text: String(text) }),
    appendInitialChild: (p, c) => { p.children.push(c) },
    appendChild: (p, c) => { p.children = p.children.filter((x) => x !== c); p.children.push(c) },
    appendChildToContainer: (p, c) => host.appendChild(p, c),
    insertBefore: (p, c, before) => { p.children = p.children.filter((x) => x !== c); const i = p.children.indexOf(before); p.children.splice(i < 0 ? p.children.length : i, 0, c) },
    insertInContainerBefore: (p, c, b) => host.insertBefore(p, c, b),
    removeChild: (p, c) => { p.children = p.children.filter((x) => x !== c) },
    removeChildFromContainer: (p, c) => host.removeChild(p, c),
    finalizeInitialChildren: () => false, prepareUpdate: () => true, commitUpdate: (inst, _u, _t, _o, next) => { inst.props = next },
    commitTextUpdate: (t, _o, n) => { t.text = String(n) }, shouldSetTextContent: () => false, resetTextContent() {},
    clearContainer: (c) => { c.children = [] }, getPublicInstance: (i) => i, preparePortalMount() {}, detachDeletedInstance() {},
    getCurrentEventPriority: () => DefaultEventPriority, getInstanceFromNode: () => null, beforeActiveInstanceBlur() {}, afterActiveInstanceBlur() {},
    prepareScopeUpdate() {}, getInstanceFromScope: () => null, hideInstance() {}, unhideInstance() {}, hideTextInstance() {}, unhideTextInstance() {},
  }
  const r = Reconciler(host)
  const container = { type: 'root', children: [] }
  const root = r.createContainer(container, 1, null, false, null, '', () => {}, null)
  const walk = (n, f) => { f(n); for (const c of n.children || []) walk(c, f) }
  return {
    container,
    render: (el) => r.updateContainer(el, root, null, null),
    text: () => { const out = []; walk(container, (n) => { if (n.type === '#text') out.push(n.text) }); return out.join('') },
    find: (pred) => { const out = []; walk(container, (n) => { if (n.type !== '#text' && n.type !== 'root' && pred(n)) out.push(n) }); return out },
  }
}

function fakeWakeLock() {
  const w = { requests: 0, sentinels: [], request(type) {
    if (this !== w) throw illegal()
    w.requests++
    assert.equal(type, 'screen')
    const L = new Set()
    const s = { released: false, releaseCalls: 0, addEventListener(ev, f) { if (this !== s) throw illegal(); L.add(f) }, removeEventListener(ev, f) { if (this !== s) throw illegal(); L.delete(f) },
      release() { if (this !== s) throw illegal(); s.releaseCalls++; if (s.released) throw new Error('already released'); s.released = true; for (const f of [...L]) f(); return Promise.resolve() } }
    w.sentinels.push(s)
    return Promise.resolve(s)
  } }
  return w
}

test('React 執行期（StrictMode 雙掛載）：只建一個 Peer / 一組訂閱；連上 → 導覽員區塊（倒數逐秒遞減、暫停凍結、下一站預告）；螢幕喚醒只在導覽員且已連線時持有', async () => {
  const net = mkNet()
  const wake = fakeWakeLock()
  Object.defineProperty(globalThis.navigator, 'wakeLock', { value: wake, configurable: true })
  const view = makeTreeRenderer()
  try {
    const b0 = ensurePeer('hostZ', TOKEN, net.deps)                        // 先用假網路建好連線單例（元件掛載時 ensurePeer 會沿用它）
    view.render(React.createElement(React.StrictMode, null, React.createElement(RemoteApp, { hostId: 'hostZ', guide: TOKEN })))
    await sleep(30)
    await net.flush()
    assert.equal(net.peers.length, 1, 'StrictMode 雙掛載：只有一個 Peer')
    assert.equal(b0.subs.size, 1, '雙掛載後只剩一個訂閱者')
    assert.equal(b0.teardown, null, '模擬卸載的拆除已被取消')
    assert.equal(net.listenerCount(), 3)
    assert.match(view.text(), /連線中…/)
    assert.equal(wake.requests, 0, '還沒連線 / 還不是導覽員：不要螢幕喚醒')
    // 連線
    net.peers[0].doOpen()
    const c1 = net.peers[0].last(); c1.doOpen()
    await sleep(30)
    assert.match(view.text(), /已連上主畫面 · 一起合奏/)
    assert.deepEqual(c1.sent, [helloMsg(TOKEN)])
    assert.equal(wake.requests, 0, '驗證通過前（還不是導覽員）不請求喚醒')
    // 導覽員通過 + 導覽進行中（帶倒數）
    c1.doData({ t: 'guide', ok: true })
    c1.doData({ t: 'tour', ...T1, index: 1, remainMs: 6000, stopMs: 16000, paused: false })
    await sleep(60)
    let txt = view.text()
    assert.match(txt, /導覽員/); assert.match(txt, /第 2 \/ 3 站/); assert.match(txt, /剩 6 秒/); assert.match(txt, /下一站：月亮/)
    assert.equal(wake.requests, 1, '導覽員且已連線：請求螢幕喚醒')
    assert.match(txt, /螢幕保持喚醒中/)
    assert.equal(wake.sentinels[0].released, false)
    // 倒數在兩次推送之間用本機時鐘內插
    await sleep(1250)
    txt = view.text()
    const secs = Number(txt.match(/剩 (\d+) 秒/)[1])
    assert.ok(secs <= 5 && secs >= 2, `過了約 1.3 秒（機器忙時更久）：剩 ${secs} 秒，一定比 6 少`)
    // 暫停：凍結
    c1.doData({ t: 'tour', ...T1, index: 1, remainMs: 6500, stopMs: 16000, paused: true })
    await sleep(40)
    assert.match(view.text(), /剩 7 秒/)
    await sleep(700)
    assert.match(view.text(), /剩 7 秒/, '暫停中：本機時間再走也不動')
    assert.match(view.text(), /已暫停/)
    // 連線中斷：狀態文字 + 按鈕停用 + 喚醒釋放；沒有重新整理鈕
    c1.doClose()
    await sleep(40)
    txt = view.text()
    assert.match(txt, /重新連線中…（第 1 次）/)
    assert.match(txt, /連線中斷 · 按鈕暫時無法使用/)
    const guideBtns = view.find((n) => n.type === 'button' && /guide-(btn|chip)/.test(n.props.className || ''))
    assert.ok(guideBtns.length >= 4)
    assert.ok(guideBtns.every((n) => n.props.disabled === true), '重連期間導覽員的按鈕全部停用')
    assert.ok(view.find((n) => n.type === 'button' && n.props.disabled !== true && /remote-retry/.test(n.props.className || '')).length === 0)
    assert.equal(view.find((n) => /remote-retry/.test(n.props.className || '')).length, 0, '自動重連期間不顯示「重新整理」鈕')
    assert.equal(wake.sentinels[0].released, true, '連線中止：釋放喚醒')
    assert.equal(wake.sentinels[0].releaseCalls, 1)
    assert.doesNotMatch(txt, /螢幕保持喚醒中/)
    // 1 秒後同一個 Peer 重連
    net.timers.advance(1000)
    const c2 = net.peers[0].last(); assert.notEqual(c2, c1)
    c2.doOpen()
    await sleep(40)
    assert.equal(net.peers.length, 1)
    assert.deepEqual(c2.sent, [helloMsg(TOKEN)], '重連後重送 hello')
    txt = view.text()
    assert.match(txt, /已連上主畫面 · 一起合奏/)
    assert.match(txt, /正在取得導覽狀態…/, '過時的狀態清掉，等主畫面的新狀態')
    assert.doesNotMatch(txt, /剩 \d+ 秒/)
    assert.equal(wake.requests, 2, '重連成功：重新取得喚醒')
    c2.doData({ t: 'guide', ok: true })
    c2.doData({ t: 'tour', ...T1, index: 0, remainMs: 15000, stopMs: 16000 })
    await sleep(40)
    txt = view.text()
    assert.match(txt, /剩 15 秒/); assert.match(txt, /下一站：潮汐/); assert.match(txt, /螢幕保持喚醒中/)
    // 卸載：拆除連線、釋放喚醒、清計時器
    view.render(null)
    await sleep(30)
    net.timers.advance(0)
    assert.equal(net.peers[0].destroyed, true)
    assert.equal(net.listenerCount(), 0)
    assert.equal(wake.sentinels[1].released, true, '卸載：釋放喚醒')
    assert.equal(net.timers.pending(), 0)
    await sleep(300)                                                        // 倒數計時器已清（卸載後不會再 setState）
  } finally {
    delete globalThis.navigator.wakeLock
    b0Cleanup()
  }
  function b0Cleanup() { try { const x = ensurePeer('hostZ', TOKEN, net.deps); x.destroy() } catch (e) { /* ignore */ } }
})

test('React 執行期：一般遙控（沒有 token）——連上後不送 hello、不請求喚醒；重連後照常；主畫面已重新載入 → 「主畫面已重新載入，請重新掃描 QR」與「重新整理」鈕', async () => {
  const net = mkNet()
  const wake = fakeWakeLock()
  Object.defineProperty(globalThis.navigator, 'wakeLock', { value: wake, configurable: true })
  const view = makeTreeRenderer()
  try {
    const bY = ensurePeer('hostY', null, net.deps)
    view.render(React.createElement(React.StrictMode, null, React.createElement(RemoteApp, { hostId: 'hostY' })))
    await sleep(30); await net.flush()
    net.peers[0].doOpen()
    const c1 = net.peers[0].last(); c1.doOpen()
    await sleep(30)
    assert.match(view.text(), /已連上主畫面 · 一起合奏/)
    assert.deepEqual(c1.sent, [], '一般遙控不送 hello')
    assert.equal(wake.requests, 0, '一般遙控不啟用螢幕喚醒（省電）')
    const pads = view.find((n) => n.type === 'button' && /^水母$/.test(n.children.map((c) => c.text || '').join('')))
    assert.equal(pads.length, 1); assert.notEqual(pads[0].props.disabled, true, '連線中：打擊墊可按')
    c1.doClose()
    await sleep(30)
    assert.match(view.text(), /重新連線中…（第 1 次）/)
    assert.equal(view.find((n) => n.type === 'button' && n.children.some((c) => c.text === '水母'))[0].props.disabled, true, '重連期間：打擊墊停用')
    net.timers.advance(1000)
    const c2 = net.peers[0].last(); c2.doOpen()
    await sleep(30)
    assert.deepEqual(c2.sent, [])
    assert.notEqual(view.find((n) => n.type === 'button' && n.children.some((c) => c.text === '水母'))[0].props.disabled, true, '重連後打擊墊恢復')
    // 主畫面重新載入：host id 不存在
    c2.doClose()
    for (let i = 1; i <= 6; i++) {
      net.timers.advance(backoffMs(bY.link.state().n))                       // 等到下一次重試
      net.peers[0].doUnavailable()                                           // 主畫面的 host id 已不存在
    }
    await sleep(30)
    assert.match(view.text(), /主畫面已重新載入，請重新掃描 QR/)
    assert.equal(view.find((n) => /remote-retry/.test(n.props.className || '')).length, 1, '放棄後才出現「重新整理」鈕')
    view.render(null)
    await sleep(30)
    net.timers.advance(0)
  } finally {
    delete globalThis.navigator.wakeLock
    try { ensurePeer('hostY', null, net.deps).destroy() } catch (e) { /* ignore */ }
  }
})

// ---- 主畫面正在錄製 / 播放（busy）：導覽開不起來，手機上的「開始導覽」要停用並說明（不能看起來能按、按了卻沒有任何回應）----
test('tourPayload / parseTourPayload：busy 只收 boolean、往返一致；沒帶（舊版主畫面）就沒有這個欄位', () => {
  const p = tourPayload({ running: false }, { ready: true, busy: true, evil: 1 })
  assert.equal(p.busy, true); assert.equal('evil' in p, false)
  assert.equal(tourPayload({ running: false }, { busy: false }).busy, false)
  for (const bad of ['yes', 1, 0, null, undefined, {}, []]) assert.equal('busy' in tourPayload({ running: false }, { busy: bad }), false, JSON.stringify(bad))
  const wire = JSON.parse(JSON.stringify(tourPayload({ running: false, paused: false, index: 0, total: 0, stopList: [] }, { speak: false, canSpeak: true, ready: true, busy: true })))
  assert.equal(parseTourPayload(wire).busy, true)
  assert.equal(parseTourPayload({ ...wire, busy: 'true' }).busy, undefined, '格式不對的 busy 被丟掉、不因此拒絕整則狀態')
  assert.equal('busy' in parseTourPayload({ ...wire, busy: undefined }), false)
  assert.equal(parseTourPayload({ ...wire, busy: false }).busy, false)
})

test('guideView：主畫面 busy（錄製 / 播放中）→ 沒在跑時「開始導覽」不能按、busy:true；沒帶 / false → 照舊可以；導覽進行中忽略 busy；noData 優先仍不可按', () => {
  const b = guideView({ ...T0, busy: true }, true)
  assert.deepEqual([b.busy, b.canStart, b.noData, b.running], [true, false, false, false])
  assert.deepEqual([guideView({ ...T0, busy: false }, true).busy, guideView({ ...T0, busy: false }, true).canStart], [false, true])
  assert.deepEqual([guideView(T0, true).busy, guideView(T0, true).canStart], [false, true], '舊版主畫面沒有 busy 欄位 → 當作沒有在忙')
  const run = guideView({ ...T1, busy: true }, true)
  assert.deepEqual([run.busy, run.running, run.canStart, run.canStop, run.canNav], [false, true, false, true, true], '導覽進行中：busy 不適用，停止 / 導覽鈕照舊')
  const both = guideView({ ...T0, ready: false, busy: true }, true)
  assert.deepEqual([both.noData, both.busy, both.canStart], [true, true, false])
  assert.equal(guideView({ ...T0, busy: true }, false).canStart, false, '沒連線一樣不能按')
  assert.equal(guideView(null, true).busy, false)
})

test('SSR·導覽員區塊：主畫面 busy → 顯示「等錄製 / 播放結束後才能導覽」、「開始導覽」停用；英文有對應字串；noData 的提示優先；導覽進行中不顯示', () => {
  const html = panel({ ...T0, busy: true })
  assert.match(html, /<p class="guide-msg">等錄製 \/ 播放結束後才能導覽<\/p>/)
  assert.match(html, /guide-run start"[^>]*disabled/)
  assert.doesNotMatch(html, /導覽還沒開始/)
  assert.match(panel({ ...T0, busy: true }, { t: tEn }), /Available once recording \/ playback has finished/)
  assert.doesNotMatch(panel({ ...T0, busy: true }, { t: tEn }), /[\u4e00-\u9fff]/, '英文版沒有中文')
  assert.match(panel({ ...T0, ready: false, busy: true }), /主畫面還沒載入海況資料/); assert.doesNotMatch(panel({ ...T0, ready: false, busy: true }), /等錄製/)
  assert.doesNotMatch(panel({ ...T1, busy: true }), /等錄製/); assert.match(panel({ ...T1, busy: true }), /結束導覽/)
  assert.doesNotMatch(panel(T0), /等錄製/); assert.doesNotMatch(panel({ ...T0, busy: false }), /等錄製/)
  assert.doesNotMatch(panel({ ...T0, busy: true }, { ok: false }), /等錄製/, '連線中斷的提示優先')
})

test('TourRemoteService：guideExtra 帶 busy（rec.mode !== idle；取不到就當沒有在忙）；每 2 秒的補推會把它送到手機', () => {
  const s = src('../services/TourRemoteService.jsx')
  assert.match(s, /try \{ busy = useStore\.getState\(\)\.rec\.mode !== 'idle' \} catch \(e\)/)
  assert.match(s, /return \{ speak: [^}]*ready, busy, \.\.\.countdownExtra\(tourRunner\) \}/)
  assert.match(src('../remote/RemoteApp.jsx'), /: v\.busy \? <p className="guide-msg">\{t\('等錄製 \/ 播放結束後才能導覽'\)\}<\/p>/)
})
