// 迷你折線圖（Sparkline.jsx）的測試：座標計算（純函式 sparkModel）+ SSR 標記（esbuild 打包後以 react-dom/server 渲染）。
// 執行：node --test src/ui/Sparkline.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const CACHE_DIR = join(ROOT, 'node_modules', '.cache', 'midisea-air-ui-test')
async function bundleJsx(entry) {
  const result = await build({ entryPoints: [resolve(ROOT, entry)], bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', packages: 'external', loader: { '.css': 'empty' } })
  mkdirSync(CACHE_DIR, { recursive: true })
  const file = join(CACHE_DIR, `${entry.replace(/[^\w]/g, '_')}.${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(file, result.outputFiles[0].text)
  return import(pathToFileURL(file).href)
}
const React = (await import('react')).default
const { renderToStaticMarkup } = await import('react-dom/server')
const { default: Sparkline, sparkModel, SPARK_W } = await bundleJsx('src/ui/Sparkline.jsx')
const css = readFileSync(resolve(ROOT, 'src/styles/air.css'), 'utf8')
const html = (props) => renderToStaticMarkup(React.createElement(Sparkline, props))
const nums = (d) => (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number)

test('sparkModel：不足 2 筆 / 不是陣列 / 整條都沒有有效數字 → null（不渲染）', () => {
  for (const bad of [undefined, null, [], [5], 'abc', 5, {}, [null, null, null], [NaN, Infinity], ['1', '2']]) assert.equal(sparkModel({ points: bad }), null, JSON.stringify(bad))
  assert.equal(sparkModel(), null); assert.equal(sparkModel({}), null)
  assert.ok(sparkModel({ points: [1, 2] })); assert.ok(sparkModel({ points: [null, 2] }))            // 只要主序列 ≥ 2 筆、且有有效值就畫（缺值斷線）
})

test('sparkModel：座標——x 平均分佈在 [2, 238]、y 從 0 起算（濃度類）、數值越大越靠上；路徑用 M / L；座標都在 viewBox 內、沒有 NaN', () => {
  const m = sparkModel({ points: [0, 10, 20, 30], height: 28 })
  assert.equal(m.w, SPARK_W); assert.equal(m.h, 28); assert.equal(m.n, 4)
  const c = nums(m.a)                                                                                // [x0,y0, x1,y1, …]
  assert.deepEqual(c.filter((_, i) => i % 2 === 0), [2, 80.67, 159.33, 238])                          // 2 + i/3 × 236
  const ys = c.filter((_, i) => i % 2 === 1)
  assert.ok(ys[0] > ys[1] && ys[1] > ys[2] && ys[2] > ys[3], 'y 遞減（值越大越靠上）')
  assert.equal(ys[0], m.baseY)                                                                       // 0 落在基準線上
  assert.match(m.a, /^M[\d. ]+(L[\d. ]+)+$/); assert.equal(m.b, '')
  assert.ok(ys.every((y) => y >= 3 && y <= 25), 'y 在上下邊距之內'); assert.ok(!/NaN|undefined|Infinity/.test(JSON.stringify(m)))
  assert.equal(m.lo, 0); assert.ok(m.hi > 30 && m.hi < 33)
  // 高度換算：矮的圖 y 範圍跟著縮
  const s = sparkModel({ points: [0, 10, 20, 30], height: 14 }); assert.equal(s.h, 14); assert.ok(nums(s.a).filter((_, i) => i % 2 === 1).every((y) => y >= 3 && y <= 11))
  for (const bad of [0, -5, NaN, 'x', null, 3]) assert.equal(sparkModel({ points: [1, 2], height: bad }).h, 28, String(bad))   // 不合理的高度 → 28
})

test('sparkModel：缺值（null / 非數字）斷線——下一個有值的點重新 M；孤立的一點畫成零長度線段（圓端點顯示成點）；開頭 / 結尾缺值不影響', () => {
  const m = sparkModel({ points: [5, 6, null, 8, 9, null, 3, null, null, 1, 2] })
  assert.equal((m.a.match(/M/g) || []).length, 4)                                                    // 4 段：[5,6] [8,9] [3] [1,2]
  assert.match(m.a, /M[\d.]+ [\d.]+L[\d.]+ [\d.]+M[\d.]+ [\d.]+L[\d.]+ [\d.]+M([\d.]+ [\d.]+) L\1M/)      // 孤立點 3：M x y L x y（同一個座標）
  const edge = sparkModel({ points: [null, 4, 5, null] }); assert.equal((edge.a.match(/M/g) || []).length, 1)
  const ns = sparkModel({ points: [1, 'x', 3, undefined, 5, {}] }); assert.equal((ns.a.match(/M/g) || []).length, 3)   // 每個有效點各自孤立
  assert.ok(!/NaN/.test(ns.a))
})

test('sparkModel：第二條線（obs）——與主序列同一條 x / y 軸；可以比主序列短或長；y 範圍涵蓋兩條；全 null 的 obs 不畫', () => {
  const a = [10, 20, 30, 40], b = [null, 15, 25, 60]
  const m = sparkModel({ points: a, obs: b })
  assert.ok(m.hi > 60, 'y 範圍涵蓋 obs 的最大值 60'); assert.equal((m.b.match(/M/g) || []).length, 1)
  assert.equal(nums(m.b)[0], nums(m.a)[2])                                                            // obs 第 1 點的 x 對到主序列第 1 點的 x
  assert.equal(sparkModel({ points: a, obs: [null, null] }).b, ''); assert.equal(sparkModel({ points: a, obs: [] }).b, ''); assert.equal(sparkModel({ points: a, obs: 'x' }).b, '')
  const longer = sparkModel({ points: [1, 2], obs: [1, 2, 3, 4, 5] }); assert.equal(longer.n, 5)          // 以較長的那條為時間軸
  const shorter = sparkModel({ points: [1, 2, 3, 4, 5], obs: [1, 2] }); assert.equal(shorter.n, 5); assert.equal((shorter.b.match(/L/g) || []).length, 1)
})

test('sparkModel：marker——整數索引；超出範圍夾在頭 / 尾；負數 / 小數 / 非數字 → 不畫；圓點只畫在有值的那條線', () => {
  const p = [10, 20, 30], o = [5, null, 15]
  assert.equal(sparkModel({ points: p, marker: 1 }).markerX, 120); assert.ok(sparkModel({ points: p, marker: 1 }).dotA)
  assert.equal(sparkModel({ points: p, marker: 99 }).markerX, 238); assert.equal(sparkModel({ points: p, marker: 0 }).markerX, 2)
  for (const bad of [-1, 1.5, NaN, '1', null, undefined]) { const m = sparkModel({ points: p, marker: bad }); assert.equal(m.markerX, null, String(bad)); assert.equal(m.dotA, null) }
  const m = sparkModel({ points: p, obs: o, marker: 1 }); assert.ok(m.dotA); assert.equal(m.dotB, null)   // obs 在第 1 小時缺值 → 沒有第二個點
  assert.ok(sparkModel({ points: p, obs: o, marker: 2 }).dotB)
  const m2 = sparkModel({ points: p, marker: 1 }); assert.equal(m2.dotA.x, m2.markerX)
})

test('sparkModel：y 軸——全部 ≥ 0 從 0 起算（zero）；有負值 / zero=false 用資料範圍加邊；全部相同不會除以 0', () => {
  const z = sparkModel({ points: [20, 22, 21] }); assert.equal(z.lo, 0)
  const nz = sparkModel({ points: [20, 22, 21], zero: false }); assert.ok(nz.lo > 19 && nz.lo < 20 && nz.hi > 22 && nz.hi < 23)
  const neg = sparkModel({ points: [-5, 5, 0] }); assert.ok(neg.lo < -5 && neg.hi > 5)
  for (const flat of [[7, 7, 7], [0, 0, 0], [-3, -3]]) { const m = sparkModel({ points: flat }); assert.ok(!/NaN|Infinity/.test(JSON.stringify(m)), JSON.stringify(flat)); assert.ok(m.hi > m.lo) }
  const one = sparkModel({ points: [5, null, null, 6] }); assert.ok(one && !/NaN/.test(JSON.stringify(one)))
})

test('渲染：role="img" + aria-label、寬度 100%、preserveAspectRatio none、viewBox；主線 spark-a、第二條 spark-b、基準線；不含 NaN / undefined；沒有 <animate> 與 style 動畫', () => {
  const out = html({ points: [10, 20, 15, 30], obs: [12, null, 14, 28], height: 40, marker: 2, ariaLabel: '模型與觀測的折線圖' })
  assert.match(out, /^<svg /); assert.ok(out.includes('role="img"') && out.includes('aria-label="模型與觀測的折線圖"'))
  assert.ok(out.includes('width="100%"') && out.includes('height="40"') && out.includes('preserveAspectRatio="none"') && out.includes(`viewBox="0 0 ${SPARK_W} 40"`))
  assert.equal((out.match(/class="spark-line spark-a"/g) || []).length, 1); assert.equal((out.match(/class="spark-line spark-b"/g) || []).length, 1)
  assert.ok(out.includes('class="spark-base"') && out.includes('class="spark-marker"') && out.includes('class="spark-dot spark-a"') && out.includes('class="spark-dot spark-b"'))
  assert.equal((out.match(/vector-effect="non-scaling-stroke"/g) || []).length, 6)                     // 基準線 + 2 條線 + marker + 2 個圓點：縮放不改變線寬
  assert.ok(out.includes('fill="none"')); assert.ok(!/NaN|undefined|null|<animate|<style|animation/.test(out), out)
  assert.ok(!out.includes('aria-hidden'))
})

test('渲染：不足 2 筆 → 空字串；沒有 ariaLabel → 視為裝飾（aria-hidden、沒有 role）；沒有 obs / marker → 沒有第二條線與標記；SSR 兩次結果相同（沒有隨機 / 時間）', () => {
  for (const bad of [{ points: [] }, { points: [5] }, { points: [null, null] }, {}, { points: 'x' }]) assert.equal(html({ ...bad, ariaLabel: 'x' }), '', JSON.stringify(bad))
  const deco = html({ points: [1, 2, 3] }); assert.ok(deco.includes('aria-hidden="true"') && !deco.includes('role=') && !deco.includes('aria-label'))
  assert.equal(html({ points: [1, 2, 3], ariaLabel: '' }).includes('role='), false)
  const one = html({ points: [1, 2, 3], ariaLabel: 'a' }); assert.ok(!one.includes('spark-line spark-b') && !one.includes('spark-marker') && !one.includes('spark-dot'))
  const p = { points: [3, 5, 4, 8], obs: [2, 4, 5, 6], marker: 1, ariaLabel: 'a' }; assert.equal(html(p), html(p))
  assert.ok(html({ points: [1, 2], ariaLabel: 'a"<b>' }).includes('aria-label="a&quot;&lt;b&gt;"'))       // 屬性值被跳脫，不能注入
})

test('CSS：模型 = 琥珀色（--amber）、觀測 = 綠色（--accent）、marker 用 --muted；沒有動畫；prefers-reduced-motion 有防護；顏色都走 CSS 變數', () => {
  assert.match(css, /\.spark-a \{ stroke: var\(--amber\); \}/); assert.match(css, /\.spark-b \{ stroke: var\(--accent\); \}/)
  assert.match(css, /\.spark-marker \{[^}]*stroke: var\(--muted\)/)
  assert.match(css, /\.spark \{[^}]*width: 100%/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.spark[^}]*animation: none/)
  const block = css.slice(css.indexOf('.spark {'), css.indexOf('.gov-air-compare'))
  assert.ok(!/@keyframes|animation:\s*(?!none)|transition:\s*(?!none)/.test(block.replace(/@media \(prefers-reduced-motion[\s\S]*?\}\s*\}?/, '')), '折線本身沒有動畫')
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(block.split('/* ---- 模型 vs 觀測')[0]), '折線的顏色不寫死')
})
