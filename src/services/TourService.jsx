// 常駐服務：TourService＝資料導覽（由 App 掛載一次，不渲染畫面）。
// 導覽的邏輯在 src/lib/tour.js（純函式 + 可注入的執行器）；接線（tourRunner、閒置判斷、中斷 / 隱藏 / 閒置計時的掛鉤）在 ./tourCore.js（非 React，Node 可測）；
// 這裡只把它們放進 useEffect：
//   · 導覽進行中：每 100ms 偵測中斷 / 換站（節流輪詢，停止即清除）；capture 階段的 pointerdown / keydown 讓「使用者的第一個動作」
//     發生在「已還原」的狀態上（先還原、再讓事件往下傳）——非 DOM 輸入（MIDI / 語音 / 遙控 / 手把）走 activity.touch() 的同步掛鉤，見 tourCore.js。
//   · 長駐：離開頁面 / 分頁隱藏 / 卸載時一律結束並還原；閒置計時把點擊、按鍵、播放結束都算活動。
// 觀眾視窗（remote）不跑導覽：字幕由 lib/tour.js 註冊的 mirror 切片送過來。
import { useEffect } from 'react'
import { useTourStore } from '../lib/tour.js'
import { tourRunner, attachRunningGuards, attachTourGuards } from './tourCore.js'

export { tourRunner, startTour, stopTour, toggleTour, tourIdleTick } from './tourCore.js'

export default function TourService() {
  const running = useTourStore((s) => s.running)

  // 導覽進行中：輪詢中斷 / 換站（100ms；停止就清掉）
  useEffect(() => {
    if (!running) return
    const iv = setInterval(() => tourRunner.tick(performance.now()), 100)
    return () => clearInterval(iv)
  }, [running])

  // 導覽進行中：碰螢幕 / 按鍵 → 立刻結束並還原（capture）
  useEffect(() => {
    if (!running) return
    return attachRunningGuards(window)
  }, [running])

  // 長駐：活動掛鉤（非 DOM 輸入先中止再動作）、隱藏 / 離開頁面中止、閒置計時
  useEffect(() => attachTourGuards({ win: window, doc: document }), [])

  return null
}
