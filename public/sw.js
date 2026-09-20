// PWA service worker
// - HTML 導覽 + JSON 資料：network-first（部署後立即拿到新版，離線才用快取）→ 避免舊版白屏（例外：/version.json 不經過 SW，見下）
// - 帶 hash 的靜態資產：stale-while-revalidate（秒開 + 背景更新）
const CACHE = 'midisea-v7'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (e) => e.waitUntil((async () => {
  const keys = await caches.keys()
  await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))) // 清舊快取
  await self.clients.claim()
})()))

self.addEventListener('fetch', (e) => {
  const { request } = e
  if (request.method !== 'GET' || !request.url.startsWith(self.location.origin)) return
  const url = new URL(request.url)
  // 版本檔（/version.json）不攔截、不快取：頁面每 5–10 分鐘用它比對「線上是不是有新版」（見 src/lib/resilience.js）。
  // 離線時若退回快取，會讀到「上次連線時看到的較新 id」→ 每個檢查週期都判定有新版而重載，重載後又落回快取的舊 HTML，永遠對不上（整個離線期間反覆重載）。
  // 交給瀏覽器原生 fetch：離線就失敗，頁面把它當「檢查失敗」略過（維持現狀）。
  if (url.pathname.endsWith('/version.json')) return
  const isDoc = request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')
  const isData = url.pathname.endsWith('.json')

  if (isDoc || isData) {
    e.respondWith(
      fetch(request)
        .then((res) => { const c = res.clone(); caches.open(CACHE).then((ca) => ca.put(request, c)); return res })
        .catch(() => caches.match(request, isDoc ? { ignoreSearch: true } : undefined))   // 離線時 /?audience=1、分享連結（?s=…）也退回已快取的頁面（同一個 HTML）
    )
    return
  }

  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(request)
      const net = fetch(request)
        .then((res) => { if (res && res.ok) cache.put(request, res.clone()); return res })
        .catch(() => hit)
      return hit || net
    })
  )
})
