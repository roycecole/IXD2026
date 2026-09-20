import { useEffect, useRef } from 'react'
import { useT, useLocale } from '../i18n/index.js'
import { attachModalFocus } from '../lib/modalFocus.js'
import { onboarding } from '../lib/onboarding.js'
import InfoZh from './info/InfoZh.jsx'
import InfoEn from './info/InfoEn.jsx'
import '../styles/onboarding.css'

const EVENT_URL = 'https://ixda.kktix.cc/events/ixda-member-2026'

// 說明視窗外殼（標題、關閉、隊伍資訊、開始探索）；正文依語系渲染 InfoZh / InfoEn（含行內標記，不逐句 t()）。
// 首次進站不再自動彈出這個長篇說明，改由 <Onboarding/>（一步一步的新手導覽）帶；長篇說明留在「說明」鈕後面：
// 上方一段極短的「快速上手」，其餘依主題放在可摺疊區塊（預設收合），並提供「重新看新手導覽」按鈕。
// 鍵盤 / 螢幕閱讀器：role="dialog" aria-modal → 開啟時焦點移進來、Esc 關閉、Tab 在視窗內循環、焦點在裡面時 T / H / 空白鍵等全域快速鍵不會在背後動作
// （見 lib/modalFocus.js）。關閉後焦點只還給「真的開啟它的那顆按鈕」（沒有就不動：例如按 ? 開啟時，不把焦點硬塞給「說明」鈕，否則接著按空白鍵會又打開它）。
export default function InfoModal({ onClose }) {
  const t = useT()
  const locale = useLocale()
  const ref = useRef(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => attachModalFocus({ container: ref.current, onClose: () => closeRef.current && closeRef.current() }), [])
  const Body = locale === 'en' ? InfoEn : InfoZh
  // 「重新看新手導覽」：先關說明視窗（App 的 closeInfo），再開導覽（導覽是常駐的全域單例，見 lib/onboarding.js）
  const replay = () => { onClose(); onboarding.open('replay') }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div ref={ref} tabIndex={-1} className="modal info-modal" role="dialog" aria-modal="true" aria-label={t('MidiSea 資料導演台')} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{t('MidiSea 資料導演台')}</h2>
          <button onClick={onClose} aria-label={t('關閉')}>✕</button>
        </div>

        <Body replay={<button type="button" className="info-replay" onClick={replay}>{t('重新看新手導覽')}</button>} />

        <div className="modal-about">
          <div>{t('本作品為')} <b>{t('IxDA Taiwan 2026 會員工作坊「AI 共生黑客鬆」')}</b></div>
          <div>{t('隊伍：')}<b>{t('12組 卡加布列島')}</b></div>
          <a href={EVENT_URL} target="_blank" rel="noopener noreferrer">{t('前往活動頁面 ↗')}</a>
        </div>

        <button className="modal-start" onClick={onClose}>{t('開始探索')}</button>
      </div>
    </div>
  )
}
