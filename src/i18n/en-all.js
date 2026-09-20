// 英文字典彙整模組：把 src/i18n/en/*.js 的 default 全部合併成一份字典。
// 只由 src/i18n/index.js 的 loadEnglish() 以 import() 動態載入——建置後 = 單一 chunk「i18n-en」（vite.config.js 的 manualChunk；含 ./en/ 底下所有檔案），
// 中文使用者、手機遙控頁的中文模式都不會下載它。新增功能的英文字典照舊放 src/i18n/en/<feature>.js（自動被 glob 併進來，不必改這裡）。
// Node 不會載入這個檔（沒有 import.meta.glob）：測試用 registerEn()，scripts/i18n-check.mjs 從磁碟讀 ./en/*.js。
// import: 'default' 只取各檔的 default（詞素表等具名匯出留給 data-tables.js，不必進這個 chunk）。
const mods = import.meta.glob('./en/*.js', { eager: true, import: 'default' })
const dict = {}
for (const d of Object.values(mods)) Object.assign(dict, d || {})
export default dict
