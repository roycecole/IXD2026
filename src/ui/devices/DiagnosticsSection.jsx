// 「裝置」面板的一節：裝置診斷（連結 + 上次診斷摘要）。
// 診斷頁本身是獨立的 ?diagnostics=1（src/DiagnosticsApp.jsx，不載 three / 主畫面）；這裡只放一個開新分頁的連結與「上次診斷」的摘要，
// 摘要從 localStorage 讀（見 lib/diagnosticsSummary.js，刻意不 import 診斷邏輯本體，主 bundle 不會變大）。
// 診斷頁在另一個分頁寫入摘要時會觸發 storage 事件，這裡就地更新。
import { useEffect, useState } from 'react'
import { useT, useLocale, localeTag } from '../../i18n/index.js'
import { DIAG_LS_KEY, loadSummary, formatWhen, diagnosticsHref } from '../../lib/diagnosticsSummary.js'
import '../../styles/diagnostics.css'

export default function DiagnosticsSection() {
  const t = useT()
  const locale = useLocale()
  const [sum, setSum] = useState(() => loadSummary())

  useEffect(() => {
    const on = (e) => { if (!e || e.key == null || e.key === DIAG_LS_KEY) setSum(loadSummary()) }
    window.addEventListener('storage', on)
    return () => window.removeEventListener('storage', on)
  }, [])

  return (
    <section className="dev-sec diag-sec" aria-labelledby="diag-sec-title">
      <h3 className="dev-sec-title" id="diag-sec-title">{t('裝置診斷')}</h3>
      <p className="dev-sec-desc">{t('展前在現場的實際硬體逐項檢查：相機、麥克風、語音、震動、AR、雙螢幕、觸控筆…，並可匯出報告。診斷頁不會上傳任何東西。')}</p>
      <div className="dev-sec-body">
        <a className="diag-open" href={diagnosticsHref(locale)} target="_blank" rel="noopener noreferrer">{t('開啟裝置診斷')}</a>
        <span className="diag-last" role="status">
          {sum
            ? t('上次診斷：{when}，通過 {pass} 項、失敗 {fail} 項', { when: formatWhen(sum.at, localeTag(locale)), pass: sum.pass, fail: sum.fail })
            : t('還沒有診斷紀錄')}
        </span>
      </div>
    </section>
  )
}
