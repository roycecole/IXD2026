// 導覽字幕的版面規則（純 CSS，沒有瀏覽器可跑；這裡守住規則存在與其覆蓋關係）。執行：node --test src/lib/captionCss.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const tour = read('../styles/tour.css'), aud = read('../styles/audience.css')

// 取出 @media (max-width: 820px) { ... } 區塊（大括號配對）
function mediaBlock(css, head) {
  const i = css.indexOf(head); assert.ok(i >= 0, `找不到 ${head}`)
  let depth = 0, j = css.indexOf('{', i)
  const start = j
  for (; j < css.length; j++) { if (css[j] === '{') depth++; else if (css[j] === '}') { depth--; if (!depth) break } }
  return css.slice(start, j + 1)
}

test('展場 ≤820px（iPad 直放 / 手機）：有掃碼 QR 時字幕抬到 QR 上方，不蓋住它', () => {
  const m = mediaBlock(tour, '@media (max-width: 820px)')
  assert.match(m, /\.app\.stagemode \.canvas-wrap:has\(\.kiosk-qr\) \.tour-caption \{ bottom: 176px; \}/)
  // QR 盒（styles.css：≤820px 畫布 104px + 說明字 + 邊距）頂端約在畫布底邊上方 170px 以內；字幕底邊要比它高
  const css = read('../styles.css')
  assert.match(css, /\.kiosk-qr canvas \{ width: 104px; height: 104px; \}/)
  assert.match(css, /\.kiosk-qr \{[^}]*bottom: 12px;/)
})

test('觀眾視窗：導覽字幕依視窗寬度放大（與資料看板同一個 clamp），標題 / 內文用 em、行數上限兩種寫法都有', () => {
  assert.match(aud, /\.audience-app \.tour-caption \{[^}]*font-size: clamp\(14px, 1\.05vw, 30px\)/)
  assert.match(aud, /\.audience-app \.tour-caption \{[^}]*max-width: min\(70vw, 1600px\)/)
  assert.match(aud, /\.audience-app \.tour-cap-title \{ font-size: 1\.5em; \}/)
  assert.match(aud, /\.audience-app \.tour-cap-body \{[^}]*font-size: 1\.05em;[^}]*-webkit-line-clamp: 3;[^}]*line-clamp: 3;/)
  // 資料看板：clamp(12px, 1.05vw, 30px) → 1920px 寬 = 20.2px；字幕內文 1.05em × 20.2 = 21.2px（先前固定 15.5px，比看板還小）
  const board = aud.match(/\.audience-app \.data-board \{[^}]*font-size: clamp\(12px, 1\.05vw, 30px\)/)
  assert.ok(board, '資料看板的 clamp（字幕沿用同一個係數）')
})

test('觀眾視窗的字幕規則都以 .audience-app 開頭（比 tour.css 的 1-class 規則與 ≤820px media query 優先）', () => {
  const rules = aud.split('\n').filter((l) => /tour-/.test(l) && /\{/.test(l))
  assert.ok(rules.length >= 6)
  for (const r of rules) assert.match(r.trim(), /^\.audience-app /, r)
})
