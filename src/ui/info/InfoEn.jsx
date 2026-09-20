// Help dialog body, English version. The shell lives in ../InfoModal.jsx and the Chinese version in ./InfoZh.jsx;
// keep both files in the same order, with the same ids and groups, the same inline markup and the same facts.
// Structure: a short lead paragraph -> "Quick start" (QUICK, at most 5 items) -> "Full guide" (GROUPS: collapsible
// topic sections, closed by default, one-line summary).
// To add content: add an entry { id, body } to PLAY (one more way to play) and put its id into the ids of exactly one
// group in GROUPS; for a new topic add a group. Mirror every change in InfoZh.jsx (lib/onboarding.test.mjs checks that
// the two files line up). Button names follow src/i18n/GLOSSARY.md.
// This file must not contain any CJK text (the language button is described in words instead).
import { Fragment } from 'react'

const PLAY = [
  { id: 'mouse', body: <><b>Mouse</b>: drag the sphere to rotate it; use the sliders on the right to adjust parameters; click an action button to summon creatures; <b>double-click the canvas</b> for Stage mode (hides the interface).</> },
  { id: 'keyboard', body: <><b>Keyboard</b>: <code>Space</code> play · <code>R</code> record · <code>1–4</code> whale / dolphin / turtle / clear trash · <code>H</code> Stage mode · <code>I</code> show / hide the info panels on the canvas (Data board, Playback &amp; parameter hints) · <code>L</code> show / hide the system-event monitor at the bottom (or use the "System events" switch in the footer) · <code>T</code> start / stop the data tour · <code>Esc</code> stop the tour / close a data source card · <code>?</code> Help · after selecting a control on the virtual controller, fine-tune it with the <code>arrow keys</code>.</> },
  { id: 'touch', body: <><b>Phone touch</b>: swipe up / down = sea level · pinch = zoom · long-press = gather the fish schools · tilt = ripple the water surface · shake = stir · tap = light up a star.</> },
  { id: 'pen', body: <><b>Stylus</b>: when you drag the sphere with an Apple Pencil, Surface Pen or Wacom pen, pressing harder adds more wave energy and tilting the pen steers the current direction (an upright pen leaves it alone). Fingers and the mouse are not affected; add <code>?pen=0</code> to the URL to turn it off.</> },
  { id: 'midi', body: <><b>MIDI</b>: plug in a KORG nanoKONTROL2 and press "Connect MIDI" to map it automatically (faders / knobs / buttons / transport keys, with LED feedback). <b>No hardware?</b> Open "Controller" at the top and play the virtual nanoKONTROL2 with your mouse and keyboard.</> },
  { id: 'sound', body: <><b>Sound</b>: <b>your first click or tap on the canvas turns on</b> the generative ambient sound automatically (sea level = root note frequency; browsers only allow sound after a user gesture). Press "Sound" to mute it (it will not start by itself again). With "Mic" on, blowing into your phone = wind, and clapping = summon dolphins.</> },
  { id: 'multi', body: <><b>Multiplayer jam</b>: press "Jam" to show a QR code; a phone that scans it becomes a remote. Each phone gets one part (Ocean / Life / Mood), and its sliders stay in sync with the main screen in real time. The remote page can turn on the phone's sensors: <b>tilt = current direction, shake = surge</b>. Add <code>?kiosk=1</code> to the URL at an exhibition and a QR code stays in the corner.</> },
  { id: 'ble', body: <><b>Bluetooth MIDI</b>: in Chrome / Edge, press "BLE MIDI" to connect a BLE-MIDI controller or keyboard directly. Safari on iPad / iPhone has no Bluetooth MIDI, so use "Jam" and scan the QR code instead.</> },
  { id: 'blur', body: <><b>Background blur / clarity</b>: the sliders in "VIEW" on the right. They only affect the background (stars, Milky Way, moon; in AR view, the camera image), so the sphere and its creatures stay sharp.</> },
  { id: 'ar', body: <><b>AR view</b>: press "AR view" to use the camera as the background, so the sphere floats in the real world. You can adjust background blur and clarity (only the background changes, not the sphere), and "Auto glow from ambient light" adjusts the sphere's glow to the brightness of the camera image.</> },
  { id: 'gamepad', body: <><b>Gamepad</b>: with a gamepad plugged in, left stick = current direction, right stick = spin / sea level, and A/B/X/Y = summon creatures. On a phone, turning your body (compass heading) turns the current.</> },
  { id: 'data', body: <><b>Real data</b>: on the right, pick a reservoir or "Hualien offshore (tide)", then press "Play 24h data" to make the sphere rise and fall with the real data (adjustable speed and looping; the data time appears at the top of the screen). Full reservoir / high tide = the sphere fills up and liquid spills over its rim. The Milky Way density in the background = the live river water level, and the bird flocks outside the sphere = the number of bird species in that basin's bird survey (it rises and falls with the real-world seasons; the bar chart on the data card previews each month, and you can press "Apply data", turn on "Link", or drag the slider to control it independently). The data card's "Overlays" options toggle the Data board / Playback &amp; parameter hints / QR separately ("Info" at the top, or the I key, hides / shows them all at once). Choose "Hualien offshore (tide)" and a moon appears in the background, with its phase and position following that day's moon age and time; choose "Moon · Hualien" and the moon follows the true azimuth and altitude from the Central Weather Administration (CWA) moonrise and moonset table (press "Play moonrise &amp; moonset" to step through the days); choose "Dust · Yunlin County" to see the Water Resources Agency (WRA) IoW dust sensor stations (when a PM10 sensor is invalid, wind speed drives it instead); choose "Air quality · Yunlin" to see PM2.5 from Open-Meteo / CAMS (modeled data, not government observations). The constellation in the background = the real coordinates of the WRA's 188 river-flow gauging stations, and the number of fish schools follows the fish survey.</> },
  { id: 'timeline', body: <><b>Survey timeline</b>: the bird and fish survey cards draw every survey year to true scale, and years with no survey appear as a hatched "No survey" band. "Play survey timeline" steps through the years (about 0.7 s each), filling the gap years by interpolation between the neighbouring survey years and saying "no survey (interpolated)" on screen. Interpolated values are illustrative, not observations.</> },
  { id: 'tour', body: <><b>Data tour</b>: press <code>T</code>, click "Start tour" on the Data tour card in the panel, or leave the app idle for 30 seconds to step through today's reservoir, the Hualien tide, the moon, Yunlin dust, air quality, birds, fish and the river-station constellation (about 110 seconds for a full lap), while large captions below the sphere explain from real data what you are looking at and why it looks that way. During the tour, click a progress dot to jump to a stop, use <code>←</code> <code>→</code> to change stops and <code>P</code> to pause / resume; there is also "Copy link to this stop" and optional "Read captions aloud". Touching the screen, turning a knob or pressing any other key (<code>Esc</code> or <code>T</code> also work) stops it and restores the sea you had before; the idle auto tour can be turned off on the card (or forced with <code>?tour=0</code> / <code>?tour=1</code> in the URL).</> },
  { id: 'inspect', body: <><b>Tap for data source</b>: tap a gauging-station star, the moon or a bird flock in the background and a card opens beside it with the values and where the data comes from. Tap empty space, press <code>Esc</code> or wait 6 seconds to close it; it does not appear while the info panels are hidden (<code>I</code>).</> },
  { id: 'share', body: <><b>Share</b>: "Share" copies a link that carries the current sea (visual settings, the sea you picked, the month, whether birds and fish follow the survey data, and the language), so whoever opens it sees the same picture and data context. "Snapshot" turns the sea as it is right now into an image with the caption "I played a sea in MidiSea [url]" (phones open the system share sheet; desktops download the image and copy the caption; in AR view the camera background is included). Add <code>?kiosk=1</code> to the URL to go straight into exhibition Stage mode; add <code>&amp;hud=0</code> to hide the info panels and <code>&amp;qr=0</code> to hide the QR code.</> },
  { id: 'audience', body: <><b>Audience window</b>: perform on the laptop and show the audience on the projector. Open Devices, then Audience window, and press "Open audience window" to get a window with no controls and no sound that shows the same sea full screen (with the data board, tour captions and data source cards), synced live with your actions. In Chrome or Edge with the "Window management" permission it opens on the external screen by itself; in other browsers drag it onto the projector and click it once for full screen. Data only moves between the two windows inside your browser.</> },
  { id: 'xr', body: <><b>AR tabletop</b> (only on phones with WebXR, such as Chrome on Android): Devices → AR tabletop → "Place on a table". Find a table with the camera, tap, and a sphere about 28 cm wide sits there; walk around it to see every angle, and adjust sea level, current and clarity or summon creatures. The camera runs only after you tap the button and nothing is uploaded; iOS Safari has no WebXR AR, so use "AR view" instead.</> },
  { id: 'lang-devices', body: <><b>Language and Devices</b>: the language button in the top-right corner switches the interface between English and Traditional Chinese (you can also add <code>?lang=en</code> or <code>?lang=zh</code> to the URL). The "Devices" button gathers optional device features: <b>Audience window</b> (dual screen), <b>Camera gestures</b> (open palm = calm, pinch = whale), <b>Voice commands</b> (say "whale", "big wave", "quiet"…), <b>Haptics</b> (phone and gamepad vibration), <b>Graphics quality</b> (adjusts to the frame rate automatically) and <b>AR tabletop</b> (only shown on phones that support it); at the bottom there are also <b>Device diagnostics</b> (opens the diagnostics page to check the hardware item by item, or go straight to <code>?diagnostics=1</code>) and <b>Operations</b> (build and crash log for exhibitions). The camera and microphone are only used while you switch them on, and video is never uploaded; in Chrome / Edge, speech recognition is sent to a cloud service by the browser.</> },
]

// Quick start: five items or fewer, one line each; the details are in the full guide below.
const QUICK = [
  { id: 'quick-turn', body: <><b>Turn and tune</b>: drag the sphere to turn it; use the sliders on the right for sea level, current and clarity; click an action button to summon a whale, dolphin or turtle.</> },
  { id: 'quick-data', body: <><b>Real data</b>: pick a reservoir, the tide, the moon, dust or air quality on the right, then press "Play" and the sphere follows the real data.</> },
  { id: 'quick-tour', body: <><b>Data tour</b>: press <code>T</code> to play through today's real data automatically, with captions below the sphere explaining why it looks that way.</> },
  { id: 'quick-nomidi', body: <><b>No MIDI controller?</b> Open "Controller" at the top for the virtual nanoKONTROL2, or press "Jam" and scan the QR code so a phone becomes a remote.</> },
  { id: 'quick-more', body: <><b>More</b>: double-click the canvas for Stage mode; press <code>?</code> to open this Help any time; "Devices" has the optional camera gestures, voice commands and more.</> },
]

// Topic groups of the full guide (title = the summary line, hint = the grey text beside it; ids point at PLAY above)
const GROUPS = [
  { id: 'controls', title: 'Controls', hint: 'Mouse, keyboard, touch, stylus, gamepad', ids: ['mouse', 'keyboard', 'touch', 'pen', 'gamepad'] },
  { id: 'midi-sound', title: 'MIDI and sound', hint: 'MIDI controller, Bluetooth MIDI, ambient sound', ids: ['midi', 'ble', 'sound'] },
  { id: 'data', title: 'Real data and tours', hint: 'Data card, survey timeline, data tour, data sources', ids: ['data', 'timeline', 'tour', 'inspect'] },
  { id: 'view', title: 'View and AR', hint: 'Background blur, AR view, AR tabletop', ids: ['blur', 'ar', 'xr'] },
  { id: 'share', title: 'Jam, sharing and exhibitions', hint: 'Phone remotes, share links, audience window', ids: ['multi', 'share', 'audience'] },
  { id: 'devices', title: 'Language and devices', hint: 'Language, camera gestures, voice, haptics, graphics quality', ids: ['lang-devices'] },
]
const BY_ID = Object.fromEntries(PLAY.map((it) => [it.id, it.body]))

const ECO = { id: 'eco', title: 'Ocean ecology', hint: 'How trash changes the sea, the creatures and the sound', text: <>More trash → murkier water, fewer creatures, fish schools that steer around the trash, and darker-toned sound. Clear the trash → a cleansing wave spreads, the water turns clear, creatures return, and the sound goes back to a bright major key. The background also has an extremely slow day-and-night "breathing" cycle.</> }

// replay: the "Replay the quick tour" button passed in by the shell (InfoModal); it sits under the quick start
export default function InfoEn({ replay = null }) {
  return (
    <>
      <p className="modal-lead">Play a line-art ocean inside a transparent sphere with a MIDI controller (or a mouse, keyboard or phone touch): shape the water, summon whales, dolphins and turtles, clean up ocean trash, and record a whole performance to replay it.</p>
      <h3>Quick start</h3>
      <ul className="modal-list">{QUICK.map((it) => <li key={it.id}>{it.body}</li>)}</ul>
      {replay}
      <h3 className="info-more">Full guide (click a topic to expand)</h3>
      {GROUPS.map((g) => (
        <details key={g.id} className="info-group">
          <summary><span className="info-group-title">{g.title}</span><span className="info-group-hint">{g.hint}</span></summary>
          <ul className="modal-list">{g.ids.map((id) => <Fragment key={id}><li>{BY_ID[id]}</li></Fragment>)}</ul>
        </details>
      ))}
      <details className="info-group">
        <summary><span className="info-group-title">{ECO.title}</span><span className="info-group-hint">{ECO.hint}</span></summary>
        <p className="modal-p">{ECO.text}</p>
      </details>
    </>
  )
}
