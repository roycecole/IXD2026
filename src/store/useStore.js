import { create } from 'zustand'
import { PARAMS, PARAM_ORDER, DEFAULT_BINDINGS } from '../params/registry.js'

const LS_KEY = 'ixd2026.bindings'
const clamp01 = (v) => Math.max(0, Math.min(1, v))

function loadBindings() {
  try { const s = localStorage.getItem(LS_KEY); if (s) return JSON.parse(s) } catch (e) {}
  return { ...DEFAULT_BINDINGS }
}
function saveBindings(b) { try { localStorage.setItem(LS_KEY, JSON.stringify(b)) } catch (e) {} }

// ---- 非反應式緩衝：高頻資料放這裡，不進 React state 以免每則訊息觸發重繪 ----
let recBuffer = []           // 錄製事件 { t, pid, value }（依 playhead 遞增 → 天然時間序）
let recParamSet = new Set()  // 播放時被自動化驅動的參數集合（供 soft-takeover 判斷）
let takeover = {}            // pid -> { caught:boolean, last:number|null }

const initialParams = {}
PARAM_ORDER.forEach((pid) => { initialParams[pid] = PARAMS[pid].value })

export const useStore = create((set, get) => ({
  params: initialParams,
  bindings: loadBindings(),                     // cc(number) -> paramId
  learn: { active: false, target: null, seq: -1 },
  midi: { connected: false, inputs: [], error: null },
  log: [],
  rec: { mode: 'idle', playhead: 0, duration: 0, playIndex: 0, count: 0 }, // mode: idle | recording | playing

  // ---- 參數 ----
  setParam: (pid, v) => set((s) => ({ params: { ...s.params, [pid]: clamp01(v) } })),
  applyParams: (partial) => set((s) => {
    const params = { ...s.params }
    for (const k in partial) params[k] = clamp01(partial[k])
    return { params }
  }),

  // 人為輸入入口（MIDI / 滑鼠 / 滑桿）：套用參數，且錄製中時寫入事件緩衝。
  // 播放（tickPlayback）不走這裡，避免回放又被錄進去。
  input: (pid, v) => {
    const st = get()
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

    const pid = st.bindings[cc]
    if (!pid) { st.pushLog('in', `CC ${cc} = ${Math.round(value01 * 127)}（未綁定）`); return }

    // soft-takeover：僅在「播放錄製」且此參數正被自動化驅動時啟用。
    // 實體旋鈕的值需先「經過」目前畫面值才接管，避免一抓就跳。
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

  // 打擊墊 → 資料事件（velocity = 強度）
  handleNote: (note, vel01) => {
    const st = get()
    st.pushLog('in', `Note ${note} vel ${Math.round(vel01 * 127)} → 事件`)
    st.pushLog('out', `/viz pulse note=${note} power=${vel01.toFixed(2)}`)
  },

  pushLog: (dir, text) => set((s) => {
    const log = [...s.log, { dir, text }]
    if (log.length > 40) log.shift()
    return { log }
  }),
  setMidi: (m) => set((s) => ({ midi: { ...s.midi, ...m } })),

  // ---- 錄製 / 播放（參數自動化）----
  startRecording: () => {
    // t=0 快照全部參數，確保回放能重現起始狀態
    recBuffer = PARAM_ORDER.map((pid) => ({ t: 0, pid, value: get().params[pid] }))
    set({ rec: { mode: 'recording', playhead: 0, duration: 0, playIndex: 0, count: recBuffer.length } })
    get().pushLog('out', '● 開始錄製')
  },
  stopRecording: () => set((s) => {
    get().pushLog('out', `■ 錄製結束（${recBuffer.length} 事件）`)
    return { rec: { ...s.rec, mode: 'idle', duration: s.rec.playhead, count: recBuffer.length } }
  }),
  advanceRec: (dt) => set((s) => ({ rec: { ...s.rec, playhead: s.rec.playhead + dt } })),

  startPlayback: () => {
    if (!recBuffer.length) return
    recParamSet = new Set(recBuffer.map((e) => e.pid))
    takeover = {}
    set((s) => ({ rec: { ...s.rec, mode: 'playing', playhead: 0, playIndex: 0 } }))
    get().pushLog('out', '▶ 播放錄製')
  },
  tickPlayback: (dt) => set((s) => {
    const r = s.rec
    const ph = r.playhead + dt
    let i = r.playIndex
    const params = { ...s.params }
    while (i < recBuffer.length && recBuffer[i].t <= ph) { const e = recBuffer[i]; params[e.pid] = clamp01(e.value); i++ }
    if (ph >= r.duration) { takeover = {}; return { params, rec: { ...r, mode: 'idle', playhead: r.duration, playIndex: i } } }
    return { params, rec: { ...r, playhead: ph, playIndex: i } }
  }),
  stopPlayback: () => { takeover = {}; set((s) => ({ rec: { ...s.rec, mode: 'idle' } })) },
  clearRec: () => {
    recBuffer = []; recParamSet = new Set(); takeover = {}
    set({ rec: { mode: 'idle', playhead: 0, duration: 0, playIndex: 0, count: 0 } })
    get().pushLog('out', '⟲ 已清除錄製')
  },

  // 場景預設（即時套用一組參數）
  applyScene: (partial) => get().applyParams(partial),
}))
