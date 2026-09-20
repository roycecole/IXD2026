import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useTourStore, buildTour, applyTourPlan, saveTourPlanAs, activateTourPlan, clearTourPlan, deleteTourPlan } from '../lib/tour.js'
import { copyText } from '../lib/tourLink.js'
import {
  PLAN_LIMITS, MAX_SAVED, draftFromPlan, draftToPlan, draftOnCount, moveRow, toggleRow, setRowNote, setDraftName, countChars, planEquals, isDefaultPlan, buildPlanLink,
} from '../lib/tourPlan.js'
import { useT, T, getLocale } from '../i18n/index.js'
import '../styles/tour.css'
import '../styles/tourpresenter.css'
import '../styles/tourplan.css'

// 「導覽腳本」編輯器（TourControls 的卡片裡，可摺疊）：導覽員自訂要講哪幾站、什麼順序、每站的備註，存在這台瀏覽器（最多 5 份），也能複製成網址分享給其他裝置。
// 用清單編輯，不用拖曳（觸控與鍵盤都好用）：每站一列 = 核取方塊（納入 / 不納入）＋ 站名 ＋「上移 / 下移」按鈕 ＋ 備註輸入（≤120 字，顯示字數）。
// 純邏輯（草稿 / 上下移 / 勾選 / 字數 / 網址編碼 / 儲存）都在 lib/tourPlan.js（Node 可測）；動作（套用 / 另存 / 切換 / 刪除 / 還原）在 lib/tour.js 的 useTourStore。
// 導覽進行中腳本唯讀（提示先結束導覽）：導覽的站表在開始時就定了，中途改腳本會讓進度點與字幕對不上。
// 備註是導覽員輸入的原文：不翻譯；顯示時一律當純文字（React 的文字節點，不會被當成 HTML）；會顯示在字幕上並被旁白念出。
// 每個按鈕都帶 data-tour-ui（點它們不算「操作海」、不會中止導覽）與明確的 aria-label / title；圖示用內嵌 SVG（不用 emoji）。
export const STOP_LABEL = {
  reservoir: T('水庫（今日水位）'), tide: T('潮汐'), moon: T('月亮'), dust: T('揚塵'), air: T('空氣品質（模型資料）'), birds: T('鳥群調查'), fish: T('魚群調查'), stations: T('河川測站星座'),
}

// 操作結果訊息（存 id + 參數，顯示時才 t()：語系中途切換訊息也跟著換）
const MSG = {
  applied: T('已套用腳本（{n} 站），只在這次有效；要保留請按「另存新腳本」'),
  updated: T('已套用，並更新「{name}」（{n} 站）'),
  appliedDefault: T('已套用預設完整導覽'),
  saved: T('已另存為「{name}」（{n} 站）並啟用'),
  full: T('最多只能存 {max} 份腳本，請先刪除一份'),
  deleted: T('已刪除「{name}」'),
  confirmDelete: T('再按一次「刪除」確認刪除「{name}」'),
  reset: T('已還原預設：使用完整導覽（已存的腳本都還在）'),
  none: T('至少要納入一站'),
  running: T('導覽進行中，先結束導覽再修改腳本'),
  noStore: T('這個瀏覽器無法儲存（可能是隱私模式）：腳本只在這次有效'),
  copied: T('已複製腳本連結'),
  copiedTrunc: T('已複製腳本連結，但備註太長放不進網址，連結沒有帶備註'),
  copyFail: T('複製失敗：請手動選取下方的連結來複製'),
  linkFail: T('無法產生連結'),
}

// 卡片上「目前腳本：xxx」的名稱：有名字就用名字；沒有名字時依來源給一個說得出口的稱呼
export function planDisplayName(plan, src, t) {
  if (plan && plan.name) return plan.name
  return src === 'url' ? t('網址腳本') : src === 'saved' ? t('未命名腳本') : t('自訂腳本')
}

const Chevron = ({ dir }) => (
  <svg className="tour-plan-ico" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
    {dir === 'up' ? <path d="M6 15l6-6 6 6" /> : dir === 'down' ? <path d="M6 9l6 6 6-6" /> : <path d="M9 6l6 6-6 6" />}
  </svg>
)

export default function TourPlanEditor({ defaultOpen = false }) {
  const t = useT()
  const uid = useId()
  const gov = useStore((s) => s.gov)
  const running = useTourStore((s) => s.running)
  const plan = useTourStore((s) => s.plan)
  const planSrc = useTourStore((s) => s.planSrc)
  const planId = useTourStore((s) => s.planId)
  const planLib = useTourStore((s) => s.planLib)
  const [open, setOpen] = useState(!!defaultOpen)
  const [draft, setDraft] = useState(() => draftFromPlan(plan))
  const [msg, setMsg] = useState(null)                 // { id, p, kind: 'ok' | 'warn' | 'err' }
  const [link, setLink] = useState('')                 // 複製失敗時的備援：可手動選取複製的連結
  const [confirmDel, setConfirmDel] = useState(false)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const alive = useRef(true)
  const rootRef = useRef(null)
  const focusReq = useRef(null)                        // 上移 / 下移之後，把焦點放回同一列的按鈕（鍵盤與螢幕閱讀器使用者不會迷路）
  const delTimer = useRef(null)
  const clearDelTimer = () => { if (delTimer.current != null) { clearTimeout(delTimer.current); delTimer.current = null } }

  useEffect(() => {                                    // StrictMode 雙掛載：alive 每次掛載重設；卸載一定取消計時器
    alive.current = true
    return () => { alive.current = false; clearDelTimer() }
  }, [])
  // 生效中的腳本被外部改變（切換已存腳本、刪除、還原預設）→ 草稿跟著換；「套用 / 另存」自己造成的變化與草稿相同，不會把使用者正在排的列順序洗掉
  useEffect(() => {
    if (!planEquals(draftToPlan(draftRef.current), plan)) setDraft(draftFromPlan(plan))
  }, [plan])
  useEffect(() => { clearDelTimer(); setConfirmDel(false) }, [planId])
  useEffect(() => {
    const f = focusReq.current
    if (!f) return
    focusReq.current = null
    try {
      const row = rootRef.current && rootRef.current.querySelector('[data-row="' + f.id + '"]')
      const pick = (k) => (row ? row.querySelector('[data-act="' + k + '"]') : null)
      let b = pick(f.kind)
      if (b && b.disabled) b = pick(f.kind === 'up' ? 'down' : 'up')   // 移到頭 / 尾：原本那顆變成停用，改把焦點給另一顆
      if (b && typeof b.focus === 'function') b.focus()
    } catch (e) { /* 焦點只是輔助 */ }
  }, [draft])

  // 哪幾站目前有資料（沒有資料的站導覽會略過）：資料還沒載入時不標
  const have = useMemo(() => (gov && Array.isArray(gov.options) && gov.options.length ? new Set(buildTour(gov).map((s) => s.id)) : null), [gov])

  const rows = draft.rows
  const onCount = draftOnCount(draft)
  const cur = planSrc === 'saved' ? planLib.plans.find((x) => x.id === planId) || null : null
  const full = planLib.plans.length >= MAX_SAVED
  const say = (id, p, kind = 'ok') => setMsg({ id, p: p || null, kind })
  const logIt = (id, p) => { try { const s = useStore.getState(); if (s.pushLog) s.pushLog('out', t(MSG[id], p)) } catch (e) { /* 日誌只是輔助 */ } }
  const fail = (r) => say(r.reason === 'running' ? 'running' : r.reason === 'full' ? 'full' : 'none', r.reason === 'full' ? { max: MAX_SAVED } : null, 'err')
  const edit = (fn) => { setDraft(fn); setMsg(null) }
  const move = (i, delta, kind) => { focusReq.current = { id: rows[i].id, kind }; edit((d) => ({ ...d, rows: moveRow(d.rows, i, delta) })) }

  const onApply = () => {
    const p = draftToPlan(draft)
    if (!p) return say('none', null, 'err')
    const r = applyTourPlan(p)
    if (!r.ok) return fail(r)
    const id = r.saved ? 'updated' : isDefaultPlan(p) ? 'appliedDefault' : 'applied'
    const P = { name: (cur && cur.name) || p.name || t('未命名腳本'), n: p.stops.length }
    if (r.saved && r.persisted === false) say('noStore', null, 'warn')
    else say(id, P)
    logIt(id, P)
  }
  const onSaveNew = () => {
    const p = draftToPlan(draft)
    if (!p) return say('none', null, 'err')
    const name = p.name || t('腳本 {n}', { n: planLib.plans.length + 1 })
    const r = saveTourPlanAs({ ...p, name })
    if (!r.ok) return fail(r)
    setDraft((d) => setDraftName(d, name))
    if (r.persisted === false) say('noStore', null, 'warn')
    else say('saved', { name, n: p.stops.length })
    logIt('saved', { name, n: p.stops.length })
  }
  const onDelete = () => {
    if (!cur) return
    const name = cur.name || t('未命名腳本')
    if (!confirmDel) {                                 // 兩段式確認：第一下只是詢問（不用 window.confirm：會擋住整個頁面，展場的投影機上更糟）
      setConfirmDel(true)
      say('confirmDelete', { name }, 'warn')
      clearDelTimer()
      delTimer.current = setTimeout(() => { delTimer.current = null; if (alive.current) { setConfirmDel(false); setMsg(null) } }, 4000)
      return
    }
    clearDelTimer()
    setConfirmDel(false)
    const r = deleteTourPlan(cur.id)
    if (!r.ok) return fail(r)
    setDraft(draftFromPlan(null))
    say(r.persisted === false ? 'noStore' : 'deleted', r.persisted === false ? null : { name }, r.persisted === false ? 'warn' : 'ok')
    logIt('deleted', { name })
  }
  const onReset = () => {
    const r = clearTourPlan()
    if (!r.ok) return fail(r)
    setDraft(draftFromPlan(null))
    say(r.persisted === false ? 'noStore' : 'reset', null, r.persisted === false ? 'warn' : 'ok')
    logIt('reset')
  }
  const onCopy = async () => {
    const p = draftToPlan(draft)
    if (!p) return say('none', null, 'err')
    let href = ''
    try { href = typeof location !== 'undefined' ? location.href : '' } catch (e) { href = '' }
    const built = buildPlanLink({ href, plan: p, locale: getLocale() })
    if (!built.url) { setLink(''); return say('linkFail', null, 'err') }
    let ok = false
    try { ok = await copyText(built.url) } catch (e) { ok = false }
    if (!alive.current) return
    if (ok) { setLink(''); say(built.truncated ? 'copiedTrunc' : 'copied', null, built.truncated ? 'warn' : 'ok') }
    else { setLink(built.url); say('copyFail', null, 'err') }   // 備援：唯讀輸入框，使用者自己選取複製
  }
  const onPick = (e) => {
    const v = e.target.value
    if (v === '__cur') return
    const r = v ? activateTourPlan(v) : clearTourPlan()
    if (!r.ok) return fail(r)
    if (!v) setDraft(draftFromPlan(null))
    setMsg(null)
  }

  const selectValue = planSrc === 'saved' && cur ? cur.id : plan ? '__cur' : ''
  const nameOf = (id) => t(STOP_LABEL[id])
  const bodyId = uid + '-body'
  return (
    <div className="tour-plan" data-tour-ui ref={rootRef}>
      <button type="button" className="tour-plan-head" data-tour-ui aria-expanded={open} aria-controls={bodyId}
              title={t('導覽腳本：自訂要講哪幾站、順序與每站的備註')} onClick={() => setOpen((v) => !v)}>
        <span className={'tour-plan-chev' + (open ? ' open' : '')}><Chevron dir="right" /></span>
        <span className="tour-plan-head-txt">{t('導覽腳本')}</span>
        {plan && <span className="tour-plan-badge">{t('使用中')}</span>}
      </button>
      {open && (
        <div className="tour-plan-body" id={bodyId}>
          <p className="tour-hint">{t('自訂要講哪幾站、順序與每站的備註（例如只講空氣品質與魚）。備註會顯示在字幕上並被旁白念出；它是你輸入的原文，不會翻譯。')}</p>
          {running && <p className="tour-plan-lock" role="note">{t('導覽進行中，腳本暫時唯讀。先結束導覽（按 T 或「停止導覽」）再修改。')}</p>}
          <fieldset className="tour-plan-fs" disabled={running}>
            <legend className="tour-sr">{t('導覽腳本編輯')}</legend>
            <label className="tour-plan-field">
              <span className="tour-plan-lab">{t('已存腳本')}</span>
              <select className="gov-select tour-plan-select" value={selectValue} onChange={onPick} data-tour-ui title={t('切換啟用的腳本：不同觀眾用不同版本')}>
                <option value="">{t('預設完整導覽（{n} 站）', { n: PLAN_LIMITS.stops })}</option>
                {planLib.plans.map((x) => <option key={x.id} value={x.id}>{t('{name}（{n} 站）', { name: x.name || t('未命名腳本'), n: x.stops.length })}</option>)}
                {plan && !cur && <option value="__cur">{planSrc === 'url' ? t('目前：網址腳本（未儲存）') : t('目前：自訂腳本（未儲存）')}</option>}
              </select>
            </label>
            <label className="tour-plan-field">
              <span className="tour-plan-lab">{t('腳本名稱')}</span>
              <span className="tour-plan-input">
                <input type="text" className="tour-plan-text" value={draft.name} maxLength={PLAN_LIMITS.name} autoComplete="off" spellCheck="false" data-tour-ui
                       placeholder={t('例如：空氣與魚')} aria-describedby={uid + '-name-cnt'} onChange={(e) => edit((d) => setDraftName(d, e.target.value))} />
                <span className="tour-plan-cnt" id={uid + '-name-cnt'}>{countChars(draft.name)} / {PLAN_LIMITS.name}</span>
              </span>
            </label>
            <ol className="tour-plan-list" aria-label={t('導覽站序')}>
              {rows.map((r, i) => {
                const name = nameOf(r.id)
                const cnt = uid + '-c-' + r.id
                return (
                  <li key={r.id} className={'tour-plan-row' + (r.on ? ' on' : '')} data-row={r.id}>
                    <label className="tour-plan-check">
                      <input type="checkbox" checked={r.on} data-tour-ui aria-label={t('納入「{name}」', { name })} onChange={() => edit((d) => ({ ...d, rows: toggleRow(d.rows, i) }))} />
                      <span className="tour-plan-name">{name}</span>
                      {have && !have.has(r.id) && <span className="tour-plan-nodata">{t('目前無資料')}</span>}
                    </label>
                    <span className="tour-plan-move">
                      <button type="button" data-act="up" data-tour-ui className="tour-plan-mv" disabled={i === 0} aria-label={t('上移「{name}」', { name })} title={t('上移一格')} onClick={() => move(i, -1, 'up')}><Chevron dir="up" /></button>
                      <button type="button" data-act="down" data-tour-ui className="tour-plan-mv" disabled={i === rows.length - 1} aria-label={t('下移「{name}」', { name })} title={t('下移一格')} onClick={() => move(i, 1, 'down')}><Chevron dir="down" /></button>
                    </span>
                    <span className="tour-plan-input tour-plan-notewrap">
                      <input type="text" className="tour-plan-text" value={r.note} maxLength={PLAN_LIMITS.note} autoComplete="off" spellCheck="false" data-tour-ui
                             placeholder={t('備註（選填）')} aria-label={t('「{name}」的備註（選填）', { name })} aria-describedby={cnt} onChange={(e) => edit((d) => ({ ...d, rows: setRowNote(d.rows, i, e.target.value) }))} />
                      <span className="tour-plan-cnt" id={cnt}>{countChars(r.note)} / {PLAN_LIMITS.note}</span>
                    </span>
                  </li>
                )
              })}
            </ol>
          </fieldset>
          <p className="tour-plan-count" aria-live="off">{t('已納入 {on} / {n} 站', { on: onCount, n: PLAN_LIMITS.stops })}</p>
          <div className="tour-plan-actions" role="group" aria-label={t('腳本操作')}>
            <button type="button" className="tour-plan-btn primary" data-tour-ui disabled={running || !onCount} title={t('套用：之後的導覽都用這份腳本（目前選的是已存腳本時，會一併更新它）')} onClick={onApply}>{t('套用')}</button>
            <button type="button" className="tour-plan-btn" data-tour-ui disabled={running || !onCount || full} title={full ? t('已存滿 {max} 份，先刪除一份', { max: MAX_SAVED }) : t('另存新腳本：存成新的一份並啟用（最多 {max} 份）', { max: MAX_SAVED })} onClick={onSaveNew}>{t('另存新腳本')}</button>
            <button type="button" className={'tour-plan-btn' + (confirmDel ? ' danger' : '')} data-tour-ui disabled={running || !cur} title={cur ? t('刪除目前選的已存腳本') : t('先在「已存腳本」選一份要刪除的腳本')} onClick={onDelete}>{confirmDel ? t('確定刪除？') : t('刪除')}</button>
            <button type="button" className="tour-plan-btn" data-tour-ui disabled={running} title={t('還原預設：不用腳本，導覽全部 {n} 站（已存的腳本不會被刪掉）', { n: PLAN_LIMITS.stops })} onClick={onReset}>{t('還原預設')}</button>
            <button type="button" className="tour-plan-btn" data-tour-ui disabled={!onCount} title={t('複製腳本連結：貼給別人，開啟後就是這份站序與備註')} onClick={onCopy}>{t('複製腳本連結')}</button>
          </div>
          <p className={'tour-plan-msg' + (msg ? ' ' + msg.kind : '')} role="status" aria-live="polite">{msg ? t(MSG[msg.id], msg.p) : ''}</p>
          {link && (
            <label className="tour-plan-field tour-plan-linkbox">
              <span className="tour-plan-lab">{t('腳本連結（點一下全選，再自行複製）')}</span>
              <input type="text" className="tour-plan-text" readOnly value={link} data-tour-ui onFocus={(e) => { try { e.target.select() } catch (err) { /* ignore */ } }} />
            </label>
          )}
        </div>
      )}
    </div>
  )
}
