# ESP32 bridge for the Wuzhi ZK-502MT (ESPHome)

An ESP32-C3 Super Mini running ESPHome holds the amp's Bluetooth LE control connection and makes the amp available to Home Assistant over Wi-Fi.

Status: the board connects to a ZK-502MT, runs the 5-step authentication and logs the decoded GetTargetInfo (tested). Gain, source and the binary sensors work (tested). EQ, AUX priority, automatic finding and the public firmware work (tested). Beep, EQ bands, disconnect phone audio and the info sensors are new and not yet tested on the amp.

The amp accepts only one control connection. While the ESP32 is connected, the phone app (PWA or vendor app) cannot connect, and the other way round. Bluetooth audio from the phone is not affected.

## What it sends

- On connect: the authentication messages (with `pair: true`, BLE pairing first), then GetTargetInfo. Both are read-only. GetTargetInfo can be turned off with `query_target_info: false`.
- When the amp pushes a frame that asks for a reply, the bridge sends the same bare acknowledgement the PWA sends.
- With the gain number configured: one read-only GetSysInfo after auth, to learn the current gain.
- Gain writes only when you change the gain number (Home Assistant or the web page), never on connect, boot or Home Assistant reconnect. See "Gain" below.
- Source switches only when you change the source select.
- With the Bluetooth audio sensor configured: a read-only GetTargetInfo every 30 s and after source changes (the amp has no push for it).
- EQ writes only when you change the EQ select, or once more when the amp refused it (see below).
- With AUX priority on: a switch to AUX when the amp leaves AUX while a cable is in (see below).
- With beep entities: one read-only beep query after auth; beep writes only when you change them.
- With the firmware sensor: one read-only model query after auth.
- Disconnect phone audio only when you press the button.
- Nothing else.

## Gain

```yaml
number:
  - platform: wuzhi_amp
    gain:
      name: Gain
      max_gain: 40
```

- The number is the amp's digital level (public attribute 1), the same as the PWA's gain slider. The ZK-502MT uses 0-30 and ignores 31-40.
- `max_gain` (0-40, default 40) is the cap. The bridge never sends a value above it; higher requests are lowered to the cap.
- Changes are stepped by 1 every 120 ms, each step confirmed by the amp, never a jump upward. Home Assistant only sees the final value. If the amp reports a value above the cap (set by another app), the first write goes straight down to the cap.
- The number shows as unknown until the amp has reported its gain, and again after a disconnect. Changes made then are ignored.
- Changes from elsewhere (the amp pushes them) update the number.

## Source and sensors

```yaml
select:
  - platform: wuzhi_amp
    source:
      name: Source
    eq:
      name: EQ

binary_sensor:
  - platform: wuzhi_amp
    aux_cable:
      name: AUX cable
    bluetooth_audio:
      name: Bluetooth audio
    connected:
      name: Amp connected
```

- Source: Bluetooth, AUX or Idle (shown only). Updated live from the amp's source push. Switching uses the standard Function command, like the PWA.
- Selecting Bluetooth while already on Bluetooth sends nothing, because the switch would drop the phone's audio link.
- Selecting AUX without a cable sends nothing; the amp would ignore it.
- AUX cable: from the amp's state (attribute 2), updated by its push.
- Bluetooth audio: whether a phone or computer is connected for audio.
- Amp connected: the bridge holds an authenticated control link.
- While not connected, gain, AUX cable and Bluetooth audio show as unknown. The two selects keep their last value, because ESPHome selects can't be set back to unknown; use Amp connected to tell.

## EQ

- Presets Normal, Rock, Pop, Classical, Jazz, Country, and User (the last custom gains the amp reported). Custom gains themselves can't be edited here; set them in the PWA.
- The EQ only affects Bluetooth audio, not AUX.
- After power-on the amp only accepts an EQ once it has played Bluetooth audio, and answers with Normal until then. The bridge logs that, shows what the amp really uses, and tries your choice again when Bluetooth audio connects or the source changes.

## Beep, EQ bands, phone audio, info

```yaml
number:
  - platform: wuzhi_amp
    beep_volume:
      name: Beep volume
    eq_31:
      name: EQ 31 Hz
    # eq_63, eq_125, eq_250, eq_500, eq_1k, eq_2k, eq_4k, eq_8k, eq_16k the same way

switch:
  - platform: wuzhi_amp
    beep:
      name: Beep

button:
  - platform: wuzhi_amp
    disconnect_phone:
      name: Disconnect phone audio

text_sensor:
  - platform: wuzhi_amp
    firmware_version:
      name: Amp firmware
    protocol_version:
      name: Amp protocol
```

- Beep and beep volume: the amp's prompt tones. The volume uses the 0-30 scale and is capped by `max_gain`, like the gain.
- EQ bands: the User EQ in dB, -12 to +12. They show the curve the amp reports, also for presets. Changing a band switches to User.
- Disconnect phone audio: drops the phone's or computer's Bluetooth audio link. If the amp isn't on Bluetooth it switches there first, because the command only works there; with a cable in, the amp goes back to AUX by itself. The phone has to reconnect from its own Bluetooth menu.
- Amp firmware: "V002.10" on the ZK-502MT, as the vendor app shows it. Amp protocol: the RCSP version, "2.1".

Not in the bridge, on purpose: renaming the amp and the pairing code (both restart the amp), and the protocol logger (PWA only).

## AUX priority

```yaml
switch:
  - platform: wuzhi_amp
    aux_priority:
      name: AUX priority
```

Off by default, kept across reboots. Same rules as the PWA:

- It only reacts to changes the amp reports: AUX cable plugged in, or the amp moving to Bluetooth or idle. Turning it on, or connecting, doesn't switch anything.
- It switches to AUX only while a cable is in. It never disconnects the phone.
- At most one switch every 2 s and 6 per minute, then it gives up for a minute. Each switch is checked again 2.5 s later, since a phone often pulls the amp back.
- Picking Bluetooth in the source select pauses it; picking AUX resumes it. Reconnecting also resumes it.

## Options

```yaml
wuzhi_amp:
  ble_client_id: amp_ble
  query_target_info: true   # read-only GetTargetInfo after auth
  log_private: false        # show address and ID string in the log
  name_prefix: wuzhi        # BLE name prefix for finding the amp
  auth_delay: 1s            # wait between enabling notifications and the auth challenge
  pair: false               # BLE pairing (encryption) before auth
```

Both settings of `pair` work on the ZK-502MT. The default is off.

Each connection gets exactly one auth attempt. The amp ignores a second challenge on the same link, and repeated challenges and reconnects once left its control channel stuck until it was power-cycled. After a failed attempt the bridge waits 30 s before reconnecting, doubling up to 10 minutes, and resets after a successful auth.

## Files

| Path | Content |
|---|---|
| `wuzhi-amp.yaml` | ESPHome config for the ESP32-C3 Super Mini (your own build, with secrets) |
| `firmware/wuzhi-amp-lean.yaml`, `firmware/wuzhi-amp-web.yaml` | Configs for the public firmware files, no secrets |
| `../.github/workflows/esphome-firmware.yml` | Builds the firmware files; tags `esphome-v*` publish a release |
| `secrets.example.yaml` | Template for `secrets.yaml` (Wi-Fi, API key) |
| `components/wuzhi_amp/button.py` | Forget amp, Disconnect phone audio buttons |
| `components/wuzhi_amp/text_sensor.py` | Firmware and protocol version |
| `components/wuzhi_amp/` | The external component |
| `components/wuzhi_amp/wuzhi_protocol.*` | Protocol core in plain C++ (auth, frames, TargetInfo parser), a port of `src/protocol/` |
| `components/wuzhi_amp/wuzhi_amp.*` | ESPHome glue on top of `ble_client` |
| `components/wuzhi_amp/number.py` | Gain, beep volume, EQ band numbers |
| `components/wuzhi_amp/select.py` | Source and EQ selects |
| `components/wuzhi_amp/switch.py` | AUX priority, beep switches |
| `components/wuzhi_amp/binary_sensor.py` | AUX cable, Bluetooth audio, connected |
| `tests/test_protocol.cpp` | Host tests for the protocol core |

## Privacy

The amp's Bluetooth address and the serial-like ID string in GetTargetInfo type 3 are redacted in the log by default. `log_private: true` shows them, and also logs raw received frames at VERBOSE level. Leave it off unless you need it, and don't post such logs.

ESPHome's own `ble_client` and `esp32_ble_tracker` log lines show the address; that is outside the component. Redact it before sharing any log. The automatically found address is stored on the board, not in any file.

## Finding the amp

With `mac_address: "00:00:00:00:00:00"` in `ble_client` (the default in `wuzhi-amp.yaml`), the bridge adopts the first device whose BLE name starts with `name_prefix` (default `wuzhi`, any case), stores it on the board and from then on connects only to that amp. The amp only advertises while nothing else holds its control connection, so close the PWA or vendor app when the board first starts.

```yaml
button:
  - platform: wuzhi_amp
    forget_amp:
      name: Forget amp
```

"Forget amp" drops the stored amp; the next one found is adopted. To pin one amp instead, put its address in `mac_address`.

## Flashing guide

You need:

- an ESP32-C3 Super Mini and a USB-C data cable (not a charge-only cable),
- a Windows, macOS or Linux PC with Python 3.10 or newer,
- the amp switched on, within a few metres of the board,
- Home Assistant on the same network, if you want it there (optional for this milestone).

There are three ways: flash a ready-made firmware file (simplest, no ESPHome install), build with an ESPHome Device Builder you already run (Home Assistant add-on, Docker or LXC), or build with the ESPHome command line on your PC.

## Flashing a ready-made firmware file

Two variants, built by GitHub Actions from `firmware/`:

| File | Content |
|---|---|
| `wuzhi-amp-lean-factory.bin` | Home Assistant only. Least RAM. |
| `wuzhi-amp-web-factory.bin` | Also a control page on the board (`http://wuzhi-amp-bridge-xxxxxx.local`), for use without Home Assistant. |

Both contain all entities described below. Nothing to configure: no Wi-Fi password or key in the file, and the amp is found by name.

1. Download a `factory.bin` from the releases page (tags `esphome-v...`), or from the artifacts of the latest "ESPHome firmware" run under Actions.
2. Plug the board into the PC, open https://web.esphome.io in Chrome or Edge, click Connect, pick the board's port, then Install and select the file. If no port shows up, hold BOOT while plugging the board in.
3. After flashing, the same page offers to set up Wi-Fi ("Configure Wi-Fi"). If you skip that, the board opens a hotspot "Wuzhi Amp Bridge Setup"; join it and pick your network on the page that opens.
4. Close the PWA and vendor app so the amp advertises. The board finds it within a few seconds.
5. Home Assistant discovers the board (Settings, Devices and services). Adopting it sets the encryption key; no key needs to be typed.

Until Home Assistant has adopted the board, its API and over-the-air updates have no key, like any ESPHome device fresh from a firmware file. Adopt it soon after flashing.

Updates: flash the `ota.bin` of a newer release from the board's web page (web variant) or with Install, then Wirelessly, after "Take control" in the ESPHome Device Builder. "Take control" turns the board into a normal Device Builder config that you can edit.

## Flashing with the ESPHome Device Builder

The Device Builder fetches the component from GitHub, so no files need to be copied to it.

1. In the Device Builder, open Secrets (top right) and add these entries, with values as described in `secrets.example.yaml`. Generate the API key as in step 3 of the command-line guide below, or with any base64 32-byte key generator.

   ```yaml
   wifi_ssid: "..."
   wifi_password: "..."
   api_key: "..."
   ```

2. Add a new device, skip the wizard if possible, and replace its YAML with the content of `wuzhi-amp.yaml`. In `external_components`, swap the active `type: local` source for the git one from the comment:

   ```yaml
   external_components:
     - source:
         type: git
         url: https://github.com/Deulfi/Fuzhiapp
         ref: esphome-bridge
         path: esphome/components
       components: [wuzhi_amp]
       refresh: 0s
   ```

   `refresh: 0s` makes it fetch the latest commit on every build. Use `ref: main` once the bridge is merged.
3. First flash. A Device Builder on another machine can't reach the board's USB port, and browsers only allow USB flashing on HTTPS pages. So:
   1. Click Install, then Manual download, and choose the factory format. The first build takes several minutes.
   2. Open https://web.esphome.io in Chrome or Edge on the PC the board is plugged into, click Connect, pick the board's port, then Install and select the downloaded `.bin`. If no port shows up, hold BOOT while plugging the board in.
4. Close the PWA or vendor app, so the amp advertises. The board finds it by name; see "Finding the amp".
5. Check the log in the Device Builder (Logs) as in step 5 below. From now on, updates go over Wi-Fi (Install, then Wirelessly).

## Flashing with the command line

The steps below use the ESPHome command line on Windows (PowerShell).

### 1. Install ESPHome

In a folder of your choice, create a virtual environment and install ESPHome:

```powershell
py -3.12 -m venv $HOME\esphome-venv
```

```powershell
& $HOME\esphome-venv\Scripts\Activate.ps1
```

```powershell
pip install esphome
```

```powershell
esphome version
```

The first build downloads the ESP32 toolchain (about 1 GB) and takes several minutes. Later builds are much faster.

### 2. Get the files

Clone the repo, or download it as ZIP from GitHub and unpack it. Then go to the `esphome` folder:

```powershell
cd path\to\Fuzhiapp\esphome
```

### 3. Create `secrets.yaml`

```powershell
Copy-Item secrets.example.yaml secrets.yaml
```

Generate an API encryption key:

```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Fill($b); [Convert]::ToBase64String($b)
```

Open `secrets.yaml` and fill in your Wi-Fi name and password, and the generated `api_key`. OTA updates use the same key.

### 4. First flash over USB

1. Close the PWA or vendor app. The amp only advertises while nothing holds its control connection.
2. Plug the board into the PC.
3. Build and flash:

   ```powershell
   esphome run wuzhi-amp.yaml
   ```

   When asked for the upload port, pick the USB/COM port. If no port shows up, or the upload fails: unplug the board, hold the BOOT button, plug it back in, release BOOT, and run the command again.

Later updates go over Wi-Fi: run the same command and pick the network address.

### 5. Check the log

```powershell
esphome logs wuzhi-amp.yaml
```

A working connection looks like this (values from a ZK-502MT, private parts redacted):

```
[I][wuzhi_amp]: Found amp "wuzhi APP", RSSI -60; stored (address not logged)
[I][wuzhi_amp]: Connected to amp, discovering services
[D][wuzhi_amp]: auth 1: send challenge
[D][wuzhi_amp]: auth 2: device response verified; auth 3: send pass
[D][wuzhi_amp]: auth 4: answer device challenge
[D][wuzhi_amp]: auth 5: device says pass, authenticated
[I][wuzhi_amp]: Authenticated with amp
[I][wuzhi_amp]: Target info: proto 2.1; vol 20/30; flags 0x0; A2DP connected; functions [Bluetooth, Music (USB/SD), AUX]; current Bluetooth; types [0 1 2 3 4 5 6 7 8 9 a b c]
[I][wuzhi_amp]:   type 0x00 (protocol version), 1 bytes: 21
[I][wuzhi_amp]:   type 0x02 (EDR address), 8 bytes: xx xx xx xx xx xx 2d 01 (address redacted)
[I][wuzhi_amp]:   type 0x03 (platform), 18 bytes: 01 + ASCII ID string, 17 chars (redacted)
...
```

### 6. Add it to Home Assistant (optional for now)

Home Assistant usually discovers the board by itself: Settings, Devices and services, then configure the discovered "Wuzhi Amp Bridge" and enter the API key from `secrets.yaml`.

## Troubleshooting

| Symptom | What to try |
|---|---|
| No COM port when flashing | Use a data cable. Hold BOOT while plugging in. |
| Board doesn't join Wi-Fi | Some C3 Super Mini boards have a weak antenna. Add `output_power: 8.5dB` under `wifi:` and flash over USB. |
| `Service AE00 with AE01/AE02 not found` | The adopted device isn't the amp (another device with a matching name). Press Forget amp, or set `name_prefix` or `mac_address`. |
| No `Found amp` line | Close the PWA and vendor app, move the board closer, check `name_prefix` against the amp's Bluetooth name. |
| `auth: timeout waiting for step 2` | The amp didn't answer. Check that nothing else (phone, PC) holds the control connection. If other devices can't connect either, the amp's control channel is stuck: switch the amp off and on. |
| `device response mismatch` | Not expected on a ZK-502MT. Please open an issue with the log, address redacted. |
| Phone app can't find the amp | Expected while the ESP32 is connected. Power the board off to use the phone app. |

## Running the host tests

The protocol core has no ESPHome dependency and builds with any C++17 compiler:

```powershell
cd tests
```

```powershell
g++ -std=c++17 -Wall -Wextra -I../components/wuzhi_amp test_protocol.cpp ../components/wuzhi_amp/wuzhi_protocol.cpp -o test_protocol
```

```powershell
./test_protocol
```

They check the E1 vectors from `docs/PROTOCOL.md` section 4, the frame examples from section 3, frame reassembly, the TargetInfo parser and its redaction, and the handshake against a simulated amp.

## Next steps

- Test EQ and AUX priority on the amp.
- Point the public configs at `main` once the bridge is merged.
