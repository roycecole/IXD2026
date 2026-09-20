// service worker（public/sw.js）的回歸測試。執行：node --test scripts/sw.test.mjs
// 用 node:vm 載入真實的 sw.js，搭配假的 caches / fetch / self（網路可以開關），驗證各種請求的攔截與離線退路。
//
// 回歸的問題：舊的 SW 對所有 .json 都是 network-first + 離線退回快取，包括 /version.json。
//   線上時頁面（build X）讀到 version.json = Y，SW 把 Y 存進快取；重載那一刻網路斷了，導航請求退回快取的舊 HTML（build X）。
//   之後每個檢查週期（5–10 分鐘）離線的 fetch(/version.json) 都被 SW 用快取的 Y 回應 → 判定「有新版」→ 重載 → 又落回舊 HTML → 整個離線期間反覆重載。
//   修法：/version.json 不經過 SW（不攔截、不快取），離線就失敗，頁面把它當「檢查失敗」。
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import * as R from '../src/lib/resilience.js'

const SW_SRC = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
const ORIGIN = 'https://midisea.example'

const okRes = (body, extra = {}) => { const r = { ok: true, body, clone: () => okRes(body, extra), ...extra, json: async () => JSON.parse(body) }; return r }

// 載入 sw.js：回傳 { handlers, net（網路開關 / 回應表）, cache（快取內容）, respond(event) }
function loadSw(src = SW_SRC) {
  const handlers = {}
  const net = { online: true, table: new Map(), requests: [] }
  const store = new Map()   // url → response（單一快取，足以驗證這支 SW）
  const cacheApi = {
    async match(req, opts) {
      const u = new URL(typeof req === 'string' ? req : req.url)
      for (const [k, v] of store) {
        const ku = new URL(k)
        if (k === (typeof req === 'string' ? req : req.url) || (opts && opts.ignoreSearch && ku.pathname === u.pathname)) return v
      }
      return undefined
    },
    async put(req, res) { store.set(typeof req === 'string' ? req : req.url, res) },
  }
  const caches = { async open() { return cacheApi }, match: (req, opts) => cacheApi.match(req, opts), async keys() { return [] }, async delete() { return true } }
  const self = { location: { origin: ORIGIN }, skipWaiting() {}, clients: { claim: async () => {} }, addEventListener(type, fn) { handlers[type] = fn } }
  const fetch = async (req) => {
    const url = typeof req === 'string' ? req : req.url
    net.requests.push(url)
    if (!net.online) throw new TypeError('Failed to fetch')
    const r = net.table.get(url)
    if (!r) return { ok: false, status: 404, clone() { return this } }
    return r
  }
  const ctx = vm.createContext({ self, caches, fetch, URL, Promise, console })
  vm.runInContext(src, ctx)
  const req = (path, over = {}) => ({ method: 'GET', url: ORIGIN + path, mode: 'cors', ...over })
  // 模擬瀏覽器分派 fetch 事件：回傳 { intercepted, response（被攔截時是 respondWith 的 Promise） }
  const dispatch = (request) => {
    let responded = null
    handlers.fetch({ request, respondWith(p) { responded = p } })
    return { intercepted: responded !== null, response: responded }
  }
  // 頁面的 fetch(url)：SW 有攔截就用它的回應，沒攔截就走原生網路（離線時失敗）
  const pageFetch = async (path, over = {}) => {
    const d = dispatch(req(path, over))
    return d.intercepted ? d.response : fetch(req(path, over))
  }
  return { handlers, net, store, dispatch, pageFetch, req }
}

test('/version.json：不攔截（不呼叫 respondWith）、不寫進快取——線上與離線都一樣；子路徑部署（/sub/version.json）也一樣', async () => {
  const sw = loadSw()
  sw.net.table.set(ORIGIN + '/version.json', okRes('{"id":"Y"}'))
  const on = sw.dispatch(sw.req('/version.json'))
  assert.equal(on.intercepted, false, '線上：交給瀏覽器')
  await sw.pageFetch('/version.json')
  assert.equal([...sw.store.keys()].some((k) => k.endsWith('version.json')), false, '不快取版本檔')
  sw.store.set(ORIGIN + '/version.json', okRes('{"id":"STALE"}'))   // 舊版 SW 遺留在快取裡的版本檔
  sw.net.online = false
  assert.equal(sw.dispatch(sw.req('/version.json')).intercepted, false, '離線也不攔截：不會用遺留的快取回應')
  await assert.rejects(sw.pageFetch('/version.json'), /Failed to fetch/, '離線 → 頁面的 fetch 失敗（= 檢查失敗，不是「有新版」）')
  assert.equal(sw.dispatch(sw.req('/sub/version.json?x=1')).intercepted, false, '子路徑 + query')
  assert.equal(sw.dispatch(sw.req('/version.json', { mode: 'navigate' })).intercepted, false)
})

test('其他 JSON（/data/ocean.json）與 HTML 導覽仍是 network-first + 離線退回快取（離線的展場還能開、還有資料）', async () => {
  const sw = loadSw()
  sw.net.table.set(ORIGIN + '/data/ocean.json', okRes('{"fetchedAt":"2026-09-20T09:00"}'))
  sw.net.table.set(ORIGIN + '/', okRes('<html>v1</html>'))
  const a = sw.dispatch(sw.req('/data/ocean.json')); assert.equal(a.intercepted, true)
  assert.equal((await a.response).body, '{"fetchedAt":"2026-09-20T09:00"}', '線上：拿網路的')
  const b = sw.dispatch(sw.req('/', { mode: 'navigate' })); assert.equal(b.intercepted, true); await b.response
  await new Promise((r) => setImmediate(r))   // 快取寫入是 fire-and-forget
  sw.net.online = false
  const off = sw.dispatch(sw.req('/data/ocean.json'))
  assert.equal(off.intercepted, true); assert.equal((await off.response).body, '{"fetchedAt":"2026-09-20T09:00"}', '離線：退回快取的資料')
  const nav = sw.dispatch(sw.req('/?audience=1', { mode: 'navigate' }))
  assert.equal(nav.intercepted, true); assert.equal((await nav.response).body, '<html>v1</html>', '離線：/?audience=1 退回同一個 HTML（ignoreSearch）')
})

test('不動到的行為：非 GET / 跨來源請求不攔截；靜態資產走 stale-while-revalidate', async () => {
  const sw = loadSw()
  assert.equal(sw.dispatch(sw.req('/data/ocean.json', { method: 'POST' })).intercepted, false)
  assert.equal(sw.dispatch({ method: 'GET', url: 'https://other.example/data/ocean.json' }).intercepted, false)
  sw.net.table.set(ORIGIN + '/assets/index-abc.js', okRes('js1'))
  const first = sw.dispatch(sw.req('/assets/index-abc.js')); assert.equal(first.intercepted, true); assert.equal((await first.response).body, 'js1')
  await new Promise((r) => setImmediate(r))
  sw.net.online = false
  const off = sw.dispatch(sw.req('/assets/index-abc.js')); assert.equal((await off.response).body, 'js1', '離線：靜態資產用快取')
})

// ---- 端到端：SW + 版本檢查器（真實的 createVersionChecker）----
function pageChecker(sw, { buildId = 'X' } = {}) {
  const reloads = []
  const status = R.createStatusStore(R.initialStatus())
  const env = { baseUrl: '/', now: () => Date.now(), doc: null, setInterval: () => 1, clearInterval() {}, fetch: (url, init) => sw.pageFetch(url.startsWith('/') ? url : '/' + url, init) }
  const cfg = R.resolveConfig({ search: '', buildId })
  const vc = R.createVersionChecker({ env, status, cfg, reloader: { soft: (why) => { reloads.push(why); return true } }, getIdle: () => ({ idle: true, reason: '' }) })
  return { vc, status, reloads }
}

test('端到端（回歸）：線上看到新版 Y、重載時網路斷了（落回舊頁面 X）→ 之後每個檢查週期都是「檢查失敗」，不會反覆重載', async () => {
  const sw = loadSw()
  sw.net.table.set(ORIGIN + '/version.json', okRes('{"id":"Y"}'))
  const online = pageChecker(sw)
  await online.vc.check(); await new Promise((r) => setImmediate(r))
  assert.equal(online.status.get().version.state, 'new'); assert.equal(online.reloads.length, 1, '線上：有新版 → 重載（一次）')
  sw.net.online = false                                                             // 重載的瞬間斷網，落回快取的舊 HTML（build X）
  let total = 0
  for (let round = 1; round <= 4; round++) {
    const page = pageChecker(sw)                                                    // 重載後的新頁面（仍是 build X）
    await page.vc.check(); await new Promise((r) => setImmediate(r))
    assert.equal(page.status.get().version.state, 'error', `第 ${round} 輪：離線 = 檢查失敗`)
    total += page.reloads.length
  }
  assert.equal(total, 0, '離線整段期間不重載')
})

test('對照組（確認這個測試環境抓得到舊問題）：把「不攔截版本檔」那一行拿掉，同樣情境會每個週期都重載', async () => {
  const broken = SW_SRC.replace(/\n\s*if \(url\.pathname\.endsWith\('\/version\.json'\)\) return/, '')
  assert.notEqual(broken, SW_SRC, '成功拿掉那一行')
  const sw = loadSw(broken)
  sw.net.table.set(ORIGIN + '/version.json', okRes('{"id":"Y"}'))
  const online = pageChecker(sw)
  await online.vc.check(); await new Promise((r) => setImmediate(r))
  assert.equal(online.reloads.length, 1)
  sw.net.online = false
  let total = 0
  for (let round = 1; round <= 4; round++) {
    const page = pageChecker(sw)
    await page.vc.check(); await new Promise((r) => setImmediate(r))
    total += page.reloads.length
  }
  assert.equal(total, 4, '舊行為：離線時讀到快取的 Y，每輪都重載')
})

test('SW 版本快取名稱沒有動（升版會在 activate 時刪掉舊快取，離線的展場機會失去已快取的 HTML 與資產）', () => {
  assert.match(SW_SRC, /const CACHE = 'midisea-v7'/)
})
