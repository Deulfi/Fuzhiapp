# Amp Control for Wuzhi Bluetooth amplifiers

A small web app that controls Wuzhi amplifier boards (tested on the **ZK-502MT**) over Bluetooth, as a replacement for the official "Wuzhi Audio" Android app. It runs in the browser, needs no account and asks for no permissions beyond Bluetooth access to the amp (on Android the browser needs the "Nearby devices" permission to find the amp).

**Open the app:** https://deulfi.github.io/Fuzhiapp/

Works in Chrome and Edge on Android, Windows, macOS, Linux and ChromeOS. It does not work on iPhone or iPad, or in Firefox and Safari, because those browsers don't support Web Bluetooth.

## What it does

- **Source:** switch between Bluetooth and AUX. AUX is greyed out when no cable is plugged in.
- **Gain:** the amp's volume, 0–30 on the ZK-502MT. It changes in small steps, never in one jump.
- **Equalizer:** the six presets (Normal, Rock, Pop, Classical, Jazz, Country) and your own 10-band curve.
- **Profiles:** save source, gain and EQ under a name and apply them with one tap, or automatically when the app connects.
- **AUX priority:** The amp switches to Bluetooth on connecting even while you're listening on AUX, the app switches it back.
- **Settings:** beep on/off (Bluetooth connection sounds) and volume, Bluetooth name, disconnecting a phone's audio, an activity log.

The app also shows changes made elsewhere, such as plugging in the AUX cable or a phone connecting.

## Getting started

1. Power the amp.
2. Open the app and press **Connect**.
3. Pick the amp from the list. It's usually called "Wuzhiapp APP", or the name you gave it followed by "APP". If it isn't listed, use "Show all devices".

You can install it like an app from the browser menu ("Install app" or "Add to Home screen").

Connecting the app is separate from pairing your phone for music. The app uses its own Bluetooth connection, so your phone can play music to the amp while the app is connected, and the app can run on a different device than the one playing.(one connection is for sound and the other is like a remote)

## Browser setup

Chrome and Edge work without changes. A few things help or are needed in some cases:

| To get this | Do this |
|---|---|
| The amp shows up when you press Connect (Android) | Allow the browser the "Nearby devices" permission |
| The Connect button opens the device list (Brave) | Enable `brave://flags/#brave-web-bluetooth-api` |
| The app reconnects by itself when opened | Enable `chrome://flags/#enable-web-bluetooth-new-permissions-backend` |

The details:

**Nearby devices permission (Android).** The browser needs it to search for the amp. Android asks the first time you press Connect. If you declined, allow it in Android's settings under Apps → your browser → Permissions.

**Brave** has Web Bluetooth switched off by default, so the Connect button does nothing. Open `brave://flags`, search for "Web Bluetooth" (`#brave-web-bluetooth-api`), set it to Enabled and restart Brave.

**Remembering the amp.** By default the browser forgets the amp when it closes, so you pick it from the list again each time. In Chrome you can turn on `chrome://flags/#enable-web-bluetooth-new-permissions-backend`; the app then reconnects by itself when you open it. It can take a few seconds after a browser restart, while the browser waits to see the amp again.

Changing flags and permissions in the browser you use every day isn't for everyone. If you'd rather keep that browser as it is, a second browser used only for this app works well, and it can sit on the home screen like any other app once installed.

## Things that may look odd

Most of these are how the amp's firmware behaves. The app works around them where it can.


**Switching to AUX leaves your phone connected.** The phone still shows the amp as its speaker and may look like it's playing, but nothing comes out. Turn on "Disconnect the phone when switching to AUX" if you'd rather have the phone let go. Afterwards the phone doesn't reconnect by itself; tap the amp in the phone's Bluetooth settings when you want it back.

**Disconnecting the phone from AUX briefly switches to Bluetooth.** The amp only accepts "disconnect" while it's on Bluetooth, so the app switches over, disconnects, and the amp falls back to AUX by itself. You may hear a short gap.

**AUX priority and the phone.** When a phone connects, the amp switches to Bluetooth. With AUX priority on, the app switches back after a moment and leaves the phone connected. Pressing Bluetooth in the app pauses AUX priority until you press AUX again.

**The gain slider goes to 40, but the ZK-502MT stops at 30.** Higher values are accepted and do nothing. The slider is longer for other models that may go higher. You can set a lower limit in the settings.

**Renaming the amp restarts it.** Afterwards, remove the old name from your phone's or computer's Bluetooth list and pair the new one. The same happens when the pairing code is changed.

**Changing the beep plays a test sound** and briefly interrupts the music.

**The app can't tell which device is connected for audio**, only whether one is. The amp doesn't report it.

**The amp starts on Bluetooth after every power-on**, even with an AUX cable plugged in. It doesn't remember AUX. The usual fix is to unplug and replug the cable, or press AUX in the app. The app can't change this permanently: AUX priority only works while the app is open and connected.

**The equalizer only affects Bluetooth audio.** On AUX it changes nothing you can hear.

**After power-on, the EQ is locked to Normal** until the amp has played something over Bluetooth once. Until then the amp quietly ignores EQ changes, and the app says so and offers "Try again". The EQ also resets to Normal on every power-on.

**Not available on the ZK-502MT:** lights, bass and treble (the knobs on the board are analog), the DSP screen, USB and SD playback, and firmware updates.

## Other models

The official app covers several Wuzhi boards. This app was built and tested on a ZK-502MT. Other models with the same Bluetooth module will probably connect and partly work.

**If the app can't find or connect to your board, check the Bluetooth chip.** The tested board has a Jieli chip marked `JL AS24BP0Q237-25A4`, most likely an AC6925A; the part after the dash (`-25A4`) is what matters. Older versions of the ZK-502MT are said to use a different chip (forum posts mention a TD5182A). Boards without a Jieli chip won't work with this app.

If you have another model, the [protocol logger](docs/logger.md) (linked at the bottom of the app's settings) shows what your amp reports. Please open an issue with a log; it's how support for more models gets added if somebody feels like doing a PR.

## Privacy

Everything stays in your browser: profiles, settings and the activity log. The app makes no network requests after it has loaded, and it works offline once installed.

## Clean-room implementation

This project contains no code, images or other material from the official app. It was written from a protocol description (interoperability facts only: byte layouts and commands) and from testing on a real amp. See [docs/](docs/) for the protocol description, the test results, and how the knowledge was gathered.

Not affiliated with Wuzhi or Jieli.

## For developers

See [docs/development.md](docs/development.md). In short: `npm install`, `npm run dev`, `npm test`.

## License

MIT, see [LICENSE](LICENSE).
