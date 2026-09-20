// 語音指令（lib/voiceCommands.js）單元測試。執行：node --test src/lib/voiceCommands.test.mjs
// 純函式：正規化、zh / en 指令比對（同義詞、誤辨、簡體、一句多指令、無關句子）、去重與冷卻（interim / final / 累加式逐字稿）、
// 動作對應（假 store，再加一組用真的 useStore 驗證「大浪+氣泡」的 pad 索引）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  COMMANDS, COMMAND_IDS, COOLDOWN_MS, PAD_NOTE_BASE, PAD_FX, CALM_TARGETS, FAST_TARGETS,
  normalize, matchCommands, createCommandTracker, runCommand, padNote, labelOf, heardText, logText, getCommand,
} from './voiceCommands.js'
import { registerEn, setLocale, t } from '../i18n/index.js'
import voiceEn from '../i18n/en/voice.js'
import shellEn from '../i18n/en/ui-shell.js'
import storeEn from '../i18n/en/store.js'

registerEn({ ...shellEn, ...storeEn, ...voiceEn })
const ids = (text, lang = 'zh', opts) => matchCommands(text, lang, opts).map((m) => m.id)

// ---------------------------------------------------------------- 正規化
test('normalize：大小寫、全形 / 半形、標點、空白', () => {
  assert.equal(normalize('ＷＨＡＬＥ！！'), 'whale')                       // 全形英文 + 全形驚嘆號
  assert.equal(normalize('  Big   WAVE,  please. '), 'big wave please')     // 大小寫、標點、連續空白
  assert.equal(normalize('１２３　ｓｔｏｐ'), '123 stop')                   // 全形數字、全形空白
  assert.equal(normalize('鯨魚，大浪！'), '鯨魚大浪')                        // 中文標點 → 空白，中文字之間的空白再移除
  assert.equal(normalize('鯨 魚 大 浪'), '鯨魚大浪')                        // 辨識器在中文字之間塞空白 → 移除
  assert.equal(normalize('鯨魚 whale'), '鯨魚 whale')                       // 中英之間的空白保留（不影響詞界）
  assert.equal(normalize("dolphin's"), 'dolphins')                           // 撇號直接刪
  assert.equal(normalize('It’s a "whale"…'), 'its a whale')
  assert.equal(normalize(null), '')
  assert.equal(normalize(undefined), '')
  assert.equal(normalize('。。。！？'), '')
})

// ---------------------------------------------------------------- 指令表
test('指令表：10 個指令、id 不重複、每個都有 zh / en / 顯示鍵 / 動作', () => {
  assert.deepEqual(COMMAND_IDS, ['whale', 'dolphin', 'turtle', 'bigwave', 'sparkle', 'purify', 'clean', 'calm', 'faster', 'stop'])
  assert.equal(new Set(COMMAND_IDS).size, COMMAND_IDS.length)
  for (const c of COMMANDS) {
    assert.ok(c.zh instanceof RegExp && c.en instanceof RegExp, c.id)
    assert.ok(c.label && c.say && c.fx, c.id)
    assert.ok(c.action && (c.action.call || c.action.pad != null || c.action.move), c.id)
    assert.equal(getCommand(c.id), c)
  }
  assert.equal(getCommand('nope'), null)
})

test('指令表：不使用 lookbehind（舊版 Safari 會整個模組解析失敗）', () => {
  for (const c of COMMANDS) for (const re of [c.zh, c.en]) assert.ok(!/\(\?<[=!]/.test(re.source), `${c.id}: ${re.source}`)
})

// ---------------------------------------------------------------- 中文
const ZH = {
  whale: ['鯨魚', '鯨魚出現', '來一隻鯨魚', '我要看鯨魚', '鲸鱼', '京魚', '驚魚', '金魚', '鯨魚！'],
  dolphin: ['海豚', '海豚出現', '海屯', '海臀', '小海豚'],
  turtle: ['海龜', '海龟', '海歸', '海規', '烏龜', '海龜出現'],
  bigwave: ['大浪', '大浪來了', '巨浪', '大郎', '浪來了', '來個大浪'],
  sparkle: ['亮星', '星星', '閃亮', '亮晶晶', '亮星星'],
  purify: ['淨化', '净化', '進化', '淨化海洋'],
  clean: ['清垃圾', '清理垃圾', '清除垃圾', '青垃圾', '輕垃圾', '清理', '清潔', '掃垃圾', '撿垃圾', '清掃'],
  calm: ['安靜', '平靜', '靜一點', '靜一下', '安靜一點', '安淨', '冷靜', '靜下來', '安静', '静一点'],
  faster: ['快一點', '快點', '加快', '加速', '再快一點', '快一些', '快一点'],
  stop: ['停', '停止', '暫停', '停下來', '停一下', '停！'],
}
for (const [id, phrases] of Object.entries(ZH)) {
  test(`中文「${id}」的各種說法（含誤辨 / 簡體）`, () => {
    for (const p of phrases) assert.deepEqual(ids(p, 'zh'), [id], `「${p}」應只觸發 ${id}，實際：${JSON.stringify(ids(p, 'zh'))}`)
  })
}

test('中文：夾雜空白與標點、辨識器多字', () => {
  assert.deepEqual(ids('請 出現 鯨魚 謝謝', 'zh'), ['whale'])
  assert.deepEqual(ids('鯨 魚', 'zh'), ['whale'])
  assert.deepEqual(ids('，，大浪。。。', 'zh'), ['bigwave'])
  assert.deepEqual(ids('ＷＨＡＬＥ', 'zh'), ['whale'])   // 中文模式下辨識器寫出全形英文，也認得
})

// ---------------------------------------------------------------- 英文
const EN = {
  whale: ['whale', 'Whale!', 'whales', 'a whale', 'the whale', 'show me the whales', 'wale', 'WHALE'],
  dolphin: ['dolphin', 'dolphins', 'a dolphin', 'the dolphin', 'dolphin please', "dolphin's"],
  turtle: ['turtle', 'a turtle', 'the turtles', 'tortoise'],
  bigwave: ['big wave', 'wave', 'a big wave', 'huge waves', 'tsunami', 'waves', 'Big Wave!'],
  sparkle: ['sparkle', 'sparkles', 'stars', 'star', 'twinkle', 'make it sparkle'],
  purify: ['purify', 'purified', 'purification', 'cleanse', 'cleansing'],
  clean: ['clean', 'clean up', 'cleanup', 'clear trash', 'clear the trash', 'clear all the trash', 'clear garbage', 'pick up trash'],
  calm: ['quiet', 'calm', 'peace', 'be quiet', 'calm down', 'shhh', 'hush', 'peaceful', 'quieter'],
  faster: ['faster', 'fast', 'speed up', 'go faster', 'quicker', 'hurry up'],
  stop: ['stop', 'Stop!', 'stopping', 'please stop', 'halt'],
}
for (const [id, phrases] of Object.entries(EN)) {
  test(`英文「${id}」的各種說法（單複數 / 冠詞 / 大小寫）`, () => {
    for (const p of phrases) assert.deepEqual(ids(p, 'en'), [id], `"${p}" should trigger only ${id}, got ${JSON.stringify(ids(p, 'en'))}`)
  })
}

test('英文：en-US 語系字串也認得（lang 只看前綴）', () => {
  assert.deepEqual(ids('whale', 'en-US'), ['whale'])
  assert.deepEqual(ids('鯨魚', 'zh-TW'), ['whale'])
})

// ---------------------------------------------------------------- 一句多個指令
test('一句多個指令：全部觸發，依出現順序', () => {
  assert.deepEqual(ids('鯨魚 大浪', 'zh'), ['whale', 'bigwave'])
  assert.deepEqual(ids('大浪 鯨魚', 'zh'), ['bigwave', 'whale'])
  assert.deepEqual(ids('海豚海龜鯨魚', 'zh'), ['dolphin', 'turtle', 'whale'])
  assert.deepEqual(ids('先安靜再停', 'zh'), ['calm', 'stop'])
  assert.deepEqual(ids('whale and big wave', 'en'), ['whale', 'bigwave'])
  assert.deepEqual(ids('stop the dolphin', 'en'), ['stop', 'dolphin'])
  assert.deepEqual(ids('dolphin, turtle, whale, sparkle', 'en'), ['dolphin', 'turtle', 'whale', 'sparkle'])
  const m = matchCommands('鯨魚 大浪 海豚', 'zh')
  assert.ok(m[0].index < m[1].index && m[1].index < m[2].index)
})

test('同一指令的多種說法重疊時只算一次（亮星星、安靜一點）', () => {
  assert.deepEqual(ids('亮星星', 'zh'), ['sparkle'])
  assert.deepEqual(ids('安靜一點', 'zh'), ['calm'])
  assert.deepEqual(ids('大浪來了', 'zh'), ['bigwave'])
})

test('同一句話說了兩次同一指令：比對會回傳兩個（冷卻由 tracker 處理）', () => {
  assert.deepEqual(ids('鯨魚 鯨魚', 'zh'), ['whale', 'whale'])
  assert.deepEqual(ids('wave wave', 'en'), ['bigwave', 'bigwave'])
})

test('中英混說：另一種語言的詞表也比對（zh-TW 辨識器常把英文詞照拉丁字母寫出來）', () => {
  assert.deepEqual(ids('鯨魚 and big wave', 'zh'), ['whale', 'bigwave'])
  assert.deepEqual(ids('whale', 'zh'), ['whale'])
  assert.deepEqual(ids('鯨魚', 'en'), ['whale'])
  assert.deepEqual(ids('whale', 'zh', { cross: false }), [])
  assert.deepEqual(ids('鯨魚', 'en', { cross: false }), [])
})

// ---------------------------------------------------------------- 不誤觸發
test('無關的中文句子不會觸發', () => {
  for (const s of ['今天天氣很好', '我想去吃飯', '請問洗手間在哪', '這個展覽很有趣', '停車場在哪裡', '停電了', '停留一下',
    '大量的人', '海邊很漂亮', '垃圾桶在哪', '兩星期以後', '星期五', '快樂', '平安', '安全', '清楚', '清晨', '進去', '進步', '冷氣', '',
    '   ', '。。。', '波浪很美', '海鮮', '烏雲', '這是一隻魚']) {
    assert.deepEqual(ids(s, 'zh'), [], `「${s}」不該觸發，實際：${JSON.stringify(ids(s, 'zh'))}`)
  }
})

test('無關的英文句子不會觸發（詞界）', () => {
  for (const s of ['hello there how are you', 'what is the weather today', 'the wavelength is short', 'this is a stopwatch', 'starting the car',
    'I like startups', 'breakfast time', 'quietly', 'fastest', 'cleaner', 'starfish', 'turtleneck', 'dolphinarium', 'whaley', 'peacefully', 'where is the bathroom',
    'thank you', '', '   ', '...']) {
    assert.deepEqual(ids(s, 'en'), [], `"${s}" should not trigger, got ${JSON.stringify(ids(s, 'en'))}`)
  }
})

// ---------------------------------------------------------------- tracker：去重與冷卻
const item = (index, transcript, isFinal = false) => ({ index, transcript, isFinal })
const fired = (tr, items, now) => tr.feed(items, now).map((f) => f.id)

test('去重：interim 逐字長大 → final，同一指令只觸發一次', () => {
  const tr = createCommandTracker({ lang: 'zh' })
  assert.deepEqual(fired(tr, [item(0, '鯨')], 0), ['whale'])            // 低延遲：interim 一出現就觸發
  assert.deepEqual(fired(tr, [item(0, '鯨魚')], 100), [])               // 同一個詞長大
  assert.deepEqual(fired(tr, [item(0, '鯨魚')], 200), [])               // 同樣內容再送一次
  assert.deepEqual(fired(tr, [item(0, '鯨魚', true)], 800), [])         // final
  assert.deepEqual(fired(tr, [item(0, '鯨魚', true)], 900), [])         // final 重複送
})

test('去重：英文 interim → final', () => {
  const tr = createCommandTracker({ lang: 'en-US' })
  assert.deepEqual(fired(tr, [item(0, 'whale')], 0), ['whale'])
  assert.deepEqual(fired(tr, [item(0, 'whale', true)], 600), [])
})

test('interim 旗標：非 final 為 true，final 為 false', () => {
  const tr = createCommandTracker({ lang: 'zh' })
  const a = tr.feed([item(0, '鯨魚')], 0)
  assert.equal(a[0].interim, true)
  const b = tr.feed([item(1, '海豚', true)], 100)
  assert.equal(b[0].interim, false)
  assert.equal(b[0].index, 1)
  assert.equal(b[0].id, 'dolphin')
  assert.equal(b[0].word, '海豚')
})

test('冷卻：同一指令 1.5 秒內只觸發一次，之後又能觸發', () => {
  assert.equal(COOLDOWN_MS, 1500)
  const tr = createCommandTracker({ lang: 'zh' })
  assert.deepEqual(fired(tr, [item(0, '鯨魚', true)], 0), ['whale'])
  assert.deepEqual(fired(tr, [item(1, '鯨魚', true)], 1000), [])         // 冷卻中
  assert.deepEqual(fired(tr, [item(2, '鯨魚', true)], 1499), [])         // 還差 1ms
  assert.deepEqual(fired(tr, [item(3, '鯨魚', true)], 1500), ['whale'])  // 冷卻結束
})

test('冷卻：只算同一指令，不同指令互不影響', () => {
  const tr = createCommandTracker({ lang: 'zh' })
  assert.deepEqual(fired(tr, [item(0, '鯨魚', true)], 0), ['whale'])
  assert.deepEqual(fired(tr, [item(1, '海豚', true)], 100), ['dolphin'])
  assert.deepEqual(fired(tr, [item(2, '鯨魚', true)], 200), [])
})

test('冷卻擋下的出現算「處理過」：冷卻結束後重送同一段不會補發', () => {
  const tr = createCommandTracker({ lang: 'zh' })
  assert.deepEqual(fired(tr, [item(0, '鯨魚 鯨魚')], 0), ['whale'])      // 第二個被冷卻擋下
  assert.deepEqual(fired(tr, [item(0, '鯨魚 鯨魚', true)], 2000), [])   // 2 秒後 final 再送同一段：不補發
})

test('一句多個指令：一次全部觸發、依出現順序；長大時只補新出現的', () => {
  const tr = createCommandTracker({ lang: 'zh' })
  assert.deepEqual(fired(tr, [item(0, '鯨魚')], 0), ['whale'])
  assert.deepEqual(fired(tr, [item(0, '鯨魚 大浪')], 300), ['bigwave'])
  assert.deepEqual(fired(tr, [item(0, '鯨魚 大浪 海豚', true)], 600), ['dolphin'])
  const tr2 = createCommandTracker({ lang: 'zh' })
  assert.deepEqual(fired(tr2, [item(0, '海豚 海龜 鯨魚', true)], 0), ['dolphin', 'turtle', 'whale'])
})

test('內容被修正：前面插字時用「第幾次出現」判斷，不會重發', () => {
  const tr = createCommandTracker({ lang: 'zh' })
  assert.deepEqual(fired(tr, [item(0, '大浪')], 0), ['bigwave'])
  assert.deepEqual(fired(tr, [item(0, '海豚大浪')], 3000), ['dolphin'])   // 大浪的位置往後移了，但它是第 1 次出現 → 已處理
  const tr2 = createCommandTracker({ lang: 'zh' })
  assert.deepEqual(fired(tr2, [item(0, '京魚')], 0), ['whale'])           // 誤辨詞
  assert.deepEqual(fired(tr2, [item(0, '鯨魚')], 3000), [])               // 修正成正確詞：還是同一次
})

test('累加式逐字稿（部分 Android Chrome）：新一段把上一段整句帶進來，不重發舊指令', () => {
  const tr = createCommandTracker({ lang: 'en-US' })
  assert.deepEqual(fired(tr, [item(0, 'whale', true)], 0), ['whale'])
  assert.deepEqual(fired(tr, [item(1, 'whale big wave')], 5000), ['bigwave'])   // 5 秒後：不是冷卻擋的，是繼承了上一段的紀錄
  assert.deepEqual(fired(tr, [item(1, 'whale big wave', true)], 5600), [])
})

test('不是累加式的重複（同一個詞分兩段各說一次）：冷卻過後要能再觸發', () => {
  const tr = createCommandTracker({ lang: 'en-US' })
  assert.deepEqual(fired(tr, [item(0, 'whale', true)], 0), ['whale'])
  assert.deepEqual(fired(tr, [item(1, 'whale', true)], 5000), ['whale'])   // 長度相同，不算「延伸」
})

test('reset()：新 session 清逐段紀錄但保留冷卻；reset({ cooldowns }) 連冷卻一起清', () => {
  const tr = createCommandTracker({ lang: 'zh' })
  assert.deepEqual(fired(tr, [item(0, '鯨魚', true)], 0), ['whale'])
  tr.reset()                                                              // 辨識器重啟，result index 從 0 重來
  assert.deepEqual(fired(tr, [item(0, '鯨魚', true)], 500), [])           // 冷卻仍在
  assert.deepEqual(fired(tr, [item(0, '鯨魚', true)], 2100), [])          // 這一段已處理過（同一個 slot）
  tr.reset()
  assert.deepEqual(fired(tr, [item(0, '鯨魚', true)], 2200), ['whale'])   // 新 session + 冷卻已過
  tr.reset({ cooldowns: true })
  assert.deepEqual(fired(tr, [item(0, '鯨魚', true)], 2300), ['whale'])   // 冷卻也清掉
})

test('自訂冷卻時間；setLang 換主要語言', () => {
  const tr = createCommandTracker({ lang: 'zh', cooldownMs: 300 })
  assert.deepEqual(fired(tr, [item(0, '鯨魚', true)], 0), ['whale'])
  assert.deepEqual(fired(tr, [item(1, '鯨魚', true)], 299), [])
  assert.deepEqual(fired(tr, [item(2, '鯨魚', true)], 300), ['whale'])
  tr.setLang('en-US')
  assert.deepEqual(fired(tr, [item(3, 'dolphin', true)], 400), ['dolphin'])
})

test('tracker 容錯：壞輸入不丟例外；長時間 session 只留最近幾段', () => {
  const tr = createCommandTracker({ lang: 'zh' })
  assert.deepEqual(tr.feed(null, 0), [])
  assert.deepEqual(tr.feed([], 0), [])
  assert.deepEqual(tr.feed([{ index: 0 }, { index: 1, transcript: null }, { index: 2, transcript: '' }], 0), [])
  let n = 0
  for (let i = 0; i < 300; i++) n += tr.feed([item(i, i % 2 ? '海豚' : '海龜', true)], i * 2000).length
  assert.equal(n, 300)   // 每 2 秒一個、輪流兩種指令，全部都該觸發
})

// ---------------------------------------------------------------- 動作
function fakeStore(over = {}) {
  const calls = []
  const st = {
    params: { current: 0.45, swimSpeed: 0.5, trashCount: 0.25, seaLevel: 0.55 },
    spawnWhale: () => calls.push(['spawnWhale']),
    spawnDolphin: () => calls.push(['spawnDolphin']),
    spawnTurtle: () => calls.push(['spawnTurtle']),
    purify: (v) => calls.push(['purify', v]),
    clearTrash: () => calls.push(['clearTrash']),
    transportStop: () => calls.push(['transportStop']),
    handleNote: (n, v) => calls.push(['handleNote', n, v]),
    input: (pid, v) => { calls.push(['input', pid, v]); st.params[pid] = v },
    ...over,
  }
  return { getState: () => st, calls, st }
}

test('動作：鯨魚 / 海豚 / 海龜 / 淨化 / 清垃圾 / 停', () => {
  const s = fakeStore()
  for (const id of ['whale', 'dolphin', 'turtle', 'purify', 'clean', 'stop']) assert.equal(runCommand(id, s), true)
  assert.deepEqual(s.calls, [['spawnWhale'], ['spawnDolphin'], ['spawnTurtle'], ['purify', 0.9], ['clearTrash'], ['transportStop']])
})

test('動作：大浪 = pad「大浪+氣泡」（效果索引 15），亮星 = pad 效果 4；note = 16 + 索引、velocity 0.9', () => {
  assert.equal(PAD_NOTE_BASE, 16)
  assert.deepEqual(PAD_FX, { sparkle: 4, bigwave: 15 })
  const s = fakeStore()
  runCommand('bigwave', s)
  runCommand('sparkle', s)
  assert.deepEqual(s.calls, [['handleNote', 31, 0.9], ['handleNote', 20, 0.9]])
  assert.equal(padNote(15), 31)
})

test('動作：安靜 = current / swimSpeed / trashCount 朝平靜值移動一段（一次性），連說兩次更平靜', () => {
  const s = fakeStore()
  runCommand('calm', s)
  const moved = s.calls.filter((c) => c[0] === 'input')
  assert.deepEqual(moved.map((c) => c[1]), ['current', 'swimSpeed', 'trashCount'])   // 只動這三個
  for (const [, pid, v] of moved) {
    const before = { current: 0.45, swimSpeed: 0.5, trashCount: 0.25 }[pid]
    assert.ok(v < before && v > CALM_TARGETS[pid], `${pid}: ${before} → ${v}（目標 ${CALM_TARGETS[pid]}）`)
  }
  assert.equal(s.st.params.seaLevel, 0.55)                                          // 其他參數不動
  const first = { ...s.st.params }
  runCommand('calm', s)
  for (const pid of Object.keys(CALM_TARGETS)) assert.ok(s.st.params[pid] < first[pid] && s.st.params[pid] > CALM_TARGETS[pid])
})

test('動作：安靜在已經很平靜時不再送 input（不閃 HUD）', () => {
  const s = fakeStore({ params: { current: 0.12, swimSpeed: 0.18, trashCount: 0.05 } })
  runCommand('calm', s)
  assert.deepEqual(s.calls, [])
})

test('動作：快一點 = current / swimSpeed 朝高值移動一段', () => {
  const s = fakeStore()
  runCommand('faster', s)
  const moved = s.calls.filter((c) => c[0] === 'input')
  assert.deepEqual(moved.map((c) => c[1]), ['current', 'swimSpeed'])
  for (const [, pid, v] of moved) assert.ok(v > { current: 0.45, swimSpeed: 0.5 }[pid] && v < FAST_TARGETS[pid])
})

test('動作：未知指令回傳 false；缺少的 store 方法不丟例外', () => {
  const s = fakeStore()
  assert.equal(runCommand('nope', s), false)
  const bare = { getState: () => ({ params: {} }) }
  for (const id of COMMAND_IDS) assert.doesNotThrow(() => runCommand(id, bare), id)
})

test('整合：用真的 useStore 執行，大浪進 padEvents 的 ev=15、亮星 ev=4；鯨魚計數 +1；停止會停掉播放 / 錄製', async () => {
  const { useStore } = await import('../store/useStore.js')
  const { padEvents } = await import('../store/events.js')
  padEvents.length = 0
  runCommand('bigwave', useStore)
  runCommand('sparkle', useStore)
  assert.deepEqual(padEvents.map((e) => e.ev), [15, 4])
  assert.ok(padEvents.every((e) => Math.abs(e.vel - 0.9) < 1e-9))
  const w0 = useStore.getState().spawns.whale
  runCommand('whale', useStore)
  assert.equal(useStore.getState().spawns.whale, w0 + 1)
  const p0 = useStore.getState().spawns.purify
  runCommand('purify', useStore)
  assert.equal(useStore.getState().spawns.purify, p0 + 1)
  useStore.getState().startRecording()
  assert.equal(useStore.getState().rec.mode, 'recording')
  runCommand('stop', useStore)
  assert.equal(useStore.getState().rec.mode, 'idle')
  const c0 = useStore.getState().params.current
  runCommand('calm', useStore)
  assert.ok(useStore.getState().params.current < c0)
  useStore.getState().setParam('trashCount', 0.8)
  runCommand('clean', useStore)
  assert.equal(useStore.getState().params.trashCount, 0)
})

// ---------------------------------------------------------------- 回饋文字
test('回饋文字：聽到：鯨魚 / Heard: whale（多個用頓號 / 逗號）', () => {
  setLocale('zh')
  assert.equal(heardText(['whale']), '聽到：鯨魚')
  assert.equal(heardText(['whale', 'bigwave']), '聽到：鯨魚、大浪')
  assert.equal(logText('calm'), '語音指令：安靜')
  setLocale('en')
  try {
    assert.equal(heardText(['whale']), 'Heard: whale')
    assert.equal(heardText(['whale', 'bigwave', 'clean']), 'Heard: whale, big wave, clear trash')
    assert.equal(logText('calm'), 'Voice command: Calm')
    assert.equal(labelOf('faster'), 'Faster')
  } finally { setLocale('zh') }
  assert.equal(labelOf('nope'), 'nope')
})

test('每個指令的 say / fx / label 英文模式下都有譯文且不含中文', () => {
  setLocale('en')
  try {
    for (const c of COMMANDS) for (const k of [c.label, c.say, c.fx]) {
      const out = t(k)
      assert.ok(!/[㐀-鿿]/.test(out), `${c.id}: ${k} → ${out}`)
    }
  } finally { setLocale('zh') }
})
