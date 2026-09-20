// 鳥 / 魚調查：分享連結暫時帶來的「連動」狀態不落地 + 日誌的筆數。執行：node --test src/store/survey.test.mjs
// localStorage 用假的（Map），在載入 store 之前裝好：偏好在載入時讀、之後每次動作寫。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const mem = new Map()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) } })
const { useStore } = await import('./useStore.js')
const { LS } = await import('../lib/persist.js')
const { seriesFromSurvey } = await import('../lib/series.js')

const gov = JSON.parse(readFileSync(new URL('../../public/data/ocean.json', import.meta.url), 'utf8'))
const S = () => useStore.getState()
const saved = () => { const v = mem.get(LS.surveyLink); return v ? JSON.parse(v) : null }
const birdOpt = () => gov.options.find((o) => o.birds && Array.isArray(o.birds.yearly))

function fresh(link = { birds: true, fish: false }) {
  mem.clear()
  S().setGov(gov)
  S().setGovOption(birdOpt().id)
  useStore.setState({ surveyLink: { ...link } })
  mem.clear()   // 準備動作不算
}

test('分享連結帶來的另一個種類的連動值，不會因為使用者手動調數量而被一起存成自己的偏好', () => {
  fresh({ birds: true, fish: false })
  S().applySharedContext({ link: { birds: true, fish: true } })         // 分享者的鳥 / 魚都連動（只進記憶體）
  assert.equal(S().surveyLink.fish, true); assert.equal(saved(), null, '套用分享脈絡本身不落地')
  S().input('birdCount', 0.2)                                            // 使用者手動調鳥 → 鳥脫鉤
  assert.equal(S().surveyLink.birds, false)
  assert.deepEqual(saved(), { birds: false }, '只寫使用者動的那一個 key（以前連 fish:true 也寫進去）')
  assert.equal(S().surveyLink.fish, true, '記憶體裡分享的魚連動照舊（這次的畫面不變）')
})

test('自動重套用「已連動」的（載入 / 換月份 / 換海況）不寫偏好：分享的連動只在記憶體', () => {
  fresh({ birds: true, fish: false })
  S().applySharedContext({ link: { birds: true, fish: true } })
  S().setSurveyMonth(5)                                                  // → applySurveyLinked → 鳥 / 魚都重套用
  S().applySurveyLinked()
  assert.equal(saved(), null, '沒有任何使用者動作 → 不寫')
  assert.equal(S().surveyLink.fish, true)
})

test('使用者明確按「套用 / 連動」才寫，而且只寫那一個 key；關閉連動同理；其他已存的值保留', () => {
  fresh({ birds: true, fish: false })
  mem.set(LS.surveyLink, JSON.stringify({ birds: false }))               // 使用者以前存過：鳥脫鉤
  S().applySharedContext({ link: { birds: true, fish: true } })
  S().setSurveyLink('fish', true)                                        // 使用者按魚的「套用」
  assert.deepEqual(saved(), { birds: false, fish: true })
  S().setSurveyLink('birds', false)
  assert.deepEqual(saved(), { birds: false, fish: true })
  S().setSurveyLink('fish', false)
  assert.deepEqual(saved(), { birds: false, fish: false })
})

test('一般（沒有分享連結）流程不變：手動調鳥數量 → 脫鉤並存；壞掉的偏好值不會讓 store 丟錯', () => {
  fresh({ birds: true, fish: false })
  S().input('birdCount', 0.4)
  assert.deepEqual(saved(), { birds: false }); assert.equal(S().surveyLink.birds, false)
  mem.set(LS.surveyLink, JSON.stringify('garbage'))
  S().setSurveyLink('fish', true)
  assert.deepEqual(saved(), { fish: true })
})

test('資料播放日誌的「筆數」：調查年表報真實調查年數（不含內插的空窗年）；其他序列仍是 points 數', () => {
  fresh({ birds: true, fish: false })
  const yearly = [2004, 2005, 2014, 2015].map((y, i) => ({ y, s: 20 + i, n: 100 }))
  const opt = { ...birdOpt(), birds: { ...birdOpt().birds, yearly } }
  const spec = seriesFromSurvey(opt, 'birds')
  assert.equal(spec.points.length, 12); assert.equal(spec.extra.years.length, 4)
  useStore.setState({ log: [] })
  assert.equal(S().playSeries(spec, null), true)
  const line = S().log.map((l) => l.text).find((x) => x.includes('資料播放'))
  assert.match(line, /（4 筆，種）/, line)
  S().stopPlayback()
  // 其他序列不變
  useStore.setState({ log: [] })
  S().setGovOption(gov.options.find((o) => o.kind === 'tide').id)
  S().playGovSeries()
  const tide = S().log.map((l) => l.text).find((x) => x.includes('資料播放'))
  assert.match(tide, /（24 筆，cm）/, tide)
  S().stopPlayback()
})
