import { create } from 'zustand'
import { PARAMS, PARAM_ORDER, DEFAULT_BINDINGS } from '../params/registry.js'

const LS_KEY = 'ixd2026.bindings'
const clamp01 = (v) => Math.max(0, Math.min(1, v))

function loadBindings() {
  try { const s = localStorage.getItem(LS_KEY); if (s) return JSON.parse(s) } catch (e) {}
  return { ...DEFAULT_BINDINGS }
}
function saveBindings(b) { try { localStorage.setItem(LS_KEY, JSON.stringify(b)) } catch (e) {} }

const initialParams = {}
PARAM_ORDER.forEach((pid) => { initialParams[pid] = PARAMS[pid].value })

export const useStore = create((set, get) => ({
  params: initialParams,
  bindings: loadBindings(),                       // cc(number) -> paramId
  learn: { active: false, target: null, seq: -1 },
  midi: { connected: false, inputs: [], error: null },
  log: [],                                        // { dir:'in'|'out', text }
  timeline: { playing: false, time: 0, duration: 600 },

  setParam: (pid, v) => set((s) => ({ params: { ...s.params, [pid]: clamp01(v) } })),
  applyParams: (partial) => set((s) => {
    const params = { ...s.params }
    for (const k in partial) params[k] = clamp01(partial[k])
    return { params }
  }),

  // ---- MIDI Learn ----
  startLearn: (pid) => set({ learn: { active: true, target: pid, seq: -1 } }),
  startSeqLearn: () => set({ learn: { active: true, target: null, seq: 0 } }),
  cancelLearn: () => set({ learn: { active: false, target: null, seq: -1 } }),

  unbindParam: (pid) => set((s) => {
    const b = { ...s.bindings }
    for (const cc of Object.keys(b)) if (b[cc] === pid) delete b[cc]
    saveBindings(b); return { bindings: b }
  }),

  // 由 useMIDI 呼叫（value01 = 0..1）
  handleCC: (cc, value01) => {
    const st = get()
    const ln = st.learn
    if (ln.active && ln.target != null) {                 // 單一參數 Learn
      const b = { ...st.bindings }
      for (const k of Object.keys(b)) if (b[k] === ln.target) delete b[k]
      b[cc] = ln.target; saveBindings(b)
      set({ bindings: b, learn: { active: false, target: null, seq: -1 } })
      st.pushLog('in', `CC ${cc} ⇄ 綁定 ${PARAMS[ln.target].label}`)
      return
    }
    if (ln.active && ln.seq >= 0) {                        // 依序 Learn
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
    const pid = st.bindings[cc]                            // 一般：控制已綁參數
    if (pid) {
      st.setParam(pid, value01)
      st.pushLog('in', `CC ${cc} = ${Math.round(value01 * 127)} → ${PARAMS[pid].label}`)
    } else {
      st.pushLog('in', `CC ${cc} = ${Math.round(value01 * 127)}（未綁定）`)
    }
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

  // ---- 時間軸 ----
  play: () => set((s) => ({ timeline: { ...s.timeline, playing: true } })),
  pause: () => set((s) => ({ timeline: { ...s.timeline, playing: false } })),
  reset: () => set((s) => ({ timeline: { ...s.timeline, time: 0, playing: false } })),
  setTime: (t) => set((s) => ({ timeline: { ...s.timeline, time: t } })),
}))
