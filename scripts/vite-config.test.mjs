// 建置設定的回歸測試。執行：node --test scripts/vite-config.test.mjs
// 手機遙控頁（#remote=）要輕：入口 chunk 只能依賴 react，不能把 three（≈176KB gzip）/ r3f 拉進來。
// 完整驗證是 npm run build 後看入口與 RemoteApp chunk 的 import（見 README 的效能一節）；這裡守住造成問題的兩個原因。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import config, { manualChunk, makeBuildId, buildInfo, versionPlugin, listCodeFiles } from '../vite.config.js'

const nm = (p) => `/Users/x/IXD2026/node_modules/${p}`

test('manualChunks：react 系列 → react；three → three；@react-three → r3f（不能被 /three/ 的比對吃掉）；其他交給 Rollup', () => {
  assert.equal(manualChunk(nm('react/index.js')), 'react')
  assert.equal(manualChunk(nm('react-dom/client.js')), 'react')
  assert.equal(manualChunk(nm('scheduler/index.js')), 'react')
  assert.equal(manualChunk(nm('zustand/esm/index.js')), 'react')
  assert.equal(manualChunk(nm('three/build/three.module.js')), 'three')
  assert.equal(manualChunk(nm('@react-three/fiber/dist/index.js')), 'r3f', 'r3f 不能落進 three chunk（three 會變成 217KB gzip、r3f chunk 消失）')
  assert.equal(manualChunk(nm('peerjs/dist/bundler.mjs')), undefined)
  assert.equal(manualChunk('/Users/x/IXD2026/src/App.jsx'), undefined)
  assert.equal(manualChunk('C:\\Users\\x\\IXD2026\\node_modules\\three\\build\\three.module.js'), 'three', 'Windows 路徑')
  assert.equal(manualChunk('/Users/x/IXD2026/src/three-utils/react-helper.js'), undefined, '只比對 node_modules 內的套件（錨定）')
  assert.equal(manualChunk(nm('some-react-thing/index.js')), undefined, '名稱含 react 的其他套件不算（錨定）')
})

test('main.jsx 不靜態載入 store / 場景：否則整個 store（連同 haptics）與 three 會被拉進入口 chunk，手機遙控頁也得下載', () => {
  const src = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8')
  const staticImports = [...src.matchAll(/^import\s.*?from\s+'([^']+)'/gm)].map((m) => m[1])
  assert.ok(!staticImports.some((p) => /useStore|Scene3D|three|@react-three/.test(p)), `靜態 import：${staticImports}`)
  assert.match(src, /import\.meta\.env\.DEV\)\s*import\('\.\/store\/useStore\.js'\)/, 'window.__store 只在 DEV、動態載入')
  assert.match(src, /import\('\.\/scene\/Scene3D\.jsx'\)/, '主畫面 / 觀眾視窗預載場景（入口不再靜態帶著它）')
})

// ---------------------------------------------------------------------------------------------
// 展場防呆的版本檔：build id = 「程式碼內容」的 sha1 前 12 碼；外掛輸出 dist/version.json，define 把同一個 id 注入程式（__BUILD_ID__）。
// 頁面（services/ResilienceService → lib/resilience.js）定期以 fetch('/version.json', { cache: 'no-store' }) 比對，不同 = 有新版。
// 為什麼不含時間戳 / 隨機鹽：CI 每 3 小時只換 public/data/ocean.json 就重新部署，id 若每次不同，所有視窗（含投影機的觀眾視窗）都會為了「只換資料」整頁重載。
// ---------------------------------------------------------------------------------------------
const flat = (a) => (Array.isArray(a) ? a.flatMap(flat) : [a])
const versionPluginOf = (cfg) => flat(cfg.plugins).find((p) => p && p.name === 'midisea-version')
const emitted = (plugin) => { const out = []; plugin.generateBundle.call({ emitFile: (f) => out.push(f) }); return out }

// 暫存的迷你專案：與真實專案同樣的頂層結構
function fixture(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'midisea-id-'))
  const files = {
    'src/main.jsx': 'console.log(1)\n', 'src/lib/a.js': 'export const a = 1\n', 'index.html': '<html></html>\n', 'package.json': '{}\n', 'package-lock.json': '{}\n', 'vite.config.js': '// cfg\n',
    'public/sw.js': '// sw\n', 'public/icon.svg': '<svg/>\n', 'public/data/ocean.json': '{"fetchedAt":"2026-09-20T09:00"}\n', ...extra,
  }
  const put = (rel, text) => { const abs = join(root, rel); mkdirSync(join(abs, '..'), { recursive: true }); writeFileSync(abs, text) }
  for (const [rel, text] of Object.entries(files)) put(rel, text)
  return { root, put, done: () => rmSync(root, { recursive: true, force: true }) }
}

test('makeBuildId：12 位小寫 hex；同一份程式碼（不論建置幾次、何時建置）id 相同——純資料的部署不會讓所有視窗重載', () => {
  const f = fixture()
  try {
    const id = makeBuildId(f.root)
    assert.match(id, /^[0-9a-f]{12}$/)
    assert.equal(makeBuildId(f.root), id, '同一份內容 → 同一個 id')
    f.put('public/data/ocean.json', '{"fetchedAt":"2026-09-20T12:00","x":"資料變了"}\n')   // CI 的 refresh-data：只換資料
    f.put('public/data/extra.json', '{}\n')
    assert.equal(makeBuildId(f.root), id, '只換 public/data/ 下的資料 → id 不變（不重載）')
    f.put('src/lib/notes.md', '# 文件\n'); f.put('src/lib/a.test.mjs', 'test\n'); f.put('README.md', 'x\n')
    assert.equal(makeBuildId(f.root), id, '測試檔與文件不算程式碼')
    f.put('src/lib/tourTestEnv.mjs', 'export const helper = 1\n')
    assert.equal(makeBuildId(f.root), id, '測試專用的輔助檔（tourTestEnv.mjs，不會被打包）也不算——回歸：只改它會讓所有展場視窗白白重載')
    f.put('src/lib/tourTestEnv.mjs', 'export const helper = 2 // 又改了一次\n'); f.put('src/services/tourTestEnv.mjs', 'x\n')
    assert.equal(makeBuildId(f.root), id, '改它、或別的資料夾同名的輔助檔，id 都不變')
    f.put('src/lib/tourTestEnvUtil.mjs', 'export const x = 1\n')
    assert.notEqual(makeBuildId(f.root), id, '只有那一個檔名被排除：名字相近的檔案（可能是真的程式）仍算')
  } finally { f.done() }
})

test('makeBuildId：任何程式檔改一個字、新增 / 刪除檔案、動 index.html / package-lock.json / vite.config.js / public 的靜態檔 → id 就不同（真的有新版才重載）', () => {
  const f = fixture()
  try {
    const seen = new Set([makeBuildId(f.root)])
    const changed = (label) => { const id = makeBuildId(f.root); assert.ok(!seen.has(id), label); seen.add(id) }
    f.put('src/lib/a.js', 'export const a = 2\n'); changed('改一個字')
    f.put('src/lib/b.js', 'export const b = 1\n'); changed('新增檔案')
    f.put('public/sw.js', '// sw v2\n'); changed('service worker 也是程式')
    f.put('index.html', '<html><body></body></html>\n'); changed('index.html')
    f.put('package-lock.json', '{"v":2}\n'); changed('套件版本（lock）')
    f.put('vite.config.js', '// cfg 2\n'); changed('建置設定')
    f.put('public/icon.svg', '<svg id="x"/>\n'); changed('public 的靜態資產')
    rmSync(join(f.root, 'src/lib/b.js')); changed('刪除檔案')   // 回到與「新增 b.js 之前 + 其他修改」不同的內容
    // 檔名也算內容：同樣的位元組換個名字 → 不同
    f.put('src/lib/c.js', 'export const c = 1\n'); const c1 = makeBuildId(f.root)
    rmSync(join(f.root, 'src/lib/c.js')); f.put('src/lib/d.js', 'export const c = 1\n')
    assert.notEqual(makeBuildId(f.root), c1)
  } finally { f.done() }
})

test('makeBuildId：與檔案建立順序 / 時間無關（同樣的內容 → 同樣的 id）；缺少 package-lock.json 等檔案不丟錯', () => {
  const a = fixture(), b = fixture()
  try {
    assert.equal(makeBuildId(a.root), makeBuildId(b.root))
    const rmRoot = mkdtempSync(join(tmpdir(), 'midisea-id-empty-'))
    try { assert.match(makeBuildId(rmRoot), /^[0-9a-f]{12}$/, '空目錄也算得出 id（不丟錯）') } finally { rmSync(rmRoot, { recursive: true, force: true }) }
    rmSync(join(b.root, 'package-lock.json')); assert.match(makeBuildId(b.root), /^[0-9a-f]{12}$/); assert.notEqual(makeBuildId(a.root), makeBuildId(b.root))
  } finally { a.done(); b.done() }
})

test('listCodeFiles（真實專案）：含 src / public 的程式與靜態檔、index.html、package-lock.json、vite.config.js；不含 public/data/、測試檔、文件；POSIX 路徑且已排序', () => {
  const files = listCodeFiles()
  for (const must of ['src/main.jsx', 'src/lib/resilience.js', 'public/sw.js', 'index.html', 'package.json', 'vite.config.js']) assert.ok(files.includes(must), must)
  assert.ok(!files.some((f) => f.startsWith('public/data/')), '資料快照不算程式碼')
  assert.ok(!files.some((f) => /\.test\.[cm]?js$/.test(f)), '測試檔不算')
  assert.ok(!files.some((f) => /\.md$/.test(f)), '文件不算')
  assert.ok(!files.includes('src/lib/tourTestEnv.mjs'), '測試專用的輔助檔不算（回歸：以前只擋 .test. 與 .md，它被算進 build id）')
  // 通則：算進 build id 的 .mjs 必須真的被某個「非測試」的模組匯入（會被打包）；只被測試匯入的輔助檔不該讓 id 變——之後再加 fooTestEnv.mjs 之類的檔案會被這條抓到
  const root = fileURLToPath(new URL('..', import.meta.url))
  const nonTest = files.filter((f) => /\.(m?js|jsx)$/.test(f) && f.startsWith('src/'))
  const codeText = nonTest.map((f) => { try { return readFileSync(join(root, f), 'utf8') } catch (e) { return '' } }).join('\n')
  for (const m of files.filter((f) => f.startsWith('src/') && f.endsWith('.mjs'))) {
    const base = m.split('/').pop().replace(/\.mjs$/, '')
    assert.ok(new RegExp("from\\s+['\"][^'\"]*" + base + "(\\.mjs)?['\"]|import\\(['\"][^'\"]*" + base).test(codeText), `${m} 算進了 build id，但沒有任何非測試模組匯入它（是測試輔助檔？請加進 vite.config.js 的 SKIP_FILE）`)
  }
  assert.ok(!files.some((f) => f.includes('\\')), 'POSIX 分隔')
  assert.deepEqual(files, [...files].sort())
  assert.match(makeBuildId(), /^[0-9a-f]{12}$/); assert.equal(makeBuildId(), makeBuildId(), '真實專案連算兩次相同')
})

test('buildInfo：build 依程式碼算 id + ISO 時間；dev（serve）為 "dev"', () => {
  const f = fixture()
  try {
    const now = new Date(Date.UTC(2026, 0, 2, 3, 4, 5))
    const b = buildInfo('build', now, f.root)
    assert.equal(b.id, makeBuildId(f.root)); assert.equal(b.builtAt, '2026-01-02T03:04:05.000Z')
    assert.equal(buildInfo('build', new Date(Date.UTC(2026, 5, 1)), f.root).id, b.id, '建置時間不同、程式碼相同 → id 相同')
    assert.deepEqual(buildInfo('serve', now, f.root), { id: 'dev', builtAt: '' })
  } finally { f.done() }
})

test('versionPlugin：只在 build 套用，輸出 version.json = { id, builtAt }', () => {
  const p = versionPlugin({ id: 'ID-1', builtAt: '2026-01-02T03:04:05.000Z' })
  assert.equal(p.name, 'midisea-version'); assert.equal(p.apply, 'build')
  const files = emitted(p)
  assert.equal(files.length, 1)
  assert.equal(files[0].type, 'asset'); assert.equal(files[0].fileName, 'version.json')
  assert.deepEqual(JSON.parse(files[0].source), { id: 'ID-1', builtAt: '2026-01-02T03:04:05.000Z' })
})

test('vite 設定：build 時 define 的 __BUILD_ID__ 與 version.json 的 id 是同一個；dev 為 "dev"；同一份程式碼重複建置 id 相同（只換資料的部署不改 id）', () => {
  assert.equal(typeof config, 'function', '設定是函式形式（依 command 決定 build id）')
  const a = config({ command: 'build', mode: 'production' })
  const id = JSON.parse(a.define.__BUILD_ID__)
  assert.match(id, /^[0-9a-f]{12}$/)
  const plugin = versionPluginOf(a)
  assert.ok(plugin, '設定裡有版本檔外掛')
  assert.equal(JSON.parse(emitted(plugin)[0].source).id, id, 'version.json 與程式內的 build id 一致')
  const b = config({ command: 'build', mode: 'production' })
  assert.equal(JSON.parse(b.define.__BUILD_ID__), id, '同一份程式碼再建置一次：id 不變')
  assert.equal(JSON.parse(config({ command: 'serve', mode: 'development' }).define.__BUILD_ID__), 'dev')
  // 既有設定沒被動到
  assert.equal(a.base, '/'); assert.equal(a.build.rollupOptions.output.manualChunks, manualChunk)
})

test('CI 資料刷新（refresh-data.yml）只 commit public/data/ocean.json：這個檔案在 id 的計算範圍之外（原始碼層級守住，避免有人把資料目錄加回去）', () => {
  const cfg = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8')
  assert.match(cfg, /SKIP_DIRS = new Set\(\['public\/data'\]\)/)
  assert.doesNotMatch(cfg, /randomBytes|Math\.random/, 'id 不能再混入隨機鹽')
  const wf = readFileSync(new URL('../.github/workflows/refresh-data.yml', import.meta.url), 'utf8')
  assert.match(wf, /git add public\/data\/ocean\.json/)
})

test('resilience.js 以 typeof 讀 __BUILD_ID__（Node / dev 沒有定義時不會 ReferenceError，退回 "dev"）', () => {
  const src = readFileSync(new URL('../src/lib/resilience.js', import.meta.url), 'utf8')
  assert.match(src, /typeof __BUILD_ID__ !== 'undefined' \? __BUILD_ID__ : 'dev'/)
})

test('main.jsx 用 ErrorBoundary 包住既有的 render 內容；入口 chunk 依賴仍然輕量（ErrorBoundary / resilience.js 不靜態載入 store / 場景 / three）', () => {
  const src = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8')
  assert.match(src, /import ErrorBoundary from '\.\/ErrorBoundary\.jsx'/)
  assert.match(src, /<ErrorBoundary>[\s\S]*<Suspense[\s\S]*<RemoteApp[\s\S]*<DiagnosticsApp[\s\S]*<AudienceApp[\s\S]*<App \/>[\s\S]*<\/Suspense>[\s\S]*<\/ErrorBoundary>/, '既有的路由分支原封不動地在 ErrorBoundary 裡')
  for (const f of ['../src/ErrorBoundary.jsx', '../src/lib/resilience.js']) {
    const code = readFileSync(new URL(f, import.meta.url), 'utf8')
    const imports = [...code.matchAll(/^import\s.*?from\s+'([^']+)'/gm)].map((m) => m[1])
    assert.ok(!imports.some((p) => /useStore|store\/|Scene3D|three|@react-three|audience|services\//.test(p)), `${f} 的靜態 import：${imports}`)
  }
})

// 完整驗證：npm run build 之後 dist/version.json 存在，且 id 與 bundle 內一致。
// 預設略過（build 可能正在別處進行、dist 內容不穩定）；MIDISEA_VERIFY_DIST=1 node --test scripts/vite-config.test.mjs 才跑。
test('dist（建置後）：version.json 存在且 id 出現在 bundle 內', { skip: !process.env.MIDISEA_VERIFY_DIST }, () => {
  const root = new URL('../dist/', import.meta.url)
  assert.ok(existsSync(new URL('version.json', root)), 'dist/version.json 不存在——先跑 npm run build')
  const v = JSON.parse(readFileSync(new URL('version.json', root), 'utf8'))
  assert.match(v.id, /^[0-9a-f]{12}$/); assert.ok(!Number.isNaN(Date.parse(v.builtAt)))
  const assets = readdirSync(new URL('assets/', root)).filter((f) => f.endsWith('.js'))
  const hits = assets.filter((f) => readFileSync(new URL('assets/' + f, root), 'utf8').includes(v.id))
  assert.ok(hits.length >= 1, `bundle 內找不到 build id ${v.id}`)
})

// =============================================================================================
// 英文字典動態載入（第 5 輪）：src/i18n/en/*.js 與彙整它們的 src/i18n/en-all.js 全部歸同一個 chunk「i18n-en」，
// 只被 src/i18n/index.js 的 loadEnglish() 動態 import——中文使用者與手機遙控頁的中文模式完全不下載（入口 chunk gzip 約 13KB，而不是 67KB）。
// =============================================================================================
import { resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadEnDict } from './i18n-check.mjs'

test('manualChunks：src/i18n/en/*.js 與 src/i18n/en-all.js 歸 i18n-en；i18n 其他檔案（index / loader / data / data-tables）與其餘原始碼、node_modules 分塊規則不變', () => {
  const src = (p) => `/Users/x/IXD2026/src/${p}`
  assert.equal(manualChunk(src('i18n/en/air.js')), 'i18n-en')
  assert.equal(manualChunk(src('i18n/en/ui-shell.js')), 'i18n-en')
  assert.equal(manualChunk(src('i18n/en/diagnostics2.js')), 'i18n-en')
  assert.equal(manualChunk(src('i18n/en-all.js')), 'i18n-en', '彙整模組跟字典同一個 chunk（否則會多一個只轉手的 facade chunk、多一趟往返）')
  assert.equal(manualChunk('C:\\Users\\x\\IXD2026\\src\\i18n\\en\\tour.js'), 'i18n-en', 'Windows 路徑')
  assert.equal(manualChunk(src('i18n/en/air.js') + '?v=123'), 'i18n-en', '帶查詢字串')
  // 真實專案裡每一個字典檔都要歸進去（新增功能的字典自動被 glob 併入，也自動歸這個 chunk）
  for (const f of readdirSync(new URL('../src/i18n/en/', import.meta.url)).filter((n) => n.endsWith('.js'))) assert.equal(manualChunk(src(`i18n/en/${f}`)), 'i18n-en', f)
  // 其餘不變
  for (const f of ['i18n/index.js', 'i18n/loader.js', 'i18n/data.js', 'i18n/data-tables.js', 'i18n/i18n.test.mjs', 'i18n/GLOSSARY.md', 'main.jsx', 'App.jsx', 'lib/resilience.js', 'i18n/en/nested/x.js', 'i18n/english.js', 'i18n/en-all.json']) assert.equal(manualChunk(src(f)), undefined, f)
  assert.equal(manualChunk('/Users/x/IXD2026/node_modules/foo/src/i18n/en/x.js'), undefined, 'node_modules 裡剛好同名的路徑不算（錨定在 node_modules 之外）')
  assert.equal(manualChunk(nm('react/index.js')), 'react'); assert.equal(manualChunk(nm('three/build/three.module.js')), 'three'); assert.equal(manualChunk(nm('@react-three/fiber/dist/index.js')), 'r3f')
  assert.equal(config({ command: 'build', mode: 'production' }).build.rollupOptions.output.manualChunks, manualChunk)
})

test('main.jsx 啟動流程：最前面就 bootLocale()（英文字典載入與路由 chunk 並行），第一次 render 等它（.then(mount, mount)：不論成功 / 逾時 / 失敗都 render），render 只出現在 mount 裡；不靜態載入字典', () => {
  const src = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8')
  assert.match(src, /import \{ t, bootLocale, prefetchEnglish \} from '\.\/i18n\/index\.js'/)
  const iBoot = src.indexOf('const localeReady = bootLocale()')
  assert.ok(iBoot > 0, '有 bootLocale() 啟動')
  assert.ok(iBoot < src.indexOf('const parseRemote') && iBoot < src.indexOf("lazy(() => import('./App.jsx'))"), 'bootLocale() 在路由設定之前（最前面就開始載入）')
  assert.match(src, /const mount = \(\) => createRoot\(document\.getElementById\('root'\)\)\.render\(/)
  assert.match(src, /\nlocaleReady\.then\(mount, mount\)\s*$/, '等字典（成功 / 失敗都 render）')
  assert.equal((src.match(/\.render\(/g) || []).length, 1, 'render 只有 mount 裡一處（不會在字典就緒前就 render）')
  assert.doesNotMatch(src, /en-all|i18n\/en\//, '不靜態載入字典')
  assert.match(src, /import\('\.\/remote\/RemoteApp\.jsx'\)\s*:\s*diagnosticsMode \? import\('\.\/DiagnosticsApp\.jsx'\)\s*:\s*audienceMode \? import\('\.\/AudienceApp\.jsx'\)\s*:\s*import\('\.\/App\.jsx'\)/, '等字典期間預抓這個網址會用到的路由 chunk（與 lazy() 同一個模組）')
  // 路由分流與 #remote= 解析原封不動
  assert.match(src, /remoteMatch \? <RemoteApp hostId=\{remoteMatch\.hostId\} guide=\{remoteMatch\.guide\} \/> : diagnosticsMode \? <DiagnosticsApp \/> : audienceMode \? <AudienceApp \/> : <App \/>/)
})

// 完整驗證（建置產物）：預設略過。MIDISEA_VERIFY_DIST=1 讀 dist/；MIDISEA_DIST_DIR=<目錄> 讀指定的（例如暫存目錄的 build，不動別人正在用的 dist/）。
//   MIDISEA_DIST_DIR=/tmp/xxx/build node --test scripts/vite-config.test.mjs
const distDir = process.env.MIDISEA_DIST_DIR ? pathToFileURL(resolvePath(process.env.MIDISEA_DIST_DIR) + '/') : new URL('../dist/', import.meta.url)
test('dist（建置後）：i18n-en 是單一帶 hash 的 chunk；index.html / 入口 chunk 不含英文字典；只有入口 chunk 動態 import 它，沒有任何靜態依賴；HTML 不 modulepreload 它', { skip: !(process.env.MIDISEA_VERIFY_DIST || process.env.MIDISEA_DIST_DIR) }, async () => {
  const html = readFileSync(new URL('index.html', distDir), 'utf8')
  const files = readdirSync(new URL('assets/', distDir)).filter((f) => f.endsWith('.js'))
  const en = files.filter((f) => /^i18n-en-[A-Za-z0-9_-]{8}\.js$/.test(f))
  assert.equal(en.length, 1, `i18n-en 應該只有一個帶 hash 的 chunk：${files.filter((f) => /i18n/.test(f))}`)
  const enFile = en[0]
  assert.ok(!html.includes('i18n-en'), 'index.html 不能引用 i18n-en（modulepreload / script 都不行）')
  const entry = /<script type="module"[^>]*src="\/assets\/([^"]+\.js)"/.exec(html)[1]
  const read = (f) => readFileSync(new URL('assets/' + f, distDir), 'utf8')
  const entryCode = read(entry)
  assert.match(entryCode, new RegExp(`import\\("\\./${enFile.replace('.', '\\.')}"\\)`), '入口 chunk 以動態 import 載入字典')
  for (const f of files) {
    if (f === enFile) continue
    const code = read(f)
    const staticDep = new RegExp(`(?:from|import)\\s*"\\./${enFile.replace('.', '\\.')}"`).test(code)
    assert.ok(!staticDep, `${f} 靜態依賴 ${enFile}（中文使用者也得下載字典）`)
    if (f !== entry) assert.ok(!code.includes(enFile), `${f} 引用了 ${enFile}（只有入口 chunk 該動態載入它）`)
  }
  // 字典內容只在 i18n-en：抽樣（較長的英文譯文）
  const { dict } = await loadEnDict()
  const samples = Object.values(dict).filter((v) => typeof v === 'string' && v.length >= 30 && !/["'\\`]/.test(v)).slice(0, 40)
  assert.ok(samples.length >= 20)
  const enCode = read(enFile)
  const inEntry = samples.filter((s) => entryCode.includes(s)), inEn = samples.filter((s) => enCode.includes(s))
  assert.deepEqual(inEntry, [], '入口 chunk 不能含英文字典的內容')
  assert.ok(inEn.length >= samples.length * 0.9, `i18n-en 應含字典內容（${inEn.length}/${samples.length}）`)
  for (const f of files) if (f !== enFile && f !== entry) assert.ok(!samples.some((s) => read(f).includes(s)), `${f} 含英文字典內容`)
})
