// 網址旗標：?kiosk / ?audience 這類「有出現就開」的開關。?kiosk=0 / false / off / no 明確關閉，
// 其餘（?kiosk、?kiosk=1、?kiosk=true …）都算開——App、導覽、觀眾視窗、場景全部用這一個判斷，不會各說各話。
export function flagOn(search, name) {
  try {
    const v = new URLSearchParams(search || '').get(name)
    return v !== null && !/^(0|false|off|no)$/i.test(v)
  } catch (e) { return false }
}
