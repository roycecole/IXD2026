// 常駐服務：展場防呆（由 App 掛載一次，不渲染畫面）。
// 邏輯全在 src/lib/resilience.js（環境可注入、Node 可測）；這裡只把它接上主畫面的真實環境：
//   · 閒置判斷：max(activity.last（人為輸入時間戳）, activity.guideAt（導覽員的 ← → P / 點導覽卡，不能用 touch()——會中止導覽）) + store.rec.mode
//     + 導覽狀態（lib/tour.js 的 useTourStore / 執行器的 current().auto）+ 彈窗（.modal-backdrop，與 tourCore 同一個判斷）+ WebXR 工作階段（手機的 AR 桌面：重載會直接結束它）。
//   · 資料更新：換掉 store.gov「只換資料」，保留使用者目前選的海況選項、不呼叫 applyGov（不動海況與參數）；成功時寫一行 OUT 日誌。
//   · WebGL context 遺失復原（.canvas-wrap canvas）/ 渲染看門狗（?kiosk 或 ?watchdog=1）/ 版本檢查 / ?reload=HH 每日重載 —— 由 startGuards 依網址旗標啟動。
// 觀眾視窗（?audience=1）不渲染 Services，它的防呆由 ErrorBoundary 啟動（資料更新由 AudienceApp 註冊 lib/resilience.js 的 dataHooks，全螢幕中不因新版而重載）。
// StrictMode 雙掛載：effect 可重複執行，cleanup 會停掉所有計時器 / 監聽 / 排定的重載。
import { useEffect } from 'react'
import { useStore } from '../store/useStore.js'
import { activity } from '../store/activity.js'
import { useTourStore } from '../lib/tour.js'
import { tourRunner } from './tourCore.js'
import { t } from '../i18n/index.js'
import { startGuards, pickOptionId } from '../lib/resilience.js'
import { getXrController } from '../lib/xr.js'

// 讀目前的忙碌狀態（每次呼叫才讀，不快取；只在檢查 / 重試時呼叫，不在渲染路徑上）
export function readIdleState() {
  let idleMs = 0
  try { idleMs = performance.now() - Math.max(activity.last, Number.isFinite(activity.guideAt) ? activity.guideAt : -Infinity) } catch (e) { idleMs = 0 }   // 導覽員剛操作過（60 秒內）也算有人在場
  let recMode = 'idle'
  try { recMode = useStore.getState().rec.mode } catch (e) { /* ignore */ }
  let tourRunning = false, tourAuto = false
  try { tourRunning = !!useTourStore.getState().running } catch (e) { /* ignore */ }
  try { const cur = tourRunner && typeof tourRunner.current === 'function' ? tourRunner.current() : null; tourAuto = !!(cur && cur.auto) } catch (e) { /* 導覽執行器的介面若改了：退回「導覽進行中 = 忙」的保守判斷 */ }
  let modalOpen = false
  try { modalOpen = !!document.querySelector('.modal-backdrop') } catch (e) { /* ignore */ }
  let xrActive = false
  try { xrActive = !!getXrController().isActive() } catch (e) { /* ignore */ }
  return { idleMs, recMode, tourRunning, tourAuto, modalOpen, xrActive }
}

// 只換資料：保留目前的海況選項（新資料裡還在才算），參數一個都不碰（不呼叫 applyGov / applySurveyLinked）
export function applyGovData(d) {
  const st = useStore.getState()
  useStore.setState({ gov: d, govOptionId: pickOptionId(d, st.govOptionId) })
}

export default function ResilienceService() {
  useEffect(() => {
    const handle = startGuards({
      env: {
        idleState: readIdleState,
        getLocalFetchedAt: () => { const g = useStore.getState().gov; return g ? g.fetchedAt : null },
        applyData: applyGovData,
        onDataApplied: (d) => { useStore.getState().pushLog('out', t('資料已更新 · {time}', { time: String(d.fetchedAt || '') })) },
      },
    })
    return () => handle.stop()
  }, [])
  return null
}
