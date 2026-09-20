// HUD 的參數名要存「中文 key」：ParamHUD 每幀依當下語系 t()。
// 若 setHud 先翻成英文再存，ParamHUD 的 t() 只會原樣回傳，淡出途中切語系就不會跟著換（還會把英文字串記成「缺譯」）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadEnDict } from '../../scripts/i18n-check.mjs'
import { registerEn, setLocale, t } from '../i18n/index.js'
import { PARAMS } from '../params/registry.js'
import { hudState, setHud } from './hud.js'

const { dict } = await loadEnDict()
registerEn(dict)

test('setHud 存中文 key，切語系後 t(hudState.label) 跟著當下語系', () => {
  try {
    setLocale('en')
    setHud('seaLevel', 0.5)
    assert.equal(hudState.label, PARAMS.seaLevel.label)      // 仍是中文 key，不是翻好的英文
    assert.equal(t(hudState.label), 'Sea level')
    setLocale('zh')
    assert.equal(t(hudState.label), '海水高度')               // 同一筆 HUD 狀態，切回中文立即變中文
  } finally { setLocale('zh') }
})
