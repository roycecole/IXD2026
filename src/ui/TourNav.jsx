import { useEffect, useRef, useState } from 'react'
import { useTourStore, setSpeakFromGesture, supportsNarration } from '../lib/tour.js'
import { tourRunner, copyTourLink } from '../services/tourCore.js'
import { useT } from '../i18n/index.js'
import '../styles/tour.css'
import '../styles/tourpresenter.css'

// 導覽員控制列：上一站 / 暫停·繼續 / 下一站 / 複製此站連結 /（瀏覽器有語音合成時）念出字幕。
// 兩處使用同一組：畫面下方的字幕卡（variant="caption"，只有圖示）與面板的導覽卡片（variant="card"，念出字幕多一行文字）。
// 每個按鈕都帶 data-tour-ui（在 tourCore 的 KEEP_SELECTOR 內：按它們不算「操作海」，不會中止導覽）、aria-label、title（含快速鍵）；觸控目標 ≥ 40px（tourpresenter.css）。
// 圖示用內嵌 SVG（不用 emoji）。觀眾視窗（remote）不渲染這個元件。
// 「念出字幕」開關被打開時，setSpeakFromGesture 在「同一個點擊處理器內、任何 await 之前」同步呼叫 narrator.unlock()（iOS 只允許使用者手勢內的第一次 speak）。
const FLASH_MS = 2000   // 「已複製」提示停留時間

const PATHS = {
  prev: <><path d="M6.5 5v14" /><path d="M19 5.5 9 12l10 6.5z" className="fill" /></>,
  next: <><path d="M17.5 5v14" /><path d="M5 5.5 15 12 5 18.5z" className="fill" /></>,
  pause: <><rect x="6" y="5" width="4" height="14" rx="1" className="fill" /><rect x="14" y="5" width="4" height="14" rx="1" className="fill" /></>,
  play: <path d="M7 4.5 20 12 7 19.5z" className="fill" />,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  check: <path d="M5 12.5 9.5 17 19 7.5" />,
  speakOn: <><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" className="fill" /><path d="M15.5 9a4 4 0 0 1 0 6" /><path d="M18 6.5a8 8 0 0 1 0 11" /></>,
  speakOff: <><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" className="fill" /><path d="m16 9.5 5 5M21 9.5l-5 5" /></>,
}
// 字幕卡在 .canvas-wrap 裡，而 .canvas-wrap 的雙擊 = 切換演出模式：連按兩下「下一站」不該把演出模式切掉
const stopDbl = (e) => e.stopPropagation()

function Icon({ name }) {
  return <svg className="tour-ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">{PATHS[name]}</svg>
}

export default function TourNav({ variant = 'caption' }) {
  const t = useT()
  const paused = useTourStore((s) => s.paused)
  const speak = useTourStore((s) => s.speak)
  const index = useTourStore((s) => s.index)
  const [copy, setCopy] = useState('idle')                    // 'idle' | 'ok' | 'fail'
  const [canSpeak] = useState(() => supportsNarration())      // 這個瀏覽器有語音合成才顯示旁白開關
  const timer = useRef(null)
  const alive = useRef(true)
  const clearTimer = () => { if (timer.current != null) { clearTimeout(timer.current); timer.current = null } }

  useEffect(() => {                                           // StrictMode 雙掛載：alive 每次掛載都重設；卸載一定取消計時器
    alive.current = true
    return () => { alive.current = false; clearTimer() }
  }, [])
  useEffect(() => { clearTimer(); setCopy('idle') }, [index])   // 換站：「已複製」提示歸零（它說的是上一站）

  const onPause = () => { if (tourRunner.isPaused()) tourRunner.resume(); else tourRunner.pause() }
  const onCopy = async () => {
    const r = await copyTourLink()
    if (r === 'none' || !alive.current) return
    clearTimer()
    setCopy(r)
    timer.current = setTimeout(() => { timer.current = null; setCopy('idle') }, FLASH_MS)
  }

  const flash = copy === 'ok' ? t('已複製') : copy === 'fail' ? t('複製失敗') : ''
  const status = flash || (paused ? t('已暫停') : '')          // 一直存在的 live region：複製結果、暫停 / 繼續（繼續 = 清空）
  return (
    <div className={'tour-nav tour-nav-' + variant} role="group" aria-label={t('導覽員控制')} data-tour-ui onDoubleClick={stopDbl}>
      <button type="button" className="tour-nb" data-tour-ui aria-label={t('上一站')} title={t('上一站（快速鍵 ←）')} onClick={() => tourRunner.prev()}>
        <Icon name="prev" />
      </button>
      <button type="button" className={'tour-nb' + (paused ? ' on' : '')} data-tour-ui aria-pressed={paused} aria-label={t('暫停講解')}
              title={paused ? t('繼續講解（快速鍵 P）') : t('暫停講解（快速鍵 P）')} onClick={onPause}>
        <Icon name={paused ? 'play' : 'pause'} />
      </button>
      <button type="button" className="tour-nb" data-tour-ui aria-label={t('下一站')} title={t('下一站（快速鍵 →）')} onClick={() => tourRunner.next()}>
        <Icon name="next" />
      </button>
      <button type="button" className={'tour-nb tour-nb-copy' + (copy !== 'idle' ? ' flash ' + copy : '')} data-tour-ui aria-label={t('複製此站連結')}
              title={copy === 'fail' ? t('複製失敗（瀏覽器不允許存取剪貼簿）') : t('複製此站連結：貼給別人，開啟後直接到這一站')} onClick={onCopy}>
        <Icon name={copy === 'ok' ? 'check' : 'link'} />
        {flash && <span className="tour-nb-txt" aria-hidden="true">{flash}</span>}
      </button>
      {canSpeak && (
        <button type="button" className={'tour-nb tour-nb-speak' + (speak ? ' on' : '')} data-tour-ui aria-pressed={speak} aria-label={t('念出字幕')}
                title={t('念出字幕：用語音朗讀每一站的說明')} onClick={() => setSpeakFromGesture(!speak)}>
          <Icon name={speak ? 'speakOn' : 'speakOff'} />
          {variant === 'card' && <span className="tour-nb-txt" aria-hidden="true">{t('念出字幕')}</span>}
        </button>
      )}
      <span className="tour-sr" role="status" aria-live="polite">{status}</span>
    </div>
  )
}
