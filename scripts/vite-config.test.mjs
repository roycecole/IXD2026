// 建置設定的回歸測試。執行：node --test scripts/vite-config.test.mjs
// 手機遙控頁（#remote=）要輕：入口 chunk 只能依賴 react，不能把 three（≈176KB gzip）/ r3f 拉進來。
// 完整驗證是 npm run build 後看入口與 RemoteApp chunk 的 import（見 README 的效能一節）；這裡守住造成問題的兩個原因。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { manualChunk } from '../vite.config.js'

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
