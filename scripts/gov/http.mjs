// 共用 HTTP 讀取（Node 18+ 內建 fetch）。錯誤訊息中的金鑰會遮蔽，避免進 CI log。
export async function getJson(url, ms = 90000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) })
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${url.replace(/Authorization=[^&]+/, 'Authorization=***')}`), { status: res.status })
  return res.json()
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 重試：政府 API 偶爾回空內容 / 截斷的 JSON / 5xx / 逾時。
// （實測水利署 opendata：「並行」請求時約 1/4 會回錯置的資料集內容、空白或截斷；依序請求則正常 —— 呼叫端請依序抓，重試只是第二道防線。）
// 4xx（金鑰錯誤、找不到）不重試，直接交給呼叫端換備援。等待時間逐次加長：delayMs、2×delayMs…
export async function retry(fn, { attempts = 3, delayMs = 5000, label = '', log = console.error } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (e) {
      const clientError = e && e.status >= 400 && e.status < 500
      if (i >= attempts || clientError) throw e
      log(`${label ? label + ': ' : ''}attempt ${i}/${attempts} failed (${e.message}); retrying in ${(delayMs * i) / 1000}s`)
      await sleep(delayMs * i)
    }
  }
}
