# Wuzhi Amp Bridge (ESP32 + ESPHome)

An ESP32-C3 Super Mini running ESPHome that holds the Bluetooth LE control connection of a Wuzhi ZK-502MT amp and makes the amp available to Home Assistant over Wi-Fi. Optionally it also serves a small control page of its own.

This branch (`esphome-bridge`) contains only the bridge. The web app (PWA), the protocol documentation and the protocol logger live on [`main`](https://github.com/Deulfi/Fuzhiapp). The bridge is a C++ port of the PWA's protocol code and follows the same safety rules.

Clean-room: written from the project's own protocol notes and tests on the user's amp. No vendor code or assets. MIT licence.

## What it does

- Finds the amp by its Bluetooth name, connects, and runs the amp's 5-step authentication.
- Shows and controls in Home Assistant:

| Entity | Type | What |
|---|---|---|
| Gain | number | the amp's digital level, capped, changed in steps of 1 |
| Source | select | Bluetooth / AUX (Idle shown only), live from the amp |
| EQ | select | Normal, Rock, Pop, Classical, Jazz, Country, User |
| EQ 31 Hz .. EQ 16 kHz | number | the User EQ curve, -12..+12 dB |
| AUX priority | switch | go back to AUX when the amp leaves it while a cable is in |
| Mute | switch | gain to 0; off restores the old gain, stepped |
| Connect to amp | switch | off frees the amp for the PWA or vendor app, kept across reboots |
| Beep, Beep volume | switch, number | the amp's prompt tones |
| Disconnect phone audio | button | drops the phone's Bluetooth audio link |
| AUX cable | binary sensor | cable plugged in |
| Bluetooth audio | binary sensor | a phone or computer is connected for audio |
| Amp connected | binary sensor | the bridge holds the control link |
| Amp firmware, Amp protocol | text sensor | e.g. "V002.10", "2.1" |
| Forget amp | button | drop the stored amp and find the next one |

Status: all entities tested on a ZK-502MT, except Mute and Connect to amp (new, not yet tested). No release yet; the first one follows after a few days of everyday use.

## One connection only

The amp accepts a single control connection. While the bridge is connected, the PWA and the vendor app can't connect, and the other way round. Bluetooth audio from your phone is not affected. To use the PWA or the vendor app, turn the bridge's Connect to amp switch off (or power the board off).

## Getting started

Pick one:

| Way | For whom | Guide |
|---|---|---|
| Ready-made firmware file | Simplest. No ESPHome install, nothing to configure. | [docs/install-firmware-file.md](docs/install-firmware-file.md) |
| ESPHome Device Builder | You already run ESPHome (Home Assistant add-on, Docker, LXC) and want to edit the config. | [docs/install-device-builder.md](docs/install-device-builder.md) |
| ESPHome command line | Build and flash from your own PC (Windows, Linux, macOS). | [docs/install-command-line.md](docs/install-command-line.md) |

You need an ESP32-C3 Super Mini (any ESP32 with BLE should work, but only the C3 Super Mini is tested), a USB-C data cable, and the amp within a few metres of the board.

## More

- [docs/configuration.md](docs/configuration.md): every option and entity, with YAML.
- [docs/how-it-works.md](docs/how-it-works.md): connection sequence, safety rules, what is sent when, the amp's quirks.
- [docs/troubleshooting.md](docs/troubleshooting.md): common problems and their fixes.
- [docs/development.md](docs/development.md): code layout, host tests, building, releases.

## Files

| Path | Content |
|---|---|
| `components/wuzhi_amp/` | The ESPHome external component |
| `firmware/wuzhi-amp-lean.yaml` | Config of the public firmware, Home Assistant only |
| `firmware/wuzhi-amp-web.yaml` | Config of the public firmware with the control page |
| `wuzhi-amp.yaml` | Example config for your own build (with secrets) |
| `secrets.example.yaml` | Template for `secrets.yaml` |
| `tests/test_protocol.cpp` | Host tests for the protocol core |
| `docs/` | Guides and reference |
| `.github/workflows/esphome-firmware.yml` | Builds the firmware files and releases |
