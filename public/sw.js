// 簡易 runtime cache：同源 GET 快取優先、背景更新（PWA 離線可開）
const CACHE = 'midisea-v1'
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (e) => {
  const { request } = e
  if (request.method !== 'GET' || !request.url.startsWith(self.location.origin)) return
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
