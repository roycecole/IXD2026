import { useState } from 'react'
import { useStore } from '../store/useStore.js'
import { SCENES } from '../timeline/scenes.js'
import { buildShareUrl } from '../lib/share.js'
import { captureCanvas, downloadBlob } from '../lib/capture.js'

function fmt(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function TopBar({ onConnect }) {
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

  return (
    <header className="topbar">
      <span className="title">資料導演台 <span className="dim">IXD2026</span></span>

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

      <div className="tools">
        <button onClick={doShare} title="複製分享連結（帶目前參數）">分享</button>
        <button onClick={doCapture} disabled={capturing} title="錄製球體 10 秒並下載影片">
          {capturing ? `錄影 ${capPct}%` : '錄影'}
        </button>
        <button onClick={doExportLog} title="匯出 IN/OUT LOG 供除錯">匯出LOG</button>
        {shareMsg && <span className="toast">{shareMsg}</span>}
      </div>

      <button className={'conn' + (midi.connected ? ' on' : '')} onClick={onConnect}>
        {midi.connected ? '● MIDI 已連線' : '連線 MIDI'}
      </button>
    </header>
  )
}
