# MidiSea Data Director — IXD2026

[繁體中文](./README.md) | **English**

Live: <https://midisea.shyetech.com> · IxDA Taiwan 2026 member workshop "AI Symbiosis Hackathon" · Team 12, Kagabulie Island (卡加布列島)

Play a sphere of sea. With two **KORG nanoKONTROL2 / nanoPAD2** MIDI controllers (or a mouse, touch, a phone remote, a gamepad, camera gestures or your voice) you perform a **3D sphere that has become an ocean**: a calm deep sea inside a transparent shell, with jellyfish, fish schools, whales, dolphins, turtles and floating trash, and a sea that slowly turns into words and numbers. The sea is driven by Taiwan **government open data** (Water Resources Agency and Central Weather Administration; datasets explored through [Twinkle Hub](https://hub.twinkleai.tw/zh-TW)). Every parameter can be bound with MIDI Learn, recorded and replayed, shared as a link, and captured as a video. The interface comes in **Traditional Chinese and English**.

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
| Data tour | Press **`T`**, click "Start tour" on the Data tour card, or leave the app idle for 30 seconds. It steps through seven stops (today's reservoir → Hualien tide → moon → Yunlin dust → birds → fish → river-station constellation), with large captions below the sphere explaining from real data what you are looking at and why the sphere looks that way, including honest notes about data limits. A full lap takes about 100 seconds, and touching anything stops it and restores your sea. See "Data tour". |
| Tap for data source | Tap a gauging-station star, the moon or a bird flock in the background and a card opens beside it with its source, values and status. See "Data source cards and stylus". |
| Stylus | Drag the sphere with an Apple Pencil, Surface Pen or Wacom pen: pressure adds wave energy and pen tilt steers the current (only for `pointerType === 'pen'`; `?pen=0` turns it off). |
| Jam (multiplayer) | Press "Jam" to show a QR code; a phone that scans it becomes a remote (PeerJS WebRTC, short IDs so the QR stays small and easy to scan). Each phone gets a part (Ocean / Life / Mood / Free), and its sliders stay in sync with the main screen every second. **Phone sensors**: once enabled, tilt = current direction and shake = surge (over the same wire protocol). Everything goes through the same `input()` path, so it can be recorded and picked up softly. If the host loses the signalling server it reconnects with the same ID, or rebuilds under a new one if that ID is taken. |
| Devices panel | The "Devices" button at the top gathers the optional device features: **Audience window** (dual screen), **Camera gestures**, **Voice commands**, **Haptics** and **Graphics quality**. The camera and microphone are only used while you switch them on, and video and audio are never uploaded. See "Devices panel". |
| Real data | Reservoir water level % **is** the sea level (full reservoir = full sphere; above 97% liquid spills over the rim and leaves a puddle at the bottom). Shimen, Deji and Zengwen come with 24 h inflow, and **Hualien offshore comes with CWA tide** series. Press "Play data" to make the sphere rise and fall with the real data (**speed x0.5–x4, looping**; a HUD at the top shows the data time and values). There are also "**Dust · Yunlin County**" and "**Moon · Hualien**" seas; all datasets are listed under "Datasets → visuals" below. |
| Milky Way × rivers | A band of Milky Way in the background whose density follows the **live river water level from the Water Resources Agency** (5 stations, ratio to the warning level): plenty of water, brighter galaxy. |
| Birds / fish × surveys | The number of line-art bird flocks outside the sphere = the "Bird flocks" parameter (0..1 → 0..5 flocks); fish schools use "Fish schools". The data card shows that basin's **monthly species-count bars** (hatched = interpolated, click a bar to preview a month, the current month is marked) and a suggested value. You can "**Apply data**", turn on "**Link**" (updates when you change sea or month), or drag the slider for "**Independent**" control (dragging unlinks it automatically and the "data" tag on the parameter row disappears). Each basin also has a **survey timeline** you can play: every step is one calendar year, the count follows that year's species count, and years with no survey are marked "no survey" and filled in by interpolation. Note (honest data disclosure): each basin has surveys in only some months / years (each month covers only 1–3 survey years, close to a single-year snapshot rather than a climate average), only months with enough records are kept, and missing months are filled by **circular interpolation** from neighbouring months and marked "interpolated". See "Survey timeline". |
| Moon × tide | With a tide sea, a moon appears in the background: its **phase = that day's moon age (derived from the CWA lunar date, from the same source as the tide)** and its position = a sky arc set by the transit time and the current time (new moon at noon, first quarter at dusk, full moon transiting at midnight). While 24 h of tide plays, the moon really rises and sets, and the HUD shows high / low tide marks, lunar date, tidal range and phase. The separate "**Moon · Hualien**" sea places the moon at its real bearing and altitude using the CWA A-B0063-001 moonrise / transit / moonset times, rise / set **azimuths** and transit **altitude** (idle = today, interpolated to the current time; "Play moonrise & moonset" moves one day per step, showing the moon's position and phase at 21:00 each night; a higher transit raises the sea, which is illustrative). |
| Data board · data in the output | The "Data board" at the top left of the canvas lists the real data behind the current sea and how it is mapped (reservoir / tide / dust / weather / birds / fish / rivers / stations; off by default on phones). The **OUT monitor** prints "Data …" rows when a sea is applied and a "DATA …" line for **every step** of data playback; the Snapshot image carries the data rows too; the exported log includes them. |
| On-canvas info panels | The info panels on the canvas come in three groups you can hide independently: **Data board**, **Playback & parameter hints** (data playback progress, parameter values, pick-up hints, AR adjustment buttons, sound hints, tour captions, data source cards) and **QR & stats** (Stage mode). The "Info" button at the top, or the **`I`** key, hides / shows them all at once (press again to restore the previous combination); the board has an **×** at its top right; the "Overlays" checkboxes on the data card toggle the three groups; the choice is stored in localStorage. URL overrides `?hud=0` (board + hints), `?board=0` and `?qr=0` are meant for exhibitions and recording and never overwrite the saved preference. Hidden panels are unmounted, so they do not keep animation loops running. The camera and voice "in use" badges are privacy indicators: **they ignore this switch and always show**. |
| Background blur / clarity | Two sliders in "VIEW" (MIDI Learn, recording and phone remote all work): they **only affect the background** (stars / Milky Way / shooting stars / moon / station constellation; in AR view, the camera image) while the sphere and creatures stay sharp. Implementation: the background sits on layer 1 → draw it first → copy the frame → Kawase dual filter (multi-level down / up sampling, close to Gaussian without ghosting sparse stars) → composite back (with clarity) → draw the foreground on top. The default costs nothing extra, and it degrades gracefully when the GPU cannot do it; at Low graphics quality a simple darkening is used instead (see "Graphics quality"). |
| Sound on by default | Browsers only allow audio after a user gesture, so "on by default" means **it starts automatically on your first click / touch / key press** (a hint reads "click anywhere to turn on sound"). After you mute it with "Sound" that choice is remembered. For an unattended exhibition, click once first or start Chrome with `--autoplay-policy=no-user-gesture-required`. |
| Phone UI | ≤820 px: the top bar splits into transport / scene / a **horizontally scrollable toolbar** (no wrapping, touch targets ≥40 px, priority order: Sound → Share → Jam → AR view…), two-row parameter rows (the slider gets its own row), large touch sliders, 16 px `select` (iOS will not zoom in), only the OUT monitor is kept, and the canvas defaults to 40%. On desktop, 821–1400 px tightens the spacing to stay on one row. |
| Physical trash | cannon-es rigid bodies: bottles and bags float on the surface, collide, get pushed by the current and **pushed away by the cleansing wave**. |
| AR view | "AR view" uses the camera as the background so the sphere floats in the real world. The **blur / clarity sliders only affect the background** while the sphere renders as usual. **Ambient light sensing**: every 0.6 s the average brightness of the camera image adjusts the sphere's glow automatically (bright surroundings → strong glow, dark → subdued; pausing for 8 s after you adjust glow by hand, and it can be turned off). |
| Marker snapshots | nanoKONTROL2 Track ◀▶ = previous / next scene; Marker Set = store the current state as a snapshot (up to 8), Marker ◀▶ cycles through them. |
| Exhibition mode | `?kiosk=1` goes straight to Stage mode (no help dialog) **with the idle auto data tour on**, plus a **small QR code that stays in the corner** (no dialog needed; visitors scan as they pass; it restarts and redraws on its own after a disconnect or when the machine boots offline) and the stats "Jam N · Plays M". Add `&hud=0` (no info panels) or `&qr=0` (no QR). Combine it with the **Audience window** in Devices to fill a projector with the same sea. |
| Scene colors | Each scene has its own hue (cyan-blue / purple-pink / teal / murky green / blue-green); waterline, particles, atmosphere and fog shift together, and "Sea hue" is a playable parameter. **Sea color correction**: `setHSL` now reads its values as sRGB (the fourth argument `THREE.SRGBColorSpace`), so the background and fog changed from a washed-out slate to a deep blue sea close to the design (about `#050e1c` at night, `#08162b` by day) and the waterline keeps about 85% of its brightness. At extreme hue values (0 / 1) the background turns dark green / dark plum. |
| Gamepad / compass | Left stick = current direction, right stick = spin and sea level, A/B/X/Y = summon; gamepads can give **rumble feedback** (see "Haptics"); on a phone, turning your body (compass >8°) turns the current. |
| PWA | An "Add to Home Screen" prompt and a "click to update" toast when a new version deploys; works offline. |
| Video recording | Captures the sphere for 10 seconds and downloads **MP4 / WebM** (in AR view: "camera background + sphere"). |
| Export log | Downloads the IN/OUT message log for debugging. |
| Comfort ambient sound | Generative Tone.js ambience: sea level = root note Hz, clarity = brightness, current = wave speed, glow = space, trash = detune, fish × swim speed = accent notes, whales / dolphins / turtles = calls, pads = scale (press "Sound" to turn on). The **cleansing wave → a bright major pentatonic arpeggio** (always major, however murky the sea is), and **overflow (level >97%) → water drips** (random left / right, at most about 3 per second). |
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
| `?` | Open Help | |
| `Space` | Play / stop playback | When a button has focus, the button keeps its native behavior |
| `R` | Start / stop recording | Same button rule |
| `1` `2` `3` `4` | Whale / dolphin / turtle / clear trash (cleansing wave) | Same button rule |
| `Esc` | Stop the data tour and restore your sea; close a data source card | |
| Arrow keys | Fine-tune a control after selecting it on the virtual controller (±0.05 per press) | |
| `Enter` / `Space` | On a focused parameter name: start MIDI Learn (`Shift` held: unbind) | |

While an input or a select has focus, the global shortcuts are ignored. During a data tour, any key other than `T`, `H`, `I`, `?`, modifier keys and `Tab` stops the tour and restores your sea.

---

## URL parameters

| Parameter | Value | Effect | Notes |
|---|---|---|---|
| `?s=` | base64url | Visual settings (each parameter quantized to 1 byte, in `PARAM_ORDER`) | Produced by "Share"; the positional encoding must not change because old links depend on it |
| `&o=` | Sea id, e.g. `feitsui`, `shimen`, `deji`, `zengwen`, `nanhua`, `hualien-tide`, `dust-yunlin`, `moon-hualien` | Opens with that sea selected | Unknown ids are ignored |
| `&m=` | `0`–`11` (0 = January) | Survey month previewed by hand | Only included if the sharer picked one |
| `&sl=` | `b0f0`, `b0f1`, `b1f0`, `b1f1` | Whether birds (b) / fish (f) follow the survey data, e.g. `b1f0` = birds linked, fish independent | Applied temporarily; never written to the recipient's saved preferences |
| `?lang=` | `zh` or `en` (case and region codes tolerated, e.g. `en-US`, `zh-TW`) | Interface language | Beats the saved preference and the browser language; not saved; the URL follows when you press the language button |
| `?kiosk=1` | — | Exhibition mode: straight to Stage mode, no help dialog, corner QR, idle auto tour on (turn it off with `?tour=0`) | Only the presence of the parameter is checked, so `?kiosk=0` also enables exhibition mode |
| `?hud=0` | `0` | Hide the Data board and the Playback & parameter hints | For exhibitions and recording; not saved |
| `?board=0` | `0` | Hide only the Data board | Same |
| `?qr=0` | `0` | Hide the exhibition QR and stats | Same |
| `?tour=` | `0` or `1` (`off` / `on` also work) | Force the idle auto tour off / on | Priority: `?tour=` > `?kiosk` > saved preference > default (on) |
| `?audience=1` | `1` | Audience window mode (no controls, no sound, follows the main window) | Normally opened from the button in Devices; opened by hand it waits for a main window |
| `?pen=0` | `0` | Turn off stylus pressure / tilt | No switch in Devices; this parameter is the only way |
| `?fps=1` | `1` | Show a small FPS readout at the bottom left of the canvas (debug) | Without it the canvas shows no FPS at all |
| `?quality=` | `auto`, `high`, `medium`, `low` | Force a graphics quality for this visit | Not saved; choosing in the panel saves a preference |
| `#remote=<id>` | hash (not a query) | Phone remote page (from the "Jam" QR code) | Generated by the main screen |

Examples:

```text
https://midisea.shyetech.com/?kiosk=1&lang=en&hud=0                  exhibition (English, no info panels)
https://midisea.shyetech.com/?s=…&o=zengwen&m=8&sl=b1f0&lang=zh      a link made by "Share" (&m=8 is September)
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

Besides the visual settings it includes the sea you picked (reservoir / tide / dust / moon), the month you previewed by hand, whether birds and fish follow the survey data, and the interface language. Whoever opens it sees the same picture and data context (load order: sea option → month → bird / fish link → visual settings → language; the visual settings go last so sea presets never overwrite them).

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

So that visitors who cannot operate the sphere can still follow it, the app walks through the real data on its own, one stop at a time, and explains each one in captions.

**How to start**: press **`T`**; click "Start tour" on the Data tour card in the panel (it comes right after the data card); or leave the app idle for 30 seconds (on by default; untick "Auto tour after 30 s idle" on the card to turn it off, which is remembered in the browser; `?kiosk=1` turns it on by default, and `?tour=0` / `?tour=1` force it off / on and win over both the preference and `?kiosk`).

**Seven stops** (a stop with no data is skipped; in AR view the moon and constellation stops are skipped because you cannot see them; a full lap is about 99 seconds):

| Stop | Content |
|---|---|
| Today's reservoir | Water level % → sea level |
| Hualien tide | 24 h of tide plays; the caption gives the tidal range (spring / neap tide…), lunar date and moon phase |
| Moon | The moon moves across the sky; the caption gives today's moonrise and moonset |
| Yunlin dust | PM10 → water murkiness. When the PM10 sensor is invalid the caption honestly says wind speed is used instead; a frozen source and collecting history are called out too |
| Birds | The survey timeline plays year by year; the caption lists the years with no survey (interpolated) |
| Fish | Same as birds (e.g. Zengwen: no survey 2007–2013) |
| River-station constellation | The 188 river gauging stations |

**On screen**: large captions below the canvas (a one-line title plus up to two lines of explanation, fading in and out, with progress dots n/N). The captions store data only and are translated when shown, so switching language mid-tour changes them at once. They belong to the "Playback & parameter hints" group (with `I` off the captions are hidden but the tour keeps running).

**Interrupting and restoring**: before the tour starts, your parameters, sea option and playback speed are remembered. Touching the screen, moving a knob or slider, or pressing any key other than `T`, `H`, `I`, `?`, a modifier or `Tab` stops the tour at once and restores the sea you had (`Esc` or `T` again also stop it). Switching language, Share, Snapshot, Rec video, Info, Help, Sound and Export log do not count as interruptions. If you start recording, press play yourself or change the sea, the tour only stops and nothing is restored. A recording you had stashed is kept, and the tour does not inflate the "Plays N" counter in exhibition mode.

**Looping**: a tour you started by hand ends and restores after one lap; a tour started by idling keeps looping until someone acts. It never starts by itself while a dialog (Help / Devices / Jam) is open, and without sea data it falls back to the old hue-cycling attract mode.

**Privacy and permissions**: it only uses data that is already loaded, needs no permission and uploads nothing. The audience window shows the same captions (the tour only runs in the main window; the audience window never starts one).

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

## Devices panel

Opened with the "Devices" button at the top. It collects the **optional** device features; each section has its own switch and status text. The always-on logic lives in `src/services/*Service.jsx`. Nothing touches the camera or microphone until you switch it on, and nothing costs extra computation while it is off.

| Feature | Default | Permission needed |
|---|---|---|
| Audience window (dual screen) | Off (a button opens it) | For automatic placement on an external screen in Chrome / Edge: "Window management" |
| Camera gestures | Off (must be switched on explicitly) | Camera |
| Voice commands | Off (you press "Start listening"; always off after a reload) | Microphone |
| Haptics | On for touch phones, off on desktop, off when the system asks for reduced motion | None |
| Graphics quality | **Auto** (raises and lowers itself from the FPS; can be locked by hand) | None |

> Note: the graphics quality default is Auto, meaning the app measures FPS from the start and steps down by itself when the picture stutters (see "Graphics quality"). It is not "off by default".

### Audience window (dual screen)

- **How to open**: Devices → Audience window (dual screen) → "Open audience window". "Close audience window" asks that window to close itself. The panel shows how many audience windows are connected and how many screens were detected.
- **What it does**: perform on the laptop, show the audience on the projector. It opens a window (URL `?audience=1`) with no controls and no sound that shows the same sea full screen, including the data board, the data playback HUD, the tour captions and the data source cards. Parameters, data playback (speed / loop), whale / dolphin / turtle / cleansing wave triggers, pad effects, language and the info-panel switches in the main window all stay in sync live.
- **Permission and support**: in Chrome or Edge on HTTPS or localhost, the "Window management" permission (`getScreenDetails`) is requested; once allowed, the window is placed on the external screen automatically and one click in it goes full screen. In **Safari, Firefox, with a single screen, when the permission is denied, or on an insecure origin**, a regular window opens instead: drag it onto the projector and click it once for full screen. The first permission grant can expire the user gesture and get the pop-up blocked; the panel then says "press again".
- **Privacy**: data only moves between the two windows of the same browser over a BroadcastChannel (`midisea-audience`) and is never uploaded; while no audience window is connected the main window does no extra work.
- **Limits**: the audience window is a **copy driven by the same parameters and events, not a pixel-exact mirror**: jellyfish and fish positions, trash physics, sphere spin and the jelly dent are not synced. Both windows must share an origin (the same URL). If two control-panel tabs are open in one browser, the audience window locks on to the first main window that answers. When the main window's tab goes to the background (the browser throttles timers) the audience window may briefly show "Waiting for the main window…" and recovers on its own. A tab opened by hand (not by a script) may refuse to be closed by "Close audience window".

### Camera gestures

- **How to switch on**: Devices → Camera gestures → "Enable camera gestures". The camera permission is only requested after that.
- **What it does**: it watches your hand with the camera so you do not have to touch the screen.
  - **Open palm**: spread all five fingers and hold for about 0.5 s, and current speed, swim speed and trash ease down toward about 0.15 / 0.3 / 0.1 (nothing snaps back when you lower your hand, and other input can take over at once).
  - **Pinch**: pinching thumb and index summons a whale (at most once every 3 seconds; holding does not repeat).
  - Every other pose (fist, thumbs-up, peace sign, fingers together) is ignored; with no hand for more than 1 second it returns to idle. Classification uses only distance ratios and angles, so it works for either hand, a mirrored front camera and any rotation.
- **On screen**: a red-dot "Camera in use" pill at the top right of the canvas (**always visible**, it ignores `I`) and a "Gesture · detected: open palm / pinch / —" badge (which follows the info-panel switch).
- **Permission and privacy**: camera. Video is processed on this device only and is **never uploaded or recorded**; the camera stops when you switch it off or leave the page. With AR view on it shares the same camera stream; otherwise it opens a hidden front-camera 640×480 `<video>`.
- **What it downloads**: the first use downloads a hand model (about 8 MB, from Google storage) and a WebAssembly runtime (about 11.7 MB uncompressed, sent compressed from the jsDelivr CDN); the browser caches both. MediaPipe (`@mediapipe/tasks-vision`, pinned to 1.0.1) is loaded dynamically only when you switch gestures on, as a separate chunk outside the main bundle. These two requests show your IP address to the CDN but send no video. The service worker does not cache cross-origin resources, so **the first use offline fails** (the panel says so).
- **Support and limits**: needs HTTPS or localhost, `getUserMedia` and WebAssembly. Detection runs at about 15 fps on the main thread (GPU delegate, falling back to CPU), so older phones and iPads may drop frames (automatic graphics quality does not pause it); detection pauses while the tab is in the background. AR view uses the rear camera and gestures use the front one, and some Android devices cannot open two camera streams at once. **The classification thresholds were tuned on synthetic hand models, not with a real camera** (see "Verification status").

### Voice commands

- **How to switch on**: Devices → Voice commands → "Start listening", and allow the microphone when the browser asks.
- **Commands**: say "whale", "dolphin", "turtle", "big wave", "sparkle", "purify", "clean", "quiet", "faster" or "stop" and the matching effect fires. You can chain several ("whale, big wave"); the same command has a 1.5 s cooldown. A short "Heard: whale" note shows below the canvas. In Chinese the words are 鯨魚, 海豚, 海龜, 大浪, 亮星, 淨化, 清垃圾, 安靜, 快一點 and 停.
  - "Quiet" eases current, swim speed and trash toward calm values in one step (say it twice for calmer); "faster" moves current and swim speed toward high values; "stop" stops recording / playback.
  - The word lists are deliberately loose (they include common mis-hearings and simplified characters), so false triggers happen: for example 進化 ("evolve") also counts as "purify", 金魚 ("goldfish") also counts as "whale", and the English words "wave" and "star" alone are enough.
- **Recognition language** follows the interface language (Chinese `zh-TW` / English `en-US`), one at a time; switch the interface language first to speak the other one.
- **Permission and privacy**: microphone. In Chrome and Edge, speech recognition sends the microphone audio to a cloud service (Google / Microsoft) and **needs a network connection**; Safari follows the system settings. This site **never records, stores or uploads audio**. The recognizer is only created, and the permission only requested, after you press "Start listening"; while listening, a "Listening" badge stays at the top right of the canvas **at all times** (press its ✕ to stop at once); it pauses when the tab goes to the background and resumes when you return. It is independent of the toolbar "Mic" (blow = wind); you can use both (on a few phones one of them may stop working while both listen).
- **Support**: Chrome, Edge and Safari (Web Speech `SpeechRecognition` / `webkitSpeechRecognition`); **not Firefox** (the switch is disabled with an explanation).
- **Limits**: on Android Chrome each recognizer restart may play a system chime; iOS Safari has no true continuous mode, so it restarts often and may ask for permission repeatedly; Brave and Electron often return network errors (after 5 retries it disables itself). Alternating "Chinese + English at once" recognition is not implemented.

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

**Mobile notes**

- **iPad / iPhone (all iOS browsers)**: no Web MIDI, Web Bluetooth or vibration API. Use "Jam" and scan the QR code to make the phone a remote (WebRTC, no Bluetooth needed). Tilt / shake sensing asks for permission on first touch.
- **Android Chrome**: supports phone vibration and Web Bluetooth. AR view uses the rear camera and camera gestures use the front camera, and some models cannot open both streams at once, so one of them may fail.
- **Older phones and iPads**: camera-gesture inference runs on the main thread and may slow the picture; lock "Low" graphics quality.

---

## Verification status (honest disclosure)

The device and sensor features added in this round were written **without the matching real hardware at hand**. The table below lists what was verified and what was not, for whoever takes the project over and for the judges: **before an exhibition or a presentation, please run each of these on a real device.**

| Feature | What was verified | Not yet verified on real hardware / environments |
|---|---|---|
| Camera gestures | 49 unit tests (classification, hysteresis, cooldown, smoothing, mirror and left / right hand, lost-hand idle, and the runtime lifecycle with a fake camera and fake landmarks); the settings section was server-rendered in both languages | A real camera with real MediaPipe output. **The classification thresholds (`THRESH` in `src/lib/gestures.js`) were tuned on synthetic hand models** and will very likely need adjusting on real hardware; actual GPU / CPU delegate performance |
| Speech recognition | 79 unit tests (fake recognizer, command matching including mis-hearings and simplified characters, de-duplication and cooldown, restart back-off, language switching); the UI was only server-rendered | A real microphone with Web Speech: cloud recognition in Chrome / Edge, Safari; the accumulating transcript on Android (unit tests only); iOS Safari's continuous behavior; false triggers from the loose word lists |
| Dual screen (`getScreenDetails`) | 46 unit tests (protocol over a fake BroadcastChannel, throttling, disconnect detection, snapshot self-healing, screen selection); same-origin BroadcastChannel can be simulated with two tabs on one machine | A real external screen or projector; the "Window management" permission flow; user-gesture expiry and pop-up blocking around the permission prompt; full-screen behavior |
| Stylus | 17 unit tests (pressure → wave energy, tilt → current, iOS angle fallback) plus 39 data-source tests; the picking projection was checked in Node with three and the real `ocean.json` (all 188 stations land inside the canvas, 181 hit themselves, and the other 7 share exactly the same coordinates as another station); it can be simulated with synthetic `PointerEvent`s (`pointerType: 'pen'`) | A real Apple Pencil / Surface Pen / Wacom pen; whether iOS really only reports `altitudeAngle`; whether the natural grip tilt feels too sensitive |
| Gamepad rumble | 42 unit tests (fake gamepad / fake `vibrationActuator`, pattern table, strength scaling, cooldowns and the global cap) | Dual-rumble feel on real Xbox / PlayStation pads; detection behavior in Firefox / Safari |
| Android vibration | Same as above (fake `navigator.vibrate`) | The real feel and the strength difference on an Android Chrome phone (motors control only duration, not strength) |

Also verified only with unit tests, server-side rendering or offline calculation, without cross-device acceptance: the CSS layout of the tour captions and cards (including phone and Stage-mode widths), the visuals of the survey timeline (hatch contrast, label placement, layout at ≤400 px), the placement and clamping of the data source cards, automatic graphics-quality downgrades on real low-end devices, the Low-quality darkening compared with the High-quality color, and the final look of the sea color correction (the numbers are an offline calculation that already includes ACES tone mapping). The verification status of the older features (MIDI, Jam, AR and so on) is not assessed in this section.

**Hands-on verification checklist (for whoever takes over)**

1. **Camera gestures**: in Chrome open Devices → Camera gestures → allow the camera → the panel shows "On", and the canvas shows the red "Camera in use" pill; spread all five fingers for about 0.5 s → current speed / swim speed / trash ease down; pinch thumb and index → exactly one whale, not repeated within 3 s; fist / thumbs-up / peace sign → nothing; after switching off, the camera LED goes dark. If it triggers too hard or too easily, adjust `THRESH` (`spreadEnter`, `fingerReachEnter`, `thumbAwayEnter`, `pinchEnter`).
2. **Voice**: in Chrome open Voice commands → "Start listening" → allow the microphone → say whale, dolphin, turtle, big wave, sparkle, purify, clean in turn and the canvas should show "Heard: …"; "quiet" should lower the parameters and "stop" should stop playback; switch to Chinese and say the Chinese commands; with the microphone permission blocked, a permission message should appear and nothing else should be affected.
3. **Dual screen**: Chrome / Edge with an external screen (HTTPS or localhost) → "Open audience window" → allow "Window management" → the window should appear on the external screen and one click goes full screen; drag a slider, press 1–4 and play the tide in the main window and the audience window should follow at once; reloading either window should recover within seconds.
4. **Stylus**: drag on the sphere with an Apple Pencil on an iPad, or a Surface / Wacom pen: hard pressure should make clearly bigger waves than light pressure; tilting the pen to the right raises current direction X; with `?pen=0` nothing should happen.
5. **Gamepad rumble**: Chrome / Edge with a gamepad, press any button → Devices → Haptics should show "Gamepad: 1 detected, 1 supports rumble" → switch it on and press "Try haptics".
6. **Android vibration**: open the site in Android Chrome → Devices → Haptics is on by default and shows "Phone vibration: supported" → "Try haptics" should feel like a whale, a drip, the cleansing wave, a dolphin, a turtle and the recording cue in turn.

---

## Languages

The interface comes in **Traditional Chinese** and **English**. Switch with the language button at the top (it reads `EN` in Chinese mode and `中文` in English mode) or with `?lang=en` / `?lang=zh` in the URL. Order of precedence: URL `?lang=` > the saved preference (localStorage `ixd2026.lang`) > the browser language (`zh*` → Chinese, anything else → English). Switching does not need a reload: data names (reservoirs, basins, counties, weather, lunar dates, tidal range), logs, share captions, tour captions and the speech-recognition language all follow. Station and river names are proper nouns from the government data and stay in Chinese in the English interface.

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
- **The Help dialog body** (`src/ui/info/InfoZh.jsx` / `InfoEn.jsx`) contains inline markup (`<b>`, `<code>`), so it is not translated sentence by sentence but maintained as a pair: both files must have the same entries in the same order with the same facts. `InfoZh.jsx` is in `ALLOW_FILES` of `scripts/i18n-check.mjs`, so it may contain Chinese directly, while **`InfoEn.jsx` must not contain any Chinese characters** (the i18n test blocks that). To add a way to play, add one `{ id, body }` entry to the `PLAY` array in both files.

---

## Datasets → visuals

All of it is government open data (OGDL v1). The front end only reads the static `public/data/ocean.json`, which GitHub Actions refreshes on a schedule (there is no backend; the key lives only in a CI secret).

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

**Data limits (honest disclosure)**
- **Dust**: the IoW endpoint only returns the "latest reading". History is appended by CI every 3 hours (de-duplicated by the source timestamp, keeping the latest 120 readings ≈ 15 days), so right after deployment there is 1 reading and the data card says "collecting". Right now the PM10 sensors always return the sentinel 4999.4 (and there is an absurd air temperature of 1956.96 °C); the script treats them as invalid → `null`. The sea then uses a default PM10 = 40 μg/m³ as an illustration (the board says "PM10 invalid"), and history playback uses **wind speed** to drive the current and murkiness instead. The source can also freeze (the timestamp advances while the value does not).
- **Stations**: only a station directory exists (no flow time series); TWD97 two-degree zone coordinates are converted to relative coordinates and used only for the background constellation.
- **Moonrise & moonset**: by default the API returns only a short window, and other ranges need `timeFrom` / `timeTo` (at most 180 days per request; currently published: 2025-01-01 → 2027-12-31). CI takes a rolling window that starts 2 days before today and runs 180 days, and keeps the old window if fetching fails; the front end uses `from / to` to tell whether the window covers today, and when it does not, the idle moon falls back to an astronomical formula. Azimuth is measured from north at 0°, clockwise; each lunar month has one day with no moonrise or no moonset.
- **Fish / bird surveys**: most basins have only 4–5 valid months / years, and missing months are filled by circular interpolation from neighbouring months (marked "interpolated"); each month covers only 1–3 survey years, close to a single-year snapshot rather than a climate average. Hualien River bird counts for 2017–2019 are entirely empty (the timeline's individuals are blank). Species names are normalized (the literal "NULL", alias order). **The survey timeline is a dense yearly series**: one point per calendar year from the first to the last survey year; gap years with no survey are filled by linear interpolation between the neighbouring survey years and marked "no survey (interpolated)", which is illustrative and not observed data; averages and baselines use real survey years only.
- Water Resources Agency open data returns misplaced / empty / truncated content for about 1 in 4 **concurrent** requests, so the script always fetches sequentially and retries. The success rate from GitHub runners to WRA / CWA has not been measured in Actions; a failed dataset only keeps its old data and never affects the others.

**Tests**: see the next section (for data: `node --test src/lib/series.test.mjs scripts/gov/gov.test.mjs`, including a smoke test against the real `ocean.json`).

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
| `src/lib/tour.test.mjs` | 32 | Tour stops (real / missing / bad data), speed, Chinese and English captions with no `undefined` / `NaN`, gap years, honest dust notes, restore and every kind of interruption, looping, preferences, mirroring |
| `src/lib/inspect.test.mjs` | 39 | Data source cards: screen-space picking, tap detection, station / moon / bird card data, card placement |
| `src/lib/pointerExpr.test.mjs` | 17 | Stylus pressure → wave energy, tilt → current, dead zone, iOS `altitudeAngle` / `azimuthAngle` fallback |
| `src/lib/audience.test.mjs` | 46 | Audience-window protocol (fake BroadcastChannel): snapshots / increments, throttling, disconnect detection, self-healing, screen selection |
| `src/lib/mirror.test.mjs` | 2 | The mirror-slice registry |
| `src/lib/gestures.test.mjs` | 49 | Gesture classification, hysteresis, cooldown, smoothing, mirror and left / right hand, lost-hand idle; the runtime with a fake camera; `package.json` matches the WASM version |
| `src/lib/voice.test.mjs` | 26 | Speech-recognition wrapper: lifecycle, automatic restart, failure back-off, `stop()` cleanup, language switching (fake recognizer) |
| `src/lib/voiceCommands.test.mjs` | 53 | Transcript normalization, Chinese / English synonym matching (including mis-hearings and simplified characters), de-duplication and cooldown, command actions |
| `src/lib/haptics.test.mjs` | 42 | Event pattern table, strength scaling, cooldowns and global cap, defaults and persistence, gamepad dual-rumble (fake devices) |
| `src/lib/quality.test.mjs` | 25 | Graphics-quality state machine: downgrade / upgrade, hysteresis, cooldowns, flap protection, warm-up, manual lock, preference serialization |
| `src/lib/qualityRuntime.test.mjs` | 11 | Graphics-quality runtime: rAF feeding, pause reasons (hidden tab / recording / video capture / dragging), `?quality=` override, `stop()` releasing every listener |
| `src/store/hud.test.mjs` | 1 | The parameter HUD label follows the language |
| `src/lib/xr.test.mjs` | 35 | WebXR: feature detection (fake `navigator.xr`), placement maths, hit-test tracking, state machine idle → requesting → placing → placed → ended, error and system-interruption exits, repeated enter / exit |

Total: **468 tests** (`node --test`, including the 35 WebXR tests below).

A limit of unit tests: Node cannot see browser-only errors (for example an `Illegal invocation` caused by `this` binding), so each new feature still has to be run once in a real browser, which is why the "Verification status" section exists.

---

## Project structure

```text
IXD2026/
├─ README.md · README.en.md · SPEC.md   # docs (Chinese / English) · full spec (with Mermaid)
├─ index.html · package.json · vite.config.js
├─ .github/workflows/                   # deploy.yml (GitHub Pages) · refresh-data.yml (scheduled ocean.json refresh)
├─ public/                              # data/ocean.json (data snapshot) · sw.js · manifest · icons · CNAME
├─ tools/midi-monitor.html              # MIDI monitor (measure CC / Note, export the mapping)
├─ scripts/
│  ├─ fetch-ocean-data.mjs              # CI refresh: weather / tide / dust / moonrise & moonset (each in try/catch; failures keep the old data)
│  ├─ bake-static-data.mjs              # one-off bake: station list / fish survey / yearly birds (idempotent)
│  ├─ tide.mjs                          # tide public-file parser
│  ├─ gov/                              # one pure module per dataset + offline tests (node --test)
│  ├─ i18n-check.mjs                    # static i18n scan (Babel AST): unwrapped Chinese literals, missing English keys
│  └─ i18n-report.mjs                   # entry point of `npm run i18n` (calls i18n-check)
└─ src/
   ├─ main.jsx                          # entry: main App / phone remote (#remote=) / audience window (?audience=1), one of the three
   ├─ App.jsx · AudienceApp.jsx · styles.css
   ├─ hooks/useMIDI.js                  # Web MIDI connection + message parsing
   ├─ store/                            # useStore.js (single Zustand source of truth: parameters / bindings / recording / soft-takeover) · activity · events · hud · stats
   ├─ params/registry.js                # parameter groups + default bindings
   ├─ audio/                            # engine.js (generative Tone.js ambience) · mic.js (mic = wind) · bus.js
   ├─ remote/RemoteApp.jsx              # phone remote page (lightweight, does not load three)
   ├─ i18n/                             # languages
   │  ├─ index.js                       # t / T / useT / useLocale / setLocale
   │  ├─ data.js                        # data-layer name translation (reservoirs / basins / lunar dates / tidal range…, pure functions)
   │  ├─ GLOSSARY.md                    # English glossary shared by every translator
   │  ├─ i18n.test.mjs                  # acceptance tests
   │  └─ en/*.js                        # English dictionaries: one file per feature, merged at build time
   ├─ services/                         # resident services (mounted once by Services.jsx): Audience / Gesture / Voice / Haptics / Quality / Tour
   ├─ lib/
   │  ├─ persist.js                     # localStorage / sessionStorage (every preference key lives here)
   │  ├─ share.js                       # parameters ↔ share URL, data context (?s= &o= &m= &sl= &lang=), captions and layout
   │  ├─ capture.js                     # share card / video recording (composites the camera background in AR view)
   │  ├─ ar.js                          # camera background · ambient light sampling · filters
   │  ├─ series.js · describe.js        # data → playback series (including the yearly survey series / gaps) and output text (pure functions)
   │  ├─ govdata.js · moon.js · birds.js  # load ocean.json · moon phase and moonrise / moonset position · bird seasons
   │  ├─ tour.js                        # data tour: stops / captions / runner (pure logic)
   │  ├─ inspect.js · pointerExpr.js    # data source cards · stylus pressure / tilt
   │  ├─ mirror.js · audience.js        # mirror-slice registry · audience-window protocol (BroadcastChannel)
   │  ├─ gestures.js · hands.js         # camera gestures: classification and state machine · camera + MediaPipe runtime
   │  ├─ voice.js · voiceCommands.js    # speech-recognition wrapper · command table and matching
   │  ├─ haptics.js                     # haptics (phone vibration / gamepad dual-rumble)
   │  ├─ xr.js                          # WebXR tabletop: feature detection · placement maths · hit-test · state machine (pure logic, loaded on demand)
   │  ├─ quality.js · qualityStore.js · qualityRuntime.js   # automatic graphics quality: state machine · shared state · runtime
   │  ├─ midiRoute.js · blemidi.js · multiplayer.js · sensors.js · ice.js   # MIDI routing · Bluetooth MIDI · Jam · phone sensors · WebRTC ICE
   │  └─ *.test.mjs                     # unit tests (next to the module they test)
   ├─ ui/                               # TopBar · ParamPanel · Monitor · Splitter · DataCard · DataBoard · DataHUD · SurveyTimeline
   │  │                                 # TourControls · TourCaption · InspectCard · KioskQR · InfoModal · MultiModal · DevicesModal · XrOverlay …
   │  ├─ devices/                       # sections of the Devices panel: AudienceSection · GestureSection · VoiceSection · HapticsSection · QualitySection · XrSection
   │  └─ info/                          # Help dialog body: InfoZh.jsx · InfoEn.jsx (maintained as a pair)
   ├─ styles/                           # per-feature CSS (audience · gestures · haptics · inspect · quality · timeline · tour · voice · xr)
   ├─ scene/Scene3D.jsx                 # R3F 3D sphere
   ├─ scene/XrRuntime.jsx               # R3F runtime for WebXR (loaded only when a session exists)
   └─ timeline/scenes.js                # scene presets
```

---

## Tech

React + Vite · Three.js + React Three Fiber · Zustand · Web MIDI API · Tone.js · cannon-es · PeerJS (WebRTC) · MediaPipe Tasks Vision (camera gestures, loaded dynamically) · Web Speech API (voice commands) · BroadcastChannel (audience window).

**Performance design**: the 3D scene reads parameters with `useStore.getState()` inside the render loop, so high-frequency MIDI messages never trigger a React re-render; the recording buffer and the soft-takeover state live at module level so that not every message repaints. The phone remote page and the audience window each load only the code they need; MediaPipe loads only when someone switches camera gestures on; and while no audience window is connected and gestures / voice are off, the matching services do no work at all.

**Dev aid**: in dev mode you can drive tests from the console with `window.__store`.

---

## Data and license

Government Open Data License, version 1 (OGDL v1). For the full data sources and schema, see [SPEC.md](./SPEC.md) (in Chinese).

**Data pipeline**: `public/data/ocean.json` is a build-time snapshot (Water Resources Agency reservoir status + 24 h inflow series + weather + river water level + bird / fish surveys + dust + station list + moonrise & moonset). GitHub Actions runs `scripts/fetch-ocean-data.mjs` every 3 hours (and again just after midnight in Taipei) to refresh it and commit it automatically, and **then dispatches the deploy workflow itself** (by GitHub's design, a push made with `GITHUB_TOKEN` does not trigger other workflows). The historical static data (station list / fish survey / yearly birds) is baked once by `scripts/bake-static-data.mjs`, and CI leaves it untouched.
- **The tide series updates daily with no key**: it fetches the CWA F-A0021-001 "tide forecast" public file (the coming month, 266 locations), takes the Hualien City high / low tide events (chart datum) and cosine-interpolates them into today's 24 h tide level; the previous day's tail events from the last saved run are merged in so the start of the curve is accurate (on the very first run the head is filled by mirroring the neighbouring half-cycle). With a `CWA_KEY` it uses the official datastore API instead (the same data); if both fail, the old series is kept.
- Add `CWA_KEY` (the authorization code you request from the [CWA Open Data Platform](https://opendata.cwa.gov.tw/)) under the repo's **Settings → Secrets and variables → Actions** and weather also comes from CWA observation stations (a government source); without it, weather falls back to Open-Meteo automatically.

**Privacy overview**: there is no backend and no accounts, and the code contains no analytics tracking (no Google Analytics or similar scripts). Camera video and microphone audio are never recorded or uploaded by this site (in Chrome and Edge the browser itself sends speech audio to a cloud recognition service; see "Voice commands"); preferences and recordings stay in your own browser's localStorage / sessionStorage. The first time camera gestures are switched on, the app downloads the model and runtime from jsDelivr and Google storage (download only, no upload). "Jam" uses PeerJS's public signalling server to set up the WebRTC connection, and when NAT or venue Wi-Fi blocks a direct connection it relays through a public TURN server (`openrelay.metered.ca`, see `src/lib/ice.js`); only slider values and trigger events pass through, never video or audio.
