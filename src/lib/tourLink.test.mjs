// 每站連結（lib/tourLink.js）的單元測試。執行：node --test src/lib/tourLink.test.mjs
// 涵蓋：parseTourLink 全部分支（序號 / 站 id / 大小寫 / 非法值 / hold）、buildTourLink（去掉一次性旗標與 hash 與帳密、只帶 tourstop / tourhold / lang、壞輸入）、
// hasTourLink、copyText（Clipboard API → 退回 textarea + execCommand → 都失敗；用「會檢查 this 的假環境」——脫離原物件呼叫會丟 Illegal invocation）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTourLink, buildTourLink, hasTourLink, copyText, TOUR_STOP_IDS } from './tourLink.js'
import { makeCopyEnv } from './tourTestEnv.mjs'

// =============================================================================================
// parseTourLink
// =============================================================================================
test('站 id 白名單：8 站、順序固定（reservoir → tide → moon → dust → air → birds → fish → stations）', () => {
  assert.deepEqual(TOUR_STOP_IDS, ['reservoir', 'tide', 'moon', 'dust', 'air', 'birds', 'fish', 'stations'])
})

test('parseTourLink：?tourstop=<站 id> → { stop: { id }, hold: false }；每個白名單 id 都認得', () => {
  for (const id of TOUR_STOP_IDS) assert.deepEqual(parseTourLink('?tourstop=' + id), { stop: { id }, hold: false }, id)
  assert.deepEqual(parseTourLink('tourstop=air'), { stop: { id: 'air' }, hold: false }, '沒有前導 ? 也行')
  assert.deepEqual(parseTourLink('?x=1&tourstop=fish&y=2'), { stop: { id: 'fish' }, hold: false }, '夾在其他參數之間')
})

test('parseTourLink：?tourstop=<n>（1 起算）→ stop.index 是 0 起算（n − 1）；1..8 以外都是 null', () => {
  assert.deepEqual(parseTourLink('?tourstop=1'), { stop: { index: 0 }, hold: false })
  assert.deepEqual(parseTourLink('?tourstop=5'), { stop: { index: 4 }, hold: false })
  assert.deepEqual(parseTourLink('?tourstop=8'), { stop: { index: 7 }, hold: false })
  assert.deepEqual(parseTourLink('?tourstop=03'), { stop: { index: 2 }, hold: false }, '前導 0 也算數字')
  assert.deepEqual(parseTourLink('?tourstop=%205%20'), { stop: { index: 4 }, hold: false }, '前後空白會被修剪')
  for (const bad of ['0', '9', '10', '-1', '2.5', '1e1', '3abc', '99999999999999999999', '+2']) assert.equal(parseTourLink('?tourstop=' + encodeURIComponent(bad)), null, bad)
})

test('parseTourLink：站 id 大小寫不拘、前後空白修剪；不在白名單的字串 / 空值 / 缺少參數 → null', () => {
  assert.deepEqual(parseTourLink('?tourstop=AIR'), { stop: { id: 'air' }, hold: false })
  assert.deepEqual(parseTourLink('?tourstop=%20Tide'), { stop: { id: 'tide' }, hold: false })
  for (const bad of ['', 'nope', 'reservoirs', 'air,fish', 'constructor', '__proto__', 'toString', 'a b', 'stationsX']) assert.equal(parseTourLink('?tourstop=' + encodeURIComponent(bad)), null, JSON.stringify(bad))
  assert.equal(parseTourLink('?tourstop'), null)
  assert.equal(parseTourLink('?tourhold=1'), null, '只有 hold、沒有站 → 不算導覽連結')
  assert.equal(parseTourLink('?kiosk=1&tour=1'), null)
  assert.equal(parseTourLink(''), null)
})

test('parseTourLink：重複的 tourstop 取第一個；壞輸入（undefined / null / 數字 / 物件）→ null 不丟錯', () => {
  assert.deepEqual(parseTourLink('?tourstop=air&tourstop=fish'), { stop: { id: 'air' }, hold: false })
  for (const bad of [undefined, null, 5, {}, [], () => {}]) { let r; assert.doesNotThrow(() => { r = parseTourLink(bad) }); assert.equal(r, null) }
})

test('parseTourLink：?tourhold=1 → hold: true；0 / false / off / no → false；沒寫 → false；只在有站時才有意義', () => {
  assert.deepEqual(parseTourLink('?tourstop=air&tourhold=1'), { stop: { id: 'air' }, hold: true })
  assert.deepEqual(parseTourLink('?tourstop=3&tourhold=1'), { stop: { index: 2 }, hold: true })
  assert.deepEqual(parseTourLink('?tourhold=1&tourstop=moon'), { stop: { id: 'moon' }, hold: true }, '參數順序不拘')
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) assert.equal(parseTourLink('?tourstop=air&tourhold=' + v).hold, false, v)
  assert.equal(parseTourLink('?tourstop=air').hold, false)
  assert.equal(parseTourLink('?tourstop=air&tourhold').hold, true, '沿用 flagOn：只寫旗標名 = 開')
})

test('hasTourLink：等同 parseTourLink !== null（給新手導覽判斷「這是導覽員的連結」）', () => {
  assert.equal(hasTourLink('?tourstop=air'), true)
  assert.equal(hasTourLink('?tourstop=1&tourhold=1'), true)
  assert.equal(hasTourLink('?tourstop=zzz'), false)
  assert.equal(hasTourLink('?tourhold=1'), false)
  assert.equal(hasTourLink(''), false)
  assert.equal(hasTourLink(undefined), false)
  assert.equal(hasTourLink(null), false)
})

// =============================================================================================
// buildTourLink
// =============================================================================================
test('buildTourLink：保留 origin 與路徑，只帶 tourstop（以站 id）；選帶 tourhold；英文才帶 lang=en', () => {
  assert.equal(buildTourLink({ href: 'https://midisea.shyetech.com/', stopId: 'air' }), 'https://midisea.shyetech.com/?tourstop=air')
  assert.equal(buildTourLink({ href: 'https://midisea.shyetech.com/', stopId: 'air', hold: true }), 'https://midisea.shyetech.com/?tourstop=air&tourhold=1')
  assert.equal(buildTourLink({ href: 'https://midisea.shyetech.com/', stopId: 'fish', locale: 'en' }), 'https://midisea.shyetech.com/?tourstop=fish&lang=en')
  assert.equal(buildTourLink({ href: 'https://midisea.shyetech.com/', stopId: 'fish', hold: true, locale: 'en' }), 'https://midisea.shyetech.com/?tourstop=fish&tourhold=1&lang=en')
  assert.equal(buildTourLink({ href: 'https://midisea.shyetech.com/', stopId: 'fish', locale: 'zh' }), 'https://midisea.shyetech.com/?tourstop=fish', '中文不帶 lang')
  assert.equal(buildTourLink({ href: 'https://midisea.shyetech.com/', stopId: 'fish', locale: 'xx' }), 'https://midisea.shyetech.com/?tourstop=fish', '未知語系不帶 lang')
  assert.equal(buildTourLink({ href: 'https://example.com/app/midisea/index.html', stopId: 'tide' }), 'https://example.com/app/midisea/index.html?tourstop=tide', '路徑保留')
  assert.equal(buildTourLink({ href: 'http://localhost:5173/', stopId: 'moon' }), 'http://localhost:5173/?tourstop=moon', 'origin 含 port')
  assert.equal(buildTourLink({ href: 'https://midisea.shyetech.com/', stopId: 'AIR ' }), 'https://midisea.shyetech.com/?tourstop=air', 'stopId 修剪 + 小寫')
})

test('buildTourLink：去掉舊的 tourstop / tourhold / audience / diagnostics / kiosk、其他一次性旗標與 hash（#remote=…）；絕不帶帳密與分享參數', () => {
  const dirty = 'https://user:secret@midisea.shyetech.com/x/?tourstop=1&tourhold=1&audience=1&diagnostics=1&kiosk=1&tour=0&speak=1&log=1&s=abc&o=feitsui&m=3&sl=1&lang=zh&token=SEKRET#remote=peer-123&x=1'
  const out = buildTourLink({ href: dirty, stopId: 'birds', locale: 'en' })
  assert.equal(out, 'https://midisea.shyetech.com/x/?tourstop=birds&lang=en')
  for (const leak of ['secret', 'user', 'SEKRET', 'token', 'audience', 'diagnostics', 'kiosk', 'remote', 'peer-123', 'feitsui', 's=abc', '#']) assert.ok(!out.includes(leak), `不該帶 ${leak}：${out}`)
  const again = buildTourLink({ href: out, stopId: 'stations' })
  assert.equal(again, 'https://midisea.shyetech.com/x/?tourstop=stations', '舊連結再生成新連結：不累加參數（lang 也沒有了：新語系是 zh）')
  // 舊連結的 hold 不會被沿用（由參數決定）
  assert.equal(buildTourLink({ href: 'https://a.test/?tourhold=1&tourstop=air', stopId: 'air' }), 'https://a.test/?tourstop=air')
})

test('buildTourLink：產生的連結能被 parseTourLink 原樣讀回（往返）', () => {
  for (const id of TOUR_STOP_IDS) for (const hold of [false, true]) for (const locale of ['zh', 'en']) {
    const url = buildTourLink({ href: 'https://midisea.shyetech.com/?kiosk=1#remote=x', stopId: id, hold, locale })
    assert.deepEqual(parseTourLink(new URL(url).search), { stop: { id }, hold }, url)
    assert.equal(new URL(url).search.includes('lang=en'), locale === 'en')
  }
})

test('buildTourLink：站 id 不在白名單 / 沒給 → \'\'；href 不是合法網址 → \'\'；file: 之類不合 origin 的網址不丟錯', () => {
  for (const stopId of [undefined, null, '', 'nope', 'constructor', 3, {}]) assert.equal(buildTourLink({ href: 'https://a.test/', stopId }), '', String(stopId))
  for (const href of [undefined, null, '', 'not a url', '/relative/path', 'http://']) assert.equal(buildTourLink({ href, stopId: 'air' }), '', String(href))
  assert.equal(buildTourLink(), '')
  assert.equal(buildTourLink({}), '')
  assert.equal(buildTourLink({ href: 'file:///Users/x/midisea/index.html?kiosk=1', stopId: 'air' }), 'file:///Users/x/midisea/index.html?tourstop=air')
})

// =============================================================================================
// copyText（會檢查 this 的假 navigator / document）
// =============================================================================================
test('copyText：Clipboard API 成功 → true，不碰 textarea / execCommand', async () => {
  const env = makeCopyEnv({ clipboard: 'ok' })
  assert.equal(await copyText('https://a.test/?tourstop=air', env), true)
  assert.equal(env.state.copied, 'https://a.test/?tourstop=air')
  assert.deepEqual(env.calls.map((c) => c[0]), ['clipboard.writeText'])
})

test('copyText：Clipboard API 被拒（reject）→ 退回隱藏 textarea + execCommand(\'copy\')，用完移除 textarea 並還原焦點', async () => {
  const env = makeCopyEnv({ clipboard: 'reject', exec: 'ok' })
  assert.equal(await copyText('LINK', env), true)
  assert.equal(env.state.copied, 'LINK')
  assert.deepEqual(env.calls.map((c) => c[0]), ['clipboard.writeText', 'append', 'textarea.focus', 'execCommand', 'remove'])
  assert.equal(env.body.children.length, 0, 'textarea 已移除（不留垃圾 DOM）')
  assert.deepEqual(env.state.focusLog, ['restore-focus'])
})

test('copyText：Clipboard API 同步丟例外 / 不存在（非安全環境）→ 同樣退回 execCommand', async () => {
  for (const clipboard of ['throw', 'none']) {
    const env = makeCopyEnv({ clipboard, exec: 'ok' })
    assert.equal(await copyText('LINK', env), true, clipboard)
    assert.equal(env.state.copied, 'LINK', clipboard)
    assert.ok(env.calls.some((c) => c[0] === 'execCommand'), clipboard)
  }
})

test('copyText：退回寫法用的 textarea 是隱藏的、唯讀、不可聚焦到 tab 順序（不影響版面與鍵盤）', async () => {
  const env = makeCopyEnv({ clipboard: 'none', exec: 'ok' })
  let seen = null
  const orig = env.body.appendChild
  env.body.appendChild = function (el) { seen = el; return orig.call(this, el) }
  await copyText('LINK', env)
  assert.ok(seen)
  assert.match(seen.style.cssText, /position:fixed/); assert.match(seen.style.cssText, /opacity:0/); assert.match(seen.style.cssText, /left:-9999px/)
  assert.equal(seen.attrs.readonly, ''); assert.equal(seen.tabIndex, -1); assert.deepEqual(seen.range, [0, 4])
})

test('copyText：兩種都失敗（被拒 + execCommand 回 false / 丟例外 / 不存在）→ false；textarea 一律清掉；不丟例外', async () => {
  for (const exec of ['false', 'throw', 'none']) {
    const env = makeCopyEnv({ clipboard: 'reject', exec })
    assert.equal(await copyText('LINK', env), false, exec)
    assert.equal(env.body.children.length, 0, exec)
  }
  assert.equal(await copyText('LINK', { navigator: null, document: null }), false)
  assert.equal(await copyText('LINK', { navigator: {}, document: {} }), false, 'document 沒有 body / createElement')
  assert.equal(await copyText('', makeCopyEnv()), false, '空字串不複製')
  assert.equal(await copyText(undefined, makeCopyEnv()), false)
})

test('copyText：不傳 env → 在呼叫當下才讀全域（Node 沒有 navigator.clipboard / document → false，不丟錯）', async () => {
  const hadNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const fakeNav = { clipboard: undefined }
  Object.defineProperty(globalThis, 'navigator', { value: fakeNav, configurable: true, writable: true })
  try { assert.equal(await copyText('LINK'), false) } finally { if (hadNav) Object.defineProperty(globalThis, 'navigator', hadNav); else delete globalThis.navigator }
})

test('假環境自身的檢查是有效的：脫離原物件呼叫 writeText / execCommand 會丟 Illegal invocation（對照組，確保上面的測試真的能抓到這類 bug）', () => {
  const env = makeCopyEnv()
  const { writeText } = env.navigator.clipboard
  assert.throws(() => writeText('x'), /Illegal invocation/)
  const { execCommand } = env.document
  assert.throws(() => execCommand('copy'), /Illegal invocation/)
  const { createElement } = env.document
  assert.throws(() => createElement('textarea'), /Illegal invocation/)
})
