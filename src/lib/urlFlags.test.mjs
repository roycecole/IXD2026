import test from 'node:test'
import assert from 'node:assert/strict'
import { flagOn } from './urlFlags.js'
import { resolveAutoIdle, isAudienceSearch } from './tour.js'

test('flagOn：有出現就開；0 / false / off / no（不分大小寫）明確關閉；沒有這個參數 = 關', () => {
  for (const s of ['?kiosk', '?kiosk=1', '?kiosk=true', '?kiosk=on', '?x=1&kiosk=yes', 'kiosk=1']) assert.equal(flagOn(s, 'kiosk'), true, s)
  for (const s of ['?kiosk=0', '?kiosk=false', '?kiosk=OFF', '?kiosk=No', '', '?x=1', '?kiosks=1']) assert.equal(flagOn(s, 'kiosk'), false, s)
  assert.equal(flagOn(undefined, 'kiosk'), false)
})

test('展場旗標一致：?kiosk=0 不再啟用閒置導覽；?audience=0 不再被當成觀眾視窗', () => {
  assert.equal(resolveAutoIdle({ saved: false, search: '?kiosk' }), true)
  assert.equal(resolveAutoIdle({ saved: false, search: '?kiosk=0' }), false)
  assert.equal(resolveAutoIdle({ saved: null, search: '?tour=1&kiosk=0' }), true)     // ?tour 仍優先
  assert.equal(isAudienceSearch('?audience=1'), true)
  assert.equal(isAudienceSearch('?audience=0'), false)
  assert.equal(isAudienceSearch('?audience'), true)
})
