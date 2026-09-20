// 建置設定的回歸測試。執行：node --test scripts/vite-config.test.mjs
// 手機遙控頁（#remote=）要輕：入口 chunk 只能依賴 react，不能把 three（≈176KB gzip）/ r3f 拉進來。
// 完整驗證是 npm run build 後看入口與 RemoteApp chunk 的 import（見 README 的效能一節）；這裡守住造成問題的兩個原因。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import config, { manualChunk, makeBuildId, buildInfo, versionPlugin } from '../vite.config.js'

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
// 展場防呆的版本檔：build id = 建置時間戳 + 短 hash；外掛輸出 dist/version.json，define 把同一個 id 注入程式（__BUILD_ID__）。
// 頁面（services/ResilienceService → lib/resilience.js）定期以 fetch('/version.json', { cache: 'no-store' }) 比對，不同 = 有新版。
// ---------------------------------------------------------------------------------------------
const flat = (a) => (Array.isArray(a) ? a.flatMap(flat) : [a])
const versionPluginOf = (cfg) => flat(cfg.plugins).find((p) => p && p.name === 'midisea-version')
const emitted = (plugin) => { const out = []; plugin.generateBundle.call({ emitFile: (f) => out.push(f) }); return out }

test('makeBuildId：UTC 時間戳（14 位）+ 短 hash（7 碼）；同輸入同結果、不同鹽不同 hash', () => {
  const d = new Date(Date.UTC(2026, 8, 20, 12, 34, 56))
  const id = makeBuildId(d, 'salt-a')
  assert.match(id, /^\d{14}-[0-9a-f]{7}$/)
  assert.ok(id.startsWith('20260920123456-'))
  assert.equal(makeBuildId(d, 'salt-a'), id)
  assert.notEqual(makeBuildId(d, 'salt-b'), id)
  assert.match(makeBuildId(), /^\d{14}-[0-9a-f]{7}$/, '預設用現在時間與隨機鹽')
  assert.notEqual(makeBuildId(), makeBuildId(), '兩次建置（即使同一秒）id 也不同')
})

test('buildInfo：build 產生新 id + ISO 時間；dev（serve）為 "dev"', () => {
  const now = new Date(Date.UTC(2026, 0, 2, 3, 4, 5))
  const b = buildInfo('build', now)
  assert.match(b.id, /^20260102030405-[0-9a-f]{7}$/); assert.equal(b.builtAt, '2026-01-02T03:04:05.000Z')
  assert.deepEqual(buildInfo('serve', now), { id: 'dev', builtAt: '' })
})

test('versionPlugin：只在 build 套用，輸出 version.json = { id, builtAt }', () => {
  const p = versionPlugin({ id: 'ID-1', builtAt: '2026-01-02T03:04:05.000Z' })
  assert.equal(p.name, 'midisea-version'); assert.equal(p.apply, 'build')
  const files = emitted(p)
  assert.equal(files.length, 1)
  assert.equal(files[0].type, 'asset'); assert.equal(files[0].fileName, 'version.json')
  assert.deepEqual(JSON.parse(files[0].source), { id: 'ID-1', builtAt: '2026-01-02T03:04:05.000Z' })
})

test('vite 設定：build 時 define 的 __BUILD_ID__ 與 version.json 的 id 是同一個；dev 為 "dev"；每次建置 id 不同', () => {
  assert.equal(typeof config, 'function', '設定是函式形式（依 command 決定 build id）')
  const a = config({ command: 'build', mode: 'production' })
  const id = JSON.parse(a.define.__BUILD_ID__)
  assert.match(id, /^\d{14}-[0-9a-f]{7}$/)
  const plugin = versionPluginOf(a)
  assert.ok(plugin, '設定裡有版本檔外掛')
  assert.equal(JSON.parse(emitted(plugin)[0].source).id, id, 'version.json 與程式內的 build id 一致')
  const b = config({ command: 'build', mode: 'production' })
  assert.notEqual(JSON.parse(b.define.__BUILD_ID__), id)
  assert.equal(JSON.parse(config({ command: 'serve', mode: 'development' }).define.__BUILD_ID__), 'dev')
  // 既有設定沒被動到
  assert.equal(a.base, '/'); assert.equal(a.build.rollupOptions.output.manualChunks, manualChunk)
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
  assert.match(v.id, /^\d{14}-[0-9a-f]{7}$/); assert.ok(!Number.isNaN(Date.parse(v.builtAt)))
  const assets = readdirSync(new URL('assets/', root)).filter((f) => f.endsWith('.js'))
  const hits = assets.filter((f) => readFileSync(new URL('assets/' + f, root), 'utf8').includes(v.id))
  assert.ok(hits.length >= 1, `bundle 內找不到 build id ${v.id}`)
})
