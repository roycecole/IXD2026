// 「裝置」面板的一節：相機手勢（張手＝海面平靜、捏合＝召喚鯨魚）。
// 只負責開關與狀態顯示；背後的相機 / 模型 / 偵測在 services/GestureService.jsx（useHandsStore 是兩邊共用的狀態）。
import { useMemo } from 'react'
import { useT } from '../../i18n/index.js'
import { useHandsStore, setGestureEnabled, gestureSupport, stateLabel, errorKey } from '../../lib/hands.js'
import '../../styles/gestures.css'

const DETAIL_CODES = ['load', 'detect', 'camera', 'busy']   // 這幾種錯誤附上瀏覽器給的原始訊息，方便除錯

export default function GestureSection() {
  const t = useT()
  const enabled = useHandsStore((s) => s.enabled)
  const phase = useHandsStore((s) => s.phase)
  const error = useHandsStore((s) => s.error)
  const camera = useHandsStore((s) => s.camera)
  const delegate = useHandsStore((s) => s.delegate)
  const state = useHandsStore((s) => s.state)
  const calm = useHandsStore((s) => s.calm)
  const support = useMemo(() => gestureSupport(), [])

  let status = null
  if (!support.ok) status = { cls: 'err', text: t(errorKey(support.code)) }
  else if (phase === 'loading') status = { cls: 'load', text: t('載入手勢模型中…（第一次需下載約 8 MB 的模型與 WebAssembly 運算程式，之後由瀏覽器快取）') }
  else if (phase === 'running') {
    const src = camera === 'shared' ? t('共用 AR 實景的相機') : t('前鏡頭')
    status = { cls: 'run', text: t('使用中 · {src} · {delegate}', { src, delegate: delegate || 'CPU' }) + ' · ' + t('偵測到：{state}', { state: stateLabel(t, state) }) + (calm ? ' · ' + t('平靜中') : '') }
  } else if (phase === 'error' && error) {
    status = { cls: 'err', text: t(errorKey(error.code)) + (error.detail && DETAIL_CODES.includes(error.code) ? ` (${error.detail})` : '') }
  } else status = { cls: '', text: t('已關閉（打開後才會要求相機權限）') }

  return (
    <section className="dev-sec" aria-labelledby="dev-gesture-title">
      <h3 className="dev-sec-title" id="dev-gesture-title">{t('相機手勢')}</h3>
      <p className="dev-sec-desc">{t('用相機看你的手，不必碰螢幕：張手讓海面平靜，捏合召喚鯨魚。')}</p>
      <div className="dev-sec-body">
        <label className="gesture-toggle" aria-disabled={!support.ok}>
          <input type="checkbox" checked={enabled} disabled={!support.ok} onChange={(e) => setGestureEnabled(e.target.checked)} />
          {t('啟用相機手勢')}
        </label>
        <p className={'dev-sec-hint gesture-status ' + status.cls + (status.cls === 'err' ? ' warn' : '')} role="status" aria-live="polite">
          <i className="gesture-dot" aria-hidden="true" />
          <span>{status.text}</span>
        </p>
        <ul className="gesture-list">
          <li><b>{t('張手')}</b>{t('五指張開並停留約半秒：洋流、游動速度與垃圾漸漸平靜；放手後不會彈回，其他輸入可以立刻接手。')}</li>
          <li><b>{t('捏合')}</b>{t('拇指與食指捏在一起：召喚一隻鯨魚（每 3 秒最多一次，捏著不放不會重複）。')}</li>
        </ul>
        <p className="dev-sec-hint">{t('手放在鏡頭前、光線充足、手心朝向相機效果最好；其他手勢都會被忽略。已開啟 AR 實景時，手勢會直接共用實景的相機。')}</p>
        <p className="dev-sec-hint">{t('隱私：影像只在這台裝置上處理，不會上傳也不會錄下來；關閉開關或離開頁面就會停止相機。手勢模型檔（約 8 MB，來自 Google）與運算程式（WebAssembly，來自 jsDelivr）第一次會下載，之後由瀏覽器快取。')}</p>
      </div>
    </section>
  )
}
