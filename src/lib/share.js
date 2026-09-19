import { PARAM_ORDER } from '../params/registry.js'

const clamp01 = (v) => Math.max(0, Math.min(1, v))

// 參數 → 緊湊 URL 字串：每個參數量化成 1 byte (0-255)，再 base64url。
export function encodeParams(params) {
  let bin = ''
  for (const pid of PARAM_ORDER) bin += String.fromCharCode(Math.round(clamp01(params[pid] ?? 0) * 255))
  try {
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  } catch (e) { return '' }
}

export function decodeParams(str) {
  try {
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'))
    const out = {}
    for (let i = 0; i < PARAM_ORDER.length && i < bin.length; i++) out[PARAM_ORDER[i]] = bin.charCodeAt(i) / 255
    return out
  } catch (e) { return null }
}

export function buildShareUrl(params) {
  const s = encodeParams(params)
  const base = location.origin + location.pathname
  return `${base}?s=${s}`
}
