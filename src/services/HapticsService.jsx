// 常駐服務：HapticsService（由 App 掛載一次，不渲染畫面）。
// 訂閱 store 的狀態變化 → 依事件觸發不同節奏的觸覺回饋（手機震動 / 手把雙馬達；事件表與節流見 lib/haptics.js）：
//   ① spawns 計數增加：鯨魚（長而低）/ 海豚（兩短）/ 海龜（緩兩下）/ 淨化波（漸強，力度跟 purifyMeta.v）
//   ② 錄製 / 播放（rec.mode）：開始、停止各有自己的節奏
//   ③ 溢流（seaLevel > 0.97）：進入時一串細碎輕震，之後以固定節奏滴水（audio/engine 的水滴聲沒有可訂閱事件，故用同門檻的計時器）
// 沒有任何裝置支援 / 總開關關閉時，trigger 直接回傳 false，這裡幾乎零成本；離開時取消訂閱、停計時器、停止進行中的震動。
import { useEffect } from 'react'
import { useStore } from '../store/useStore.js'
import { purifyMeta } from '../store/events.js'
import { getHaptics, attachHapticsSource } from '../lib/haptics.js'

export default function HapticsService() {
  useEffect(() => {
    const hp = getHaptics()
    const dispose = attachHapticsSource({
      store: useStore,
      haptics: hp,
      getPurifyV: () => purifyMeta.v,
      isHidden: () => typeof document !== 'undefined' && document.hidden === true,
    })
    // 分頁進背景 → 立刻停（瀏覽器在背景本來也不會震，這裡避免回到前景時殘留）
    const onVis = () => { if (document.hidden) hp.cancel() }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      dispose()
    }
  }, [])
  return null
}
