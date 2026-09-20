// i18n 靜態檢查：用 Babel AST 找出「沒有被 t() / T() 包起來的中文字面量」，並核對英文字典。
// （註解不會被抓到——AST 本來就不含註解；console.* 內的開發訊息也略過。）
//   node scripts/i18n-report.mjs [檔案…]   列出結果
//   npm test                                 src/i18n/i18n.test.mjs 以此為驗收
import { parse } from '@babel/parser'
import traverseMod from '@babel/traverse'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const traverse = (traverseMod.default && traverseMod.default.default) || traverseMod.default || traverseMod
export const ROOT = join(fileURLToPath(import.meta.url), '..', '..')
export const HAN = /[㐀-鿿豈-﫿]/

// 整檔允許中文（例如「中文版說明內容」元件）：以 repo 相對路徑（用 /）
export const ALLOW_FILES = new Set([
  'src/ui/info/InfoZh.jsx',           // 說明視窗的中文版內容（英文版在 InfoEn.jsx）
])
// 任何地方都允許的字面量（專有名詞 / 隊名，英文版也維持原文者）
export const ALLOW_TEXT = new Set([
  '卡加布列島',
])

const rel = (f) => relative(ROOT, f).split(sep).join('/')

export function listSourceFiles(dir = join(ROOT, 'src')) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) { if (rel(p) !== 'src/i18n/en') out.push(...listSourceFiles(p)); continue }
    if (!/\.(js|jsx)$/.test(name) || /\.test\.(js|jsx|mjs)$/.test(name)) continue
    out.push(p)
  }
  return out
}

// 翻譯 key 的呼叫位置：t('…') / T('…')（第 1 個參數）、translate(loc, '…')（第 2 個參數）
const isKeyCall = (path) => {
  const c = path.parent
  if (!c || c.type !== 'CallExpression' || c.callee.type !== 'Identifier') return false
  const name = c.callee.name
  if (name === 't' || name === 'T') return c.arguments[0] === path.node
  if (name === 'translate') return c.arguments[1] === path.node
  return false
}
const inConsole = (path) => !!path.findParent((p) => p.isCallExpression() && p.node.callee.type === 'MemberExpression' && p.node.callee.object.type === 'Identifier' && p.node.callee.object.name === 'console')

// 分析單一檔案 → { keys:[{key,line}], stray:[{text,line,kind}] }
export function analyze(code, file = 'x.jsx') {
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx'], errorRecovery: false })
  const keys = [], stray = []
  const visit = (path, text, kind) => {
    if (!HAN.test(text)) return
    if (isKeyCall(path)) { keys.push({ key: text, line: path.node.loc.start.line }); return }
    if (inConsole(path)) return
    if (ALLOW_TEXT.has(text.trim())) return
    stray.push({ text: text.trim().replace(/\s+/g, ' ').slice(0, 80), line: path.node.loc.start.line, kind })
  }
  traverse(ast, {
    StringLiteral(path) { if (path.parent.type === 'ImportDeclaration' || path.parent.type === 'ExportNamedDeclaration' || path.parent.type === 'ExportAllDeclaration') return; visit(path, path.node.value, 'string') },
    JSXText(path) { visit(path, path.node.value, 'jsx-text') },
    TemplateLiteral(path) {
      const n = path.node
      if (n.expressions.length === 0 && n.quasis.length === 1 && isKeyCall(path)) { if (HAN.test(n.quasis[0].value.cooked)) keys.push({ key: n.quasis[0].value.cooked, line: n.loc.start.line }); return }
      const raw = n.quasis.map((q) => q.value.cooked || '').join('')
      if (/gl_Frag|gl_Position|\buniform\s|\bvarying\s/.test(raw)) return   // GLSL 著色器字串（裡面的中文是 shader 註解）
      for (const q of n.quasis) if (HAN.test(q.value.cooked || '')) { if (!inConsole(path)) stray.push({ text: q.value.cooked.trim().replace(/\s+/g, ' ').slice(0, 80), line: q.loc.start.line, kind: 'template' }) }
    },
  })
  return { keys, stray }
}

// 掃整個 src → { files:{相對路徑:{keys,stray}}, keys:Set, stray:[{file,text,line,kind}] }
export function scan(files = listSourceFiles()) {
  const res = { files: {}, keys: new Map(), stray: [], errors: [] }
  for (const f of files) {
    const r = rel(f)
    let a
    try { a = analyze(readFileSync(f, 'utf8'), r) } catch (e) { res.errors.push({ file: r, error: String(e.message || e) }); continue }
    res.files[r] = a
    for (const k of a.keys) if (!res.keys.has(k.key)) res.keys.set(k.key, `${r}:${k.line}`)
    if (!ALLOW_FILES.has(r)) for (const s of a.stray) res.stray.push({ file: r, ...s })
  }
  return res
}

// 載入所有 src/i18n/en/*.js 字典（合併）
export async function loadEnDict() {
  const dir = join(ROOT, 'src/i18n/en')
  const dict = {}, owners = {}, dupes = []
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.js')).sort()) {
    const m = await import(pathToFileURL(join(dir, name)).href)
    for (const [k, v] of Object.entries(m.default || {})) {
      // 同一個 key 在不同檔案重複宣告：譯文相同無妨（各功能各自補譯、不用互相協調），譯文不同才算衝突
      if (k in dict && String(dict[k]) !== String(v)) dupes.push({ key: k, a: owners[k], b: name })
      dict[k] = v; owners[k] = name
    }
  }
  return { dict, dupes }
}

export const placeholders = (s) => new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))
