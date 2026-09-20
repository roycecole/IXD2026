import { useEffect, useRef, useState } from 'react'
import { PEER_CONFIG } from '../lib/ice.js'
import { askSensorPermission, startTilt, startShake } from '../lib/sensors.js'

// 手機遙控頁（#remote=<hostId>）：輕量、不載 three。滑桿 / 按鈕 / 打擊墊
// 全部送回主畫面的 store.input()/handleNote() —— 多支手機同時連線＝一群人合奏一片海。
// 主畫面會分配「聲部」（海/生態/氛圍/自由）並每秒回傳目前參數，滑桿跟著大畫面動。

const ALL_SLIDERS = {
  seaLevel: '海水高度', current: '洋流速度', clarity: '海水清澈',
  jellyCount: '水母數量', fishCount: '魚群數量', swimSpeed: '游動速度',
  glow: '夢幻輝光', hue: '海色色相', trashCount: '垃圾數量',
}
const DEFAULT_PIDS = ['seaLevel', 'current', 'clarity', 'trashCount', 'glow', 'hue']
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
  const b = (boot = { peer: null, conn: null, subs: new Set(), status: '連線中…', ok: false, role: null, syncParams: null })
  const emit = () => b.subs.forEach((f) => { try { f() } catch (e) {} })
  import('peerjs').then(({ default: Peer }) => {
    const peer = (b.peer = new Peer(PEER_CONFIG))
    peer.on('open', () => {
      const conn = (b.conn = peer.connect(hostId, { reliable: true }))
      conn.on('open', () => { b.ok = true; b.status = '已連上主畫面 · 一起合奏'; emit() })
      conn.on('data', (m) => {
        if (!m || typeof m !== 'object') return
        if (m.t === 'role') { b.role = m; emit() }
        else if (m.t === 'sync' && m.params) { b.syncParams = m.params; emit() }
      })
      conn.on('close', () => { b.ok = false; b.status = '連線中斷'; emit(); boot = null }) // 清單例 → 重連可重建
      conn.on('error', () => { b.ok = false; b.status = '連線失敗'; emit(); boot = null })
    })
    peer.on('error', (e) => { b.ok = false; b.status = '無法連線：' + (e.type || e.message || ''); emit(); boot = null })
    setTimeout(() => { if (!b.ok && b.status === '連線中…') { b.status = '連線偏慢…場地 Wi-Fi 可能擋 P2P，建議手機開熱點再掃一次'; emit() } }, 15000)
  }).catch((e) => { b.status = '載入失敗：' + e.message; emit() })
  return b
}

export default function RemoteApp({ hostId }) {
  const [status, setStatus] = useState('連線中…')
  const [ok, setOk] = useState(false)
  const [role, setRole] = useState(null)
  const lastSend = useRef({})   // 節流
  const lastLocal = useRef({})  // 最近本地拖動時間（同步不要蓋住手上的滑桿）
  const listRef = useRef(null)
  const [sensorsOn, setSensorsOn] = useState(false)
  const [sensMsg, setSensMsg] = useState('')
  const tiltRef = useRef(null)
  const shakeStop = useRef(null)

  useEffect(() => () => {                       // 離開頁面時收掉感測器監聽
    try { tiltRef.current && tiltRef.current.stop() } catch (e) {}
    try { shakeStop.current && shakeStop.current() } catch (e) {}
  }, [])

  useEffect(() => {
    const b = ensurePeer(hostId)
    const sync = () => {
      setOk(b.ok); setStatus(b.status); setRole(b.role)
      // 主畫面參數 → 滑桿位置（2.5 秒內自己拖過的不蓋）
      if (b.syncParams && listRef.current) {
        const now = performance.now()
        listRef.current.querySelectorAll('input[data-pid]').forEach((inp) => {
          const pid = inp.dataset.pid
          if (now - (lastLocal.current[pid] || 0) < 2500) return
          const v = b.syncParams[pid]
          if (typeof v === 'number' && document.activeElement !== inp) {
            inp.value = v
            const out = inp.parentElement.querySelector('.remote-val')
            if (out) out.textContent = v.toFixed(2)
          }
        })
      }
    }
    sync()
    b.subs.add(sync)
    return () => b.subs.delete(sync)
  }, [hostId])

  const send = (m) => { const c = boot && boot.conn; if (c && c.open) { try { c.send(m) } catch (e) {} } }
  const sendParam = (pid, v) => {
    lastLocal.current[pid] = performance.now()
    const now = performance.now()
    if (now - (lastSend.current[pid] || 0) < 40) return // ~25Hz 節流
    lastSend.current[pid] = now
    send({ t: 'p', pid, v })
  }

  // 感測器：傾斜 → 洋流方向（flowX/flowY）、搖晃 → 浪湧（pad note 17）。走同一條 wire 協定，主畫面不需新程式。
  const toggleSensors = async () => {
    if (sensorsOn) {
      try { tiltRef.current && tiltRef.current.stop() } catch (e) {}
      try { shakeStop.current && shakeStop.current() } catch (e) {}
      tiltRef.current = null; shakeStop.current = null
      setSensorsOn(false); setSensMsg(''); return
    }
    if (!(await askSensorPermission())) { setSensMsg('未取得感測器權限（iOS 請在提示中允許「動作與方向」）'); return }
    let seen = false
    tiltRef.current = startTilt(({ flowX, flowY }) => { send({ t: 'p', pid: 'flowX', v: flowX }); send({ t: 'p', pid: 'flowY', v: flowY }) }, {
      onFirst: () => { seen = true; setSensMsg('') },
      onLandscape: (l) => { seen = true; setSensMsg(l ? '請直向握持手機（橫放時傾斜感測暫停）' : '') },
    })
    shakeStop.current = startShake((vel) => {
      send({ t: 'n', note: 17, vel })
      try { navigator.vibrate && navigator.vibrate(15) } catch (e) {}
    })
    setSensorsOn(true)
    setSensMsg('偵測中…傾斜看看')
    setTimeout(() => { if (!seen) setSensMsg('沒有收到感測器資料（需要手機或平板）') }, 2000)
  }

  const pids = (role && role.pids && role.pids.length ? role.pids : DEFAULT_PIDS).filter((p) => ALL_SLIDERS[p])

  return (
    <div className="remote">
      <header className="remote-head">
        <span className="remote-title">MidiSea 遙控器</span>
        <span className={'remote-status' + (ok ? ' ok' : '')}>{status}</span>
        {ok && role && <span className="remote-role">你的聲部：{role.label}</span>}
        {!ok && /中斷|失敗|無法/.test(status) && (
          <button className="remote-retry" onClick={() => location.reload()}>重新連線（主畫面重開請掃新 QR）</button>
        )}
      </header>
      <main className="remote-body">
        <section className="remote-sliders" aria-label="參數滑桿" ref={listRef}>
          {pids.map((pid) => (
            <label key={pid} className="remote-slider">
              <span>{ALL_SLIDERS[pid]} <em className="remote-val">--</em></span>
              <input type="range" min="0" max="1" step="0.005" defaultValue="0.5" data-pid={pid}
                     onInput={(e) => {
                       sendParam(pid, parseFloat(e.target.value))
                       const out = e.target.parentElement.querySelector('.remote-val')
                       if (out) out.textContent = parseFloat(e.target.value).toFixed(2)
                     }} disabled={!ok} />
            </label>
          ))}
        </section>
        <section className="remote-sensors" aria-label="手機感測器">
          <button className={sensorsOn ? 'on' : ''} aria-pressed={sensorsOn} onClick={toggleSensors} disabled={!ok}>
            {sensorsOn ? '感測器 開　傾斜＝洋流 · 搖晃＝浪湧' : '啟用感測器　傾斜＝洋流 · 搖晃＝浪湧'}
          </button>
          {sensorsOn && <button onClick={() => tiltRef.current && tiltRef.current.recenter()} title="把目前握持姿勢設為水平基準">歸零</button>}
          {sensMsg && <span className="remote-hint">{sensMsg}</span>}
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
      <footer className="remote-foot">多支手機可同時連線 · 每人一個聲部 · 你的每個動作都會即時演到大畫面的海</footer>
    </div>
  )
}
