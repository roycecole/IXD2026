import { useMemo } from 'react'
import { useStore } from '../store/useStore.js'
import { useTourStore, buildTour, tourTotalMs, captionText, setAutoIdle, IDLE_MS } from '../lib/tour.js'
import { toggleTour } from '../services/TourService.jsx'
import { useT } from '../i18n/index.js'
import '../styles/tour.css'

// 面板上的「資料導覽」卡片（放在資料卡之後）：開始 / 停止、目前第幾站、閒置自動導覽開關。
export default function TourControls() {
  const t = useT()   // 訂閱語系：captionText 讀「當下語系」
  const gov = useStore((s) => s.gov)
  const recMode = useStore((s) => s.rec.mode)
  const running = useTourStore((s) => s.running)
  const caption = useTourStore((s) => s.caption)
  const index = useTourStore((s) => s.index)
  const total = useTourStore((s) => s.total)
  const autoIdle = useTourStore((s) => s.autoIdle)
  const remote = useTourStore((s) => s.remote)
  const stops = useMemo(() => buildTour(gov), [gov])
  if (remote) return null   // 觀眾視窗沒有面板；保險
  const idleS = Math.round(IDLE_MS / 1000)
  const noData = stops.length === 0
  const busy = !running && recMode !== 'idle'
  const disabled = noData || busy
  const why = noData ? t('導覽需要海況資料，載入完成後才能使用') : busy ? t('等錄製 / 播放結束後才能導覽') : t('開始 / 停止資料導覽（快速鍵 T）')
  return (
    <div className="gov-card tour-card" data-tour-ui role="group" aria-label={t('資料導覽')}>
      <div className="gov-title">{t('資料導覽')}{!noData && <span className="dim"> · {t('共 {n} 站 · 約 {s} 秒', { n: stops.length, s: Math.round(tourTotalMs(stops) / 1000) })}</span>}</div>
      <p className="tour-desc">{t('依序巡演真實資料：水庫、潮汐、月亮、揚塵、鳥、魚、河川測站；畫面下方的字幕說明現在看的是什麼、球為什麼長這樣。')}</p>
      <button type="button" className={'gov-apply tour-btn' + (running ? ' on' : '')} aria-pressed={running} disabled={disabled} title={why}
              onClick={toggleTour}>
        {running ? t('■ 停止導覽') : t('▶ 開始導覽')} <kbd>T</kbd>
      </button>
      {running && (
        <div className="tour-now" aria-live="off">
          {t('第 {n} / {total} 站', { n: index + 1, total })} · {captionText(caption).title}
        </div>
      )}
      <label className="tour-auto" title={t('沒有動作 {s} 秒就自動開始，碰任何東西立即停止並還原；展場模式（?kiosk=1）預設開啟', { s: idleS })}>
        <input type="checkbox" checked={autoIdle} onChange={(e) => setAutoIdle(e.target.checked)} />{t('閒置 {s} 秒自動導覽', { s: idleS })}
      </label>
      {running && <p className="tour-hint">{t('導覽中：任何操作都會停止並還原')}</p>}
    </div>
  )
}
