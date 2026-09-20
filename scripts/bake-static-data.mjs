// 一次性烘焙（可重複執行、冪等）：把「歷史靜態」政府資料併進 public/data/ocean.json。
//   · stations        水利署河川流量測站站況（188 站）→ 島形座標           （data.gov.tw 22223）
//   · options[].fish  水利署魚類調查 → 各流域物種數 / 總隻次 / 逐月 / 逐年     （data.gov.tw 25799）
//   · options[].birds 水利署鳥類調查（32720）：既有 basin/species/count/monthly/monthlyBasin 原值不動，只補 yearly；
//                     新選項（德基、揚塵、月亮）補完整 birds
//   · 新增選項 dust-yunlin、moon-hualien；補 source / mapping / birdsNote 文字
// 動態資料（揚塵最新值、月出月沒）不在這裡，由 fetch-ocean-data.mjs 於 CI 每次刷新。
//
// 用法：node scripts/bake-static-data.mjs [--dir <已下載的 JSON 目錄>]
//   OCEAN_JSON_PATH  指向副本可先試跑（同 fetch-ocean-data.mjs）
//   --dir / GOV_DATA_DIR  目錄內若有 flow.json / fish.json / bird.json 就直接讀，否則從水利署 API 下載（魚 10MB、鳥 23MB）
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getJson, retry } from './gov/http.mjs'
import { buildStations, stationsNote, STATIONS_URL } from './gov/stations.mjs'
import {
  buildSpeciesResolver, summarizeSurvey, groupByBasin,
  BIRD_URL, FISH_URL, BIRD_MIN_RECORDS, FISH_MIN_RECORDS,
} from './gov/survey.mjs'
import {
  ensureGovOptions, orderOption, orderTop, withSourceParts, appendParts, withBirdsNoteAppendix,
  SOURCE_LABEL, BASE_MAPPING, MAPPING_ADDITIONS, BIRDS_NOTE_APPENDIX,
} from './gov/shape.mjs'
import { stringifyOcean } from './gov/json.mjs'

// 選項 → 調查流域（basinname）。揚塵源自濁水溪河床；德基水庫在大甲溪。
export const OPTION_BASIN = {
  feitsui: '淡水河', shimen: '淡水河',
  zengwen: '曾文溪', nanhua: '曾文溪',
  'hualien-tide': '花蓮溪', 'moon-hualien': '花蓮溪',
  'dust-yunlin': '濁水溪',
  deji: '大甲溪',
}
const ATTACH_MIN_ROWS = 60 // 該流域在該資料集至少要有這麼多筆才附上（否則略過，不憑寥寥數筆畫出魚群／鳥群）

/**
 * 純函式：ocean.json（物件）+ 三份原始資料列 → { ocean, report }。不讀寫檔案、不連網。
 * 冪等：既有 birds 的原值從不覆寫；stations / fish / birds.yearly 每次重算。
 */
export function bakeStatic(cur, { flowRows, fishRows, birdRows }) {
  const out = structuredClone(cur)
  const report = { options: [] }

  const st = buildStations(flowRows)
  report.stations = { total: st.total, active: st.active, skipped: st.skipped, extent: st.extent }
  out.stations = { note: stationsNote(st), total: st.total, active: st.active, list: st.list }

  out.options = ensureGovOptions(Array.isArray(out.options) ? out.options : [])

  const surveys = {
    bird: { by: groupByBasin(birdRows), keyOf: buildSpeciesResolver(birdRows), min: BIRD_MIN_RECORDS, cache: new Map() },
    fish: { by: groupByBasin(fishRows), keyOf: buildSpeciesResolver(fishRows), min: FISH_MIN_RECORDS, cache: new Map() },
  }
  // 該流域在該資料集的彙總；筆數不足 ATTACH_MIN_ROWS → null
  const summary = (kind, basin) => {
    const sv = surveys[kind]
    if (sv.cache.has(basin)) return sv.cache.get(basin)
    const rows = sv.by.get(basin)
    const r = rows && rows.length >= ATTACH_MIN_ROWS ? { rows: rows.length, ...summarizeSurvey(rows, sv.keyOf, { minRecords: sv.min }) } : null
    sv.cache.set(basin, r)
    return r
  }

  // 既有（凍結）的 birds 依流域收集：同流域的新選項（月亮 ↔ 花蓮外海）沿用同一組數字，兩個選項不會顯示不同的花蓮溪
  const frozenBirds = new Map()
  for (const o of out.options) {
    const b = OPTION_BASIN[o.id]
    if (b && o.birds && o.birds.basin === `${b}流域` && !frozenBirds.has(b)) frozenBirds.set(b, o.birds)
  }

  for (const o of out.options) {
    const basin = OPTION_BASIN[o.id]
    const rep = { id: o.id, basin: basin || null }
    report.options.push(rep)
    if (!basin) continue

    const b = summary('bird', basin)
    if (b) {
      if (o.birds) o.birds.yearly = b.yearly // 既有 basin / species / count / monthly / monthlyBasin 一律不動
      else {
        const frozen = frozenBirds.get(basin)
        o.birds = frozen
          ? { ...structuredClone(frozen), yearly: b.yearly }
          : { basin: `${basin}流域`, species: b.species, count: b.count, monthly: b.monthly, monthlyBasin: basin, yearly: b.yearly }
      }
      rep.birds = { rows: b.rows, computed: { species: b.species, count: b.count, monthly: b.monthly }, kept: { species: o.birds.species, count: o.birds.count, monthly: o.birds.monthly }, yearly: o.birds.yearly }
    }

    const f = summary('fish', basin)
    if (f) {
      o.fish = { basin: `${basin}流域`, species: f.species, count: f.count, monthly: f.monthly, yearly: f.yearly }
      rep.fish = { rows: f.rows, ...o.fish }
    } else delete o.fish
  }
  out.options = out.options.map(orderOption)

  out.mapping = appendParts(out.mapping || BASE_MAPPING, MAPPING_ADDITIONS)
  out.birdsNote = withBirdsNoteAppendix(out.birdsNote || '', BIRDS_NOTE_APPENDIX)
  out.source = withSourceParts(out.source || '', [SOURCE_LABEL.stations, SOURCE_LABEL.fish])
  return { ocean: orderTop(out), report }
}

const MIN_ROWS = { flow: 50, fish: 1000, bird: 1000 } // 下載被截斷 / 回傳錯誤物件時拒絕烘焙，避免把好資料洗掉
async function loadDataset(name, url, dir) {
  const file = dir ? join(dir, `${name}.json`) : null
  const local = !!file && existsSync(file)
  const check = (rows) => {
    if (!Array.isArray(rows) || rows.length < MIN_ROWS[name]) throw new Error(`unexpected payload (${Array.isArray(rows) ? rows.length + ' rows' : typeof rows})`)
    return rows
  }
  try {
    // 水利署 opendata 偶爾回空內容 / 截斷的 JSON（實測遇過）：下載會重試
    const rows = local ? check(JSON.parse(await readFile(file, 'utf8'))) : await retry(async () => check(await getJson(url, 120000)), { attempts: 3, delayMs: 5000, label: name })
    console.log(`${name}: ${rows.length} rows ${local ? `(local ${file})` : '(downloaded)'}`)
    return rows
  } catch (e) { throw new Error(`${name}: ${e.message}`) }
}

async function main() {
  const i = process.argv.indexOf('--dir')
  const dir = i > 0 ? process.argv[i + 1] : process.env.GOV_DATA_DIR
  const url = process.env.OCEAN_JSON_PATH ? pathToFileURL(resolvePath(process.env.OCEAN_JSON_PATH)) : new URL('../public/data/ocean.json', import.meta.url)
  const cur = JSON.parse(await readFile(url, 'utf8'))

  // 依序下載、不要並行：水利署 opendata 並行請求時實測會回錯置（A 端點回 B 內容）／空白／截斷的資料；魚、鳥欄位相同，錯置了 MIN_ROWS 也擋不住
  const flowRows = await loadDataset('flow', STATIONS_URL, dir)
  const fishRows = await loadDataset('fish', FISH_URL, dir)
  const birdRows = await loadDataset('bird', BIRD_URL, dir)
  const { ocean, report } = bakeStatic(cur, { flowRows, fishRows, birdRows })

  console.log(`stations: total ${report.stations.total}, active ${report.stations.active}, skipped ${report.stations.skipped}`)
  for (const r of report.options) {
    const valid = (m) => m.filter((v) => v !== null).length
    console.log(
      `${r.id.padEnd(13)} ${(r.basin || '-').padEnd(4)}`,
      r.birds ? `birds species ${r.birds.kept.species} count ${r.birds.kept.count} months ${valid(r.birds.kept.monthly)} years ${r.birds.yearly.length}` : 'birds -',
      '|',
      r.fish ? `fish species ${r.fish.species} count ${r.fish.count} months ${valid(r.fish.monthly)} years ${r.fish.yearly.length}` : 'fish -',
    )
  }
  await writeFile(url, stringifyOcean(ocean))
  console.log('baked →', url.pathname ?? String(url))
}

const isMain = (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href } catch (e) { return false } })()
if (isMain) main().catch((e) => { console.error('bake failed:', e.message); process.exit(1) })
