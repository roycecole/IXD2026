import { useEffect } from 'react'
import { useStore, seriesMeta } from '../store/useStore.js'
import { purifyMeta, padEvents } from '../store/events.js'
import { useLocaleStore, getLocale, applyDocumentLocale, t } from '../i18n/index.js'
import { registerMirror, listMirrors } from '../lib/mirror.js'
import { AUDIENCE_CHANNEL, createHost, createCoreSlices, hostStatus, hostControl } from '../lib/audience.js'

// 常駐服務：AudienceService —— 主視窗（控制台）端的觀眾視窗廣播（協定與節流見 lib/audience.js）。
// 平時只掛一個 BroadcastChannel 監聽（零訂閱、零計時器）；有觀眾視窗 hello 之後才啟動切片訂閱與 ping，最後一個離開就全部收掉。
// 觀眾視窗與主視窗載入同一份程式，核心切片在「兩邊」都要註冊（主視窗用 get / subscribe，觀眾視窗用 apply）——
// 所以註冊函式從這裡匯出，AudienceApp 也呼叫它（每個視窗只註冊一次）。

let coreRegistered = false
export function registerCoreMirrors() {
  if (coreRegistered) return
  coreRegistered = true
  const slices = createCoreSlices({
    store: useStore,
    seriesMeta,
    purifyMeta,
    padEvents,
    locale: {
      get: getLocale,
      // 觀眾視窗套用主視窗的語系：直接改 store + 文件語言，不走 setLocale——它會把語系寫進兩個視窗共用的 localStorage 偏好（主視窗「自動偵測」的人不該被觀眾視窗悄悄存成手動選擇）
      set: (loc) => { if ((loc === 'zh' || loc === 'en') && loc !== getLocale()) { useLocaleStore.setState({ locale: loc }); applyDocumentLocale(loc) } },
      subscribe: (cb) => useLocaleStore.subscribe((s, p) => { if (s.locale !== p.locale) cb() }),
    },
  })
  for (const [key, slice] of slices) registerMirror(key, slice)
}

export default function AudienceService() {
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return undefined   // 舊瀏覽器：沒有雙螢幕功能，其他功能不受影響
    registerCoreMirrors()
    let ch
    try { ch = new BroadcastChannel(AUDIENCE_CHANNEL) } catch (e) { return undefined }
    let lastCount = 0
    const host = createHost({
      channel: ch,
      listSlices: listMirrors,
      onChange: ({ count, active }) => {
        hostStatus.set({ count, active })
        if (count !== lastCount) {   // 連線數變了才記一行（OUT 監看）
          lastCount = count
          useStore.getState().pushLog('out', count > 0 ? t('觀眾視窗連線：{n}', { n: count }) : t('觀眾視窗已全部離線'))
        }
      },
    })
    hostControl.closeAll = () => host.closeAudiences()
    return () => {
      hostControl.closeAll = null
      host.destroy()
      hostStatus.set({ count: 0, active: false })
    }
  }, [])
  return null
}
