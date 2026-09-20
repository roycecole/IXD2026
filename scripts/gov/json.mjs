// ocean.json 的序列化：等同 JSON.stringify(v, null, 2)，只有指定路徑下「純值的陣列／物件」（資料列）收成單行，
// 讓逐日月亮、站點目錄、逐年統計這些大量小列不會各佔 8–10 行。路徑以 '.' 連接、陣列索引以 '*' 代替。
// 未列入者維持原本的 2 空白縮排，既有段落的文字完全不變（git diff 只會出現新增內容）。
export const INLINE_PATHS = [
  'moon.days.*',
  'stations.list.*',
  'dust.stations.*',
  'dust.history.*',
  'options.*.fish.monthly',
  'options.*.fish.yearly.*',
  'options.*.birds.yearly.*',
]

const isPrim = (v) => v === null || typeof v !== 'object'

export function stringifyOcean(value, inline = INLINE_PATHS) {
  const inlineSet = new Set(inline)
  const walk = (v, path, depth) => {
    if (isPrim(v)) return JSON.stringify(v) ?? 'null'
    const isArr = Array.isArray(v)
    const entries = isArr ? v : Object.entries(v).filter(([, x]) => x !== undefined && typeof x !== 'function')
    if (!entries.length) return isArr ? '[]' : '{}'
    const flat = isArr ? v.every(isPrim) : entries.every(([, x]) => isPrim(x))
    if (flat && inlineSet.has(path.join('.'))) return JSON.stringify(v)
    const pad = '  '.repeat(depth + 1)
    const items = isArr
      ? v.map((x) => pad + walk(x === undefined ? null : x, [...path, '*'], depth + 1))
      : entries.map(([k, x]) => pad + JSON.stringify(k) + ': ' + walk(x, [...path, k], depth + 1))
    return (isArr ? '[' : '{') + '\n' + items.join(',\n') + '\n' + '  '.repeat(depth) + (isArr ? ']' : '}')
  }
  return walk(value, [], 0) + '\n'
}
