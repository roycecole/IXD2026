// 資料層組詞規則的詞素表（天氣現象詞 / 農曆），給 src/i18n/data.js 使用。
// 為什麼獨立一份、而不是直接 import ./en/data.js：src/i18n/en/ 底下全部是「英文字典」，建置時被歸進動態載入的 i18n-en chunk（見 vite.config.js 的 manualChunk），
// 中文使用者與手機遙控頁完全不下載它；data.js 若靜態 import ./en/data.js，i18n-en 就會變成主畫面的靜態依賴（連中文使用者也要下載整包英文字典）。
// 這些表很小（約 2KB），複製一份的代價遠小於那個。src/i18n/i18n.test.mjs 會核對本檔與 ./en/data.js 的同名匯出逐項相同（改一邊忘了另一邊會失敗）。
// 注意：中文只能當「物件的鍵」（識別字，不是字串字面量）——i18n 掃描器（scripts/i18n-check.mjs）會把字串字面量裡的中文當成「沒包 t()」。所以 LUNAR_DAY 不能用 '初' + c 組出來。

// ---- 詞素表：CWA 天氣現象詞 ----
export const WX_SKY = { 晴: 'clear', 多雲: 'cloudy', 陰: 'overcast' }
// 修飾詞：[排序, 英文]（英文語序固定為 occasional → local → brief → 時段）；有 只是連接詞，不出英文
export const WX_MOD = {
  有: [0, ''], 偶爾: [1, 'occasional'], 偶有: [1, 'occasional'], 局部: [2, 'local'], 短暫: [3, 'brief'], 午後: [4, 'afternoon'],
  下午: [4, 'afternoon'], 上午: [4, 'morning'], 傍晚: [4, 'evening'], 晚間: [4, 'evening'], 夜間: [4, 'overnight'], 清晨: [4, 'early-morning'],
}
export const WX_NOUN = {
  雨: 'rain', 陣雨: 'showers', 雷陣雨: 'thundershowers', 雷雨: 'thunderstorms', 大雨: 'heavy rain', 豪雨: 'extremely heavy rain',
  大豪雨: 'torrential rain', 超大豪雨: 'extremely torrential rain', 毛毛雨: 'drizzle', 雪: 'snow', 冰雹: 'hail', 霧: 'fog',
  靄: 'mist', 霾: 'haze', 煙霧: 'smoky haze',
}

// ---- 詞素表：農曆 ----
export const LUNAR_MONTH = { 正: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12, 臘: 12, 冬: 11 }
export const LUNAR_DAY = {
  初一: 1, 十一: 11, 廿一: 21, 二十一: 21, 初二: 2, 十二: 12, 廿二: 22, 二十二: 22, 初三: 3,
  十三: 13, 廿三: 23, 二十三: 23, 初四: 4, 十四: 14, 廿四: 24, 二十四: 24, 初五: 5, 十五: 15,
  廿五: 25, 二十五: 25, 初六: 6, 十六: 16, 廿六: 26, 二十六: 26, 初七: 7, 十七: 17, 廿七: 27,
  二十七: 27, 初八: 8, 十八: 18, 廿八: 28, 二十八: 28, 初九: 9, 十九: 19, 廿九: 29, 二十九: 29,
  初十: 10, 二十: 20, 廿: 20, 三十: 30, 卅: 30,
}
