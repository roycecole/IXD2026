// 可拖曳分隔線：axis='x' 改變寬度、axis='y' 改變高度。onDelta 收到每次移動的增量。
export default function Splitter({ axis = 'x', onDelta }) {
  const onPointerDown = (e) => {
    e.preventDefault()
    let last = axis === 'x' ? e.clientX : e.clientY
    const move = (ev) => {
      const cur = axis === 'x' ? ev.clientX : ev.clientY
      onDelta(cur - last)
      last = cur
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.userSelect = ''
    }
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return <div className={'splitter ' + axis} onPointerDown={onPointerDown} title="拖曳改變大小" />
}
