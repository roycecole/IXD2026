// 手機掃 QR 當遙控器（多人合奏）：主畫面當 host（PeerJS WebRTC DataChannel），
// 手機開 #remote=<id> 頁連進來，訊息一律走 store.input()/handleNote() —— 與 MIDI /
// 滑鼠同一條路徑，因此 Learn、錄製、soft-takeover、HUD 對多人來源一樣生效。
import { useStore } from '../store/useStore.js'
import { PARAM_ORDER } from '../params/registry.js'
import { PEER_CONFIG } from './ice.js'
import { bumpStat } from '../store/stats.js'

export const multiState = { on: false, id: null, count: 0 }

// 聲部分工：每支加入的手機輪流分到一個聲部（樂團感）；free = 全部
export const ROLES = [
  { id: 'ocean', label: '海 · 水位/洋流/清澈', pids: ['seaLevel', 'current', 'clarity'] },
  { id: 'life', label: '生態 · 水母/魚群/游速', pids: ['jellyCount', 'fishCount', 'swimSpeed'] },
  { id: 'mood', label: '氛圍 · 輝光/色相/垃圾', pids: ['glow', 'hue', 'trashCount'] },
  { id: 'free', label: '自由 · 全部參數', pids: ['seaLevel', 'current', 'clarity', 'jellyCount', 'fishCount', 'swimSpeed', 'glow', 'hue', 'trashCount'] },
]
let roleIdx = 0
let syncIv = null

const ALLOWED_P = new Set(PARAM_ORDER)
const ALLOWED_A = new Set(['spawnWhale', 'spawnDolphin', 'spawnTurtle', 'clearTrash', 'transportPlay', 'transportStop', 'transportRecord'])

let peer = null
let conns = []

// 匯出供測試 / 未來其他傳輸層（WebSocket 等）重用
export function dispatch(m) {
  try {
    if (!m || typeof m !== 'object') return
    const st = useStore.getState()
    if (m.t === 'p' && ALLOWED_P.has(m.pid) && typeof m.v === 'number') {
      st.input(m.pid, Math.max(0, Math.min(1, m.v)))
    } else if (m.t === 'a' && ALLOWED_A.has(m.a)) {
      st[m.a]()
    } else if (m.t === 'n' && typeof m.note === 'number') {
      st.handleNote(m.note | 0, Math.max(0.05, Math.min(1, +m.vel || 0.8)))
    }
  } catch (e) {}
}

export async function startHost(onChange) {
  if (peer) return multiState
  const { default: Peer } = await import('peerjs')
  peer = new Peer(PEER_CONFIG)
  await new Promise((resolve, reject) => {
    peer.on('open', resolve)
    peer.on('error', (e) => { if (!multiState.on) { peer = null; reject(e) } })
  })
  multiState.on = true
  multiState.id = peer.id
  peer.on('connection', (c) => {
    conns.push(c)
    c.on('open', () => {
      multiState.count = conns.filter((x) => x.open).length
      bumpStat('joins')
      const role = ROLES[roleIdx++ % ROLES.length]        // 輪流分聲部
      try { c.send({ t: 'role', id: role.id, label: role.label, pids: role.pids }) } catch (e) {}
      onChange && onChange()
      useStore.getState().pushLog('in', `遙控器加入 · 聲部「${role.label.split(' ')[0]}」（${multiState.count} 人連線）`)
    })
    c.on('data', dispatch)
    c.on('close', () => { conns = conns.filter((x) => x !== c); multiState.count = conns.filter((x) => x.open).length; onChange && onChange() })
    c.on('error', () => {})
  })
  // 狀態回傳：每秒把目前參數同步到所有遙控器（滑桿跟著主畫面走）
  if (!syncIv) syncIv = setInterval(() => {
    const open = conns.filter((x) => x.open)
    if (!open.length) return
    const payload = { t: 'sync', params: useStore.getState().params }
    open.forEach((c) => { try { c.send(payload) } catch (e) {} })
  }, 1000)
  return multiState
}

export function remoteUrl() {
  if (!multiState.id) return ''
  return `${location.origin}${location.pathname}#remote=${multiState.id}`
}
