// 點物件看資料出處（lib/inspect.js）單元測試。執行：node --test src/lib/inspect.test.mjs
// 選取 / 輕點判定 / 卡片位置 / 卡片內容（中英）/ 卡片 store 全部是純邏輯：假座標、假計時器、假資料，不碰 three 與 DOM。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadEnDict } from '../../scripts/i18n-check.mjs'
import { registerEn, setLocale } from '../i18n/index.js'
import {
  THRESHOLD_PX, MIN_ALPHA, PRIORITY, thresholdFor, pickSources, registerPickSource, collectCandidates, pickTarget,
  createTapTracker, placeCard, DOCK_W, playContext, stationData, moonData, birdData, buildInspectData, describeInspect,
  sanitizeInspectState, createInspectStore, IDLE_MS, FAILSAFE_MS,
} from './inspect.js'

const { dict } = await loadEnDict()
registerEn(dict)
const inEn = (fn) => { setLocale('en'); try { return fn() } finally { setLocale('zh') } }

// 資料固定用假資料（ocean.json 由排程每天刷新，月出月沒視窗 / 潮汐日期 / 農曆都會滾動，不能拿來寫死斷言）；
// 真實檔只做「不丟錯、結構正確」的煙霧測試（見最後幾個 test）。
const realOcean = JSON.parse(readFileSync(new URL('../../public/data/ocean.json', import.meta.url), 'utf8'))
const MOON_DAYS = [   // [日期, 月出, 月出方位, 中天, 中天仰角, 仰角方位, 月沒, 月沒方位]；9/20 沒有月沒（月沒落在 9/21 凌晨），與真實資料同型
  ['2026-09-17', '11:13', 121, '16:31', 37, 'S', '21:44', 239],
  ['2026-09-18', '12:04', 121, '17:21', 37, 'S', '22:36', 239],
  ['2026-09-19', '12:56', 121, '18:12', 38, 'S', '23:29', 240],
  ['2026-09-20', '13:47', 121, '19:04', 38, 'S', '', null],
  ['2026-09-21', '14:39', 122, '19:57', 38, 'S', '00:22', 240],
  ['2026-09-22', '15:31', 122, '20:50', 38, 'S', '01:16', 241],
]
const ocean = {
  moon: { county: '花蓮縣', from: '2026-09-17', to: '2026-09-22', days: MOON_DAYS },
  stations: { total: 3, active: 2, list: [
    { n: '景美', r: '景美溪', x: 0.17, y: 0.46, a: 114.95, s: 0 },
    { n: '思源橋', r: '北勢溪', x: 0.24, y: 0.45, a: 0.74, s: 1 },
    { n: '無名站', r: '', x: 0.1, y: 0.1, a: null, s: 1 },
  ] },
  options: [
    { id: 'moon-hualien', name: '月亮 · 花蓮', kind: 'moon',
      birds: { basin: '花蓮溪流域', species: 129, monthly: [82, 39, null, 74, null, null, 41, null, null, null, null, null], yearly: [{ y: 2002, s: 39 }, { y: 2017, s: 89 }, { y: 2019, s: 83 }] } },
    { id: 'hualien-tide', name: '花蓮外海', kind: 'tide',
      series: { date: '2026-09-20', lunar: '2026-08-10', lunarLabel: '農曆八月初十', range: '小', points: [{ h: 0, v: 175 }, { h: 1, v: 170 }] } },
    { id: 'feitsui', name: '翡翠水庫',
      birds: { basin: '淡水河流域', species: 122, monthly: [null, 84, null, null, 82, null, null, 68, null, 90, null, null], yearly: [{ y: 2005, s: 88 }, { y: 2015, s: 59 }, { y: 2016, s: 78 }, { y: 2017, s: 50 }] } },
    { id: 'zengwen', name: '曾文水庫',
      birds: { basin: '曾文溪流域', species: 161, monthly: [118, 79, null, 56, 55, 97, null, 77, null, 87, 53, null], yearly: [{ y: 2004, s: 97 }, { y: 2005, s: 124 }, { y: 2014, s: 75 }, { y: 2015, s: 89 }] } },
    { id: 'deji', name: '德基水庫', birds: { basin: '大甲溪流域', species: 80, monthly: [62, null, null, 71, null, null, 55, null, 57, null, null, null], yearly: [{ y: 2012, s: 77 }, { y: 2013, s: 62 }] } },
  ],
}
const optOf = (id) => ocean.options.find((o) => o.id === id)
const cand = (kind, id, sx, sy, more = {}) => ({ kind, id, sx, sy, ...more })

// ───────────────────────────── 選取 ─────────────────────────────
test('閾值：觸控 ≥ 24px、滑鼠 ≥ 12px、筆介於其間；未知類型當滑鼠', () => {
  assert.ok(THRESHOLD_PX.touch >= 24); assert.ok(THRESHOLD_PX.mouse >= 12)
  assert.ok(THRESHOLD_PX.pen > THRESHOLD_PX.mouse && THRESHOLD_PX.pen < THRESHOLD_PX.touch)
  assert.equal(thresholdFor('touch'), THRESHOLD_PX.touch); assert.equal(thresholdFor('pen'), THRESHOLD_PX.pen)
  assert.equal(thresholdFor('mouse'), THRESHOLD_PX.mouse); assert.equal(thresholdFor(undefined), THRESHOLD_PX.mouse)
})
test('pickTarget：選最近的星；超出閾值 → null；同一批候選觸控比滑鼠寬鬆', () => {
  const cs = [cand('station', 1, 100, 100), cand('station', 2, 140, 100), cand('station', 3, 300, 300)]
  assert.equal(pickTarget(cs, { x: 104, y: 100 }, { pointerType: 'mouse' }).id, 1)
  assert.equal(pickTarget(cs, { x: 130, y: 100 }, { pointerType: 'mouse' }).id, 2)     // 離 2 只有 10px
  assert.equal(pickTarget(cs, { x: 200, y: 200 }, { pointerType: 'mouse' }), null)
  const p = { x: 118, y: 100 }                                                         // 距 1 = 18px、距 2 = 22px
  assert.equal(pickTarget(cs, p, { pointerType: 'mouse' }), null)                      // 滑鼠 12px：都不到
  assert.equal(pickTarget(cs, p, { pointerType: 'touch' }).id, 1)                      // 觸控 24px：選最近的 1
  assert.equal(pickTarget(cs, p, { threshold: 5 }), null)                              // 明確給閾值優先
  assert.equal(pickTarget(cs, { x: 100, y: 100 }, { pointerType: 'mouse' }).dist, 0)
})
test('pickTarget：恰在閾值上算命中，超過一點點就不算', () => {
  const cs = [cand('station', 1, 0, 0)]
  assert.ok(pickTarget(cs, { x: 12, y: 0 }, { pointerType: 'mouse' }))
  assert.equal(pickTarget(cs, { x: 12.01, y: 0 }, { pointerType: 'mouse' }), null)
})
test('多物件優先序：測站 > 鳥群 > 月亮（即使月亮圓盤 / 鳥群離點擊點更近）', () => {
  assert.ok(PRIORITY.station < PRIORITY.bird && PRIORITY.bird < PRIORITY.moon)
  const moon = cand('moon', 'moon', 200, 200, { r: 80 })                              // 大圓盤：點在盤內 = 邊緣距離 0
  const star = cand('station', 5, 210, 200)                                           // 星在盤內、離點擊點 10px
  const bird = cand('bird', 0, 205, 200, { r: 20 })
  assert.equal(pickTarget([moon, bird, star], { x: 200, y: 200 }, { pointerType: 'mouse' }).kind, 'station')
  assert.equal(pickTarget([moon, bird], { x: 200, y: 200 }, { pointerType: 'mouse' }).kind, 'bird')
  assert.equal(pickTarget([moon], { x: 200, y: 200 }, { pointerType: 'mouse' }).kind, 'moon')
  assert.equal(pickTarget([moon, star], { x: 200, y: 260 }, { pointerType: 'mouse' }).kind, 'moon')   // 星離 60px 太遠 → 落回月亮
})
test('同優先序：邊緣距離小者勝；平手取中心較近；有本體半徑的物件點在本體內即算命中', () => {
  const a = cand('bird', 1, 100, 100, { r: 30 }), b = cand('bird', 2, 100, 150, { r: 30 })
  assert.equal(pickTarget([a, b], { x: 100, y: 100 }, { pointerType: 'mouse' }).id, 1)   // a：邊緣 0；b：邊緣 20 > 12
  assert.equal(pickTarget([a, b], { x: 100, y: 128 }, { pointerType: 'mouse' }).id, 2)   // b 中心較近，a 邊緣 0 也在盤內：平手→中心較近
  const moon = cand('moon', 'moon', 300, 300, { r: 60 })
  assert.ok(pickTarget([moon], { x: 300 + 70, y: 300 }, { pointerType: 'mouse' }), '盤緣外 10px 仍在滑鼠閾值內')
  assert.equal(pickTarget([moon], { x: 300 + 80, y: 300 }, { pointerType: 'mouse' }), null)
})
test('alpha 過低（淡出中 / 幾乎看不見）不可選取；達門檻才可以', () => {
  const at = { x: 50, y: 50 }
  assert.equal(pickTarget([cand('station', 1, 50, 50, { alpha: MIN_ALPHA.station - 0.01 })], at, { pointerType: 'mouse' }), null)
  assert.ok(pickTarget([cand('station', 1, 50, 50, { alpha: MIN_ALPHA.station })], at, { pointerType: 'mouse' }))
  assert.equal(pickTarget([cand('station', 1, 50, 50, { alpha: 0.05 })], at, { pointerType: 'mouse' }), null)   // cache.alpha 很低
  assert.equal(pickTarget([cand('moon', 'moon', 50, 50, { alpha: 0.1, r: 30 })], at, { pointerType: 'mouse' }), null)
  assert.ok(pickTarget([cand('moon', 'moon', 50, 50, { alpha: 0.3, r: 30 })], at, { pointerType: 'mouse' }))
  assert.equal(pickTarget([cand('station', 1, 50, 50, { alpha: 0.8, minAlpha: 0.9 })], at, { pointerType: 'mouse' }), null)   // 個別覆寫
  assert.ok(pickTarget([cand('station', 1, 50, 50)], at, { pointerType: 'mouse' }), '沒給 alpha = 完全不透明')
  // 看不見的高優先序物件不擋路：落到可見的月亮
  const cs = [cand('station', 1, 50, 50, { alpha: 0.1 }), cand('moon', 'moon', 50, 50, { r: 30, alpha: 1 })]
  assert.equal(pickTarget(cs, at, { pointerType: 'mouse' }).kind, 'moon')
})
test('bounds：中心在畫布外的物件不可選；壞資料（NaN / 空）不會丟錯', () => {
  const bounds = { w: 400, h: 300 }
  assert.equal(pickTarget([cand('station', 1, 405, 100)], { x: 399, y: 100 }, { pointerType: 'touch', bounds }), null)
  assert.equal(pickTarget([cand('station', 1, 100, -2)], { x: 100, y: 1 }, { pointerType: 'touch', bounds }), null)
  assert.ok(pickTarget([cand('station', 1, 399, 100)], { x: 399, y: 100 }, { pointerType: 'touch', bounds }))
  assert.equal(pickTarget([cand('station', 1, NaN, 1), null, undefined], { x: 0, y: 0 }, {}), null)
  assert.equal(pickTarget(null, { x: 0, y: 0 }), null); assert.equal(pickTarget([], null), null); assert.equal(pickTarget([], { x: NaN, y: 0 }), null)
})

test('registerPickSource / collectCandidates：世界座標 → 螢幕候選；來源壞掉 / 回 null / 座標壞掉不影響其他來源', () => {
  pickSources.clear()
  const offA = registerPickSource('station', () => ({ alpha: 0.9, items: [{ id: 0, x: 1, y: 2, z: 3 }, { id: 1, x: NaN, y: 0, z: 0 }] }))
  registerPickSource('moon', () => ({ items: [{ id: 'moon', x: 0, y: 0, z: -9, rWorld: 1.25, alpha: 0.6 }] }))
  registerPickSource('bird', () => { throw new Error('boom') })
  registerPickSource('ghost', () => null)
  const project = (x, y, z) => (z < -100 ? null : { sx: x * 10 + 100, sy: y * 10 + 100, pxPerUnit: 40 })
  const cs = collectCandidates(pickSources, project)
  assert.equal(cs.length, 2)
  const st = cs.find((c) => c.kind === 'station'), mn = cs.find((c) => c.kind === 'moon')
  assert.deepEqual([st.id, st.sx, st.sy, st.r, st.alpha], [0, 110, 120, 0, 0.9])
  assert.deepEqual([mn.sx, mn.sy, mn.r, mn.alpha], [100, 100, 50, 0.6])                   // 半徑 1.25 世界單位 × 40 px/單位；個別 alpha 優先
  assert.equal(collectCandidates(new Map([['station', () => ({ items: [{ id: 1, x: 0, y: 0, z: -999 }] })]]), project).length, 0)   // 在相機後方
  offA(); assert.equal(pickSources.has('station'), false)
  const offB = registerPickSource('x', () => null); const fn2 = () => null; registerPickSource('x', fn2); offB(); assert.ok(pickSources.has('x'), '取消舊的不會拆掉後註冊的')
  pickSources.clear()
})

// ───────────────────────────── 輕點判定 ─────────────────────────────
const D = (id, x, y, t, type = 'mouse', extra = {}) => ({ id, x, y, t, type, ...extra })
test('輕點：位移 < 10px 且 < 450ms 才算；回傳落點、指標類型與 meta', () => {
  const tr = createTapTracker()
  tr.down({ ...D(1, 100, 100, 1000, 'touch'), meta: { onSphere: false } })
  const tap = tr.up({ id: 1, x: 103, y: 104, t: 1200 })
  assert.deepEqual([tap.x, tap.y, tap.type, tap.dbl], [103, 104, 'touch', false])
  assert.deepEqual(tap.meta, { onSphere: false })
  tr.down(D(2, 0, 0, 5000)); assert.ok(tr.up({ id: 2, x: 0, y: 0, t: 5000 + 449 }))
  tr.down(D(3, 0, 0, 9000)); assert.equal(tr.up({ id: 3, x: 0, y: 0, t: 9000 + 450 }), null)      // 長按（果凍 / 聚集魚群）不算
})
test('輕點：拖曳（位移 ≥ 10px，包含移出去又移回來）不算', () => {
  const tr = createTapTracker()
  tr.down(D(1, 100, 100, 0)); tr.move({ id: 1, x: 109, y: 100 }); assert.ok(tr.up({ id: 1, x: 109, y: 100, t: 100 }))     // 9.0px 還算輕點
  tr.down(D(2, 100, 100, 1000)); tr.move({ id: 2, x: 110, y: 100 }); assert.equal(tr.up({ id: 2, x: 110, y: 100, t: 1100 }), null)
  tr.down(D(3, 100, 100, 3000)); tr.move({ id: 3, x: 140, y: 100 }); tr.move({ id: 3, x: 100, y: 100 })
  assert.equal(tr.up({ id: 3, x: 100, y: 100, t: 3100 }), null, '走出去再走回來仍是拖曳')
  tr.down(D(4, 0, 0, 5000)); assert.equal(tr.up({ id: 4, x: 8, y: 8, t: 5050 }), null, '只在 up 座標才超出（斜向 11.3px）')
})
test('輕點：兩指（縮放）作廢，包含先落下的那根與後落下的那根；全部離開後恢復', () => {
  const tr = createTapTracker()
  tr.down(D(1, 100, 100, 0, 'touch')); tr.down(D(2, 200, 100, 30, 'touch'))
  assert.equal(tr.up({ id: 1, x: 100, y: 100, t: 100 }), null)
  assert.equal(tr.up({ id: 2, x: 200, y: 100, t: 120 }), null)
  assert.equal(tr.size, 0)
  tr.down(D(3, 100, 100, 1000, 'touch')); assert.ok(tr.up({ id: 3, x: 100, y: 100, t: 1100 }))
})
test('輕點：滑鼠非左鍵不算；pointercancel 不產生輕點；沒 down 的 up 回 null', () => {
  const tr = createTapTracker()
  tr.down(D(1, 0, 0, 0, 'mouse', { button: 2 })); assert.equal(tr.up({ id: 1, x: 0, y: 0, t: 50 }), null)
  tr.down(D(2, 0, 0, 100, 'mouse', { button: 1 })); assert.equal(tr.up({ id: 2, x: 0, y: 0, t: 150 }), null)
  tr.down(D(3, 0, 0, 300, 'touch', { button: 0 })); tr.cancel(3); assert.equal(tr.up({ id: 3, x: 0, y: 0, t: 320 }), null)
  assert.equal(tr.up({ id: 99, x: 0, y: 0, t: 400 }), null)
  tr.down(D(4, 0, 0, 500, 'pen', { button: 0 })); assert.equal(tr.up({ id: 4, x: 0, y: 0, t: 520 }).type, 'pen')
})
test('雙擊：間隔 < 320ms 的第二下標成 dbl（呼叫端忽略，讓雙擊切換演出模式照常）；間隔夠長則否', () => {
  const tr = createTapTracker()
  tr.down(D(1, 0, 0, 1000)); assert.equal(tr.up({ id: 1, x: 0, y: 0, t: 1050 }).dbl, false)
  tr.down(D(2, 0, 0, 1150)); assert.equal(tr.up({ id: 2, x: 0, y: 0, t: 1200 }).dbl, true)
  tr.down(D(3, 0, 0, 2000)); assert.equal(tr.up({ id: 3, x: 0, y: 0, t: 2050 }).dbl, false)
})

// ───────────────────────────── 卡片位置 ─────────────────────────────
test('placeCard：預設放物件右下；右邊放不下翻到左邊；下面放不下翻到上面', () => {
  const W = 900, H = 600, cw = 240, ch = 150
  const a = placeCard({ x: 300, y: 200, cw, ch, w: W, h: H })
  assert.equal(a.placement, 'right-below'); assert.ok(a.left > 300 && a.top > 200)
  const b = placeCard({ x: 820, y: 200, cw, ch, w: W, h: H })
  assert.equal(b.placement, 'left-below'); assert.ok(b.left + cw < 820)
  const c = placeCard({ x: 300, y: 560, cw, ch, w: W, h: H })
  assert.equal(c.placement, 'right-above'); assert.ok(c.top + ch < 560)
  const d = placeCard({ x: 860, y: 570, cw, ch, w: W, h: H })
  assert.equal(d.placement, 'left-above')
})
test('placeCard：邊界夾住不溢出（含物件在角落、卡片比畫布還大）', () => {
  const W = 700, H = 500, cw = 240, ch = 150, m = 8
  for (const [x, y] of [[0, 0], [W, 0], [0, H], [W, H], [W / 2, H / 2], [5, 250], [695, 250], [-30, 700]]) {
    const r = placeCard({ x, y, cw, ch, w: W, h: H, margin: m })
    assert.ok(r.left >= m && r.top >= m && r.left + cw <= W - m && r.top + ch <= H - m, `(${x},${y}) → ${JSON.stringify(r)}`)
  }
  const tiny = placeCard({ x: 100, y: 100, cw: 900, ch: 900, w: 600, h: 600 })            // 卡片比畫布大：至少貼左上、不出現負值
  assert.ok(tiny.left >= 8 && tiny.top >= 8)
})
test('placeCard：窄畫面（手機）停靠在畫布下緣', () => {
  const r = placeCard({ x: 100, y: 100, cw: 300, ch: 160, w: 390, h: 400 })
  assert.equal(r.dock, true); assert.equal(r.left, 8); assert.equal(r.top, 400 - 160 - 8)
  assert.equal(placeCard({ x: 100, y: 100, cw: 300, ch: 160, w: DOCK_W, h: 400 }).dock, true)
  assert.equal(placeCard({ x: 100, y: 100, cw: 300, ch: 160, w: DOCK_W + 1, h: 400 }).dock, false)
  assert.ok(placeCard({ x: 0, y: 0, cw: 300, ch: 900, w: 390, h: 400 }).top >= 8)         // 卡片比畫布高：不出現負的 top
})

// ───────────────────────────── 播放脈絡 ─────────────────────────────
test('playContext：非播放 / 非資料播放 → null；月亮回當天 idx；潮汐回內插時刻', () => {
  const meta = { active: true, kind: 'moon', step: 0.25, points: new Array(10).fill({}) }
  assert.equal(playContext(meta, { mode: 'idle', playhead: 1 }), null)
  assert.equal(playContext({ ...meta, active: false }, { mode: 'playing', playhead: 1 }), null)
  assert.equal(playContext(null, { mode: 'playing', playhead: 1 }), null)
  assert.deepEqual(playContext(meta, { mode: 'playing', playhead: 0.6 }), { kind: 'moon', idx: 2 })
  assert.equal(playContext(meta, { mode: 'playing', playhead: 99 }).idx, 9)                // 夾在最後一天
  const tide = { active: true, kind: 'tide', step: 1, points: [{ h: 0 }, { h: 1 }, { h: 2 }] }
  const c = playContext(tide, { mode: 'playing', playhead: 1.5 }); assert.equal(c.kind, 'tide'); assert.equal(c.idx, 1); assert.ok(Math.abs(c.hour - 1.5) < 1e-9)
})

// ───────────────────────────── 卡片資料與內容 ─────────────────────────────
const NOW = new Date(2026, 8, 20, 12, 30)   // 2026-09-20 12:30（本地時間）；假資料的月出月沒視窗含此日
test('stationData：取自測站清單（站名 / 河川 / 集水面積 / 現存）；壞索引 → null', () => {
  const list = ocean.stations.list
  const d = stationData(list, 0)
  assert.deepEqual(d, { kind: 'station', n: list[0].n, r: list[0].r, a: list[0].a, s: list[0].s ? 1 : 0 })
  assert.equal(stationData(list, 99999), null); assert.equal(stationData(null, 0), null)
  assert.deepEqual(stationData([{ n: 'X', r: '', a: 0, s: 0 }], 0), { kind: 'station', n: 'X', r: '', a: 0, s: 0 })
})
test('測站卡片（中文）：站名 / 河川 / 集水面積 / 現存或已廢 / 出處', () => {
  const v = describeInspect({ kind: 'station', n: '景美', r: '景美溪', a: 114.95, s: 0 })
  assert.equal(v.title, '景美'); assert.equal(v.eyebrow, '河川流量測站')
  assert.deepEqual(v.rows.map((r) => [r.k, r.v]), [['所屬河川', '景美溪'], ['集水面積', '115 km²'], ['狀態', '已廢']])
  assert.match(v.source, /水利署.*22223/)
  const live = describeInspect({ kind: 'station', n: '思源橋', r: '北勢溪', a: 0.74, s: 1 })
  assert.equal(live.rows[1].v, '0.7 km²'); assert.equal(live.rows[2].v, '現存')
  assert.equal(describeInspect({ kind: 'station', n: 'X', r: '', a: null, s: 1 }).rows[0].v, '—')
  assert.equal(describeInspect({ kind: 'station', n: 'X', r: 'Y', a: 12345.6, s: 1 }).rows[1].v, '12,346 km²')
})
test('測站卡片（英文）：站名 / 河川名維持原文，其餘為英文', () => {
  const v = inEn(() => describeInspect({ kind: 'station', n: '景美', r: '景美溪', a: 114.95, s: 0 }))
  assert.equal(v.title, '景美'); assert.equal(v.eyebrow, 'River gauging station')
  assert.deepEqual(v.rows.map((r) => [r.k, r.v]), [['River', '景美溪'], ['Catchment area', '115 km²'], ['Status', 'Discontinued']])
  assert.match(v.source, /^Source: Water Resources Agency/)
})

test('moonData（月亮海況）：今日月出 / 中天 / 月沒（沒有的顯示 —）+ 現在方位仰角 + 月相', () => {
  const d = moonData({ gov: ocean, opt: optOf('moon-hualien'), now: NOW })
  const today = MOON_DAYS[3]
  assert.equal(d.mode, 'real'); assert.equal(d.date, '2026-09-20'); assert.equal(d.replay, false)
  assert.deepEqual([d.rise, d.transit, d.set, d.alt, d.dir, d.riseAz, d.setAz], [today[1], today[3], '', 38, 'S', 121, null])
  assert.ok(d.age >= 0 && d.age < 29.6)
  const v = describeInspect(d)
  assert.equal(v.title, '月亮'); assert.equal(v.eyebrow, '月出月沒 · 花蓮縣 2026-09-20')
  assert.deepEqual(v.rows.map((r) => r.k), ['月出', '中天', '月沒', '現在', '月相'])
  assert.equal(v.rows[0].v, '13:47 · 方位 121°'); assert.equal(v.rows[1].v, '19:04 · 仰角 38°（南方）'); assert.equal(v.rows[2].v, '—')
  assert.match(v.rows[4].v, /月齡 \d+\.\d 天/)
  assert.match(v.source, /A-B0063-001/)
  assert.equal(d.up, false); assert.equal(v.rows[3].v, '現在在地平線下', '12:30 尚未月出')
})
test('moonData（月亮海況）：月出後在地平線上（方位 / 仰角合理）；月出前 / 月沒後在地平線下', () => {
  const at = (h, m = 0) => moonData({ gov: ocean, opt: optOf('moon-hualien'), now: new Date(2026, 8, 20, h, m) })
  assert.equal(at(6).up, false)                                                          // 前一輪 9/19 23:29 已月沒、今日 13:47 才月出
  const rising = at(14, 30); assert.equal(rising.up, true); assert.ok(rising.az > 100 && rising.az < 180 && rising.elev > 0)
  const high = at(19, 4); assert.ok(Math.abs(high.elev - 38) <= 1 && Math.abs(high.az - 180) <= 1, `中天：${high.az}° / ${high.elev}°`)
  const setting = at(23, 30); assert.equal(setting.up, true); assert.ok(setting.az > 180 && setting.elev < 38)
  assert.match(describeInspect(rising).rows[3].v, /^方位 \d+° · 仰角 \d+°$/)
  assert.equal(describeInspect(at(6)).rows[3].v, '現在在地平線下')
})
test('moonData（月亮海況）：資料播放中 → 顯示播放到的那一天 × 當晚 21:00', () => {
  const idx = MOON_DAYS.findIndex((x) => x[0] === '2026-09-18')
  const d = moonData({ gov: ocean, opt: optOf('moon-hualien'), now: NOW, play: { kind: 'moon', idx } })
  assert.equal(d.replay, true); assert.equal(d.date, '2026-09-18'); assert.equal(d.rise, '12:04'); assert.equal(d.up, true)   // 9/18 月出 12:04、月沒 22:36：21:00 在天上
  const v = describeInspect(d)
  assert.equal(v.rows[3].k, '當晚 21:00'); assert.match(v.rows[3].v, /^方位 \d+° · 仰角 \d+°$/)
  assert.equal(moonData({ gov: ocean, opt: optOf('moon-hualien'), now: NOW, play: { kind: 'moon', idx: 99 } }).replay, false, '播放索引壞掉 → 退回今日')
  assert.doesNotThrow(() => describeInspect(moonData({ gov: ocean, opt: optOf('moon-hualien'), now: NOW, play: { kind: 'moon', idx: 0 } })), '資料頭一天（沒有前一天可對）也不丟錯')
  const cover = moonData({ gov: ocean, opt: optOf('moon-hualien'), now: NOW, play: { kind: 'tide', idx: 1 } })   // 種類不符的播放脈絡不影響
  assert.equal(cover.replay, false)
})
test('moonData：資料視窗不含今日 → 天文公式 + 說明；沒有資料 / 其他海況 → 天文公式月相', () => {
  const far = moonData({ gov: ocean, opt: optOf('moon-hualien'), now: new Date(2031, 0, 5, 12, 0) })
  assert.equal(far.mode, 'sky'); assert.equal(far.outOfRange, true)
  assert.match(describeInspect(far).note, /不含今日/)
  const other = moonData({ gov: ocean, opt: optOf('zengwen'), now: NOW })
  assert.equal(other.mode, 'sky'); assert.match(describeInspect(other).note, /天文公式/)
  assert.equal(moonData({}).mode, 'sky')
})
test('moonData（潮汐海況）：月相 + 潮差 + 農曆', () => {
  const d = moonData({ gov: ocean, opt: optOf('hualien-tide'), now: NOW })
  assert.equal(d.mode, 'tide'); assert.equal(d.range, '小'); assert.equal(d.lunarLabel, '農曆八月初十')
  assert.ok(d.age > 8 && d.age < 10, `農曆初十 → 月齡約 8.5+，實得 ${d.age}`)      // ageFromLunar('…08-10', 12.5h) = 10 − 1.5 + 0.52
  const v = describeInspect(d)
  assert.deepEqual(v.rows.map((r) => r.k), ['潮汐', '潮差', '月相'])
  assert.equal(v.rows[1].v, '小潮'); assert.match(v.rows[0].v, /2026-09-20 · 農曆 八月初十/)
  assert.match(v.note, /潮汐是月亮的引力/); assert.match(v.source, /F-A0021-001/)
})
test('潮汐播放中 → 月齡用序列時刻（與 MoonSky 一致）', () => {
  const a = moonData({ gov: ocean, opt: optOf('hualien-tide'), now: NOW, play: { kind: 'tide', hour: 0.5 } })
  const b = moonData({ gov: ocean, opt: optOf('hualien-tide'), now: NOW, play: { kind: 'tide', hour: 23.5 } })
  assert.ok(b.age > a.age, '一天之內月齡隨時刻增加')
})
test('月亮卡片（英文）：潮差 neap tide、月相英文名、農曆 8/10', () => {
  const v = inEn(() => describeInspect(moonData({ gov: ocean, opt: optOf('hualien-tide'), now: NOW })))
  assert.equal(v.title, 'Moon'); assert.equal(v.eyebrow, 'Tide & moon')
  assert.deepEqual(v.rows.map((r) => r.k), ['Tide', 'Tidal range', 'Moon phase'])
  assert.equal(v.rows[1].v, 'neap tide'); assert.match(v.rows[0].v, /Lunar 8\/10/); assert.match(v.rows[2].v, /moon age \d+\.\d days/)
  const r = inEn(() => describeInspect(moonData({ gov: ocean, opt: optOf('moon-hualien'), now: new Date(2026, 8, 20, 20, 0) })))
  assert.deepEqual(r.rows.map((x) => x.k), ['Moonrise', 'Transit', 'Moonset', 'Now', 'Moon phase'])
  assert.equal(r.rows[0].v, '13:47 · bearing 121°'); assert.equal(r.rows[1].v, '19:04 · altitude 38° (south)'); assert.equal(r.rows[2].v, '—')
  assert.match(r.rows[3].v, /^Bearing \d+° · altitude \d+°$/); assert.match(r.eyebrow, /^Moonrise & moonset · .+ 2026-09-20$/)
  assert.doesNotMatch(r.eyebrow, /[㐀-鿿]/, '縣市名有英文')
  assert.match(r.source, /^Source: CWA/)
  const below = inEn(() => describeInspect(moonData({ gov: ocean, opt: optOf('moon-hualien'), now: new Date(2026, 8, 20, 6, 0) })))
  assert.equal(below.rows[3].v, 'Below the horizon now')
})

test('birdData / 鳥群卡片：流域 / 本月鳥種數（實測或內插）/ 調查年範圍 / 群數', () => {
  const opt = optOf('feitsui')                                                           // monthly: 2 月 84、5 月 82、8 月 68、10 月 90
  const feb = birdData({ opt, month: 1 })
  assert.equal(feb.value, 84); assert.equal(feb.interpolated, false); assert.deepEqual([feb.from, feb.to, feb.years], [2005, 2017, 4])
  const v = describeInspect(feb)
  assert.equal(v.title, '鳥群')
  assert.deepEqual(v.rows.map((r) => r.k), ['流域', '鳥種數', '調查年', '推算群數'])
  assert.equal(v.rows[0].v, '淡水河流域'); assert.equal(v.rows[1].v, '2 月 · 84 種'); assert.equal(v.rows[2].v, '2005–2017（4 個年度）')
  assert.match(v.rows[3].v, /^\d 群$/); assert.match(v.source, /32720/)
  const sep = describeInspect(birdData({ opt, month: 8 }))
  assert.match(sep.rows[1].v, /^9 月 · \d+ 種（內插）$/)
  const en = inEn(() => describeInspect(birdData({ opt, month: 8 })))
  assert.equal(en.rows[0].k, 'Basin'); assert.match(en.rows[1].v, /^Sep · \d+ species \(interpolated\)$/)
  assert.equal(en.rows[2].v, '2005–2017 (4 survey years)'); assert.equal(en.rows[1].k, 'Bird species')
  const one = inEn(() => describeInspect(birdData({ opt: { birds: { basin: '大甲溪流域', species: 80, monthly: [62, null, null, null, null, null, null, null, null, null, null, null], yearly: [{ y: 2012, s: 77 }] } }, month: 0 })))
  assert.equal(one.rows[2].v, '2012–2012 (1 survey year)')
})
test('birdData：沒指定月份用現實月份；本月無資料 / 沒有 birds → 卡片仍可讀（不丟錯）', () => {
  assert.equal(birdData({ opt: optOf('deji'), now: new Date(2026, 3, 10) }).month, 3)
  assert.equal(birdData({ opt: optOf('deji'), month: 5, now: new Date(2026, 3, 10) }).month, 5)
  const none = birdData({ opt: { name: 'x' } })
  assert.equal(none.none, true)
  assert.match(describeInspect(none).note, /沒有對應的鳥類調查資料/)
  const noMonthly = describeInspect(birdData({ opt: { birds: { basin: 'A流域', species: 10, monthly: [], yearly: [] } }, month: 2 }))
  assert.equal(noMonthly.rows.find((r) => r.k === '鳥種數').v, '尚無資料'); assert.equal(noMonthly.rows.find((r) => r.k === '調查年').v, '—')
  assert.equal(noMonthly.rows.find((r) => r.k === '推算群數'), undefined)
})
test('buildInspectData：依命中物件的種類組資料；未知種類 / 空 → null', () => {
  const ctx = { gov: ocean, opt: optOf('zengwen'), now: NOW, month: null, play: null }
  assert.equal(buildInspectData({ kind: 'station', id: 1 }, ctx).n, '思源橋')
  assert.equal(buildInspectData({ kind: 'moon', id: 'moon' }, ctx).kind, 'moon')
  assert.equal(buildInspectData({ kind: 'bird', id: 0 }, ctx).basin, '曾文溪流域')
  assert.equal(buildInspectData({ kind: 'ufo' }, ctx), null); assert.equal(buildInspectData(null, ctx), null)
  assert.equal(buildInspectData({ kind: 'station', id: 1 }, {}), null); assert.equal(buildInspectData({ kind: 'station', id: 99 }, ctx), null)
})
test('中天方向：N → 北方、S → 南方、未知 → 只給仰角、缺仰角 → 只給時刻、缺中天 → —', () => {
  const base = { kind: 'moon', mode: 'real', county: '花蓮縣', date: '2026-09-20', age: 9, up: false, transit: '12:00', alt: 60, dir: 'N' }
  const row = (o) => describeInspect({ ...base, ...o }).rows[1].v   // 第 2 列＝中天（中英文的列名不同，用位置取）
  assert.equal(row({}), '12:00 · 仰角 60°（北方）'); assert.equal(row({ dir: 'S' }), '12:00 · 仰角 60°（南方）'); assert.equal(row({ dir: '' }), '12:00 · 仰角 60°')
  assert.equal(row({ alt: null }), '12:00'); assert.equal(row({ transit: '' }), '—')
  assert.equal(inEn(() => row({})), '12:00 · altitude 60° (north)')
})
test('describeInspect：缺欄位 / 亂資料不丟錯（觀眾視窗收到的是外來 JSON）', () => {
  assert.equal(describeInspect(null), null); assert.equal(describeInspect({ kind: 'ufo' }), null); assert.equal(describeInspect('x'), null)
  for (const kind of ['station', 'moon', 'bird']) assert.doesNotThrow(() => describeInspect({ kind }))
  assert.doesNotThrow(() => describeInspect({ kind: 'moon', mode: 'real' })); assert.doesNotThrow(() => describeInspect({ kind: 'moon', mode: 'tide' }))
})


// ── 真實 ocean.json 煙霧測試：不寫死日期，只驗「不丟錯、結構正確、英文無中文」 ──
test('真實資料：每座測站 / 每個海況選項都能組出卡片（中英文），英文卡片除專有名詞外不含中文', () => {
  const HAN = /[㐀-鿿豈-﫿]/
  const list = realOcean.stations.list
  assert.ok(list.length > 100)
  for (const i of [0, Math.floor(list.length / 2), list.length - 1]) {
    const d = stationData(list, i), v = describeInspect(d)
    assert.equal(v.rows.length, 3); assert.equal(v.title, list[i].n)
    const en = inEn(() => describeInspect(d))
    assert.equal(en.rows[0].k, 'River'); assert.doesNotMatch([en.eyebrow, en.note, en.source, en.rows[1].k, en.rows[1].v, en.rows[2].v].join(' '), HAN)
  }
  const days = realOcean.moon.days
  const mid = days[Math.floor(days.length / 2)][0].split('-').map(Number)
  const now = new Date(mid[0], mid[1] - 1, mid[2], 20, 0)
  for (const o of realOcean.options) {
    const ctx = { gov: realOcean, opt: o, now, month: null, play: null }
    for (const kind of ['moon', 'bird']) {
      const d = buildInspectData({ kind }, ctx)
      assert.ok(describeInspect(d), `${o.id}/${kind}`)
      const en = inEn(() => describeInspect(d))
      assert.doesNotMatch([en.eyebrow, en.title, en.note || '', en.source || '', ...en.rows.flatMap((r) => [r.k, r.v])].join(' '), HAN, `${o.id}/${kind} 英文卡片含中文：${JSON.stringify(en)}`)
    }
  }
  const moonOpt = realOcean.options.find((o) => o.kind === 'moon')
  assert.equal(moonData({ gov: realOcean, opt: moonOpt, now }).mode, 'real')
  assert.equal(describeInspect(moonData({ gov: realOcean, opt: moonOpt, now })).rows.length, 5)
})

// ───────────────────────────── 卡片狀態 store ─────────────────────────────
function makeTimers() {
  let now = 0, seq = 0
  const q = new Map()
  return {
    setTimeoutFn: (fn, ms) => { const id = ++seq; q.set(id, { at: now + ms, fn }); return id },
    clearTimeoutFn: (id) => { q.delete(id) },
    advance(ms) { const end = now + ms; for (;;) { let pick = null; for (const [id, x] of q) if (x.at <= end && (!pick || x.at < pick.x.at)) pick = { id, x }; if (!pick) break; q.delete(pick.id); now = Math.max(now, pick.x.at); pick.x.fn() } now = end },
    pending: () => q.size,
  }
}
const DATA = { kind: 'station', n: '景美', r: '景美溪', a: 1, s: 1 }

test('store：開 / 關；seq 每次開卡 +1；訂閱通知；壞資料不開', () => {
  const tm = makeTimers(); const s = createInspectStore(tm)
  let n = 0; const off = s.subscribe(() => n++)
  assert.equal(s.get().open, false)
  assert.equal(s.open({ kind: 'ufo' }), false); assert.equal(s.open(null), false); assert.equal(s.get().open, false)
  assert.equal(s.open(DATA, { x: 0.25, y: 0.75 }), true)
  assert.deepEqual([s.get().open, s.get().x, s.get().y, s.get().seq, s.get().data], [true, 0.25, 0.75, 1, DATA])
  s.open(DATA, { x: 2, y: -1 }); assert.deepEqual([s.get().x, s.get().y, s.get().seq], [1, 0, 2])          // 位置夾在 0..1
  const ref = s.get(); s.close(); s.close(); assert.equal(s.get().open, false); assert.equal(s.get().data, null); assert.notEqual(s.get(), ref)
  const closed = s.get(); s.close(); assert.equal(s.get(), closed, '重複關閉：狀態參考不變')
  const before = n; off(); s.open(DATA); assert.equal(n, before, '取消訂閱後不再通知')
  assert.equal(tm.pending(), 1); s.dispose(); assert.equal(tm.pending(), 0)
})
test('store：6 秒無操作自動關；操作（touch）重新計時；游標停在卡片上暫停、離開後重新計 6 秒', () => {
  assert.equal(IDLE_MS, 6000)
  const tm = makeTimers(); const s = createInspectStore(tm)
  s.open(DATA)
  tm.advance(5900); assert.equal(s.get().open, true)
  s.touch(); tm.advance(5900); assert.equal(s.get().open, true, 'touch 後重新計時')
  tm.advance(200); assert.equal(s.get().open, false)
  s.open(DATA); s.hold(true); assert.equal(tm.pending(), 0); tm.advance(60000); assert.equal(s.get().open, true, '停在卡片上：不自動關')
  s.hold(false); tm.advance(5900); assert.equal(s.get().open, true); tm.advance(200); assert.equal(s.get().open, false)
  s.open(DATA); tm.advance(1000); s.open(DATA); tm.advance(5500); assert.equal(s.get().open, true, '開新卡重新計時')
  s.close(); assert.equal(tm.pending(), 0, '關閉後不留計時器')
})
test('store：游標停在卡片上時卡片被關掉（Esc / 點空白，pointerleave 可能不會來）→ 下一張新卡片仍會自動關', () => {
  const tm = makeTimers(); const s = createInspectStore(tm)
  s.open(DATA); s.hold(true); s.close()
  s.open(DATA); tm.advance(6100)
  assert.equal(s.get().open, false)
})
test('store：觀眾視窗 applyMirror 只設定狀態（位置為 0..1）；壞值忽略；主視窗失聯時保險計時關閉', () => {
  assert.equal(FAILSAFE_MS > IDLE_MS, true)
  const tm = makeTimers(); const s = createInspectStore(tm)
  s.applyMirror({ open: true, data: DATA, x: 0.4, y: 0.6, seq: 9 })
  assert.deepEqual([s.get().open, s.get().x, s.get().y, s.get().seq], [true, 0.4, 0.6, 9])
  s.applyMirror(null); s.applyMirror('x'); assert.equal(s.get().open, true, '壞值忽略')
  s.applyMirror({ open: true, data: { kind: 'ufo' } }); assert.equal(s.get().open, false, '未知種類 → 視為關閉')
  s.applyMirror({ open: true, data: DATA, x: 5, y: NaN }); assert.deepEqual([s.get().x, s.get().y], [1, 0.5])
  tm.advance(FAILSAFE_MS - 100); assert.equal(s.get().open, true); tm.advance(200); assert.equal(s.get().open, false)
  s.applyMirror({ open: true, data: DATA }); s.applyMirror({ open: false }); assert.equal(s.get().open, false); assert.equal(tm.pending(), 0)
})
test('sanitizeInspectState：open 但沒有合法資料 → 關閉；關閉時不帶資料', () => {
  assert.equal(sanitizeInspectState(undefined), null)
  assert.equal(sanitizeInspectState({ open: true }).open, false)
  assert.deepEqual(sanitizeInspectState({ open: false, data: DATA, x: 0.2, y: 0.3, seq: 3.7 }), { open: false, data: null, x: 0.2, y: 0.3, seq: 3 })
  assert.equal(sanitizeInspectState({ open: 'yes', data: DATA }).open, false)
})
test('與鏡像相容：狀態可 JSON 序列化再還原後 apply（觀眾視窗走 BroadcastChannel）', () => {
  const host = createInspectStore(makeTimers()), aud = createInspectStore(makeTimers())
  host.open({ kind: 'bird', basin: '淡水河流域', month: 8, value: 79, interpolated: true, from: 2005, to: 2017, years: 4, flocks: 3 }, { x: 0.3, y: 0.4 })
  aud.applyMirror(JSON.parse(JSON.stringify(host.get())))
  assert.deepEqual(aud.get(), host.get())
  assert.match(describeInspect(aud.get().data).rows[1].v, /9 月 · 79 種（內插）/)
})
