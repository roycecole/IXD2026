// 展場角落的極小維運指示燈：畫面右下角一顆約 8px 的小點，不開維運面板就能知道防呆現在好不好。
// 形狀 + 顏色（不能只靠顏色）：
//   綠 = 實心圓：一切正常
//   琥珀 = 空心圓帶點：有事在等——新版在等閒置 / 資料更新排隊中 / 遙控器使用中延後重載 / 崩潰紀錄近 10 分鐘有事件
//   紅 = 實心三角：看門狗判定卡死 / WebGL 遺失中 / 熔斷停止快速重載（halted）/ 即將重載
//   灰 = 虛線圓：防呆未啟用（尚未啟動、開發版）
// 互動：hover / 鍵盤聚焦 / 點一下 → 一行狀態文字（例如「新版 5115d8… 等待閒置（有人操作中）」），並附「開啟維運面板」（點工具列的 [data-k="devices"]；
//   找不到——演出模式、?kiosk 隱藏了工具列——就不顯示連結）。點一下釘住、再點 / 點別處 / Esc 收起。
// 預設：展場（?kiosk）顯示、一般不顯示；偏好 LS.oplight（'on' | 'off'，「裝置」面板 → 維運的開關）；?oplight=1 / 0 只覆寫這一次、不寫偏好（見 lib/resilience.js 的 resolveOpLightPref）。
// 這是維運指示、不是資訊面板：演出模式（H）與 ?hud=0 下仍顯示（不看 overlays.hud），只有偏好能關掉。
// 由 services/ResilienceService.jsx 以 portal 掛到 document.body（z-index 低於彈窗；不擋操作：只有圓點本身與展開的文字收指標）。
// 觀眾視窗（投影機）不掛：畫面是給觀眾看的，而且入口 chunk 不能 import store。
// 判斷全在 lib/resilience.js 的 deriveOpsLight（純函式）；這裡只把 code 轉成文字。不在渲染路徑做昂貴的事：訂閱 opsStatus（很少變）+ 每 30 秒重讀一次崩潰紀錄（讓「近 10 分鐘」自然過期）。
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useT, T } from '../i18n/index.js'
import { flagOn } from '../lib/urlFlags.js'
import { opsStatus, getCrashLog, deriveOpsLight, resolveOpLightPref, readOpLightSaved } from '../lib/resilience.js'
import { BUSY_WHY } from './devices/OpsSection.jsx'
import '../styles/resilience.css'

const REFRESH_MS = 30 * 1000
const PIN_MS = 15 * 1000                   // 點一下釘住的文字，這麼久沒動作就自己收起（不留在展場畫面上）
const HIDE_DELAY_MS = 200                  // 游標從圓點移到文字之間的空隙，給一點時間不閃掉
const LEVEL_LABEL = { ok: T('維運指示燈：正常'), warn: T('維運指示燈：需注意'), bad: T('維運指示燈：異常'), off: T('維運指示燈：未啟用') }
const RELOAD_LABEL = { webgl: T('顯示引擎中斷'), watchdog: T('畫面停止更新') }
const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k)
const shortId = (id) => (id && id.length > 6 ? id.slice(0, 6) + '…' : id || '?')
const search = () => { try { return globalThis.location ? String(globalThis.location.search || '') : '' } catch (e) { return '' } }
const listCrashes = () => { try { return getCrashLog().list() } catch (e) { return [] } }
const findOpsButton = () => { try { return typeof document !== 'undefined' ? document.querySelector('[data-k="devices"]') : null } catch (e) { return null } }

// deriveOpsLight 的一個 item → 一行文字（t 必須是當下語系的 t：呼叫端 useT()）
export function itemText(t, item) {
  const why = (r) => (r && has(BUSY_WHY, r) ? t(BUSY_WHY[r]) : t(BUSY_WHY.active))
  switch (item.code) {
    case 'ok': return t('一切正常')
    case 'off': return t('防呆未啟用')
    case 'off-dev': return t('防呆未啟用（開發版）')
    case 'halted': return t('異常過多：已停止快速重新載入，約 {m} 分鐘後會再試一次', { m: item.m })
    case 'halted-manual': return t('已停止自動重新載入，請人工處理')
    case 'reloading': return has(RELOAD_LABEL, item.reason) ? t('偵測到異常（{why}），即將重新載入…', { why: t(RELOAD_LABEL[item.reason]) }) : t('即將重新載入頁面')
    case 'stalled': return t('偵測到畫面停止更新（看門狗）')
    case 'gl-lost': return t('顯示引擎暫時中斷，嘗試恢復中…')
    case 'version-wait': return t('新版 {id} 等待閒置（{why}）', { id: shortId(item.id), why: why(item.why) })
    case 'version-soon': return t('新版 {id} 即將重新載入', { id: shortId(item.id) })
    case 'version-manual': return t('有新版 {id}（已關閉自動重新載入）', { id: shortId(item.id) })
    case 'data-wait': return item.why ? t('新資料等待閒置（{why}）', { why: why(item.why) }) : t('新資料即將更新')
    case 'events': return t('近 10 分鐘崩潰紀錄有 {n} 筆事件', { n: item.n })
    default: return ''
  }
}

// 純顯示（好測）：level 決定形狀 / 顏色；open 時顯示文字與（有工具列才有的）開啟維運面板連結
export function OpsLightView({ level, line, label, open, canOpenOps, popId, openOpsText, onToggle, onOpenOps, handlers = {}, rootRef }) {
  return (
    <div className="res-light" ref={rootRef} data-level={level}>
      <button type="button" className="res-light-dot" data-level={level} aria-label={label} aria-expanded={!!open} aria-controls={open ? popId : undefined}
              title={open ? undefined : label} onClick={onToggle} {...handlers}>
        <i aria-hidden="true" />
      </button>
      {open && (
        <div className="res-light-pop" id={popId} data-level={level} {...handlers}>
          <span className="res-light-text">{line}</span>
          {canOpenOps && <button type="button" className="res-light-link" onClick={onOpenOps}>{openOpsText}</button>}
        </div>
      )}
    </div>
  )
}

// 有 hooks 的本體（測試可直接 SSR 它；正式由 OpsLight 以 portal 掛到 body）。defaultPinned：一開始就展開（測試用；正式不帶）
export function OpsLightBody({ defaultPinned = false }) {
  const t = useT()
  const st = useSyncExternalStore(opsStatus.subscribe, opsStatus.get, opsStatus.get)
  const pref = resolveOpLightPref({ search: search(), saved: readOpLightSaved(), kiosk: flagOn(search(), 'kiosk') })   // 偏好在 st.oplightRev 變動時重讀（st 變了就重繪）
  const show = pref.show
  const [entries, setEntries] = useState(() => (show ? listCrashes() : []))
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  const [pinned, setPinned] = useState(!!defaultPinned)
  const rootRef = useRef(null)
  const hideTimer = useRef(0)
  const popId = useId()
  const open = hover || focus || pinned            // 三種展開方式（滑鼠 hover / 鍵盤聚焦 / 點一下釘住）任一個成立就展開：Esc 也要對三種都有效（必須在 hooks 區、早於 !show 的 return）

  // 崩潰紀錄：狀態有變（新增事件）就重讀，另外每 30 秒重讀一次（讓「近 10 分鐘」過期、也撈到合併重複錯誤的最新時間）
  useEffect(() => {
    if (!show) return undefined
    setEntries(listCrashes())
    const id = setInterval(() => setEntries(listCrashes()), REFRESH_MS)
    return () => clearInterval(id)
  }, [show, st.crashRev])

  // 開發版：主控台可用 window.__opsStatus 模擬各種狀態（正式建置整段不存在）
  useEffect(() => {
    if (!(import.meta.env && import.meta.env.DEV) || typeof window === 'undefined') return undefined
    window.__opsStatus = opsStatus
    return () => { if (window.__opsStatus === opsStatus) delete window.__opsStatus }
  }, [])

  // 點一下釘住：一段時間沒動作 / 點別處 → 收起
  useEffect(() => {
    if (!pinned) return undefined
    const id = setTimeout(() => setPinned(false), PIN_MS)
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setPinned(false) }
    document.addEventListener('pointerdown', onDown, true)
    return () => { clearTimeout(id); document.removeEventListener('pointerdown', onDown, true) }
  }, [pinned])
  // Esc：展開中（不論是 hover / 鍵盤聚焦 / 釘住）都收起。以前只在「釘住」時才登記監聽，Tab 聚焦展開後按 Esc 沒有反應（與檔頭與 README 寫的不符）。
  // 不 stopPropagation：導覽（tourCore）與彈窗自己的 Esc 處理照常運作；焦點留在圓點上，下次聚焦（Tab 離開再回來）才會再展開。
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => { if (e.key === 'Escape') { clearTimeout(hideTimer.current); setHover(false); setFocus(false); setPinned(false) } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  useEffect(() => () => clearTimeout(hideTimer.current), [])
  // 偏好被關掉 / 指示燈隱藏時，展開狀態一併重置（不留下卡住的 hover / 釘住）
  useEffect(() => { if (!show) { setHover(false); setFocus(false); setPinned(false) } }, [show])

  if (!show) return null
  const derived = deriveOpsLight({ status: st, entries, now: Date.now() })
  const texts = derived.items.map((it) => itemText(t, it)).filter(Boolean)
  const line = texts.slice(0, 2).join(' · ')
  const levelLabel = t(LEVEL_LABEL[derived.level])
  const label = derived.level === 'ok' ? levelLabel : `${levelLabel} · ${texts.join(' · ')}`
  const canOpenOps = open ? !!findOpsButton() : false

  const mouseLike = (e) => e.pointerType === 'mouse' || e.pointerType === 'pen' || e.pointerType === undefined   // 觸控點一下會補發 hover：只認滑鼠 / 手寫筆
  const handlers = {
    onPointerEnter: (e) => { if (!mouseLike(e)) return; clearTimeout(hideTimer.current); setHover(true) },
    onPointerLeave: (e) => { if (!mouseLike(e)) return; clearTimeout(hideTimer.current); hideTimer.current = setTimeout(() => setHover(false), HIDE_DELAY_MS) },
    onFocus: (e) => { let vis = true; try { vis = e.target.matches(':focus-visible') } catch (err) { /* 舊瀏覽器：一律當作鍵盤聚焦 */ } if (vis) setFocus(true) },
    onBlur: (e) => { if (rootRef.current && e.relatedTarget && rootRef.current.contains(e.relatedTarget)) return; setFocus(false) },   // 焦點在圓點與「開啟維運面板」之間移動時不收起（否則 Tab 到連結前它就被卸載了）
  }
  const openOps = () => {
    const b = findOpsButton()
    setPinned(false); setHover(false); setFocus(false)
    if (b && typeof b.click === 'function') b.click()
  }
  return (
    <OpsLightView level={derived.level} line={line} label={label} open={open} canOpenOps={canOpenOps} popId={popId} openOpsText={t('開啟維運面板')}
                  onToggle={() => setPinned((p) => !p)} onOpenOps={openOps} handlers={handlers} rootRef={rootRef} />
  )
}

export default function OpsLight() {
  if (typeof document === 'undefined' || !document.body) return null
  return createPortal(<OpsLightBody />, document.body)
}
