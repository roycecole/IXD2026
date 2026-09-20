// 「裝置」面板的一節：觸覺回饋（總開關、強度、測試、裝置偵測）。
// 實際的觸發在 services/HapticsService.jsx，節奏與節流在 lib/haptics.js；這裡只管設定與偵測結果的顯示。
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useT, T } from '../../i18n/index.js'
import { getHaptics, TEST_SEQUENCE, LEVELS } from '../../lib/haptics.js'
import '../../styles/haptics.css'

// 靜態表：用 T() 標記，顯示時再 t()
const STEP_LABEL = {
  whale: T('鯨魚（長而低）'),
  drip: T('水滴（短而輕）'),
  purify: T('淨化波（漸強）'),
  dolphin: T('海豚（兩下輕點）'),
  turtle: T('海龜（緩慢兩下）'),
  record: T('錄製開始（短、短、長）'),
}
const LEVEL_LABEL = { weak: T('弱'), medium: T('中'), strong: T('強') }

const capsSig = (c) => JSON.stringify([c.vibrate, c.touch, c.reducedMotion, c.pads])

// 偵測結果：gamepadconnected / disconnected 事件 + 每 2 秒輕量重掃（Chrome 要按過手把按鍵才會露出手把；只在面板開著時跑，離開即清除）
function useCaps(hp) {
  const [caps, setCaps] = useState(() => hp.caps())
  const sig = useRef(capsSig(caps))
  useEffect(() => {
    const refresh = () => {
      const c = hp.caps(), s = capsSig(c)
      if (s !== sig.current) { sig.current = s; setCaps(c) }
    }
    refresh()
    window.addEventListener('gamepadconnected', refresh)
    window.addEventListener('gamepaddisconnected', refresh)
    const iv = setInterval(refresh, 2000)
    return () => {
      window.removeEventListener('gamepadconnected', refresh)
      window.removeEventListener('gamepaddisconnected', refresh)
      clearInterval(iv)
    }
  }, [hp])
  return caps
}

export default function HapticsSection() {
  const t = useT()
  const hp = getHaptics()
  const st = useSyncExternalStore(hp.subscribe, hp.getState, hp.getState)
  const caps = useCaps(hp)
  const [playing, setPlaying] = useState(null)   // 測試中的事件名
  const stopRef = useRef(null)
  useEffect(() => () => { if (stopRef.current) { stopRef.current(); stopRef.current = null } }, [])   // 離開面板 → 停止測試與震動

  const noDevice = !caps.vibrate && caps.padRumble === 0
  const runTest = () => {
    if (stopRef.current) { stopRef.current(); stopRef.current = null; setPlaying(null); return }
    stopRef.current = hp.runSequence(TEST_SEQUENCE, {
      onStep: (name) => setPlaying(name),
      onDone: () => { stopRef.current = null; setPlaying(null) },
    })
  }

  return (
    <section className="dev-sec hap-sec" aria-labelledby="hap-title">
      <h3 className="dev-sec-title" id="hap-title">{t('觸覺回饋')}</h3>
      <p className="dev-sec-desc">{t('不同事件有不同的觸感節奏：鯨魚長而低、水滴短而輕、淨化波漸強、海豚兩下輕點。手機用震動馬達，手把（Gamepad）用雙震動馬達。')}</p>
      <div className="dev-sec-body">
        <label>
          <input type="checkbox" checked={st.enabled} onChange={(e) => hp.setEnabled(e.target.checked)} />
          {t('啟用觸覺回饋')}
        </label>
        <div className="hap-seg" role="group" aria-label={t('觸覺強度')}>
          {LEVELS.map((l) => (
            <button key={l} type="button" className={st.level === l ? 'on' : ''} aria-pressed={st.level === l} onClick={() => hp.setLevel(l)}>{t(LEVEL_LABEL[l])}</button>
          ))}
        </div>
        <button type="button" className={'hap-test' + (playing ? ' on' : '')} onClick={runTest} disabled={noDevice && !playing} title={noDevice ? t('沒有可用的震動裝置') : undefined}>
          {playing ? t('停止測試') : t('測試觸感')}
        </button>
        <span className="hap-now" role="status" aria-live="polite">{playing ? t('正在播放：{name}', { name: t(STEP_LABEL[playing]) }) : ''}</span>

        <ul className="hap-status">
          <li><span className={'hap-dot' + (caps.vibrate ? ' ok' : '')} aria-hidden="true" />{caps.vibrate ? t('手機震動：支援') : t('手機震動：不支援')}</li>
          <li>
            <span className={'hap-dot' + (caps.padRumble > 0 ? ' ok' : '')} aria-hidden="true" />
            {caps.padCount === 0 ? t('手把：未偵測到（接上後按一下任意按鍵）') : t('手把：偵測到 {n} 支，{m} 支支援震動', { n: caps.padCount, m: caps.padRumble })}
          </li>
        </ul>

        {!caps.vibrate && <p className="dev-sec-hint">{t('這個瀏覽器沒有震動 API（iOS Safari 就是如此），手機震動會靜默略過；可改接手把（Chrome / Edge）體驗觸覺回饋。')}</p>}
        {caps.vibrate && !caps.touch && <p className="dev-sec-hint">{t('這台看起來不是手機或平板，多半沒有震動馬達；接上支援震動的手把即可使用。')}</p>}
        {caps.padCount > 0 && caps.padRumble === 0 && <p className="dev-sec-hint">{t('偵測到的手把不支援震動（目前只有 Chrome / Edge 支援手把震動）。')}</p>}
        {caps.reducedMotion && <p className="dev-sec-hint warn">{t('系統開啟了「減少動態效果」，所以觸覺回饋預設關閉；你仍可手動開啟。')}</p>}
        {st.enabled && noDevice && <p className="dev-sec-hint warn">{t('目前沒有可用的震動裝置，事件會靜默略過。')}</p>}
        <p className="dev-sec-hint">{t('偏好只存在這台裝置，不會傳送任何資料。')}</p>
      </div>
    </section>
  )
}
