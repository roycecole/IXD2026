// 用法：node scripts/i18n-report.mjs [--keys] [檔案…]   → 列出未包 t() 的中文字面量與缺英文的 key
import { resolve } from 'node:path'
import { scan, loadEnDict, listSourceFiles, placeholders, HAN } from './i18n-check.mjs'

const args = process.argv.slice(2)
const showKeys = args.includes('--keys')
const files = args.filter((a) => !a.startsWith('--')).map((f) => resolve(f))
const res = scan(files.length ? files : listSourceFiles())
const { dict, dupes } = await loadEnDict()

const byFile = {}
for (const s of res.stray) (byFile[s.file] ||= []).push(s)
let n = 0
for (const [f, arr] of Object.entries(byFile).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n## ${f}  （未包 t() 的中文 ${arr.length} 處）`)
  for (const s of arr) { console.log(`  ${String(s.line).padStart(4)}  [${s.kind}] ${s.text}`); n++ }
}
const missing = [...res.keys.keys()].filter((k) => !(k in dict))
console.log(`\n未包 t() 的中文字面量：${n}；缺英文的 key：${missing.length}；字典重複 key：${dupes.length}；解析失敗檔案：${res.errors.length}`)
if (showKeys || missing.length <= 40) for (const k of missing) console.log(`  缺英文  ${res.keys.get(k)}  ${k.slice(0, 70)}`)
for (const e of res.errors) console.log(`  解析失敗 ${e.file}: ${e.error}`)
for (const d of dupes) console.log(`  重複 ${d.key.slice(0, 50)}（${d.a} / ${d.b}）`)
process.exit(n || missing.length || dupes.length || res.errors.length ? 1 : 0)
