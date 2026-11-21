# ESP32 bridge for the Wuzhi ZK-502MT (ESPHome)

An ESP32-C3 Super Mini running ESPHome holds the amp's Bluetooth LE control connection and makes the amp available to Home Assistant over Wi-Fi.

Status: first milestone. The board connects to the amp, runs the 5-step authentication, sends GetTargetInfo (opcode 0x03, read-only) and logs the decoded reply. It does not control anything yet: no gain, source or EQ entities.

The amp accepts only one control connection. While the ESP32 is connected, the phone app (PWA or vendor app) cannot connect, and the other way round. Bluetooth audio from the phone is not affected.

## What it sends

- On connect: the authentication messages, then GetTargetInfo. Both are read-only. GetTargetInfo can be turned off with `query_target_info: false`.
- When the amp pushes a frame that asks for a reply, the bridge sends the same bare acknowledgement the PWA sends.
- Nothing else. No gain, source or EQ writes.

## Files

| Path | Content |
|---|---|
| `wuzhi-amp.yaml` | ESPHome config for the ESP32-C3 Super Mini |
| `secrets.example.yaml` | Template for `secrets.yaml` (Wi-Fi, API key, amp address) |
| `components/wuzhi_amp/` | The external component |
| `components/wuzhi_amp/wuzhi_protocol.*` | Protocol core in plain C++ (auth, frames, TargetInfo parser), a port of `src/protocol/` |
| `components/wuzhi_amp/wuzhi_amp.*` | ESPHome glue on top of `ble_client` |
| `tests/test_protocol.cpp` | Host tests for the protocol core |

## Privacy

The amp's Bluetooth address and the serial-like ID string in GetTargetInfo type 3 are redacted in the log by default. `log_private: true` shows them, and also logs raw received frames at VERBOSE level. Leave it off unless you need it, and don't post such logs.

Two things are outside the component and do show the address:

- ESPHome's own `ble_client` and `esp32_ble_tracker` log lines.
- The `find_amp` helper in `wuzhi-amp.yaml`, which exists to show you the address once.

Redact the address before sharing any log. `secrets.yaml` holds the address and is git-ignored.

## Flashing guide

You need:

- an ESP32-C3 Super Mini and a USB-C data cable (not a charge-only cable),
- a Windows, macOS or Linux PC with Python 3.10 or newer,
- the amp switched on, within a few metres of the board,
- Home Assistant on the same network, if you want it there (optional for this milestone).

There are two ways to build: with an ESPHome Device Builder you already run (Home Assistant add-on, Docker or LXC), or with the ESPHome command line on your PC.

## Flashing with the ESPHome Device Builder

The Device Builder fetches the component from GitHub, so no files need to be copied to it.

1. In the Device Builder, open Secrets (top right) and add these entries, with values as described in `secrets.example.yaml`. Generate the API key as in step 3 of the command-line guide below, or with any base64 32-byte key generator. Use `00:00:00:00:00:00` for `amp_mac` for now.

   ```yaml
   wifi_ssid: "..."
   wifi_password: "..."
   api_key: "..."
   amp_mac: "00:00:00:00:00:00"
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
4. Find the amp's address. Disconnect the phone app from the amp, then open the device's Logs in the Device Builder (over Wi-Fi). Look for the `find_amp` line shown in step 4 of the command-line guide. Put the address into Secrets as `amp_mac`.
5. Click Install, then Wirelessly. From now on all updates go over Wi-Fi.
6. Check the log as in step 6 below.

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

Open `secrets.yaml` and fill in your Wi-Fi name and password, and the generated `api_key`. OTA updates use the same key. Leave `amp_mac` at `00:00:00:00:00:00` for now.

### 4. First flash over USB and find the amp's address

1. Disconnect the amp from the phone app (close the PWA tab or the vendor app). The amp only shows up for others while nothing holds its control connection.
2. Plug the board into the PC.
3. Build and flash:

   ```powershell
   esphome run wuzhi-amp.yaml
   ```

   When asked for the upload port, pick the USB/COM port. If no port shows up, or the upload fails: unplug the board, hold the BOOT button, plug it back in, release BOOT, and run the command again.
4. After flashing, ESPHome shows the log. Within a few seconds you should see a line like:

   ```
   [I][find_amp]: Found Wuzhi..., address AA:BB:CC:DD:EE:FF, RSSI -60
   ```

   If nothing shows up: make sure no phone is connected to the amp's control channel, and move the board closer.
5. Stop the log with Ctrl+C. Put the address into `secrets.yaml` as `amp_mac`.

### 5. Second flash with the address

```powershell
esphome run wuzhi-amp.yaml
```

The board is on Wi-Fi now, so ESPHome offers an over-the-air upload as well as USB. Either works.

### 6. Check the log

```powershell
esphome logs wuzhi-amp.yaml
```

A working connection looks like this (values from a ZK-502MT, private parts redacted):

```
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

Once this works, the `on_ble_advertise` block in `wuzhi-amp.yaml` can be removed.

### 7. Add it to Home Assistant (optional for now)

Home Assistant usually discovers the board by itself: Settings, Devices and services, then configure the discovered "Wuzhi Amp" and enter the API key from `secrets.yaml`. There are no amp entities yet; this only checks that the link to Home Assistant works.

## Troubleshooting

| Symptom | What to try |
|---|---|
| No COM port when flashing | Use a data cable. Hold BOOT while plugging in. |
| Board doesn't join Wi-Fi | Some C3 Super Mini boards have a weak antenna. Add `output_power: 8.5dB` under `wifi:` and flash over USB. |
| `Service AE00 with AE01/AE02 not found` | The address in `amp_mac` belongs to a different device. |
| `auth: timeout waiting for step 2` | The amp didn't answer. Power-cycle the amp and check that nothing else is connected to it. |
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

In this order, each one tested on the amp before the next:

1. Gain as a number entity, capped (default 40), stepped by 1.
2. Source BT/AUX as a select, with live updates from the 0x21 push.
3. EQ preset as a select, AUX cable in as a binary sensor.
4. Optional AUX priority.
