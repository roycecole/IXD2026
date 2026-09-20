// 手機遙控訊息 → store：訊息一律走 store.input() / handleNote() / 動作——與 MIDI / 滑鼠同一條路徑，
// 因此 Learn、錄製、soft-takeover、HUD 與「資料導覽被輸入中止並還原」對多人來源一樣生效。
// 從 lib/multiplayer.js 抽出來（那個檔案載入 PeerJS 與 import.meta.env，Node 無法測試）。
import { useStore } from '../store/useStore.js'
import { PARAM_ORDER } from '../params/registry.js'
import { touch } from '../store/activity.js'

const ALLOWED_P = new Set(PARAM_ORDER)
const ALLOWED_A = new Set(['spawnWhale', 'spawnDolphin', 'spawnTurtle', 'clearTrash', 'transportPlay', 'transportStop', 'transportRecord'])

// 洋流方向是「兩軸拼成的向量」：多支手機同時傾斜時各寫一軸 → 拼出無人的向量、洋流抖動。
// 以連線為單位做擁有權：最近有動的那支手機擁有洋流向量，其他手機在其靜止 1.5 秒內的 flowX/flowY 一律忽略。
const flowOwner = { src: null, t: 0 }
const FLOW_HOLD_MS = 1500

// 匯出供測試 / 未來其他傳輸層（WebSocket 等）重用。src = 來源連線識別（無則不做擁有權判斷）
export function dispatch(m, src) {
  try {
    if (!m || typeof m !== 'object') return
    const st = useStore.getState()
    if (m.t === 'p' && ALLOWED_P.has(m.pid) && typeof m.v === 'number') {
      if (src != null && (m.pid === 'flowX' || m.pid === 'flowY')) {
        const now = Date.now()
        if (flowOwner.src != null && flowOwner.src !== src && now - flowOwner.t < FLOW_HOLD_MS) return
        flowOwner.src = src; flowOwner.t = now
      }
      st.input(m.pid, Math.max(0, Math.min(1, m.v)))
    } else if (m.t === 'a' && ALLOWED_A.has(m.a)) {
      touch()   // 走帶鍵（播放 / 停止 / 錄製）不經 input()：先算一次人為操作，導覽才會在動作「之前」中止並還原（否則第一下按鍵被還原蓋掉）
      st[m.a]()
    } else if (m.t === 'n' && typeof m.note === 'number') {
      st.handleNote(m.note | 0, Math.max(0.05, Math.min(1, +m.vel || 0.8)))
    }
  } catch (e) {}
}
