# MidiSea Data Director — IXD2026

[繁體中文](./README.md) | **English**

Live: <https://midisea.shyetech.com> · IxDA Taiwan 2026 member workshop "AI Symbiosis Hackathon" · Team 12, Kagabulie Island (卡加布列島)

Play a sphere of sea. With two **KORG nanoKONTROL2 / nanoPAD2** MIDI controllers (or a mouse, touch, a phone remote, a gamepad, camera gestures or your voice) you perform a **3D sphere that has become an ocean**: a calm deep sea inside a transparent shell, with jellyfish, fish schools, whales, dolphins, turtles and floating trash, and a sea that slowly turns into words and numbers. The sea is driven by Taiwan **government open data** (Water Resources Agency and Central Weather Administration; datasets explored through [Twinkle Hub](https://hub.twinkleai.tw/zh-TW)); one extra "Air quality" sea uses **modeled data** from Open-Meteo's CAMS model (not government observations, and always labeled as such on screen). Every parameter can be bound with MIDI Learn, recorded and replayed, shared as a link, and captured as a video. The interface comes in **Traditional Chinese and English**. The first visit opens a step-by-step interactive quick tour, an exhibition that runs all day has safeguards that recover by themselves, and before moving to a new device you can check the hardware item by item with the built-in **device diagnostics page**.

> The core idea: turn abstract, multi-dimensional data into an instrument you can play with both hands.

---

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests + i18n acceptance (node --test)
npm run i18n       # i18n report only: untranslated Chinese literals, missing English keys
npm run build      # produces dist/
```

Open http://localhost:5173 in **desktop Chrome or Edge** and press "Connect MIDI" to grant permission.

> Web MIDI needs Chrome or Edge on localhost or HTTPS. Safari (macOS and iOS) has no Web MIDI, and Firefox needs a separate permission and is untested; see the support matrix below. Embedded browser sandboxes block MIDI permission, so use your own Chrome for real hardware. Without hardware, the "Controller" button at the top gives you a virtual nanoKONTROL2 for mouse and keyboard, and on iPad / iPhone you can use "Jam" and scan the QR code to turn a phone into a remote.
>
> The camera (AR view, camera gestures), the microphone (voice commands) and automatic screen placement all need **HTTPS or localhost**.
>
> Before going on site, or onto a device you have never used, open `?diagnostics=1` (there is also a link in the Devices panel) and run the **device diagnostics page** once to check item by item whether the camera, microphone, speech, vibration, screens and so on work; see "Device diagnostics page".

---

## Features

| Feature | What it does |
|---|---|
| 3D sphere | Three.js / R3F. Transparent shell, procedural waves, sea creatures and flowing text. **Drag with the mouse, or turn a knob, to spin it.** |
| Two languages | The language button at the top (it reads `EN` in Chinese mode and `中文` in English mode) switches the whole interface, logs, data names and share captions. `?lang=en` or `?lang=zh` in the URL picks a language. See "Languages". |
| Parameter panel | Grouped sliders; every parameter can be bound to a CC with **MIDI Learn**. |
| Record / play | Record a whole performance of knob moves and replay it. **Soft-takeover** ("pickup mode") lets a physical knob take over during playback without jumping. |
| Share | Copies a link that carries the data context: `?s=…` (visual settings) plus `&o=` (sea), `&m=` (month), `&sl=` (bird / fish link) and `&lang=` (language). Old links with only `?s=` still open. See "Share". |
| Snapshot | Captures the sea right now as a share card (with the current data rows) → the system share sheet on phones, a PNG download on desktop, with the caption "I played a sea in MidiSea [url]" (the URL is the same context link). **In AR view the real camera background is included**: the camera image is aligned to the canvas with `object-fit: cover` geometry, gets the same background blur / clarity filter, and the transparent WebGL canvas is drawn on top (browsers without `ctx.filter` approximate the blur by scaling). "Rec video" composites frame by frame the same way. |
| Data tour | Press **`T`**, click "Start tour" on the Data tour card, or leave the app idle for 30 seconds. It steps through eight stops (today's reservoir → Hualien tide → moon → Yunlin dust → **air quality (modeled data)** → birds → fish → river-station constellation), with large captions below the sphere explaining from real data what you are looking at and why the sphere looks that way, including honest notes about data limits. A full lap takes about 111 seconds, and touching anything stops it and restores your sea. **Presenter controls**: clickable progress dots to jump between stops, previous / next / pause (keyboard `←` `→` `P`), "Copy link to this stop" (`?tourstop=`), and optional spoken captions. See "Data tour". |
| Quick tour | The first visit opens a 7-step interactive tour (a dimmed overlay, a spotlight and a small card, a sentence or two per step) instead of the long help text that used to pop up on arrival. The full guide still lives behind the Help button, reorganized into "5 quick-start items + 6 collapsed topic sections + an ocean-ecology section", with a "Replay the quick tour" button. `?onboard=0` / `?onboard=1` turn it off / force it on. See "Quick tour, system-event monitor and view fitting". |
| Hideable system-event monitor | The "Input / output monitor (IN performer / OUT system events)" at the bottom can be hidden with the small arrow on its title bar, the "System events" switch in the footer, or the **`L`** key. It is shown by default on desktop and hidden on phones, and your choice is remembered. While hidden, the footer still shows the latest OUT event on one line and the log keeps recording. `?log=1` / `?log=0` override it for one visit only. |
| Automatic view fitting | When the canvas is tall and narrow (for example a phone held upright in full-screen Stage mode) the camera pulls back so the whole sphere is visible; landscape, desktop and near-square canvases keep the framing they always had, unchanged. The zoom slider and pinch zoom keep working; `?fit=0` turns it off. |
| Device diagnostics page | `?diagnostics=1` (there is a link in the Devices panel): 25 quick checks in one press plus 12 interactive checks that only start when you press their own button (camera, microphone, speech, MIDI, gamepad, vibration, pen, sensors, screens, pop-up, fullscreen), with a report you can copy or download. It uploads nothing. See "Device diagnostics page". |
| Exhibition safeguards | When the screen hits an error it counts down and reloads by itself (5 → 15 → 60 s back-off, and after 5 crashes within 10 minutes a circuit breaker stops it), recovers from a lost WebGL context, has a render watchdog, and updates itself to a new build or new data (only when idle); `?reload=HH` reloads once a day. "Devices → Operations" shows the build, crash log and active safeguards. See "Exhibition safeguards and operations". |
| Tap for data source | Tap a gauging-station star, the moon or a bird flock in the background and a card opens beside it with its source, values and status. See "Data source cards and stylus". |
| Stylus | Drag the sphere with an Apple Pencil, Surface Pen or Wacom pen: pressure adds wave energy and pen tilt steers the current (only for `pointerType === 'pen'`; `?pen=0` turns it off). |
| Jam (multiplayer) | Press "Jam" to show a QR code; a phone that scans it becomes a remote (PeerJS WebRTC, short IDs so the QR stays small and easy to scan). Each phone gets a part (Ocean / Life / Mood / Free), and its sliders stay in sync with the main screen every second. **Phone sensors**: once enabled, tilt = current direction and shake = surge (over the same wire protocol). Everything goes through the same `input()` path, so it can be recorded and picked up softly. If the host loses the signalling server it reconnects with the same ID, or rebuilds under a new one if that ID is taken. |
| Devices panel | The "Devices" button at the top gathers the optional device features: **Audience window** (dual screen), **Camera gestures**, **Voice commands**, **Haptics** and **Graphics quality**, plus two sections, **Device diagnostics** (a link to the diagnostics page and the last result) and **Operations** (build, crash log, safeguard status). The camera and microphone are only used while you switch them on, and video and audio are never uploaded. See "Devices panel". |
| Real data | Reservoir water level % **is** the sea level (full reservoir = full sphere; above 97% liquid spills over the rim and leaves a puddle at the bottom). Shimen, Deji and Zengwen come with 24 h inflow, and **Hualien offshore comes with CWA tide** series. Press "Play data" to make the sphere rise and fall with the real data (**speed x0.5–x4, looping**; a HUD at the top shows the data time and values). There are also "**Dust · Yunlin County**", "**Moon · Hualien**" and "**Air quality · Yunlin**" (modeled data) seas; all datasets are listed under "Datasets → visuals" below. |
| Air quality (modeled data) | The "Air quality · Yunlin" sea: hourly PM2.5, PM10 and US AQI at Mailiao, Yunlin County, from the Open-Meteo Air Quality API (CAMS global atmospheric model). **This is modeled data, not government observations** (the amber tag on the data card, the data board and the OUT log all say "model data"). "Play air quality · 120 hours" replays the last 5 days at 0.2 s per hour: the higher the PM2.5, the murkier the sea, the more trash, the more yellow-green the hue and the dimmer the glow. CC BY 4.0: Open-Meteo must be credited (the data card has a link). See "Datasets → visuals". |
| Milky Way × rivers | A band of Milky Way in the background whose density follows the **live river water level from the Water Resources Agency** (5 stations, ratio to the warning level): plenty of water, brighter galaxy. |
| Birds / fish × surveys | The number of line-art bird flocks outside the sphere = the "Bird flocks" parameter (0..1 → 0..5 flocks); fish schools use "Fish schools". The data card shows that basin's **monthly species-count bars** (hatched = interpolated, click a bar to preview a month, the current month is marked) and a suggested value. You can "**Apply data**", turn on "**Link**" (updates when you change sea or month), or drag the slider for "**Independent**" control (dragging unlinks it automatically and the "data" tag on the parameter row disappears). Each basin also has a **survey timeline** you can play: every step is one calendar year, the count follows that year's species count, and years with no survey are marked "no survey" and filled in by interpolation. Note (honest data disclosure): each basin has surveys in only some months / years (each month covers only 1–3 survey years, close to a single-year snapshot rather than a climate average), only months with enough records are kept, and missing months are filled by **circular interpolation** from neighbouring months and marked "interpolated". See "Survey timeline". |
| Moon × tide | With a tide sea, a moon appears in the background: its **phase = that day's moon age (derived from the CWA lunar date, from the same source as the tide)** and its position = a sky arc set by the transit time and the current time (new moon at noon, first quarter at dusk, full moon transiting at midnight). While 24 h of tide plays, the moon really rises and sets, and the HUD shows high / low tide marks, lunar date, tidal range and phase. The separate "**Moon · Hualien**" sea places the moon at its real bearing and altitude using the CWA A-B0063-001 moonrise / transit / moonset times, rise / set **azimuths** and transit **altitude** (idle = today, interpolated to the current time; "Play moonrise & moonset" moves one day per step, showing the moon's position and phase at 21:00 each night; a higher transit raises the sea, which is illustrative). |
| Data board · data in the output | The "Data board" at the top left of the canvas lists the real data behind the current sea and how it is mapped (reservoir / tide / dust / air quality / weather / birds / fish / rivers / stations; off by default on phones). The **OUT monitor** prints "Data …" rows when a sea is applied and a "DATA …" line for **every step** of data playback; the Snapshot image carries the data rows too; the exported log includes them. |
| On-canvas info panels | The info panels on the canvas come in three groups you can hide independently: **Data board**, **Playback & parameter hints** (data playback progress, parameter values, pick-up hints, AR adjustment buttons, sound hints, tour captions, data source cards) and **QR & stats** (Stage mode). The "Info" button at the top, or the **`I`** key, hides / shows them all at once (press again to restore the previous combination); the board has an **×** at its top right; the "Overlays" checkboxes on the data card toggle the three groups; the choice is stored in localStorage. URL overrides `?hud=0` (board + hints), `?board=0` and `?qr=0` are meant for exhibitions and recording and never overwrite the saved preference. Hidden panels are unmounted, so they do not keep animation loops running. The camera and voice "in use" badges are privacy indicators: **they ignore this switch and always show**. |
| Background blur / clarity | Two sliders in "VIEW" (MIDI Learn, recording and phone remote all work): they **only affect the background** (stars / Milky Way / shooting stars / moon / station constellation; in AR view, the camera image) while the sphere and creatures stay sharp. Implementation: the background sits on layer 1 → draw it first → copy the frame → Kawase dual filter (multi-level down / up sampling, close to Gaussian without ghosting sparse stars) → composite back (with clarity) → draw the foreground on top. The default costs nothing extra, and it degrades gracefully when the GPU cannot do it; at Low graphics quality a simple darkening is used instead (see "Graphics quality"). |
| Sound on by default | Browsers only allow audio after a user gesture, so "on by default" means **it starts automatically on your first click / touch / key press** (a hint reads "click anywhere to turn on sound"). After you mute it with "Sound" that choice is remembered. For an unattended exhibition, click once first or start Chrome with `--autoplay-policy=no-user-gesture-required`. |
| Phone UI | ≤820 px: the top bar splits into transport / scene / a **horizontally scrollable toolbar** (no wrapping, touch targets ≥40 px, priority order: Sound → Share → Jam → AR view…), two-row parameter rows (the slider gets its own row), large touch sliders, 16 px `select` (iOS will not zoom in), the input / output monitor is hidden by default (the "Events" switch in the footer opens it, and it then shows only the OUT column), and the canvas defaults to 40%. On desktop, 821–1400 px tightens the spacing to stay on one row. |
| Physical trash | cannon-es rigid bodies: bottles and bags float on the surface, collide, get pushed by the current and **pushed away by the cleansing wave**. |
| AR view | "AR view" uses the camera as the background so the sphere floats in the real world. The **blur / clarity sliders only affect the background** while the sphere renders as usual. **Ambient light sensing**: every 0.6 s the average brightness of the camera image adjusts the sphere's glow automatically (bright surroundings → strong glow, dark → subdued; pausing for 8 s after you adjust glow by hand, and it can be turned off). |
| Marker snapshots | nanoKONTROL2 Track ◀▶ = previous / next scene; Marker Set = store the current state as a snapshot (up to 8), Marker ◀▶ cycles through them. |
| Exhibition mode | `?kiosk=1` goes straight to Stage mode (no help dialog and no quick tour) **with the idle auto data tour on**, plus a **small QR code that stays in the corner** (no dialog needed; visitors scan as they pass; it restarts and redraws on its own after a disconnect or when the machine boots offline) and the stats "Jam N · Plays M". Add `&hud=0` (no info panels), `&qr=0` (no QR) or `&reload=3` (reload once a day at 03:00 when idle). Exhibition mode also turns on the render watchdog and the more frequent version / data checks, see "Exhibition safeguards and operations". Combine it with the **Audience window** in Devices to fill a projector with the same sea (the audience window has the watchdog on by default too). |
| Scene colors | Each scene has its own hue (cyan-blue / purple-pink / teal / murky green / blue-green); waterline, particles, atmosphere and fog shift together, and "Sea hue" is a playable parameter. **Sea color correction**: `setHSL` now reads its values as sRGB (the fourth argument `THREE.SRGBColorSpace`), so the background and fog changed from a washed-out slate to a deep blue sea close to the design (about `#050e1c` at night, `#08162b` by day) and the waterline keeps about 85% of its brightness. At extreme hue values (0 / 1) the background turns dark green / dark plum. |
| Gamepad / compass | Left stick = current direction, right stick = spin and sea level, A/B/X/Y = summon; gamepads can give **rumble feedback** (see "Haptics"); on a phone, turning your body (compass >8°) turns the current. |
| PWA | An "Add to Home Screen" prompt and a "click to update" toast when a new version deploys; works offline. |
| Video recording | Captures the sphere for 10 seconds and downloads **MP4 / WebM** (in AR view: "camera background + sphere"). |
| Export log | Downloads the IN/OUT message log for debugging. |
| Comfort ambient sound | Generative Tone.js ambience: sea level = root note Hz, clarity = brightness, current = wave speed, glow = space, trash = detune, fish × swim speed = accent notes, whales / dolphins / turtles = calls, pads = scale (press "Sound" to turn on). The **cleansing wave → a bright major pentatonic arpeggio** (always major, however murky the sea is), and **overflow (level >97%) → water drips** (random left / right, at most about 3 per second; the schedule times only ever increase, so a high-refresh display can no longer make Tone.js throw "time must be >= last scheduled" and stall the main loop; an error in the audio update is no longer rethrown and the main loop schedules the next frame first). |
| Resizable layout | Drag the splitters to change panel width and monitor height. |
| Responsive | Narrow screens stack vertically and use touch interaction. |
| Local storage | localStorage / sessionStorage remember parameters, bindings, sizes, recordings and logs. |
| AR tabletop (WebXR) | On a phone with WebXR (Chrome on Android, etc.): Devices → AR tabletop → "Place on a table". Find a table with the camera, tap, and a sphere about 28 cm wide sits there; walk around it to see every angle. iOS Safari has no WebXR AR, so use "AR view". **Not yet verified on a real device**, see "Devices panel". |

---

## Controls (nanoKONTROL2 factory defaults)

**6 faders (Slider 1–6, CC0–5)**

| Fader | Effect |
|---|---|
| 1 | Sea level |
| 2 | Current speed |
| 3 | Jellyfish |
| 4 | Fish schools |
| 5 | Trash |
| 6 | Water clarity |

**2 knobs (Knob 1–2, CC16–17)**: spin the sphere / creature swim speed.

**4 buttons (Button 1–4, Solo CC32–35)**: whale / dolphin / turtle / clear trash.

**Transport keys**: ● record start / end, ▶ play / stop, ■ stop, Cycle clears the recording. You never have to touch the mouse during a performance.

**LED feedback** (set LED Mode = External in the KORG Kontrol Editor for the nanoKONTROL2): ● blinks while recording, ▶ lights while playing, ■ lights when ready to play, Cycle blinks in Learn mode, the track's R key blinks while a knob is waiting for pick-up, and trigger keys light for 0.3 s when pressed.

**Bluetooth MIDI (Web Bluetooth)**: the "BLE MIDI" button connects a BLE-MIDI controller or keyboard directly over GATT (no need to pair it in the system first). It shares the `routeMidi` path with USB, so Learn / recording / soft-takeover all work. Supported in Chrome and Edge (desktop and Android); **Safari on iPad / iPhone (and every other iOS browser) has no Web Bluetooth and no Web MIDI**, so on those devices use "Jam" and scan the QR code to make the phone a remote (WebRTC, no Bluetooth needed).

**nanoPAD2 X-Y pad**: X (Pitch Bend) → current direction X (stirs the direction of the waves); Y is unbound by default (click "Current dir Y" → slide the pad to Learn).

**nanoPAD2 pads: 16 effects × 4 banks (= 64 pads)**: `note % 16` picks the effect and `note ÷ 16` picks the intensity level (soft / medium / hard / burst, matching nanoPAD2 scenes or pitch ranges), with velocity as force. Effects: jellyfish pulse / surge / ripple / bubbles / bright star / dolphin / whale / turtle / **cleansing wave** / drop trash / current turn / flash / fish dash / triple ripple / star shower / big wave + bubbles. The virtual controller has the same 16 pads and bank switch.

**Phone touch / sensors**: drag left / right = spin (with inertia), swipe up / down = sea level, pinch = zoom, tap = star burst, **long-press 0.5 s = fish schools gather at your finger**, **tilt = the surface stays level**, **shake = stir the water** (iOS asks for sensor permission on first touch). "Add to Home Screen" gives you a full-screen offline PWA.

> **Ecology**: more trash → murkier water, fewer creatures, **fish schools steer around the trash**, accent notes turn minor; clear the trash → the **cleansing wave** spreads, creatures return and the sound goes back to major. The background also has an extremely slow 4-minute day-and-night cycle.
> If your device uses different CCs: **click a parameter name → turn a knob** to rebind (Learn), or press "Map knobs in order"; `shift+click` unbinds. Buttons also have on-screen action buttons (mouse / touch). Bindings are stored in localStorage.

---

## Keyboard shortcuts

| Key | Action | Notes |
|---|---|---|
| `H` | Stage mode (hide all UI, keep only the sphere); press again to leave | Double-clicking the canvas toggles the same thing |
| `I` | Show / hide the info panels on the canvas (Data board, Playback & parameter hints, QR) | Press again to restore the previous combination |
| `T` | Start / stop the data tour | Ctrl / Cmd / Alt + T does not count |
| `L` | Show / hide the input / output monitor (system events) at the bottom | Ctrl / Cmd / Alt + L does not count; ignored while an input or select has focus, or focus is inside a dialog (Help / Devices / Jam), though a focused button still lets it through; shown by default on desktop and hidden on phones, and remembered once you toggle it. Pressing `L` during a data tour counts as an action and stops the tour and restores your sea |
| `←` `→` `P` | **While a data tour runs**: previous stop / next stop / pause · resume | Only active during a tour and never stops it; holding a key does not skip repeatedly; when a slider (for example a knob on the virtual controller) or an input has focus the key goes to that control |
| `→` / `Enter` · `←` · `Esc` | **While the quick tour is open**: next · back · skip | The tour card is a dialog, so global shortcuts are ignored while focus is inside it; `Tab` cycles only between the card's buttons |
| `?` | Open Help | |
| `Space` | Play / stop playback | When a button has focus, the button keeps its native behavior |
| `R` | Start / stop recording | Same button rule |
| `1` `2` `3` `4` | Whale / dolphin / turtle / clear trash (cleansing wave) | Same button rule |
| `Esc` | Stop the data tour and restore your sea; close a data source card | |
| Arrow keys | Fine-tune a control after selecting it on the virtual controller (±0.05 per press) | |
| `Enter` / `Space` | On a focused parameter name: start MIDI Learn (`Shift` held: unbind) | |

While an input or a select has focus, the global shortcuts are ignored. During a data tour, any key other than `T`, `H`, `I`, `?`, the presenter keys `←` `→` `P`, modifier keys and `Tab` stops the tour and restores your sea (`Esc` ends it).

---

## URL parameters

| Parameter | Value | Effect | Notes |
|---|---|---|---|
| `?s=` | base64url | Visual settings (each parameter quantized to 1 byte, in `PARAM_ORDER`) | Produced by "Share"; the positional encoding must not change because old links depend on it |
| `&o=` | Sea id, e.g. `feitsui`, `shimen`, `deji`, `zengwen`, `nanhua`, `hualien-tide`, `dust-yunlin`, `moon-hualien`, `air-yunlin` | Opens with that sea selected | Unknown ids are ignored |
| `&m=` | `0`–`11` (0 = January) | Survey month previewed by hand | Only included if the sharer picked one |
| `&sl=` | `b0f0`, `b0f1`, `b1f0`, `b1f1` | Whether birds (b) / fish (f) follow the survey data, e.g. `b1f0` = birds linked, fish independent | Applied temporarily; never written to the recipient's saved preferences |
| `?lang=` | `zh` or `en` (case and region codes tolerated, e.g. `en-US`, `zh-TW`) | Interface language | Beats the saved preference and the browser language; not saved; the URL follows when you press the language button |
| `?kiosk=1` | `1` (`0`, `false`, `off`, `no` turn it off) | Exhibition mode: straight to Stage mode, no help dialog, no quick tour, corner QR, idle auto tour on (turn it off with `?tour=0`), render watchdog on | Only `?kiosk=0` / `false` / `off` / `no` switch it off explicitly; every other spelling (`?kiosk`, `?kiosk=1`…) counts as on; the tour, the audience window and the safeguards share one function |
| `?hud=0` | `0` | Hide the Data board and the Playback & parameter hints | For exhibitions and recording; not saved |
| `?board=0` | `0` | Hide only the Data board | Same |
| `?qr=0` | `0` | Hide the exhibition QR and stats | Same |
| `?tour=` | `0` or `1` (`off` / `on` also work) | Force the idle auto tour off / on | Priority: `?tour=` > `?kiosk` > saved preference > default (on) |
| `?audience=1` | `1` | Audience window mode (no controls, no sound, follows the main window) | Normally opened from the button in Devices; opened by hand it waits for a main window; the render watchdog is on by default (a projector stays on all day and nobody notices a freeze; `?watchdog=0` turns it off) |
| `?pen=0` | `0` | Turn off stylus pressure / tilt | No switch in Devices; this parameter is the only way |
| `?fps=1` | `1` | Show a small FPS readout at the bottom left of the canvas (debug) | Without it the canvas shows no FPS at all |
| `?quality=` | `auto`, `high`, `medium`, `low` | Force a graphics quality for this visit | Not saved; choosing in the panel saves a preference |
| `#remote=<id>` | hash (not a query) | Phone remote page (from the "Jam" QR code) | Generated by the main screen |
| `?diagnostics=1` | `1` (`0`, `false`, `off`, `no` turn it off) | Device diagnostics page (a separate page that does not load the 3D scene or the main screen) | The "Open device diagnostics" button in Devices opens it in a new tab; page routing priority: phone remote `#remote=` > diagnostics > audience window > main screen. See "Device diagnostics page" |
| `?log=` | `1`, `0` (also `true`, `on`, `yes`, `show` and `false`, `off`, `no`, `hide`) | Force the input / output monitor (system events) shown / hidden for this visit | Not saved; priority: URL > saved preference > width-based default (shown above 820 px, hidden at 820 px and below) |
| `?onboard=` | `1`, `0` (`0`, `false`, `off`, `no` turn it off; anything else counts as on) | Force the quick tour on / off | `?onboard=1` beats "already seen" and `?kiosk`; the phone remote, the audience window and the diagnostics page never show a quick tour (not even with `?onboard=1`); `?kiosk` and `?tourstop=` suppress it by default |
| `?fit=0` | `0` (`false`, `off`, `no` also work) | Turn off automatic view fitting | For debugging; on by default, and wide screens are unaffected anyway |
| `?watchdog=` | `1`, `0` | Force the render watchdog on / off | Default: on for `?kiosk` and the audience window, off otherwise; `?watchdog=0` always turns it off |
| `?autoupdate=0` | `0` (`false`, `off`, `no` also work) | When a new build is detected, only record it and do not reload automatically | Default: production builds reload by themselves when a new build exists and the page is idle; development builds do not check for versions |
| `?reload=HH` | An integer `0`–`23` | Reload once a day after HH:00 local time, when idle | The page has to stay open for it to work; values outside 0–23 are ignored; shown in "Devices → Operations" |
| `?tourstop=` | `1`–`8`, or a stop id: `reservoir`, `tide`, `moon`, `dust`, `air`, `birds`, `fish`, `stations` | Start the data tour at that stop once the data has loaded (started only once) | Invalid values (for example `zzz`, `9`) do not start a tour; the quick tour is suppressed while it is present; "Copy link to this stop" produces URLs with the stop id |
| `&tourhold=1` | `1` (`0`, `false`, `off`, `no` turn it off) | With `?tourstop=`: arrive at the stop paused (presenter mode) | Has no effect without `?tourstop=` |
| `?speak=` | `1`, `0` (also `on`, `true`, `yes` and `off`, `false`, `no`) | Tour spoken captions on / off by default | Off by default; priority: URL > saved preference > off; speaks only in the main window and has no effect where the browser has no speech synthesis. See "Data tour" |

Examples:

```text
https://midisea.shyetech.com/?kiosk=1&lang=en&hud=0                  exhibition (English, no info panels)
https://midisea.shyetech.com/?kiosk=1&reload=3                       exhibition (reloads once a day at 03:00 when idle)
https://midisea.shyetech.com/?s=…&o=zengwen&m=8&sl=b1f0&lang=zh      a link made by "Share" (&m=8 is September)
https://midisea.shyetech.com/?tourstop=air&tourhold=1                presenter link: opens at the "air quality" stop, paused
https://midisea.shyetech.com/?diagnostics=1                          device diagnostics page
https://midisea.shyetech.com/?quality=low&fps=1                      debugging a low-end device
```

---

## Record / play

1. `● Record` → move knobs / drag the sphere / pull sliders → `■ Stop recording`
2. `▶ Play` replays the whole take; `⟲ Clear` to record again
3. **Soft-takeover**: during playback a physical knob must first "pass through" the value on screen before it takes over, so nothing jumps; dragging a slider or the sphere takes over immediately
4. Recordings are saved to localStorage and can still be played after a reload

## Share

Press "Share" to copy a link that carries the current sea:

```text
?s=<visual settings>&o=<sea>&m=<survey month>&sl=<bird/fish link>&lang=<language>
```

Besides the visual settings it includes the sea you picked (reservoir / tide / dust / moon / air quality), the month you previewed by hand, whether birds and fish follow the survey data, and the interface language. Whoever opens it sees the same picture and data context (load order: sea option → month → bird / fish link → visual settings → language; the visual settings go last so sea presets never overwrite them).

- The link state and the language are applied temporarily and never overwrite the recipient's own preferences (reload a URL without the parameters and they get their own settings back).
- Old links with only `?s=` always keep working; garbled or unknown fields are ignored without affecting the rest.
- Exhibition URLs (only `?lang=` or `?kiosk=1`) do not count as share links, so a first visit still opens with today's real sea.

"Snapshot" builds a 1080×1080 share card with the caption "I played a sea in MidiSea [url]" (in Chinese: "我在 MidiSea 演了一片海 [網址]"). Phones open the system share sheet with both the image and the text. Browsers without file sharing (mostly desktops) download `midisea-star.png` and copy the caption and link to the clipboard (if the browser refuses the clipboard this is silently skipped and you only see "downloaded"). On the English card the URL line and data rows shrink their font before they are cut, so they never overflow the card.

## Video recording

Press "Rec video" to capture the sphere for 10 seconds and download `ixd2026-globe.mp4` (`.webm` when the browser cannot record MP4).

## Export log

Press "Export log" to download `ixd2026-log.txt` (IN/OUT messages with timestamps) for debugging MIDI and the event flow.

---

## Data tour

So that visitors who cannot operate the sphere can still follow it, the app walks through the real data on its own, one stop at a time, and explains each one in captions. A presenter can also run it like a slideshow: jump around, pause, and pass on a link to one particular stop.

**How to start**: press **`T`**; click "Start tour" on the Data tour card in the panel (it comes right after the data card); or leave the app idle for 30 seconds (on by default; untick "Auto tour after 30 s idle" on the card to turn it off, which is remembered in the browser; `?kiosk=1` turns it on by default, and `?tour=0` / `?tour=1` force it off / on and win over both the preference and `?kiosk`).

**Eight stops** (a stop with no data is skipped; in AR view the moon and constellation stops are skipped because you cannot see them; a full lap is about 111 seconds):

| Stop | Content |
|---|---|
| Today's reservoir | Water level % → sea level |
| Hualien tide | 24 h of tide plays; the caption gives the tidal range (spring / neap tide…), lunar date and moon phase |
| Moon | The moon moves across the sky; the caption gives today's moonrise and moonset |
| Yunlin dust | PM10 → water murkiness. When the PM10 sensor is invalid the caption honestly says wind speed is used instead; a frozen source and collecting history are called out too |
| Air quality | Hourly PM2.5 from the Open-Meteo / CAMS model: the higher the PM2.5, the murkier the sea and the more trash; the caption says outright "model data, not government observations" |
| Birds | The survey timeline plays year by year; the caption lists the years with no survey (interpolated) |
| Fish | Same as birds (e.g. Zengwen: no survey 2007–2013) |
| River-station constellation | The 188 river gauging stations |

**On screen**: large captions below the canvas (a one-line title plus up to two lines of explanation, fading in and out), with clickable progress dots (n/N) and a row of presenter buttons underneath. The captions store data only and are translated when shown, so switching language mid-tour changes them at once. On a short landscape screen (for example a phone held sideways) the captions become a narrow card at the bottom left so they do not cover the lower half of the sphere. They belong to the "Playback & parameter hints" group (with `I` off the captions are hidden but the tour keeps running).

**Presenter controls** (while the tour runs; the presenter buttons, the progress dots and "Copy link" do not count as acting on the sea and never stop the tour):

- **Progress dots**: click any dot to jump to that stop; its caption and sea apply at once, and the tour carries on without switching to Stage mode.
- **Button row**: previous stop, pause / resume, next stop, copy link to this stop, and (only where the browser supports speech synthesis) read captions aloud. The caption card and the Data tour card in the panel each have one row.
- **Keyboard**: `←` previous stop, `→` next stop, `P` pause / resume; `Esc` still ends it and restores your sea.
- **What pause means**: pausing freezes the stop's timer and the data playback (the caption card gets an amber border and a "Paused" tag, and the data HUD says "Paused" instead of a tiny speed); jumping to another stop while paused keeps the new stop paused; resuming carries on with the time left on that stop. **Touching anything while paused** (a click on the canvas, a knob, any other key) **still ends the tour and restores your sea**, playback speed included. Pause has no timeout: after someone pauses an exhibition's auto tour it stays paused until someone touches something or presses `P` or `Esc`.
- **Per-stop links**: "Copy link to this stop" copies `https://…/?tourstop=<stop id>` (with `&tourhold=1` added while paused and `&lang=en` in the English interface); the button briefly reads "Copied" and the OUT monitor gets a line. The link carries only the stop id, the language and the hold flag, and **never carries along** other parameters from your current URL (`?kiosk`, `?audience`, `?s=`, `#remote=` and the like). When someone opens it, the tour starts at that stop as soon as the data has loaded (only once); with `tourhold=1` it waits there paused; and no quick tour pops up in front first. `?tourstop=` accepts `1`–`8` or a stop id (`reservoir`, `tide`, `moon`, `dust`, `air`, `birds`, `fish`, `stations`); an invalid value does not start a tour; if the linked stop is skipped this time (missing data or AR view) the tour starts at the first stop. Links use the stop id rather than a number because missing data or AR view skips some stops, which would shift the numbers.
- **Audience window**: shows the same captions and progress, but the dots are not clickable and there is no button row; when the main window is paused it shows "Paused" and the progress bar stops.

**Spoken captions (optional)**: off by default, and it asks for no permission before you turn it on. Once on (the "Read captions aloud" button in the row, or `?speak=1` to default it on; priority: URL > preference > off), each stop's caption is spoken with the browser's built-in speech synthesis (Web Speech `speechSynthesis`) whenever the stop changes: `zh-TW` in Chinese mode and `en-US` in English mode, falling back to another voice of the same language; units and symbols are made speakable first (for example "μg/m³" becomes "micrograms per cubic metre").

- It speaks only in the main window and never in the audience window; pausing or ending stops it at once, and resuming after a pause, changing stop or switching language re-reads the current stop. If a stop's time runs out before the sentence is finished, the tour waits up to 6 more seconds before moving on.
- **While a caption is being spoken (and for about 0.7 s afterwards), voice commands automatically ignore recognition results**, so a "whale" spoken by the speaker is not taken by the microphone as a command.
- This site sends no text anywhere; the browser synthesizes the speech, and whether a browser that picks a cloud voice goes online is up to the browser and the system.
- Limits: the available voices differ by device (Windows / Android may have no `zh-TW` voice and fall back to another Chinese voice, or have none at all; Linux Chromium often has no voice whatsoever, in which case the whole caption is silent and the tour carries on); iOS Safari and some mobile browsers only speak after the page has been tapped once, and stay silent until then; in English mode station and river names stay in Chinese and an English voice may skip or garble them; a missing value "—" is not read out as "no data". **The sound and quality of real speech synthesis have not been tried** (the embedded preview panel did not test spoken captions); see "Verification status".

**Interrupting and restoring**: before the tour starts, your parameters, sea option and playback speed are remembered. Touching the screen, moving a knob or slider, or pressing any key other than `T`, `H`, `I`, `?`, `←` `→` `P`, a modifier or `Tab` (that includes `L` and the footer's "System events" switch) stops the tour at once and restores the sea you had (`Esc` or `T` again also stop it). Switching language, Share, Snapshot, Rec video, Info, Help, Sound and Export log do not count as interruptions. If you start recording, press play yourself or change the sea, the tour only stops and nothing is restored. A recording you had stashed is kept, and the tour does not inflate the "Plays N" counter in exhibition mode.

**Restore first, then act**: DOM events (a tap or key press) stop the tour in the capture phase; non-DOM inputs — MIDI knobs and buttons, voice commands, the phone remote (including its transport keys), a gamepad, camera gestures and the mouse wheel — always call `activity.touch()` first, and its synchronous hook (`onActivity`) stops the tour and restores the sea **before** the action runs. Your first action (clear trash, quiet, ● record, ▶ play, a knob) therefore lands on the restored sea instead of being overwritten by the restore 100 ms later. The tour also stops and restores when the tab is hidden, minimised or fully covered (in the background `requestAnimationFrame` stops, but the tour would keep changing stops and captions by wall-clock time: a frozen sea with captions that keep changing). Pressing only panel buttons, closing a dialog, reading a data card or letting your own playback finish also counts as activity (the tour takes over 30 s later), and a data card left open is closed when the automatic tour starts. The tour's own stop changes, playback and overflow never buzz the phone or gamepad (a whale / dolphin / turtle / purify you call still does).

**Looping**: a tour you started by hand ends and restores after one lap; a tour started by idling keeps looping until someone acts. It never starts by itself while a dialog (Help / Devices / Jam) is open, and without sea data it falls back to the old hue-cycling attract mode.

**Privacy and permissions**: it only uses data that is already loaded, needs no permission and uploads nothing (see above for spoken captions). The audience window shows the same captions (the tour only runs in the main window; the audience window never starts one).

---

## Data source cards and stylus

**Tap for data source**: tap (movement under 10 px, held under 0.45 s, one finger, not the second tap of a double-click) an object on the **background** of the canvas and a card opens beside it. Every card cites its source:

| Object | What the card shows |
|---|---|
| Station star (the background constellation of 188 river gauging stations) | Name, river, catchment area, active or discontinued, a note on brightness |
| Moon | Today's moonrise, transit (with altitude), moonset, current bearing and altitude, moon phase (tide seas show the phase and tidal range) |
| Bird flock outside the sphere | Basin, this month's bird species count (marked "interpolated" for missing months), survey-year range, derived flock count |

Tap empty space, press `Esc`, press the × on the card or wait 6 seconds to close it (the card does not close while the pointer is on it); with the info panels hidden (`I`) no card opens; switching language changes the card text at once (station and river names stay in Chinese); on a narrow canvas (≤520 px) the card docks to the bottom edge.
Limits: stars and moon cannot be tapped while they are faded out or in AR view; a tap on the sphere itself is still the "star burst", so a flock drawn inside the sphere's area does not open a card; when you double-click a star the first click opens a card, and after switching to Stage mode it lingers for up to 6 more seconds. The audience window shows the main window's card (positions are mirrored in canvas-relative coordinates, so with different aspect ratios the ring and the object can be slightly off).

**Stylus pressure and tilt** (only `pointerType === 'pen'`: Apple Pencil, Surface Pen, Wacom; mouse and finger never trigger it):

- Pressure: while you drag the sphere, pressing harder adds more wave energy (spin inertia and surge).
- Tilt: while the pen is down on the canvas, its tilt steers current direction X / Y (an upright pen within 6 degrees leaves it alone; a hovering pen does nothing; updates come at most 20 times a second). Tilt is an **absolute mapping**, and a natural pen grip already tilts 20–45 degrees, so the current leans toward the way you hold the pen. If that is too sensitive at an exhibition, turn it off with `?pen=0`.
- Apple Pencil in iOS Safari may only report `altitudeAngle` / `azimuthAngle` without `tiltX` / `tiltY`; there is a fallback conversion (see the verification status: not yet tried on a real iPad).
- It uses no permissions, collects no data, and has no switch in the Devices panel.

---

## Survey timeline

The bird and fish survey cards in the data card include a "Survey timeline": it draws every survey year to true scale (bar height follows the species count), and years with no survey become an amber hatched band labelled "No survey 2007–2013" (for example Zengwen fish: 12 calendar years from 2004 to 2015, of which 2007–2013 have no survey).

- "Play survey timeline" steps through the years, about 0.7 s each (12 steps, about 8.4 s, for Zengwen fish). Gap years are driven by a **linear interpolation between the neighbouring survey years**; a cursor sweeps the timeline and highlights the current year, and both the on-canvas data hint and the OUT log say "no survey (interpolated)" together with the whole gap.
- **Interpolated values are illustrative, not observations**; the average and baseline use real survey years only.
- Accessibility: the timeline has `role="img"` and an `aria-label` (for example "Survey years 2004, 2005, 2006, 2014, 2015; no survey 2007 to 2013"); the layout uses percentages only and does not overflow at ≤400 px; during playback the cursor is written straight to the DOM through `store.subscribe`, without re-rendering React.

---

## Quick tour, system-event monitor and view fitting

Three features that make the app easier for a first-time user, especially on a phone.

### Quick tour

- **What it is**: it opens by itself on the first visit as 7 short steps — welcome, turn and touch, shape the sea, plug into real data, data tour, more, ready — each a sentence or two with a spotlight frame around the part of the screen it talks about (a dimmed overlay plus a card with progress dots, "Step n / 7" and Back / Next / Skip). When the target sits inside a scrollable panel it is scrolled into view first, and the scroll position is restored at the end; when a target does not exist or cannot be seen, the card falls back to the centre of the screen.
- **On a phone**: at widths ≤ 520 px the card becomes a bottom sheet hugging the lower edge; when the target is in the lower half of the screen (a slider in the control panel, the data card) it docks to the top edge instead so it never covers the spotlighted target.
- **Controls**: on desktop `→` / `Enter` next, `←` back and `Esc` skip; on a phone tap the buttons on the card. While it is open, focus stays inside the card (`Tab` cycles only between its buttons) and the global shortcuts behind it do nothing.
- **What is remembered**: only "finish" or "skip" writes to the browser (`ixd2026.onboarded` in localStorage, written together with the older `ixd2026.seen`); existing users who already have `ixd2026.seen` are left alone; if localStorage cannot be read (for example private mode) it counts as a first visit and appears on every load (once finished in a tab, sessionStorage remembers it for that tab). A first visit still opens with today's real sea. Nothing is uploaded.
- **When it does not appear**: `?onboard=0`; exhibition mode `?kiosk`; a data-tour link `?tourstop=` (whoever gets a link should see that stop straight away); the phone remote, the audience window and the diagnostics page. `?onboard=1` forces it (except on the phone remote, the audience window and the diagnostics page).
- **Replay**: Help → "Replay the quick tour".
- **Help dialog**: the long guide no longer pops up on arrival; it lives behind the Help button (or `?`): a one-line lead, 5 "Quick start" items, 6 topic sections closed by default (Controls, MIDI and sound, Real data and tours, View and AR, Jam / sharing and exhibitions, Language and devices) and an "Ocean ecology" section.

### System-event monitor (input / output monitor)

- **How to hide it**: the small arrow on the right of the monitor's title bar, the "System events" switch in the footer (it reads "Events" on phones), or the `L` key.
- **Default and memory**: on desktop (width > 820 px) it is shown by default and on phones it is hidden; once you toggle it the choice is remembered (`ixd2026.monitor` in localStorage, the value is `show` or `hide`). With no preference and no URL override, the monitor follows the window when it crosses 820 px; once you toggle it by hand it stops following. `?log=1` / `?log=0` override it for one visit only and are not saved; priority: URL > saved preference > width-based default.
- **While hidden**: the monitor and the splitter above it are not rendered, and the canvas and the right-hand panel extend downward; the log keeps recording, so "Export log" and showing it again are both complete. The footer shows the latest OUT event on one line (`aria-live="polite"`, with throttled updates). Every toggle leaves an OUT log line ("System events shown" / "System events hidden"), so an exported log has a few extra lines.
- Stage mode (`H` / `?kiosk`) never shows the monitor or the footer anyway. To fit the new switch, the desktop footer height is now automatic (26 px minimum, wrapping allowed).

### Automatic view fitting

- **Why**: the camera's vertical field of view is fixed (45°) and the horizontal range is that times the canvas aspect ratio; on a phone held upright in full screen (for example 375×812, aspect ratio about 0.46) the sphere is cut off on both sides.
- **How**: when the canvas is narrower than "just fits the sphere" (aspect ratio below roughly 0.95) the camera **pulls back** along its original line of sight (it only pulls back, never in); wider canvases (desktop, landscape, near-square) keep a factor of exactly 1 and the framing is bit-for-bit what it was. By the formula, in phone upright Stage mode (375×812, 390×844) the camera distance is about 12.9 (it was 6.6, about 1.95 times as far), and on a tablet held upright at 768×1024 about 1.24 times.
- **Behaviour**: the zoom slider and pinch zoom keep working (the default zoom always shows the whole sphere, and you can still zoom in and out on an upright phone); when the window, screen orientation or panel width changes it adjusts smoothly over about 0.5–1 s; the first frame is placed directly, so it never starts cut off and then shrinks; it does nothing during WebXR tabletop placement; `?fit=0` turns it off (for debugging). Everything is computed locally and needs no permission.
- **Knock-on adjustments** (only while pulled back; desktop is unchanged): the background river-station constellation moves above the sphere, centred, in upright layouts; the fog's near / far distances and the background star shell scale with the camera distance, otherwise the water body would be swallowed by fog and stars would land in front of the lens as huge blobs.
- **Limits**: on wide screens the sphere shell fills about 77% of the height (unchanged on purpose); on an upright phone the sphere is smaller on screen (about 311 px at 375 px wide, roughly 58% of the 540 px on desktop) and the tap-to-select radius shrinks in proportion; in upright layouts the station constellation may overlap the top data HUD bar a little; on extremely narrow canvases below aspect ratio 0.31 the moon disc's edge may be clipped slightly (the narrowest common phone is about 0.39 and is not affected).

---

## Devices panel

Opened with the "Devices" button at the top. It collects the **optional** device features; each section has its own switch and status text. The always-on logic lives in `src/services/*Service.jsx`. Nothing touches the camera or microphone until you switch it on, and nothing costs extra computation while it is off.

| Feature | Default | Permission needed |
|---|---|---|
| Audience window (dual screen) | Off (a button opens it) | For automatic placement on an external screen in Chrome / Edge: "Window management" |
| Camera gestures | Off (must be switched on explicitly) | Camera |
| Voice commands | Off (you press "Start listening"; always off after a reload) | Microphone |
| Haptics | On for touch phones, off on desktop, off when the system asks for reduced motion | None |
| Graphics quality | **Auto** (raises and lowers itself from the FPS; can be locked by hand) | None |
| Device diagnostics | A link (the "Open device diagnostics" button opens a new tab) plus a summary of the last run | None (the camera / microphone and other interactive checks inside the diagnostics page each ask for their own permission) |
| Operations | Always shown, nothing to switch on | None |

> Note: the graphics quality default is Auto, meaning the app measures FPS from the start and steps down by itself when the picture stutters (see "Graphics quality"). It is not "off by default".

### Audience window (dual screen)

- **How to open**: Devices → Audience window (dual screen) → "Open audience window". "Close audience window" asks that window to close itself. The panel shows how many audience windows are connected and how many screens were detected.
- **What it does**: perform on the laptop, show the audience on the projector. It opens a window (URL `?audience=1`) with no controls and no sound that shows the same sea full screen, including the data board, the data playback HUD, the tour captions and the data source cards. Parameters, data playback (speed / loop), whale / dolphin / turtle / cleansing wave triggers, pad effects, language and the info-panel switches in the main window all stay in sync live.
- **Permission and support**: in Chrome or Edge on HTTPS or localhost, the "Window management" permission (`getScreenDetails`) is requested; once allowed, the window is placed on the external screen automatically and one click in it goes full screen. In **Safari, Firefox, with a single screen, when the permission is denied, or on an insecure origin**, a regular window opens instead: drag it onto the projector and click it once for full screen. The first permission grant can expire the user gesture and get the pop-up blocked; the panel then says "press again".
- **Screen stays awake**: the audience window holds its own Screen Wake Lock (system-wide: neither the projector nor the laptop display sleeps just because nobody touches the keyboard or mouse, however long the tour runs); it is requested again when the window returns to the foreground and silently skipped where unsupported.
- **Graphics quality**: a projector is often 4K / high DPR and the heaviest picture to draw, so the audience window adapts its quality from **its own FPS** (its level is not written to the shared preference, so the two windows never overwrite each other). When you pick a level by hand in Devices → Graphics quality in the main window, an already-open audience window locks to the same level (choosing Auto again returns it to its own FPS). A projector capped at 30 Hz makes Auto mistake it for weak hardware and step down: pick a level by hand in the main window.
- **Privacy**: data only moves between the two windows of the same browser over a BroadcastChannel (`midisea-audience`) and is never uploaded; while no audience window is connected the main window does no extra work.
- **Limits**: the audience window is a **copy driven by the same parameters and events, not a pixel-exact mirror**: jellyfish and fish positions, trash physics, sphere spin and the jelly dent are not synced. Both windows must share an origin (the same URL). If two control-panel tabs are open in one browser, the audience window locks on to the first main window that answers. When the main window's tab goes to the background (the browser throttles timers) the audience window may briefly show "Waiting for the main window…" and recovers on its own. A tab opened by hand (not by a script) may refuse to be closed by "Close audience window".

### Camera gestures

- **How to switch on**: Devices → Camera gestures → "Enable camera gestures". The camera permission is only requested after that.
- **What it does**: it watches your hand with the camera so you do not have to touch the screen.
  - **Open palm**: spread all five fingers and hold for about 0.5 s, and current speed, swim speed and trash ease down toward about 0.15 / 0.3 / 0.1 (nothing snaps back when you lower your hand, and other input can take over at once).
  - **Pinch**: pinching thumb and index summons a whale (at most once every 3 seconds; holding does not repeat).
  - Every other pose (fist, thumbs-up, peace sign, fingers together) is ignored; with no hand for more than 1 second it returns to idle. Classification uses only distance ratios and angles, so it works for either hand, a mirrored front camera and any rotation.
- **On screen**: a red-dot "Camera in use" pill at the top right of the canvas (**always visible**, it ignores `I`) and a "Gesture · detected: open palm / pinch / —" badge (which follows the info-panel switch).
- **Permission and privacy**: camera. Video is processed on this device only and is **never uploaded or recorded**; the camera stops right away when you switch it off, leave the page or switch to another tab (it reopens when you come back). With AR view on it shares the same camera stream; otherwise it opens a hidden front-camera 640×480 `<video>`.
- **What it downloads**: the first use downloads a hand model (about 8 MB, from Google storage) and a WebAssembly runtime (about 11.7 MB uncompressed, sent compressed from the jsDelivr CDN); the browser caches both. MediaPipe (`@mediapipe/tasks-vision`, pinned to 1.0.1) is loaded dynamically only when you switch gestures on, as a separate chunk outside the main bundle. These two requests show your IP address to the CDN but send no video. The service worker does not cache cross-origin resources, so **the first use offline fails** (the panel says so).
- **Support and limits**: needs HTTPS or localhost, `getUserMedia` and WebAssembly. Detection runs at about 15 fps on the main thread (GPU delegate, falling back to CPU); on slow devices (older phones and iPads) it measures how long each inference takes and stretches the interval (at least twice the inference time as rest, capped at 100 ms, which keeps main-thread use to roughly a third to a half) at the cost of slower gesture response; automatic graphics quality does not reduce inference cost and does not pause it. Detection pauses and the camera it opened is released while the tab is in the background. AR view uses the rear camera and gestures use the front one, and some Android devices cannot open two camera streams at once. **The classification thresholds were tuned on synthetic hand models, not with a real camera** (see "Verification status").

### Voice commands

- **How to switch on**: Devices → Voice commands → "Start listening", and allow the microphone when the browser asks.
- **Commands**: say "whale", "dolphin", "turtle", "big wave", "sparkle", "purify", "clean", "quiet", "faster" or "stop" and the matching effect fires. You can chain several ("whale, big wave"); the same command has a 1.5 s cooldown. A short "Heard: whale" note shows below the canvas. In Chinese the words are 鯨魚, 海豚, 海龜, 大浪, 亮星, 淨化, 清垃圾, 安靜, 快一點 and 停.
  - "Quiet" eases current, swim speed and trash toward calm values in one step (say it twice for calmer); "faster" moves current and swim speed toward high values; "stop" stops recording / playback.
  - The word lists are deliberately loose (they include common mis-hearings and simplified characters), so false triggers happen: for example 進化 ("evolve") also counts as "purify", 金魚 ("goldfish") also counts as "whale", and the English words "wave" and "star" alone are enough.
- **Recognition language** follows the interface language (Chinese `zh-TW` / English `en-US`), one at a time; switch the interface language first to speak the other one.
- **Permission and privacy**: microphone. In Chrome and Edge, speech recognition sends the microphone audio to a cloud service (Google / Microsoft) and **needs a network connection**; Safari follows the system settings. This site **never records, stores or uploads audio**. The recognizer is only created, and the permission only requested, after you press "Start listening"; while listening, a "Listening" badge stays at the top right of the canvas **at all times** (press its ✕ to stop at once); it pauses when the tab goes to the background and resumes when you return. It is independent of the toolbar "Mic" (blow = wind); you can use both (on a few phones one of them may stop working while both listen).
- **Support**: Chrome, Edge and Safari (Web Speech `SpeechRecognition` / `webkitSpeechRecognition`); **not Firefox** (the switch is disabled with an explanation).
- **Limits**: on Android Chrome each recognizer restart may play a system chime; iOS Safari has no true continuous mode, so it restarts often and may ask for permission repeatedly; Brave and Electron often return network errors (after 5 retries it disables itself). Alternating "Chinese + English at once" recognition is not implemented. While the data tour's spoken captions are being read (and for about 0.7 s afterwards), voice commands automatically ignore recognition results, so a "whale" spoken by the speaker is not taken by the microphone as a command.

### Haptics

- **How to use**: Devices → Haptics: a switch, a strength (Light / Medium / Strong), and "Try haptics", which plays a whale (long and low), a drip (short and light), the cleansing wave (building up), a dolphin (two light taps), a turtle and the recording cue in turn.
- **Events**: whale, dolphin, turtle, cleansing wave, recording start / stop, playback start / stop, and overflow (when the sea level is above 97% it first gives a fine, light rattle, then drips at a steady rhythm that speeds up as the sea fills). Cooldowns and a global per-second cap keep quick repeated taps from turning into a constant buzz.
- **Devices**: phones (Android Chrome and similar) use the vibration motor (`navigator.vibrate`); gamepads use their dual rumble motors (Gamepad `vibrationActuator`, dual-rumble, Chrome / Edge only; Chrome only detects the pad after you have pressed one of its buttons).
- **Defaults**: on for touch phones, off on desktop (turn it on after plugging in a gamepad), and off when the system asks for reduced motion. iOS Safari has no vibration API, so it is skipped silently; a gamepad can be used instead.
- **Privacy**: your choices (switch and strength) are stored only on this device, in localStorage (`ixd2026.haptics`); nothing is sent anywhere.
- **Limits**: the phone remote page (the phone that scanned the QR code) does not mount the services, so the remote phone itself gets no haptics; tapping a star to light it is not wired to haptics yet; the overflow drips are simulated at a fixed rhythm and are not synchronised with the sound; `navigator.vibrate` also exists in desktop Chrome without a motor, so "supported" in the panel only means the API exists.

### Graphics quality

- **How to use**: Devices → Graphics quality → Auto / High / Medium / Low. It shows the current level, the current FPS (updated every second) and the reason for the last automatic downgrade.
- **Auto mode** (the default): if the 3-second average stays below 40 FPS it steps down a level; after 8 seconds above 55 FPS it steps back up. There is a minimum stay (10 s) and cooldowns between changes, and if it is dropped again right after an upgrade the upgrade cooldown doubles, so it does not flap. It pauses while you drag, record or capture video, or while the tab is in the background. Choosing a level by hand locks it, and it no longer raises or lowers itself.
- **Levels**:

  | Level | Resolution cap | Creatures and particles | Other |
  |---|---|---|---|
  | High (as before) | 2x pixel ratio | 100% | All effects |
  | Medium | 1.5x | about 70% | — |
  | Low | 1x | about 50% | No shooting stars; background blur is skipped and background clarity uses a simple darkening |

- **Privacy**: only the frame rate is measured; the preference (mode and last level, `ixd2026.quality`) stays on this device. Auto mode remembers the last level, so the next load starts from it. `?quality=` only forces a level for the visit, and `?fps=1` shows the FPS.
- **Limits**: it measures the rAF cadence, not GPU time; iOS Low Power Mode or a 30 Hz display caps rAF at 30 fps and makes Auto mistake it for weak hardware and drop to Low, so lock a level by hand there. A downgrade resizes the canvas, so the resolution of Snapshot images and videos follows the current level (the level never changes during a video recording).

### AR tabletop (WebXR)

- **How to switch it on**: it only appears on devices where the browser has WebXR and `isSessionSupported('immersive-ar')` is true (in practice Chrome on Android with ARCore). Devices → AR tabletop → "Place on a table" → allow the camera. Scan a table or the floor, tap when the ring appears, and a sphere about 28 cm wide is set there; it stays put as you walk around it.
- **Controls**: a DOM overlay at the bottom has sliders for sea level, current speed and water clarity, whale / dolphin / turtle buttons, "Place again" and "Exit AR" (they go through the same `input()` path, so they can be recorded). When tracking is lost it says "Move your phone to find a surface".
- **Permission and privacy**: the camera runs only after you tap the button; the picture is handled by the browser's WebXR, and this site neither sees nor uploads it. The button is disabled while "AR view" is on (both need the camera).
- **Zero cost when unsupported**: all XR code is a separate lazy chunk (`xr` / `XrRuntime` / `XrOverlay`, about 2–3 kB gzip each). Devices without `navigator.xr` (iOS Safari, most desktops) never download it and do not see the section; exiting, a system interruption or any error returns to the normal 2D view.
- **Verification status**: **not verified on a real device** (the development environment has no XR hardware and the embedded browser does not support it). The state machine and placement maths have 35 unit tests (fake session); the render layer got a smoke test with a fake XR manager; the normal 2D view was checked in a real browser and matches the view before the change. Hit-test accuracy, the DOM overlay, and how visible additive line art is over passthrough, along with performance, all need a real device.
- **Limits**: only horizontal planes are accepted (normal y ≥ 0.75); XR anchors are not used, so the sphere may drift slightly when ARCore corrects its tracking; environments without DOM overlay (such as immersive-ar in Quest Browser) can still place the sphere but show no sliders or exit button.
- **Steps for a real-device check** (please run them if you have an Android phone): (1) use HTTPS, or USB debugging plus `adb reverse tcp:5173 tcp:5173` and open localhost; (2) "AR tabletop" appears at the bottom of the Devices panel, and does not appear on iPhone Safari or a desktop without AR; (3) after entering, you see the camera picture with no dark-blue background or stars, and a cyan ring appears as you scan; (4) tap to place, walk a full circle and confirm the sphere stays fixed and particle sizes look right; (5) drag the three overlay sliders and tap the three creatures; (6) cover the camera and check the tracking-lost hint and recovery; (7) after exiting, the view, background layers and background blur / clarity are normal; (8) repeat in English.

### Device diagnostics

- **How to open**: Devices → Device diagnostics → "Open device diagnostics" (a new tab, URL `?diagnostics=1`). The panel shows "Last run: time, N passed, M failed"; when the diagnostics page updates in another tab, the panel updates live.
- **Privacy**: only a summary is stored here (the time and how many items fell in each state; `ixd2026.diag` in localStorage), with no device information. The diagnostics page itself is described in "Device diagnostics page".

### Operations

- **What it shows**: the build (build id; `dev` in a development build), load time, sea-data time, the latest results of the data check and the version check, the crash log (total count and the number of reloads it caused in the last 10 minutes, expandable to the most recent entries), and the safeguards currently active (render watchdog, WebGL recovery, automatic build updates, data updates, daily reload).
- **Buttons**: reload now, check for updates now, clear the crash log.
- **Privacy**: the log stays on this device and nothing is sent anywhere. You do not normally need to touch this section; how each safeguard behaves is described in "Exhibition safeguards and operations".

---

## Device diagnostics page

Before going on site, or onto a device you have never used, check with the real hardware, item by item, whether the camera, microphone, speech, MIDI, gamepad, vibration, screens, fullscreen and so on work. It is the main tool for the "real-device verification day" (see "Verification status").

- **How to open**: URL `?diagnostics=1` (for example `https://midisea.shyetech.com/?diagnostics=1`; during development `http://localhost:5173/?diagnostics=1`), or Devices → "Open device diagnostics" (a new tab). It works on phones and desktops. It is a separate page that does not load the 3D scene or the main screen, and its header has its own `EN` / `中文` switch (switching does not re-run the checks).
- **Quick checks (25)**: press "Run all quick checks" to run them all in about 3–4 seconds; they need no permission and never start the camera or microphone. Four groups:
  - **Environment**: browser and platform, screen and window size, secure context (https), language and time zone, network state, processor and memory, storage estimate.
  - **Graphics and performance**: WebGL (renderer and maximum texture size), a 2-second frame-rate sample (average and lowest).
  - **Browser feature support**: localStorage read / write, a BroadcastChannel round trip, Service Worker, Web Share of an image, clipboard write, the fullscreen API, Screen Wake Lock (released right after the request), MediaRecorder formats.
  - **Device APIs present**: Web MIDI, Web Bluetooth, WebXR AR (support only; no session is opened), speech recognition, Gamepad, vibration, PointerEvent and touch points, `getScreenDetails`.
- **Interactive checks (12)**: each starts only when you press its own button. Camera (preview plus measured resolution and fps), microphone (a 3-second level meter), speech recognition (5 seconds, showing the recognized text and language), Web MIDI device list, gamepad (live buttons and sticks), gamepad rumble, pen and touch pad, phone vibration (answer whether you felt it), orientation and motion sensors (iPhone asks for permission first), screen list (`getScreenDetails`), pop-up window, fullscreen enter and exit. The camera picture, phone vibration and fullscreen can be answered "Normal / Not normal" ("Not normal" turns that item into a failure); vibration must be answered to count as passed, the others may be left unanswered.
- **Result states**: passed / failed / unsupported / needs action / skipped / info. Badges use text, colour and shape together, never colour alone.
- **Report**: "Copy report" gives a Markdown table (37 rows, untested ones marked "not tested") plus a JSON block; when the browser blocks the clipboard it shows a text box you can select by hand. "Download JSON" gives `midisea-diagnostics-YYYYMMDD-HHMMSS.json`.
- **Privacy**: every check runs inside the browser on your device and **nothing is uploaded**. The report contains no personal data, IP address, images, audio or device names; camera / microphone / screen labels are not collected; speech recognition records only a character count, never the content; the URL has its `#hash` removed. The camera, microphone and speech only start after you press a button and are all released when you press "Stop", leave the page or the tab is hidden. Note that Chrome's own speech recognition sends audio to a cloud service (as with "Voice commands"). The Devices panel only reads and writes one summary (`ixd2026.diag`).
- **Reading the results**:
  - The summary's "passed" count includes pure info items (UA, screen, language…); being offline or not on https counts as a failure (a deliberate exhibition check); Service Worker shows "needs action" in development, where it is not registered.
  - The frame-rate sample measures `requestAnimationFrame` on an empty diagnostics page, reflecting the display refresh rate and the compositor, and does **not** stand for FPS under the 3D scene's load; the 45 FPS threshold is a rule of thumb; with the tab in the background that item is skipped or times out.
  - Some items are limited by the browser: for example iPhone has no vibration, page fullscreen or WebXR, and most features need https.
- **Verification status**: the diagnostics logic has 55 unit tests (fake objects check `this` binding; after deliberately turning a native call into a detached call the test goes red). In a real browser (the embedded preview panel, Chrome engine, desktop and phone emulation) the quick checks were run: 19 passed, 1 failed (clipboard: the embedded panel refused the permission), 2 unsupported (Web Share and WebXR), and the rest needed action or were skipped; the Device diagnostics and Operations sections of the Devices panel were also looked at. **The interactive checks (camera, microphone, speech, vibration, fullscreen, screen management) were not run for real** (the embedded panel blocks the camera and microphone); the clipboard's success path in an ordinary browser (only the failure message was verified), iOS Safari and real Android devices have not been verified either — exactly what the real-device verification day is for.

---

## Exhibition safeguards and operations

An exhibition that runs all day has no engineer beside it, so it has to recover by itself when the screen errors, the graphics engine drops out, rendering freezes or a new build appears. The logic is in `src/ErrorBoundary.jsx`, `src/lib/resilience.js` and `src/services/ResilienceService.jsx`; the status and tools are in "Devices → Operations".

| Safeguard | What it does | When it is on |
|---|---|---|
| Error boundary (ErrorBoundary) | When rendering the screen throws, it is replaced by "Something went wrong. Reloading in N s", a "Reload now" button and an expandable "Error details" section, and it reloads itself when the countdown reaches 0. **Back-off 5 → 15 → 60 s**: 5 s the first time; the second within a minute waits 15 s and the third onward 60 s. **5 crashes within 10 minutes trip the circuit breaker**: automatic reloads stop and it shows "Something went wrong. Please restart manually" with a manual reload button, which prevents an endless reload storm. Fatal events recorded at the same instant (within 200 ms) merge into one incident, so a single crash is never counted twice. `error` / `unhandledrejection` on `window` are only recorded, never reloaded on | Always (wrapped around everything: the main screen, the audience window, the phone remote and the diagnostics page) |
| WebGL context-loss recovery | When the graphics engine (the WebGL context) is lost, the top of the screen shows "Graphics engine interrupted, trying to recover…"; if it has not recovered within **4 seconds** the page reloads, and if it does recover it shows "Graphics engine recovered" for a few seconds. A loss while the tab is in the background does not reload it in the background; the 4 seconds start again when it returns to the foreground | Always in the main screen and the audience window |
| Render watchdog | When the tab is visible but there has been **no animation frame (`requestAnimationFrame`) for 10 seconds in a row**, it is judged frozen and the page reloads; two consecutive checks must agree before it acts, and it does not judge while the tab is in the background | Exhibition mode `?kiosk`, the **audience window** (a projector stays on all day and nobody notices a freeze) or `?watchdog=1`; `?watchdog=0` always turns it off; off by default in normal mode (so background / power-saving situations are not reloaded by mistake) |
| Version check | The build writes `dist/version.json` (`{ id, builtAt }`; the id is a UTC build timestamp plus a short hash, and the same id is compiled into the program), and the page periodically compares it with `fetch('/version.json', { cache: 'no-store' })`; a different id means a new build. When a new build exists it reloads itself **only when idle** (no input for ≥ 60 s and no recording / playback / tour / dialog), and while busy it looks again every 15 s. Offline or failed checks are silently skipped | Always checked in production builds: every 10 minutes (5 in exhibition mode); development builds do not check; `?autoupdate=0` only records and never reloads |
| Automatic data update | It periodically re-fetches `data/ocean.json`; when `fetchedAt` is newer it **swaps in only the data and leaves your current sea and every parameter alone** (applied only when idle; bird / fish counts that are linked are not recomputed from the new data until you next press "Apply"). When it succeeds the OUT log gets a "data updated" line | Main screen: every 30 minutes in exhibition mode, every 3 hours otherwise (only while the page is visible). The audience window does not do it (it picks up new data when it reloads itself) |
| Daily reload | Add `?reload=3` and it reloads once a day after 03:00 local time, when idle; after a reload the target is recomputed as "tomorrow", so it never reloads in a chain | `?reload=HH` (0–23) |

**What idle means**: no input for at least 60 seconds and no recording, data playback, manual tour or dialog. In exhibition mode (`?kiosk`), or during a tour that started by idling, the tour is the normal state of an empty room (an auto tour loops forever), so it does not count as busy; a recording, a dialog and input within the last 60 seconds still do.

**Crash log**: a ring of the latest 20 entries (time, message, first 300 characters of the stack, build id, a summary of the URL flags), with identical errors within one page load merged into one entry. A new-build or daily reload also records an informational event that does not count toward the crash count or the circuit breaker (the breaker only counts screen errors, WebGL failures and watchdog stalls, the events that cause a reload). The log stays in this device's localStorage (`ixd2026.crashes`) and is **never uploaded**; you can view and clear it in "Devices → Operations".

**Suggested exhibition setup**: `?kiosk=1&reload=3` (optionally with `&lang=en&hud=0`), with an audience window opened onto the projector on the same machine (it has the watchdog on by default). If the watchdog misjudges in your environment, add `?watchdog=0` to turn it off.

**Verification status (honest disclosure)**:
- The safeguard logic has 72 unit tests (fake environments and fake timers, including a `this`-binding regression) and 9 build-configuration tests (one of which is a dist check that runs only with `MIDISEA_VERIFY_DIST=1` and is skipped by default).
- Verified in a real browser (the embedded preview panel): the **error boundary** (deliberately making a component throw → countdown → automatic reload → recovered) and the "Devices → Operations" panel.
- **Not** verified in a real environment: WebGL context-loss recovery, the render watchdog (including its false-positive rate on a real projector; the 10-second threshold is a rule of thumb), the automatic data update, the daily reload, and **the version check and automatic reload against a deployed `dist/version.json`** (only possible after going live).
- Detection of a new build can lag the actual deployment by up to about one CDN cache period (`/version.json` passes through the service worker and the hosting CDN's cache); offline, the service worker may return an old `version.json`, which simply reads "up to date".

---

## Browser and device support matrix

**How to read this**: the table is derived from the browser APIs each feature actually uses and their published compatibility. This project is developed and verified mainly in **desktop Chrome and Edge** (including an embedded browser panel); the Safari, Firefox, iOS and Android columns were **not verified feature by feature on real devices**, and "untested" means exactly that.

Legend: **Supported** = the browser provides the API and the feature is expected to work; **Conditional** = needs something extra (HTTPS, a permission, a particular platform); **Fallback** = the API is missing and the feature falls back to something else; **Not supported**; **Untested** = should work in theory, but nobody has tried it.

| Feature (API needed) | Chrome | Edge | Safari | Firefox |
|---|---|---|---|---|
| 3D sphere and basic interaction (WebGL, Pointer Events, Web Audio) | Supported | Supported | Untested (SPEC targets 16.4+, secondary) | Untested (SPEC: secondary) |
| MIDI controllers (Web MIDI; HTTPS or localhost) | Supported | Supported | Not supported (neither macOS nor iOS) | Conditional (108+ needs a separate grant; untested) |
| Bluetooth MIDI (Web Bluetooth) | Supported (desktop, Android) | Supported | Not supported | Not supported |
| Jam / phone remote (WebRTC; phone sensors need DeviceOrientation / DeviceMotion) | Supported | Supported | Supported (sensors ask permission on first touch) | Untested |
| AR view (`getUserMedia`; HTTPS) | Conditional (HTTPS + camera permission) | Conditional | Conditional | Conditional |
| Video recording (MediaRecorder + `canvas.captureStream`) | Supported (MP4 or WebM) | Supported | Supported (MP4) | Supported (WebM) |
| Snapshot (Web Share with files; otherwise PNG download + caption copy) | Supported | Supported | Supported (desktop may refuse the clipboard, silently skipped) | Fallback (PNG download) |
| Audience window sync (BroadcastChannel) | Supported | Supported | Supported | Supported |
| Audience window placed on an external screen automatically (`getScreenDetails` + Window management permission) | Conditional (HTTPS / localhost + permission) | Conditional | Fallback (regular window, drag it to the projector) | Fallback (same) |
| Camera gestures (`getUserMedia` + WebAssembly + MediaPipe) | Conditional (HTTPS + camera permission; not tried on hardware) | Conditional (not tried on hardware) | Untested | Untested |
| Voice commands (Web Speech `SpeechRecognition`) | Conditional (microphone permission + network; cloud recognition) | Conditional (same) | Conditional (`webkitSpeechRecognition`, depends on system settings; not tried on hardware) | Not supported |
| Haptics: phone vibration (Vibration API) | Supported (Android only; desktops have no motor) | Supported (Android only) | Not supported (no API on iOS, skipped silently) | Untested |
| Haptics: gamepad rumble (Gamepad `vibrationActuator`) | Supported (pad detected only after a button press; not tried on hardware) | Supported (not tried on hardware) | Not supported | Not supported |
| Stylus pressure and tilt (Pointer Events) | Supported (not tried on hardware) | Supported (not tried on hardware) | Conditional (Apple Pencil may only give `altitudeAngle` / `azimuthAngle`, with a fallback conversion; not tried on hardware) | Untested |
| Automatic graphics quality (rAF measurement) | Supported | Supported | Supported (Low Power Mode misleads it, see "Graphics quality") | Supported |
| AR tabletop (WebXR `immersive-ar` + hit-test) | Conditional (Android only; needs ARCore, HTTPS and camera permission; **not tried on a device**) | Conditional (Android only; not verified) | Not supported (no WebXR AR on iOS Safari; use "AR view") | Not supported |
| Device diagnostics page `?diagnostics=1` (API detection; interactive checks need permissions on top) | Supported (quick checks run in the embedded preview panel; interactive checks not run) | Untested | Conditional (iPhone has no vibration, page fullscreen or WebXR, and the page shows them as unsupported; **not tried on hardware**) | Untested |
| Spoken tour captions (Web Speech `speechSynthesis`, optional) | Conditional (available voices vary by system and there may be no Chinese voice; **the sound has not been tried**) | Conditional (same; untested) | Conditional (iOS speaks only after the page has been tapped; **not tried on hardware**) | Untested |
| Exhibition safeguards (error boundary, WebGL context-loss recovery, render watchdog, version check, data update, daily reload) | Supported (the error boundary was tried in the embedded preview panel; the rest have unit tests only, and the version check can only be verified after going live) | Untested | Untested | Untested |
| Quick tour, system-event monitor, automatic view fitting (DOM, localStorage, pure maths) | Supported (tried in desktop and phone emulation) | Untested | Untested | Untested |

**Mobile notes**

- **iPad / iPhone (all iOS browsers)**: no Web MIDI, Web Bluetooth or vibration API. Use "Jam" and scan the QR code to make the phone a remote (WebRTC, no Bluetooth needed). Tilt / shake sensing asks for permission on first touch. Spoken tour captions only speak after the page has been tapped, and the diagnostics page shows vibration, page fullscreen and WebXR as unsupported. None of this has been tried on real iOS hardware.
- **Android Chrome**: supports phone vibration and Web Bluetooth. AR view uses the rear camera and camera gestures use the front camera, and some models cannot open both streams at once, so one of them may fail.
- **Older phones and iPads**: camera-gesture inference runs on the main thread and may slow the picture; lock "Low" graphics quality.

---

## Verification status (honest disclosure)

The lists below say what was verified and what was not, for whoever takes the project over and for the judges: **before an exhibition or a presentation, please run each item marked "not yet verified" on a real device** (a suggested plan is in "Real-device verification day" at the end of this section).

### This round (round 4): new features

The features of this round were tried by the coordinator in a **real browser** (the embedded preview panel, Chrome engine; desktop at 1280×800, and phone emulation at 375×812 portrait and 812×375 landscape) for exactly the items listed as "verified" below. They were **not** verified on any real device (iPhone, iPad, Android phone, external projector) or on a full Safari / Firefox / Edge.

| Feature | What was verified | Not yet verified |
|---|---|---|
| Device diagnostics page | 55 unit tests; in a real browser (desktop and phone emulation) the quick checks ran: 19 passed / 1 failed (clipboard: the embedded panel refused the permission) / 2 unsupported (Web Share, WebXR); the Device diagnostics and Operations sections of the Devices panel | The **interactive checks** (camera, microphone, speech, vibration, fullscreen, screen management; the embedded panel blocks the camera and microphone); the clipboard's success path in an ordinary browser (only the failure message was verified); everything in iOS Safari; WebXR |
| Air quality | 33 tests (20 in `scripts/gov/air.test.mjs` + 13 in `src/lib/air.test.mjs`, including checks against the real `ocean.json`); in a real browser: the option, the data card, the "model data" label, the CC BY credit, playback | The long-run success rate of the schedule on GitHub Actions (the fetch script has been run against the real network locally; how it does on the schedule only shows once live); how far it differs from the Ministry of Environment's station readings (modeled data will always differ somewhat) |
| Exhibition safeguards | 72 unit tests (fake environments, fake timers) + 9 build-configuration tests; in a real browser: the **error boundary** (deliberately making a component throw → countdown → automatic reload → recovered) | WebGL context-loss recovery, the render watchdog (including its false-positive rate on a real projector), the automatic data update, the daily reload; **the version check and automatic reload against a deployed `dist/version.json`** (only possible after going live) |
| Hideable system-event monitor | 16 tests; in a real browser: the `L` key, the footer switch, remembering the preference, hidden by default on a phone | The footer layout at real device widths (including iPad landscape) |
| Quick tour | 47 tests (including the Help dialog structure check); in a real browser: the 7 steps (spotlight and card placement on phone and desktop), remembered after finishing, absent when `?tourstop=` is present | iOS Safari (including the collapsing address bar) and the layout on other real devices |
| Automatic view fitting | 28 tests (camera maths and state machine, checked against real projection with three's `PerspectiveCamera`); in a real browser: the whole sphere visible on a phone in upright Stage mode, unchanged in landscape | Real devices; how it feels when rotating; whether objects on the smaller upright sphere are still easy to tap |
| Presenter controls (with the air-quality stop and per-stop links) | 141 tests (`tour` 76 + `tourCore` 47 + `tourLink` 18); in a real browser: `←` `→` `P`, clicking the progress dots, pause freezing playback and the timer, jumping while paused, resume, `Esc` restoring speed and sea, a deep link starting the tour exactly once, the caption card on phone portrait and landscape | The clipboard success path of "Copy link" in an ordinary browser; the layout of most CSS on real devices |
| Spoken captions | 45 narration tests + 3 echo-guard tests (fake `speechSynthesis`, fake timers; they check `this` binding) | **The sound and quality of real speech synthesis** (the embedded panel did not test spoken captions); spoken captions in iOS Safari; differences in available voices between devices |
| Overflow drip scheduling | 3 tests (times only increase; a random sequence run ten thousand times never goes backward) | The actual sound on a high-refresh display |

Also **not verified at all** this round: WebXR (AR tabletop), the watchdog's false-positive rate on a real projector, and the layout of most CSS on real devices.

### Earlier device and sensor features

These features were written without the matching real hardware at hand.

| Feature | What was verified | Not yet verified on real hardware / environments |
|---|---|---|
| Camera gestures | 56 unit tests (classification, hysteresis, cooldown, smoothing, mirror and left / right hand, lost-hand idle, and the runtime lifecycle with a fake camera and fake landmarks); the settings section was server-rendered in both languages | A real camera with real MediaPipe output. **The classification thresholds (`THRESH` in `src/lib/gestures.js`) were tuned on synthetic hand models** and will very likely need adjusting on real hardware; actual GPU / CPU delegate performance |
| Speech recognition | 79 unit tests (fake recognizer, command matching including mis-hearings and simplified characters, de-duplication and cooldown, restart back-off, language switching); the UI was only server-rendered | A real microphone with Web Speech: cloud recognition in Chrome / Edge, Safari; the accumulating transcript on Android (unit tests only); iOS Safari's continuous behavior; false triggers from the loose word lists |
| Dual screen (`getScreenDetails`) | 46 unit tests (protocol over a fake BroadcastChannel, throttling, disconnect detection, snapshot self-healing, screen selection); same-origin BroadcastChannel can be simulated with two tabs on one machine | A real external screen or projector; the "Window management" permission flow; user-gesture expiry and pop-up blocking around the permission prompt; full-screen behavior |
| Stylus | 17 unit tests (pressure → wave energy, tilt → current, iOS angle fallback) plus 39 data-source tests; the picking projection was checked in Node with three and the real `ocean.json` (all 188 stations land inside the canvas, 181 hit themselves, and the other 7 share exactly the same coordinates as another station); it can be simulated with synthetic `PointerEvent`s (`pointerType: 'pen'`) | A real Apple Pencil / Surface Pen / Wacom pen; whether iOS really only reports `altitudeAngle`; whether the natural grip tilt feels too sensitive |
| Gamepad rumble | 42 unit tests (fake gamepad / fake `vibrationActuator`, pattern table, strength scaling, cooldowns and the global cap) | Dual-rumble feel on real Xbox / PlayStation pads; detection behavior in Firefox / Safari |
| Android vibration | Same as above (fake `navigator.vibrate`) | The real feel and the strength difference on an Android Chrome phone (motors control only duration, not strength) |

Also verified only with unit tests, server-side rendering or offline calculation, without cross-device acceptance: the CSS layout of the tour captions and cards (including phone and Stage-mode widths), the visuals of the survey timeline (hatch contrast, label placement, layout at ≤400 px), the placement and clamping of the data source cards, automatic graphics-quality downgrades on real low-end devices, the Low-quality darkening compared with the High-quality color, and the final look of the sea color correction (the numbers are an offline calculation that already includes ACES tone mapping). The verification status of the older features (MIDI, Jam, AR and so on) is not assessed in this section.

**Hands-on verification checklist for the earlier features (for whoever takes over)**

1. **Camera gestures**: in Chrome open Devices → Camera gestures → allow the camera → the panel shows "On", and the canvas shows the red "Camera in use" pill; spread all five fingers for about 0.5 s → current speed / swim speed / trash ease down; pinch thumb and index → exactly one whale, not repeated within 3 s; fist / thumbs-up / peace sign → nothing; after switching off, the camera LED goes dark. If it triggers too hard or too easily, adjust `THRESH` (`spreadEnter`, `fingerReachEnter`, `thumbAwayEnter`, `pinchEnter`).
2. **Voice**: in Chrome open Voice commands → "Start listening" → allow the microphone → say whale, dolphin, turtle, big wave, sparkle, purify, clean in turn and the canvas should show "Heard: …"; "quiet" should lower the parameters and "stop" should stop playback; switch to Chinese and say the Chinese commands; with the microphone permission blocked, a permission message should appear and nothing else should be affected.
3. **Dual screen**: Chrome / Edge with an external screen (HTTPS or localhost) → "Open audience window" → allow "Window management" → the window should appear on the external screen and one click goes full screen; drag a slider, press 1–4 and play the tide in the main window and the audience window should follow at once; reloading either window should recover within seconds.
4. **Stylus**: drag on the sphere with an Apple Pencil on an iPad, or a Surface / Wacom pen: hard pressure should make clearly bigger waves than light pressure; tilting the pen to the right raises current direction X; with `?pen=0` nothing should happen.
5. **Gamepad rumble**: Chrome / Edge with a gamepad, press any button → Devices → Haptics should show "Gamepad: 1 detected, 1 supports rumble" → switch it on and press "Try haptics".
6. **Android vibration**: open the site in Android Chrome → Devices → Haptics is on by default and shows "Phone vibration: supported" → "Try haptics" should feel like a whale, a drip, the cleansing wave, a dolphin, a turtle and the recording cue in turn.

### Real-device verification day (suggested plan)

Do every "not yet verified" item above in a single day, and keep evidence of the results.

1. On **every device to be checked** (iPhone Safari, Android Chrome, iPad, desktop Chrome / Edge / Safari / Firefox, the computer that drives the projector) open `?diagnostics=1` over **HTTPS**: press "Run all quick checks" first, then go through the interactive checks one by one (camera, microphone, speech, vibration, screen list, fullscreen, MIDI, gamepad…).
2. Press "Copy report" or "Download JSON" to keep it, and add the device model, OS version and browser version yourself (the report collects no camera / microphone / screen labels and does not include the model). If the clipboard is blocked, use "Download JSON" and note that.
3. **Main screen**: open the site in iOS Safari and Android Chrome and check the quick tour's 7 cards and their placement, the whole sphere visible in a phone's upright Stage mode, the data tour's `←` `→` `P` (with an external keyboard) and progress dots, and "Copy link to this stop" (paste it on another device and open it); turn on "Read captions aloud" and check the sound, the language, and how pause and stop changes behave, with voice commands on as well to confirm the speech does not trigger a command.
4. **Exhibition**: leave the machine on for the whole session with `?kiosk=1&reload=<the next hour>` and watch "Devices → Operations" (does the watchdog misjudge, the data check, the crash log); after deploying a new build, confirm the page reloads by itself when idle.
5. Hand the reports and observations to whoever takes over; a diagnostics report can be pasted straight into an issue.

---

## Languages

The interface comes in **Traditional Chinese** and **English**. Switch with the language button at the top (it reads `EN` in Chinese mode and `中文` in English mode) or with `?lang=en` / `?lang=zh` in the URL. Order of precedence: URL `?lang=` > the saved preference (localStorage `ixd2026.lang`) > the browser language (`zh*` → Chinese, anything else → English). Switching does not need a reload: data names (reservoirs, basins, counties, weather, lunar dates, tidal range), logs, share captions, the quick tour, tour captions, the language of spoken captions (Chinese `zh-TW` / English `en-US`) and the speech-recognition language all follow; the diagnostics page has its own `EN` / `中文` switch and switching does not re-run the checks. Station and river names are proper nouns from the government data and stay in Chinese in the English interface (an English spoken voice may skip or garble them).

**Design**: the **Chinese source text is the key**. The code was written in Chinese, so translating means wrapping a literal in `t()`. English goes in `src/i18n/en/*.js` (one file per feature, merged automatically by Vite through `import.meta.glob`, so a new feature needs no change to any shared file); a missing English entry falls back to the Chinese text (dev mode logs it once to the console).

**How to add a translation**:

1. Wrap the Chinese literal:
   - React components: `const t = useT()` → `t('分享')` (re-renders when the language changes)
   - Non-React code (pure functions, store logs): `import { t } from '.../i18n/index.js'`, which uses the current language
   - Static tables (for example the `label` in the parameter registry): **mark** it with `T('海水高度')`, which returns the Chinese unchanged, and call `t(label)` when displaying it
   - Interpolation: `t('{n} 站', { n: 3 })`; an English value may be a function `({ n }) => …` to handle plurals
2. Add `'中文原文': 'English'` to `src/i18n/en/<your feature>.js`. Follow `src/i18n/GLOSSARY.md` (for example the whole site says "sphere" and never "globe"; the button for "分享星球" is "Snapshot").
3. Acceptance: `npm run i18n` (which runs `node scripts/i18n-report.mjs`) must report 0 untranslated Chinese literals, 0 missing English keys and 0 duplicate keys; `npm test` runs `src/i18n/i18n.test.mjs`, which blocks the same problems and additionally checks that English values contain no Chinese and that `{placeholder}`s match the Chinese key. The scanner finds literals through a Babel AST: comments, `console.*` and regexes do not count.

**Things to watch**:

- A component that calls a pure function that reads the current language (`describeBoard`, `formatHud`, `buildTour`…) must subscribe to the language itself with `useT()` / `useLocale()`, or it will not re-render on a switch.
- A string stored in the store or a log is a snapshot of the language at that moment; anything that must follow a switch should be stored as `{ key, params }` and translated with `t()` when displayed (the tour captions work this way).
- A resident service holding language-dependent state (the speech recognizer's language, cached transcripts) must listen to `useLocaleStore.subscribe` and reset.
- Data-layer names go through `src/i18n/data.js` (pure functions) and `src/i18n/en/data.js`.
- **The Help dialog body** (`src/ui/info/InfoZh.jsx` / `InfoEn.jsx`) contains inline markup (`<b>`, `<code>`), so it is not translated sentence by sentence but maintained as a pair: both files must have the same entries in the same order with the same facts. `InfoZh.jsx` is in `ALLOW_FILES` of `scripts/i18n-check.mjs`, so it may contain Chinese directly, while **`InfoEn.jsx` must not contain any Chinese characters** (the i18n test blocks that). The structure is "Quick start `QUICK` (at most 5 items) + collapsible topic sections `GROUPS` + ocean ecology": to add a way to play, add one `{ id, body }` entry to the `PLAY` array in both files and put its id into exactly one group in `GROUPS`. `src/lib/onboarding.test.mjs` parses the source to check that the ids, the groups and the number of inline tags in the two files line up one to one, and it pins the current counts (19 ways to play + 5 quick-start items), so adding one means updating that test as well. Keep the Help dialog short: add only a line or two inside the relevant collapsed section.

---

## Datasets → visuals

The data is mostly government open data (OGDL v1); **"Air quality" is the exception**: it is Open-Meteo's CAMS modeled data (CC BY 4.0, not government observations), and weather also falls back to Open-Meteo when there is no CWA key. The front end only reads the static `public/data/ocean.json`, which GitHub Actions refreshes on a schedule (there is no backend; the key lives only in a CI secret).

| Dataset (source) | How it reaches the picture | Playable |
|---|---|---|
| Reservoir status + inflow (Water Resources Agency) | Water level % = sea level, full-reservoir overflow; inflow → current / fish schools | 24 h inflow |
| Tide forecast F-A0021-001 (CWA) | Tide level → sea level (overflow at high tide); moon phase = that day's lunar date | 24 h tide |
| Live river water level (Water Resources Agency, 5 stations) | Ratio to warning level → background Milky Way density | — |
| Bird survey (Water Resources Agency) | Bird flocks outside the sphere; monthly seasons (circular interpolation) | Survey timeline (yearly, gaps interpolated) |
| **Fish survey** (Water Resources Agency `0a79fde0-a69d-4842-b66b-e51f43ce83f0`) | The "Fish schools" parameter; monthly seasons | Survey timeline (yearly, gaps interpolated) |
| **IoW dust** (Water Resources Agency `ae7bd821-a879-4b65-ad34-b3dac36874e0`, 3 stations along the Zhuoshui River in Yunlin) | PM10 → water clarity / trash / hue; wind speed → current | History (see limits below) |
| **River gauging station list** (Water Resources Agency `9332bd66-0213-4380-a5d5-a43e7be49255`) | 188 stations laid out at their real coordinates in the shape of Taiwan as a **background constellation** (active = bright, discontinued = dim, brightness follows catchment area; stations on the same river are joined by thin lines); tap one for its data source | — |
| **Moonrise & moonset A-B0063-001** (CWA, Hualien County) | The moon's azimuth / altitude (idle = today × the current time; playback = day by day) | Daily (rolling 180 days) |
| **Air quality (modeled data)** (Open-Meteo Air Quality API, CAMS global atmospheric model; CC BY 4.0; **not government observations**) | Hourly PM2.5 at Mailiao, Yunlin County (about 23.79°N, 120.25°E) → water clarity / trash / hue / glow; the current follows today's wind speed; the data card also lists PM10 and US AQI | Hourly history (the last 120 hours ≈ 5 days, 0.2 s per hour) |

**Data limits (honest disclosure)**
- **Dust**: the IoW endpoint only returns the "latest reading". History is appended by CI every 3 hours (de-duplicated by the source timestamp, keeping the latest 120 readings ≈ 15 days), so right after deployment there is 1 reading and the data card says "collecting". Right now the PM10 sensors always return the sentinel 4999.4 (and there is an absurd air temperature of 1956.96 °C); the script treats them as invalid → `null`. The sea then uses a default PM10 = 40 μg/m³ as an illustration (the board says "PM10 invalid"), and history playback uses **wind speed** to drive the current and murkiness instead. The source can also freeze (the timestamp advances while the value does not). As of 2026-09-20 PM10 is still the invalid sentinel and wind speed looks frozen, which is why "Air quality" was added.
- **Air quality (modeled data)**: the source is the CAMS global atmospheric model (analysis + forecast) served by the Open-Meteo Air Quality API, **not numbers measured by a government station**. The grid is coarse (tens of kilometres) and can differ from ground stations (for example the Ministry of Environment's Mailiao station), so it is only an artistic mapping and **must not be read as an official air-quality figure**; the data card, the data board, the log and the tour captions all say "model data". `US AQI` is the US EPA index, not the Ministry of Environment's AQI, and the screen always writes it as "US AQI". The data is hourly: each CI run fetches the "past 5 days", merges it with the old data by time and de-duplicates, drops forecast future hours and keeps only the latest 120 rows up to now; if fetching fails the old data is kept. The current does not follow the hourly playback (there is no hourly wind in the history, so it only uses today's wind speed). The licence is CC BY 4.0, which requires crediting "Weather data by Open-Meteo.com" with a link back to <https://open-meteo.com/> (the data card carries the credit and a link, and `air.note` in `ocean.json` states the attribution). Open-Meteo's free API is for non-commercial use only; if this is ever used commercially it needs a paid plan.
- **Ministry of Environment air data (an optional follow-up, not implemented)**: the Ministry of Environment's air-quality API needs an API key that you apply for yourself, and this project has not applied for one, so it is not wired in. If someone gets a key later, government observations can be brought in from CI with a secret such as `MOENV_KEY`, and "Air quality" could then use official numbers; until then, treat it as modeled data.
- **Stations**: only a station directory exists (no flow time series); TWD97 two-degree zone coordinates are converted to relative coordinates and used only for the background constellation.
- **Moonrise & moonset**: by default the API returns only a short window, and other ranges need `timeFrom` / `timeTo` (at most 180 days per request; currently published: 2025-01-01 → 2027-12-31). CI takes a rolling window that starts 2 days before today and runs 180 days, and keeps the old window if fetching fails; the front end uses `from / to` to tell whether the window covers today, and when it does not, the idle moon falls back to an astronomical formula. Azimuth is measured from north at 0°, clockwise; each lunar month has one day with no moonrise or no moonset.
- **Fish / bird surveys**: most basins have only 4–5 valid months / years, and missing months are filled by circular interpolation from neighbouring months (marked "interpolated"); each month covers only 1–3 survey years, close to a single-year snapshot rather than a climate average. Hualien River bird counts for 2017–2019 are entirely empty (the timeline's individuals are blank). Species names are normalized (the literal "NULL", alias order). **The survey timeline is a dense yearly series**: one point per calendar year from the first to the last survey year; gap years with no survey are filled by linear interpolation between the neighbouring survey years and marked "no survey (interpolated)", which is illustrative and not observed data; averages and baselines use real survey years only.
- Water Resources Agency open data returns misplaced / empty / truncated content for about 1 in 4 **concurrent** requests, so the script always fetches sequentially and retries. The success rate from GitHub runners to WRA / CWA has not been measured in Actions; a failed dataset only keeps its old data and never affects the others.

**Tests**: see the next section (for data: `node --test src/lib/series.test.mjs scripts/gov/gov.test.mjs src/lib/air.test.mjs scripts/gov/air.test.mjs`, including a smoke test against the real `ocean.json`).

---

## Testing

```bash
npm test                              # = node --test: runs every *.test.mjs (including the i18n acceptance)
npm run i18n                          # i18n report only (clean means 0 unwrapped, 0 missing English, 0 duplicate keys)
node --test src/lib/tour.test.mjs     # a single file
npm run build                         # the build must succeed
```

The numbers below were measured with `node --test` when this document was written. All of these run on plain Node (no browser needed; every browser API is injected as a fake):

| Test file | Tests | Scope |
|---|---|---|
| `src/i18n/i18n.test.mjs` | 8 | i18n acceptance: every Chinese literal wrapped in `t()` / `T()`, every key has English, no conflicting dictionary entries, `{placeholder}`s match and English values contain no Chinese, function-valued English entries, `ocean.json` names all have English in English mode, Chinese mode returns text unchanged |
| `src/lib/i18n-data.test.mjs` | 10 | Data-layer text: Chinese output unchanged character for character (data board / log / HUD), English wording, a full `ocean.json` scan with no Chinese in English mode, no leftovers after switching language |
| `src/lib/series.test.mjs` | 23 | Data → playback series and output text; the dense yearly survey series, gap-year interpolation and HUD; a smoke test on the real `ocean.json` |
| `scripts/gov/gov.test.mjs` | 14 | Offline parsing of each dataset (dust sentinels and rolling history, station coordinates, fish / bird surveys, moonrise & moonset, HTTP retry, JSON output, idempotent baking) |
| `src/lib/share.test.mjs` | 35 | Share-link encode / decode, data context (`&o=&m=&sl=&lang=`), old-link compatibility and garbage tolerance, load order, snapshot caption, `fitText` layout |
| `src/lib/tour.test.mjs` | 76 | Tour stops (real / missing / bad data, including the air-quality stop), speed, Chinese and English captions with no `undefined` / `NaN`, gap years, honest dust and air-quality notes, restore and every kind of interruption, looping, preferences, mirroring; presenter controls (jump / previous / next / pause and resume / start stop and hold), spoken captions (fake speech) |
| `src/lib/inspect.test.mjs` | 41 | Data source cards: screen-space picking, tap detection, station / moon / bird card data, card placement, content-based dwell time |
| `src/lib/pointerExpr.test.mjs` | 17 | Stylus pressure → wave energy, tilt → current, dead zone, iOS `altitudeAngle` / `azimuthAngle` fallback |
| `src/lib/audience.test.mjs` | 46 | Audience-window protocol (fake BroadcastChannel): snapshots / increments, throttling, disconnect detection, self-healing, screen selection |
| `src/lib/mirror.test.mjs` | 2 | The mirror-slice registry |
| `src/lib/gestures.test.mjs` | 56 | Gesture classification, hysteresis, cooldown, smoothing, mirror and left / right hand, lost-hand idle; the runtime with a fake camera (including releasing the camera when the tab is hidden, no camera left open on quick tab flips, and back-off when inference is slow); `package.json` matches the WASM version |
| `src/lib/voice.test.mjs` | 26 | Speech-recognition wrapper: lifecycle, automatic restart, failure back-off, `stop()` cleanup, language switching (fake recognizer) |
| `src/lib/voiceCommands.test.mjs` | 53 | Transcript normalization, Chinese / English synonym matching (including mis-hearings and simplified characters), de-duplication and cooldown, command actions |
| `src/lib/haptics.test.mjs` | 42 | Event pattern table, strength scaling, cooldowns and global cap, defaults and persistence, gamepad dual-rumble (fake devices) |
| `src/lib/quality.test.mjs` | 25 | Graphics-quality state machine: downgrade / upgrade, hysteresis, cooldowns, flap protection, warm-up, manual lock, preference serialization |
| `src/lib/qualityRuntime.test.mjs` | 18 | Graphics-quality runtime: rAF feeding, pause reasons (hidden tab / recording / video capture / dragging), `?quality=` override, `stop()` releasing every listener; the audience window downgrading itself without writing the shared preference, and the main window's quality mode mirrored to it |
| `src/store/hud.test.mjs` | 1 | The parameter HUD label follows the language |
| `src/services/tourCore.test.mjs` | 47 | Tour × real input paths (the real `useStore` / `activity` / `createTourRunner`): MIDI knobs and transport keys, voice, phone remote, wheel and Marker all restore first and then act; a hidden tab stops the tour; idle timing; haptics muted during the tour; the decision logic for the presenter keys `←` `→` `P`; a per-stop link starting exactly once |
| `src/store/rec-stash.test.mjs` | 5 | A user's recording survives data playback and a whole tour (fails if the stash logic is removed) |
| `src/store/survey.test.mjs` | 5 | Bird / fish links brought by a share link are never persisted; the data-playback log reports real survey years |
| `src/lib/wakeLock.test.mjs` | 6 | Screen wake lock: called as a method, no leak when released before the request resolves, re-requested on return to the foreground |
| `src/audio/mic.test.mjs` · `src/lib/ar.test.mjs` | 3 · 4 | Mic / AR camera: repeated taps during the permission prompt, cancel and failure never leave an orphan stream |
| `src/lib/modalFocus.test.mjs` | 10 | Dialog focus management: focus moves in, Esc, Tab cycling, focus returns to the opener, global hotkeys ignored inside the dialog |
| `src/lib/shareLink.test.mjs` | 6 | Copying the share link (clipboard unavailable → manual copy) and where the share result message sits |
| `src/lib/describeGaps.test.mjs` | 4 | The bird / fish rows of the data board and log mark survey gaps |
| `src/lib/captionCss.test.mjs` · `scripts/vite-config.test.mjs` | 3 · 9 | Caption layout rules (above the QR, larger in the audience window) · build configuration: chunking (the entry never pulls in three), the build id and the `version.json` plugin, `__BUILD_ID__` injection, `main.jsx` wrapping the error boundary (plus 1 dist check that runs only with `MIDISEA_VERIFY_DIST=1` and is skipped by default) |
| `src/lib/xr.test.mjs` | 37 | WebXR: feature detection (fake `navigator.xr`), placement maths, hit-test tracking, state machine idle → requesting → placing → placed → ended, error and system-interruption exits, repeated enter / exit |
| `src/lib/urlFlags.test.mjs` | 2 | URL flags (?kiosk / ?audience) behave the same everywhere: `=0` / `false` / `off` switch them off, and the tour and the audience window share one function |
| `src/lib/diagnostics.test.mjs` | 55 | Diagnostics page: the 25 quick checks (fake `navigator` / `window`), resource release by the interactive probes (tracks / recognition / `AudioContext` / timers / listeners), the report (Markdown + JSON) and privacy filtering, fake objects that check `this` (a detached native call turns the test red) |
| `src/lib/air.test.mjs` · `scripts/gov/air.test.mjs` | 13 · 20 | Air quality: data → playback series / mapping / board and HUD text (Chinese and English, the "model data" label, no display anywhere calls it government data) / `playAir`; the fetch side's request URL, validation, hourly parsing, history merge with de-duplication and the 120-row cap, option parameters, keeping old data on failure; checks against the real `ocean.json` |
| `src/lib/resilience.test.mjs` | 72 | Exhibition safeguards: URL flags → configuration, the crash log (ring / de-duplication), back-off 5 → 15 → 60 s and the 5-in-10-minutes circuit breaker, several fatal events at the same instant merging into one, the watchdog, WebGL context-loss recovery, the version check and data update (busy / idle), the daily reload, the ErrorBoundary and the Operations panel; the default environment works under the browser's `this` rules |
| `src/lib/layoutPrefs.test.mjs` | 16 | System-event monitor: width-based default, preference read / write, `?log=` priority, following the window across 820 px, falling back to the default when `localStorage` is unavailable, the footer's latest OUT event and throttling |
| `src/lib/onboarding.test.mjs` | 47 | Quick tour: when it shows by itself (including `?onboard=`, `?kiosk`, `?tourstop=`), the keys it remembers, spotlight and card placement geometry, the state machine and keyboard, focus in and out, the `InfoZh` / `InfoEn` structure lining up one to one |
| `src/lib/cameraFit.test.mjs` | 28 | View fitting: the factor per aspect ratio (always 1 on wide screens, bit for bit unchanged), the camera state machine (first frame placed, recomputed only when the size changes, `?fit=0`), real projection with three's `PerspectiveCamera`, constellation and star-shell layout |
| `src/lib/tourLink.test.mjs` | 18 | Per-stop links: parsing `?tourstop=` / `?tourhold=`, building links without carrying other flags, round trip, copying to the clipboard (falling back to the old method on failure) |
| `src/lib/narration.test.mjs` · `src/lib/echoGuard.test.mjs` | 45 · 3 | Spoken captions (fake `speechSynthesis` / fake timers): `speak` finishing / cancelling / erroring, voice choice, making units and symbols speakable · echo guard: voice commands ignored while speaking and for a short time afterwards |
| `src/audio/timing.test.mjs` | 3 | Overflow drip schedule times only ever increase (so Tone.js never throws "time must be >= last scheduled") |

Total: **954 tests** (`node --test`: 953 pass and 1 is skipped, the dist check that runs only with `MIDISEA_VERIFY_DIST=1`; 41 test files, including the 37 WebXR tests in the table above).

A limit of unit tests: Node cannot see browser-only errors (for example an `Illegal invocation` caused by `this` binding), so each new feature still has to be run once in a real browser, which is why the "Verification status" section exists.

---

## Project structure

```text
IXD2026/
├─ README.md · README.en.md · SPEC.md   # docs (Chinese / English) · full spec (with Mermaid)
├─ index.html · package.json · vite.config.js   # vite.config.js also holds the version.json plugin (emits dist/version.json and injects __BUILD_ID__)
├─ .github/workflows/                   # deploy.yml (GitHub Pages) · refresh-data.yml (scheduled ocean.json refresh)
├─ public/                              # data/ocean.json (data snapshot) · sw.js · manifest · icons · CNAME
├─ tools/midi-monitor.html              # MIDI monitor (measure CC / Note, export the mapping)
├─ scripts/
│  ├─ fetch-ocean-data.mjs              # CI refresh: weather / tide / dust / moonrise & moonset / air quality (each in try/catch; failures keep the old data)
│  ├─ bake-static-data.mjs              # one-off bake: station list / fish survey / yearly birds (idempotent)
│  ├─ tide.mjs                          # tide public-file parser
│  ├─ gov/                              # one pure module per dataset + offline tests (node --test); air.mjs = Open-Meteo air quality (modeled data)
│  ├─ i18n-check.mjs                    # static i18n scan (Babel AST): unwrapped Chinese literals, missing English keys
│  └─ i18n-report.mjs                   # entry point of `npm run i18n` (calls i18n-check)
└─ src/
   ├─ main.jsx                          # entry: main App / phone remote (#remote=) / diagnostics page (?diagnostics=1) / audience window (?audience=1), one of the four, wrapped in ErrorBoundary
   ├─ App.jsx · AudienceApp.jsx · DiagnosticsApp.jsx · styles.css
   ├─ ErrorBoundary.jsx                 # outermost error boundary: countdown reload · back-off · circuit breaker · WebGL / watchdog notices (exhibition safeguards)
   ├─ hooks/useMIDI.js                  # Web MIDI connection + message parsing
   ├─ store/                            # useStore.js (single Zustand source of truth: parameters / bindings / recording / soft-takeover) · activity · events · hud · stats
   ├─ params/registry.js                # parameter groups + default bindings
   ├─ audio/                            # engine.js (generative Tone.js ambience) · mic.js (mic = wind) · bus.js · timing.js (overflow drip schedule times)
   ├─ remote/RemoteApp.jsx              # phone remote page (lightweight, does not load three)
   ├─ i18n/                             # languages
   │  ├─ index.js                       # t / T / useT / useLocale / setLocale
   │  ├─ data.js                        # data-layer name translation (reservoirs / basins / lunar dates / tidal range…, pure functions)
   │  ├─ GLOSSARY.md                    # English glossary shared by every translator
   │  ├─ i18n.test.mjs                  # acceptance tests
   │  └─ en/*.js                        # English dictionaries: one file per feature, merged at build time
   ├─ services/                         # resident services (mounted once by Services.jsx): Audience / Gesture / Voice / Haptics / Quality / Tour / Resilience (tourCore.js = the non-React wiring of the tour, testable in Node)
   ├─ lib/
   │  ├─ persist.js                     # localStorage / sessionStorage (every preference key lives here)
   │  ├─ share.js                       # parameters ↔ share URL, data context (?s= &o= &m= &sl= &lang=), captions and layout
   │  ├─ capture.js                     # share card / video recording (composites the camera background in AR view)
   │  ├─ ar.js                          # camera background · ambient light sampling · filters
   │  ├─ series.js · describe.js        # data → playback series (including the yearly survey series / gaps) and output text (pure functions)
   │  ├─ govdata.js · moon.js · birds.js  # load ocean.json · moon phase and moonrise / moonset position · bird seasons
   │  ├─ tour.js · tourLink.js          # data tour: stops / captions / runner / presenter controls (pure logic) · per-stop links (?tourstop=) and copying
   │  ├─ narration.js · echoGuard.js    # spoken captions (speechSynthesis wrapper, making units speakable) · echo guard (voice commands ignored while speaking)
   │  ├─ inspect.js · pointerExpr.js    # data source cards · stylus pressure / tilt
   │  ├─ diagnostics.js · diagnosticsSummary.js   # diagnostics page: check registry / probes / report · a small summary module the Devices panel reads (does not pull in the diagnostics body)
   │  ├─ resilience.js                  # exhibition safeguards: URL flags → config · crash log · back-off and circuit breaker · watchdog · WebGL recovery · version check · data update · daily reload
   │  ├─ layoutPrefs.js · onboarding.js · cameraFit.js   # system-event monitor preference · quick tour (steps / geometry / state machine) · automatic view fitting (pure functions)
   │  ├─ urlFlags.js                    # the shared judgement of URL flags (?kiosk / ?audience / ?diagnostics …)
   │  ├─ mirror.js · audience.js        # mirror-slice registry · audience-window protocol (BroadcastChannel)
   │  ├─ wakeLock.js · modalFocus.js · shareLink.js · remoteDispatch.js   # screen wake lock · dialog focus management · copy link (with manual-copy fallback) · phone-remote message dispatch
   │  ├─ gestures.js · hands.js         # camera gestures: classification and state machine · camera + MediaPipe runtime
   │  ├─ voice.js · voiceCommands.js    # speech-recognition wrapper · command table and matching
   │  ├─ haptics.js                     # haptics (phone vibration / gamepad dual-rumble)
   │  ├─ xr.js                          # WebXR tabletop: feature detection · placement maths · hit-test · state machine (pure logic, loaded on demand)
   │  ├─ quality.js · qualityStore.js · qualityRuntime.js   # automatic graphics quality: state machine · shared state · runtime
   │  ├─ midiRoute.js · blemidi.js · multiplayer.js · sensors.js · ice.js   # MIDI routing · Bluetooth MIDI · Jam · phone sensors · WebRTC ICE
   │  └─ *.test.mjs · tourTestEnv.mjs   # unit tests (next to the module they test) · a fake environment for the tour tests (fake timers / clipboard / speech)
   ├─ ui/                               # TopBar · ParamPanel · Monitor · Footer · Splitter · DataCard · DataBoard · DataHUD · SurveyTimeline
   │  │                                 # TourControls · TourCaption · TourNav · Onboarding · InspectCard · KioskQR · InfoModal · MultiModal · DevicesModal · XrOverlay …
   │  ├─ devices/                       # sections of the Devices panel: AudienceSection · GestureSection · VoiceSection · HapticsSection · QualitySection · XrSection · DiagnosticsSection · OpsSection
   │  └─ info/                          # Help dialog body: InfoZh.jsx · InfoEn.jsx (maintained as a pair)
   ├─ styles/                           # per-feature CSS (air · audience · diagnostics · gestures · haptics · inspect · monitor · onboarding · quality · resilience · timeline · tour · tourpresenter · voice · xr)
   ├─ scene/Scene3D.jsx                 # R3F 3D sphere
   ├─ scene/XrRuntime.jsx               # R3F runtime for WebXR (loaded only when a session exists)
   └─ timeline/scenes.js                # scene presets
```

---

## Tech

React + Vite · Three.js + React Three Fiber · Zustand · Web MIDI API · Tone.js · cannon-es · PeerJS (WebRTC) · MediaPipe Tasks Vision (camera gestures, loaded dynamically) · Web Speech API (voice-command recognition and speech synthesis for spoken tour captions) · BroadcastChannel (audience window).

**Performance design**: the 3D scene reads parameters with `useStore.getState()` inside the render loop, so high-frequency MIDI messages never trigger a React re-render; the recording buffer and the soft-takeover state live at module level so that not every message repaints. The phone remote page and the audience window each load only the code they need (the remote page's entry depends on react only, about 80 KB gzip, with no three / scene / store; the main page and the audience window preload the 3D scene straight away); MediaPipe loads only when someone switches camera gestures on; and while no audience window is connected and gestures / voice are off, the matching services do no work at all.

**Dev aid**: in dev mode you can drive tests from the console with `window.__store`.

---

## Data and license

Government Open Data License, version 1 (OGDL v1). For the full data sources and schema, see [SPEC.md](./SPEC.md) (in Chinese).

**Open-Meteo (CC BY 4.0, credit required)**: the "Air quality" data and the weather fallback come from [Open-Meteo](https://open-meteo.com/), licensed CC BY 4.0; you must credit "Weather data by Open-Meteo.com" and link to <https://open-meteo.com/>. The data card's air-quality block carries that credit, and its link points to the Open-Meteo Air Quality API documentation page (`https://open-meteo.com/en/docs/air-quality-api`, taken from `air.sourceUrl` in `ocean.json`); `air.note` states the attribution as well. Air quality is CAMS global atmospheric model data, **not government observations**, and OGDL v1 does not apply to it. Open-Meteo's free API is for non-commercial use only; this project only calls it from CI, once every 3 hours (the browser never calls it directly), and commercial use later would need a paid plan.

**Data pipeline**: `public/data/ocean.json` is a build-time snapshot (Water Resources Agency reservoir status + 24 h inflow series + weather + river water level + bird / fish surveys + dust + station list + moonrise & moonset + Open-Meteo air-quality model data). GitHub Actions runs `scripts/fetch-ocean-data.mjs` every 3 hours (and again just after midnight in Taipei) to refresh it and commit it automatically, and **then dispatches the deploy workflow itself** (by GitHub's design, a push made with `GITHUB_TOKEN` does not trigger other workflows). The historical static data (station list / fish survey / yearly birds) is baked once by `scripts/bake-static-data.mjs`, and CI leaves it untouched.
- **The tide series updates daily with no key**: it fetches the CWA F-A0021-001 "tide forecast" public file (the coming month, 266 locations), takes the Hualien City high / low tide events (chart datum) and cosine-interpolates them into today's 24 h tide level; the previous day's tail events from the last saved run are merged in so the start of the curve is accurate (on the very first run the head is filled by mirroring the neighbouring half-cycle). With a `CWA_KEY` it uses the official datastore API instead (the same data); if both fail, the old series is kept.
- **Air quality needs no key**: on every refresh `scripts/fetch-ocean-data.mjs` fetches Open-Meteo's hourly data with `past_days=5`, merges it with the old data, de-duplicates and keeps only the latest 120 hours; if fetching fails the old data is kept. The Ministry of Environment's air-quality API needs a key you apply for yourself and is not wired in (an optional follow-up; see "Datasets → visuals").
- Add `CWA_KEY` (the authorization code you request from the [CWA Open Data Platform](https://opendata.cwa.gov.tw/)) under the repo's **Settings → Secrets and variables → Actions** and weather also comes from CWA observation stations (a government source); without it, weather falls back to Open-Meteo automatically.

**Privacy overview**: there is no backend and no accounts, and the code contains no analytics tracking (no Google Analytics or similar scripts). Camera video and microphone audio are never recorded or uploaded by this site (in Chrome and Edge the browser itself sends speech audio to a cloud recognition service; see "Voice commands"); preferences and recordings stay in your own browser's localStorage / sessionStorage. The first time camera gestures are switched on, the app downloads the model and runtime from jsDelivr and Google storage (download only, no upload). "Jam" uses PeerJS's public signalling server to set up the WebRTC connection, and when NAT or venue Wi-Fi blocks a direct connection it relays through a public TURN server (`openrelay.metered.ca`, see `src/lib/ice.js`); only slider values and trigger events pass through, never video or audio.

**Privacy of this round's features**: every check on the device diagnostics page runs inside your browser, and the report is generated only when you press "Copy" or "Download" and contains no personal data, IP address, images, audio or device names; the crash log stays in this device's localStorage (`ixd2026.crashes`) and is never uploaded; the quick tour, the system-event monitor and view fitting only keep a preference locally or do a local calculation; spoken tour captions are handled by the browser's speech synthesis and this site sends no text anywhere (whether a browser that picks a cloud voice goes online is up to the browser and the system). The version check and the automatic data update only send requests to this site's own `version.json` and `data/ocean.json`.
