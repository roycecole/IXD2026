// 空氣品質「模型 vs 觀測」UI 的測試：AirCompareCard / AirModelSpark / AirObsLine / AirDriveToggle / AirSparkline，以及整張 DataCard / DataBoard（store 以假的取代）。
// esbuild 打包 .jsx 後以 react-dom/server 渲染（i18n 保持外部模組，讓測試與被測元件共用同一份語系實例）。執行：node --test src/ui/AirCompareCard.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { loadEnDict, HAN } from '../../scripts/i18n-check.mjs'
import { registerEn, setLocale, getLocale } from '../i18n/index.js'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const CACHE_DIR = join(ROOT, 'node_modules', '.cache', 'midisea-air-ui-test')
const { dict } = await loadEnDict(); registerEn(dict)

// 假的 store（各個被打包的元件共用同一份 globalThis 狀態）：不用 zustand——SSR 時 zustand 的 hook 讀的是「建立當下的初始狀態」（getServerSnapshot），之後 setState 的內容看不到；這裡直接讀一份可變的物件
const STORE_STUB = `
const state = (globalThis.__airTestState ||= {
  gov: null, govOptionId: null, surveyMonth: null, surveyLink: { birds: false, fish: false }, params: { birdCount: 0.5, fishCount: 0.5 },
  rec: { mode: 'idle', speed: 1, loop: false, playhead: 0 }, overlays: { board: true, hud: true, qr: false },
  setGovOption: () => {}, applyGov: () => {}, playGovSeries: () => {}, playDust: () => {}, playMoon: () => {}, playAir: () => {}, setRecSpeed: () => {}, toggleRecLoop: () => {}, setOverlay: () => {},
  applyParams: () => {}, pushLog: () => {}, input: () => {}, setSurveyMonth: () => {}, applySurvey: () => {}, setSurveyLink: () => {}, playSurvey: () => {}, surveySuggest: () => null,
})
export const seriesMeta = (globalThis.__airTestSeriesMeta ||= { active: false, kind: '', points: [], step: 0.2, extra: {} })
export const useStore = (selector = (s) => s) => selector(state)
useStore.getState = () => state
useStore.setState = (patch) => { Object.assign(state, typeof patch === 'function' ? patch(state) : patch) }
useStore.subscribe = () => () => {}
globalThis.__airTestStore = useStore
`
// SSR 用的 i18n：useT / useLocale 直接讀「當下語系」（zustand 的 hook 在 SSR 只回初始語系 zh），其餘匯出照舊（同一份語系實例與字典）
const I18N_HREF = pathToFileURL(resolve(ROOT, 'src/i18n/index.js')).href
const I18N_STUB = `
export * from '${I18N_HREF}'
import { getLocale, translate } from '${I18N_HREF}'
export function useT() { const loc = getLocale(); return (zh, params) => translate(loc, zh, params) }
export function useLocale() { return getLocale() }
`
async function bundleJsx(entry, stubs = {}) {
  const result = await build({
    entryPoints: [resolve(ROOT, entry)], bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', packages: 'external', loader: { '.css': 'empty' },
    plugins: [{
      name: 'test-shims',
      setup(b) {
        b.onResolve({ filter: /.*/ }, (a) => {
          if (!a.path.startsWith('.')) return undefined
          const abs = resolve(a.resolveDir, a.path)
          for (const k of Object.keys(stubs)) if (abs.endsWith(k)) return { path: k, namespace: 'stub' }
          if (/[\\/]i18n[\\/]index\.js$/.test(abs)) return { path: 'i18n-ssr', namespace: 'stub' }
          return undefined
        })
        b.onResolve({ filter: /^file:/ }, (a) => ({ path: a.path, external: true }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: a.path === 'i18n-ssr' ? I18N_STUB : stubs[a.path], loader: 'js', resolveDir: ROOT }))
      },
    }],
  })
  mkdirSync(CACHE_DIR, { recursive: true })
  const file = join(CACHE_DIR, `${entry.replace(/[^\w]/g, '_')}.${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(file, result.outputFiles[0].text)
  return import(pathToFileURL(file).href)
}
const React = (await import('react')).default
const { renderToStaticMarkup } = await import('react-dom/server')
const Card = await bundleJsx('src/ui/AirCompareCard.jsx')
const stubs = { 'store/useStore.js': STORE_STUB }
const { default: DataCard } = await bundleJsx('src/ui/DataCard.jsx', stubs)
const { default: DataBoard } = await bundleJsx('src/ui/DataBoard.jsx', stubs)
const store = globalThis.__airTestStore
const html = (C, props = {}) => renderToStaticMarkup(React.createElement(C, props))
const inEn = (fn) => { setLocale('en'); try { return fn() } finally { setLocale('zh') } }
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ')   // 可見文字 + 屬性以外的部分
const attrs = (h) => [...h.matchAll(/(?:title|aria-label)="([^"]*)"/g)].map((m) => m[1].replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')).join('\n')
const everything = (h) => text(h) + '\n' + attrs(h)   // 使用者看得到 / 讀得到的全部文字（含 title 與 aria-label）

// ---- fixture ----
const T0 = Date.parse('2026-09-20T00:00:00+08:00')
const iso = (h) => new Date(T0 + h * 3600e3 + 8 * 3600e3).toISOString().slice(0, 13) + ':00:00+08:00'
const N = 24
const model = Array.from({ length: N }, (_, i) => 24 + (i % 6) * 2)                          // 24..34
const STATION = { name: '麥寮', county: '雲林縣', id: '60', lat: 23.753, lon: 120.251, km: 4.1 }
const OBS = { source: '環境部空氣品質監測網（政府資料開放授權條款－第1版）', sourceUrl: 'https://data.moenv.gov.tw/', license: '政府資料開放授權條款－第1版', station: STATION, fetchedAt: iso(N), history: model.map((v, i) => ({ t: iso(i), pm25: v - 8, pm10: 30, aqi: 55, wind: 2.5 })) }   // 觀測 = 模型 − 8 → 模型高估 8.0
const AIR = { county: '雲林縣', place: '麥寮', lat: 23.79, lon: 120.25, sourceUrl: 'https://open-meteo.com/en/docs/air-quality-api', history: model.map((v, i) => ({ t: iso(i), pm10: v + 5, pm25: v, dust: 0, aqi: 80, wind: 1 + (i % 5) })) }
const AIR_OBS = { ...AIR, obs: OBS }
const OPT = { id: 'air-yunlin', name: '空氣品質 · 雲林', kind: 'air', level: 34, params: { clarity: 0.6, trashCount: 0.3, glow: 0.5, hue: 0.4, current: 0.3 } }
const govOf = (air, extra = {}) => ({ sourceShort: '水利署 · CWA潮汐 · Open-Meteo', weather: { weather: '多雲', airTemp: 29, humidity: 80, windSpeed: 3.6 }, air, options: [OPT], ...extra })
const setGov = (gov, optId = 'air-yunlin') => store.setState({ gov, govOptionId: optId })

test('AirCompareCard：有觀測 → 標題 / 折線（兩條）/ 圖例 / 一句話結論 / 出處與授權 / 距離但書；沒有觀測 → 不渲染', () => {
  const spark = React.createElement(Card.AirSparkline, { air: AIR_OBS, height: 44 })
  const h = html(Card.AirCompareCard, { air: AIR_OBS, spark })
  assert.ok(h.includes('gov-air-compare') && h.includes('spark-a') && h.includes('spark-b'), '兩條線')
  const t = text(h)
  assert.match(t, /模型 vs 觀測/); assert.match(t, /近 24 小時 PM2\.5（μg\/m³）/)
  assert.match(t, /模型（非政府觀測）/); assert.match(t, /環境部麥寮站觀測/)
  assert.match(t, /與環境部麥寮站觀測相比，模型平均高估 8\.0 μg\/m³（平均絕對誤差 8\.0，共 24 小時）/)
  assert.match(t, /模型：Open-Meteo \/ CAMS（非政府觀測）；觀測：環境部麥寮站（政府資料開放授權條款－第1版）/)
  assert.ok(h.includes('href="https://data.moenv.gov.tw/"') && h.includes('rel="noopener noreferrer"'))
  assert.match(t, /測站離模型格點約 4\.1 公里；模型是數十公里的粗網格，落差不全是模型的誤差/)
  assert.ok(h.includes('role="group"') && h.includes('aria-label="模型 vs 觀測"'))
  assert.ok(!/NaN|undefined|null/.test(h), h)
  for (const air of [AIR, { ...AIR, obs: null }, null, undefined, {}, { ...AIR, obs: { ...OBS, history: OBS.history.slice(0, 2) } }]) assert.equal(html(Card.AirCompareCard, { air, spark }), '', JSON.stringify(air && air.obs && air.obs.history && air.obs.history.length))
})

test('AirCompareCard：一句話結論的四種說法（高估 / 低估 / 大致吻合 / 平均差小但逐時落差明顯）——誠實；|平均差| < 1 才能說大致吻合，符號不會反', () => {
  const air = (d, jitter = 0) => ({ ...AIR, obs: { ...OBS, history: model.map((v, i) => ({ t: iso(i), pm25: v - d + (i % 2 ? jitter : -jitter) })) } })
  const say = (a) => text(html(Card.AirCompareCard, { air: a }))
  assert.match(say(air(8)), /模型平均高估 8\.0 μg\/m³/)
  assert.match(say(air(-8)), /模型平均低估 8\.0 μg\/m³/)                                           // 觀測比模型高 → 模型低估，數字不帶負號
  assert.match(say(air(0.5)), /大致吻合（平均差 \+0\.5 μg\/m³，平均絕對誤差 0\.5，共 24 小時）/)
  assert.match(say(air(-0.5)), /大致吻合（平均差 −0\.5 μg\/m³/)
  assert.match(say(air(1)), /高估 1\.0 μg\/m³/); assert.doesNotMatch(say(air(1)), /大致吻合/)      // 剛好 1 → 不算吻合
  const mixed = say(air(0, 9)); assert.match(mixed, /模型平均差僅 \+?0\.0 μg\/m³，但逐小時落差明顯（平均絕對誤差 9\.0/); assert.doesNotMatch(mixed, /大致吻合/)
})

test('AirCompareCard：英文——不含中文、措辭誠實（modeled / not government observations、observations at MOENV’s Mailiao station）；單複數', () => inEn(() => {
  const spark = React.createElement(Card.AirSparkline, { air: AIR_OBS, height: 44 })
  const h = html(Card.AirCompareCard, { air: AIR_OBS, spark })
  const all = everything(h)
  assert.ok(!HAN.test(all), all.match(new RegExp(HAN.source + '+', 'g')))
  assert.match(all, /Model vs observations/); assert.match(all, /Model \(not government observations\)/); assert.match(all, /Observations at MOENV’s Mailiao station/)
  assert.match(all, /Against observations at MOENV’s Mailiao station, the model overestimates PM2\.5 by 8\.0 μg\/m³ on average \(mean absolute error 8\.0, 24 hours\)/)
  assert.match(all, /Model: Open-Meteo \/ CAMS \(not government observations\)\. Observations: MOENV’s Mailiao station \(Taiwan Open Government Data License v1\)/)
  assert.match(all, /about 4\.1 km/)
  assert.doesNotMatch(all.replaceAll('not government observations', ''), /government observations?\b/i)      // 沒有把任何東西說成「政府觀測」
  const aria = attrs(html(Card.AirSparkline, { air: AIR_OBS })); assert.match(aria, /PM2\.5 line chart of the model \(Open-Meteo \/ CAMS, not government observations\) and observations at MOENV’s Mailiao station: last 24 hours; model 24–34, observed 16–26 μg\/m³/)
}))

test('AirModelSpark（沒有觀測時永遠顯示的模型單條折線）：標題 / 範圍 / aria-label 標明模型、非政府觀測；只有一條線；有觀測（能比）時不渲染', () => {
  const spark = React.createElement(Card.AirSparkline, { air: AIR, height: 36 })
  const h = html(Card.AirModelSpark, { air: AIR, spark })
  assert.ok(h.includes('gov-air-spark') && h.includes('spark-a') && !h.includes('spark-line spark-b'))
  assert.match(text(h), /近 24 小時 PM2\.5（模型）/); assert.match(text(h), /24–34 μg\/m³/)
  assert.match(attrs(h), /近 24 小時的模型 PM2\.5 折線圖（Open-Meteo \/ CAMS，非政府觀測）：24–34 μg\/m³/)
  assert.equal(html(Card.AirModelSpark, { air: AIR_OBS, spark }), '')                            // 有觀測 → 由 AirCompareCard 顯示
  assert.equal(html(Card.AirModelSpark, { air: { ...AIR, history: [AIR.history[0]] }, spark }), '')   // 不足 2 個有效小時
  const en = inEn(() => everything(html(Card.AirModelSpark, { air: AIR, spark }))); assert.ok(!HAN.test(en)); assert.match(en, /PM2\.5 over the last 24 hours \(model\)/)
})

test('AirSparkline：播放中的小時（hour，MM-DD HH:MM）→ marker 落在對應的點；不在範圍內 → 沒有 marker；有觀測時 marker 同時標兩條線', () => {
  const at = (hour, air = AIR_OBS) => html(Card.AirSparkline, { air, hour })
  assert.ok(!at(null).includes('spark-marker'))
  assert.ok(at('09-20 05:00').includes('spark-marker'))
  assert.ok(at('09-20 05:00').includes('spark-dot spark-a') && at('09-20 05:00').includes('spark-dot spark-b'))
  assert.ok(!at('09-19 05:00').includes('spark-marker') && !at('nope').includes('spark-marker'))
  const x = (h) => Number(/class="spark-marker" x1="([\d.]+)"/.exec(h)[1])
  assert.ok(x(at('09-20 05:00')) < x(at('09-20 06:00')) && x(at('09-20 06:00')) < x(at('09-20 22:00')))
  assert.ok(!at('09-20 05:00', AIR).includes('spark-dot spark-b'), '沒有觀測 → 只有模型的點')
})

test('AirDriveToggle：只在有可用的觀測時出現；兩顆按鈕（環境部觀測 / 模型資料）、aria-pressed 反映目前來源；標籤照實（觀測 → 政府資料開放授權條款；模型 → 非政府觀測）', () => {
  const on = (drive) => html(Card.AirDriveToggle, { air: AIR_OBS, drive, onChange: () => {} })
  const obs = on('obs')
  assert.match(obs, /aria-pressed="true"[^>]*>環境部觀測</); assert.match(obs, /aria-pressed="false"[^>]*>模型資料</)
  const model = on('model')
  assert.match(model, /aria-pressed="false"[^>]*>環境部觀測</); assert.match(model, /aria-pressed="true"[^>]*>模型資料</)
  assert.ok(obs.includes('air-drive-obs on') && model.includes('air-drive-model on'))
  assert.match(attrs(obs), /用環境部測站觀測的逐時 PM2\.5 驅動海況（政府資料開放授權條款－第1版）/); assert.match(attrs(obs), /用 Open-Meteo \/ CAMS 模型的逐時 PM2\.5 驅動海況（模型資料，非政府觀測）/)
  assert.match(text(obs), /驅動海況的資料/)
  for (const air of [AIR, null, { ...AIR, obs: { ...OBS, history: [OBS.history[0]] } }]) assert.equal(html(Card.AirDriveToggle, { air, drive: 'model' }), '')
  const en = inEn(() => everything(on('obs'))); assert.ok(!HAN.test(en), en); assert.match(en, /Data driving the sea/); assert.match(en, /MOENV observation/)
})

test('AirObsLine：環境部觀測那一行（綠色標籤 + 測站 + PM2.5 / PM10 / AQI（不是 US AQI）+ 時間）；沒有觀測不渲染', () => {
  const h = html(Card.AirObsLine, { air: AIR_OBS })
  const t = text(h)
  assert.match(t, /環境部觀測 環境部麥寮站 · PM2\.5 26 · PM10 30 μg\/m³ · AQI 55 · 09-20 23:00/); assert.doesNotMatch(t, /US AQI/)
  assert.ok(h.includes('gov-air-badge-obs'))
  assert.equal(html(Card.AirObsLine, { air: AIR }), '')
})

// ---- 整張 DataCard（store 以假的取代）----
test('DataCard（空氣品質、沒有 obs）：與過去相同——模型單條折線、模型標籤、沒有並列小卡 / 切換 / 觀測行；選項標籤與播放鈕維持原文；折線永遠顯示', () => {
  setGov(govOf(AIR))
  const h = html(DataCard), all = everything(h)
  assert.ok(h.includes('gov-air-spark') && h.includes('spark-a') && !h.includes('spark-line spark-b'))
  assert.ok(!h.includes('gov-air-compare') && !h.includes('air-drive') && !h.includes('gov-air-obs-line'))
  assert.match(all, /空氣品質 · 雲林（PM2\.5 34，模型）/); assert.match(all, /▶ 播放空氣品質 24 小時/); assert.doesNotMatch(text(h), /播放空氣品質 24 小時（/)
  assert.match(all, /模型資料（Open-Meteo \/ CAMS），非政府觀測/); assert.match(all, /約數十公里的粗網格模型估計/)
  assert.ok(!all.replaceAll('不是環境部 AQI', '').includes('環境部') && !all.includes('政府資料開放授權條款'), '沒有金鑰 / 沒有 obs → 畫面沒有新增任何環境部觀測的字樣（只剩舊有的「US AQI 不是環境部 AQI」說明）')
  assert.equal(all.replaceAll('非政府觀測', '').includes('政府觀測'), false)
})

test('DataCard（有 obs、預設）：驅動海況 = 環境部觀測——選項標籤與播放鈕標「環境部觀測」；並列小卡 + 觀測行 + 切換都在；模型那一行仍標「模型資料，非政府觀測」', () => {
  setGov(govOf(AIR_OBS))
  const h = html(DataCard), all = everything(h)
  assert.ok(h.includes('gov-air-compare') && h.includes('gov-air-obs-line') && h.includes('air-drive'))
  assert.ok(!h.includes('gov-air-spark'), '有並列小卡時，模型單條折線由小卡取代')
  assert.match(all, /空氣品質 · 雲林（PM2\.5 26，環境部觀測）/)                                  // level = 觀測的最新 PM2.5（34 − 8），不是模型的
  assert.match(text(h), /▶ 播放空氣品質 24 小時（環境部觀測）/); assert.match(all, /播放最近的逐時 PM2\.5（環境部測站觀測，政府資料開放授權條款－第1版）/)
  assert.match(all, /模型資料（Open-Meteo \/ CAMS），非政府觀測/)
  assert.match(text(h), /空氣品質 · 雲林縣麥寮 · PM2\.5 34 · PM10 39 μg\/m³ · US AQI 80/)          // 模型那一行沒被觀測蓋掉
  assert.doesNotMatch(all, /PM2\.5 34，環境部觀測/)
})

test('DataCard（有 obs、切到模型）：選項標籤 / 播放鈕標「模型」、播放提示是「模型資料，非政府觀測」——使用模型序列時不出現「政府觀測」（只有「非政府觀測」）', () => {
  setGov(govOf(AIR_OBS, { airDrive: 'model' }))
  const h = html(DataCard), all = everything(h)
  assert.match(all, /空氣品質 · 雲林（PM2\.5 34，模型）/); assert.match(text(h), /▶ 播放空氣品質 24 小時（模型）/)
  assert.match(all, /播放最近的逐時 PM2\.5（Open-Meteo \/ CAMS 模型資料，非政府觀測）/); assert.doesNotMatch(all, /播放最近的逐時 PM2\.5（環境部測站觀測/)
  assert.ok(h.includes('air-drive-model on') && !h.includes('air-drive-obs on'))
  assert.equal(all.replaceAll('非政府觀測', '').includes('政府觀測'), false, '只能有「非政府觀測」')
  assert.ok(!/空氣品質 · 雲林（PM2\.5 \d+，環境部觀測）/.test(all), '選項標籤不能標環境部觀測')
  // 觀測不可用（沒有 ≥ 2 個有效小時）時，即使 airDrive 設成 obs 也退回模型，且沒有切換
  setGov(govOf({ ...AIR, obs: { ...OBS, history: [OBS.history[0]] } }, { airDrive: 'obs' }))
  const fb = html(DataCard), fbAll = everything(fb)
  assert.match(fbAll, /（PM2\.5 34，模型）/); assert.ok(!fb.includes('air-drive') && !fb.includes('gov-air-compare'))
})

test('DataCard（英文）：整張空氣品質區塊（有 obs）不含中文；選項標籤 / 播放鈕 / 小卡措辭誠實；沒有 obs 時也乾淨', () => {
  for (const gov of [govOf(AIR_OBS), govOf(AIR_OBS, { airDrive: 'model' }), govOf(AIR)]) {
    setGov(gov)
    const en = inEn(() => everything(html(DataCard)))
    assert.ok(!HAN.test(en), en.match(new RegExp('.{0,30}' + HAN.source + '+.{0,30}', 'g')))
    assert.doesNotMatch(en.replaceAll('not government observations', ''), /government observations?\b/i)
  }
  setGov(govOf(AIR_OBS))
  const en = inEn(() => everything(html(DataCard)))
  assert.match(en, /Air quality · Yunlin \(PM2\.5 26, MOENV observed\)/); assert.match(en, /Play air quality · 24 hours \(MOENV observed\)/)
  assert.match(en, /Air quality · Mailiao, Yunlin County · PM2\.5 34 · PM10 39 μg\/m³ · US AQI 80/)
  setGov(govOf(AIR_OBS, { airDrive: 'model' }))
  const enM = inEn(() => everything(html(DataCard)))
  assert.match(enM, /Air quality · Yunlin \(PM2\.5 34, modeled\)/); assert.match(enM, /Play air quality · 24 hours \(model\)/)
  assert.equal(getLocale(), 'zh')
})

test('DataCard（揚塵）：水利署風速凍結 + air 有逐時模型風速 → 誠實說明「風速為模型資料（Open-Meteo），水利署感測器凍結」並用模型風速播放；air 沒有風速 → 維持原本的「來源疑似凍結」說法', () => {
  const DUST = { county: '雲林縣', stations: [{ pm10: null, wind: 5.3, temp: 30, rh: 71, t: iso(3) }], history: [0, 1, 2, 3, 4].map((i) => ({ t: iso(i), pm10: null, wind: 5.34, temp: 30, rh: 71 })) }
  const DUST_OPT = { id: 'dust-yunlin', name: '揚塵 · 雲林縣', kind: 'dust', level: 0, params: { clarity: 0.8, trashCount: 0.1, current: 0.3 } }
  setGov({ ...govOf(AIR), dust: DUST, options: [DUST_OPT, OPT] }, 'dust-yunlin')
  const h = html(DataCard), all = everything(h)
  assert.match(text(h), /風速為模型資料（Open-Meteo），水利署感測器凍結：歷史播放改用逐時模型風速。/)
  assert.match(text(h), /▶ 播放揚塵歷史（風速（模型））24 筆/); assert.match(all, /播放最近的逐時模型風速（Open-Meteo，模型資料）/)
  assert.doesNotMatch(text(h), /目前累積的 \d+ 筆.*數值完全相同/)
  const en = inEn(() => everything(html(DataCard))); assert.ok(!HAN.test(en), en.match(new RegExp('.{0,30}' + HAN.source + '+.{0,30}', 'g'))); assert.match(en, /Wind speed is model data \(Open-Meteo\); the WRA sensor is frozen/); assert.match(en, /Play dust history \(Wind speed \(model\)\)/)
  // air 沒有風速 → 舊行為
  setGov({ ...govOf({ ...AIR, history: AIR.history.map(({ wind, ...r }) => r) }), dust: DUST, options: [DUST_OPT, OPT] }, 'dust-yunlin')
  const old = html(DataCard)
  assert.doesNotMatch(text(old), /風速為模型資料/); assert.match(text(old), /數值完全相同/); assert.match(text(old), /播放揚塵歷史（風速）5 筆/)
})

// ---- DataBoard ----
test('DataBoard（空氣品質）：有 obs → 多「觀測 / 落差 / 驅動」三列與折線；沒有 obs → 維持原來的列（另加模型折線）；模型驅動時「驅動」列標「模型資料，非政府觀測」', () => {
  store.setState({ overlays: { board: true, hud: true, qr: false } })
  setGov(govOf(AIR))
  const plain = html(DataBoard)
  assert.equal((plain.match(/class="k"/g) || []).length, 4)                                       // 空氣品質 / 來源 / 映射 / 氣象
  assert.ok(plain.includes('data-board-spark') && plain.includes('spark-a') && !plain.includes('spark-line spark-b'))
  assert.ok(!text(plain).includes('環境部'))
  setGov(govOf(AIR_OBS))
  const h = html(DataBoard), t = text(h)
  const keys = [...h.matchAll(/class="k">([^<]*)</g)].map((m) => m[1])
  assert.deepEqual(keys, ['空氣品質', '來源', '映射', '觀測', '落差', '驅動', '氣象'])
  assert.match(t, /環境部麥寮站 · PM2\.5 26 · PM10 30 μg\/m³ · AQI 55 · 09-20 23:00/)
  assert.match(t, /模型平均高估 8\.0 μg\/m³（平均絕對誤差 8\.0，共 24 小時）/)
  assert.match(t, /驅動 環境部觀測 · 政府資料開放授權條款－第1版/)
  assert.ok(h.includes('spark-line spark-b'))
  assert.match(t, /PM2\.5 ↑ → 海水清澈 0\.\d\d · 垃圾 0\.\d\d · 輝光 0\.\d\d/)
  setGov(govOf(AIR_OBS, { airDrive: 'model' }))
  const m = text(html(DataBoard)); assert.match(m, /驅動 模型資料，非政府觀測/); assert.doesNotMatch(m, /驅動 環境部觀測/)
  const en = inEn(() => everything(html(DataBoard))); assert.ok(!HAN.test(en), en.match(new RegExp('.{0,30}' + HAN.source + '+.{0,30}', 'g'))); assert.match(en, /Driven by/); assert.match(en, /Observed/)
  store.setState({ overlays: { board: false, hud: true, qr: false } }); assert.equal(html(DataBoard), '')     // 尊重 overlays.board
})

test('DataBoard：正在播放空氣品質序列時，「驅動」列照實說播放中的來源（導覽播模型序列時不會說觀測；播觀測時不會說模型）；播的不是空氣品質或停止播放後回到資料卡的偏好', () => {
  store.setState({ overlays: { board: true, hud: true, qr: false } })
  const sm = globalThis.__airTestSeriesMeta
  const drive = () => text(html(DataBoard)).match(/驅動 ([^]*?) 氣象/)[1]
  const PREF_OBS = '環境部觀測 · 政府資料開放授權條款－第1版', MODEL = '模型資料，非政府觀測'
  try {
    setGov(govOf(AIR_OBS))
    assert.equal(drive(), PREF_OBS)                                                                           // 沒在播放 → 偏好（auto = 觀測）
    store.setState({ rec: { mode: 'playing', speed: 1, loop: false, playhead: 0 } })
    Object.assign(sm, { active: true, kind: 'air', extra: { model: true }, points: [{ t: '09-20 01:00' }], step: 0.2 })
    assert.equal(drive(), MODEL)                                                                              // 導覽 / 資料卡播的是模型序列
    Object.assign(sm, { extra: { model: false, source: 'obs' } })
    assert.equal(drive(), PREF_OBS)
    Object.assign(sm, { kind: 'dust', extra: { metric: 'wind' } })                                            // 播的不是空氣品質 → 用偏好
    assert.equal(drive(), PREF_OBS)
    Object.assign(sm, { kind: 'air', extra: { model: true } }); store.setState({ rec: { mode: 'idle', speed: 1, loop: false, playhead: 0 } })
    assert.equal(drive(), PREF_OBS)                                                                           // 停止播放 → 回到偏好
    setGov(govOf(AIR_OBS, { airDrive: 'model' })); assert.equal(drive(), MODEL)
  } finally { store.setState({ rec: { mode: 'idle', speed: 1, loop: false, playhead: 0 } }); sm.active = false }
})
