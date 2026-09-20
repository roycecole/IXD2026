import { create } from 'zustand'
import { PARAMS, PARAM_ORDER, DEFAULT_BINDINGS, ACTION_BINDINGS } from '../params/registry.js'
import { LS, SS, loadLS, saveLS, removeLS, loadSS, saveSS } from '../lib/persist.js'
import { noteQueue } from '../audio/bus.js'
import { padEvents, purifyMeta } from './events.js'
import { setHud } from './hud.js'
import { touch, touchGlow } from './activity.js'
import { bumpStat } from './stats.js'
import { SCENES } from '../timeline/scenes.js'
import { seriesFromOption, seriesFromSurvey, seriesFromDust, seriesFromMoon, automationFor, fishParam } from '../lib/series.js'
import { birdSeasonal, flockCount } from '../lib/birds.js'

// 資料播放中的「資料時刻」資訊（DataHUD / MoonSky 每幀讀取，非反應式）
// 畫布上的資訊面板分三組，各自可關：board=資料看板、hud=播放 / 參數 / 待接管提示（含 AR 調整鈕、聲音提示）、qr=展場掃碼 QR 與統計。
// 網址覆寫（展場 / 錄影用，不寫入偏好）：?hud=0 關 board+hud、?board=0、?qr=0。
const OVERLAY_KEYS = ['board', 'hud', 'qr']
function initOverlays() {
  const narrow = typeof window !== 'undefined' && window.innerWidth <= 820
  const o = { board: !narrow, hud: true, qr: true }
  const saved = loadLS(LS.overlays, null)
  if (saved && typeof saved === 'object') OVERLAY_KEYS.forEach((k) => { if (typeof saved[k] === 'boolean') o[k] = saved[k] })
  else { const legacy = loadLS(LS.board, null); if (legacy != null) o.board = !!legacy }
  try {
    const q = new URLSearchParams(location.search)
    if (q.get('hud') === '0') { o.board = false; o.hud = false }
    if (q.get('board') === '0') o.board = false
    if (q.get('qr') === '0') o.qr = false
  } catch (e) {}
  return o
}
let overlaysBeforeHide = null // 「全部隱藏」前的組合，再按一次還原成原樣

export const seriesMeta = { active: false, kind: '', name: '', label: '', unit: '', date: '', step: 1.1, points: [], target: '', extra: {}, lunar: '', lunarLabel: '', range: '', events: [] }

const haptic = (ms) => { try { navigator.vibrate && navigator.vibrate(ms) } catch (e) {} }

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const perfNow = () => { try { return performance.now() / 1000 } catch (e) { return 0 } }

// ---- 非反應式緩衝：高頻資料放這裡，不進 React state 以免每則訊息觸發重繪 ----
let recBuffer = []           // 錄製事件 { t, pid, value }（依 playhead 遞增 → 天然時間序）
let recParamSet = new Set()  // 播放時「真的被自動化驅動」的參數（t>0 事件），供 soft-takeover 判斷
let takeover = {}            // pid -> { caught:boolean, last:number|null }
let fullLog = loadSS(SS.log, []) // 完整 IN/OUT log（本 session），供匯出除錯
let loopSkip = 0             // 循環 wrap 時跳過 t=0 全參數快照（否則手動調整每圈被打回）
let bufferKind = 'user'      // recBuffer 目前裝的是使用者錄製還是資料 series
let stashedRec = null        // 資料播放前暫存的使用者錄製，播完自動還原

// 資料播放結束 → 還原使用者錄製（若有）。回傳要合併進 rec state 的欄位，或 null。
function restoreUserRec() {
  if (bufferKind !== 'series') return null
  bufferKind = 'user'
  const st2 = stashedRec
  stashedRec = null
  recBuffer = st2 ? st2.events : []
  recParamSet = new Set()
  return { duration: st2 ? st2.duration : 0, count: recBuffer.length }
}

// ---- 載入上次保存 ----
const savedRec = loadLS(LS.recording, null)
if (savedRec && Array.isArray(savedRec.events)) recBuffer = savedRec.events

const savedParams = loadLS(LS.params, null)
const initialParams = {}
PARAM_ORDER.forEach((pid) => {
  initialParams[pid] = savedParams && typeof savedParams[pid] === 'number' ? clamp01(savedParams[pid]) : PARAMS[pid].value
})

function loadBindings() { const b = loadLS(LS.bindings, null); return b && typeof b === 'object' ? b : { ...DEFAULT_BINDINGS } }
function saveBindings(b) { saveLS(LS.bindings, b) }

export const useStore = create((set, get) => ({
  params: initialParams,
  bindings: loadBindings(),                     // cc(number) -> paramId
  learn: { active: false, target: null, seq: -1 },
  midi: { connected: false, inputs: [], error: null, bleName: null },
  log: [],
  rec: { mode: 'idle', playhead: 0, duration: (savedRec && savedRec.duration) || 0, playIndex: 0, count: recBuffer.length, speed: 1, loop: false },
  spawns: { whale: 0, dolphin: 0, turtle: 0, purify: 0 },   // 按鈕觸發計數（場景讀取後生成訪客 / 淨化波）
  gov: null,                                     // 真實海況資料快照（public/data/ocean.json）
  govOptionId: null,                             // 目前選擇的水庫海況
  surveyMonth: null,                             // 鳥 / 魚調查的季節：null=現實月份，0..11=手動預覽該月（展場示範用）
  surveyLink: { birds: true, fish: false, ...loadLS(LS.surveyLink, {}) }, // 鳥 / 魚數量參數是否「連動」調查資料（手動調參數會自動脫鉤 = 獨立控制）
  audioOn: false,                                // 背景音是否開啟（預設：第一次使用者手勢時自動開；使用者靜音後記住）
  setAudioOn: (on) => set({ audioOn: !!on }),
  overlays: initOverlays(),                      // 畫布上的資訊面板顯示狀態（見 initOverlays）
  setOverlay: (k, v) => {
    if (!OVERLAY_KEYS.includes(k)) return
    const o = { ...get().overlays, [k]: !!v }
    saveLS(LS.overlays, o); set({ overlays: o })
  },
  toggleOverlays: () => {                        // 主控開關：任一顯示中 → 全部隱藏；全部隱藏 → 還原 / 全開
    const cur = get().overlays
    const any = OVERLAY_KEYS.some((k) => cur[k])
    let next
    if (any) { overlaysBeforeHide = { ...cur }; next = { board: false, hud: false, qr: false } }
    else next = overlaysBeforeHide && OVERLAY_KEYS.some((k) => overlaysBeforeHide[k]) ? overlaysBeforeHide : { board: true, hud: true, qr: true }
    saveLS(LS.overlays, next); set({ overlays: next })
    get().pushLog('out', '畫面資訊面板：' + (any ? '隱藏' : '顯示'))
  },

  // ---- 參數 ----
  setParam: (pid, v) => set((s) => ({ params: { ...s.params, [pid]: clamp01(v) } })),
  applyParams: (partial) => set((s) => {
    const params = { ...s.params }
    for (const k in partial) if (k in params) params[k] = clamp01(partial[k])
    return { params }
  }),

  // 人為輸入入口（MIDI / 滑鼠 / 滑桿）：套用參數，錄製中時寫入事件緩衝。
  // 播放中對「被自動化」的參數手動輸入 → 立即登記接管（caught），配合 tickPlayback 跳過覆寫。
  input: (pid, v) => {
    const st = get()
    if (st.rec.mode === 'playing' && recParamSet.has(pid)) {
      const t = takeover[pid] || (takeover[pid] = { caught: false, last: null })
      t.caught = true
    }
    st.setParam(pid, v)
    setHud(pid, clamp01(v)); touch()   // 參數 HUD + 活動時間戳
    if (pid === 'glow') touchGlow()    // 手動調輝光 → AR 環境光自動調輝光暫停 8 秒
    if (pid === 'birdCount' || pid === 'fishCount') {   // 手動調鳥 / 魚數量 → 脫鉤（獨立控制），要再連動請按「套用 / 連動」
      const k = pid === 'birdCount' ? 'birds' : 'fish'
      if (st.surveyLink[k]) { const l = { ...st.surveyLink, [k]: false }; saveLS(LS.surveyLink, l); set({ surveyLink: l }) }
    }
    if (st.rec.mode === 'recording') recBuffer.push({ t: st.rec.playhead, pid, value: clamp01(v) })
  },

  // ---- MIDI Learn ----
  startLearn: (pid) => set({ learn: { active: true, target: pid, seq: -1 } }),
  startSeqLearn: () => set({ learn: { active: true, target: null, seq: 0 } }),
  cancelLearn: () => set({ learn: { active: false, target: null, seq: -1 } }),
  unbindParam: (pid) => set((s) => {
    const b = { ...s.bindings }
    for (const cc of Object.keys(b)) if (b[cc] === pid) delete b[cc]
    saveBindings(b); return { bindings: b }
  }),

  handleCC: (cc, value01) => {
    const st = get()
    touch()
    const ln = st.learn
    if (ln.active && ln.target != null) {                    // 單一參數 Learn
      const b = { ...st.bindings }
      for (const k of Object.keys(b)) if (b[k] === ln.target) delete b[k]
      b[cc] = ln.target; saveBindings(b)
      set({ bindings: b, learn: { active: false, target: null, seq: -1 } })
      st.pushLog('in', `CC ${cc} ⇄ 綁定 ${PARAMS[ln.target].label}`)
      return
    }
    if (ln.active && ln.seq >= 0) {                          // 依序 Learn
      const pid = PARAM_ORDER[ln.seq]
      if (pid) {
        const b = { ...st.bindings }
        for (const k of Object.keys(b)) if (b[k] === pid) delete b[k]
        b[cc] = pid; saveBindings(b)
        const next = ln.seq + 1
        const done = next >= PARAM_ORDER.length
        set({ bindings: b, learn: done ? { active: false, target: null, seq: -1 } : { active: true, target: null, seq: next } })
        st.pushLog('in', `CC ${cc} ⇄ ${PARAMS[pid].label}${done ? '（依序完成）' : ''}`)
      }
      return
    }

    // 按鈕動作（鯨魚 / 海豚 / 海龜 / 清除垃圾）：按下觸發
    const action = ACTION_BINDINGS[cc]
    if (action) { if (value01 > 0.5) { const fn = st[action]; if (fn) fn() } return }

    const pid = st.bindings[cc]
    if (!pid) { st.pushLog('in', `CC ${cc} = ${Math.round(value01 * 127)}（未綁定）`); return }

    // soft-takeover：僅在「播放錄製」且此參數正被自動化驅動時啟用。
    if (st.rec.mode === 'playing' && recParamSet.has(pid)) {
      const cur = st.params[pid]
      let to = takeover[pid]
      if (!to) { to = { caught: false, last: null }; takeover[pid] = to }
      if (!to.caught) {
        const eps = 0.03
        const crossed =
          Math.abs(value01 - cur) <= eps ||
          (to.last != null && Math.sign(value01 - cur) !== Math.sign(to.last - cur))
        if (crossed) {
          to.caught = true
        } else {
          to.last = value01
          st.pushLog('in', `CC ${cc} 待接管 ${PARAMS[pid].label}（soft-takeover）`)
          return
        }
      }
    }

    st.input(pid, value01)
    st.pushLog('in', `CC ${cc} = ${Math.round(value01 * 127)} → ${PARAMS[pid].label}`)
  },

  // 打擊墊 → 資料事件（velocity = 強度）+ 音訊觸發
  handleNote: (note, vel01) => {
    const st = get()
    touch(); haptic(8)
    noteQueue.push({ note, vel: vel01 })
    if (noteQueue.length > 32) noteQueue.shift()
    // 打擊墊 → 視覺事件庫：16 效果 × 4 bank（nanoPAD2 Scene / 音高區段 → bank 改變強度檔位）
    const n = ((note % 64) + 64) % 64
    padEvents.push({ ev: n % 16, bank: Math.floor(n / 16), vel: vel01 })
    if (padEvents.length > 40) padEvents.shift()
    st.pushLog('in', `Note ${note} vel ${Math.round(vel01 * 127)} → 事件`)
    st.pushLog('out', `/viz pad note=${note} power=${vel01.toFixed(2)}`)
  },

  pushLog: (dir, text) => set((s) => {
    fullLog.push({ t: perfNow(), dir, text })
    if (fullLog.length > 2000) fullLog.shift()
    const log = [...s.log, { dir, text }]
    if (log.length > 40) log.shift()
    return { log }
  }),
  exportLogText: () => fullLog.map((l) => `[${(l.t || 0).toFixed(2)}s][${l.dir.toUpperCase()}] ${l.text}`).join('\n'),
  persistLog: () => saveSS(SS.log, fullLog),
  persistParams: () => saveLS(LS.params, get().params),

  setMidi: (m) => set((s) => ({ midi: { ...s.midi, ...m } })),

  // ---- 錄製 / 播放（參數自動化）----
  startRecording: () => {
    if (get().rec.mode === 'playing') return // 防禦：播放中不可開錄，避免摧毀既有錄製
    recBuffer = PARAM_ORDER.map((pid) => ({ t: 0, pid, value: get().params[pid] })) // t=0 快照全部
    bufferKind = 'user'; stashedRec = null
    seriesMeta.active = false
    bumpStat('recs')
    set((s) => ({ rec: { ...s.rec, mode: 'recording', playhead: 0, duration: 0, playIndex: 0, count: recBuffer.length } }))
    get().pushLog('out', '● 開始錄製')
  },
  stopRecording: () => {
    const dur = get().rec.playhead
    saveLS(LS.recording, { events: recBuffer, duration: dur })
    get().pushLog('out', `■ 錄製結束（${recBuffer.length} 事件）`)
    set((s) => ({ rec: { ...s.rec, mode: 'idle', duration: dur, count: recBuffer.length } }))
  },
  advanceRec: (dt) => set((s) => ({ rec: { ...s.rec, playhead: s.rec.playhead + dt } })),

  startPlayback: () => {
    if (!recBuffer.length) return
    // 只把「錄製過程中真的被改動」的參數列入自動化集合（t>0），soft-takeover 才不會誤鎖靜態參數
    recParamSet = new Set(recBuffer.filter((e) => e.t > 0).map((e) => e.pid))
    takeover = {}
    loopSkip = recBuffer.findIndex((e) => e.t > 0)
    if (loopSkip < 0) loopSkip = recBuffer.length
    bumpStat('plays')
    set((s) => ({ rec: { ...s.rec, mode: 'playing', playhead: 0, playIndex: 0 } }))
    get().pushLog('out', '▶ 播放錄製')
  },
  setRecSpeed: (v) => set((s) => ({ rec: { ...s.rec, speed: v } })),
  toggleRecLoop: () => set((s) => ({ rec: { ...s.rec, loop: !s.rec.loop } })),
  tickPlayback: (dt) => set((s) => {
    const r = s.rec
    const ph = r.playhead + dt * (r.speed || 1)
    let i = r.playIndex
    const params = { ...s.params }
    while (i < recBuffer.length && recBuffer[i].t <= ph) {
      const e = recBuffer[i]
      // 已被演出者接管的參數不再被錄音覆寫（soft-takeover 保持）
      if (!(takeover[e.pid] && takeover[e.pid].caught)) params[e.pid] = clamp01(e.value)
      i++
    }
    if (ph >= r.duration) {
      // 循環：跳過 t=0 全參數快照重播（手動調整才不會每圈被打回），接管狀態保留
      if (r.loop && recBuffer.length) return { params, rec: { ...r, playhead: 0, playIndex: loopSkip } }
      takeover = {}; seriesMeta.active = false
      const rest = restoreUserRec() // 資料播放結束 → 還原使用者錄製
      if (rest) return { params, rec: { ...r, mode: 'idle', playhead: 0, playIndex: 0, ...rest } }
      return { params, rec: { ...r, mode: 'idle', playhead: r.duration, playIndex: i } }
    }
    return { params, rec: { ...r, playhead: ph, playIndex: i } }
  }),
  stopPlayback: () => {
    takeover = {}; seriesMeta.active = false
    const rest = restoreUserRec()
    set((s) => ({ rec: { ...s.rec, mode: 'idle', ...(rest ? { playhead: 0, playIndex: 0, ...rest } : {}) } }))
  },
  clearRec: () => {
    recBuffer = []; recParamSet = new Set(); takeover = {}; bufferKind = 'user'; stashedRec = null; removeLS(LS.recording)
    set((s) => ({ rec: { ...s.rec, mode: 'idle', playhead: 0, duration: 0, playIndex: 0, count: 0 } }))
    get().pushLog('out', '⟲ 已清除錄製')
  },

  // 場景預設（即時套用一組參數）。錄製中走 input 以便被錄進去；
  // 播放中也走 input → 對自動化參數立即登記接管（場景/Marker 鍵才不會被下一批事件蓋回）。
  applyScene: (partial) => {
    const st = get()
    if (st.rec.mode !== 'idle') { for (const k in partial) st.input(k, partial[k]) }
    else st.applyParams(partial)
  },

  // ---- 海洋動作（按鈕觸發）----
  spawnWhale: () => { touch(); haptic(18); set((s) => ({ spawns: { ...s.spawns, whale: s.spawns.whale + 1 } })); get().pushLog('out', '鯨魚出現') },
  spawnDolphin: () => { touch(); haptic(14); set((s) => ({ spawns: { ...s.spawns, dolphin: s.spawns.dolphin + 1 } })); get().pushLog('out', '海豚出現') },
  spawnTurtle: () => { touch(); haptic(14); set((s) => ({ spawns: { ...s.spawns, turtle: s.spawns.turtle + 1 } })); get().pushLog('out', '海龜出現') },
  // 淨化波：視覺（三環擴散 + 推開垃圾）與聲音（上行琶音）都以 spawns.purify 計數器 + purifyMeta.v 觸發
  purify: (v = 1) => { touch(); purifyMeta.v = Math.max(0.2, Math.min(1, v)); set((s) => ({ spawns: { ...s.spawns, purify: s.spawns.purify + 1 } })) },
  clearTrash: () => { touch(); haptic(10); get().setParam('trashCount', 0); get().purify(1); get().pushLog('out', '清除垃圾 → 淨化波') },

  // ---- 走帶鍵（實體 transport）----
  transportPlay: () => { const m = get().rec.mode; if (m === 'playing') get().stopPlayback(); else if (m === 'idle') get().startPlayback() },
  transportStop: () => { const m = get().rec.mode; if (m === 'recording') get().stopRecording(); else if (m === 'playing') get().stopPlayback() },
  transportRecord: () => { const m = get().rec.mode; if (m === 'recording') get().stopRecording(); else if (m === 'idle') get().startRecording() },

  // ---- 真實海況（政府開放資料 · 多海況可選）----
  setGov: (d) => set({ gov: d, govOptionId: d && (d.defaultOption || (d.options && d.options[0] && d.options[0].id)) }),
  govOption: () => { const g = get().gov; if (!g) return null; if (g.options) return g.options.find((o) => o.id === get().govOptionId) || g.options[0]; return { params: g.params, name: g.sourceShort } },
  setGovOption: (id) => { set({ govOptionId: id }); get().applyGov() },
  applyGov: () => {
    const o = get().govOption()
    if (o && o.params) {
      get().applyParams(o.params)
      get().pushLog('out', `套用海況：${o.name || '真實資料'}`)
      get().applySurveyLinked()   // 鳥 / 魚數量：連動中的才由調查資料決定；已脫鉤（獨立控制）的保持使用者的值
    }
  },

  // ---- 鳥 / 魚調查資料（水利署）：資料建議值、套用、連動 ----
  // 建議值＝該流域年度物種數基準 × 現實（或預覽）月份的相對豐度；不寫入。UI 用它顯示「資料 → 建議」並提供「套用」。
  surveySuggest: (kind) => {
    const o = get().govOption()
    const d = o && o[kind]
    if (!d) return null
    const mo = get().surveyMonth != null ? get().surveyMonth : new Date().getMonth()
    const season = birdSeasonal(d.monthly, mo)
    const rel = season ? season.rel : 1
    const flocks = kind === 'birds' ? flockCount(d.species, rel) : null
    const value = kind === 'birds' ? flocks / 5 : fishParam(d.species, rel)
    return { kind, month: mo, season, basin: d.basin, species: d.species, flocks, value: Math.round(value * 100) / 100 }
  },
  applySurvey: (kind) => {
    const sg = get().surveySuggest(kind)
    if (!sg) return false
    get().setParam(kind === 'birds' ? 'birdCount' : 'fishCount', sg.value)
    const l = { ...get().surveyLink, [kind]: true }
    saveLS(LS.surveyLink, l); set({ surveyLink: l })
    const nm = kind === 'birds' ? '鳥群' : '魚群'
    get().pushLog('out', `${nm} · ${sg.basin} ${sg.month + 1} 月${sg.season ? ` ${sg.season.value} 種${sg.season.interpolated ? '（內插）' : ''}` : ''} → ${nm}數量 ${sg.value.toFixed(2)}${sg.flocks != null ? `（${sg.flocks} 群）` : ''}`)
    return true
  },
  applySurveyLinked: () => { const l = get().surveyLink; for (const k of ['birds', 'fish']) if (l[k]) get().applySurvey(k) },
  setSurveyLink: (kind, on) => {
    if (on) { get().applySurvey(kind); return }        // 開啟連動 = 立刻套用資料值
    const l = { ...get().surveyLink, [kind]: false }; saveLS(LS.surveyLink, l); set({ surveyLink: l })
  },
  setSurveyMonth: (m) => { set({ surveyMonth: m }); get().applySurveyLinked() },

  // ---- 資料播放：把時間序列（進流量 / 潮汐 / 揚塵歷史 / 魚鳥調查年表 / 月出月沒）轉成自動化事件 → 走既有播放引擎 ----
  // 播放中一樣支援倍速 / 循環 / soft-takeover 即時接手；結束後自動還原使用者原本的錄製。
  playSeries: (spec, o) => {
    const st = get()
    if (st.rec.mode !== 'idle' || !spec || !spec.points || !spec.points.length) return false
    if (o && o.params) st.applyParams(o.params) // 先落在該海況基準
    if (bufferKind === 'user' && recBuffer.length) stashedRec = { events: recBuffer, duration: st.rec.duration } // 暫存使用者錄製，播完還原
    bufferKind = 'series'
    recBuffer = PARAM_ORDER.map((pid) => ({ t: 0, pid, value: get().params[pid] }))
    spec.points.forEach((p, i) => {
      const t = i * spec.step + 0.001
      for (const [pid, value] of automationFor(spec, i)) recBuffer.push({ t, pid, value })
    })
    const ex = spec.extra || {}
    Object.assign(seriesMeta, {
      active: true, kind: spec.kind, name: spec.name, label: spec.label, unit: spec.unit || '', date: spec.date || '', step: spec.step, points: spec.points,
      target: spec.target || '', extra: ex, lunar: ex.lunar || '', lunarLabel: ex.lunarLabel || '', range: ex.range || '', events: ex.events || [],
    })
    set((s) => ({ rec: { ...s.rec, mode: 'idle', playhead: 0, playIndex: 0, duration: spec.points.length * spec.step, count: recBuffer.length } }))
    get().startPlayback()
    get().pushLog('out', `▶ 資料播放：${spec.name} ${spec.date || ''} ${spec.label}（${spec.points.length} 筆${spec.unit ? '，' + spec.unit : ''}）`)
    return true
  },
  playGovSeries: () => { const o = get().govOption(); const spec = seriesFromOption(o); if (spec) get().playSeries(spec, o) },
  playSurvey: (kind) => { const o = get().govOption(); const spec = seriesFromSurvey(o, kind); if (spec) get().playSeries(spec, o) },
  playDust: () => { const g = get().gov; const o = get().govOption(); const spec = seriesFromDust(g && g.dust, '揚塵'); if (spec) get().playSeries(spec, o) },
  playMoon: () => { const g = get().gov; const o = get().govOption(); const spec = seriesFromMoon(g && g.moon); if (spec) get().playSeries(spec, o) },

  // ---- 場景切換 / Marker 快照（nanoKONTROL2 Track ◀▶ / Marker 鍵）----
  sceneIdx: 0,
  markers: loadLS(LS.markers, []),
  markerIdx: -1,
  scenePrev: () => { const i = (get().sceneIdx - 1 + SCENES.length) % SCENES.length; set({ sceneIdx: i }); get().applyScene(SCENES[i].params); get().pushLog('out', `場景 ◀ ${SCENES[i].label}`) },
  sceneNext: () => { const i = (get().sceneIdx + 1) % SCENES.length; set({ sceneIdx: i }); get().applyScene(SCENES[i].params); get().pushLog('out', `場景 ▶ ${SCENES[i].label}`) },
  markerSet: () => {
    const m = [...get().markers, { ...get().params }].slice(-8) // 最多 8 組
    saveLS(LS.markers, m); set({ markers: m, markerIdx: m.length - 1 })
    touch(); get().pushLog('out', `Marker 快照 #${m.length}（共 ${m.length} 組）`)
  },
  markerPrev: () => { const m = get().markers; if (!m.length) return; const i = (get().markerIdx - 1 + m.length) % m.length; set({ markerIdx: i }); get().applyScene(m[i]); get().pushLog('out', `Marker ◀ 快照 #${i + 1}`) },
  markerNext: () => { const m = get().markers; if (!m.length) return; const i = (get().markerIdx + 1) % m.length; set({ markerIdx: i }); get().applyScene(m[i]); get().pushLog('out', `Marker ▶ 快照 #${i + 1}`) },
}))

// LED 回饋用：目前「播放中且待接管（soft-takeover 尚未咬合）」的 CC 清單
export function getPendingTakeoverCCs() {
  const st = useStore.getState()
  if (st.rec.mode !== 'playing') return []
  const out = []
  for (const cc of Object.keys(st.bindings)) {
    const pid = st.bindings[cc]
    const to = takeover[pid]
    if (recParamSet.has(pid) && to && !to.caught) out.push(Number(cc))
  }
  return out
}

// 螢幕指示用：待接管的參數 + 實體旋鈕該往哪轉才能咬合
export function getTakeoverHints() {
  const st = useStore.getState()
  if (st.rec.mode !== 'playing') return []
  const out = []
  for (const cc of Object.keys(st.bindings)) {
    const pid = st.bindings[cc]
    const to = takeover[pid]
    if (recParamSet.has(pid) && to && !to.caught) {
      const cur = st.params[pid]
      const dir = to.last == null ? '·' : to.last < cur ? '↑' : '↓'
      out.push({ pid, label: PARAMS[pid].label, dir })
    }
  }
  return out
}
