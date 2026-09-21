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

test('觀眾視窗：導覽員的備註（.tour-cap-note）與出處 / 授權行（.tour-cap-src）也依容器放大（em），不再是投影上最小的固定 13.5 / 11.5px；權重壓過 tourplan.css 的 px 與 ≤820px 規則', () => {
  const note = /\.audience-app \.tour-cap-note \{([^}]*)\}/.exec(aud), src = /\.audience-app \.tour-cap-src \{([^}]*)\}/.exec(aud)
  assert.ok(note && src, '觀眾視窗有備註 / 出處行的規則')
  const em = (body, prop) => Number(new RegExp(prop + ':\\s*([0-9.]+)em').exec(body)?.[1])
  assert.ok(em(note[1], 'font-size') >= 0.85 && em(note[1], 'font-size') < 1.05, '備註略小於說明（1.05em）但不是固定 px')
  assert.ok(em(src[1], 'font-size') >= 0.75 && em(src[1], 'font-size') < em(note[1], 'font-size'), '出處行比備註更小')
  assert.doesNotMatch(note[1] + src[1], /font-size:\s*[0-9.]+px/, '不用固定 px')
  // 算術：1920px 寬的容器 = clamp(14px, 1.05vw, 30px) ≈ 20.2px → 備註 ≥ 18px、出處 ≥ 16px；4K 封頂 30px → 備註 ≥ 25px
  const c1080 = Math.min(30, Math.max(14, 0.0105 * 1920)), c4k = 30
  assert.ok(c1080 * em(note[1], 'font-size') >= 17.5 && c1080 * em(src[1], 'font-size') >= 15.5)
  assert.ok(c4k * em(note[1], 'font-size') >= 25)
  // tourplan.css 仍是固定 px（主視窗不放大）——本檔的規則靠 2 個 class 的權重壓過它，不改它
  const plan = read('../styles/tourplan.css')
  assert.match(plan, /\.tour-cap-note \{[^}]*font-size: 13\.5px/); assert.match(plan, /\.tour-cap-src \{[^}]*font-size: 11\.5px/)
  // 觀眾視窗的樹狀結構沒有 .app / .canvas-wrap：tourplan.css 的橫放矮螢幕規則（.app .canvas-wrap …）不會蓋到它
  assert.doesNotMatch(read('../AudienceApp.jsx').replace(/\/\/.*$/gm, ''), /className="app\b|canvas-wrap/)
})

test('觀眾視窗的字幕規則都以 .audience-app 開頭（比 tour.css 的 1-class 規則與 ≤820px media query 優先）', () => {
  const rules = aud.split('\n').filter((l) => /tour-/.test(l) && /\{/.test(l))
  assert.ok(rules.length >= 6)
  for (const r of rules) assert.match(r.trim(), /^\.audience-app /, r)
})

test("導覽字幕：帶了「模型 vs 觀測」比較句（data-long='cmp'）→ 桌面 3 行、手機 / 橫放矮螢幕放寬到 ≥ 5 行（比較結論在句尾，不能被省略號吃掉）；TourCaption 依 cmpSrc 設定", () => {
  const plan = read('../styles/tourplan.css')
  assert.match(plan, /\.tour-cap-body\[data-long='cmp'\] \{ -webkit-line-clamp: 3; line-clamp: 3; \}/, '桌面 3 行')
  const clamp = (block, sel) => { const m = new RegExp(sel + " \\{ -webkit-line-clamp: (\\d+); line-clamp: (\\d+); \\}").exec(block); assert.ok(m, sel); assert.equal(m[1], m[2], '兩種寫法都要（只寫後者在 Chromium / Safari 蓋不掉）'); return Number(m[1]) }
  const mobile = mediaBlock(plan, '@media (max-width: 820px)'), land = mediaBlock(plan, '@media (orientation: landscape) and (max-height: 460px)')
  assert.ok(clamp(mobile, "\\.tour-cap-body\\[data-long='cmp'\\]") >= 5, '≤820px（手機直放）')
  assert.ok(clamp(land, "\\.app \\.canvas-wrap \\.tour-cap-body\\[data-long='cmp'\\]") >= 5, '橫放矮螢幕（選擇器與該區塊既有的 data-long 規則同權重）')
  const cap = read('../ui/TourCaption.jsx')
  assert.match(cap, /data-long=\{cmpSrc \? 'cmp' : txt\.body\.length > \(locale === 'en' \? LONG_BODY\.en : LONG_BODY\.zh\) \? 'true' : undefined\}/)
  assert.ok(cap.indexOf('const cmpSrc') < cap.indexOf("data-long={cmpSrc"), 'cmpSrc 先宣告')
})
