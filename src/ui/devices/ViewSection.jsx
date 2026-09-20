// 「裝置」面板的「取景」一節：完整（含光暈）/ 填滿（球填滿寬度）。
// 倍率在 lib/cameraFit.js（fitScale 的 mode）、偏好與 ?fit= 解析在 lib/viewPrefs.js、套用在 Scene3D 的 CameraRig；這裡只管選模式與顯示狀態。
// 單選：原生 radio（方向鍵換選項、螢幕閱讀器念「第 N 個，共 2 個」），外層 role="radiogroup"；選了立即生效（CameraRig 下一幀就用新的目標倍率，相機平滑移過去）。
import { useSyncExternalStore } from 'react'
import { useT, T } from '../../i18n/index.js'
import { getViewState, VIEW_MODES } from '../../lib/viewPrefs.js'
import '../../styles/view.css'

// 靜態表：用 T() 標記，顯示時再 t()
const MODE_LABEL = { full: T('完整（含光暈）'), fill: T('填滿（球填滿寬度）') }

// view：可注入（測試用）；預設是全站共用的那一份（與 Scene3D 的 CameraRig 同一個）
export default function ViewSection({ view }) {
  const t = useT()
  const src = view || getViewState()
  const st = useSyncExternalStore(src.subscribe, src.get, src.get)
  const choose = (m) => { src.setMode(m) }

  return (
    <section className="dev-sec view-sec" aria-labelledby="view-title">
      <h3 className="dev-sec-title" id="view-title">{t('取景')}</h3>
      <p className="dev-sec-desc" id="view-desc">{t('手機直式時「填滿」會讓球更大、光暈被邊緣裁掉；寬螢幕沒有差別。')}</p>
      <div className="dev-sec-body">
        <div className="view-opts" role="radiogroup" aria-labelledby="view-title" aria-describedby="view-desc">
          {VIEW_MODES.map((m) => (
            <label key={m} className={'view-opt' + (st.mode === m ? ' on' : '')}>
              {/* 已選中的那個再點一次也要處理（例如網址 ?fit=fill 指定的模式，點它 = 存成偏好），所以 onClick 與 onChange 都接 */}
              <input type="radio" name="view-mode" value={m} checked={st.mode === m} onChange={() => choose(m)} onClick={() => choose(m)} />
              <span>{t(MODE_LABEL[m])}</span>
            </label>
          ))}
        </div>

        {st.enabled
          ? <p className="dev-sec-hint view-current" aria-live="polite">{t('目前取景：{mode}', { mode: t(MODE_LABEL[st.mode]) })}</p>
          : <p className="dev-sec-hint warn view-current" aria-live="polite">{t('本次由網址 ?fit={v} 關閉自動取景（除錯用），球維持預設距離；這裡的選擇只會存成偏好。', { v: st.param })}</p>}
        {st.enabled && (st.override === 'full' || st.override === 'fill') && <p className="dev-sec-hint">{t('本次由網址 ?fit={v} 指定；在這裡選擇會改存為偏好。', { v: st.param })}</p>}
        {st.enabled && st.affects === false && <p className="dev-sec-hint">{t('目前的視窗比例不受影響（兩種取景看起來一樣）。')}</p>}
        {st.enabled && st.affects === true && <p className="dev-sec-hint">{t('目前的視窗比例偏窄：兩種取景的球大小不同。')}</p>}
        <p className="dev-sec-hint">{t('取景偏好只存在這台裝置，不會傳送任何資料。')}</p>
      </div>
    </section>
  )
}
