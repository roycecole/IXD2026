import { useMemo } from 'react'
import Sparkline from './Sparkline.jsx'
import { useT } from '../i18n/index.js'
import { airCompare, airObsUsable } from '../lib/airCompare.js'
import { airCompareText, airObsWhereText, airObsSummary, airObsPmText } from '../lib/describe.js'
import '../styles/air.css'

// 空氣品質：資料卡 / 資料看板的「模型 vs 觀測」元件（純呈現：沒有 store 依賴，播放位置由呼叫端以 hour 傳入，好測、也不會因播放而重繪整張資料卡）。
//   · AirSparkline：PM2.5 迷你折線（模型 = 琥珀色；有環境部觀測 → 再疊一條綠色的觀測；缺值斷線；marker = 播放中的那一小時）。沒有 ≥ 2 個有效小時 → 不渲染
//   · AirModelSpark：沒有觀測時，模型 PM2.5 的單條折線 + 說明（永遠顯示）
//   · AirCompareCard：有觀測且與模型重疊 ≥ 3 小時時的「模型 vs 觀測」小卡（折線、圖例、一句話結論、出處與授權、距離的但書）
//   · AirDriveToggle：「驅動海況的資料」切換（環境部觀測 / 模型資料）——有可用的觀測才出現
// 誠實：模型一律標「模型資料（Open-Meteo / CAMS），非政府觀測」；觀測標「環境部○○站觀測」並附授權「政府資料開放授權條款－第1版」。

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
export const hourLabel = (iso) => String(iso || '').slice(5, 16).replace('T', ' ')   // 與 series.js 的 fmtT 同一格式：'MM-DD HH:MM'

// air → { hours: ISO[], model: (number|null)[], obs: (number|null)[]|null, cmp }（有觀測且能比 → 對齊後的時間軸；否則只有模型逐時）。沒有任何模型 PM2.5 → null
export function airLines(air) {
  const cmp = airCompare(air)
  if (cmp) return { hours: cmp.hours, model: cmp.model, obs: cmp.obs, cmp }
  const hist = air && Array.isArray(air.history) ? air.history : []
  const hours = hist.map((x) => (x && x.t) || ''), model = hist.map((x) => num(x && x.pm25))
  return model.filter((v) => v !== null).length >= 2 ? { hours, model, obs: null, cmp: null } : null
}
const range = (arr) => { const v = (arr || []).filter((x) => x !== null); return v.length ? [Math.round(Math.min(...v)), Math.round(Math.max(...v))] : null }

export function AirSparkline({ air, height = 28, hour = null }) {
  const t = useT()
  const L = useMemo(() => airLines(air), [air])
  if (!L) return null
  const marker = hour ? L.hours.findIndex((h) => hourLabel(h) === hour) : -1
  const [mlo, mhi] = range(L.model) || [0, 0]
  const label = L.obs
    ? t('模型（Open-Meteo / CAMS，非政府觀測）與{where}觀測的 PM2.5 折線圖：近 {n} 小時；模型 {mlo}–{mhi}、觀測 {olo}–{ohi} μg/m³', { where: airObsWhereText(L.cmp.station.name), n: L.hours.length, mlo, mhi, olo: (range(L.obs) || [0, 0])[0], ohi: (range(L.obs) || [0, 0])[1] })
    : t('近 {n} 小時的模型 PM2.5 折線圖（Open-Meteo / CAMS，非政府觀測）：{lo}–{hi} μg/m³', { n: L.hours.length, lo: mlo, hi: mhi })
  return <Sparkline points={L.model} obs={L.obs || undefined} height={height} marker={marker >= 0 ? marker : undefined} ariaLabel={label} />
}

// 沒有環境部觀測時：模型 PM2.5 的單條折線（120 小時）。spark：折線本身（呼叫端傳入會隨播放更新的版本；SSR / 測試可傳靜態的）
export function AirModelSpark({ air, spark }) {
  const t = useT()
  const L = useMemo(() => airLines(air), [air])
  if (!L || L.obs) return null
  const [lo, hi] = range(L.model)
  return (
    <div className="gov-air-spark">
      <div className="air-cmp-head">
        <span className="air-cmp-title">{t('近 {n} 小時 PM2.5（模型）', { n: L.hours.length })}</span>
        <span className="air-cmp-range">{lo}–{hi} μg/m³</span>
      </div>
      {spark}
    </div>
  )
}

export function AirCompareCard({ air, spark }) {
  const t = useT()
  const L = useMemo(() => airLines(air), [air])
  if (!L || !L.cmp) return null
  const { cmp } = L
  const where = airObsWhereText(cmp.station.name)
  const obs = air && air.obs ? air.obs : {}
  const link = typeof obs.sourceUrl === 'string' && /^https:\/\//.test(obs.sourceUrl) ? obs.sourceUrl : ''
  const km = typeof cmp.station.km === 'number' && Number.isFinite(cmp.station.km) ? cmp.station.km : null
  return (
    <div className="gov-air-compare" role="group" aria-label={t('模型 vs 觀測')}>
      <div className="air-cmp-head">
        <span className="air-cmp-title">{t('模型 vs 觀測')}</span>
        <span className="air-cmp-range">{t('近 {n} 小時 PM2.5（μg/m³）', { n: L.hours.length })}</span>
      </div>
      {spark}
      <div className="air-cmp-legend">
        <span className="air-key air-key-model">{t('模型（非政府觀測）')}</span>
        <span className="air-key air-key-obs">{t('{where}觀測', { where })}</span>
      </div>
      <p className="air-cmp-sum">{airCompareText(cmp)}</p>
      <p className="air-cmp-credit">
        {t('模型：Open-Meteo / CAMS（非政府觀測）；觀測：{where}（{license}）', { where, license: t('政府資料開放授權條款－第1版') })}
        {link && <> · <a href={link} target="_blank" rel="noopener noreferrer">{t('環境部資料開放平台')}</a></>}
      </p>
      {km != null && <p className="air-cmp-caveat">{t('測站離模型格點約 {km} 公里；模型是數十公里的粗網格，落差不全是模型的誤差。', { km })}</p>}
    </div>
  )
}

// 資料卡空氣品質區塊的「觀測」一行（與模型那一行並列，各有各的標籤）
export function AirObsLine({ air }) {
  const t = useT()
  const o = useMemo(() => airObsSummary(air), [air])
  if (!o) return null
  return (
    <div className="gov-metrics gov-air-line gov-air-obs-line" title={t('環境部空氣品質監測網的測站觀測：離模型格點最近的測站，最新一小時的逐時值')}>
      <span className="gov-air-badge gov-air-badge-obs">{t('環境部觀測')}</span>{' '}
      {airObsWhereText(o.station)} · {airObsPmText(o)}{o.t ? ' · ' + hourLabel(o.t) : ''}
    </div>
  )
}

// 「驅動海況的資料」：環境部觀測 / 模型資料。drive：目前實際使用的來源（'obs' | 'model'）；沒有可用的觀測 → 不渲染
export function AirDriveToggle({ air, drive, onChange }) {
  const t = useT()
  if (!airObsUsable(air)) return null
  const opts = [
    ['obs', t('環境部觀測'), t('用環境部測站觀測的逐時 PM2.5 驅動海況（政府資料開放授權條款－第1版）')],
    ['model', t('模型資料'), t('用 Open-Meteo / CAMS 模型的逐時 PM2.5 驅動海況（模型資料，非政府觀測）')],
  ]
  return (
    <div className="air-drive" role="group" aria-label={t('驅動海況的資料')}>
      <span className="air-drive-label">{t('驅動海況的資料')}</span>
      {opts.map(([id, text, title]) => (
        <button key={id} type="button" className={'air-drive-btn air-drive-' + id + (drive === id ? ' on' : '')} aria-pressed={drive === id} title={title}
                onClick={() => { if (drive !== id && typeof onChange === 'function') onChange(id) }}>{text}</button>
      ))}
    </div>
  )
}
