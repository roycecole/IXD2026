import { useEffect, useState, useSyncExternalStore } from 'react'
import { useT, T } from '../../i18n/index.js'
import { AUDIENCE_NAME, hostStatus, hostControl, buildAudienceUrl, requestScreens, planAudienceOpen, readScreenInfo } from '../../lib/audience.js'
import '../../styles/audience.css'

// 「裝置」面板的一節：觀眾視窗（雙螢幕）。
// 筆電操作、投影機給觀眾看：按鈕開一個觀眾視窗，支援 Window Management（Chrome / Edge，需 HTTPS 或 localhost + 使用者授權）就自動放到外接螢幕；
// 其餘情況開一般視窗，請使用者把它拖到投影機畫面。連線狀態（幾個觀眾視窗連著）來自 AudienceService（lib/audience.js 的 hostStatus）。

let popupRef = null   // 這個視窗開出來的觀眾視窗（面板關掉再開仍記得；重整頁面就忘了——關閉時會另外廣播 close 訊息）

// 提示訊息：存 key（T 標記），顯示時才 t()，切語系會跟著換
const NOTES = {
  placed: T('已在另一個螢幕開啟觀眾視窗。點一下該視窗即可進入全螢幕。'),
  focus: T('觀眾視窗已經開著，已切到前景。'),
  single: T('只偵測到一個螢幕，已開啟一般視窗。接上投影機後，請把視窗拖到投影機畫面，再點一下進入全螢幕。'),
  unsupported: T('這個瀏覽器無法自動指定螢幕（需要 Chrome / Edge，且網址為 HTTPS 或 localhost）。已開啟一般視窗：請把視窗拖到投影機畫面，再點一下進入全螢幕。'),
  denied: T('沒有取得多螢幕權限，已開啟一般視窗：請把視窗拖到投影機畫面，再點一下進入全螢幕。之後想自動放置，可在網址列的網站設定允許「視窗管理」。'),
  error: T('讀取螢幕資訊失敗，已開啟一般視窗：請把視窗拖到投影機畫面，再點一下進入全螢幕。'),
  blocked: T('彈出視窗被瀏覽器封鎖。請在網址列允許本網站的彈出視窗，然後再按一次「開啟觀眾視窗」。'),
  retry: T('已取得多螢幕權限，但瀏覽器擋下了這一次的彈出視窗。請再按一次「開啟觀眾視窗」。'),
  closed: T('已要求觀眾視窗關閉。若視窗沒有關閉（不是從這裡開啟的），請直接關掉它。'),
}
const WARN = new Set(['blocked', 'retry', 'denied', 'error', 'unsupported'])

export default function AudienceSection() {
  const t = useT()
  const st = useSyncExternalStore(hostStatus.subscribe, hostStatus.get, hostStatus.get)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null)      // NOTES 的 key
  const [scr, setScr] = useState(null)        // readScreenInfo 的結果

  const supported = typeof BroadcastChannel !== 'undefined'

  // 螢幕數量：面板開著時每 3 秒重讀一次（接上 / 拔掉投影機會更新；已授權才有精確數字，不會跳權限提示）
  useEffect(() => {
    if (!supported) return undefined
    let dead = false
    const read = () => { readScreenInfo(window).then((info) => { if (!dead) setScr(info) }).catch(() => {}) }
    read()
    const iv = setInterval(read, 3000)
    return () => { dead = true; clearInterval(iv) }
  }, [supported])

  if (!supported) return null   // 沒有 BroadcastChannel（很舊的瀏覽器）：整節不顯示

  const open = async () => {
    if (busy) return
    if (popupRef && !popupRef.closed) {   // 已經開著：切到前景就好（同名視窗再 window.open 會被重新載入）
      try { popupRef.focus() } catch (e) { /* ignore */ }
      setNote('focus')
      return
    }
    setBusy(true); setNote(null)
    const askedPermission = !scr || scr.permission !== 'granted'
    const res = await requestScreens(window)          // 可能跳出「視窗管理」權限提示（在按鈕的手勢裡呼叫）
    const plan = planAudienceOpen(res)
    let win = null
    try { win = window.open(buildAudienceUrl(window.location), AUDIENCE_NAME, plan.features) } catch (e) { win = null }
    setBusy(false)
    if (!win) { setNote(res.details && askedPermission ? 'retry' : 'blocked'); return }   // 剛授權完，第一次的彈出視窗常因手勢過期被擋 → 請再按一次
    popupRef = win
    setNote(plan.placed ? 'placed' : plan.reason)
    readScreenInfo(window).then(setScr).catch(() => {})
  }

  const close = () => {
    if (hostControl.closeAll) hostControl.closeAll()   // 廣播 close：連著的觀眾視窗自己關（包含重整前開的、手動開的）
    try { if (popupRef && !popupRef.closed) popupRef.close() } catch (e) { /* ignore */ }
    popupRef = null
    setNote('closed')
  }

  const conn = st.count > 0
  const screenText = scr && scr.count != null
    ? t('偵測到 {n} 個螢幕', { n: scr.count })
    : scr && scr.extended === true ? t('偵測到多個螢幕')
      : scr && scr.extended === false ? t('目前只有 1 個螢幕')
        : t('此瀏覽器無法偵測螢幕數量')

  return (
    <section className="dev-sec">
      <h3 className="dev-sec-title">{t('觀眾視窗（雙螢幕）')}</h3>
      <p className="dev-sec-desc">{t('筆電操作、投影機給觀眾看：開一個觀眾視窗放到外接螢幕，全螢幕顯示同一片海（含資料看板），你的操作即時同步。觀眾視窗沒有控制介面、也不出聲音。')}</p>
      <div className="dev-sec-body">
        <button onClick={open} disabled={busy}>{busy ? t('等待螢幕權限…') : t('開啟觀眾視窗')}</button>
        <button onClick={close} disabled={!conn && !(popupRef && !popupRef.closed)}>{t('關閉觀眾視窗')}</button>
        <div className="aud-status-row" role="status" aria-live="polite">
          <span className={'aud-conn' + (conn ? ' on' : '')}>{conn ? t('{n} 個觀眾視窗已連線', { n: st.count }) : t('尚無觀眾視窗連線')}</span>
          <span>{screenText}</span>
        </div>
        {note && <p className={'aud-note' + (WARN.has(note) ? ' warn' : '')} role="status">{t(NOTES[note])}</p>}
        <p className="dev-sec-hint">{t('資料只在你的瀏覽器內、兩個視窗之間傳遞，不會上傳。自動放到外接螢幕需要 Chrome / Edge、HTTPS（或 localhost）與「視窗管理」權限；Safari / Firefox 會開一般視窗，請手動拖到投影機再點一下進入全螢幕。')}</p>
      </div>
    </section>
  )
}
