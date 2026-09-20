// 「裝置」面板的一節：畫質（自動 / 高 / 中 / 低）。
// 實際的 FPS 量測與換級在 services/QualityService.jsx，狀態機在 lib/quality.js，共用狀態在 lib/qualityStore.js；這裡只管選模式與顯示狀態。
import { useT, useLocale, localeTag, T } from '../../i18n/index.js'
import { useStore } from '../../store/useStore.js'
import { useQualityStore } from '../../lib/qualityStore.js'
import { MODES } from '../../lib/quality.js'
import '../../styles/quality.css'

// 靜態表：用 T() 標記，顯示時再 t()
const MODE_LABEL = { auto: T('自動選擇'), high: T('高畫質'), medium: T('中畫質'), low: T('低畫質') }
const TIER_HINT = {
  high: T('高畫質：完整效果，解析度最高 2 倍像素比。'),
  medium: T('中畫質：解析度上限 1.5 倍，生物與粒子約減 30%。'),
  low: T('低畫質：解析度 1 倍，生物與粒子減半、流星關閉；背景模糊不套用，背景清澈以簡化暗化代替。'),
}

export default function QualitySection() {
  const t = useT()
  const loc = useLocale()
  const mode = useQualityStore((s) => s.mode)
  const tier = useQualityStore((s) => s.tier)
  const fps = useQualityStore((s) => s.fps)
  const paused = useQualityStore((s) => s.paused)
  const reason = useQualityStore((s) => s.reason)
  const overridden = useQualityStore((s) => s.overridden)
  const setMode = useQualityStore((s) => s.setMode)
  const blur = useStore((s) => s.params.bgBlur ?? 0)

  const time = reason ? new Date(reason.at).toLocaleTimeString(localeTag(loc), { hour12: false }) : ''
  return (
    <section className="dev-sec qual-sec" aria-labelledby="qual-title">
      <h3 className="dev-sec-title" id="qual-title">{t('畫質')}</h3>
      <p className="dev-sec-desc">{t('依畫面更新速度（FPS）自動調整解析度與特效，保護較舊的手機與 iPad；也可以手動固定在某一級。')}</p>
      <div className="dev-sec-body">
        <div className="qual-seg" role="group" aria-label={t('畫質模式')}>
          {MODES.map((m) => (
            <button key={m} type="button" className={mode === m ? 'on' : ''} aria-pressed={mode === m} onClick={() => setMode(m)}>{t(MODE_LABEL[m])}</button>
          ))}
        </div>

        <ul className="qual-status">
          <li>{mode === 'auto' ? t('目前等級：{tier}（自動調整）', { tier: t(MODE_LABEL[tier]) }) : t('目前等級：{tier}（手動固定）', { tier: t(MODE_LABEL[tier]) })}</li>
          <li>{fps == null ? t('目前 FPS：量測中') : t('目前 FPS：{fps}', { fps })}</li>
          <li>{reason
            ? t('上次自動降級：{time}，{from} → {to}（{s} 秒平均 {fps} FPS，低於 {threshold}）', { time, from: t(MODE_LABEL[reason.from]), to: t(MODE_LABEL[reason.to]), s: Math.round(reason.windowMs / 1000), fps: reason.fps, threshold: reason.threshold })
            : t('尚未自動降級')}</li>
        </ul>

        <p className="dev-sec-hint">{t(TIER_HINT[tier])}</p>
        {tier === 'low' && blur > 0.02 && <p className="dev-sec-hint warn">{t('目前的背景模糊設定在低畫質下被略過；背景清澈仍有效果，但是簡化版。')}</p>}
        {mode === 'auto' && paused && <p className="dev-sec-hint">{t('調整暫停中：拖曳、錄影，或分頁在背景時不會換級。')}</p>}
        {overridden && <p className="dev-sec-hint">{t('目前的模式來自網址的 ?quality= 參數；在這裡選擇會改存為偏好。')}</p>}
        <p className="dev-sec-hint">{t('只量測畫面更新速度；偏好只存在這台裝置，不會傳送任何資料。')}</p>
      </div>
    </section>
  )
}
