// 新手導覽（lib/onboarding.js + ui/Onboarding.jsx 的接線）的單元測試。執行：node --test src/lib/onboarding.test.mjs
// 涵蓋：shouldAutoShow 各種組合（seen / onboarded / kiosk / audience / diagnostics / remote / ?onboard 覆寫 / localStorage 不可用）、
// 存取順序（開始不寫、完成 / 略過才寫；首次到訪的判斷不受影響）、步驟定義與英文、目標解析（缺失 → 置中）、
// 卡片定位幾何（各種視窗 × 目標位置：不超出視窗、不遮住目標、手機貼底 / 貼頂）、可見矩形與捲動（假 DOM）、導航狀態機、鍵盤、說明視窗中英對應。
// 瀏覽器專屬：假 storage / 假 DOM 都會檢查 this（原生方法脫離原物件呼叫會丟 Illegal invocation，Node 不會，所以要在假物件裡模擬）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadEnDict, HAN, placeholders } from '../../scripts/i18n-check.mjs'
import { registerEn, setLocale, t } from '../i18n/index.js'
import { LS } from './persist.js'
import {
  STEPS, NEXT_LABEL, COMPACT_MAX, isCompact, progressOf, onboardParam, isRemoteHash, shouldAutoShow, isFirstVisit, markDone, keyToAction,
  rectFrom, intersectRects, overlapArea, rectArea, padRect, isUsableRect, scrollDelta1D, visibleRectOf, scrollTargetIntoView, resolveTarget,
  cardWidthFor, placeCard, createOnboarding,
} from './onboarding.js'

const { dict } = await loadEnDict()
registerEn(dict)
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const SEEN = 'ixd2026.seen', ONB = 'ixd2026.onboarded'

// ---- 假 storage：檢查 this、可設定「讀 / 寫會丟例外」、記錄寫入 ----
function fakeStorage({ init = {}, throwGet = false, throwSet = false } = {}) {
  const data = new Map(Object.entries(init)), writes = []
  const s = {
    data, writes,
    getItem(k) { if (this !== s) throw new TypeError('Illegal invocation'); if (throwGet) throw new DOMException('denied', 'SecurityError'); return data.has(k) ? data.get(k) : null },
    setItem(k, v) { if (this !== s) throw new TypeError('Illegal invocation'); if (throwSet) throw new DOMException('quota', 'QuotaExceededError'); writes.push(k); data.set(k, String(v)) },
  }
  return s
}

// =============================================================================================
// 偏好鍵 / 網址參數
// =============================================================================================
test('偏好鍵：seen 沿用既有的 ixd2026.seen；onboarded 是新鍵', () => {
  assert.equal(LS.seen, SEEN)
  assert.equal(LS.onboarded, ONB)
})

test('onboardParam：?onboard=1 / ?onboard / =true → on；=0 / false / off / no（不分大小寫）→ off；沒帶 → null', () => {
  for (const s of ['?onboard=1', '?onboard', '?onboard=true', '?x=1&onboard=yes', 'onboard=on']) assert.equal(onboardParam(s), 'on', s)
  for (const s of ['?onboard=0', '?onboard=false', '?onboard=OFF', '?onboard=No']) assert.equal(onboardParam(s), 'off', s)
  for (const s of ['', '?x=1', '?onboards=1', undefined, null]) assert.equal(onboardParam(s), null, String(s))
})

test('isRemoteHash：與 main.jsx 相同，#remote=<非空 id>', () => {
  assert.equal(isRemoteHash('#remote=abc123'), true)
  for (const h of ['#remote=', '#remote', '', '#other=1', undefined, null]) assert.equal(isRemoteHash(h), false, String(h))
})

// =============================================================================================
// shouldAutoShow
// =============================================================================================
test('shouldAutoShow：各種組合', () => {
  const seen = () => fakeStorage({ init: { [SEEN]: '1' } })
  const onb = () => fakeStorage({ init: { [ONB]: '1' } })
  const empty = () => fakeStorage()
  const cases = [
    // 描述, 參數, 預期
    ['首次進站（沒有任何鍵）', { local: empty() }, true],
    ['沒帶 storage 也照首次處理', {}, true],
    ['無關的網址參數（?lang=en&s=…）不影響', { search: '?lang=en&s=abc', local: empty() }, true],
    ['已有 seen（舊使用者）不打擾', { local: seen() }, false],
    ['已有 onboarded 不打擾', { local: onb() }, false],
    ['兩個鍵都有', { local: fakeStorage({ init: { [SEEN]: '1', [ONB]: '1' } }) }, false],
    ['?kiosk（展場整天開著）不顯示', { search: '?kiosk=1', local: empty() }, false],
    ['?kiosk（沒有值）也算', { search: '?kiosk', local: empty() }, false],
    ['?kiosk=0 明確關閉 → 一般首次進站', { search: '?kiosk=0', local: empty() }, true],
    ['?audience=1（觀眾視窗）不顯示', { search: '?audience=1', local: empty() }, false],
    ['?audience=0 不是觀眾視窗', { search: '?audience=0', local: empty() }, true],
    ['?diagnostics=1（診斷頁）不顯示', { search: '?diagnostics=1', local: empty() }, false],
    ['#remote=xyz（手機遙控頁）不顯示', { hash: '#remote=xyz', local: empty() }, false],
    ['#remote= 沒有 id 不算遙控頁', { hash: '#remote=', local: empty() }, true],
    ['?onboard=0 永不顯示（首次進站）', { search: '?onboard=0', local: empty() }, false],
    ['?onboard=false / off / no 也一樣', { search: '?onboard=off', local: empty() }, false],
    ['?onboard=1 強制顯示（已有 seen）', { search: '?onboard=1', local: seen() }, true],
    ['?onboard=1 強制顯示（已有 onboarded）', { search: '?onboard=1', local: onb() }, true],
    ['?onboard（沒有值）強制顯示', { search: '?onboard', local: seen() }, true],
    ['?onboard=1 蓋過 ?kiosk', { search: '?kiosk=1&onboard=1', local: empty() }, true],
    ['?onboard=1 也不會出現在 ?audience', { search: '?audience=1&onboard=1', local: empty() }, false],
    ['?onboard=1 也不會出現在 ?diagnostics', { search: '?diagnostics=1&onboard=1', local: empty() }, false],
    ['?onboard=1 也不會出現在 #remote', { search: '?onboard=1', hash: '#remote=xyz', local: empty() }, false],
    ['?onboard=0 蓋過 ?onboard=1 之外的一切（同時帶 kiosk）', { search: '?kiosk&onboard=0', local: empty() }, false],
  ]
  for (const [name, args, want] of cases) assert.equal(shouldAutoShow(args), want, name)
})

test('shouldAutoShow：localStorage 不可用（隱私模式 / 被封鎖）→ 視為首次，照樣顯示；不丟例外', () => {
  assert.equal(shouldAutoShow({ local: fakeStorage({ throwGet: true }) }), true)          // getItem 丟例外
  assert.equal(shouldAutoShow({ local: () => { throw new DOMException('blocked', 'SecurityError') } }), true)   // 取得 window.localStorage 本身就丟例外
  assert.equal(shouldAutoShow({ local: null, session: null }), true)
  // 但 sessionStorage 記得「這個分頁已完成」→ 不再顯示（重新整理不會又彈）
  assert.equal(shouldAutoShow({ local: fakeStorage({ throwGet: true }), session: fakeStorage({ init: { [ONB]: '1' } }) }), false)
  // ?onboard=0 / 1 不依賴 storage
  assert.equal(shouldAutoShow({ search: '?onboard=0', local: fakeStorage({ throwGet: true }) }), false)
  assert.equal(shouldAutoShow({ search: '?onboard=1', local: () => { throw new Error('x') } }), true)
})

test('shouldAutoShow：storage 可以是物件，也可以是回傳物件的函式（惰性取得）', () => {
  const st = fakeStorage({ init: { [SEEN]: '1' } })
  assert.equal(shouldAutoShow({ local: () => st }), false)
  assert.equal(shouldAutoShow({ local: st }), false)
})

// =============================================================================================
// isFirstVisit / markDone / 存取順序
// =============================================================================================
test('isFirstVisit：只看 seen（與過去 App 載入 ocean.json 時的判斷相同）；讀不到 → false', () => {
  assert.equal(isFirstVisit(fakeStorage()), true)
  assert.equal(isFirstVisit(fakeStorage({ init: { [SEEN]: '1' } })), false)
  assert.equal(isFirstVisit(fakeStorage({ init: { [ONB]: '1' } })), true)        // 只有新鍵、沒有 seen：仍算首次（兩個鍵本來就成對寫入）
  assert.equal(isFirstVisit(fakeStorage({ throwGet: true })), false)               // 過去：catch → false
  assert.equal(isFirstVisit(() => { throw new Error('blocked') }), false)
  assert.equal(isFirstVisit(null), false)
})

test('markDone：seen + onboarded 都寫（值 "1"）；localStorage 寫不進去 → 退到 sessionStorage；全都失敗也不丟例外', () => {
  const l = fakeStorage(), s = fakeStorage()
  assert.deepEqual(markDone(l, s), { seen: true, onboarded: true, session: true })
  assert.equal(l.data.get(SEEN), '1'); assert.equal(l.data.get(ONB), '1'); assert.equal(s.data.get(ONB), '1')
  const bad = fakeStorage({ throwSet: true }), s2 = fakeStorage()
  assert.deepEqual(markDone(bad, s2), { seen: false, onboarded: false, session: true })
  assert.deepEqual(markDone(() => { throw new Error('x') }, fakeStorage({ throwSet: true })), { seen: false, onboarded: false, session: false })
  assert.deepEqual(markDone(null, null), { seen: false, onboarded: false, session: false })
})

test('存取順序：開始 / 翻頁絕不寫 seen（否則首次到訪以今天真實的海開場的判斷會變）；完成 / 略過才寫，而且 App 在進站當下記下的「首次」不受影響', () => {
  const local = fakeStorage(), session = fakeStorage()
  const firstVisitAtMount = isFirstVisit(local)          // App：第一次 render 就記下
  assert.equal(firstVisitAtMount, true)
  const ob = createOnboarding({ getLocal: () => local, getSession: () => session, getEnv: () => ({ search: '', hash: '' }) })
  assert.equal(ob.autoStart(), true)
  ob.next(); ob.next(); ob.prev(); ob.goto(4)
  assert.deepEqual(local.writes, [], '導覽進行中不能寫任何鍵')
  assert.equal(isFirstVisit(local), true, '進行中：載入 ocean.json 時讀到的仍是「首次」')
  ob.skip()
  assert.deepEqual(local.writes.sort(), [ONB, SEEN].sort(), '略過後兩個鍵都寫入')
  assert.equal(isFirstVisit(local), false, '寫入之後下次進站不再是首次')
  assert.equal(firstVisitAtMount, true, 'App 記下的進站當下判斷不變 → 開場的海照首次處理')
})

test('App 接線（原始碼層級）：首次判斷在第一次 render 就記下、早於載入 ocean.json；<Onboarding/> 已掛上；不再自動彈出長篇說明', () => {
  const app = read('../App.jsx')
  const iFirst = app.indexOf('useState(() => isFirstVisit())')
  const iLoad = app.indexOf('loadOceanData().then')
  assert.ok(iFirst > 0 && iLoad > 0 && iFirst < iLoad, 'firstVisit 必須在載入 ocean.json 之前就記下')
  assert.ok(/<Onboarding\s*\/>/.test(app), 'App 要渲染 <Onboarding />')
  assert.ok(/const \[showInfo, setShowInfo\] = useState\(false\)/.test(app), '說明視窗不再自動彈出')
  assert.ok(!/localStorage\.getItem\('ixd2026\.seen'\)/.test(app), '載入 ocean.json 時不再臨時去讀 seen')
})

// =============================================================================================
// 步驟定義 + 英文
// =============================================================================================
test('步驟：七步、順序固定、欄位齊全；歡迎沒有目標（置中）', () => {
  assert.deepEqual(STEPS.map((s) => s.id), ['welcome', 'play', 'sea', 'data', 'tour', 'more', 'done'])
  assert.equal(new Set(STEPS.map((s) => s.id)).size, STEPS.length)
  for (const s of STEPS) {
    assert.ok(s.title && s.body, s.id)
    assert.ok(Array.isArray(s.targets) && s.targets.every((x) => typeof x === 'string' && x.length), s.id)
  }
  assert.deepEqual(STEPS[0].targets, [])
  for (const id of ['play', 'sea', 'data', 'tour', 'more', 'done']) assert.ok(STEPS.find((s) => s.id === id).targets.length >= 1, id)
  assert.equal(STEPS[0].nextLabel, '開始'); assert.equal(STEPS[6].nextLabel, '開始探索'); assert.equal(NEXT_LABEL, '下一步')
})

test('步驟文案要短：每步標題 + 一兩句短句（中文 ≤ 60 字、≤ 2 句；英文 ≤ 190 字元）', () => {
  for (const s of STEPS) {
    assert.ok(s.title.length <= 16, `${s.id} 標題太長：${s.title}`)
    assert.ok(s.body.length <= 60, `${s.id} 內文太長（${s.body.length}）：${s.body}`)
    assert.ok((s.body.match(/。/g) || []).length <= 2, `${s.id} 超過兩句`)
  }
  setLocale('en')
  try {
    for (const s of STEPS) {
      assert.ok(t(s.title).length <= 32, `${s.id} en 標題太長：${t(s.title)}`)
      assert.ok(t(s.body).length <= 190, `${s.id} en 內文太長（${t(s.body).length}）`)
    }
  } finally { setLocale('zh') }
})

test('步驟 / 按鈕 / 提示的英文都有；英文沒有中文字；中文模式輸出不變', () => {
  const keys = [
    ...STEPS.flatMap((s) => [s.title, s.body, s.nextLabel].filter(Boolean)), NEXT_LABEL,
    '新手導覽', '第 {n} / {total} 步', '開始', '下一步', '上一步', '略過', '略過（Esc）', '上一步（←）', '下一步（→ 或 Enter）', '重新看新手導覽', '開始探索',
  ]
  for (const k of keys) {
    assert.equal(t(k, { n: 2, total: 7 }), k.replace('{n}', '2').replace('{total}', '7'), `zh 原樣：${k}`)
    assert.ok(k in dict, `缺英文：${k}`)
    setLocale('en')
    try {
      const en = t(k, { n: 2, total: 7 })
      assert.ok(en && !HAN.test(en) && !/\{\w+\}/.test(en), `${k} → ${en}`)
      assert.deepEqual([...placeholders(String(dict[k]))].sort(), [...placeholders(k)].sort(), `placeholder：${k}`)
    } finally { setLocale('zh') }
  }
  setLocale('en'); try { assert.equal(t('第 {n} / {total} 步', { n: 3, total: 7 }), 'Step 3 of 7') } finally { setLocale('zh') }
})

test('步驟的選擇器對得上現有元件（改 class 名稱會在這裡被抓到）', () => {
  const src = ['../App.jsx', '../ui/TopBar.jsx', '../ui/ParamPanel.jsx', '../ui/DataCard.jsx', '../ui/TourControls.jsx', '../ui/Footer.jsx'].map(read).join('\n')
  for (const s of STEPS) for (const sel of s.targets) {
    for (const m of sel.matchAll(/\.([\w-]+)/g)) assert.ok(src.includes(m[1]), `${s.id}：找不到 class ${m[1]}（${sel}）`)
    for (const m of sel.matchAll(/\[data-k="([\w-]+)"\]/g)) assert.ok(src.includes(`data-k="${m[1]}"`), `${s.id}：找不到 data-k=${m[1]}`)
  }
})

test('進度：progressOf', () => {
  assert.deepEqual(progressOf(0, 7), { n: 1, total: 7, first: true, last: false, pct: 1 / 7 })
  const p = progressOf(6, 7); assert.equal(p.n, 7); assert.equal(p.last, true); assert.equal(p.pct, 1)
  assert.equal(progressOf(99, 7).n, 7); assert.equal(progressOf(-3, 7).n, 1); assert.equal(progressOf(NaN, 7).n, 1)
})

// =============================================================================================
// 鍵盤
// =============================================================================================
test('keyToAction：→ / Enter 下一步、← 上一步；Enter 落在按鈕上交給原生；有修飾鍵不處理', () => {
  const k = (key, target = { tagName: 'DIV' }, mods = {}) => keyToAction({ key, target, ...mods })
  assert.equal(k('ArrowRight'), 'next'); assert.equal(k('ArrowLeft'), 'prev'); assert.equal(k('Enter'), 'next')
  assert.equal(k('Enter', { tagName: 'BUTTON' }), null, '焦點在「略過」按 Enter = 略過（原生），不能變成下一步')
  assert.equal(k('Enter', { tagName: 'A' }), null)
  assert.equal(k('ArrowRight', { tagName: 'BUTTON' }), 'next')
  assert.equal(k('ArrowRight', undefined, { metaKey: true }), null); assert.equal(k('ArrowLeft', undefined, { altKey: true }), null); assert.equal(k('Enter', undefined, { ctrlKey: true }), null)
  for (const key of ['Escape', 'Tab', ' ', 'a', 't', 'h', 'ArrowUp']) assert.equal(k(key), null, key)
  assert.equal(keyToAction(null), null); assert.equal(keyToAction({ key: 'Enter' }), 'next')
})

// =============================================================================================
// 幾何：基本
// =============================================================================================
test('矩形工具：rectFrom / intersectRects / overlapArea / padRect / isUsableRect', () => {
  const a = rectFrom({ left: 10, top: 20, width: 100, height: 50 })
  assert.deepEqual(a, { left: 10, top: 20, width: 100, height: 50, right: 110, bottom: 70 })
  assert.equal(intersectRects(a, rectFrom({ left: 200, top: 0, width: 10, height: 10 })), null)
  assert.equal(intersectRects(a, rectFrom({ left: 110, top: 20, width: 10, height: 10 })), null, '只有邊相貼不算重疊')
  assert.deepEqual(intersectRects(a, rectFrom({ left: 60, top: 40, width: 100, height: 100 })), rectFrom({ left: 60, top: 40, width: 50, height: 30 }))
  assert.equal(overlapArea(a, rectFrom({ left: 60, top: 40, width: 100, height: 100 })), 50 * 30)
  assert.equal(rectArea(null), 0)
  const p = padRect(rectFrom({ left: 2, top: 3, width: 100, height: 50 }), 6, { w: 105, h: 500 })
  assert.deepEqual([p.left, p.top, p.right, p.bottom], [0, 0, 105, 59], '外框不會畫到視窗外')
  assert.equal(isUsableRect(rectFrom({ left: 0, top: 0, width: 6, height: 6 })), true)
  assert.equal(isUsableRect(rectFrom({ left: 0, top: 0, width: 5, height: 50 })), false)
  assert.equal(isUsableRect(null), false)
})

test('scrollDelta1D：已在容器內 → 0；比容器大 → 對齊起點；其餘 → 置中', () => {
  assert.equal(scrollDelta1D(150, 250, 100, 500), 0)                      // 完整在裡面
  assert.equal(scrollDelta1D(600, 700, 100, 500), 650 - 300)              // 在下方 → 置中（目標中心 650、容器中心 300）
  assert.equal(scrollDelta1D(-200, -100, 100, 500), -150 - 300)           // 在上方 → 往回捲
  assert.equal(scrollDelta1D(600, 1100, 100, 500), 600 - 112)             // 比容器還高 → 對齊起點（含 12px 內距）
  assert.equal(scrollDelta1D(105, 200, 100, 500), 152.5 - 300)            // 貼著邊（內距不夠）→ 也會調整到置中
})

// =============================================================================================
// 幾何：可見矩形 / 捲動（假 DOM，檢查 this）
// =============================================================================================
function makeEnv(vw = 1000, vh = 700) {
  const win = { getComputedStyle(el) { if (this !== win) throw new TypeError('Illegal invocation'); return el.style || {} } }
  return { win, doc: { body: { name: 'body' }, documentElement: { name: 'html' } }, viewport: { w: vw, h: vh } }
}
function makeEl({ rect = { left: 0, top: 0, width: 100, height: 40 }, style = {}, parent = null, connected = true } = {}) {
  const el = {
    style, parentElement: parent, isConnected: connected,
    getBoundingClientRect() { if (this !== el) throw new TypeError('Illegal invocation'); const r = typeof rect === 'function' ? rect() : rect; return { ...r, right: r.left + r.width, bottom: r.top + r.height } },
  }
  return el
}
// 可捲動容器：內容高度 scrollHeight、可視高度 = rect.height；子元素的位置隨 scrollTop 移動
function makeScroller(env, { rect = { left: 600, top: 100, width: 300, height: 400 }, scrollHeight = 1400, scrollWidth = rect.width, style = { overflowY: 'auto', overflowX: 'hidden' } } = {}) {
  let top = 0, left = 0
  const c = makeEl({ rect, style, parent: env.doc.body })
  Object.assign(c, { scrollHeight, clientHeight: rect.height, scrollWidth, clientWidth: rect.width })
  Object.defineProperty(c, 'scrollTop', { get: () => top, set: (v) => { top = Math.max(0, Math.min(scrollHeight - rect.height, v)) } })
  Object.defineProperty(c, 'scrollLeft', { get: () => left, set: (v) => { left = Math.max(0, Math.min(scrollWidth - rect.width, v)) } })
  c.child = (contentTop, height = 60, contentLeft = 0, width = 200) => makeEl({ parent: c, rect: () => ({ left: rect.left + contentLeft - left, top: rect.top + contentTop - top, width, height }) })
  return c
}

test('visibleRectOf：沒被裁切 → 原矩形；被可捲動祖先裁切 → 扣掉；完全在外面 → null', () => {
  const env = makeEnv()
  const free = makeEl({ rect: { left: 50, top: 60, width: 200, height: 80 }, parent: env.doc.body })
  assert.deepEqual(visibleRectOf(free, env), rectFrom({ left: 50, top: 60, width: 200, height: 80 }))
  const panel = makeScroller(env)                 // 面板 y: 100~500
  const half = panel.child(360, 100)              // 目標 y: 460~560 → 只有 460~500 看得到
  assert.deepEqual(visibleRectOf(half, env), rectFrom({ left: 600, top: 460, width: 200, height: 40 }))
  const hidden = panel.child(900, 60)             // y: 1000~1060，在面板外
  assert.equal(visibleRectOf(hidden, env), null)
})

test('visibleRectOf：display:none / visibility:hidden / 大小為 0 / 已卸載 / 在視窗外 / null → null，不丟例外', () => {
  const env = makeEnv()
  const P = env.doc.body
  assert.equal(visibleRectOf(makeEl({ parent: P, style: { display: 'none' } }), env), null)
  assert.equal(visibleRectOf(makeEl({ parent: P, style: { visibility: 'hidden' } }), env), null)
  assert.equal(visibleRectOf(makeEl({ parent: P, rect: { left: 0, top: 0, width: 0, height: 0 } }), env), null)
  assert.equal(visibleRectOf(makeEl({ parent: P, connected: false }), env), null)
  assert.equal(visibleRectOf(makeEl({ parent: P, rect: { left: 2000, top: 10, width: 50, height: 50 } }), env), null, '完全在視窗右邊')
  assert.equal(visibleRectOf(null, env), null)
  assert.equal(visibleRectOf({ getBoundingClientRect() { throw new Error('boom') } }, env), null)
  const clipped = visibleRectOf(makeEl({ parent: P, rect: { left: 900, top: 650, width: 300, height: 200 } }), env)
  assert.deepEqual(clipped, rectFrom({ left: 900, top: 650, width: 100, height: 50 }), '扣掉視窗外的部分')
})

test('scrollTargetIntoView：把面板裡看不到的目標捲進面板；記下原位置；已在裡面就不動；不碰 overflow:hidden 的外層', () => {
  const env = makeEnv()
  const panel = makeScroller(env)
  const target = panel.child(900, 120)            // 內容 y=900，面板可視高度 400 → 一開始看不到
  assert.equal(visibleRectOf(target, env), null)
  const log = []
  assert.equal(scrollTargetIntoView(target, { ...env, log }), true)
  const r = visibleRectOf(target, env)
  assert.ok(r && r.height === 120, '捲進來之後完整看得到')
  assert.deepEqual(log.map((x) => [x.el === panel, x.top, x.left]), [[true, 0, 0]], '記下面板原本的捲動位置（結束時還原）')
  assert.equal(scrollTargetIntoView(target, { ...env, log }), false, '已經在視野內：不再動')
  assert.equal(log.length, 1)
  // 比面板還高的目標 → 對齊面板上緣（不是置中裁掉兩頭）
  const tall = panel.child(1000, 500)
  scrollTargetIntoView(tall, { ...env, log })
  assert.equal(tall.getBoundingClientRect().top, 100 + 12)
  // 外層是 overflow:hidden（例如 body / .app）→ 不捲它們（scrollIntoView 會，版面會被推歪）
  const hiddenBox = makeScroller(env, { style: { overflowY: 'hidden', overflowX: 'hidden' } })
  const inHidden = hiddenBox.child(900, 60)
  assert.equal(scrollTargetIntoView(inHidden, { ...env, log: [] }), false)
  assert.equal(hiddenBox.scrollTop, 0)
  assert.equal(scrollTargetIntoView(null, { ...env }), false)
})

test('scrollTargetIntoView：橫向捲動的工具列（手機）也能把目標捲進來', () => {
  const env = makeEnv(375, 812)
  const strip = makeScroller(env, { rect: { left: 0, top: 60, width: 375, height: 44 }, scrollHeight: 44, scrollWidth: 1200, style: { overflowX: 'auto', overflowY: 'hidden' } })
  const btn = strip.child(0, 40, 900, 60)         // 內容 x=900 → 在畫面右外側
  assert.equal(visibleRectOf(btn, env), null)
  assert.equal(scrollTargetIntoView(btn, { ...env, log: [] }), true)
  const r = visibleRectOf(btn, env)
  assert.ok(r && r.width === 60 && r.left >= 0 && r.right <= 375)
})

// =============================================================================================
// 目標解析
// =============================================================================================
test('resolveTarget：依序嘗試 targets；第一個存在且看得到的勝出；缺失 → 落到下一個；全部落空 → null（置中卡片）', () => {
  const vp = { w: 1000, h: 700 }
  const good = rectFrom({ left: 10, top: 10, width: 200, height: 80 })
  const els = { '.a': { id: 'a' }, '.b': { id: 'b' }, '.c': { id: 'c' } }
  const rects = new Map([[els['.a'], null], [els['.b'], good], [els['.c'], good]])
  const calls = []
  const ctx = { viewport: vp, query: (s) => els[s] || null, getRect: (el) => rects.get(el) || null, prepare: (el) => calls.push(el.id) }
  const hit = resolveTarget({ targets: ['.missing', '.a', '.b', '.c'] }, ctx)
  assert.equal(hit.selector, '.b'); assert.equal(hit.el, els['.b']); assert.deepEqual(hit.rect, good)
  assert.deepEqual(calls, ['a', 'b'], '對存在的候選才做捲進視野（.missing 不存在；.b 勝出後不再往下）')
  assert.equal(resolveTarget({ targets: ['.missing', '.nope'] }, ctx), null)
  assert.equal(resolveTarget({ targets: [] }, ctx), null)
  assert.equal(resolveTarget({}, ctx), null)
  assert.equal(resolveTarget(null, ctx), null)
})

test('resolveTarget：query / prepare / getRect 丟例外、矩形太小 → 都當作沒有，不報錯、不卡住', () => {
  const vp = { w: 1000, h: 700 }
  const el = { id: 'x' }
  const ok = rectFrom({ left: 0, top: 0, width: 50, height: 50 })
  assert.equal(resolveTarget({ targets: ['bad['] }, { viewport: vp, query: () => { throw new SyntaxError('bad selector') }, getRect: () => ok }), null)
  assert.equal(resolveTarget({ targets: ['.x'] }, { viewport: vp, query: () => el, getRect: () => { throw new Error('boom') } }), null)
  assert.equal(resolveTarget({ targets: ['.x'] }, { viewport: vp, query: () => el, getRect: () => rectFrom({ left: 0, top: 0, width: 3, height: 3 }) }), null)
  const hit = resolveTarget({ targets: ['.x'] }, { viewport: vp, query: () => el, prepare: () => { throw new Error('scroll failed') }, getRect: () => ok })
  assert.equal(hit && hit.el, el, '捲動失敗不影響定位')
})

test('resolveTarget（假 DOM 串起來）：目標在面板裡看不到 → 先捲進視野再量；目標被隱藏（演出模式）→ null', () => {
  const env = makeEnv()
  const panel = makeScroller(env)
  const group = panel.child(800, 150)
  const stage = { '.panel .group': group }
  const ctx = {
    viewport: env.viewport, query: (s) => stage[s] || null,
    prepare: (el) => scrollTargetIntoView(el, { ...env, log: [] }),
    getRect: (el) => visibleRectOf(el, env),
  }
  const hit = resolveTarget({ targets: ['.panel .group'] }, ctx)
  assert.ok(hit && hit.rect.height === 150)
  group.style = { display: 'none' }
  assert.equal(resolveTarget({ targets: ['.panel .group'] }, ctx), null)
})

// =============================================================================================
// 卡片定位
// =============================================================================================
const inside = (c, vp, m) => c.left >= m - 1 && c.top >= m - 1 && c.left + c.width <= vp.w - m + 1 && c.top + c.height <= vp.h - m + 1
const cardRect = (c) => rectFrom({ left: c.left, top: c.top, width: c.width, height: c.height })
const DESKTOPS = [[1440, 900], [1280, 720], [1024, 768], [1920, 1080], [900, 700]]
const PHONES = [[375, 812], [320, 568], [390, 844], [412, 915], [520, 900]]

test('cardWidthFor / isCompact：寬 ≤ 520 是手機；桌面卡片最寬 320、手機撐滿（左右各 8px）', () => {
  assert.equal(COMPACT_MAX, 520); assert.equal(isCompact(520), true); assert.equal(isCompact(521), false)
  assert.equal(cardWidthFor(1440), 320); assert.equal(cardWidthFor(340, false), 316); assert.equal(cardWidthFor(360, false), 320); assert.equal(cardWidthFor(375), 359); assert.equal(cardWidthFor(320), 304)
})

test('placeCard：沒有目標 → 置中（桌面與手機都是）', () => {
  for (const [w, h] of [...DESKTOPS, ...PHONES]) {
    const c = placeCard({ spot: null, card: { h: 200 }, viewport: { w, h } })
    assert.equal(c.mode, 'center')
    assert.ok(Math.abs(c.left + c.width / 2 - w / 2) <= 1 && Math.abs(c.top + c.height / 2 - h / 2) <= 1, `${w}x${h}`)
    assert.ok(inside(c, { w, h }, 8))
  }
})

test('placeCard（桌面）：小目標 → 貼著目標旁邊，不超出視窗、一定不遮住目標', () => {
  for (const [w, h] of DESKTOPS) {
    const vp = { w, h }
    const spots = {
      toolbar: { left: w * 0.35, top: 0, width: w * 0.65, height: 50 },
      panelSlice: { left: w - 340, top: h * 0.4, width: 330, height: 180 },
      select: { left: w - 330, top: 160, width: 310, height: 34 },
      help: { left: w - 210, top: 8, width: 44, height: 34 },
      cornerBL: { left: 10, top: h - 60, width: 100, height: 40 },
      cornerBR: { left: w - 110, top: h - 60, width: 100, height: 40 },
      center: { left: w / 2 - 50, top: h / 2 - 20, width: 100, height: 40 },
    }
    for (const [name, r] of Object.entries(spots)) {
      const spot = rectFrom(r)
      const c = placeCard({ spot, card: { h: 210 }, viewport: vp })
      assert.equal(c.mode, 'anchor', `${w}x${h} ${name}`)
      assert.equal(c.width, 320)
      assert.ok(inside(c, vp, 12), `${w}x${h} ${name} 超出視窗：${JSON.stringify(c)}`)
      assert.equal(overlapArea(cardRect(c), spot), 0, `${w}x${h} ${name} 遮住了目標：${JSON.stringify(c)}`)
    }
  }
})

test('placeCard（桌面）：寬扁的目標（工具列）卡片放下方；面板裡的目標放左邊（蓋在畫布上，不擋面板）', () => {
  const vp = { w: 1440, h: 900 }
  const bar = placeCard({ spot: rectFrom({ left: 500, top: 0, width: 940, height: 50 }), card: { h: 180 }, viewport: vp })
  assert.equal(bar.side, 'bottom'); assert.ok(bar.top >= 50)
  const panel = placeCard({ spot: rectFrom({ left: 1100, top: 350, width: 330, height: 180 }), card: { h: 180 }, viewport: vp })
  assert.equal(panel.side, 'left'); assert.ok(panel.left + panel.width <= 1100)
})

test('placeCard（桌面）：目標超大（整個畫布）→ 盡量靠邊、只蓋到一點點（不超出視窗）', () => {
  for (const [w, h] of DESKTOPS) {
    const vp = { w, h }
    const spot = rectFrom({ left: 0, top: 50, width: w - 348, height: h - 160 })   // 畫布：左邊全部，右邊留給 340px 的面板
    const c = placeCard({ spot, card: { h: 200 }, viewport: vp })
    assert.ok(inside(c, vp, 12), `${w}x${h}`)
    assert.ok(overlapArea(cardRect(c), spot) <= 0.05 * rectArea(cardRect(c)), `${w}x${h} 蓋到目標 ${overlapArea(cardRect(c), spot)}px²`)
  }
  // 目標就是整個視窗（演出模式的畫布）→ 無處可躲：退到視窗內下緣置中，仍不超出
  const vp = { w: 1280, h: 720 }
  const c = placeCard({ spot: rectFrom({ left: 0, top: 0, width: 1280, height: 720 }), card: { h: 200 }, viewport: vp })
  assert.ok(inside(c, vp, 12)); assert.equal(c.side, 'inside-bottom')
})

test('placeCard（手機 ≤ 520）：貼底的 bottom sheet（左右各 8px、撐滿寬度）', () => {
  for (const [w, h] of PHONES) {
    const vp = { w, h }
    const small = rectFrom({ left: 10, top: 10, width: 80, height: 40 })        // 頂欄的按鈕
    const canvas = rectFrom({ left: 0, top: 110, width: w, height: h * 0.4 })   // 畫布（在上半）
    for (const spot of [small, canvas]) {
      const c = placeCard({ spot, card: { h: 190 }, viewport: vp })
      assert.equal(c.mode, 'sheet'); assert.equal(c.side, 'bottom')
      assert.equal(c.left, 8); assert.equal(c.width, w - 16)
      assert.equal(c.top + c.height, h - 8, '貼齊底部（留 8px）')
      assert.equal(overlapArea(cardRect(c), spot), 0)
    }
  }
})

test('placeCard（手機）：貼底會蓋住目標（例如面板裡的滑桿在畫面下半）→ 改貼頂；兩邊都蓋住 → 維持貼底', () => {
  const vp = { w: 375, h: 812 }
  const lower = rectFrom({ left: 0, top: 480, width: 375, height: 230 })         // 面板：y 480~710，貼底卡片（y 614~804）會蓋掉一半以上
  const c = placeCard({ spot: lower, card: { h: 190 }, viewport: vp })
  assert.equal(c.mode, 'sheet'); assert.equal(c.side, 'top'); assert.equal(c.top, 8)
  assert.equal(overlapArea(cardRect(c), lower), 0)
  const whole = placeCard({ spot: rectFrom({ left: 0, top: 0, width: 375, height: 812 }), card: { h: 190 }, viewport: vp })
  assert.equal(whole.side, 'bottom')
  // 只蓋到一點點（< 15%）→ 不翻，維持貼底（卡片位置固定比較穩）
  const nearly = placeCard({ spot: rectFrom({ left: 0, top: 110, width: 375, height: 520 }), card: { h: 190 }, viewport: vp })
  assert.equal(nearly.side, 'bottom')
})

test('placeCard：卡片比視窗還高 → 高度夾在視窗內；沒量到高度（0 / undefined）也不出錯', () => {
  const vp = { w: 320, h: 300 }
  const c = placeCard({ spot: rectFrom({ left: 10, top: 10, width: 50, height: 30 }), card: { h: 900 }, viewport: vp })
  assert.equal(c.height, 300 - 16); assert.ok(inside(c, vp, 8))
  for (const card of [{}, { h: 0 }, undefined, { h: NaN }]) {
    const d = placeCard({ spot: rectFrom({ left: 100, top: 100, width: 50, height: 30 }), card, viewport: { w: 1000, h: 700 } })
    assert.ok(Number.isFinite(d.left) && Number.isFinite(d.top) && d.height === 0)
  }
})

test('placeCard 隨機測試：永遠有限數字、不超出視窗；大視窗 + 小目標一定不遮住', () => {
  let seed = 20260920
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
  const between = (a, b) => a + rnd() * (b - a)
  for (let i = 0; i < 3000; i++) {
    const w = Math.round(between(320, 2000)), h = Math.round(between(400, 1200))
    const vp = { w, h }
    const sw = between(20, Math.min(w, 700)), sh = between(20, Math.min(h, 500))
    const spot = rectFrom({ left: between(0, w - sw), top: between(0, h - sh), width: sw, height: sh })
    const card = { h: Math.round(between(120, 260)) }
    const c = placeCard({ spot, card, viewport: vp })
    for (const k of ['left', 'top', 'width', 'height']) assert.ok(Number.isFinite(c[k]), `${JSON.stringify({ vp, spot })} ${k}`)
    const m = isCompact(w) ? 8 : 12
    assert.ok(inside(c, vp, m), `超出視窗 ${JSON.stringify({ vp, spot, c })}`)
    if (!isCompact(w) && w >= 1100 && sw <= 300) assert.equal(overlapArea(cardRect(c), spot), 0, `遮住了小目標 ${JSON.stringify({ vp, spot, c })}`)
  }
})

// =============================================================================================
// 導航狀態機
// =============================================================================================
function mk({ local = fakeStorage(), session = fakeStorage(), env = { search: '', hash: '' } } = {}) {
  const ob = createOnboarding({ getLocal: () => local, getSession: () => session, getEnv: () => env })
  return { ob, local, session }
}

test('導覽：開始 → 下一步逐步前進 → 最後一步的「下一步」＝完成（關閉並寫入兩個鍵）', () => {
  const { ob, local } = mk()
  assert.deepEqual(ob.getState(), { open: false, index: 0, source: null })
  assert.equal(ob.next(), false, '沒開著時所有操作都是 no-op'); assert.equal(ob.prev(), false); assert.equal(ob.skip(), false)
  assert.equal(ob.open('replay'), true)
  assert.deepEqual(ob.getState(), { open: true, index: 0, source: 'replay' })
  for (let i = 1; i < STEPS.length; i++) { assert.equal(ob.next(), true); assert.equal(ob.getState().index, i) }
  assert.deepEqual(local.writes, [])
  assert.equal(ob.next(), true, '最後一步再按下一步 = 完成')
  assert.deepEqual(ob.getState(), { open: false, index: 0, source: null })
  assert.equal(local.data.get(SEEN), '1'); assert.equal(local.data.get(ONB), '1')
})

test('導覽：上一步（第一步再按 = no-op）、goto（夾在範圍內）、重複開啟不會把進度洗回第一步', () => {
  const { ob } = mk()
  ob.open('auto')
  assert.equal(ob.prev(), false); assert.equal(ob.getState().index, 0)
  ob.next(); ob.next()
  assert.equal(ob.prev(), true); assert.equal(ob.getState().index, 1)
  assert.equal(ob.open('auto'), false, 'StrictMode 雙掛載 / 重複點擊：已經開著就不動')
  assert.equal(ob.getState().index, 1)
  assert.equal(ob.goto(99), true); assert.equal(ob.getState().index, STEPS.length - 1)
  assert.equal(ob.goto(99), false); assert.equal(ob.goto(-5), true); assert.equal(ob.getState().index, 0)
})

test('導覽：略過（任何一步）→ 關閉並寫入兩個鍵；完成也一樣；close() 不寫偏好', () => {
  for (const at of [0, 3, STEPS.length - 1]) {
    const { ob, local, session } = mk()
    ob.open('auto'); ob.goto(at)
    assert.equal(ob.skip(), true)
    assert.equal(ob.getState().open, false)
    assert.deepEqual([...local.data.keys()].sort(), [ONB, SEEN].sort(), `第 ${at + 1} 步略過`)
    assert.equal(session.data.get(ONB), '1')
  }
  const { ob, local } = mk()
  ob.open('replay'); ob.goto(2)
  assert.equal(ob.finish(), true); assert.equal(local.data.size, 2)
  const b = mk(); b.ob.open(); assert.equal(b.ob.close(), true); assert.equal(b.local.data.size, 0, 'close() 不寫偏好')
  assert.equal(b.ob.close(), false)
})

test('導覽：寫入失敗（隱私模式）也照樣關閉、不丟例外', () => {
  const { ob } = mk({ local: fakeStorage({ throwSet: true }), session: fakeStorage({ throwSet: true }) })
  ob.open('auto')
  assert.doesNotThrow(() => ob.skip())
  assert.equal(ob.getState().open, false)
})

test('導覽：subscribe / 取消訂閱；狀態沒變就不通知、getState 回傳同一個物件（useSyncExternalStore 的快照要穩定）', () => {
  const { ob } = mk()
  let n = 0
  const off = ob.subscribe(() => { n++ })
  const s0 = ob.getState()
  ob.next(); ob.prev(); ob.skip()                          // 沒開著：都不通知
  assert.equal(n, 0); assert.equal(ob.getState(), s0)
  ob.open(); assert.equal(n, 1)
  const s1 = ob.getState()
  ob.open(); ob.prev(); ob.goto(0)                         // 沒有改變
  assert.equal(n, 1); assert.equal(ob.getState(), s1)
  ob.next(); assert.equal(n, 2)
  off(); ob.next(); assert.equal(n, 2, '取消訂閱後不再通知')
  // 訂閱者丟例外不影響其他訂閱者
  const { ob: ob2 } = mk(); let got = 0
  ob2.subscribe(() => { throw new Error('bad subscriber') }); ob2.subscribe(() => { got++ })
  assert.doesNotThrow(() => ob2.open()); assert.equal(got, 1)
})

test('自動開始：首次進站 → 開啟（source auto）；每次載入只判斷一次（StrictMode 第二次 effect 不會重設進度）', () => {
  const { ob } = mk()
  assert.equal(ob.autoStart(), true)
  assert.deepEqual(ob.getState(), { open: true, index: 0, source: 'auto' })
  ob.next()
  assert.equal(ob.autoStart(), false, '第二次呼叫（StrictMode）什麼都不做')
  assert.deepEqual(ob.getState(), { open: true, index: 1, source: 'auto' }, '進度維持、仍開著')
  ob.skip()
  assert.equal(ob.autoStart(), false, '完成後不會又自己彈出來')
  assert.equal(ob.getState().open, false)
})

test('自動開始：舊使用者（有 seen）/ kiosk / audience / diagnostics / remote / ?onboard=0 都不會被打擾；?onboard=1 強制', () => {
  const seen = () => fakeStorage({ init: { [SEEN]: '1' } })
  const open = (over) => mk(over).ob.autoStart()
  assert.equal(open({ local: seen() }), false)
  assert.equal(open({ env: { search: '?kiosk=1', hash: '' } }), false)
  assert.equal(open({ env: { search: '?audience=1', hash: '' } }), false)
  assert.equal(open({ env: { search: '?diagnostics=1', hash: '' } }), false)
  assert.equal(open({ env: { search: '', hash: '#remote=abc' } }), false)
  assert.equal(open({ env: { search: '?onboard=0', hash: '' } }), false)
  assert.equal(open({ local: seen(), env: { search: '?onboard=1', hash: '' } }), true)
  assert.equal(open({ local: fakeStorage({ throwGet: true }) }), true, 'storage 讀不到：視為首次')
  // 取得環境本身丟例外 → 不顯示、不丟例外
  const bad = createOnboarding({ getLocal: () => fakeStorage(), getSession: () => fakeStorage(), getEnv: () => { throw new Error('no location') } })
  assert.equal(bad.autoStart(), false)
})

test('重新看導覽：已看過的人也能從說明視窗重看（open("replay")），看完再寫一次不會出錯', () => {
  const { ob, local } = mk({ local: fakeStorage({ init: { [SEEN]: '1', [ONB]: '1' } }) })
  assert.equal(ob.open('replay'), true)
  assert.equal(ob.getState().source, 'replay')
  ob.goto(STEPS.length - 1); ob.next()
  assert.equal(ob.getState().open, false)
  assert.equal(local.data.get(SEEN), '1')
})

test('所有方法都不依賴 this（可以直接當 onClick 傳）', () => {
  const { ob } = mk()
  const { open, next, prev, skip, subscribe, getState } = ob
  open('replay'); next(); prev(); assert.equal(getState().index, 0)
  const off = subscribe(() => {}); off(); skip()
  assert.equal(getState().open, false)
})

// =============================================================================================
// UI 接線（原始碼層級）：TourService 靠 .modal-backdrop 判斷有沒有彈窗；焦點 / a11y / 動態
// =============================================================================================
test('根元素帶 modal-backdrop onboard-backdrop（閒置導覽在引導進行中不會自動啟動）；CSS 覆寫成不影響版面、不模糊', () => {
  const jsx = read('../ui/Onboarding.jsx'), css = read('../styles/onboarding.css'), core = read('../services/tourCore.js')
  assert.ok(/className=\{'modal-backdrop onboard-backdrop'/.test(jsx))
  assert.ok(core.includes("document.querySelector('.modal-backdrop')"), 'tourCore 仍用 .modal-backdrop 判斷有沒有彈窗')
  const rule = css.match(/\.modal-backdrop\.onboard-backdrop\s*\{([^}]*)\}/)
  assert.ok(rule, 'CSS 要用兩個 class 疊起來覆寫 .modal-backdrop')
  for (const decl of ['display: block', 'padding: 0', 'backdrop-filter: none', 'background: transparent']) assert.ok(rule[1].includes(decl), decl)
  assert.ok(/role="dialog"/.test(jsx) && /aria-modal="true"/.test(jsx) && /aria-label=\{t\('新手導覽'\)\}/.test(jsx), '卡片是 role=dialog aria-modal + aria-label')
  assert.ok(/attachModalFocus\(/.test(jsx), '焦點進入卡片、Esc、Tab 圈選、結束後還原')
  assert.ok(/prefers-reduced-motion: reduce/.test(css), 'prefers-reduced-motion 不做動畫')
})

test('說明視窗：有「重新看新手導覽」按鈕（先關視窗再開導覽）；role=dialog；Footer / TopBar 沒被改', () => {
  const modal = read('../ui/InfoModal.jsx')
  assert.ok(modal.includes("t('重新看新手導覽')") && /onboarding\.open\('replay'\)/.test(modal))
  assert.ok(/onClose\(\)\s*;\s*onboarding\.open\('replay'\)/.test(modal), '先 onClose 再開導覽')
  assert.ok(/role="dialog"/.test(modal) && /aria-modal="true"/.test(modal))
  assert.ok(!/onboard/.test(read('../ui/TopBar.jsx')) && !/onboard/.test(read('../ui/Footer.jsx')))
})

// =============================================================================================
// 說明視窗正文：InfoZh / InfoEn 條目與順序一一對應、英文不含中文
// =============================================================================================
test('InfoZh / InfoEn：id 與順序一一對應；快速上手 ≤ 5 條；每條玩法恰好在一個摺疊區塊；英文不含任何中文字元', () => {
  const zh = read('../ui/info/InfoZh.jsx'), en = read('../ui/info/InfoEn.jsx')
  const idsOf = (s) => [...s.matchAll(/\bid: '([\w-]+)'/g)].map((m) => m[1])
  const groupsOf = (s) => [...s.matchAll(/ids: \[([^\]]*)\]/g)].map((m) => [...m[1].matchAll(/'([\w-]+)'/g)].map((x) => x[1]))
  assert.deepEqual(idsOf(zh), idsOf(en), 'id 與順序必須一致')
  assert.deepEqual(groupsOf(zh), groupsOf(en), '分組必須一致')
  const play = [...zh.match(/const PLAY = \[\n([\s\S]*?)\n\]\n/)[1].matchAll(/\{ id: '([\w-]+)'/g)].map((m) => m[1])
  assert.equal(play.length, 19, '既有 19 條玩法一條都不能少')
  assert.deepEqual(groupsOf(zh).flat().sort(), [...play].sort(), '每條玩法恰好出現在一個區塊')
  assert.ok(idsOf(zh).filter((x) => x.startsWith('quick-')).length <= 5 && idsOf(zh).some((x) => x.startsWith('quick-')), '快速上手 1~5 條')
  assert.equal((zh.match(/<details/g) || []).length, (en.match(/<details/g) || []).length)
  assert.equal((zh.match(/<details/g) || []).length, 2, '.map 產生一組 + 生態一個（原始碼各一處）')
  assert.ok(!HAN.test(en), 'InfoEn 不能有任何中文字元（含註解）')
  // 每個條目的行內標記（<b> / <code>）數量中英一致
  const entries = (s) => Object.fromEntries([...s.matchAll(/\{ id: '([\w-]+)', body: <>([\s\S]*?)<\/> \}/g)].map((m) => [m[1], [(m[2].match(/<b>/g) || []).length, (m[2].match(/<code>/g) || []).length]]))
  assert.deepEqual(entries(zh), entries(en), '行內標記數量需一致')
  assert.equal(Object.keys(entries(zh)).length, 19 + 5)   // 玩法 19 + 快速上手 5（生態區塊的 id 是 eco，沒有 body 欄位）
})
