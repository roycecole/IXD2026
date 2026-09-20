import { useStore } from '../store/useStore.js'
import { birdSeasonal } from '../lib/birds.js'
import { ageFromLunar, moonAge, moonPhaseName } from '../lib/moon.js'
import { seriesFromOption, seriesFromSurvey, seriesFromDust, seriesFromMoon } from '../lib/series.js'
import { dustSummary } from '../lib/describe.js'

// 資料區：選海況 → 套用 / 播放；鳥群 / 魚群調查卡（逐月圖 + 套用 / 連動 / 獨立控制 + 年表播放）；資料看板開關。
const KIND_NAME = { birds: '鳥群', fish: '魚群' }
const PID = { birds: 'birdCount', fish: 'fishCount' }

function optionLabel(o) {
  if (o.kind === 'tide') return `${o.name}（潮汐）`
  if (o.kind === 'dust') return `${o.name}（PM10 ${o.level || '—'}）`
  if (o.kind === 'moon') return `${o.name}（月出月沒）`
  return `${o.name}（水位 ${o.level}%）`
}

// 鳥 / 魚調查卡：資料怎麼變（逐月長條）→ 建議值 → 你可以「套用」、開「連動」，或直接拖滑桿「獨立控制」
function SurveyCard({ kind, opt }) {
  const d = opt[kind]
  const surveyMonth = useStore((s) => s.surveyMonth)
  const linked = useStore((s) => s.surveyLink[kind])
  const value = useStore((s) => s.params[PID[kind]])
  const recMode = useStore((s) => s.rec.mode)
  const setSurveyMonth = useStore((s) => s.setSurveyMonth)
  const applySurvey = useStore((s) => s.applySurvey)
  const setSurveyLink = useStore((s) => s.setSurveyLink)
  const input = useStore((s) => s.input)
  const playSurvey = useStore((s) => s.playSurvey)

  const nowMonth = new Date().getMonth()
  const shown = surveyMonth != null ? surveyMonth : nowMonth
  const seasons = Array.from({ length: 12 }, (_, m) => birdSeasonal(d.monthly, m))
  const cur = seasons[shown]
  const maxV = Math.max(1, ...seasons.map((s) => (s ? s.value : 0)))
  const sg = useStore.getState().surveySuggest(kind) // 依 surveyMonth / 選項重新渲染（已訂閱 surveyMonth，選項變更時父層重繪）
  const yearly = seriesFromSurvey(opt, kind)
  const nm = KIND_NAME[kind]

  return (
    <div className={'survey-card' + (linked ? ' linked' : '')} role="group" aria-label={`${nm}資料：${d.basin}`}>
      <div className="survey-head">
        <span className="survey-title">{nm} · {d.basin}</span>
        <span className={'survey-state' + (linked ? ' linked' : '')}>{linked ? '連動資料' : '獨立控制'}</span>
      </div>
      <div className="survey-hint">
        {kind === 'birds' ? '該流域鳥類調查的物種數越多，球外的鳥群越多。' : '該流域魚類調查的物種數越多，海裡的魚群越多。'}點長條預覽各月份（斜線＝內插）。
      </div>
      <div className="survey-bars" role="group" aria-label={`${nm}逐月物種數，點擊預覽該月`}>
        {seasons.map((s, m) => (
          <button key={m} type="button" aria-pressed={m === shown}
                  className={'sbar' + (m === shown ? ' sel' : '') + (s && s.interpolated ? ' interp' : '') + (m === nowMonth ? ' now' : '')}
                  style={{ '--h': (s ? Math.max(6, Math.round((s.value / maxV) * 100)) : 0) + '%' }}
                  title={`${m + 1} 月：${s ? s.value + ' 種' + (s.interpolated ? '（內插）' : '') : '無資料'}${m === nowMonth ? '（現在）' : ''}`}
                  onClick={() => setSurveyMonth(m === nowMonth ? null : m)}><i /></button>
        ))}
      </div>
      <div className="survey-axis" aria-hidden="true"><span>1 月</span><span>4</span><span>7</span><span>10</span><span>12</span></div>
      <div className="survey-line">
        {shown + 1} 月 {cur ? `${cur.value} 種${cur.interpolated ? '（內插）' : ''}` : '—'}
        {cur && <span className="dim"> · 年均 {cur.mean}</span>}
        {sg && <span className="survey-suggest"> → 建議 {kind === 'birds' ? `${sg.flocks} 群` : sg.value.toFixed(2)}</span>}
      </div>
      <div className="survey-slider">
        <span>{nm}數量</span>
        <input type="range" min="0" max="1" step="0.01" value={value} aria-label={`${nm}數量（獨立控制）`}
               onChange={(e) => input(PID[kind], parseFloat(e.target.value))} />
        <span className="pval">{kind === 'birds' ? `${Math.round(value * 5)} 群` : value.toFixed(2)}</span>
      </div>
      <div className="survey-actions">
        <button type="button" onClick={() => applySurvey(kind)} title={`把資料建議值寫入「${nm}數量」，並開啟連動`}>套用資料</button>
        <button type="button" className={linked ? 'on' : ''} aria-pressed={linked} onClick={() => setSurveyLink(kind, !linked)}
                title="連動：換海況 / 換月份時自動更新；手動拖曳滑桿會自動脫鉤（獨立控制）">{linked ? '連動中' : '連動'}</button>
        {surveyMonth != null && <button type="button" onClick={() => setSurveyMonth(null)}>回到現在</button>}
      </div>
      {yearly && (
        <button type="button" className="gov-apply gov-series" disabled={recMode !== 'idle'} onClick={() => playSurvey(kind)}
                title={`依年度播放 ${d.basin} 的${nm}調查：每一步＝一個調查年度，${nm}數量隨當年物種數變化`}>
          ▶ 播放調查年表 {yearly.points[0].t}–{yearly.points[yearly.points.length - 1].t}
        </button>
      )}
    </div>
  )
}

export default function DataCard() {
  const gov = useStore((s) => s.gov)
  const govOptionId = useStore((s) => s.govOptionId)
  const setGovOption = useStore((s) => s.setGovOption)
  const applyGov = useStore((s) => s.applyGov)
  const playGovSeries = useStore((s) => s.playGovSeries)
  const playDust = useStore((s) => s.playDust)
  const playMoon = useStore((s) => s.playMoon)
  const recMode = useStore((s) => s.rec.mode)
  const recSpeed = useStore((s) => s.rec.speed)
  const recLoop = useStore((s) => s.rec.loop)
  const setRecSpeed = useStore((s) => s.setRecSpeed)
  const toggleRecLoop = useStore((s) => s.toggleRecLoop)
  const showBoard = useStore((s) => s.showBoard)
  const setShowBoard = useStore((s) => s.setShowBoard)

  if (!gov || !gov.options) return null
  const opt = gov.options.find((o) => o.id === govOptionId) || gov.options[0]
  const seriesSpec = seriesFromOption(opt)
  const dustSpec = opt.kind === 'dust' ? seriesFromDust(gov.dust) : null
  const moonSpec = opt.kind === 'moon' ? seriesFromMoon(gov.moon) : null
  const dust = opt.kind === 'dust' ? dustSummary(gov.dust) : null
  const anyPlay = !!(seriesSpec || dustSpec || moonSpec || opt.birds || opt.fish)

  // 月相（潮汐 / 月亮海況）：以 CWA 農曆日期推月齡，農曆日期過期則退回天文公式
  let moonLine = ''
  if ((opt.kind === 'tide' || opt.kind === 'moon') && opt.series) {
    const now = new Date()
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const fromLunar = opt.series.date === todayStr ? ageFromLunar(opt.series.lunar, now.getHours() + now.getMinutes() / 60) : null
    const age = fromLunar != null ? fromLunar : moonAge(now)
    moonLine = `${moonPhaseName(age)} · 月齡 ${age.toFixed(1)} 天` + (fromLunar != null && opt.series.lunarLabel ? ` · ${opt.series.lunarLabel}${opt.series.range ? ' ' + opt.series.range + '潮' : ''}` : '')
  } else if (opt.kind === 'tide' || opt.kind === 'moon') {
    moonLine = `${moonPhaseName(moonAge(new Date()))} · 月齡 ${moonAge(new Date()).toFixed(1)} 天`
  }

  return (
    <div className="gov-card">
      <div className="gov-title">今日海況 <span className="dim">· {gov.sourceShort}</span></div>
      {gov.weather && <div className="gov-metrics">{gov.weather.weather} · {gov.weather.airTemp}°C · 風 {gov.weather.windSpeed} m/s</div>}
      <select className="gov-select" value={govOptionId || ''} onChange={(e) => setGovOption(e.target.value)} aria-label="選擇海況資料">
        {gov.options.map((o) => <option key={o.id} value={o.id}>{optionLabel(o)}</option>)}
      </select>
      <button className="gov-apply" onClick={applyGov}>套用此海況</button>
      {dust && (
        <div className="gov-metrics gov-dust" title="水資源物聯網（IoW）揚塵感測站最新值：PM10 高 → 海水混濁、垃圾多、色相偏黃綠；風速 → 洋流">
          揚塵 · {dust.county} {dust.n} 站 · PM10 {dust.pm10 != null ? dust.pm10.toFixed(1) : '—'} μg/m³
          {dust.wind != null && <> · 風 {dust.wind.toFixed(1)} m/s</>}
        </div>
      )}
      {moonLine && <div className="gov-metrics gov-moon" title="潮汐是月亮的引力：背景月亮的盈虧與位置對應當日月齡與時刻">月亮 · {moonLine}</div>}

      {opt.birds && <SurveyCard kind="birds" opt={opt} />}
      {opt.fish && <SurveyCard kind="fish" opt={opt} />}

      {(seriesSpec || opt.kind === 'dust' || moonSpec || opt.kind === 'moon') && (
        <div className="gov-plays">
          {seriesSpec && (
            <button className="gov-apply gov-series" onClick={playGovSeries} disabled={recMode !== 'idle'}
                    title={`把 ${opt.name} ${opt.series.date || ''} 的${opt.series.label}時間序列轉成自動化播放`}>
              ▶ 播放 24h {opt.series.label}資料
            </button>
          )}
          {opt.kind === 'dust' && (dustSpec
            ? <button className="gov-apply gov-series" onClick={playDust} disabled={recMode !== 'idle'} title="播放 CI 累積的揚塵歷史（PM10 / 風速）：每一步＝一次 6 小時取樣">▶ 播放揚塵歷史 {dustSpec.points.length} 筆</button>
            : <p className="hint gov-wait">揚塵歷史累積中（{(gov.dust && gov.dust.history ? gov.dust.history.length : 0)} 筆）：資料來源只提供「最新值」，排程每 6 小時累積一筆，累積 2 筆後即可播放。</p>)}
          {opt.kind === 'moon' && moonSpec && (
            <button className="gov-apply gov-series" onClick={playMoon} disabled={recMode !== 'idle'}
                    title="CWA 月出月沒表：每一步＝一天；月亮依真實月出 / 中天 / 月沒時刻與方位在天空移動，中天越高海水越高（示意）">
              ▶ 播放月出月沒 {moonSpec.points.length} 天
            </button>
          )}
        </div>
      )}
      {anyPlay && (
        <div className="gov-playctl" aria-label="資料播放設定">
          {[0.5, 1, 2, 4].map((v) => (
            <button key={v} className={'gov-spd' + (recSpeed === v ? ' on' : '')} aria-pressed={recSpeed === v}
                    onClick={() => setRecSpeed(v)} title={`播放倍速 ×${v}`}>×{v}</button>
          ))}
          <button className={'gov-spd' + (recLoop ? ' on' : '')} aria-pressed={recLoop}
                  onClick={toggleRecLoop} title="播完自動從頭循環">循環</button>
        </div>
      )}
      <label className="gov-board" title="在畫布左上角顯示目前海況背後的真實資料與映射（展場很好用）">
        <input type="checkbox" checked={showBoard} onChange={(e) => setShowBoard(e.target.checked)} />在畫面顯示資料看板
      </label>
    </div>
  )
}
