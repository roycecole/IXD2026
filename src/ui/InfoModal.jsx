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
          <li><b>聲音</b>：按「聲音」開生成式背景音（海水高度＝根音頻率）；「麥克風」對手機吹氣＝起風、拍手＝召喚海豚。</li>
          <li><b>多人合奏</b>：按「多人」秀出 QR，手機掃碼變遙控器——每支手機分到一個聲部（海 / 生態 / 氛圍），滑桿即時跟主畫面同步。</li>
          <li><b>AR 實景</b>：按「實景」用相機當背景，球體浮在真實世界；可調背景模糊與清澈（只影響背景，球體不變）。</li>
          <li><b>Gamepad</b>：接上手把＝左桿洋流方向、右桿自轉 / 海水高度、A/B/X/Y 召喚；手機轉身（指北針）＝洋流轉向。</li>
          <li><b>真實資料</b>：右側選水庫或「花蓮外海（潮汐）」；按「播放 24h 資料」讓球隨真實資料起伏（可倍速、循環，畫面上方顯示資料時刻）。滿庫 / 滿潮 ＝ 海水滿球、液體從球緣溢出。背景銀河濃度＝河川即時水位、球外鳥群＝該流域鳥類調查鳥種數。</li>
          <li><b>分享</b>：「分享」複製帶參數連結、「分享星球」把此刻的海輸出成圖片分享。網址加 <code>?kiosk=1</code> 直接進展場演出模式。</li>
        </ul>

        <h3>海洋生態</h3>
        <p className="modal-p">垃圾變多 → 海水混濁、生物變少、魚群主動繞開垃圾、聲音轉暗調；清除垃圾 → 淨化波擴散、海水清澈、生物回歸、聲音回到明亮的大調。背景還有極慢的晝夜呼吸。</p>

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
