// 版面偏好（輸入輸出監看顯示 / 隱藏）單元測試。執行：node --test src/lib/layoutPrefs.test.mjs
// 涵蓋：預設依寬度、偏好持久化與壞值容錯、?log 覆寫優先序、localStorage 不可用時退回預設、視窗跨斷點自動跟隨、Footer 最新 OUT 事件挑選、節流。
// 瀏覽器專屬陷阱：localStorage.getItem / matchMedia 是原生方法，拆開呼叫會丟 Illegal invocation → 假物件要檢查 this。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LS } from './persist.js'
import {
  NARROW_MAX, MONITOR_ID, MONITOR_TOGGLE_ID,
  defaultMonitorShown, normalizePref, readMonitorPref, writeMonitorPref, parseLogParam, resolveMonitorShown,
  pickLatestOut, isDataLine, throttleDelay, watchNarrowViewport, createLayoutPrefs,
} from './layoutPrefs.js'

// 會檢查 this 的假 localStorage（原生 Storage 方法脫離物件呼叫會丟 TypeError: Illegal invocation）
function fakeStorage(initial = {}, { failGet = false, failSet = false } = {}) {
  const data = new Map(Object.entries(initial))
  const s = {
    data,
    getItem(k) { if (this !== s) throw new TypeError('Illegal invocation'); if (failGet) throw new Error('SecurityError'); return data.has(k) ? data.get(k) : null },
    setItem(k, v) { if (this !== s) throw new TypeError('Illegal invocation'); if (failSet) throw new Error('QuotaExceededError'); data.set(k, String(v)) },
  }
  return s
}

// 會檢查 this 的假 window：matchMedia / addEventListener 都是方法呼叫
function fakeWindow({ width = 1200, mm = true, modern = true } = {}) {
  const w = {
    innerWidth: width,
    resizeListeners: new Set(),
    mqls: [],
    addEventListener(ev, f) { if (this !== w) throw new TypeError('Illegal invocation'); if (ev === 'resize') w.resizeListeners.add(f) },
    removeEventListener(ev, f) { if (this !== w) throw new TypeError('Illegal invocation'); if (ev === 'resize') w.resizeListeners.delete(f) },
    setWidth(px) {
      w.innerWidth = px
      for (const f of [...w.resizeListeners]) f()
      for (const m of w.mqls) m.fire()
    },
  }
  if (mm) {
    w.matchMedia = function (q) {
      if (this !== w) throw new TypeError('Illegal invocation')
      const max = Number(/max-width:\s*(\d+)px/.exec(q)[1])
      const ls = new Set()
      const m = {
        get matches() { return w.innerWidth <= max },
        fire() { for (const f of [...ls]) f() },
        ls,
      }
      if (modern) {
        m.addEventListener = function (ev, f) { if (this !== m) throw new TypeError('Illegal invocation'); if (ev === 'change') ls.add(f) }
        m.removeEventListener = function (ev, f) { if (this !== m) throw new TypeError('Illegal invocation'); if (ev === 'change') ls.delete(f) }
      } else {
        m.addListener = function (f) { if (this !== m) throw new TypeError('Illegal invocation'); ls.add(f) }
        m.removeListener = function (f) { if (this !== m) throw new TypeError('Illegal invocation'); ls.delete(f) }
      }
      w.mqls.push(m)
      return m
    }
  }
  return w
}

test('常數：斷點 820、DOM id、LS 鍵（不與既有鍵衝突）', () => {
  assert.equal(NARROW_MAX, 820)
  assert.equal(LS.monitor, 'ixd2026.monitor')
  assert.equal(new Set(Object.values(LS)).size, Object.values(LS).length)   // LS 鍵表沒有重複值
  assert.ok(MONITOR_ID && MONITOR_TOGGLE_ID && MONITOR_ID !== MONITOR_TOGGLE_ID)
})

test('預設依寬度：> 820 顯示、≤ 820 隱藏；量不到寬度 → 桌面預設（顯示）', () => {
  assert.equal(defaultMonitorShown(1440), true)
  assert.equal(defaultMonitorShown(821), true)
  assert.equal(defaultMonitorShown(820), false)     // 邊界：820 算手機（與 CSS max-width: 820px 一致）
  assert.equal(defaultMonitorShown(390), false)
  for (const bad of [undefined, null, NaN, 0, -5, 'abc', Infinity]) assert.equal(defaultMonitorShown(bad), true, String(bad))
  assert.equal(defaultMonitorShown('600'), false)   // 字串數字也認得
})

test('normalizePref：只接受 show / hide（含 JSON 字串），壞值 → null', () => {
  for (const [raw, want] of [['show', 'show'], ['hide', 'hide'], ['"show"', 'show'], ['"hide"', 'hide'], [' "hide" ', 'hide']]) assert.equal(normalizePref(raw), want, raw)
  for (const bad of [null, undefined, '', 'SHOW', 'true', 'false', '1', '0', 'yes', '{"a":1}', '[]', 'null', '"maybe"', 1, true, {}, []]) assert.equal(normalizePref(bad), null, JSON.stringify(bad))
})

test('偏好讀寫：以方法呼叫 storage、存 JSON 字串、往返一致；壞值 / 例外 / 沒有 storage 都不丟例外', () => {
  const s = fakeStorage()
  assert.equal(readMonitorPref(s), null)                       // 沒存過
  assert.equal(writeMonitorPref(s, 'hide'), true)
  assert.equal(s.data.get(LS.monitor), '"hide"')
  assert.equal(readMonitorPref(s), 'hide')
  assert.equal(writeMonitorPref(s, 'show'), true)
  assert.equal(readMonitorPref(s), 'show')
  assert.equal(writeMonitorPref(s, 'maybe'), false)            // 不寫壞值
  assert.equal(readMonitorPref(s), 'show')
  // 壞值容錯
  for (const raw of ['', 'garbage', '{"x":1}', '123', 'null', '"SHOW"']) assert.equal(readMonitorPref(fakeStorage({ [LS.monitor]: raw })), null, raw)
  assert.equal(readMonitorPref(fakeStorage({ [LS.monitor]: 'show' })), 'show')   // 裸字串也認
  // storage 不可用
  assert.equal(readMonitorPref(null), null)
  assert.equal(readMonitorPref(undefined), null)
  assert.equal(writeMonitorPref(null, 'show'), false)
  assert.equal(readMonitorPref(fakeStorage({}, { failGet: true })), null)
  assert.equal(writeMonitorPref(fakeStorage({}, { failSet: true }), 'show'), false)
})

test('?log 解析：1 / 0 與常見寫法；沒有 / 看不懂 → null（不覆寫）', () => {
  for (const s of ['?log=1', '?log=true', '?log=ON', '?log=yes', '?log=show', '?log', '?log=', '?x=1&log=1', 'log=1']) assert.equal(parseLogParam(s), true, s)
  for (const s of ['?log=0', '?log=false', '?log=OFF', '?log=No', '?log=hide', '?a=b&log=0']) assert.equal(parseLogParam(s), false, s)
  for (const s of ['', '?', '?kiosk=1', '?logs=1', '?log=maybe', '?log=2', undefined, null]) assert.equal(parseLogParam(s), null, String(s))
})

test('起始顯示的優先序：網址 ?log > 使用者偏好 > 依寬度預設', () => {
  // 只有預設
  assert.deepEqual(resolveMonitorShown({ width: 1280, saved: null, search: '' }), { shown: true, source: 'default' })
  assert.deepEqual(resolveMonitorShown({ width: 390, saved: null, search: '' }), { shown: false, source: 'default' })
  // 偏好蓋過預設（雙向）
  assert.deepEqual(resolveMonitorShown({ width: 1280, saved: 'hide', search: '' }), { shown: false, source: 'saved' })
  assert.deepEqual(resolveMonitorShown({ width: 390, saved: 'show', search: '' }), { shown: true, source: 'saved' })
  // 網址蓋過偏好與預設（雙向）
  assert.deepEqual(resolveMonitorShown({ width: 1280, saved: 'show', search: '?log=0' }), { shown: false, source: 'url' })
  assert.deepEqual(resolveMonitorShown({ width: 390, saved: 'hide', search: '?log=1' }), { shown: true, source: 'url' })
  assert.deepEqual(resolveMonitorShown({ width: 390, saved: null, search: '?log=1' }), { shown: true, source: 'url' })
  // 看不懂的網址值 → 忽略，退回偏好 / 預設
  assert.deepEqual(resolveMonitorShown({ width: 390, saved: 'show', search: '?log=zzz' }), { shown: true, source: 'saved' })
  // 壞偏好 → 退回預設
  assert.deepEqual(resolveMonitorShown({ width: 390, saved: 'wat', search: '' }), { shown: false, source: 'default' })
  // 全部缺 → 桌面預設
  assert.deepEqual(resolveMonitorShown(), { shown: true, source: 'default' })
})

test('store：預設依寬度；使用者切換 → 寫偏好（JSON 字串）；重新載入沿用', () => {
  const s = fakeStorage()
  const a = createLayoutPrefs({ width: 390, search: '', getStorage: () => s })
  assert.equal(a.getState().monitorShown, false)
  assert.equal(a.getState().monitorSource, 'default')
  assert.equal(s.data.has(LS.monitor), false)                  // 只是預設，不寫偏好
  a.getState().toggleMonitor()
  assert.equal(a.getState().monitorShown, true)
  assert.equal(a.getState().monitorSource, 'saved')
  assert.equal(s.data.get(LS.monitor), '"show"')
  a.getState().setMonitorShown(false)
  assert.equal(s.data.get(LS.monitor), '"hide"')
  // 「重新載入」：同一份 storage、桌面寬度 → 偏好（hide）蓋過寬度預設
  const b = createLayoutPrefs({ width: 1600, search: '', getStorage: () => s })
  assert.equal(b.getState().monitorShown, false)
  assert.equal(b.getState().monitorSource, 'saved')
})

test('store：?log=1 / ?log=0 覆寫這一次，不寫偏好；使用者之後切換才寫', () => {
  const s = fakeStorage({ [LS.monitor]: '"hide"' })
  const on = createLayoutPrefs({ width: 390, search: '?log=1', getStorage: () => s })
  assert.equal(on.getState().monitorShown, true)
  assert.equal(on.getState().monitorSource, 'url')
  assert.equal(s.data.get(LS.monitor), '"hide"')               // 覆寫沒有動到既有偏好
  const off = createLayoutPrefs({ width: 1600, search: '?log=0', getStorage: () => s })
  assert.equal(off.getState().monitorShown, false)
  assert.equal(s.data.get(LS.monitor), '"hide"')
  // 網址覆寫期間視窗變化不跟隨
  on.getState().setNarrow(true)
  assert.equal(on.getState().monitorShown, true)
  // 使用者在覆寫的頁面上切換 → 才寫偏好（比照 ?hud=0 之後的切換）
  on.getState().toggleMonitor()
  assert.equal(on.getState().monitorShown, false)
  assert.equal(s.data.get(LS.monitor), '"hide"')
  on.getState().toggleMonitor()
  assert.equal(s.data.get(LS.monitor), '"show"')
})

test('store：localStorage 不可用（沒有 / 存取丟例外 / 讀寫丟例外）→ 退回預設，切換只在本次有效，不崩潰', () => {
  const envs = [
    { getStorage: () => null },
    { getStorage: () => { throw new Error('SecurityError') } },
    { getStorage: () => fakeStorage({}, { failGet: true, failSet: true }) },
    {},                                                          // 連 getStorage 都沒有
  ]
  for (const e of envs) {
    const desktop = createLayoutPrefs({ width: 1440, search: '', ...e })
    const phone = createLayoutPrefs({ width: 375, search: '', ...e })
    assert.equal(desktop.getState().monitorShown, true)
    assert.equal(phone.getState().monitorShown, false)
    assert.equal(phone.getState().monitorSource, 'default')
    phone.getState().toggleMonitor()
    assert.equal(phone.getState().monitorShown, true)            // 切換仍然有效（只是沒記住）
    phone.getState().setNarrow(false)
    assert.equal(phone.getState().monitorShown, true)            // 使用者選過 → 不再自動跟隨
  }
  // 沒有 window（Node / SSR）：量不到寬度 → 桌面預設
  assert.equal(createLayoutPrefs({}).getState().monitorShown, true)
})

test('store：沒偏好也沒網址覆寫時，視窗跨過 820px 自動跟隨；使用者選過就不再跟隨', () => {
  const s = fakeStorage()
  const st = createLayoutPrefs({ width: 1200, search: '', getStorage: () => s })
  const seen = []
  st.subscribe((x) => seen.push(x.monitorShown))
  st.getState().setNarrow(true)
  assert.equal(st.getState().monitorShown, false)
  st.getState().setNarrow(true)                                  // 重複呼叫不重複通知
  st.getState().setNarrow(false)
  assert.equal(st.getState().monitorShown, true)
  assert.deepEqual(seen, [false, true])
  assert.equal(s.data.has(LS.monitor), false)                    // 自動跟隨不寫偏好
  st.getState().setMonitorShown(true)                            // 使用者明確選「顯示」
  st.getState().setNarrow(true)
  assert.equal(st.getState().monitorShown, true)
})

test('watchNarrowViewport：matchMedia change → 回報窄 / 寬；訂閱當下先回報一次；取消後不再回報（無洩漏）', () => {
  const w = fakeWindow({ width: 1000 })
  const got = []
  const off = watchNarrowViewport(w, (n) => got.push(n))
  assert.deepEqual(got, [false])
  w.setWidth(600)
  w.setWidth(500)
  w.setWidth(900)
  assert.equal(got.at(-1), false)
  assert.ok(got.includes(true))
  assert.equal(w.mqls[0].ls.size, 1)
  off()
  const n = got.length
  w.setWidth(300)
  assert.equal(got.length, n)
  assert.equal(w.mqls[0].ls.size, 0)
  off()                                                          // 重複取消無害
})

test('watchNarrowViewport：舊版 Safari（addListener）與沒有 matchMedia（resize 退路：只在翻轉時回報）', () => {
  const old = fakeWindow({ width: 1000, modern: false })
  const g1 = []
  const off1 = watchNarrowViewport(old, (n) => g1.push(n))
  old.setWidth(700)
  assert.deepEqual(g1, [false, true])
  off1()
  assert.equal(old.mqls[0].ls.size, 0)

  const nomm = fakeWindow({ width: 1000, mm: false })
  const g2 = []
  const off2 = watchNarrowViewport(nomm, (n) => g2.push(n))
  nomm.setWidth(980); nomm.setWidth(900)                         // 仍是寬 → 不回報
  nomm.setWidth(800); nomm.setWidth(700)                         // 翻轉一次
  nomm.setWidth(1100)
  assert.deepEqual(g2, [false, true, false])
  assert.equal(nomm.resizeListeners.size, 1)
  off2()
  assert.equal(nomm.resizeListeners.size, 0)
})

test('watchNarrowViewport：StrictMode 式「掛載 → 取消 → 再掛載」不累積訂閱；沒有 window / 沒有 callback → no-op', () => {
  const w = fakeWindow({ width: 500 })
  const a = watchNarrowViewport(w, () => {})
  a()
  const b = watchNarrowViewport(w, () => {})
  assert.equal(w.mqls.reduce((n, m) => n + m.ls.size, 0), 1)
  b()
  assert.equal(w.mqls.reduce((n, m) => n + m.ls.size, 0), 0)
  assert.equal(typeof watchNarrowViewport(null, () => {}), 'function')
  assert.equal(typeof watchNarrowViewport(undefined, () => {}), 'function')
  assert.equal(typeof watchNarrowViewport(w, null), 'function')
  // matchMedia 丟例外 → 退回 resize
  const broken = fakeWindow({ width: 1000 })
  broken.matchMedia = () => { throw new Error('nope') }
  const g = []
  const off = watchNarrowViewport(broken, (n) => g.push(n))
  broken.setWidth(500)
  assert.deepEqual(g, [false, true])
  off()
})

test('Footer 最新 OUT 事件：挑最後一則 out；沒有 out / 沒有日誌 → null（不顯示）；收斂空白；不改動輸入', () => {
  const log = [
    { dir: 'out', text: 'AR 實景開啟' },
    { dir: 'in', text: 'CC 1 = 64 → 海水高度' },
    { dir: 'out', text: '鯨魚出現' },
    { dir: 'in', text: 'CC 2 = 10' },
  ]
  const snap = JSON.stringify(log)
  assert.equal(pickLatestOut(log), '鯨魚出現')                    // 最後一則是 IN，仍要挑到最近的 OUT
  assert.equal(JSON.stringify(log), snap)
  assert.equal(pickLatestOut([{ dir: 'in', text: 'x' }, { dir: 'in', text: 'y' }]), null)
  assert.equal(pickLatestOut([]), null)
  assert.equal(pickLatestOut(null), null)
  assert.equal(pickLatestOut(undefined), null)
  assert.equal(pickLatestOut('nope'), null)
  assert.equal(pickLatestOut([{ dir: 'out', text: '  多   餘\n空白  ' }]), '多 餘 空白')
  assert.equal(pickLatestOut([{ dir: 'out', text: '舊事件' }, { dir: 'out', text: '   ' }]), '舊事件')   // 空白行略過，往前找
  assert.equal(pickLatestOut([{ dir: 'out', text: '舊事件' }, { dir: 'out' }, null, { dir: 'out', text: 42 }, {}]), '舊事件')   // 壞資料略過
  assert.equal(pickLatestOut([{ dir: 'OUT', text: 'x' }]), null)   // dir 只認小寫 'out'（store 就是這樣寫的）
})

test('節流：距離上次更新還要等多久', () => {
  assert.equal(throttleDelay(1000, 1200, 500), 300)
  assert.equal(throttleDelay(1000, 1500, 500), 0)
  assert.equal(throttleDelay(1000, 9000, 500), 0)
  assert.equal(throttleDelay(1000, 1000, 500), 500)
  assert.equal(throttleDelay(NaN, 1000, 500), 0)
  assert.equal(throttleDelay(undefined, 1000, 500), 0)
})

test('接線檢查：App 有 L 鍵與條件渲染、Footer 有 aria 屬性與 aria-live、Monitor 有可讀名稱（防止之後被誤刪）', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
  const app = read('../App.jsx'), footer = read('../ui/Footer.jsx'), monitor = read('../ui/Monitor.jsx')
  assert.match(app, /k === 'l' \|\| k === 'L'/)
  assert.match(app, /monitorShown && <Splitter axis="y"/)
  assert.match(app, /monitorShown && <Monitor \/>/)
  assert.match(footer, /aria-pressed=\{shown\}/)
  assert.match(footer, /aria-expanded=\{shown\}/)
  assert.match(footer, /aria-controls=/)
  assert.match(footer, /aria-live="polite"/)
  assert.match(monitor, /aria-label=\{t\('輸入輸出監看：MIDI 進、系統事件出'\)\}/)
  assert.match(monitor, /aria-expanded="true"/)
  assert.match(monitor, /aria-controls=\{MONITOR_ID\}/)
})

// ---- 螢幕閱讀器：高頻的資料播放行不進 aria-live ----
test('isDataLine：資料播放每步寫的「DATA …」行（App.jsx pushLog(\'out\', \'DATA \' + formatHud(…))）→ true；使用者動作 / 導覽 / 系統事件 → false；壞輸入不丟錯', () => {
  assert.equal(isDataLine('DATA 09-16 08:00 · PM2.5 23.8'), true)
  assert.equal(isDataLine('DATA\t潮位 150 cm'), true)
  assert.equal(isDataLine('導覽 3/8｜今日月亮'), false)
  assert.equal(isDataLine('AR 實景開啟'), false)
  assert.equal(isDataLine('產生分享連結'), false)
  assert.equal(isDataLine('DATABASE 已更新'), false, '只認「DATA + 空白」開頭')
  assert.equal(isDataLine('資料 DATA x'), false)
  for (const bad of [null, undefined, 42, {}, [], '']) assert.equal(isDataLine(bad), false)
  // 與 pickLatestOut 串起來（Footer 實際拿到的字串：空白已收斂）
  assert.equal(isDataLine(pickLatestOut([{ dir: 'out', text: '  DATA   09-16  08:00 ' }])), true)
})

test('接線檢查（螢幕閱讀器）：Footer 的 DATA 行 aria-hidden（其他 OUT 事件仍在 aria-live 裡朗讀）；DataHUD 不是 live region（每 0.2–1 秒換一次會讓朗讀佇列堆積）', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
  const footer = read('../ui/Footer.jsx'), hud = read('../ui/DataHUD.jsx')
  assert.match(footer, /isDataLine\(text\)/); assert.match(footer, /aria-hidden=\{isDataLine\(text\) \? 'true' : undefined\}/)
  assert.match(footer, /className="footer-out-text"[^>]*aria-hidden=/, '文字節點本身要 aria-hidden（不是只藏 OUT 標籤）')
  assert.match(footer, /aria-live="polite" aria-atomic="true"/, '其他事件仍然朗讀')
  assert.doesNotMatch(hud, /aria-live="polite"/); assert.match(hud, /aria-live="off"/)
})
