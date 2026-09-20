// 「裝置」面板的一節：展場維運（版本 / 載入時間 / 資料更新時間 / 崩潰紀錄 / 目前啟用的防呆 / 立即重新載入 / 立即檢查更新 / 清除崩潰紀錄）。
// 狀態來自 lib/resilience.js 的 opsStatus（由 services/ResilienceService.jsx 啟動的防呆寫入）與崩潰紀錄（localStorage 環狀 20 筆）；這一節只讀取與顯示。
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useT, useLocale, localeTag, T } from '../../i18n/index.js'
import { useStore } from '../../store/useStore.js'
import { BUILD_ID, opsStatus, guardControls, getCrashLog, summarizeCrashes, resolveConfig, GL_RESTORE_MS, IDLE_MIN_MS } from '../../lib/resilience.js'
import '../../styles/resilience.css'

// 靜態表：用 T() 標記，顯示時再 t()
const KIND_LABEL = {
  render: T('畫面錯誤'), webgl: T('顯示引擎失效'), watchdog: T('畫面卡死'),
  error: T('未捕捉的錯誤'), rejection: T('未處理的 Promise 拒絕'), reload: T('自動重新載入'),
}
const RELOAD_WHY = { version: T('新版本'), daily: T('每日重載') }
const BUSY_WHY = { modal: T('有視窗開著'), active: T('有人操作中'), recording: T('錄製中'), tour: T('導覽中'), playing: T('播放中') }

const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k)
const two = (n) => String(n).padStart(2, '0')

export default function OpsSection() {
  const t = useT()
  const loc = useLocale()
  const st = useSyncExternalStore(opsStatus.subscribe, opsStatus.get, opsStatus.get)
  const govAt = useStore((s) => (s.gov ? s.gov.fetchedAt : null))
  const cfg = useMemo(() => resolveConfig({ search: location.search, hash: location.hash }), [])
  const [list, setList] = useState(() => getCrashLog().list())
  const [checking, setChecking] = useState(false)
  const refresh = useCallback(() => setList(getCrashLog().list()), [])
  useEffect(() => { refresh() }, [st.crashRev, refresh])

  const fmt = (ms) => (ms ? new Date(ms).toLocaleString(localeTag(loc), { hour12: false }) : '—')
  const busy = (r) => (r && has(BUSY_WHY, r) ? t(BUSY_WHY[r]) : '')
  const sum = summarizeCrashes(list)
  const recent = list.slice(-5).reverse()

  const v = st.version, d = st.data
  const auto = cfg.version.auto
  let versionText
  if (v.state === 'off' || !cfg.version.check) versionText = t('開發版不檢查')
  else if (!v.checkedAt) versionText = t('尚未檢查')
  else if (v.state === 'new') {
    const why = busy(v.deferred)
    versionText = `${fmt(v.checkedAt)} · ${t('有新版（{id}）', { id: v.remoteId })}${auto ? (why ? ' · ' + t('等閒置再重新載入（{why}）', { why }) : ' · ' + t('即將重新載入')) : ' · ' + t('已關閉自動重新載入')}`
  } else if (v.state === 'same') versionText = `${fmt(v.checkedAt)} · ${t('已是最新')}`
  else versionText = `${fmt(v.checkedAt)} · ${t('檢查失敗（離線？之後會再試）')}`

  let dataText
  if (d.state === 'off') dataText = t('未啟用')
  else if (!d.checkedAt && !d.appliedAt) dataText = t('尚未檢查')
  else if (d.state === 'pending') { const why = busy(d.deferred); dataText = `${fmt(d.checkedAt)} · ${t('有新資料（{at}）', { at: d.remoteFetchedAt })}${why ? ' · ' + t('等閒置再套用（{why}）', { why }) : ''}` }
  else if (d.state === 'applied') dataText = `${fmt(d.appliedAt)} · ${t('已更新到 {at}', { at: d.remoteFetchedAt })}`
  else if (d.state === 'same') dataText = `${fmt(d.checkedAt)} · ${t('已是最新')}`
  else dataText = `${fmt(d.checkedAt)} · ${t('檢查失敗（離線？之後會再試）')}`

  const wd = cfg.watchdog
  const wdText = wd.on
    ? t('啟用（{why}）', { why: wd.reason === 'kiosk' ? t('展場模式 ?kiosk') : t('網址 ?watchdog=1') })
    : t('未啟用（{why}）', { why: wd.reason === 'flag-off' ? t('已用 ?watchdog=0 關閉') : t('一般模式；加上 ?watchdog=1 開啟') })
  const autoText = { kiosk: t('生效（展場模式 ?kiosk：無人操作 {s} 秒後套用）', { s: IDLE_MIN_MS / 1000 }), idle: t('生效（閒置 {s} 秒、沒有錄製 / 播放 / 導覽 / 彈窗時套用）', { s: IDLE_MIN_MS / 1000 }), 'flag-off': t('已關閉（?autoupdate=0），只記錄不重新載入'), dev: t('開發版不檢查') }[cfg.version.reason]
  const dataEvery = cfg.data.visibleOnly ? t('每 {h} 小時（頁面可見時）', { h: Math.round(cfg.data.everyMs / 3600000) }) : t('每 {m} 分鐘', { m: Math.round(cfg.data.everyMs / 60000) })
  const dailyText = cfg.reloadHour !== null && cfg.reloadHour !== undefined ? t('每天 {hh}:00（閒置時）', { hh: two(cfg.reloadHour) }) : t('未設定（網址加 ?reload=0–23）')

  const reloadNow = () => { try { location.reload() } catch (e) { /* ignore */ } }
  const checkNow = async () => {
    const c = guardControls.current
    if (!c || checking) return
    setChecking(true)
    try { await c.checkNow() } finally { setChecking(false) }
  }
  const clearCrashes = () => { getCrashLog().clear(); opsStatus.set({ crashRev: opsStatus.get().crashRev + 1, halted: false }); refresh() }

  return (
    <section className="dev-sec ops-sec" aria-labelledby="ops-title">
      <h3 className="dev-sec-title" id="ops-title">{t('維運')}</h3>
      <p className="dev-sec-desc">{t('展場整天不關機用的狀態與復原工具：版本、資料更新時間、崩潰紀錄與目前啟用的防呆。一般使用不需要動它。')}</p>
      <div className="dev-sec-body">
        <dl className="ops-list">
          <dt>{t('版本')}</dt><dd className="mono">{BUILD_ID}</dd>
          <dt>{t('載入時間')}</dt><dd>{fmt(st.bootAt)}</dd>
          <dt>{t('海況資料時間')}</dt><dd className="mono">{govAt || '—'}</dd>
          <dt>{t('資料檢查')}</dt><dd>{dataText}</dd>
          <dt>{t('版本檢查')}</dt><dd>{versionText}</dd>
          <dt>{t('崩潰紀錄')}</dt><dd>{t('共 {n} 筆 · 近 10 分鐘重新載入 {m} 次', { n: sum.total, m: sum.fatal10 })}{st.halted ? ' · ' + t('已停止自動重新載入') : ''}</dd>
        </dl>

        <ul className="ops-guards" aria-label={t('目前啟用的防呆')}>
          <li className={wd.on ? '' : 'off'}><b>{t('渲染看門狗')}</b>{wdText}</li>
          <li><b>{t('WebGL 復原')}</b>{t('啟用（遺失後 {s} 秒沒恢復就重新載入）', { s: GL_RESTORE_MS / 1000 })}</li>
          <li className={cfg.version.check ? '' : 'off'}><b>{t('自動更新版本')}</b>{autoText}</li>
          <li><b>{t('資料更新')}</b>{dataEvery}</li>
          <li className={cfg.reloadHour === null ? 'off' : ''}><b>{t('每日重新載入')}</b>{dailyText}</li>
        </ul>

        <details className="ops-crashes">
          <summary>{t('最近 {n} 筆紀錄', { n: recent.length })}</summary>
          {recent.length === 0 ? <p>{t('沒有崩潰紀錄')}</p> : (
            <ol>
              {recent.map((e) => (
                <li key={`${e.boot}-${e.sig}-${e.t}`}>
                  <div className="ops-crash-head">
                    <span>{fmt(e.t)}</span>
                    <span className="ops-crash-kind">{has(KIND_LABEL, e.kind) ? t(KIND_LABEL[e.kind]) : e.kind}{e.kind === 'reload' && has(RELOAD_WHY, e.msg) ? ` · ${t(RELOAD_WHY[e.msg])}` : ''}</span>
                    {e.n > 1 && <span>×{e.n}</span>}
                  </div>
                  {e.kind !== 'reload' && e.msg && <div className="ops-crash-msg">{e.msg}</div>}
                  <div className="ops-crash-meta">build {e.build || '—'}{e.flags ? ` · ${e.flags}` : ''}</div>
                  {e.stack && <details><summary>stack</summary><div className="ops-crash-meta">{e.stack}</div></details>}
                </li>
              ))}
            </ol>
          )}
        </details>

        <div className="ops-actions">
          <button type="button" onClick={reloadNow}>{t('立即重新載入')}</button>
          <button type="button" onClick={checkNow} disabled={checking || !guardControls.current}>{checking ? t('檢查中…') : t('立即檢查更新')}</button>
          <button type="button" onClick={clearCrashes} disabled={list.length === 0}>{t('清除崩潰紀錄')}</button>
        </div>
        <p className="dev-sec-hint">{t('紀錄只存在這台裝置，不會傳送任何資料。')}</p>
      </div>
    </section>
  )
}
