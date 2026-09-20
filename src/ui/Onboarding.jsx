import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useT, useLocale } from '../i18n/index.js'
import { attachModalFocus } from '../lib/modalFocus.js'
import {
  onboarding, STEPS, NEXT_LABEL, progressOf, keyToAction, resolveTarget, visibleRectOf, scrollTargetIntoView,
  padRect, placeCard, cardWidthFor, isCompact,
} from '../lib/onboarding.js'
import '../styles/onboarding.css'

// 新手導覽：半透明遮罩 + 目標元素的聚光外框 + 提示卡（進度點、上一步 / 下一步 / 略過）。邏輯與幾何都在 lib/onboarding.js（純函式，有測試）。
// 首次進站自動開始（ui 只負責呼叫 onboarding.autoStart()；要不要顯示由 shouldAutoShow 決定）；說明視窗的「重新看新手導覽」也是開這一個。
// 引導進行中：
//   · 根元素同時帶 modal-backdrop：TourService 靠 document.querySelector('.modal-backdrop') 判斷「有彈窗」，此時閒置導覽不會自動啟動
//     （版面上它是 position:fixed，不佔位；styles/onboarding.css 覆寫成透明、不模糊）
//   · 卡片是 role="dialog" aria-modal：焦點在裡面時 App 的全域快速鍵（T / H / I / 空白鍵…）不會觸發（isInModal）；
//     焦點若被點擊遮罩帶走，這裡會拉回來，並擋下該次鍵盤事件
//   · 目標要看得見：目標在可捲動的面板裡就先捲進視野（結束時還原捲動位置）；目標不存在 / 看不到 → 自動退回置中卡片
//   · 手機（≤ 520px）卡片貼底（bottom sheet）；貼底會蓋住目標時改貼頂
const SPOT_PAD = 6      // 聚光外框比目標大幾 px
const POLL_MS = 500     // 目標可能晚出現（海況資料還在載入）或被別的東西擠開：低頻檢查，關閉即清除

const viewportNow = () => {
  if (typeof document === 'undefined') return { w: 360, h: 640 }
  const de = document.documentElement
  return { w: de.clientWidth || window.innerWidth, h: de.clientHeight || window.innerHeight }
}
const rr = (n) => Math.round(n)
const sameRect = (a, b) => (!a && !b) || (!!a && !!b && rr(a.left) === rr(b.left) && rr(a.top) === rr(b.top) && rr(a.width) === rr(b.width) && rr(a.height) === rr(b.height))
const sameLayout = (a, b) => !!a && sameRect(a.spot, b.spot) && a.place.mode === b.place.mode && a.place.side === b.place.side
  && a.place.left === b.place.left && a.place.top === b.place.top && a.place.width === b.place.width

export default function Onboarding() {
  const st = useSyncExternalStore(onboarding.subscribe, onboarding.getState, onboarding.getState)
  // 首次進站自動開始（StrictMode 會執行兩次：autoStart 每次載入只判斷一次，開著的狀態不會被重設）
  useEffect(() => { onboarding.autoStart() }, [])
  return st.open ? <Dialog index={st.index} source={st.source} /> : null
}

function Dialog({ index, source }) {
  const t = useT()
  const locale = useLocale()
  const step = STEPS[Math.max(0, Math.min(STEPS.length - 1, index))]
  const pr = progressOf(index, STEPS.length)
  const cardRef = useRef(null)
  const firstRun = useRef(true)     // 第一次 layout（剛掛載）不做焦點補救：焦點交給 attachModalFocus，它要記下「開啟前」的焦點才能在結束時還原
  const stepRef = useRef(step)
  stepRef.current = step
  const scrolledEl = useRef(null)   // 已經為它捲過的目標元素（同一個元素不重複捲）
  const scrollLog = useRef([])      // 被我們捲動過的容器與原位置，結束時還原
  const raf = useRef(0)
  const lastSpot = useRef(null)     // 目標暫時消失時保留最後的聚光位置，讓它淡出而不是瞬間消失
  const [lay, setLay] = useState(null)         // { spot, place }
  const [anim, setAnim] = useState(false)      // 第一次定位後才開啟滑動動畫（不要從 (0,0) 飛進來）
  const [targetEl, setTargetEl] = useState(null)

  // 量目標 + 卡片並定位（讀 DOM，不寫；只有結果變了才 setState）
  const measure = useCallback(() => {
    const card = cardRef.current
    if (!card) return
    const vp = viewportNow()
    const hit = resolveTarget(stepRef.current, {
      viewport: vp,
      query: (sel) => document.querySelector(sel),
      prepare: (el) => {
        if (scrolledEl.current === el) return
        scrolledEl.current = el
        scrollTargetIntoView(el, { win: window, doc: document, log: scrollLog.current })
      },
      getRect: (el) => visibleRectOf(el, { win: window, doc: document, viewport: vp }),
    })
    const spot = hit ? padRect(hit.rect, SPOT_PAD, vp) : null
    const place = placeCard({ spot, card: { h: card.offsetHeight }, viewport: vp, compact: isCompact(vp.w) })
    const next = { spot, place }
    setLay((prev) => (sameLayout(prev, next) ? prev : next))
    const el = hit ? hit.el : null
    setTargetEl((prev) => (prev === el ? prev : el))
  }, [])

  const schedule = useCallback(() => {
    if (raf.current) return
    raf.current = requestAnimationFrame(() => { raf.current = 0; measure() })
  }, [measure])

  // 換步 / 換語系（文字長度不同 → 卡片高度不同）：在繪製前重新定位
  useLayoutEffect(() => {
    scrolledEl.current = null
    measure()
    if (firstRun.current) { firstRun.current = false; return }
    // 換步時被移除的按鈕（第一步沒有「上一步」、最後一步沒有「略過」）若剛好有焦點 → 焦點掉到 body，App 的全域快速鍵會在背後動作：拉回卡片
    const card = cardRef.current, ae = document.activeElement
    if (card && (!ae || ae === document.body)) { try { card.focus({ preventScroll: true }) } catch (e) { /* ignore */ } }
  }, [index, locale, measure])

  // 定位套用後：卡片寬度若剛變了（手機 ↔ 桌面、旋轉螢幕），先前量到的高度是舊寬度下的 → 用新寬度再量一次（結果沒變就不會再 setState，不會迴圈）
  useLayoutEffect(() => {
    const card = cardRef.current
    if (lay && card && Math.abs(card.offsetHeight - lay.place.height) > 1 && card.offsetHeight <= viewportNow().h - 16) measure()
  }, [lay, measure])

  // 焦點：進卡片本身（螢幕閱讀器會唸出對話框名稱與 aria-describedby 的內文；容器不畫焦點框，Enter = 下一步）、Esc = 略過、Tab 在卡片內循環、結束後還原
  useEffect(() => attachModalFocus({
    container: cardRef.current,
    onClose: () => onboarding.skip(),
    fallbackSelector: source === 'replay' ? '[data-k="help"]' : undefined,   // 從說明視窗來的：說明視窗已卸載，還給「說明」鈕
  }), [source])

  // → / Enter 下一步、← 上一步
  useEffect(() => {
    const onKey = (e) => {
      const card = cardRef.current
      if (!card) return
      if (!card.contains(e.target) && e.key !== 'Tab' && e.key !== 'Escape') {
        // 焦點被帶到卡片外（例如點了遮罩）：拉回卡片，並擋下這次按鍵，免得 App 的全域快速鍵（T / H / 空白鍵…）在背後動作
        e.stopPropagation()
        try { card.focus({ preventScroll: true }) } catch (err) { /* ignore */ }
      }
      if (e.repeat && e.key === 'Enter') e.preventDefault()   // 按住 Enter 會連續觸發按鈕：一路跳到結束
      const act = keyToAction(e)
      if (!act) return
      e.preventDefault()
      if (e.repeat) return
      if (act === 'next') onboarding.next()
      else onboarding.prev()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // 視窗 resize / 捲動 / 旋轉、目標大小變動、低頻輪詢 → 重算（全部在關閉時取消）
  useEffect(() => {
    window.addEventListener('resize', schedule)
    window.addEventListener('orientationchange', schedule)
    window.addEventListener('scroll', schedule, true)   // scroll 不冒泡：capture 才收得到面板 / 工具列內部的捲動
    const vv = window.visualViewport
    if (vv && typeof vv.addEventListener === 'function') vv.addEventListener('resize', schedule)
    const iv = setInterval(() => { if (!document.hidden) measure() }, POLL_MS)
    return () => {
      window.removeEventListener('resize', schedule)
      window.removeEventListener('orientationchange', schedule)
      window.removeEventListener('scroll', schedule, true)
      if (vv && typeof vv.removeEventListener === 'function') vv.removeEventListener('resize', schedule)
      clearInterval(iv)
      if (raf.current) { cancelAnimationFrame(raf.current); raf.current = 0 }
    }
  }, [schedule, measure])
  useEffect(() => {
    if (!targetEl || typeof ResizeObserver !== 'function') return undefined
    const ro = new ResizeObserver(() => schedule())
    ro.observe(targetEl)
    return () => ro.disconnect()
  }, [targetEl, schedule])

  useEffect(() => {
    const id = requestAnimationFrame(() => setAnim(true))
    return () => cancelAnimationFrame(id)
  }, [])

  // 關閉 / 卸載：把被捲動的面板還原到原位（StrictMode 的假卸載也會走這裡，所以同時歸零 scrolledEl，之後重掛會再捲一次）
  useEffect(() => () => {
    for (const s of scrollLog.current) { try { s.el.scrollTop = s.top; s.el.scrollLeft = s.left } catch (e) { /* ignore */ } }
    scrollLog.current = []
    scrolledEl.current = null
    firstRun.current = true
  }, [])

  const onBackdropMouseDown = (e) => {
    const card = cardRef.current
    if (card && !card.contains(e.target)) { e.preventDefault(); try { card.focus({ preventScroll: true }) } catch (err) { /* ignore */ } }
  }

  const spot = lay ? lay.spot : null
  if (spot) lastSpot.current = spot
  const shown = spot || lastSpot.current
  const place = lay ? lay.place : null
  // 貼底的 bottom sheet 直接用 bottom 對齊視窗底邊（iOS Safari 的網址列收合會讓量到的視窗高度與 fixed 的基準差一截，用 top 算會浮起來）；其餘用 top
  const cardStyle = place
    ? (place.mode === 'sheet' && place.side === 'bottom' ? { left: place.left, top: 'auto', bottom: 8, width: place.width } : { left: place.left, top: place.top, width: place.width })
    : { left: 0, top: 0, width: cardWidthFor(viewportNow().w), opacity: 0 }   // 第一次定位完成前不顯示（useLayoutEffect 會在繪製前算好，使用者看不到這一格）。
    // 不能用 visibility: 'hidden'：瀏覽器不讓 visibility:hidden 的元素取得焦點，而 attachModalFocus 的 focus() 在第一次 commit 的 passive effect 就跑（React 會先 flush 它才做 setLay 觸發的重繪）——
    // 焦點就沒進卡片（螢幕閱讀器聽不到對話框、鍵盤要多按一次）。opacity: 0 的元素照樣可聚焦；卡片 CSS 沒有 opacity 轉場，第二次 commit 移除它就是原樣。
  const progress = t('第 {n} / {total} 步', { n: pr.n, total: pr.total })
  const nextLabel = t(step.nextLabel || NEXT_LABEL)

  return (
    <div className={'modal-backdrop onboard-backdrop' + (spot ? '' : ' no-spot') + (anim ? ' anim' : '')} onMouseDown={onBackdropMouseDown}>
      {shown && <div className="onboard-spot" aria-hidden="true" style={{ left: shown.left, top: shown.top, width: shown.width, height: shown.height, opacity: spot ? 1 : 0 }} />}
      <div ref={cardRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t('新手導覽')} aria-describedby="onboard-content"
           className={'onboard-card' + (anim ? ' anim' : '')} data-mode={place ? place.mode : 'center'} data-side={place ? place.side : 'center'} style={cardStyle}>
        {/* aria-live：換步時螢幕閱讀器會唸出「第 n / N 步」與新的標題、內文（焦點留在按鈕上，不會自己重唸） */}
        <div id="onboard-content" className="onboard-content" aria-live="polite" aria-atomic="true">
          <div className="onboard-progress">
            <span className="onboard-dots" aria-hidden="true">
              {STEPS.map((s, i) => <i key={s.id} className={'onboard-dot' + (i < index ? ' done' : i === index ? ' cur' : '')} />)}
            </span>
            <span className="onboard-count">{progress}</span>
          </div>
          <h2 className="onboard-title">{t(step.title)}</h2>
          <p className="onboard-body">{t(step.body)}</p>
        </div>
        <div className="onboard-actions">
          {!pr.last && <button type="button" className="onboard-skip" onClick={() => onboarding.skip()} title={t('略過（Esc）')}>{t('略過')}</button>}
          <span className="onboard-spacer" />
          {!pr.first && <button type="button" className="onboard-prev" onClick={() => onboarding.prev()} title={t('上一步（←）')}>{t('上一步')}</button>}
          <button type="button" className="onboard-next" onClick={() => onboarding.next()} title={t('下一步（→ 或 Enter）')}>{nextLabel}</button>
        </div>
      </div>
    </div>
  )
}
