import { useState, useEffect } from 'react'
import { useStore } from '../store/useStore.js'
import { SCENES } from '../timeline/scenes.js'
import { buildShareUrl } from '../lib/share.js'
import { captureCanvas, downloadBlob, shareSnapshot } from '../lib/capture.js'
import { arContext } from '../lib/ar.js'
import { audioToggle, audioState } from '../audio/engine.js'
import { micToggle } from '../audio/mic.js'
import { bleSupported } from '../lib/blemidi.js'
import { describeBoard } from '../lib/describe.js'
import { LS, saveLS } from '../lib/persist.js'

function fmt(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function TopBar({ onConnect, onBle, onInfo, onVK, vkOn, onMulti, multiOn, onAR, arOn }) {
  const rec = useStore((s) => s.rec)
  const midi = useStore((s) => s.midi)
  const startRecording = useStore((s) => s.startRecording)
  const stopRecording = useStore((s) => s.stopRecording)
  const startPlayback = useStore((s) => s.startPlayback)
  const stopPlayback = useStore((s) => s.stopPlayback)
  const clearRec = useStore((s) => s.clearRec)
  const applyScene = useStore((s) => s.applyScene)
  const pushLog = useStore((s) => s.pushLog)

  const [shareMsg, setShareMsg] = useState('')
  const [capPct, setCapPct] = useState(-1)
  const audioOn = useStore((s) => s.audioOn)
  const setAudioOn = useStore((s) => s.setAudioOn)
  const [micOn, setMicOn] = useState(false)
  const overlaysOn = useStore((s) => s.overlays.board || s.overlays.hud || s.overlays.qr)
  const toggleOverlays = useStore((s) => s.toggleOverlays)
  const [hz, setHz] = useState(0)

  // 聲音開啟時每 0.5s 更新根音 Hz 顯示
  useEffect(() => {
    if (!audioOn) return
    const iv = setInterval(() => setHz(audioState.rootHz), 500)
    return () => clearInterval(iv)
  }, [audioOn])

  const recording = rec.mode === 'recording'
  const playing = rec.mode === 'playing'
  const hasRec = rec.count > 0
  const capturing = capPct >= 0

  const doShare = async () => {
    const url = buildShareUrl(useStore.getState().params)
    try { await navigator.clipboard.writeText(url); setShareMsg('已複製分享連結') }
    catch (e) { setShareMsg('複製失敗（見主控台）'); console.log('share url:', url) }
    pushLog('out', '產生分享連結')
    setTimeout(() => setShareMsg(''), 2200)
  }

  const doCapture = () => {
    if (capturing) return
    setCapPct(0)
    pushLog('out', '● 開始錄影（10 秒）')
    captureCanvas({
      seconds: 10,
      getAr: () => arContext(useStore.getState().params), // 實景時錄「相機背景 + 球體」
      onProgress: (el) => setCapPct(Math.round((el / 10) * 100)),
      onDone: (blob, ext, err) => {
        setCapPct(-1)
        if (err || !blob) { pushLog('out', '錄影失敗：' + (err || '無資料')); return }
        downloadBlob(blob, `ixd2026-globe.${ext}`)
        pushLog('out', `■ 錄影完成 → 下載 .${ext}`)
      },
    })
  }

  const doExportLog = () => {
    const text = useStore.getState().exportLogText()
    downloadBlob(new Blob([text || '(空)'], { type: 'text/plain' }), 'ixd2026-log.txt')
    pushLog('out', '匯出 LOG')
  }

  const doShareImage = async () => {
    const st = useStore.getState()
    const rows = describeBoard(st.gov, st.govOption())          // 分享圖帶上目前海況的資料列
    const r = await shareSnapshot({ lines: rows.slice(0, 3).map((x) => `${x.k}｜${x.v}`), ar: arContext(st.params) }) // 實景時連真實背景一起輸出
    if (!r.ok) { setShareMsg('分享失敗：' + r.why); pushLog('out', '分享星球失敗：' + r.why) }
    else if (r.how === 'download') { setShareMsg('已下載分享圖'); pushLog('out', '分享星球 → 下載 PNG') }
    else if (r.how === 'share') pushLog('out', '分享星球 → 系統分享')
    setTimeout(() => setShareMsg(''), 2200)
  }

  return (
    <header className="topbar">
      <div className="transport">
        <button className={'rec' + (recording ? ' on' : '')}
                onClick={() => (recording ? stopRecording() : startRecording())} disabled={playing}>
          {recording ? '■ 停止錄製' : '● 錄製'}
        </button>
        <button onClick={() => (playing ? stopPlayback() : startPlayback())} disabled={recording || !hasRec}>
          {playing ? '❚❚ 停止' : '▶ 播放'}
        </button>
        <button onClick={clearRec} disabled={recording || !hasRec}>⟲ 清除</button>
        <span className="time">{fmt(rec.playhead)} / {fmt(rec.duration)}</span>
      </div>

      <div className="scenes">
        <span className="dim scenes-label">場景</span>
        {SCENES.map((sc, i) => (
          <button key={i} className="scene" title={sc.label} onClick={() => applyScene(sc.params)}>{i}</button>
        ))}
      </div>

      <div className="toolstrip">
      <div className="tools">
        <button onClick={doShare} title="複製分享連結（帶目前參數）">分享</button>
        <button onClick={doShareImage} title="分享星球：擷取此刻的海 → 分享 / 下載圖片">分享星球</button>
        <button className={'conn' + (multiOn ? ' on' : '')} onClick={onMulti} title="多人合奏：手機掃 QR 當遙控器">多人</button>
        <button className={'conn' + (arOn ? ' on' : '')} onClick={onAR} title="AR 實景：相機當背景，球體浮在真實世界；可調背景模糊 / 清澈">實景</button>
        <button className={'conn' + (overlaysOn ? ' on' : '')} aria-pressed={overlaysOn} onClick={toggleOverlays}
                title="顯示 / 隱藏畫布上的資訊面板：資料看板、播放與參數提示、QR（快速鍵 I）">資訊</button>
        <button onClick={doCapture} disabled={capturing} title="錄製球體 10 秒並下載影片">
          {capturing ? `錄影 ${capPct}%` : '錄影'}
        </button>
        <button onClick={doExportLog} title="匯出 IN/OUT LOG 供除錯">匯出LOG</button>
        <button className={'conn' + (vkOn ? ' on' : '')} onClick={onVK} title="虛擬 nanoKONTROL2：無實體裝置也能用滑鼠 / 鍵盤操作">控制器</button>
        <button onClick={onInfo} title="操作說明 / 關於本專案">說明</button>
        <button className={'conn' + (audioOn ? ' on' : '')} data-audio-btn
                onClick={async () => { const on = await audioToggle(); setAudioOn(on); saveLS(LS.audio, on ? 'on' : 'off'); useStore.getState().pushLog('out', on ? `聲音開啟（根音 ${audioState.rootHz}Hz）` : '聲音靜音（之後不再自動開啟）') }}
                title="舒適背景音（Tone.js）：海水高度=根音Hz、清澈=明亮度、洋流=浪速、輝光=空間感、垃圾=失諧、打擊墊=音階">
          {audioOn ? `聲音 ${hz || audioState.rootHz}Hz` : '聲音'}
        </button>
        <button className={'conn' + (micOn ? ' on' : '')}
                onClick={async () => { const on = await micToggle(); setMicOn(on); useStore.getState().pushLog('out', on ? '麥克風開啟：吹氣＝起風' : '麥克風關閉') }}
                title="麥克風＝風：對手機吹氣 → 浪變大。只做即時音量偵測，不錄音、不上傳">
          {micOn ? '風·開' : '麥克風'}
        </button>
        {shareMsg && <span className="toast">{shareMsg}</span>}
      </div>

      <button className={'conn' + (midi.connected ? ' on' : '')} onClick={onConnect}>
        {midi.connected ? '● MIDI 已連線' : '連線 MIDI'}
      </button>
      {bleSupported() && (
        <button className={'conn' + (midi.bleName ? ' on' : '')} onClick={onBle}
                title="藍牙 MIDI（Web Bluetooth）：直接連 BLE-MIDI 控制器 / 鍵盤，不需先在系統配對">
          {midi.bleName ? '● 藍牙 ' + midi.bleName.slice(0, 12) : '藍牙 MIDI'}
        </button>
      )}
      </div>
    </header>
  )
}
