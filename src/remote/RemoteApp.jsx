import { useEffect, useRef, useState } from 'react'
import { PEER_CONFIG } from '../lib/ice.js'
import { askSensorPermission, startTilt, startShake } from '../lib/sensors.js'
import { useT, useLocale, T, translate, toggleLocale } from '../i18n/index.js'
import { helloMsg, guideCmd, guideView, countdownView, reduceGuideMsg, GUIDE_HELLO_WAIT_MS } from '../lib/tourRemote.js'
import { createRemoteLink } from '../lib/remoteReconnect.js'
import { holdScreenAwake } from '../lib/wakeLockLite.js'
import '../styles/guide.css'

// 手機遙控頁（#remote=<hostId>）：輕量、不載 three。滑桿 / 按鈕 / 打擊墊
// 全部送回主畫面的 store.input()/handleNote() —— 多支手機同時連線＝一群人合奏一片海。
// 主畫面會分配「聲部」（海/生態/氛圍/自由）並每秒回傳目前參數，滑桿跟著大畫面動。
// 導覽員模式（#remote=<hostId>&guide=<token>，導覽員 QR）：連上後送 hello 驗證 token；通過後最上方多一個「導覽員」區塊
//   （上一站 / 暫停 / 下一站、開始 / 結束導覽、站 chips、念出字幕），原本的演奏控制收進預設收合的「演奏控制」（演奏操作會中止導覽，別不小心碰到）。
//   只能操控資料導覽；驗證失敗 / 主畫面沒有回應 → 維持一般遙控。協定與邏輯在 lib/tourRemote.js（本頁不 import three / store / tour.js）。
// 自動重連（導覽員與一般遙控都適用）：手機鎖屏 / 切到背景 / 換網路 → 連線斷了不必重新整理頁面，頁面可見時用退避（1、2、4、8、15 秒）自動重連到同一個主畫面；
//   回到前景立刻重試一次；主畫面已重新載入（host id 已換）連續失敗約 6 次 → 停止並請重新掃描 QR。邏輯在 lib/remoteReconnect.js（可注入、Node 可測）。
//   重連期間按鈕維持停用並顯示「重新連線中…（第 n 次）」；感測器（本頁的監聽）不受連線影響，重連後照原樣繼續送。
// 導覽員模式且已連線時：螢幕保持喚醒（lib/wakeLockLite.js；一般遙控不啟用），並顯示這一站的倒數 / 進度條與「下一站」預告
//   （主畫面每 2 秒補推一次剩餘時間，兩次推送之間用本機時鐘內插，收到新推送就重新校準；舊版主畫面沒有這些欄位 → 整段不顯示）。

// 靜態表的中文名用 T() 標記，顯示處再 t()
const ALL_SLIDERS = {
  seaLevel: T('海水高度'), current: T('洋流速度'), clarity: T('海水清澈'),
  jellyCount: T('水母數量'), fishCount: T('魚群數量'), swimSpeed: T('游動速度'),
  glow: T('夢幻輝光'), hue: T('海色色相'), trashCount: T('垃圾數量'),
  birdCount: T('鳥群數量'), bgBlur: T('背景模糊'), bgClarity: T('背景清澈'),
}
const DEFAULT_PIDS = ['seaLevel', 'current', 'clarity', 'trashCount', 'glow', 'hue']
const ACTIONS = [
  { a: 'spawnWhale', label: T('鯨魚') },
  { a: 'spawnDolphin', label: T('海豚') },
  { a: 'spawnTurtle', label: T('海龜') },
  { a: 'clearTrash', label: T('清垃圾') },
]
const PADS = [T('水母'), T('浪湧'), T('漣漪'), T('氣泡'), T('亮星'), T('海豚'), T('鯨魚'), T('海龜'), T('淨化'), T('垃圾'), T('轉向'), T('閃光'), T('衝刺'), T('三漣'), T('星雨'), T('大浪')]
// 導覽員區塊的站名（站 id 對應中文名；host 只送站 id，站名由本頁依語系顯示）
const STOP_NAMES = {
  reservoir: T('今日水庫'), tide: T('潮汐'), moon: T('月亮'), dust: T('揚塵'),
  air: T('空氣品質'), birds: T('鳥群調查'), fish: T('魚群調查'), stations: T('河川測站'),
}
const SLOW_HINT_MS = 15000   // 第一次連線超過這麼久還沒連上：提示場地 Wi-Fi 可能擋 P2P

// 按鈕回饋：功能偵測、以方法呼叫（不脫離 navigator）、任何例外都吞掉
function buzz(ms = 12) { try { if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(ms) } catch (e) { /* 不支援 / 被擋 */ } }

// 本機單調時鐘（倒數內插用；狀態的「收到時間」與畫面的「現在」必須是同一個時鐘）
const nowMs = () => (typeof performance !== 'undefined' && performance && typeof performance.now === 'function' ? performance.now() : Date.now())

// 連線層狀態（lib/remoteReconnect.js 的 snapshot）→ 畫面上的狀態文字：回傳「中文 key（T 標記）＋ 插值參數」，畫面上才 t()，所以連線中途切語系也會跟著換。
//   ls = { phase, n, unavailable, reason, detail, ever }；slow = 第一次連線已經等很久（只在「從沒連上過」時才提示 Wi-Fi 問題）
export function statusForLink(ls, { slow = false } = {}) {
  const s = ls && typeof ls === 'object' ? ls : {}
  if (s.phase === 'connected') return { key: T('已連上主畫面 · 一起合奏'), params: null }
  if (s.phase === 'gaveup') {
    if (s.reason === 'unavailable') return { key: T('主畫面已重新載入，請重新掃描 QR'), params: null }
    if (s.reason === 'load') return { key: T('載入失敗：{msg}'), params: { msg: s.detail || '' } }
    return { key: T('無法連線：{e}'), params: { e: s.detail || '' } }
  }
  if (s.phase === 'paused') return { key: T('連線中斷 · 回到這個畫面會自動重連'), params: null }
  if (!s.ever && slow && !(s.unavailable > 0)) return { key: T('連線偏慢…場地 Wi-Fi 可能擋 P2P，建議手機開熱點再掃一次'), params: null }   // 從沒連上過、拖很久、而且不是「主畫面不存在」（那個是 peer-unavailable，與 Wi-Fi 無關）
  if (s.n > 0) return { key: T('重新連線中…（第 {n} 次）'), params: { n: s.n } }
  return { key: T('連線中…'), params: null }
}

// 連線狀態（StrictMode 雙掛載安全的模組級單例）：狀態放這裡，元件只訂閱。
// status 存「中文 key（T 標記）＋ statusP 插值參數」；ls = 連線層的狀態；ok = 與主畫面的資料通道可用。
// guide：'none'（網址沒有 token）| 'pending'（已送 hello 等回覆）| 'ok' | 'denied'（token 不符 / 主畫面沒有回應）；tour：主畫面推來的導覽狀態；tourAt：收到它的本機時間（倒數內插的基準）
// 連線掉了不再清掉單例：連線層（createRemoteLink）自己退避重連、重複使用同一個 Peer，每次只留一條連線；每次連線 open（含重連）都重送 hello。
// deps（測試用）：{ makePeer, env, setTimer, clearTimer }
export function createBoot(hostId, guideToken, deps = {}) {
  const setTimer = typeof deps.setTimer === 'function' ? deps.setTimer : (fn, ms) => setTimeout(fn, ms)
  const clearTimer = typeof deps.clearTimer === 'function' ? deps.clearTimer : (id) => clearTimeout(id)
  const makePeer = typeof deps.makePeer === 'function' ? deps.makePeer : () => import('peerjs').then(({ default: Peer }) => new Peer(PEER_CONFIG))
  const b = { hostId, guideToken, link: null, subs: new Set(), status: T('連線中…'), statusP: null, ls: null, ok: false, role: null, syncParams: null, guide: guideToken ? 'pending' : 'none', tour: null, tourAt: 0, helloTimer: null, slowTimer: null, slow: false, teardown: null, setTimer, clearTimer }
  const emit = () => b.subs.forEach((f) => { try { f() } catch (e) { /* 訂閱者出錯不影響連線 */ } })
  const stopHelloTimer = () => { if (b.helloTimer !== null) { clearTimer(b.helloTimer); b.helloTimer = null } }
  const stopSlowTimer = () => { if (b.slowTimer !== null) { clearTimer(b.slowTimer); b.slowTimer = null } }
  const refresh = () => {   // 連線層狀態 → 畫面狀態
    b.ok = !!b.ls && b.ls.phase === 'connected'
    const s = statusForLink(b.ls, { slow: b.slow })
    b.status = s.key; b.statusP = s.params
    if (!b.ok) stopHelloTimer()
  }
  b.link = createRemoteLink({
    hostId, makePeer, env: deps.env, setTimer, clearTimer,
    onChange: (ls) => { b.ls = ls; refresh(); emit() },
    onOpen: (conn, { reconnect }) => {
      stopSlowTimer()
      if (reconnect) b.tour = null                          // 重連：舊的導覽狀態已過時，等主畫面的新狀態（通過 hello 後主畫面立刻推一次）
      if (guideToken) {                                     // 導覽員模式：送 hello 驗證 token（每次連線 open 都送，含重連）；逾時沒回應（主畫面是舊版 / 沒有導覽員功能）就當作一般遙控
        try { conn.send(helloMsg(guideToken)) } catch (e) {}
        stopHelloTimer()
        b.helloTimer = setTimer(() => { b.helloTimer = null; if (b.guide === 'pending') { b.guide = 'denied'; emit() } }, GUIDE_HELLO_WAIT_MS)
      }
      emit()
    },
    onData: (m) => {
      if (!m || typeof m !== 'object') return
      if (m.t === 'role') { b.role = m; emit() }
      else if (m.t === 'sync' && m.params) { b.syncParams = m.params; emit() }
      else if (m.t === 'guide' || m.t === 'tour') {
        const cur = { guide: b.guide, tour: b.tour }
        const next = reduceGuideMsg(cur, m)
        if (next.guide !== cur.guide || next.tour !== cur.tour) {
          if (next.tour !== cur.tour) b.tourAt = nowMs()   // 倒數以「收到這一刻」為基準內插；每次收到新的推送就重新校準（不累積漂移）
          b.guide = next.guide; b.tour = next.tour; if (b.guide !== 'pending') stopHelloTimer(); emit()
        }
      }
    },
  })
  b.slowTimer = setTimer(() => { b.slowTimer = null; b.slow = true; refresh(); emit() }, SLOW_HINT_MS)
  // 完整拆除：停連線層（Peer / 連線 / 監聽 / 計時器全部收掉）與這裡的計時器
  b.destroy = () => {
    if (b.teardown !== null) { clearTimer(b.teardown); b.teardown = null }
    stopHelloTimer(); stopSlowTimer()
    b.link.stop()
    b.subs.clear()
  }
  return b
}

let boot = null
export function ensurePeer(hostId, guideToken, deps) {
  if (boot && (boot.hostId !== hostId || boot.guideToken !== guideToken)) { boot.destroy(); boot = null }   // 網址換了（理論上整頁會重載）：不沿用舊連線
  if (boot) { if (boot.teardown !== null) { boot.clearTimer(boot.teardown); boot.teardown = null }; return boot }   // StrictMode 的第二次掛載：取消尚未執行的拆除，沿用同一條連線
  const b = (boot = createBoot(hostId, guideToken, deps))
  try { if (import.meta.env.DEV) window.__remoteBoot = b } catch (e) { /* Node 測試沒有 import.meta.env */ }   // 開發輔助：預覽面板擋 WebRTC，主控台可直接改 b.ok / b.guide / b.tour / b.tourAt（= performance.now()）再呼叫 b.subs.forEach((f) => f()) 驗畫面（正式建置會被移除）
  b.link.start()
  return b
}
// 元件卸載（或 StrictMode 模擬卸載）時呼叫：沒有訂閱者了 → 下一個 macrotask 才真的拆除（StrictMode 會在同一個 tick 內立刻重新掛載並取消這次拆除；真的卸載才會拆）
export function releasePeer(b) {
  if (!b || b.subs.size > 0 || b.teardown !== null) return
  b.teardown = b.setTimer(() => { b.teardown = null; if (b.subs.size === 0) { b.destroy(); if (boot === b) boot = null } }, 0)
}

// 這一站的倒數 + 細進度條：文字與進度以「主畫面推來的剩餘時間 − 本機經過時間」內插（暫停時不動）。
//   自己有一個計時器（每 250ms 重繪這一小塊，不牽動整個頁面）；now 有給（測試）就不計時、以它為「現在」。role="timer" 隱含 aria-live=off：不會每秒吵螢幕閱讀器。
export function GuideCountdown({ v, at = 0, now: nowProp, t }) {
  const fixed = typeof nowProp === 'number'
  const [tick, setTick] = useState(() => (fixed ? nowProp : nowMs()))
  const live = !fixed && !v.paused && v.remainMs > 0
  useEffect(() => {
    if (!live) return undefined
    setTick(nowMs())
    const id = setInterval(() => setTick(nowMs()), 250)
    return () => clearInterval(id)
  }, [live, at])
  const c = countdownView(v, at, fixed ? nowProp : tick)
  if (!c) return null
  return (
    <div className={'guide-time' + (c.paused ? ' is-paused' : '')}>
      {c.frac !== null && <div className="guide-bar" aria-hidden="true"><i key={v.index} style={{ transform: `scaleX(${c.frac.toFixed(3)})` }} /></div>}
      <span className="guide-left" role="timer" aria-live="off">{t('剩 {n} 秒', { n: c.secs })}</span>
    </div>
  )
}

// 導覽員區塊（純展示：資料來自 lib/tourRemote.js 的 guideView，按鈕一律呼叫 cmd(指令, 參數)；可用 SSR 測試標記）
//   v = guideView(tour, connected)；ok = 與主畫面連線可用；t = 依遙控頁語系的 t；
//   at = 收到導覽狀態的本機時間、now = 固定的「現在」（只有測試會給）；wake = 螢幕喚醒狀態（'on' | 'unsupported' | 'failed' | 其他 = 不顯示）
export function GuidePanel({ v, ok, cmd, t, at = 0, now, wake = '' }) {
  const stopName = (id, i) => (STOP_NAMES[id] ? t(STOP_NAMES[id]) : t('第 {n} 站', { n: i + 1 }))
  return (
    <section className={'guide' + (ok ? '' : ' is-offline')} aria-label={t('導覽員')}>
      <div className="guide-head">
        <h2 className="guide-title">{t('導覽員')}</h2>
        <span className="guide-scope">{t('只能操控資料導覽')}</span>
      </div>
      {ok && wake === 'on' && <p className="guide-wake">{t('螢幕保持喚醒中')}</p>}
      {ok && (wake === 'unsupported' || wake === 'failed') && <p className="guide-wake is-off">{t('此瀏覽器無法保持喚醒（請把手機的自動鎖定調長）')}</p>}
      <div className="guide-now" aria-live="polite">
        {!ok ? <p className="guide-msg">{t('連線中斷 · 按鈕暫時無法使用')}</p>
          : v.noData ? <p className="guide-msg">{t('主畫面還沒載入海況資料')}</p>
          : v.running ? (
            <>
              <div className="guide-stop">{stopName(v.stopId, v.index)}</div>
              <div className="guide-meta">
                <span>{t('第 {n} / {total} 站', { n: v.index + 1, total: v.total })}</span>
                {v.paused && <span className="guide-paused">{t('已暫停')}</span>}
              </div>
              {v.timed && <GuideCountdown v={v} at={at} now={now} t={t} />}
              {v.note && <p className="guide-note">{v.note}</p>}
              {v.next && (
                <p className="guide-next">
                  {v.next.last ? <span className="guide-next-k">{t('最後一站')}</span> : (
                    <>
                      <span className="guide-next-k">{t('下一站：{name}', { name: stopName(v.next.id, v.next.index) })}</span>
                      {v.next.note && <span className="guide-next-note">{v.next.note}</span>}
                    </>
                  )}
                </p>
              )}
            </>
          ) : <p className="guide-msg">{v.known ? t('導覽還沒開始') : t('正在取得導覽狀態…')}</p>}
      </div>
      <div className="guide-nav">
        <button className="guide-btn" onClick={() => cmd('prev')} disabled={!v.canNav}>{t('上一站')}</button>
        <button className={'guide-btn' + (v.paused ? ' on' : '')} aria-pressed={v.paused} onClick={() => cmd(v.paused ? 'resume' : 'pause')} disabled={!v.canNav}>
          {v.paused ? t('繼續') : t('暫停')}
        </button>
        <button className="guide-btn" onClick={() => cmd('next')} disabled={!v.canNav}>{t('下一站')}</button>
      </div>
      <button className={'guide-btn guide-run' + (v.running ? ' stop' : ' start')} onClick={() => cmd(v.running ? 'stop' : 'start')} disabled={v.running ? !v.canStop : !v.canStart}>
        {v.running ? t('結束導覽') : t('開始導覽')}
      </button>
      {v.chips.length > 0 && (
        <div className="guide-chips" role="group" aria-label={t('導覽站（點一下跳到該站）')}>
          {v.chips.map((c) => (
            <button key={c.i} className={'guide-chip' + (c.current ? ' cur' : '')} aria-current={c.current ? 'step' : undefined} onClick={() => cmd('goto', c.i)} disabled={!ok}>
              <span className="guide-chip-n">{c.i + 1}</span>{stopName(c.id, c.i)}
            </button>
          ))}
        </div>
      )}
      {v.showSpeak && (
        <button className={'guide-btn guide-speak' + (v.speak ? ' on' : '')} aria-pressed={v.speak} onClick={() => cmd('speak', !v.speak)} disabled={!ok}>
          {v.speak ? t('念出字幕：開') : t('念出字幕：關')}
        </button>
      )}
    </section>
  )
}

export default function RemoteApp({ hostId, guide: guideToken = null }) {
  const t = useT()
  const locale = useLocale()
  const [status, setStatus] = useState(T('連線中…'))
  const [statusP, setStatusP] = useState(null)
  const [ok, setOk] = useState(false)
  const [stuck, setStuck] = useState(false)   // 連線層已放棄（主畫面已重新載入 / 致命錯誤）：顯示「重新整理」按鈕
  const [role, setRole] = useState(null)
  const [gs, setGs] = useState({ guide: guideToken ? 'pending' : 'none', tour: null, at: 0 })
  const [wake, setWake] = useState('')
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
    const b = ensurePeer(hostId, guideToken)
    const sync = () => {
      setOk(b.ok); setStatus(b.status); setStatusP(b.statusP); setRole(b.role)
      setStuck(!!b.ls && b.ls.phase === 'gaveup')
      setGs((p) => (p.guide === b.guide && p.tour === b.tour && p.at === b.tourAt ? p : { guide: b.guide, tour: b.tour, at: b.tourAt }))
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
    return () => { b.subs.delete(sync); releasePeer(b) }
  }, [hostId, guideToken])

  const isGuide = gs.guide === 'ok'

  // 導覽員模式且已連線時：螢幕保持喚醒（一般遙控不啟用，省電）。連線中止 / 卸載 / 離開導覽員模式 → 釋放；回到前景由 wakeLockLite 自己重新取得。
  useEffect(() => {
    if (!(isGuide && ok)) { setWake(''); return undefined }
    return holdScreenAwake({ onState: setWake })
  }, [isGuide, ok])

  const send = (m) => { if (boot) boot.link.send(m) }
  const sendParam = (pid, v) => {
    lastLocal.current[pid] = performance.now()
    const now = performance.now()
    if (now - (lastSend.current[pid] || 0) < 40) return // ~25Hz 節流
    lastSend.current[pid] = now
    send({ t: 'p', pid, v })
  }
  const cmd = (c, arg) => { buzz(); send(guideCmd(c, arg)) }   // 導覽員按鈕：短震一下 + 送指令（host 端節流、驗證）

  // 感測器：傾斜 → 洋流方向（flowX/flowY）、搖晃 → 浪湧（pad note 17）。走同一條 wire 協定，主畫面不需新程式。
  // 監聽由本元件持有、與連線無關：連線中斷期間 send 是空操作，重連後（boot.link 換了新連線）照原樣繼續送——原本開著的感測器保持開著。
  const toggleSensors = async () => {
    if (sensorsOn) {
      try { tiltRef.current && tiltRef.current.stop() } catch (e) {}
      try { shakeStop.current && shakeStop.current() } catch (e) {}
      tiltRef.current = null; shakeStop.current = null
      setSensorsOn(false); setSensMsg(''); return
    }
    if (!(await askSensorPermission())) { setSensMsg(T('未取得感測器權限（iOS 請在提示中允許「動作與方向」）')); return }
    let seen = false
    tiltRef.current = startTilt(({ flowX, flowY }) => { send({ t: 'p', pid: 'flowX', v: flowX }); send({ t: 'p', pid: 'flowY', v: flowY }) }, {
      onFirst: () => { seen = true; setSensMsg('') },
      onLandscape: (l) => { seen = true; setSensMsg(l ? T('請直向握持手機（橫放時傾斜感測暫停）') : '') },
    })
    shakeStop.current = startShake((vel) => {
      send({ t: 'n', note: 17, vel })
      try { navigator.vibrate && navigator.vibrate(15) } catch (e) {}
    })
    setSensorsOn(true)
    setSensMsg(T('偵測中…傾斜看看'))
    setTimeout(() => { if (!seen) setSensMsg(T('沒有收到感測器資料（需要手機或平板）')) }, 2000)
  }

  const pids = (role && role.pids && role.pids.length ? role.pids : DEFAULT_PIDS).filter((p) => ALL_SLIDERS[p])

  const wrapPlay = !!guideToken && gs.guide !== 'denied'      // 有導覽員 token 且沒被拒絕：演奏控制收進「演奏控制」（驗證前就先收，通過時不會重建滑桿）
  const v = guideView(gs.tour, ok)

  const roleLine = ok && role && <span className="remote-role">{t('你的聲部：{part}', { part: t(role.label) })}</span>

  const playControls = (
    <>
      <section className="remote-sliders" aria-label={t('參數滑桿')} ref={listRef}>
        {pids.map((pid) => (
          <label key={pid} className="remote-slider">
            <span>{t(ALL_SLIDERS[pid])} <em className="remote-val">--</em></span>
            <input type="range" min="0" max="1" step="0.005" defaultValue="0.5" data-pid={pid}
                   onInput={(e) => {
                     sendParam(pid, parseFloat(e.target.value))
                     const out = e.target.parentElement.querySelector('.remote-val')
                     if (out) out.textContent = parseFloat(e.target.value).toFixed(2)
                   }} disabled={!ok} />
          </label>
        ))}
      </section>
      <section className="remote-sensors" aria-label={t('手機感測器')}>
        <button className={sensorsOn ? 'on' : ''} aria-pressed={sensorsOn} onClick={toggleSensors} disabled={!ok}>
          {sensorsOn ? t('感測器 開　傾斜＝洋流 · 搖晃＝浪湧') : t('啟用感測器　傾斜＝洋流 · 搖晃＝浪湧')}
        </button>
        {sensorsOn && <button onClick={() => tiltRef.current && tiltRef.current.recenter()} title={t('把目前握持姿勢設為水平基準')}>{t('歸零')}</button>}
        {sensMsg && <span className="remote-hint">{t(sensMsg)}</span>}
      </section>
      <section className="remote-actions" aria-label={t('動作按鈕')}>
        {ACTIONS.map((b) => (
          <button key={b.a} onClick={() => send({ t: 'a', a: b.a })} disabled={!ok}>{t(b.label)}</button>
        ))}
      </section>
      <section className="remote-pads" aria-label={t('打擊墊')}>
        {PADS.map((p, i) => (
          <button key={i} onPointerDown={() => send({ t: 'n', note: 16 + i, vel: 0.9 })} disabled={!ok}>{t(p)}</button>
        ))}
      </section>
    </>
  )

  return (
    <div className="remote">
      <header className="remote-head">
        <div className="remote-toprow">
          <span className="remote-title">{t('MidiSea 遙控器')}</span>
          <button className="remote-lang" onClick={toggleLocale} lang={locale === 'zh' ? 'en' : 'zh-Hant'}
                  title={'Switch language / ' + translate('zh', '切換語言')} aria-label={locale === 'zh' ? 'Switch to English' : translate('zh', '切換為中文')}>
            {locale === 'zh' ? 'EN' : translate('zh', '中文')}
          </button>
        </div>
        <span className={'remote-status' + (ok ? ' ok' : '')}>{t(status, statusP)}</span>
        {!wrapPlay && roleLine}
        {!ok && stuck && (
          <button className="remote-retry" onClick={() => location.reload()}>{t('重新連線（主畫面重開請掃新 QR）')}</button>
        )}
      </header>
      <main className="remote-body">
        {isGuide && <GuidePanel v={v} ok={ok} cmd={cmd} t={t} at={gs.at} wake={wake} />}
        {!!guideToken && gs.guide === 'denied' && ok && (
          <p className="guide-denied" role="status">{t('導覽員連結已失效或主畫面沒有回應，先當一般遙控使用（主畫面重開後，請重新掃描導覽員 QR）')}</p>
        )}
        {wrapPlay ? (
          <details className="remote-play">
            <summary>
              <span className="remote-play-sum">
                <span>{t('演奏控制')}</span>
                <span className="remote-play-hint">{t('操作會中止導覽')}</span>
                <span className="remote-play-arrow" aria-hidden="true">▾</span>
              </span>
            </summary>
            <div className="remote-play-body">
              {roleLine}
              {playControls}
            </div>
          </details>
        ) : playControls}
      </main>
      <footer className="remote-foot">{t('多支手機可同時連線 · 每人一個聲部 · 你的每個動作都會即時演到大畫面的海')}</footer>
    </div>
  )
}
