// Help dialog body, English version. The shell lives in ../InfoModal.jsx and the Chinese version in ./InfoZh.jsx;
// keep both files in the same order, with the same inline markup and the same facts.
// To add content: add an entry { id, body } to PLAY (one more way to play), or add a section to SECTIONS
// (`list` = bullet list, `text` = one paragraph). Button names follow src/i18n/GLOSSARY.md.
// This file must not contain any CJK text (the language button is described in words instead).
import { Fragment } from 'react'

const PLAY = [
  { id: 'mouse', body: <><b>Mouse</b>: drag the sphere to rotate it; use the sliders on the right to adjust parameters; click an action button to summon creatures; <b>double-click the canvas</b> for Stage mode (hides the interface).</> },
  { id: 'keyboard', body: <><b>Keyboard</b>: <code>Space</code> play · <code>R</code> record · <code>1–4</code> whale / dolphin / turtle / clear trash · <code>H</code> Stage mode · <code>I</code> show / hide the info panels on the canvas (Data board, Playback &amp; parameter hints) · after selecting a control on the virtual controller, fine-tune it with the <code>arrow keys</code>.</> },
  { id: 'touch', body: <><b>Phone touch</b>: swipe up / down = sea level · pinch = zoom · long-press = gather the fish schools · tilt = ripple the water surface · shake = stir · tap = light up a star.</> },
  { id: 'midi', body: <><b>MIDI</b>: plug in a KORG nanoKONTROL2 and press "Connect MIDI" to map it automatically (faders / knobs / buttons / transport keys, with LED feedback). <b>No hardware?</b> Open "Controller" at the top and play the virtual nanoKONTROL2 with your mouse and keyboard.</> },
  { id: 'sound', body: <><b>Sound</b>: <b>your first click or tap on the canvas turns on</b> the generative ambient sound automatically (sea level = root note frequency; browsers only allow sound after a user gesture). Press "Sound" to mute it (it will not start by itself again). With "Mic" on, blowing into your phone = wind, and clapping = summon dolphins.</> },
  { id: 'multi', body: <><b>Multiplayer jam</b>: press "Jam" to show a QR code; a phone that scans it becomes a remote. Each phone gets one part (Ocean / Life / Mood), and its sliders stay in sync with the main screen in real time. The remote page can turn on the phone's sensors: <b>tilt = current direction, shake = surge</b>. Add <code>?kiosk=1</code> to the URL at an exhibition and a QR code stays in the corner.</> },
  { id: 'ble', body: <><b>Bluetooth MIDI</b>: in Chrome / Edge, press "BLE MIDI" to connect a BLE-MIDI controller or keyboard directly. Safari on iPad / iPhone has no Bluetooth MIDI, so use "Jam" and scan the QR code instead.</> },
  { id: 'blur', body: <><b>Background blur / clarity</b>: the sliders in "VIEW" on the right. They only affect the background (stars, Milky Way, moon; in AR view, the camera image), so the sphere and its creatures stay sharp.</> },
  { id: 'ar', body: <><b>AR view</b>: press "AR view" to use the camera as the background, so the sphere floats in the real world. You can adjust background blur and clarity (only the background changes, not the sphere), and "Auto glow from ambient light" adjusts the sphere's glow to the brightness of the camera image.</> },
  { id: 'gamepad', body: <><b>Gamepad</b>: with a gamepad plugged in, left stick = current direction, right stick = spin / sea level, and A/B/X/Y = summon creatures. On a phone, turning your body (compass heading) turns the current.</> },
  { id: 'data', body: <><b>Real data</b>: on the right, pick a reservoir or "Hualien offshore (tide)", then press "Play 24h data" to make the sphere rise and fall with the real data (adjustable speed and looping; the data time appears at the top of the screen). Full reservoir / high tide = the sphere fills up and liquid spills over its rim. The Milky Way density in the background = the live river water level, and the bird flocks outside the sphere = the number of bird species in that basin's bird survey (it rises and falls with the real-world seasons; the bar chart on the data card previews each month, and you can press "Apply data", turn on "Link", or drag the slider to control it independently). The data card's "Overlays" options toggle the Data board / Playback &amp; parameter hints / QR separately ("Info" at the top, or the I key, hides / shows them all at once). Choose "Hualien offshore (tide)" and a moon appears in the background, with its phase and position following that day's moon age and time; choose "Moon · Hualien" and the moon follows the true azimuth and altitude from the Central Weather Administration (CWA) moonrise and moonset table (press "Play moonrise &amp; moonset" to step through the days); choose "Dust · Yunlin County" to see the Water Resources Agency (WRA) IoW dust sensor stations (when a PM10 sensor is invalid, wind speed drives it instead). The constellation in the background = the real coordinates of the WRA's 188 river-flow gauging stations, and the number of fish schools follows the fish survey.</> },
  { id: 'share', body: <><b>Share</b>: "Share" copies a link with the current parameters, and "Snapshot" turns the sea as it is right now into an image to share. Add <code>?kiosk=1</code> to the URL to go straight into exhibition Stage mode; add <code>&amp;hud=0</code> to hide the info panels and <code>&amp;qr=0</code> to hide the QR code.</> },
  { id: 'lang-devices', body: <><b>Language and Devices</b>: the language button in the top-right corner switches the interface between English and Traditional Chinese (you can also add <code>?lang=en</code> or <code>?lang=zh</code> to the URL). The "Devices" button gathers optional device features (more will be added over time). Each one is only used while you turn it on.</> },
]

const SECTIONS = [
  { id: 'play', title: 'How to play', list: PLAY },
  { id: 'eco', title: 'Ocean ecology', text: <>More trash → murkier water, fewer creatures, fish schools that steer around the trash, and darker-toned sound. Clear the trash → a cleansing wave spreads, the water turns clear, creatures return, and the sound goes back to a bright major key. The background also has an extremely slow day-and-night "breathing" cycle.</> },
]

export default function InfoEn() {
  return (
    <>
      <p className="modal-lead">Play a line-art ocean inside a transparent sphere with a MIDI controller (or a mouse, keyboard or phone touch): shape the water, summon whales, dolphins and turtles, clean up ocean trash, and record a whole performance to replay it.</p>
      {SECTIONS.map((s) => (
        <Fragment key={s.id}>
          <h3>{s.title}</h3>
          {s.list
            ? <ul className="modal-list">{s.list.map((it) => <li key={it.id}>{it.body}</li>)}</ul>
            : <p className="modal-p">{s.text}</p>}
        </Fragment>
      ))}
    </>
  )
}
