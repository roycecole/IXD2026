// 資料層譯名：政府開放資料裡的名稱（水庫 / 海況選項 / 流域 / 縣市 / 月相 / 潮差 / 圖表標籤 / 來源簡稱）。
// 測站名與河川名（stations.list[].n / .r、rivers[].name / .river）是專有名詞，維持原文，不在此列。
// 組詞規則（天氣詞、農曆日期）的詞素表以具名匯出，供 src/i18n/data.js 使用（只有 default 會被併進字典）。

// ---- 詞素表：CWA 天氣現象詞 ----
export const WX_SKY = { 晴: 'clear', 多雲: 'cloudy', 陰: 'overcast' }
// 修飾詞：[排序, 英文]（英文語序固定為 occasional → local → brief → 時段）；'有' 只是連接詞，不出英文
export const WX_MOD = {
  有: [0, ''], 偶爾: [1, 'occasional'], 偶有: [1, 'occasional'], 局部: [2, 'local'], 短暫: [3, 'brief'],
  午後: [4, 'afternoon'], 下午: [4, 'afternoon'], 上午: [4, 'morning'], 傍晚: [4, 'evening'], 晚間: [4, 'evening'], 夜間: [4, 'overnight'], 清晨: [4, 'early-morning'],
}
export const WX_NOUN = {
  雨: 'rain', 陣雨: 'showers', 雷陣雨: 'thundershowers', 雷雨: 'thunderstorms', 大雨: 'heavy rain', 豪雨: 'extremely heavy rain', 大豪雨: 'torrential rain', 超大豪雨: 'extremely torrential rain', 毛毛雨: 'drizzle',
  雪: 'snow', 冰雹: 'hail', 霧: 'fog', 靄: 'mist', 霾: 'haze', 煙霧: 'smoky haze',
}

// ---- 詞素表：農曆 ----
export const LUNAR_MONTH = { 正: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12, 臘: 12, 冬: 11 }
export const LUNAR_DAY = (() => {
  const d = {}
  const n = ['一', '二', '三', '四', '五', '六', '七', '八', '九']
  n.forEach((c, i) => { d['初' + c] = i + 1; d['十' + c] = 11 + i; d['廿' + c] = 21 + i; d['二十' + c] = 21 + i })
  d['初十'] = 10; d['二十'] = 20; d['廿'] = 20; d['三十'] = 30; d['卅'] = 30
  return d
})()

// ---- 潮差：CWA 的 TideRange 只給一個字（大 / 中 / 小 / 長 / 若），顯示時補「潮」----
export const TIDE_RANGE_EN = { 大: 'spring tide', 中: 'mid tide', 小: 'neap tide', 長: 'long tide', 若: 'young tide' }

export default {
  // 水庫
  '翡翠水庫': 'Feitsui Reservoir',
  '石門水庫': 'Shimen Reservoir',
  '德基水庫': 'Deji Reservoir',
  '曾文水庫': 'Zengwen Reservoir',
  '南化水庫': 'Nanhua Reservoir',

  // 海況選項名（ocean.json options[].name）
  '花蓮外海': 'Hualien offshore',
  '揚塵 · 雲林縣': 'Dust · Yunlin County',
  '月亮 · 花蓮': 'Moon · Hualien',

  // 流域（birds / fish 的 basin）
  '淡水河流域': 'Tamsui River basin',
  '曾文溪流域': 'Zengwen River basin',
  '花蓮溪流域': 'Hualien River basin',
  '濁水溪流域': 'Zhuoshui River basin',
  '大甲溪流域': 'Dajia River basin',
  '南化水庫樣點（曾文溪流域）': 'Nanhua Reservoir sites (Zengwen River basin)',
  '大漢溪流域': 'Dahan River basin',
  '新店溪流域': 'Xindian River basin',
  '基隆河流域': 'Keelung River basin',
  '頭前溪流域': 'Touqian River basin',
  '後龍溪流域': 'Houlong River basin',
  '大安溪流域': "Da'an River basin",
  '烏溪流域': 'Wu River basin',
  '北港溪流域': 'Beigang River basin',
  '朴子溪流域': 'Puzi River basin',
  '八掌溪流域': 'Bazhang River basin',
  '急水溪流域': 'Jishui River basin',
  '二仁溪流域': 'Erren River basin',
  '高屏溪流域': 'Gaoping River basin',
  '東港溪流域': 'Donggang River basin',
  '卑南溪流域': 'Beinan River basin',
  '秀姑巒溪流域': 'Xiuguluan River basin',
  '蘭陽溪流域': 'Lanyang River basin',
  '和平溪流域': 'Heping River basin',
  '立霧溪流域': 'Liwu River basin',

  // 縣市（dust.county / moon.county）
  '基隆市': 'Keelung City',
  '臺北市': 'Taipei City', '台北市': 'Taipei City',
  '新北市': 'New Taipei City',
  '桃園市': 'Taoyuan City',
  '新竹市': 'Hsinchu City', '新竹縣': 'Hsinchu County',
  '苗栗縣': 'Miaoli County',
  '臺中市': 'Taichung City', '台中市': 'Taichung City',
  '彰化縣': 'Changhua County',
  '南投縣': 'Nantou County',
  '雲林縣': 'Yunlin County',
  '嘉義市': 'Chiayi City', '嘉義縣': 'Chiayi County',
  '臺南市': 'Tainan City', '台南市': 'Tainan City',
  '高雄市': 'Kaohsiung City',
  '屏東縣': 'Pingtung County',
  '宜蘭縣': 'Yilan County',
  '花蓮縣': 'Hualien County',
  '臺東縣': 'Taitung County', '台東縣': 'Taitung County',
  '澎湖縣': 'Penghu County',
  '金門縣': 'Kinmen County',
  '連江縣': 'Lienchiang County',

  // 月相（moon.js moonPhaseName；標準月相英文）
  '新月': 'New moon',
  '眉月': 'Waxing crescent',
  '上弦月': 'First quarter',
  '盈凸月': 'Waxing gibbous',
  '滿月': 'Full moon',
  '虧凸月': 'Waning gibbous',
  '下弦月': 'Last quarter',
  '殘月': 'Waning crescent',

  // 潮差：全名（大潮 / 中潮…）＋單字（ocean.json 的 series.range 是單字）。
  // 單字是通用的程度詞；顯示潮差請用 tideRangeText()（src/i18n/data.js），它會給 "neap tide"。
  '大潮': 'spring tide', '中潮': 'mid tide', '小潮': 'neap tide', '長潮': 'long tide', '若潮': 'young tide',
  '大': 'Large', '中': 'Medium', '小': 'Small', '長': 'Long', '若': 'Weak',
  '{range}潮': ({ range }) => TIDE_RANGE_EN[range] || `${range} tide`,

  // 乾滿潮事件名（CWA 的 Tide 欄位）
  '滿潮': 'high tide',
  '乾潮': 'low tide',
  '↑滿潮': '↑ High tide',
  '↓乾潮': '↓ Low tide',

  // 序列標籤 / 單位（series.js 規格裡的 label / unit；進流量、潮位來自 ocean.json）
  '進流量': 'Inflow',
  '潮位': 'Tide level',
  '鳥種數': 'Bird species',
  '魚種數': 'Fish species',
  '風速': 'Wind speed',
  '中天仰角': 'Transit altitude',
  '種': 'species',
  '揚塵': 'Dust',
  '月亮': 'Moon',

  // 資料來源簡稱（ocean.json sourceShort 以「 · 」分段翻）
  '水利署': 'WRA',
  '中央氣象署': 'CWA',
  'CWA潮汐': 'CWA tide',
  '水利署 · CWA潮汐 · Open-Meteo': 'WRA · CWA tide · Open-Meteo',
}
