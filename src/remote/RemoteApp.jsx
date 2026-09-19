import { useEffect, useRef, useState } from 'react'
import { PEER_CONFIG } from '../lib/ice.js'

// 手機遙控頁（#remote=<hostId>）：輕量、不載 three。滑桿 / 按鈕 / 打擊墊
// 全部送回主畫面的 store.input()/handleNote() —— 多支手機同時連線＝一群人合奏一片海。

const SLIDERS = [
  { pid: 'seaLevel', label: '海水高度' },
  { pid: 'current', label: '洋流速度' },
  { pid: 'clarity', label: '海水清澈' },
  { pid: 'trashCount', label: '垃圾數量' },
  { pid: 'glow', label: '夢幻輝光' },
  { pid: 'hue', label: '海色色相' },
]
const ACTIONS = [
  { a: 'spawnWhale', label: '鯨魚' },
  { a: 'spawnDolphin', label: '海豚' },
  { a: 'spawnTurtle', label: '海龜' },
  { a: 'clearTrash', label: '清垃圾' },
]
const PADS = ['水母', '浪湧', '漣漪', '氣泡', '亮星', '海豚', '鯨魚', '海龜', '淨化', '垃圾', '轉向', '閃光', '衝刺', '三漣', '星雨', '大浪']

// 模組級連線單例（StrictMode 雙掛載安全）：狀態放這裡，元件只訂閱
let boot = null
function ensurePeer(hostId) {
  if (boot) return boot
  const b = (boot = { peer: null, conn: null, subs: new Set(), status: '連線中…', ok: false })
  const emit = () => b.subs.forEach((f) => { try { f() } catch (e) {} })
  import('peerjs').then(({ default: Peer }) => {
    const peer = (b.peer = new Peer(PEER_CONFIG))
    peer.on('open', () => {
      const conn = (b.conn = peer.connect(hostId, { reliable: true }))
      conn.on('open', () => { b.ok = true; b.status = '已連上主畫面 · 一起合奏'; emit() })
      conn.on('close', () => { b.ok = false; b.status = '連線中斷 — 重新掃 QR'; emit() })
      conn.on('error', () => { b.ok = false; b.status = '連線失敗 — 重新掃 QR'; emit() })
    })
    peer.on('error', (e) => { b.ok = false; b.status = '無法連線：' + (e.type || e.message || ''); emit() })
    setTimeout(() => { if (!b.ok && b.status === '連線中…') { b.status = '連線偏慢…場地 Wi-Fi 可能擋 P2P，建議手機開熱點再掃一次'; emit() } }, 15000)
  }).catch((e) => { b.status = '載入失敗：' + e.message; emit() })
  return b
}

export default function RemoteApp({ hostId }) {
  const [status, setStatus] = useState('連線中…')
  const [ok, setOk] = useState(false)
  const lastSend = useRef({})

  useEffect(() => {
    const b = ensurePeer(hostId)
    const sync = () => { setOk(b.ok); setStatus(b.status) }
    sync()
    b.subs.add(sync)
    return () => b.subs.delete(sync)
  }, [hostId])

  const send = (m) => { const c = boot && boot.conn; if (c && c.open) { try { c.send(m) } catch (e) {} } }
  const sendParam = (pid, v) => {
    const now = performance.now()
    if (now - (lastSend.current[pid] || 0) < 40) return // ~25Hz 節流
    lastSend.current[pid] = now
    send({ t: 'p', pid, v })
  }

  return (
    <div className="remote">
      <header className="remote-head">
        <span className="remote-title">MidiSea 遙控器</span>
        <span className={'remote-status' + (ok ? ' ok' : '')}>{status}</span>
      </header>
      <main className="remote-body">
        <section className="remote-sliders" aria-label="參數滑桿">
          {SLIDERS.map((s) => (
            <label key={s.pid} className="remote-slider">
              <span>{s.label}</span>
              <input type="range" min="0" max="1" step="0.005" defaultValue="0.5"
                     onInput={(e) => sendParam(s.pid, parseFloat(e.target.value))} disabled={!ok} />
            </label>
          ))}
        </section>
        <section className="remote-actions" aria-label="動作按鈕">
          {ACTIONS.map((b) => (
            <button key={b.a} onClick={() => send({ t: 'a', a: b.a })} disabled={!ok}>{b.label}</button>
          ))}
        </section>
        <section className="remote-pads" aria-label="打擊墊">
          {PADS.map((p, i) => (
            <button key={i} onPointerDown={() => send({ t: 'n', note: 16 + i, vel: 0.9 })} disabled={!ok}>{p}</button>
          ))}
        </section>
      </main>
      <footer className="remote-foot">多支手機可同時連線 · 你的每個動作都會即時演到大畫面的海</footer>
    </div>
  )
}
