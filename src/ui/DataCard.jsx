import { useMemo } from 'react'
import { useStore } from '../store/useStore.js'
import SurveyTimeline from './SurveyTimeline.jsx'
import { birdSeasonal } from '../lib/birds.js'
import { ageFromLunar, moonAge, moonPhaseName } from '../lib/moon.js'
import { seriesFromOption, seriesFromSurvey, seriesFromDust, seriesFromMoon } from '../lib/series.js'
import { dustSummary } from '../lib/describe.js'
import { useT, useLocale, T } from '../i18n/index.js'
import { nameText, weatherText, lunarLabelText, tideRangeText } from '../i18n/data.js'

// 資料區：選海況 → 套用 / 播放；鳥群 / 魚群調查卡（逐月圖 + 套用 / 連動 / 獨立控制 + 年表播放）；資料看板開關。
const PID = { birds: 'birdCount', fish: 'fishCount' }
// 各類別的文字（T() 只標記、原樣回傳中文；顯示時再 t()）
const KIND = {
  birds: {
    name: T('鳥群'), count: T('鳥群數量'),
    group: T('鳥群資料：{basin}'), monthly: T('鳥群逐月物種數，點擊預覽該月'),
    hint: T('該流域鳥類調查的物種數越多，球外的鳥群越多。點長條預覽各月份（斜線＝內插）。'),
    slider: T('鳥群數量（獨立控制）'),
    playTitle: T('依年度播放 {basin} 的鳥群調查：每一步＝一年，沒有調查的年份以內插補上並標示「無調查」，鳥群數量隨當年物種數變化'),
  },
  fish: {
    name: T('魚群'), count: T('魚群數量'),
    group: T('魚群資料：{basin}'), monthly: T('魚群逐月物種數，點擊預覽該月'),
    hint: T('該流域魚類調查的物種數越多，海裡的魚群越多。點長條預覽各月份（斜線＝內插）。'),
    slider: T('魚群數量（獨立控制）'),
    playTitle: T('依年度播放 {basin} 的魚群調查：每一步＝一年，沒有調查的年份以內插補上並標示「無調查」，魚群數量隨當年物種數變化'),
  },
}

function optionLabel(o, t) {
  const name = nameText(o.name)
  if (o.kind === 'tide') return t('{name}（潮汐）', { name })
  if (o.kind === 'dust') return o.level > 0 ? t('{name}（PM10 {level}）', { name, level: o.level }) : t('{name}（PM10 無效 · 看風速）', { name })   // level=0：來源 PM10 感測器回報無效值
  if (o.kind === 'moon') return t('{name}（月出月沒）', { name })
  return t('{name}（水位 {level}%）', { name, level: o.level })
}

// 鳥 / 魚調查卡：資料怎麼變（逐月長條）→ 建議值 → 你可以「套用」、開「連動」，或直接拖滑桿「獨立控制」
function SurveyCard({ kind, opt }) {
  const t = useT()
  const loc = useLocale()
  const K = KIND[kind]
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
  const yearly = useMemo(() => seriesFromSurvey(opt, kind), [opt, kind, loc])   // 逐年序列（含空窗年）；date 文字取建立當下語系，故語系當依賴
  const basin = nameText(d.basin)
  const monthVal = (x) => x.interpolated ? t('{n} 種（內插）', { n: x.value }) : t('{n} 種', { n: x.value })
  const barTitle = (m, x) => {
    const tip = x ? t('{m} 月：{v}', { m: m + 1, v: monthVal(x) }) : t('{m} 月：無資料', { m: m + 1 })
    return m === nowMonth ? t('{v}（現在）', { v: tip }) : tip
  }

  return (
    <div className={'survey-card' + (linked ? ' linked' : '')} role="group" aria-label={t(K.group, { basin })}>
      <div className="survey-head">
        <span className="survey-title">{t(K.name)} · {basin}</span>
        <span className={'survey-state' + (linked ? ' linked' : '')}>{linked ? t('連動資料') : t('獨立控制')}</span>
      </div>
      <div className="survey-hint">
        {t(K.hint)}
      </div>
      <div className="survey-bars" role="group" aria-label={t(K.monthly)}>
        {seasons.map((s, m) => (
          <button key={m} type="button" aria-pressed={m === shown}
                  className={'sbar' + (m === shown ? ' sel' : '') + (s && s.interpolated ? ' interp' : '') + (m === nowMonth ? ' now' : '')}
                  style={{ '--h': (s ? Math.max(6, Math.round((s.value / maxV) * 100)) : 0) + '%' }}
                  title={barTitle(m, s)}
                  onClick={() => setSurveyMonth(m === nowMonth ? null : m)}><i /></button>
        ))}
      </div>
      <div className="survey-axis" aria-hidden="true">
        {[1, 4, 7, 10, 12].map((m, i) => <span key={m}>{i === 0 || loc === 'en' ? t('{m} 月', { m }) : m}</span>)}
      </div>
      <div className="survey-line">
        {t('{m} 月 {v}', { m: shown + 1, v: cur ? monthVal(cur) : '—' })}
        {cur && <span className="dim"> · {t('年均 {n}', { n: cur.mean })}</span>}
        {sg && <span className="survey-suggest"> → {t('建議 {v}', { v: kind === 'birds' ? t('{n} 群', { n: sg.flocks }) : sg.value.toFixed(2) })}</span>}
      </div>
      <div className="survey-slider">
        <span>{t(K.count)}</span>
        <input type="range" min="0" max="1" step="0.01" value={value} aria-label={t(K.slider)}
               onChange={(e) => input(PID[kind], parseFloat(e.target.value))} />
        <span className="pval">{kind === 'birds' ? t('{n} 群', { n: Math.round(value * 5) }) : value.toFixed(2)}</span>
      </div>
      <div className="survey-actions">
        <button type="button" onClick={() => applySurvey(kind)} title={t('把資料建議值寫入「{p}」，並開啟連動', { p: t(K.count) })}>{t('套用資料')}</button>
        <button type="button" className={linked ? 'on' : ''} aria-pressed={linked} onClick={() => setSurveyLink(kind, !linked)}
                title={t('連動：換海況 / 換月份時自動更新；手動拖曳滑桿會自動脫鉤（獨立控制）')}>{linked ? t('連動中') : t('連動')}</button>
        {surveyMonth != null && <button type="button" onClick={() => setSurveyMonth(null)}>{t('回到現在')}</button>}
      </div>
      {yearly && <SurveyTimeline spec={yearly} />}
      {yearly && (
        <button type="button" className="gov-apply gov-series" disabled={recMode !== 'idle'} onClick={() => playSurvey(kind)}
                title={t(K.playTitle, { basin })}>
          ▶ {t('播放調查年表 {a}–{b}', { a: yearly.points[0].t, b: yearly.points[yearly.points.length - 1].t })}
        </button>
      )}
    </div>
  )
}

export default function DataCard() {
  const t = useT()   // 訂閱語系：describe.js / moon.js 等純函式讀「當下語系」，切換時本元件要重繪
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
  const overlays = useStore((s) => s.overlays)
  const setOverlay = useStore((s) => s.setOverlay)

  if (!gov || !gov.options) return null
  const opt = gov.options.find((o) => o.id === govOptionId) || gov.options[0]
  const seriesSpec = seriesFromOption(opt)
  const dustSpec = opt.kind === 'dust' ? seriesFromDust(gov.dust) : null
  const moonSpec = opt.kind === 'moon' ? seriesFromMoon(gov.moon) : null
  const dust = opt.kind === 'dust' ? dustSummary(gov.dust) : null
  const dustHistN = opt.kind === 'dust' && gov.dust && Array.isArray(gov.dust.history) ? gov.dust.history.filter((x) => typeof x.pm10 === 'number' || typeof x.wind === 'number').length : 0
  const anyPlay = !!(seriesSpec || dustSpec || moonSpec || opt.birds || opt.fish)

  // 月相（潮汐 / 月亮海況）：以 CWA 農曆日期推月齡，農曆日期過期則退回天文公式
  let moonLine = ''
  if ((opt.kind === 'tide' || opt.kind === 'moon') && opt.series) {
    const now = new Date()
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const fromLunar = opt.series.date === todayStr ? ageFromLunar(opt.series.lunar, now.getHours() + now.getMinutes() / 60) : null
    const age = fromLunar != null ? fromLunar : moonAge(now)
    moonLine = t('{phase} · 月齡 {age} 天', { phase: moonPhaseName(age), age: age.toFixed(1) }) + (fromLunar != null && opt.series.lunarLabel ? ` · ${lunarLabelText(opt.series.lunarLabel)}${opt.series.range ? ' ' + tideRangeText(opt.series.range) : ''}` : '')
  } else if (opt.kind === 'tide' || opt.kind === 'moon') {
    moonLine = t('{phase} · 月齡 {age} 天', { phase: moonPhaseName(moonAge(new Date())), age: moonAge(new Date()).toFixed(1) })
  }
  // 揚塵播放的資料欄位名（'PM10' 或 '風速'）
  const dustLabel = dustSpec ? (dustSpec.label === T('風速') ? t('風速') : dustSpec.label) : ''
  // 揚塵感測站摘要（各段用「 · 」串接：站名 / 風速 / 濕度）
  const dustLine = dust
    ? [
      dust.pm10 != null
        ? t('揚塵 · {county} {n} 站 · PM10 {v} μg/m³', { county: nameText(dust.county), n: dust.n, v: dust.pm10.toFixed(1) })
        : t('揚塵 · {county} {n} 站 · PM10 無效', { county: nameText(dust.county), n: dust.n }),
      dust.wind != null ? t('風 {n} m/s', { n: dust.wind.toFixed(1) }) : null,
      dust.rh != null ? t('濕度 {n}%', { n: dust.rh.toFixed(0) }) : null,
    ].filter((x) => x != null).join(' · ')
    : ''

  return (
    <div className="gov-card">
      <div className="gov-title">{t('今日海況')} <span className="dim">· {nameText(gov.sourceShort)}</span></div>
      {gov.weather && <div className="gov-metrics">{weatherText(gov.weather.weather)} · {gov.weather.airTemp}°C · {t('風 {n} m/s', { n: gov.weather.windSpeed })}</div>}
      <select className="gov-select" value={govOptionId || ''} onChange={(e) => setGovOption(e.target.value)} aria-label={t('選擇海況資料')}>
        {gov.options.map((o) => <option key={o.id} value={o.id}>{optionLabel(o, t)}</option>)}
      </select>
      <button className="gov-apply" onClick={applyGov}>{t('套用此海況')}</button>
      {dust && (
        <div className="gov-metrics gov-dust" title={t('水資源物聯網（IoW）揚塵感測站最新值：PM10 高 → 海水混濁、垃圾多、色相偏黃綠；風速 → 洋流。PM10 感測器常回傳無效的哨兵值，此時海況以預設 40 μg/m³ 示意、歷史播放改用風速')}>
          {dustLine}
        </div>
      )}
      {moonLine && <div className="gov-metrics gov-moon" title={t('潮汐是月亮的引力：背景月亮的盈虧與位置對應當日月齡與時刻')}>{t('月亮 · {v}', { v: moonLine })}</div>}

      {opt.birds && <SurveyCard kind="birds" opt={opt} />}
      {opt.fish && <SurveyCard kind="fish" opt={opt} />}

      {(seriesSpec || opt.kind === 'dust' || moonSpec || opt.kind === 'moon') && (
        <div className="gov-plays">
          {seriesSpec && (
            <button className="gov-apply gov-series" onClick={playGovSeries} disabled={recMode !== 'idle'}
                    title={t('把 {name} {date} 的{label}時間序列轉成自動化播放', { name: nameText(opt.name), date: opt.series.date || '', label: nameText(opt.series.label) })}>
              ▶ {t('播放 24h {label}資料', { label: nameText(opt.series.label) })}
            </button>
          )}
          {opt.kind === 'dust' && (dustSpec
            ? <button className="gov-apply gov-series" onClick={playDust} disabled={recMode !== 'idle'} title={dustSpec.label === T('風速')
                ? t('播放 CI 累積的揚塵歷史（{label}）：每一步＝一次 3 小時取樣；PM10 感測器目前無效，改以風速驅動洋流與海水混濁', { label: dustLabel })
                : t('播放 CI 累積的揚塵歷史（{label}）：每一步＝一次 3 小時取樣', { label: dustLabel })}>▶ {t('播放揚塵歷史（{label}）{n} 筆', { label: dustLabel, n: dustSpec.points.length })}</button>
            : <p className="hint gov-wait">{t('揚塵歷史累積中（{n} 筆有效）：資料來源只提供「最新值」，排程每 3 小時累積一筆，累積 2 筆有效資料後即可播放（PM10 無效時改用風速）。', { n: dustHistN })}</p>)}
          {opt.kind === 'dust' && dustSpec && dustSpec.stats.max === dustSpec.stats.min && (
            <p className="hint gov-wait">{t('目前累積的 {n} 筆{label}數值完全相同（來源疑似凍結：時戳前進、數值不變），播放看不到變化，等來源更新後才會動。', { n: dustSpec.points.length, label: dustLabel })}</p>
          )}
          {opt.kind === 'moon' && moonSpec && (
            <button className="gov-apply gov-series" onClick={playMoon} disabled={recMode !== 'idle'}
                    title={t('CWA 月出月沒表：每一步＝一天；月亮依真實月出 / 中天 / 月沒時刻與方位在天空移動，中天越高海水越高（示意）')}>
              ▶ {t('播放月出月沒 {n} 天', { n: moonSpec.points.length })}
            </button>
          )}
        </div>
      )}
      {anyPlay && (
        <div className="gov-playctl" aria-label={t('資料播放設定')}>
          {[0.5, 1, 2, 4].map((v) => (
            <button key={v} className={'gov-spd' + (recSpeed === v ? ' on' : '')} aria-pressed={recSpeed === v}
                    onClick={() => setRecSpeed(v)} title={t('播放倍速 ×{v}', { v })}>×{v}</button>
          ))}
          <button className={'gov-spd' + (recLoop ? ' on' : '')} aria-pressed={recLoop}
                  onClick={toggleRecLoop} title={t('播完自動從頭循環')}>{t('循環')}</button>
        </div>
      )}
      <fieldset className="gov-overlays" aria-label={t('畫面顯示')}>
        <legend>{t('畫面顯示（快速鍵 I：全部隱藏 / 顯示）')}</legend>
        <label title={t('畫布左上角：目前海況背後的真實資料與映射（展場很好用）')}>
          <input type="checkbox" checked={overlays.board} onChange={(e) => setOverlay('board', e.target.checked)} />{t('資料看板')}
        </label>
        <label title={t('畫布上緣 / 下緣：資料播放進度、參數數值、待接管旋鈕提示、AR 調整鈕、聲音提示')}>
          <input type="checkbox" checked={overlays.hud} onChange={(e) => setOverlay('hud', e.target.checked)} />{t('播放與參數提示')}
        </label>
        <label title={t('演出模式（H / 雙擊）：角落的掃碼 QR 與合奏統計；關閉後不會自動啟動多人主機')}>
          <input type="checkbox" checked={overlays.qr} onChange={(e) => setOverlay('qr', e.target.checked)} />{t('掃碼 QR（演出模式）')}
        </label>
      </fieldset>
    </div>
  )
}
