import { useEffect, useRef } from 'react'
import { useT } from './i18n/index.js'
import { renderDetail } from './lib/diagnostics.js'
import { bucketOf, guideCurrent, guideIsLast, guideProgress, guideStats } from './lib/diagnosticsGuide.js'

// 導引模式的全畫面卡片（手機友善）：intro（快速檢查摘要 + 裝置備註）→ 一次一項互動檢查 → summary（總結 + 複製 / 下載）。
// 純畫面：狀態機在 lib/diagnosticsGuide.js，探測器 / 權限 / 釋放都由 DiagnosticsApp 負責（這裡只呼叫 ctx 的處理函式）。
//   ctx：{ guide, plan, checks（id → 檢查定義）, results（機器結果）, effective（疊加使用者判斷後）, verdicts, running, quickSummary, note 區塊（noteNode）, 報告動作（onCopy / onDownload / msgText / manual）,
//         onNext / onBack / onLeave / onRestart / onGoto / onStart / onStop / onSkip / onVerdict, parts: { Badge, Chip, Verdict, Detail, renderLive } }
export default function GuideView({ ctx }) {
  const { guide } = ctx
  const t = useT()
  const titleRef = useRef(null)
  const cur = guideCurrent(guide)
  // 換一張卡片：捲到最上面並把焦點移到標題（螢幕閱讀器會念出新的項目；鍵盤使用者不必重新 Tab 過來）
  useEffect(() => {
    try { window.scrollTo(0, 0) } catch (e) { /* ignore */ }
    const el = titleRef.current
    if (el && typeof el.focus === 'function') { try { el.focus({ preventScroll: true }) } catch (e) { /* ignore */ } }
  }, [guide.phase, cur])

  const pr = guideProgress(guide)
  return (
    <section className="diag-guide" aria-labelledby="diag-guide-title" data-phase={guide.phase}>
      <header className="diag-guide-head">
        <div className="diag-guide-top">
          <span className="diag-guide-count" role="status">
            {guide.phase === 'step' ? t('第 {n} / {total} 項', { n: pr.n, total: pr.total }) : guide.phase === 'summary' ? t('導引完成：共 {total} 項', { total: pr.total }) : t('互動檢查導引：共 {total} 項', { total: pr.total })}
          </span>
          <button type="button" className="diag-btn ghost" onClick={ctx.onLeave}>{t('離開導引')}</button>
        </div>
        <div className="diag-progress" role="progressbar" aria-label={t('導引進度')} aria-valuemin={0} aria-valuemax={pr.total} aria-valuenow={pr.n}><i style={{ width: pr.pct + '%' }} /></div>
      </header>
      {guide.phase === 'intro' && <Intro ctx={ctx} titleRef={titleRef} />}
      {guide.phase === 'step' && cur && <Step ctx={ctx} id={cur} titleRef={titleRef} />}
      {guide.phase === 'summary' && <Summary ctx={ctx} titleRef={titleRef} />}
    </section>
  )
}

function Intro({ ctx, titleRef }) {
  const t = useT()
  const { plan, checks, quickSummary: q } = ctx
  return (
    <>
      <div className="diag-guide-body">
        <h2 id="diag-guide-title" ref={titleRef} tabIndex={-1}>{t('依序帶你做完互動檢查')}</h2>
        <p className="diag-guide-todo">{t('一次一項：按「開始」→ 看結果 → 需要判斷時回答 → 下一項。做不到的可以略過，之後隨時能回到清單補測。')}</p>
        {q && <p className="diag-note" role="status">{t('快速檢查已完成：通過 {pass}、失敗 {fail}、不支援 {unsupported}、尚未測 {pending}', q)}</p>}
        <p className="diag-note">{t('相機、麥克風與語音只在你按「開始」後才啟動；離開這一項、按停止或離開頁面都會立刻關閉。已經有結果的項目會保留，重測會覆蓋。')}</p>
        {plan.skipped.length > 0 && (
          <div className="diag-skipped">
            <h3>{t('這台裝置不支援，已自動略過（記為「不支援」）')}</h3>
            <ul>
              {plan.skipped.map((s) => {
                const c = checks[s.id]
                return <li key={s.id}><b>{c ? t(c.title) : s.id}</b><span>{renderDetail(s.outcome, t)}</span></li>
              })}
            </ul>
          </div>
        )}
        {ctx.noteNode}
      </div>
      <footer className="diag-guide-foot single">
        <button type="button" className="diag-btn primary big" onClick={ctx.onNext}>
          {plan.steps.length ? t('開始第 1 項') : t('沒有需要做的項目，看總結')}
        </button>
      </footer>
    </>
  )
}

function Step({ ctx, id, titleRef }) {
  const t = useT()
  const { checks, effective, verdicts, running, parts, guide } = ctx
  const c = checks[id]
  if (!c) return null
  const raw = ctx.results[id]
  const eff = effective[id]
  const isRun = !!running[id]
  const custom = c.custom === 'pointer'
  const last = guideIsLast(guide)
  const done = bucketOf(eff) !== 'pending'
  return (
    <>
      <div className="diag-guide-body" data-check={id}>
        <h2 id="diag-guide-title" ref={titleRef} tabIndex={-1}>{t(c.title)}</h2>
        {c.guide && <p className="diag-guide-todo">{t(c.guide)}</p>}
        {!custom && (
          isRun
            ? <button type="button" className="diag-btn big" onClick={() => ctx.onStop(id)}>{t(c.stopLabel)}</button>
            : <button type="button" className="diag-btn primary big" onClick={() => ctx.onStart(id)}>{t(c.startLabel)}</button>
        )}
        <div className="diag-guide-result" aria-live="polite">
          <parts.Badge status={eff ? eff.status : null} running={isRun} />
          <parts.Detail eff={eff} c={c} />
        </div>
        {parts.renderLive(c)}
        <parts.Verdict check={c} raw={raw} verdict={verdicts[id]} onVerdict={ctx.onVerdict} />
        {c.hint && <p className="diag-hint">{t(c.hint)}</p>}
        {!isRun && !(eff && eff.status === 'skipped') && (
          <div className="diag-ctl">
            <button type="button" className="diag-btn ghost" onClick={() => ctx.onSkip(id)}>{custom ? t('這台沒有觸控筆，略過') : t('略過這一項')}</button>
          </div>
        )}
      </div>
      <footer className="diag-guide-foot">
        <button type="button" className="diag-btn" onClick={ctx.onBack}>{t('上一項')}</button>
        <button type="button" className={'diag-btn' + (done ? ' primary' : '')} onClick={ctx.onNext}>{last ? t('完成，看總結') : t('下一項')}</button>
      </footer>
    </>
  )
}

function Summary({ ctx, titleRef }) {
  const t = useT()
  const { plan, checks, effective, parts, guide } = ctx
  const st = guideStats(plan.order, effective)
  return (
    <>
      <div className="diag-guide-body">
        <h2 id="diag-guide-title" ref={titleRef} tabIndex={-1}>{t('互動檢查總結')}</h2>
        <div className="diag-summary five" role="group" aria-label={t('導引總結')}>
          <parts.Chip kind="pass" label={t('通過')} n={st.pass} />
          <parts.Chip kind="fail" label={t('失敗')} n={st.fail} />
          <parts.Chip kind="unsupported" label={t('不支援')} n={st.unsupported} />
          <parts.Chip kind="skipped" label={t('已略過')} n={st.skipped} />
          {st.pending > 0 && <parts.Chip kind="pending" label={t('未完成')} n={st.pending} />}
        </div>
        {st.pending > 0 && <p className="diag-note warn">{t('還有 {n} 項沒有結果或還在等你回答；可以按該項的「重測 / 補做」。', { n: st.pending })}</p>}
        <ul className="diag-guide-list">
          {plan.order.map((id) => {
            const c = checks[id]
            if (!c) return null
            const eff = effective[id]
            const stepIndex = guide.steps.indexOf(id)
            return (
              <li key={id} data-check={id}>
                <div className="diag-row-head">
                  <span className="diag-title">{t(c.title)}</span>
                  <parts.Badge status={eff ? eff.status : null} running={false} />
                </div>
                <parts.Detail eff={eff} c={c} />
                {stepIndex >= 0 && <div className="diag-ctl"><button type="button" className="diag-btn ghost" onClick={() => ctx.onGoto(stepIndex)}>{eff ? t('重測這一項') : t('補做這一項')}</button></div>}
              </li>
            )
          })}
        </ul>
        {ctx.noteNode}
        <div className="diag-actions">
          <button type="button" className="diag-btn primary" onClick={ctx.onCopy}>{t('複製報告')}</button>
          <button type="button" className="diag-btn" onClick={ctx.onDownload}>{t('下載 JSON')}</button>
        </div>
        <p className="diag-msg" role="status" aria-live="polite">{ctx.msgText}</p>
        {ctx.manual && <textarea className="diag-manual" readOnly value={ctx.manual} aria-label={t('報告文字（可手動全選複製）')} onFocus={(e) => e.target.select()} />}
      </div>
      <footer className="diag-guide-foot">
        <button type="button" className="diag-btn" onClick={ctx.onBack}>{t('上一項')}</button>
        <button type="button" className="diag-btn" onClick={ctx.onRestart}>{t('重新做一輪')}</button>
        <button type="button" className="diag-btn primary" onClick={ctx.onLeave}>{t('回到清單')}</button>
      </footer>
    </>
  )
}
