// 導覽員 QR（按 G）與導覽字幕的版面關係（純 CSS，沒有瀏覽器可跑；這裡守住「字幕預留量 ≥ QR 盒右緣」的算術與規則存在）。執行：node --test src/lib/guideQrLayout.test.mjs
// 回歸：英文說明（'Guide QR · presenters only'、'Back to the regular QR in 60 s'）比 156px 畫布寬 → 盒子被撐到 ~205–222px，右緣往右移，
//   而字幕的左右預留量只照一般 QR（14 + 132 + 18 = 164px）算，字幕（半透明 + blur）蓋在 QR 上 → 模組糊掉、手機掃不到。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { buildRemoteUrl } from './tourRemote.js'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const guide = read('../styles/guide.css'), tour = read('../styles/tour.css'), presenter = read('../styles/tourpresenter.css'), base = read('../styles.css')

const LEFT = 14                                                    // .kiosk-qr { left: 14px }（styles.css）
const GAP = 12                                                     // 盒子右緣與字幕之間至少留的空白

function ruleBody(css, selector) {                                 // 第一個「selector { ... }」的內容（不含巢狀）
  const i = css.indexOf(selector + ' {'); assert.ok(i >= 0, `找不到 ${selector}`)
  return css.slice(css.indexOf('{', i) + 1, css.indexOf('}', i))
}

test('導覽員 QR 盒：寬度上限 = 畫布 156 + 內距 16 + 邊框 2 = 174px（英文長說明在盒內換行，不撐寬）；說明 / 倒數置中', () => {
  const body = ruleBody(guide, '.kiosk-qr.is-guide')
  const max = Number(/max-width:\s*(\d+)px/.exec(body)?.[1])
  assert.equal(max, 174)
  assert.match(guide, /\.kiosk-qr\.is-guide canvas \{ width: 156px; height: 156px; \}/)
  assert.match(base, /\* \{ box-sizing: border-box; \}/, 'max-width 含內距與邊框的前提（border-box）')
  assert.match(base, /\.kiosk-qr \{[^}]*left: 14px;/); assert.match(base, /\.kiosk-qr \{[^}]*padding: 8px 8px 6px;/)
  assert.equal(156 + 8 * 2 + 1 * 2, max, '畫布 + 左右內距 + 左右邊框')
  assert.match(guide, /\.kiosk-qr\.is-guide \.kiosk-qr-cap, \.kiosk-qr\.is-guide \.kiosk-qr-count \{ text-align: center; \}/)
})

test('寬螢幕（> 820px）：導覽員 QR 出現時，字幕左右各預留 ≥ 盒子右緣 + 留白（不蓋住 QR）；一般 QR 的預留量（340px）不動', () => {
  const max = Number(/max-width:\s*(\d+)px/.exec(ruleBody(guide, '.kiosk-qr.is-guide'))[1])
  const reserve = 2 * (LEFT + max + GAP)                           // 兩側對稱預留
  const m = /@media \(min-width: 821px\) and \(min-height: 461px\) \{\s*\.app\.stagemode \.canvas-wrap:has\(\.kiosk-qr\.is-guide\) \.tour-caption \{ max-width: max\(260px, min\(780px, calc\(100% - (\d+)px\)\)\); \}/.exec(tour)
  assert.ok(m, 'tour.css 有導覽員 QR 專用的寬螢幕字幕收窄規則')
  assert.ok(Number(m[1]) >= reserve, `預留 ${m[1]}px ≥ 2 × (${LEFT} + ${max} + ${GAP}) = ${reserve}px`)
  assert.match(tour, /\.app\.stagemode \.tour-caption \{ max-width: max\(260px, min\(780px, calc\(100% - 340px\)\)\); \}/, '一般演出模式的字幕預留不變')
  // 一般 QR（132px 畫布 + 內距 16 + 邊框 2 = 150px 寬，右緣 14 + 150 = 164px）在每側 170px 的預留內：導覽員 QR 才需要更多
  assert.ok(LEFT + 132 + 16 + 2 <= 340 / 2)
})

test('≤820px（直放 iPad / 手機）：導覽員 QR 出現時字幕抬到 216px（QR 盒 124px 畫布 + 換行後的說明 ≈ 190–205px）；比一般 QR 的 176px 高', () => {
  const i = tour.indexOf('@media (max-width: 820px)'); assert.ok(i >= 0)
  const block = tour.slice(i, tour.indexOf('@media (prefers-reduced-motion', i))
  const a = /:has\(\.kiosk-qr\) \.tour-caption \{ bottom: (\d+)px; \}/.exec(block), b = /:has\(\.kiosk-qr\.is-guide\) \.tour-caption \{ bottom: (\d+)px; \}/.exec(block)
  assert.ok(a && b); assert.equal(Number(a[1]), 176); assert.ok(Number(b[1]) >= 216 && Number(b[1]) > Number(a[1]))
  // 盒高粗估：124 畫布 + 說明 2 行（12px × 1.4 × 2 ≈ 34）+ 倒數 2 行（10.5 × 1.4 × 2 ≈ 30）+ 內距 14 + 邊框 2 + 間距 6 + 距底 12 ≈ 222 → 留 10px 內的餘量以 216 為下限（字幕本身有 8px 內距）
  assert.ok(Number(b[1]) >= 124 + 34 + 30 + 14 + 2 + 6 + 12 - 22)
})

test('矮的橫放螢幕：導覽員 QR 出現時字幕在 QR 右邊（left 196px > 盒右緣 188px），且蓋回 ≤820px 那條 216px 的規則（同權重、tourpresenter.css 較後載入）', () => {
  const max = Number(/max-width:\s*(\d+)px/.exec(ruleBody(guide, '.kiosk-qr.is-guide'))[1])
  const m = /:has\(\.kiosk-qr\.is-guide\) \.tour-caption \{ left: (\d+)px; bottom: 8px; max-width: min\(44vw, calc\(100% - (\d+)px\)\); \}/.exec(presenter)
  assert.ok(m, 'tourpresenter.css 的橫放區塊有導覽員 QR 規則')
  assert.ok(Number(m[1]) >= LEFT + max + 8, `left ${m[1]}px ≥ 盒右緣 ${LEFT + max}px + 8`)
  assert.ok(Number(m[2]) >= Number(m[1]) + 12, '右邊界扣掉的量要含左邊的位移，字幕不會超出畫布')
  // 橫放矮螢幕的區塊裡：導覽員規則在一般 QR 規則之後（同區塊、後者優先）
  const land = presenter.slice(presenter.indexOf('@media (orientation: landscape) and (max-height: 460px)'))
  assert.ok(land.indexOf(':has(.kiosk-qr) .tour-caption') < land.indexOf(':has(.kiosk-qr.is-guide) .tour-caption'))
  // 載入順序：TourCaption.jsx 先 import tour.css、再 tourpresenter.css（同權重時後者贏）
  const cap = read('../ui/TourCaption.jsx')
  assert.ok(cap.indexOf("'../styles/tour.css'") >= 0 && cap.indexOf("'../styles/tour.css'") < cap.indexOf("'../styles/tourpresenter.css'"))
})

test('導覽員 QR 的網址夠短：QR 版本 ≤ 5（156px 畫布的每個模組 ≥ 3.5px、手機掃得到；124px 畫布 ≥ 2.7px）——網址變長要重新檢查畫布尺寸', () => {
  const require = createRequire(import.meta.url)
  const QR = require('qrcode')
  const id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', token = 'X'.repeat(32)          // 最長合理的 peer id + token（base64url 32 字）
  const url = buildRemoteUrl('https://midisea.shyetech.com/', id, token)
  const qr = QR.create(url, { errorCorrectionLevel: 'L' })
  assert.ok(qr.version <= 5, `V${qr.version} 的網址 ${url.length} 字元`)
  const modules = qr.modules.size + 2 * 2                                            // margin: 2
  assert.ok(156 / modules >= 3.5 && 124 / modules >= 2.7, `每模組 ${(156 / modules).toFixed(2)}px / ${(124 / modules).toFixed(2)}px`)
})
