# Install: ready-made firmware file

The simplest way. You flash a finished file from the browser; there is nothing to configure and no ESPHome install.

## The two variants

| File | Content |
|---|---|
| `wuzhi-amp-lean-factory.bin` | Home Assistant only. Least RAM. |
| `wuzhi-amp-web-factory.bin` | Also a control page on the board, `http://wuzhi-amp-bridge-xxxxxx.local`, usable without Home Assistant. |

Both have all entities (see [configuration.md](configuration.md)). Neither contains a Wi-Fi password, key or amp address: Wi-Fi is set up after flashing, Home Assistant sets the key, and the amp is found by its name.

The `ota.bin` files are for updates over Wi-Fi, not for the first flash.

## You need

- an ESP32-C3 Super Mini,
- a USB-C **data** cable (charge-only cables don't work),
- a PC with Chrome or Edge (Firefox and Safari can't flash over USB),
- the amp switched on, within a few metres of where the board will sit.

## Steps

1. **Download.** Open the [latest release](https://github.com/Deulfi/Fuzhiapp/releases/latest) and download `wuzhi-amp-lean-factory.bin` or `wuzhi-amp-web-factory.bin`.
   Builds that are newer than the last release are under Actions, "ESPHome firmware", latest run, Artifacts (GitHub asks you to sign in for these).
2. **Flash.** Plug the board into the PC. Open https://web.esphome.io, click Connect and pick the board's port (often "USB JTAG/serial debug unit"). Click Install, select the downloaded file, and wait until it says done.
   If no port shows up: unplug the board, hold its BOOT button, plug it in, release BOOT, and try again.
3. **Wi-Fi.** After flashing, the same page offers "Configure Wi-Fi". Pick your network and enter the password.
   If you skip that, or the board can't reach your Wi-Fi later, it opens a hotspot named "Wuzhi Amp Bridge Setup". Join it with a phone; a page opens where you pick your network.
4. **The amp.** Close the PWA and the vendor app, so nothing holds the amp's control connection. The amp only advertises while it is free. The board finds it within a few seconds and remembers it.
5. **Home Assistant.** Settings, Devices and services: Home Assistant shows the discovered "Wuzhi Amp Bridge". Click Configure. Adopting it sets the encryption key; you don't type one.

Until Home Assistant has adopted the board, its API and wireless updates have no key, like any ESPHome device fresh from a firmware file. Adopt it soon after flashing.

## Without Home Assistant

Flash the web variant. After step 4, open `http://wuzhi-amp-bridge-xxxxxx.local` (the six characters are the end of the board's MAC address; your router's device list shows the name and IP address too). The page shows all controls.

## Updates

- **Web variant:** open the board's page, scroll to "OTA Update", and upload the `ota.bin` of the newer release.
- **Through the ESPHome Device Builder:** the board shows up there as discovered. "Take control" turns it into a normal config that the Device Builder can build and install wirelessly. From then on, follow [install-device-builder.md](install-device-builder.md).
- **Over USB:** repeat steps 1-2 with the newer `factory.bin`. Wi-Fi settings and the remembered amp are kept.

## Several amps

Each board takes the first amp whose name starts with "wuzhi". With several amps in range, power up one amp at a time while each board finds its amp, or use the Device Builder to set `mac_address` per board (see [configuration.md](configuration.md)). The Forget amp button makes a board look again.
