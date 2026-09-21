// 常駐服務：導覽員遙控（手機當導覽員遙控器）的主畫面端；不渲染畫面。
// 邏輯在 src/lib/tourRemote.js（純函式 / 可注入依賴，Node 可測）；這裡只把它接上真實的導覽執行器 / 活動時間戳 / 連線層：
//   · 建立 createGuideHost（驗證 guide token、導覽員連線集合、指令 → tourRunner）並 attach 給 lib/multiplayer.js（它把 hello / 指令訊息轉進來）
//   · 只在「有導覽員連線」時才訂閱 useTourStore 與每 2 秒補推（createGuideSync）：沒人用導覽員遙控時，這個服務什麼都不跑
//   · 導覽員指令走 touchGuide()（只記時間，不中止導覽）與 noteRemoteActivity()（遙控「有人在」）——絕不呼叫 touch()
// StrictMode 雙掛載安全：effect 可重複執行，cleanup 會退訂 / 清計時器 / 拆掉 attach。
import { useEffect } from 'react'
import { useStore } from '../store/useStore.js'
import { touchGuide } from '../store/activity.js'
import { useTourStore, setSpeak, supportsNarration } from '../lib/tour.js'
import { noteRemoteActivity } from '../lib/remoteDispatch.js'
import { multiState, attachGuideHost } from '../lib/multiplayer.js'
import { createGuideHost, createGuideSync, countdownExtra } from '../lib/tourRemote.js'
import { tourRunner } from './tourCore.js'
import { t } from '../i18n/index.js'

// 狀態酬載的附加欄位：旁白偏好 / 這台有沒有語音合成 / 海況資料是否已載入 / 主畫面是否正在錄製或播放（busy：導覽開不起來，tour.js 的 start 會回 false）（遙控頁據此顯示「開始導覽」能不能按與原因）
//   + 倒數（選用）：這一站還剩多少毫秒（tourRunner.remainingMs()，暫停時凍結）與這一站的總長（current().stop.durationMs）——遙控頁據此顯示倒數與進度條。
//   不另外開計時器：換站 / 暫停 / 繼續時 tourStore 一變就推（createGuideSync），其餘由每 2 秒的補推帶著。沒在跑 / 取不到 → 不帶這兩個欄位（舊版遙控頁 / 舊版主畫面的行為不變）。
function guideExtra() {
  let ready = false
  try { const g = useStore.getState().gov; ready = !!(g && Array.isArray(g.options) && g.options.length) } catch (e) { /* 取不到就當沒資料 */ }
  let busy = false
  try { busy = useStore.getState().rec.mode !== 'idle' } catch (e) { /* 取不到就當沒有在忙 */ }
  return { speak: !!useTourStore.getState().speak, canSpeak: supportsNarration(), ready, busy, ...countdownExtra(tourRunner) }   // countdownExtra 取不到 / 丟例外都回 {}：不能影響導覽狀態推送
}

function guideLog(event, n) {
  const s = useStore.getState()
  if (!s.pushLog) return
  if (event === 'join') s.pushLog('in', t('導覽員遙控器已連線（{n} 支）', { n }))
  else if (event === 'leave') s.pushLog('in', t('導覽員遙控器已離線（剩 {n} 支）', { n }))
}

export default function TourRemoteService() {
  useEffect(() => {
    const host = createGuideHost({
      runner: tourRunner,
      tourStore: useTourStore,
      touchGuide,
      noteActivity: noteRemoteActivity,
      now: () => performance.now(),
      getToken: () => multiState.guide,      // 目前 host session 的 token（host 重建時換新）
      setSpeak,
      getExtra: guideExtra,
      log: guideLog,
    })
    const sync = createGuideSync({ tourStore: useTourStore, payload: () => host.payload(), broadcast: (m) => host.broadcast(m) })
    const refresh = () => { if (host.size() > 0) sync.start(); else sync.stop() }
    const offChange = host.onChange(refresh)
    const detach = attachGuideHost(host)
    refresh()
    return () => { offChange(); sync.stop(); detach(); host.clear() }
  }, [])
  return null
}
