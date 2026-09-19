import { create } from 'zustand'
import { PARAMS, PARAM_ORDER, DEFAULT_BINDINGS, ACTION_BINDINGS } from '../params/registry.js'
import { LS, SS, loadLS, saveLS, removeLS, loadSS, saveSS } from '../lib/persist.js'
import { noteQueue } from '../audio/bus.js'

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const perfNow = () => { try { return performance.now() / 1000 } catch (e) { return 0 } }

// ---- 非反應式緩衝：高頻資料放這裡，不進 React state 以免每則訊息觸發重繪 ----
let recBuffer = []           // 錄製事件 { t, pid, value }（依 playhead 遞增 → 天然時間序）
let recParamSet = new Set()  // 播放時「真的被自動化驅動」的參數（t>0 事件），供 soft-takeover 判斷
let takeover = {}            // pid -> { caught:boolean, last:number|null }
let fullLog = loadSS(SS.log, []) // 完整 IN/OUT log（本 session），供匯出除錯

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
  midi: { connected: false, inputs: [], error: null },
  log: [],
  rec: { mode: 'idle', playhead: 0, duration: (savedRec && savedRec.duration) || 0, playIndex: 0, count: recBuffer.length },
  spawns: { whale: 0, dolphin: 0, turtle: 0 },   // 按鈕觸發計數（場景讀取後生成訪客）

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
    noteQueue.push({ note, vel: vel01 })
    if (noteQueue.length > 32) noteQueue.shift()
    st.pushLog('in', `Note ${note} vel ${Math.round(vel01 * 127)} → 事件`)
    st.pushLog('out', `/viz pulse note=${note} power=${vel01.toFixed(2)}`)
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
    set({ rec: { mode: 'recording', playhead: 0, duration: 0, playIndex: 0, count: recBuffer.length } })
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
    set((s) => ({ rec: { ...s.rec, mode: 'playing', playhead: 0, playIndex: 0 } }))
    get().pushLog('out', '▶ 播放錄製')
  },
  tickPlayback: (dt) => set((s) => {
    const r = s.rec
    const ph = r.playhead + dt
    let i = r.playIndex
    const params = { ...s.params }
    while (i < recBuffer.length && recBuffer[i].t <= ph) {
      const e = recBuffer[i]
      // 已被演出者接管的參數不再被錄音覆寫（soft-takeover 保持）
      if (!(takeover[e.pid] && takeover[e.pid].caught)) params[e.pid] = clamp01(e.value)
      i++
    }
    if (ph >= r.duration) { takeover = {}; return { params, rec: { ...r, mode: 'idle', playhead: r.duration, playIndex: i } } }
    return { params, rec: { ...r, playhead: ph, playIndex: i } }
  }),
  stopPlayback: () => { takeover = {}; set((s) => ({ rec: { ...s.rec, mode: 'idle' } })) },
  clearRec: () => {
    recBuffer = []; recParamSet = new Set(); takeover = {}; removeLS(LS.recording)
    set({ rec: { mode: 'idle', playhead: 0, duration: 0, playIndex: 0, count: 0 } })
    get().pushLog('out', '⟲ 已清除錄製')
  },

  // 場景預設（即時套用一組參數）。錄製中改走 input 以便被錄進去。
  applyScene: (partial) => {
    const st = get()
    if (st.rec.mode === 'recording') { for (const k in partial) st.input(k, partial[k]) }
    else st.applyParams(partial)
  },

  // ---- 海洋動作（按鈕觸發）----
  spawnWhale: () => { set((s) => ({ spawns: { ...s.spawns, whale: s.spawns.whale + 1 } })); get().pushLog('out', '鯨魚出現') },
  spawnDolphin: () => { set((s) => ({ spawns: { ...s.spawns, dolphin: s.spawns.dolphin + 1 } })); get().pushLog('out', '海豚出現') },
  spawnTurtle: () => { set((s) => ({ spawns: { ...s.spawns, turtle: s.spawns.turtle + 1 } })); get().pushLog('out', '海龜出現') },
  clearTrash: () => { get().setParam('trashCount', 0); get().pushLog('out', '清除垃圾') },

  // ---- 走帶鍵（實體 transport）----
  transportPlay: () => { const m = get().rec.mode; if (m === 'playing') get().stopPlayback(); else if (m === 'idle') get().startPlayback() },
  transportStop: () => { const m = get().rec.mode; if (m === 'recording') get().stopRecording(); else if (m === 'playing') get().stopPlayback() },
  transportRecord: () => { const m = get().rec.mode; if (m === 'recording') get().stopRecording(); else if (m === 'idle') get().startRecording() },
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
