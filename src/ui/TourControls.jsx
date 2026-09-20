import { useMemo, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useTourStore, buildTour, tourTotalMs, captionText, setAutoIdle, setSpeakFromGesture, supportsNarration, IDLE_MS } from '../lib/tour.js'
import { planToOptions } from '../lib/tourPlan.js'
import { toggleTour } from '../services/TourService.jsx'
import TourNav from './TourNav.jsx'
import TourPlanEditor, { planDisplayName } from './TourPlanEditor.jsx'
import { useT } from '../i18n/index.js'
import '../styles/tour.css'
import '../styles/tourpresenter.css'
import '../styles/tourplan.css'

// 面板上的「資料導覽」卡片（放在資料卡之後）：開始 / 停止、目前腳本、目前第幾站、導覽員控制（跳站 / 暫停 / 複製此站連結 / 念出字幕，與字幕卡同一組）、閒置自動導覽開關、
// 可摺疊的「導覽腳本」編輯器（TourPlanEditor：自訂站序與每站備註，存在這台瀏覽器，可用網址分享）。
// 有生效中的腳本（網址 ?tour=air,fish 或已存 / 已套用的腳本）時，站數與時間、開始導覽都以腳本為準。
// 「念出字幕」勾選時，在同一個手勢處理器內同步解鎖 iOS 的語音（setSpeakFromGesture）。
export default function TourControls() {
  const t = useT()   // 訂閱語系：captionText 讀「當下語系」
  const gov = useStore((s) => s.gov)
  const recMode = useStore((s) => s.rec.mode)
  const running = useTourStore((s) => s.running)
  const caption = useTourStore((s) => s.caption)
  const index = useTourStore((s) => s.index)
  const total = useTourStore((s) => s.total)
  const autoIdle = useTourStore((s) => s.autoIdle)
  const speak = useTourStore((s) => s.speak)
  const paused = useTourStore((s) => s.paused)
  const remote = useTourStore((s) => s.remote)
  const plan = useTourStore((s) => s.plan)
  const planSrc = useTourStore((s) => s.planSrc)
  const [canSpeak] = useState(() => supportsNarration())
  const stops = useMemo(() => buildTour(gov, planToOptions(plan)), [gov, plan])
  if (remote) return null   // 觀眾視窗沒有面板；保險
  const idleS = Math.round(IDLE_MS / 1000)
  const noData = stops.length === 0
  const busy = !running && recMode !== 'idle'
  const disabled = noData || busy
  const loaded = !!(gov && Array.isArray(gov.options) && gov.options.length)
  const planMissing = plan && loaded ? plan.stops.length - stops.length : 0   // 腳本裡目前沒有資料、會被略過的站
  const why = noData ? (plan && loaded ? t('腳本內的站目前都沒有資料，導覽無法開始；請改選其他站或還原預設') : t('導覽需要海況資料，載入完成後才能使用')) : busy ? t('等錄製 / 播放結束後才能導覽') : t('開始 / 停止資料導覽（快速鍵 T）')
  return (
    <div className="gov-card tour-card" data-tour-ui role="group" aria-label={t('資料導覽')}>
      <div className="gov-title">{t('資料導覽')}{!noData && <span className="dim"> · {t('共 {n} 站 · 約 {s} 秒', { n: stops.length, s: Math.round(tourTotalMs(stops) / 1000) })}</span>}</div>
      <p className="tour-desc">{t('依序巡演真實資料：水庫、潮汐、月亮、揚塵、空氣品質（模型資料）、鳥、魚、河川測站；畫面下方的字幕說明現在看的是什麼、球為什麼長這樣。')}</p>
      {plan && (
        <div className="tour-plan-now" data-src={planSrc}>
          {t('目前腳本：{name}（{n} 站）', { name: planDisplayName(plan, planSrc, t), n: plan.stops.length })}
          {planMissing > 0 && !noData && <span className="tour-plan-warn"> · {t('{m} 站目前沒有資料，會略過', { m: planMissing })}</span>}
        </div>
      )}
      {plan && noData && loaded && <p className="tour-plan-warn tour-plan-warn-block" role="note">{t('腳本內的站目前都沒有資料，導覽無法開始；請改選其他站或還原預設')}</p>}
      <button type="button" className={'gov-apply tour-btn' + (running ? ' on' : '')} aria-pressed={running} disabled={disabled} title={why}
              onClick={toggleTour}>
        {running ? t('■ 停止導覽') : t('▶ 開始導覽')} <kbd>T</kbd>
      </button>
      {running && (
        <div className="tour-now" aria-live="off">
          {t('第 {n} / {total} 站', { n: index + 1, total })} · {captionText(caption).title}{paused && <span className="tour-now-paused"> · {t('已暫停')}</span>}
        </div>
      )}
      {running && <TourNav variant="card" />}
      <label className="tour-auto" title={t('沒有動作 {s} 秒就自動開始，碰任何東西立即停止並還原；展場模式（?kiosk=1）預設開啟', { s: idleS })}>
        <input type="checkbox" checked={autoIdle} onChange={(e) => setAutoIdle(e.target.checked)} />{t('閒置 {s} 秒自動導覽', { s: idleS })}
      </label>
      {canSpeak && (
        <label className="tour-auto" title={t('用語音朗讀每一站的字幕；預設關閉，只在這個視窗出聲')}>
          <input type="checkbox" checked={speak} onChange={(e) => setSpeakFromGesture(e.target.checked)} />{t('導覽時念出字幕')}
        </label>
      )}
      <TourPlanEditor />
      {running && <p className="tour-hint">{t('導覽中：任何操作都會停止並還原')}</p>}
      {running && <p className="tour-hint">{t('導覽員：← 上一站、→ 下一站、P 暫停 / 繼續；也可以點進度點直接跳到該站')}</p>}
    </div>
  )
}
