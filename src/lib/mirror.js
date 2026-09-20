// 「鏡像狀態切片」註冊表：讓觀眾視窗（第二個視窗，見 lib/audience.js）能顯示主視窗的某塊狀態。
// 任何功能想被鏡像到觀眾視窗，就在自己的模組頂層 registerMirror(key, slice)——不必知道觀眾視窗怎麼實作。
//   slice = {
//     get(): JSON 可序列化的值（主視窗端：目前狀態）,
//     apply(value): 把收到的值套用到本視窗的狀態（觀眾視窗端）,
//     subscribe(cb): 狀態改變時呼叫 cb()（主視窗端），回傳取消訂閱函式,
//     hz?: 最高廣播頻率（預設 10），
//   }
// 主視窗與觀眾視窗載入的是同一份程式：切片在兩邊都會註冊，只是主視窗用 get/subscribe、觀眾視窗用 apply。
const slices = new Map()

export function registerMirror(key, slice) {
  if (!key || !slice || typeof slice.get !== 'function' || typeof slice.apply !== 'function') throw new Error('registerMirror: key and { get, apply, subscribe? } are required')
  slices.set(key, slice)
  return () => { if (slices.get(key) === slice) slices.delete(key) }
}
export function getMirror(key) { return slices.get(key) }
export function listMirrors() { return [...slices.entries()] }
export function clearMirrors() { slices.clear() }   // 測試用
