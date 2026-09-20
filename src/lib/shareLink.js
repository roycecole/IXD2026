// 複製文字到剪貼簿，失敗時退回「讓使用者手動複製」（純函式，環境可注入；Node 可測）。
// 手機上的內嵌瀏覽器（LINE / IG / FB）或非安全來源（http 區網網址）常常沒有 navigator.clipboard，或 writeText 被擋；
// 手機沒有主控台，光是 console.log 網址等於拿不到連結。window.prompt 會跳出一個可選取、可長按複製的輸入框，在這些環境也能用。
//   回傳：'copied' 已複製 · 'manual' 已跳出輸入框（使用者自己複製）· 'failed' 兩條路都不行
export async function copyText(text, env = {}) {
  const clipboard = env.clipboard !== undefined ? env.clipboard : (typeof navigator !== 'undefined' ? navigator.clipboard : null)
  const prompt = env.prompt !== undefined ? env.prompt : (typeof window !== 'undefined' && typeof window.prompt === 'function' ? (m, v) => window.prompt(m, v) : null)   // 包一層：保持 window 當 this（原生函式拆開呼叫會 Illegal invocation）
  try {
    if (clipboard && typeof clipboard.writeText === 'function') { await clipboard.writeText(text); return 'copied' }
  } catch (e) { /* 被擋 / 沒有權限 → 走下面的手動複製 */ }
  if (typeof prompt === 'function') {
    try { prompt(env.promptLabel || '', text); return 'manual' } catch (e) { /* 連 prompt 都被擋 */ }
  }
  return 'failed'
}
