import { useLocaleLoading, useLocaleFailed, translate } from './index.js'
import '../styles/langnotice.css'

// 語言鈕旁的「載入英文字典」狀態提示（主畫面 TopBar / 手機遙控頁 / 診斷頁的語言鈕共用）。
//   · 載入中：只有螢幕閱讀器的 live 文字（視覺上是語言鈕變暗、游標變 progress，見 langnotice.css；快的載入不閃一條提示）
//   · 失敗：畫面上方一條短暫提示（約 FAIL_NOTICE_MS 秒後自己消失），不能只有 console。
//     文字是「英文 / 中文」雙語字面量：失敗的正是英文字典，t() 在這種時候拿不到英文，所以英文半句直接寫在程式裡、中文半句走 translate('zh', …)（i18n 掃描器認得）。
//     'retry'（載入逾時：還在跑、只是太慢）→ 再按一次 EN 重試；'reload'（硬失敗）→ 再按一次 EN 會整頁重新載入（見 i18n/index.js 的 toggleLocale）。
// 語言鈕本身要自己接 aria-busy：useLocaleLoading()（見各處的 lang 按鈕）。
// 函式（不是模組頂層常數）：translate() 不能在 import 當下呼叫（i18n.test.mjs 的結構檢查守住）；'zh' 固定不看目前語系，這裡只是圖它被掃描器認得。
export const langNoticeText = (kind) => {
  if (kind === 'loading') return 'Loading English… / ' + translate('zh', '載入英文中…')
  if (kind === 'reload') return 'English failed to load — press EN again to reload the page / ' + translate('zh', '英文載入失敗，再按一次「EN」會重新整理頁面')
  if (kind === 'retry') return 'English failed to load — press EN again to retry / ' + translate('zh', '英文載入失敗，再按一次「EN」重試')
  return ''
}

export default function LangNotice() {
  const loading = useLocaleLoading()
  const failed = useLocaleFailed()
  const text = failed ? langNoticeText(failed === 'reload' ? 'reload' : 'retry') : loading ? langNoticeText('loading') : ''
  // 一直渲染同一個 live region（內容才換）：螢幕閱讀器才會念出後來塞進去的文字
  return <span className={'lang-notice' + (failed ? ' is-failed' : ' is-sr')} role="status" aria-live="polite">{text}</span>
}
