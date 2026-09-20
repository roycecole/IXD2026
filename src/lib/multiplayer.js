// 手機掃 QR 當遙控器（多人合奏）：主畫面當 host（PeerJS WebRTC DataChannel），
// 手機開 #remote=<id> 頁連進來，訊息一律走 store.input()/handleNote() —— 與 MIDI /
// 滑鼠同一條路徑，因此 Learn、錄製、soft-takeover、HUD 對多人來源一樣生效。
// 展場常駐：ID 為短碼（QR 更小）、與訊號伺服器斷線自動用同一 ID 重連、ID 被占用自動換號重建。
import { useStore } from '../store/useStore.js'
import { dispatch } from './remoteDispatch.js'
import { PEER_CONFIG } from './ice.js'
import { makeGuideToken, buildRemoteUrl } from './tourRemote.js'
import { bumpStat } from '../store/stats.js'
import { t, T } from '../i18n/index.js'

// count = 所有已連線的手機（含導覽員）；guide = 導覽員 token（每個 host session 一個，存記憶體；host 重建時換新）；guides = 已通過驗證的導覽員連線數
export const multiState = { on: false, id: null, count: 0, guide: null, guides: 0 }

// 開發輔助：主控台可用 window.__peer 取得目前 host 的 Peer（測試斷線重連 / 銷毀重建；正式建置會被移除）
if (import.meta.env.DEV) Object.defineProperty(window, '__peer', { get: () => peer, configurable: true })

// 聲部分工：每支加入的手機輪流分到一個聲部（樂團感）；free = 全部
// label 是中文 key（T 標記）：原樣經 wire 傳給遙控頁，由各端依自己的語系 t()（手機與主畫面語系可以不同）
export const ROLES = [
  { id: 'ocean', label: T('海 · 水位/洋流/清澈'), pids: ['seaLevel', 'current', 'clarity'] },
  { id: 'life', label: T('生態 · 水母/魚群/鳥群'), pids: ['jellyCount', 'fishCount', 'birdCount', 'swimSpeed'] },
  { id: 'mood', label: T('氛圍 · 輝光/色相/背景'), pids: ['glow', 'hue', 'trashCount', 'bgBlur', 'bgClarity'] },
  { id: 'free', label: T('自由 · 全部參數'), pids: ['seaLevel', 'current', 'clarity', 'jellyCount', 'fishCount', 'birdCount', 'swimSpeed', 'glow', 'hue', 'trashCount', 'bgBlur', 'bgClarity'] },
]
let roleIdx = 0
let syncIv = null
let peer = null
let conns = []
let starting = null

// 多訂閱者：MultiModal / KioskQR 各自訂閱 host 狀態變化
const listeners = new Set()
const notify = () => listeners.forEach((f) => { try { f() } catch (e) {} })
export function onHostChange(fn) { listeners.add(fn); return () => listeners.delete(fn) }

// 導覽員遙控（手機當導覽員遙控器）：驗證 / 指令 / 連線集合的邏輯在 lib/tourRemote.js 的 createGuideHost（純函式，Node 可測），
// 由 services/TourRemoteService.jsx 建立（它需要導覽模組）並在掛載時 attach 進來；這裡只做接線：
//   收到 hello / g 訊息 → guideHost.handle；連線關閉 / 錯誤 → guideHost.remove；host 重建 → guideHost.clear（token 也換新）。
let guideHost = null
export function attachGuideHost(gh) {
  guideHost = gh
  const off = gh.onChange(() => { multiState.guides = gh.size(); notify() })
  multiState.guides = gh.size()
  notify()
  return () => { off(); if (guideHost === gh) { guideHost = null; multiState.guides = 0; notify() } }
}
export function sendToGuides(msg) { try { return guideHost ? guideHost.broadcast(msg) : 0 } catch (e) { return 0 } }   // 推給所有已通過驗證的導覽員連線
export function guideConns() { try { return guideHost ? guideHost.conns() : [] } catch (e) { return [] } }             // 目前所有已通過驗證的導覽員連線

// 遙控訊息 → store 的派送（dispatch）在 lib/remoteDispatch.js（不含 PeerJS / import.meta.env，Node 測得到）；這裡保留匯出以維持原本的 API。
export { dispatch }

// 短 ID：'ms' + 8 碼 base36（≈ 2.8e12 種）→ URL 短、QR 版本低、小尺寸也好掃
function makeId() {
  const a = new Uint8Array(8)
  ;(globalThis.crypto || window.crypto).getRandomValues(a)
  return 'ms' + Array.from(a, (b) => (b % 36).toString(36)).join('')
}

function wire(p) {
  p.on('connection', (c) => {
    c.__t0 = Date.now()
    conns.push(c)
    c.on('open', () => {
      multiState.count = conns.filter((x) => x.open).length
      bumpStat('joins')
      const role = ROLES[roleIdx++ % ROLES.length]        // 輪流分聲部
      try { c.send({ t: 'role', id: role.id, label: role.label, pids: role.pids }) } catch (e) {}
      notify()
      useStore.getState().pushLog('in', t('遙控器加入 · 聲部「{part}」（{n} 人連線）', { part: t(role.label).split(' ')[0], n: multiState.count }))
    })
    c.on('data', (m) => { if (guideHost && guideHost.handle(c, m)) return; dispatch(m, c.peer) })   // hello / 導覽員指令由 guideHost 處理，其餘照舊走 dispatch
    const drop = () => { if (guideHost) { try { guideHost.remove(c) } catch (e) {} } conns = conns.filter((x) => x !== c); multiState.count = conns.filter((x) => x.open).length; notify() }
    c.on('close', drop)
    c.on('error', drop) // 從未 open 的連線（ICE 失敗）PeerJS 不會發 close → 只能靠 error / 逾時清掉，否則展場 24h 會累積
  })
  // 與訊號伺服器斷線（網路瞬斷 / 伺服器重啟）：既有 WebRTC 連線不受影響，稍後用同一個 ID 重連，QR 不變
  p.on('disconnected', () => { setTimeout(() => { if (!p.destroyed) { try { p.reconnect() } catch (e) {} } }, 1500) })
  p.on('error', (e) => { if (e && e.type === 'unavailable-id') { try { p.destroy() } catch (x) {} } }) // 重連時 ID 被占 → 銷毀，交給 close 換號重建
  p.on('close', () => {
    if (peer !== p) return
    peer = null; multiState.on = false; multiState.id = null; conns = []; multiState.count = 0; starting = null
    multiState.guide = null   // host session 結束：token 失效（下一個 session 換新，舊的導覽員 QR 作廢）
    if (guideHost) { try { guideHost.clear() } catch (e) {} }
    multiState.guides = 0
    notify()
    setTimeout(() => { if (!peer) startHost().catch(() => {}) }, 2500)  // 被銷毀 → 換新 ID 重建（QR 會自動重畫）
  })
}

function ensureSync() {
  // 狀態回傳：每秒把目前參數同步到所有遙控器（滑桿跟著主畫面走）
  if (syncIv) return
  syncIv = setInterval(() => {
    // 清掉 30 秒仍未 open 的殭屍連線（掃碼後 ICE 失敗、對方直接關頁面等）
    const now = Date.now()
    const alive = conns.filter((x) => x.open || now - (x.__t0 || now) < 30000)
    if (alive.length !== conns.length) {
      conns.filter((x) => !alive.includes(x)).forEach((x) => { try { x.close() } catch (e) {} })
      conns = alive
    }
    const open = conns.filter((x) => x.open)
    if (!open.length) return
    const payload = { t: 'sync', params: useStore.getState().params }
    open.forEach((c) => { try { c.send(payload) } catch (e) {} })
  }, 1000)
}

export function startHost() {
  if (starting) return starting
  starting = (async () => {
    const { default: Peer } = await import('peerjs')
    let lastErr = null
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = makeId()
      try {
        const p = await new Promise((resolve, reject) => {
          const np = new Peer(id, PEER_CONFIG)
          const to = setTimeout(() => { try { np.destroy() } catch (e) {} reject(new Error(t('連線逾時'))) }, 12000)
          const onErr = (e) => { clearTimeout(to); try { np.destroy() } catch (x) {} reject(e) }
          np.on('error', onErr)
          np.on('open', () => { clearTimeout(to); np.off('error', onErr); resolve(np) })
        })
        peer = p
        multiState.on = true; multiState.id = p.id
        multiState.guide = makeGuideToken() || null   // 導覽員 token：每個 host session 隨機一個（crypto）；取不到安全亂數 → null（導覽員功能停用）
        wire(p); ensureSync(); notify()
        return multiState
      } catch (e) {
        lastErr = e
        if (!(e && e.type === 'unavailable-id')) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1))) // 撞號立刻換；其他錯誤退避
      }
    }
    throw lastErr || new Error(t('無法啟動'))
  })()
  starting.catch(() => { starting = null })
  return starting
}

// 一般遙控網址；{ guide: true } → 導覽員網址（#remote=<id>&guide=<token>），沒有 token（host 還沒起來 / 沒有安全亂數）時回傳 ''
export function remoteUrl({ guide = false } = {}) {
  if (!multiState.id) return ''
  if (guide && !multiState.guide) return ''
  return buildRemoteUrl(`${location.origin}${location.pathname}`, multiState.id, guide ? multiState.guide : null)
}
