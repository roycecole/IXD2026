const EVENT_URL = 'https://ixda.kktix.cc/events/ixda-member-2026'

export default function InfoModal({ onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>MidiSea 資料導演台</h2>
          <button onClick={onClose} aria-label="關閉">✕</button>
        </div>
        <p className="modal-lead">用 MIDI 控制器（或滑鼠 / 鍵盤 / 手機觸控）演奏一顆透明球體裡的線稿海洋——調海水、召喚鯨豚海龜、清理海洋垃圾，還能錄下整段演出並回放。</p>

        <h3>怎麼玩</h3>
        <ul className="modal-list">
          <li><b>滑鼠</b>：拖曳球體＝旋轉；右側滑桿調參數；點動作鈕召喚生物；<b>雙擊畫面</b>＝演出模式（隱藏介面）。</li>
          <li><b>鍵盤</b>：<code>空白鍵</code> 播放 · <code>R</code> 錄製 · <code>1~4</code> 鯨魚 / 海豚 / 海龜 / 清垃圾 · <code>H</code> 演出模式 · 虛擬控制器上點選後用<code>方向鍵</code>微調。</li>
          <li><b>手機觸控</b>：上下滑＝海水高度 · 兩指縮放＝遠近 · 長按＝魚群聚集 · 傾斜＝水面晃動 · 搖晃＝攪動 · 點擊＝亮星。</li>
          <li><b>MIDI</b>：接上 KORG nanoKONTROL2 按「連線 MIDI」自動對應（推桿 / 旋鈕 / 按鈕 / 走帶鍵＋LED 回饋）。<b>沒有實體裝置</b>可開頂部「控制器」用滑鼠鍵盤操作虛擬 nanoKONTROL2。</li>
          <li><b>聲音</b>：按「聲音」開生成式背景音（海水高度＝根音頻率）；「麥克風」對手機吹氣＝起風。</li>
        </ul>

        <h3>海洋生態</h3>
        <p className="modal-p">垃圾變多 → 海水混濁、生物變少；清除垃圾 → 海水清澈、生物回歸。所有變化平滑連動，聲音也會跟著改變。</p>

        <div className="modal-about">
          <div>本作品為 <b>IxDA Taiwan 2026 會員工作坊「AI 共生黑客鬆」</b></div>
          <div>隊伍：<b>12組 卡加布列島</b></div>
          <a href={EVENT_URL} target="_blank" rel="noopener noreferrer">前往活動頁面 ↗</a>
        </div>

        <button className="modal-start" onClick={onClose}>開始探索</button>
      </div>
    </div>
  )
}
