import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useT, useLocale, toggleLocale, translate, localeTag, T } from './i18n/index.js'
import {
  applyVerdict, browserEnv, buildReport, collectMeta, copyText, createCancel, createPointerTracker, createProbe, downloadText,
  getAutoChecks, getCheck, getChecks, getGroups, makeResult, pointerOutcome, renderDetail, reportFileName, runAutoChecks,
  saveSummary, statusKey, summarize,
} from './lib/diagnostics.js'
import './styles/diagnostics.css'

// 裝置診斷頁（?diagnostics=1）：展前在現場的實際硬體逐項檢查，並匯出報告。不載 three / 主畫面。
// 邏輯全在 lib/diagnostics.js（環境可注入、node 可測）；這裡只管畫面、把使用者的按鈕接到「探測器」、以及離開頁面時的清理：
//   · 相機 / 麥克風 / 語音只在使用者按下按鈕後才啟動（同一個點擊事件內直接呼叫 probe.start()，iOS 的權限與 AudioContext 才不會因手勢過期失敗）。
//   · 任何結束路徑（完成、錯誤、再按一次停止、pagehide、元件卸載）都會 stop() 所有探測器——它們會同步釋放 track / 辨識 / 計時器 / 監聽。
//   · React.StrictMode 會讓 effect 跑兩次：所有 effect 都可重複執行、cleanup 完整。

const SKIP_MSG = T('使用者略過了這一項')

// ───────────────────────────── 小元件 ─────────────────────────────
function Badge({ status, running }) {
  const t = useT()
  if (running) return <span className="diag-badge s-running"><i aria-hidden="true" />{t('檢查執行中')}</span>
  return <span className={'diag-badge s-' + (status || 'not-run')}><i aria-hidden="true" />{t(statusKey(status))}</span>
}

function Chip({ kind, label, n }) {
  return <div className={'diag-chip c-' + kind}><b>{n}</b><span>{label}</span></div>
}

function Verdict({ check, raw, verdict, onVerdict }) {
  const t = useT()
  const spec = check.verdict
  if (!spec || !raw || (raw.status !== 'pass' && raw.status !== 'needs-action')) return null
  return (
    <div className="diag-verdict" role="group" aria-label={t(spec.ask)}>
      <span className="diag-verdict-q">{t(spec.ask)}</span>
      <button type="button" className={'diag-btn' + (verdict === 'ok' ? ' on-ok' : '')} aria-pressed={verdict === 'ok'} onClick={() => onVerdict(check.id, 'ok')}>{t(spec.ok)}</button>
      <button type="button" className={'diag-btn' + (verdict === 'bad' ? ' on-bad' : '')} aria-pressed={verdict === 'bad'} onClick={() => onVerdict(check.id, 'bad')}>{t(spec.bad)}</button>
    </div>
  )
}

const f1 = (v) => (typeof v === 'number' && Number.isFinite(v) ? (Math.round(v * 10) / 10).toString() : '—')

function CameraLive({ live, running, videoRef, facing, setFacing }) {
  const t = useT()
  return (
    <div className="diag-live">
      <div className="diag-seg" role="group" aria-label={t('鏡頭方向')}>
        <button type="button" className={facing === 'user' ? 'on' : ''} aria-pressed={facing === 'user'} disabled={running} onClick={() => setFacing('user')}>{t('前置鏡頭')}</button>
        <button type="button" className={facing === 'environment' ? 'on' : ''} aria-pressed={facing === 'environment'} disabled={running} onClick={() => setFacing('environment')}>{t('後置鏡頭')}</button>
      </div>
      <div className="diag-preview">
        <video ref={videoRef} muted playsInline aria-label={t('相機預覽（只顯示在這裡，不會錄影或上傳）')} />
        {!running && <div className="diag-preview-ph">{t('預覽沒有開啟')}</div>}
      </div>
      {running && <p className="diag-note" role="status"><span className="diag-rec" aria-hidden="true" />{t('相機使用中：按「關閉相機」或離開頁面即會釋放')}</p>}
      {live && live.ended && <p className="diag-note warn" role="status">{t('相機中途中斷了（被拔除或被其他 App 搶走）')}</p>}
    </div>
  )
}

function MicLive({ live, running }) {
  const t = useT()
  const pct = Math.round(((live && live.level) || 0) * 100)
  const peak = Math.round(((live && live.peak) || 0) * 100)
  return (
    <div className="diag-live">
      <div className="diag-meter" role="meter" aria-label={t('麥克風音量')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <i style={{ width: pct + '%' }} />
        <b style={{ left: Math.min(99, peak) + '%' }} />
      </div>
      <p className="diag-note">{running ? t('收音中：請對著麥克風說話') : t('最大音量 {pct}%', { pct: peak })}</p>
    </div>
  )
}

function SpeechLive({ live, running }) {
  const t = useT()
  return (
    <div className="diag-live">
      <p className="diag-note warn">{t('Chrome 的語音辨識會把聲音送到雲端服務；本頁不會儲存或上傳任何內容，報告只記字數。')}</p>
      <div className="diag-speech" aria-live="polite">{(live && live.text) || (running ? t('請說一句話…') : '—')}</div>
      {live && live.lang && <p className="diag-note">{t('辨識語言：{lang}', { lang: live.lang })}</p>}
    </div>
  )
}

function MidiLive({ live }) {
  const t = useT()
  if (!live || !live.inputs) return null
  const list = (arr) => (arr.length ? arr.map((p, i) => <li key={i}>{p.name || '—'}{p.manufacturer ? ' · ' + p.manufacturer : ''}</li>) : <li className="diag-dim">{t('（沒有裝置）')}</li>)
  return (
    <div className="diag-live">
      <div className="diag-cols">
        <div><h4>{t('MIDI 輸入')}</h4><ul className="diag-list">{list(live.inputs)}</ul></div>
        <div><h4>{t('MIDI 輸出')}</h4><ul className="diag-list">{list(live.outputs)}</ul></div>
      </div>
      <p className="diag-note">{t('已收到 {n} 則訊息', { n: live.messages || 0 })}{live.last ? ' · ' + live.last : ''}</p>
    </div>
  )
}

function GamepadLive({ live }) {
  const t = useT()
  const pads = (live && live.pads) || []
  if (!pads.length) return null
  return (
    <div className="diag-live">
      {pads.map((p) => (
        <div className="diag-pad-card" key={p.index}>
          <h4>{p.id || '—'}<small>{p.mapping ? ' · ' + p.mapping : ''}</small></h4>
          <div className="diag-btns" aria-label={t('按鍵狀態')}>
            {p.buttons.map((b, i) => <span key={i} className={'diag-btn-cell' + (b.pressed ? ' on' : '')} title={f1(b.value)}>{i}</span>)}
          </div>
          <div className="diag-axes" aria-label={t('搖桿軸數值')}>
            {p.axes.map((a, i) => (
              <div className="diag-axis" key={i}>
                <span>{i}</span>
                <div className="diag-axis-bar"><i style={{ left: ((Math.max(-1, Math.min(1, a)) + 1) * 50) + '%' }} /></div>
                <span className="diag-num">{a.toFixed(2)}</span>
              </div>
            ))}
          </div>
          <p className="diag-note">{p.rumble ? t('有震動馬達') : t('沒有震動馬達')}</p>
        </div>
      ))}
    </div>
  )
}

function OrientLive({ live }) {
  const t = useT()
  const o = (live && live.orient) || {}
  const m = (live && live.motion) || {}
  return (
    <div className="diag-live">
      <dl className="diag-kv">
        <dt>alpha</dt><dd>{f1(o.alpha)}</dd>
        <dt>beta</dt><dd>{f1(o.beta)}</dd>
        <dt>gamma</dt><dd>{f1(o.gamma)}</dd>
        <dt>{t('加速度 x / y / z')}</dt><dd>{f1(m.x)} / {f1(m.y)} / {f1(m.z)}</dd>
      </dl>
    </div>
  )
}

function ScreensLive({ live }) {
  const t = useT()
  const screens = live && live.screens
  if (!screens || !screens.length) return null
  return (
    <ul className="diag-list diag-live">
      {screens.map((s, i) => (
        <li key={i}>
          {t('螢幕 {n}', { n: i + 1 })}：{s.width ?? '—'}×{s.height ?? '—'}
          {s.primary ? ' · ' + t('主要顯示器') : s.internal === true ? ' · ' + t('內建顯示器') : s.internal === false ? ' · ' + t('外接顯示器') : ''}
          {s.dpr ? ' · ' + s.dpr + 'x' : ''}
        </li>
      ))}
    </ul>
  )
}

// 觸控筆與觸控畫板：事件餵給純邏輯的 tracker（lib/diagnostics.js），畫面每 120ms 才更新一次讀數
const PEN_COLOR = { pen: '#5dcaa5', touch: '#4aa3ff', mouse: '#ff9d2b', other: '#c8cbd8' }
function PointerPad({ onOutcome, onReset }) {
  const t = useT()
  const canvasRef = useRef(null)
  const trackerRef = useRef(null)
  const lastPos = useRef(new Map())
  const timerRef = useRef(0)
  const dirty = useRef(false)
  const [snap, setSnap] = useState(null)
  if (!trackerRef.current) trackerRef.current = createPointerTracker()

  // 畫布依實際大小 / 像素比縮放（視窗大小改變時重設；重設會清掉筆跡，無妨）。落筆時也檢查一次：分組摺疊時量到的寬度是 0
  const fit = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    const r = c.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return
    const dpr = window.devicePixelRatio || 1
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr)
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h }
  }, [])
  useEffect(() => {
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [fit])
  useEffect(() => () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = 0 } }, [])

  const flush = useCallback(() => {
    timerRef.current = 0
    if (!dirty.current) return
    dirty.current = false
    const s = trackerRef.current.snapshot()
    setSnap(s)
    onOutcome(pointerOutcome(s))
  }, [onOutcome])
  const schedule = () => { dirty.current = true; if (!timerRef.current) timerRef.current = setTimeout(flush, 120) }

  const draw = (e, kind) => {
    const c = canvasRef.current
    if (!c) return
    const r = c.getBoundingClientRect()
    const sx = c.width / Math.max(1, r.width), sy = c.height / Math.max(1, r.height)
    const x = (e.clientX - r.left) * sx, y = (e.clientY - r.top) * sy
    if (kind === 'down') { lastPos.current.set(e.pointerId, { x, y }); return }
    if (kind === 'up' || kind === 'cancel') { lastPos.current.delete(e.pointerId); return }
    const prev = lastPos.current.get(e.pointerId)
    if (!prev || e.buttons === 0) return
    const g = c.getContext('2d')
    if (!g) return
    const p = typeof e.pressure === 'number' && e.pressure > 0 ? e.pressure : 0.5
    g.strokeStyle = PEN_COLOR[e.pointerType] || PEN_COLOR.other
    g.lineCap = 'round'
    g.lineWidth = (2 + p * 8) * (window.devicePixelRatio || 1)
    g.beginPath(); g.moveTo(prev.x, prev.y); g.lineTo(x, y); g.stroke()
    lastPos.current.set(e.pointerId, { x, y })
  }
  const on = (kind) => (e) => {
    if (kind === 'down') { fit(); try { e.currentTarget.setPointerCapture(e.pointerId) } catch (err) { /* 沒有 capture 也能畫 */ } }
    trackerRef.current.handle(kind, e)
    draw(e, kind)
    schedule()
  }
  const reset = () => {
    trackerRef.current.reset()
    lastPos.current.clear()
    dirty.current = false
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = 0 }
    const c = canvasRef.current
    if (c) { const g = c.getContext('2d'); if (g) g.clearRect(0, 0, c.width, c.height) }
    setSnap(null)
    onReset()
  }

  const last = snap && snap.last
  const seen = (snap && snap.seen) || {}
  const mark = (v) => (v ? t('已偵測到') : '—')
  return (
    <div className="diag-live">
      <canvas ref={canvasRef} className="diag-pad" aria-label={t('觸控筆與觸控畫板')}
        onPointerDown={on('down')} onPointerMove={on('move')} onPointerUp={on('up')} onPointerCancel={on('cancel')} onContextMenu={(e) => e.preventDefault()} />
      <dl className="diag-kv">
        <dt>pointerType</dt><dd>{last ? last.pointerType : '—'}</dd>
        <dt>pressure</dt><dd>{last ? f1(last.pressure) : '—'}</dd>
        <dt>tiltX / tiltY</dt><dd>{last ? f1(last.tiltX) + ' / ' + f1(last.tiltY) : '—'}</dd>
        <dt>{t('接觸面積')}</dt><dd>{last ? f1(last.width) + ' × ' + f1(last.height) : '—'}</dd>
        <dt>{t('滑鼠輸入')}</dt><dd>{mark(seen.mouse)}</dd>
        <dt>{t('觸控輸入')}</dt><dd>{seen.touch ? t('已偵測到（最多 {n} 指）', { n: snap.maxTouches }) : '—'}</dd>
        <dt>{t('觸控筆輸入')}</dt><dd>{mark(seen.pen)}</dd>
      </dl>
      <div className="diag-ctl"><button type="button" className="diag-btn" onClick={reset}>{t('清除畫板與紀錄')}</button></div>
    </div>
  )
}

// ───────────────────────────── 主畫面 ─────────────────────────────
export default function DiagnosticsApp() {
  const t = useT()
  const locale = useLocale()
  const env = useMemo(() => browserEnv(), [])
  const checks = useMemo(() => getChecks(), [])
  const groups = useMemo(() => getGroups(), [])

  const [results, setResults] = useState({})      // id → 機器結果
  const [verdicts, setVerdicts] = useState({})    // id → 'ok' | 'bad'（使用者按的「正常 / 不正常」）
  const [live, setLive] = useState({})            // id → 即時資料（音量、辨識文字、手把數值…）
  const [running, setRunning] = useState({})      // id → 互動探測器執行中
  const [quick, setQuick] = useState({ running: false, done: 0, total: 0, current: null })
  const [open, setOpen] = useState(() => Object.fromEntries(groups.map((g) => [g.id, true])))
  const [note, setNote] = useState(null)          // 'copied' | 'copy-failed' | 'downloaded' | 'download-failed'
  const [manual, setManual] = useState('')        // 複製失敗時顯示、讓使用者手動全選複製的報告文字
  const [facing, setFacingState] = useState('user')

  const probes = useRef({})
  const quickCancel = useRef(null)
  const revokers = useRef(new Set())
  const videoRef = useRef(null)
  const facingRef = useRef('user')
  const setFacing = (v) => { facingRef.current = v; setFacingState(v) }

  // 頁面專用外觀：styles.css 對 body 設了 overflow:hidden（給全螢幕的主畫面），診斷頁要能捲動
  useLayoutEffect(() => {
    const el = document.documentElement
    el.classList.add('diag-html')
    return () => el.classList.remove('diag-html')
  }, [])
  useEffect(() => { document.title = t('MidiSea 裝置診斷') }, [t])

  // 使用者的判斷疊加在機器結果上；總覽 / 報告 / 摘要都用疊加後的結果
  const effective = useMemo(() => {
    const out = {}
    for (const c of checks) { const r = results[c.id]; if (r) out[c.id] = applyVerdict(c, r, verdicts[c.id]) }
    return out
  }, [results, verdicts, checks])
  const summary = useMemo(() => summarize(checks, effective), [checks, effective])

  // 最近一次摘要存起來，供「裝置」面板那一節顯示（還沒有任何結果時不覆寫）
  useEffect(() => { if (Object.keys(effective).length) saveSummary(summary) }, [summary, effective])

  // 離開頁面 / 卸載：停掉所有快速檢查與探測器（相機 / 麥克風 / 辨識 / 計時器 / 監聽），釋放下載用的 object URL
  const stopAll = useCallback(() => {
    if (quickCancel.current) quickCancel.current.cancel()
    for (const p of Object.values(probes.current)) p.stop()
  }, [])
  useEffect(() => {
    const onHide = () => stopAll()
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      stopAll()
      for (const p of Object.values(probes.current)) p.destroy()
      probes.current = {}
      for (const r of revokers.current) r()
      revokers.current.clear()
    }
  }, [stopAll])

  useEffect(() => {   // 提示訊息 4 秒後自動消失
    if (!note) return undefined
    const id = setTimeout(() => setNote(null), 4000)
    return () => clearTimeout(id)
  }, [note])

  // ---- 快速檢查 ----
  const runQuick = useCallback(async () => {
    if (quickCancel.current) return
    const cancel = createCancel()
    quickCancel.current = cancel
    const auto = getAutoChecks()
    setQuick({ running: true, done: 0, total: auto.length, current: null })
    await runAutoChecks(env, {
      checks: auto, cancel,
      onStart: (c) => setQuick((q) => ({ ...q, current: c.id })),
      onResult: (r) => { setResults((p) => ({ ...p, [r.id]: r })); setQuick((q) => ({ ...q, done: q.done + 1 })) },
    })
    if (quickCancel.current === cancel) quickCancel.current = null
    setQuick((q) => ({ ...q, running: false, current: null }))
  }, [env])

  // ---- 互動檢查 ----
  const attach = useCallback(async (stream) => {
    const v = videoRef.current
    if (!v) return null
    v.srcObject = stream
    v.muted = true
    try { await v.play() } catch (e) { /* 自動播放被擋不影響：串流仍在，預覽稍後就會出現 */ }
    return v
  }, [])
  const detach = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    try { v.pause() } catch (e) { /* ignore */ }
    v.srcObject = null
  }, [])

  const getProbe = (id) => {
    if (probes.current[id]) return probes.current[id]
    const opts = {
      onUpdate: (patch) => setLive((p) => ({ ...p, [id]: { ...(p[id] || {}), ...patch } })),
      onResult: (r) => setResults((p) => ({ ...p, [id]: r })),
      onRunning: (v) => setRunning((p) => ({ ...p, [id]: v })),
      attach, detach,
      get facing() { return facingRef.current },
      get lang() { return localeTag() },   // 每次啟動時讀當下語系（zh-TW / en-US）
    }
    return (probes.current[id] = createProbe(id, env, opts))
  }
  const startProbe = (id) => {   // 必須在點擊事件內同步呼叫（權限 / AudioContext / requestPermission 都要使用者手勢）
    setVerdicts((p) => { if (!(id in p)) return p; const n = { ...p }; delete n[id]; return n })
    setLive((p) => ({ ...p, [id]: {} }))
    getProbe(id).start()
  }
  const stopProbe = (id) => { const p = probes.current[id]; if (p) p.stop() }
  const skip = (id) => {
    stopProbe(id)
    const c = getCheck(id)
    setResults((p) => ({ ...p, [id]: makeResult(c, { status: 'skipped', msg: { key: SKIP_MSG } }, 0) }))
    setVerdicts((p) => { if (!(id in p)) return p; const n = { ...p }; delete n[id]; return n })
  }
  const onVerdict = (id, v) => setVerdicts((p) => ({ ...p, [id]: p[id] === v ? undefined : v }))

  const pointerCheck = useMemo(() => getCheck('pointer'), [])
  const onPointerOutcome = useCallback((out) => {
    const r = makeResult(pointerCheck, out, 0)
    setResults((p) => { const o = p.pointer; return o && o.status === r.status && o.detail === r.detail ? p : { ...p, pointer: r } })
  }, [pointerCheck])
  const onPointerReset = useCallback(() => setResults((p) => { if (!('pointer' in p)) return p; const n = { ...p }; delete n.pointer; return n }), [])

  // ---- 報告 ----
  const makeReport = () => buildReport({ checks, results: effective, meta: collectMeta(env), tr: t, locale })
  const onCopy = async () => {
    const rep = makeReport()
    const res = await copyText(rep.text, env)
    if (res.ok) { setManual(''); setNote('copied') } else { setManual(rep.text); setNote('copy-failed') }
  }
  const onDownload = () => {
    const rep = makeReport()
    const r = downloadText(JSON.stringify(rep.json, null, 2), reportFileName(), env)
    if (r.ok) { revokers.current.add(r.revoke); setNote('downloaded') } else setNote('download-failed')
  }

  const toggleGroup = (id) => setOpen((p) => ({ ...p, [id]: !p[id] }))
  const allOpen = groups.every((g) => open[g.id])
  const setAll = (v) => setOpen(Object.fromEntries(groups.map((g) => [g.id, v])))

  const quickDone = !quick.running && quick.total > 0 && quick.done >= quick.total
  const noteText = note === 'copied' ? t('已複製報告（Markdown 表格 + JSON）')
    : note === 'copy-failed' ? t('無法自動複製：請在下方文字框全選後手動複製')
      : note === 'downloaded' ? t('已下載 JSON 報告')
        : note === 'download-failed' ? t('無法下載檔案：請改用「複製報告」')
          : quickDone ? t('快速檢查完成：通過 {pass}、失敗 {fail}、不支援 {unsupported}、尚未測 {pending}', summary) : ''

  const renderLive = (c) => {
    const lv = live[c.id]
    const isRun = !!running[c.id]
    switch (c.id) {
      case 'cam': return <CameraLive live={lv} running={isRun} videoRef={videoRef} facing={facing} setFacing={setFacing} />
      case 'mic': return <MicLive live={lv} running={isRun} />
      case 'speech': return <SpeechLive live={lv} running={isRun} />
      case 'midi': return <MidiLive live={lv} />
      case 'gamepad': return <GamepadLive live={lv} />
      case 'orient': return <OrientLive live={lv} />
      case 'screens': return <ScreensLive live={lv} />
      case 'pointer': return <PointerPad onOutcome={onPointerOutcome} onReset={onPointerReset} />
      default: return null
    }
  }

  return (
    <div className="diag-app">
      <header className="diag-head">
        <div className="diag-head-row">
          <h1>{t('裝置診斷')}</h1>
          <button type="button" className="diag-lang" onClick={toggleLocale} lang={locale === 'zh' ? 'en' : 'zh-Hant'}
            title={'Switch language / ' + translate('zh', '切換語言')} aria-label={locale === 'zh' ? 'Switch to English' : translate('zh', '切換為中文')}>
            {locale === 'zh' ? 'EN' : translate('zh', '中文')}
          </button>
        </div>
        <p className="diag-privacy">{t('這個頁面不會上傳任何東西：所有檢查都在這台裝置的瀏覽器裡執行；相機、麥克風與語音只在你按下按鈕後才啟動，離開頁面就會全部關閉。報告只在你按「複製」或「下載」時產生，且不含個人資料、IP、影像或音訊。')}</p>

        <div className="diag-summary" role="group" aria-label={t('診斷總覽')}>
          <Chip kind="pass" label={t('通過')} n={summary.pass} />
          <Chip kind="fail" label={t('失敗')} n={summary.fail} />
          <Chip kind="unsupported" label={t('不支援')} n={summary.unsupported} />
          <Chip kind="pending" label={t('尚未測')} n={summary.pending} />
        </div>

        <div className="diag-actions">
          <button type="button" className="diag-btn primary" onClick={runQuick} disabled={quick.running}>
            {quick.running ? t('檢查中… {done}/{total}', { done: quick.done, total: quick.total }) : t('執行所有快速檢查')}
          </button>
          <button type="button" className="diag-btn" onClick={onCopy}>{t('複製報告')}</button>
          <button type="button" className="diag-btn" onClick={onDownload}>{t('下載 JSON')}</button>
          <button type="button" className="diag-btn ghost" onClick={() => setAll(!allOpen)}>{allOpen ? t('全部收合') : t('全部展開')}</button>
        </div>
        <p className="diag-msg" role="status" aria-live="polite">{noteText}</p>
        {manual && <textarea className="diag-manual" readOnly value={manual} aria-label={t('報告文字（可手動全選複製）')} onFocus={(e) => e.target.select()} />}
      </header>

      <main className="diag-main">
        {groups.map((g) => {
          const list = checks.filter((c) => c.group === g.id)
          const s = summarize(list, effective)
          const gid = 'diag-g-' + g.id
          return (
            <section className="diag-group" key={g.id} aria-labelledby={gid + '-h'}>
              <h2 className="diag-group-h" id={gid + '-h'}>
                <button type="button" aria-expanded={!!open[g.id]} aria-controls={gid} onClick={() => toggleGroup(g.id)}>
                  <span className="diag-caret" aria-hidden="true" />
                  <span className="diag-group-t">{t(g.title)}</span>
                  <span className="diag-group-s">
                    {t('{pass}/{total} 通過', { pass: s.pass, total: s.total })}
                    {s.fail > 0 && <em>{t('{fail} 失敗', { fail: s.fail })}</em>}
                  </span>
                </button>
              </h2>
              <ul className="diag-rows" id={gid} hidden={!open[g.id]}>
                {list.map((c) => {
                  const raw = results[c.id]
                  const eff = effective[c.id]
                  const isRun = c.kind === 'auto' ? quick.running && quick.current === c.id : !!running[c.id]
                  const interactive = c.kind === 'interactive'
                  const detail = eff ? renderDetail(eff, t) : ''
                  return (
                    <li className="diag-row" key={c.id} data-check={c.id}>
                      <div className="diag-row-head">
                        <span className="diag-title">{t(c.title)}</span>
                        <Badge status={eff ? eff.status : null} running={isRun} />
                      </div>
                      {c.hint && <p className="diag-hint">{t(c.hint)}</p>}
                      {detail && <p className="diag-detail" aria-live={interactive ? 'polite' : undefined}>{detail}</p>}
                      {eff && eff.ms > 0 && c.kind === 'auto' && <span className="diag-ms">{eff.ms} ms</span>}
                      {interactive && (
                        <>
                          {c.custom !== 'pointer' && (
                            <div className="diag-ctl">
                              {isRun
                                ? <button type="button" className="diag-btn" onClick={() => stopProbe(c.id)}>{t(c.stopLabel)}</button>
                                : <button type="button" className="diag-btn primary" onClick={() => startProbe(c.id)}>{t(c.startLabel)}</button>}
                              {!isRun && <button type="button" className="diag-btn ghost" onClick={() => skip(c.id)}>{t('略過這一項')}</button>}
                            </div>
                          )}
                          {renderLive(c)}
                          <Verdict check={c} raw={raw} verdict={verdicts[c.id]} onVerdict={onVerdict} />
                          {c.custom === 'pointer' && (!raw || raw.status !== 'skipped') && (
                            <div className="diag-ctl"><button type="button" className="diag-btn ghost" onClick={() => skip(c.id)}>{t('這台沒有觸控筆，略過')}</button></div>
                          )}
                        </>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </main>

      <footer className="diag-foot">
        <a href="./">{t('回到 MidiSea')}</a>
      </footer>
    </div>
  )
}
