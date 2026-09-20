// 最外層錯誤邊界（展場防呆）：render 出錯 → 復原畫面 + 倒數自動重新載入，不需要工程師到場。
//   · 復原畫面不依賴會出錯的東西：只用 React + 語系 t()（包一層 try/catch）+ resilience.css；語系用 import { t }（class 元件不能用 hook）。
//   · 崩潰寫進 localStorage 環狀紀錄（最近 20 筆：時間 / 訊息 / stack 前 300 字 / build id / 網址旗標），同一個錯誤（StrictMode 雙呼叫）合併成一筆。
//   · 自動重載退避：第 1 次 5 秒；1 分鐘內第 2 次 15 秒、第 3 次 60 秒；10 分鐘內累積 5 次 → 停止自動重載，改顯示「請人工處理」與手動按鈕（避免無限重載風暴）。
//   · window 'error' / 'unhandledrejection' 只記錄、不重載（見 lib/resilience.js 的 installErrorCapture）。
//   · 觀眾視窗（?audience=1）不渲染 Services，所以由這裡啟動它需要的防呆（WebGL 遺失 / 看門狗 / 版本檢查）；主畫面由 services/ResilienceService.jsx 啟動。
//   · 提示（GuardNotice）：WebGL 遺失 / 已恢復、即將重新載入、熔斷停止自動重載。不放進 store，所以入口 chunk（含手機遙控頁）不會被拉進 store / three。
//   · 可注入：props.deps = { log, now, reload, setInterval, clearInterval, buildId, flags, win, search, hash }（測試用；預設走真實環境）。
import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { t as translateNow, T, useT } from './i18n/index.js'
import {
  BUILD_ID, opsStatus, getCrashLog, planAutoReload, errorInfo, installErrorCapture, resolveConfig, startGuards, flagSummary,
} from './lib/resilience.js'
import './styles/resilience.css'

// 語系（i18n）本身若出問題，復原畫面仍要能顯示：退回中文原文 + 插值
const t = (zh, params) => { try { return translateNow(zh, params) } catch (e) { return String(zh).replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m)) } }

const TICK_MS = 500

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null, plan: null, deadline: 0, left: 0 }
    this.timer = null
    this.stopCapture = null
    this.guards = null
    this.reloadNow = this.reloadNow.bind(this)
  }

  static getDerivedStateFromError(error) {
    return { error: error == null ? new Error('Unknown error') : error }   // throw null / undefined 也要進入錯誤狀態，否則會無限重試 render
  }

  // 依賴（可由 props.deps 覆寫）。每次呼叫當下才組：不在建構時抓原生函式，也不把原生函式存成屬性後脫離原物件呼叫。
  deps() {
    const d = this.props.deps || {}
    const g = globalThis
    const search = d.search !== undefined ? d.search : (g.location ? g.location.search : '')
    const hash = d.hash !== undefined ? d.hash : (g.location ? g.location.hash : '')
    return {
      log: d.log || getCrashLog(),
      now: d.now || (() => Date.now()),
      reload: d.reload || (() => { g.location.reload() }),
      setInterval: d.setInterval || ((fn, ms) => g.setInterval(fn, ms)),
      clearInterval: d.clearInterval || ((id) => g.clearInterval(id)),
      buildId: d.buildId || BUILD_ID,
      flags: d.flags !== undefined ? d.flags : flagSummary(search, hash),
      win: d.win !== undefined ? d.win : (g.window || null),
      search, hash,
    }
  }

  componentDidMount() {
    const d = this.deps()
    // 全域錯誤只記錄；StrictMode 的 mount → unmount → mount 會重複進來：先確保舊的已解除
    if (this.stopCapture) this.stopCapture()
    this.stopCapture = installErrorCapture({ win: d.win, crashLog: d.log, cfg: { buildId: d.buildId, flags: d.flags } })
    if (this.props.deps) return   // 測試注入時不啟動真實防呆
    try {
      const cfg = resolveConfig({ search: d.search, hash: d.hash })
      if (cfg.mode === 'audience' && !this.guards) this.guards = startGuards({ config: cfg })
    } catch (e) { /* 防呆本身不能讓頁面出錯 */ }
  }

  componentDidCatch(error) {
    const d = this.deps()
    let plan
    try {
      const r = d.log.add({ kind: 'render', error, build: d.buildId, flags: d.flags })
      if (r && r.coalesced && !r.entry) return   // 同一個錯誤剛記過（StrictMode 雙呼叫）：第一次已經設好狀態了
      if (r && r.isNew) opsStatus.set({ crashRev: opsStatus.get().crashRev + 1 })
      plan = planAutoReload(d.log.list(), d.now())
    } catch (e) {
      plan = { stop: false, delayMs: 5000, count1: 1, count10: 1 }   // 連記錄都失敗（儲存壞了）：仍然用最保守的第 1 次退避
    }
    this.setState({ plan, deadline: plan.stop ? 0 : d.now() + plan.delayMs, left: plan.stop ? 0 : plan.delayMs })
  }

  componentDidUpdate() {
    const { error, plan } = this.state
    if (error && plan && !plan.stop && this.timer === null) this.startCountdown()
  }

  componentWillUnmount() {
    this.stopTimer()
    if (this.stopCapture) { this.stopCapture(); this.stopCapture = null }
    if (this.guards) { this.guards.stop(); this.guards = null }
  }

  startCountdown() {
    const d = this.deps()
    this.timer = d.setInterval(() => {
      const left = Math.max(0, this.state.deadline - d.now())
      if (left <= 0) { this.stopTimer(); this.reloadNow(); return }
      this.setState({ left })
    }, TICK_MS)
  }

  stopTimer() {
    if (this.timer === null) return
    const d = this.deps()
    d.clearInterval(this.timer)
    this.timer = null
  }

  reloadNow() {
    this.stopTimer()
    try { this.deps().reload() } catch (e) { /* ignore */ }
  }

  renderRecovery() {
    const { error, plan, left } = this.state
    const info = errorInfo(error)
    const halted = !!(plan && plan.stop)
    const secs = Math.max(1, Math.ceil(left / 1000))
    return (
      <div className="res-crash" role="alert">
        <div className="res-crash-card">
          <h1 className="res-crash-title">{halted ? t('發生錯誤，請人工處理') : t('發生錯誤，{s} 秒後自動重新載入', { s: secs })}</h1>
          {halted
            ? <p className="res-crash-msg">{t('短時間內反覆發生錯誤，已停止自動重新載入。請按下面的按鈕重新載入，或關閉分頁後重新開啟。')}</p>
            : <p className="res-crash-count" aria-hidden="true">{secs}</p>}
          <div className="res-crash-actions">
            <button type="button" className="res-btn" onClick={this.reloadNow}>{halted ? t('重新載入') : t('立即重新載入')}</button>
          </div>
          <details className="res-crash-details">
            <summary>{t('錯誤摘要')}</summary>
            <pre>{info.message}{info.stack ? '\n' + info.stack : ''}</pre>
          </details>
          <p className="res-crash-build">build {(this.props.deps && this.props.deps.buildId) || BUILD_ID}</p>
        </div>
      </div>
    )
  }

  render() {
    if (this.state.error) return this.renderRecovery()
    return <>{this.props.children}<GuardNotice /></>
  }
}

// ---- 畫面上的短暫提示（WebGL 遺失 / 恢復、即將重新載入、熔斷）----
const REASON_LABEL = { webgl: T('顯示引擎中斷'), watchdog: T('畫面停止更新') }   // 靜態表：T() 標記，顯示時再 t()

export function GuardNotice() {
  const t = useT()
  const st = useSyncExternalStore(opsStatus.subscribe, opsStatus.get, opsStatus.get)
  const [hiddenAt, setHiddenAt] = useState(0)
  const gl = st.gl
  useEffect(() => {
    if (gl.state !== 'restored') return undefined
    const id = setTimeout(() => setHiddenAt(gl.at), 3500)
    return () => clearTimeout(id)
  }, [gl.state, gl.at])

  let msg = ''
  let warn = false
  if (st.halted) { msg = t('短時間內多次異常，已停止自動重新載入。請人工處理。'); warn = true }
  else if (st.reloading && Object.prototype.hasOwnProperty.call(REASON_LABEL, st.reloading.reason)) { msg = t('偵測到異常（{why}），即將重新載入…', { why: t(REASON_LABEL[st.reloading.reason]) }); warn = true }
  else if (gl.state === 'lost') { msg = t('顯示引擎暫時中斷，嘗試恢復中…'); warn = true }
  else if (gl.state === 'restored' && hiddenAt !== gl.at) msg = t('顯示引擎已恢復')
  if (!msg) return null
  return (
    <div className={'res-notice' + (warn ? ' warn' : '')} role="status" aria-live="polite">
      <span>{msg}</span>
      {st.halted && <button type="button" className="res-btn" onClick={() => { try { globalThis.location.reload() } catch (e) { /* ignore */ } }}>{t('重新載入')}</button>}
    </div>
  )
}
