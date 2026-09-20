// 手機掃 QR 當遙控器（多人合奏）：主畫面當 host（PeerJS WebRTC DataChannel），
// 手機開 #remote=<id> 頁連進來，訊息一律走 store.input()/handleNote() —— 與 MIDI /
// 滑鼠同一條路徑，因此 Learn、錄製、soft-takeover、HUD 對多人來源一樣生效。
// 展場常駐：ID 為短碼（QR 更小）、與訊號伺服器斷線自動用同一 ID 重連、ID 被占用自動換號重建。
import { useStore } from '../store/useStore.js'
import { PARAM_ORDER } from '../params/registry.js'
import { PEER_CONFIG } from './ice.js'
import { bumpStat } from '../store/stats.js'

export const multiState = { on: false, id: null, count: 0 }

// 開發輔助：主控台可用 window.__peer 取得目前 host 的 Peer（測試斷線重連 / 銷毀重建；正式建置會被移除）
if (import.meta.env.DEV) Object.defineProperty(window, '__peer', { get: () => peer, configurable: true })

// 聲部分工：每支加入的手機輪流分到一個聲部（樂團感）；free = 全部
export const ROLES = [
  { id: 'ocean', label: '海 · 水位/洋流/清澈', pids: ['seaLevel', 'current', 'clarity'] },
  { id: 'life', label: '生態 · 水母/魚群/鳥群', pids: ['jellyCount', 'fishCount', 'birdCount', 'swimSpeed'] },
  { id: 'mood', label: '氛圍 · 輝光/色相/背景', pids: ['glow', 'hue', 'trashCount', 'bgBlur', 'bgClarity'] },
  { id: 'free', label: '自由 · 全部參數', pids: ['seaLevel', 'current', 'clarity', 'jellyCount', 'fishCount', 'birdCount', 'swimSpeed', 'glow', 'hue', 'trashCount', 'bgBlur', 'bgClarity'] },
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

const ALLOWED_P = new Set(PARAM_ORDER)
const ALLOWED_A = new Set(['spawnWhale', 'spawnDolphin', 'spawnTurtle', 'clearTrash', 'transportPlay', 'transportStop', 'transportRecord'])

// 洋流方向是「兩軸拼成的向量」：多支手機同時傾斜時各寫一軸 → 拼出無人的向量、洋流抖動。
// 以連線為單位做擁有權：最近有動的那支手機擁有洋流向量，其他手機在其靜止 1.5 秒內的 flowX/flowY 一律忽略。
const flowOwner = { src: null, t: 0 }
const FLOW_HOLD_MS = 1500

// 匯出供測試 / 未來其他傳輸層（WebSocket 等）重用。src = 來源連線識別（無則不做擁有權判斷）
export function dispatch(m, src) {
  try {
    if (!m || typeof m !== 'object') return
    const st = useStore.getState()
    if (m.t === 'p' && ALLOWED_P.has(m.pid) && typeof m.v === 'number') {
      if (src != null && (m.pid === 'flowX' || m.pid === 'flowY')) {
        const now = Date.now()
        if (flowOwner.src != null && flowOwner.src !== src && now - flowOwner.t < FLOW_HOLD_MS) return
        flowOwner.src = src; flowOwner.t = now
      }
      st.input(m.pid, Math.max(0, Math.min(1, m.v)))
    } else if (m.t === 'a' && ALLOWED_A.has(m.a)) {
      st[m.a]()
    } else if (m.t === 'n' && typeof m.note === 'number') {
      st.handleNote(m.note | 0, Math.max(0.05, Math.min(1, +m.vel || 0.8)))
    }
  } catch (e) {}
}

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
      useStore.getState().pushLog('in', `遙控器加入 · 聲部「${role.label.split(' ')[0]}」（${multiState.count} 人連線）`)
    })
    c.on('data', (m) => dispatch(m, c.peer))
    const drop = () => { conns = conns.filter((x) => x !== c); multiState.count = conns.filter((x) => x.open).length; notify() }
    c.on('close', drop)
    c.on('error', drop) // 從未 open 的連線（ICE 失敗）PeerJS 不會發 close → 只能靠 error / 逾時清掉，否則展場 24h 會累積
  })
  // 與訊號伺服器斷線（網路瞬斷 / 伺服器重啟）：既有 WebRTC 連線不受影響，稍後用同一個 ID 重連，QR 不變
  p.on('disconnected', () => { setTimeout(() => { if (!p.destroyed) { try { p.reconnect() } catch (e) {} } }, 1500) })
  p.on('error', (e) => { if (e && e.type === 'unavailable-id') { try { p.destroy() } catch (x) {} } }) // 重連時 ID 被占 → 銷毀，交給 close 換號重建
  p.on('close', () => {
    if (peer !== p) return
    peer = null; multiState.on = false; multiState.id = null; conns = []; multiState.count = 0; starting = null
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
          const to = setTimeout(() => { try { np.destroy() } catch (e) {} reject(new Error('連線逾時')) }, 12000)
          const onErr = (e) => { clearTimeout(to); try { np.destroy() } catch (x) {} reject(e) }
          np.on('error', onErr)
          np.on('open', () => { clearTimeout(to); np.off('error', onErr); resolve(np) })
        })
        peer = p
        multiState.on = true; multiState.id = p.id
        wire(p); ensureSync(); notify()
        return multiState
      } catch (e) {
        lastErr = e
        if (!(e && e.type === 'unavailable-id')) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1))) // 撞號立刻換；其他錯誤退避
      }
    }
    throw lastErr || new Error('無法啟動')
  })()
  starting.catch(() => { starting = null })
  return starting
}

export function remoteUrl() {
  if (!multiState.id) return ''
  return `${location.origin}${location.pathname}#remote=${multiState.id}`
}
