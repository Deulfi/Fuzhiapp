# Troubleshooting

Logs: in the Device Builder, the device's Logs button; on the command line, `esphome logs wuzhi-amp.yaml`; with the web variant, the log at the bottom of the board's page. ESPHome's own BLE lines show the amp's Bluetooth address: blank it out before posting a log.

## Flashing

| Symptom | What to try |
|---|---|
| No port in web.esphome.io or `esphome run` | Use a data cable, not a charge-only one. Unplug, hold BOOT, plug in, release BOOT. Try another USB port. |
| "Permission denied" on Linux | Add yourself to the `dialout` group and log in again. |
| web.esphome.io can't connect | Use Chrome or Edge. Close other programs that hold the port (serial monitors, another browser tab). |
| Device Builder: "Plug into this computer" missing | The page isn't served over HTTPS. Use Manual download and web.esphome.io instead. |

## Wi-Fi

| Symptom | What to try |
|---|---|
| Board doesn't join Wi-Fi | Some C3 Super Mini boards have a weak antenna. Add `output_power: 8.5dB` under `wifi:` (own build), and place the board away from metal. |
| Public firmware: Wi-Fi setup lost | The board opens the "Wuzhi Amp Bridge Setup" hotspot when it can't reach the saved network. Join it and pick the network again. |
| Home Assistant doesn't discover the board | Same network and subnet? Add it by hand: Settings, Devices and services, Add, ESPHome, host `wuzhi-amp-bridge-xxxxxx.local` or the IP. |

## Finding and connecting to the amp

| Log / symptom | What to try |
|---|---|
| No `Found amp` line | Close the PWA and vendor app (the amp only advertises while free). Move the board closer. Check that the amp's Bluetooth name starts with `name_prefix`. |
| `Service AE00 with AE01/AE02 not found` | The adopted device isn't the amp. Press Forget amp, or set `name_prefix` or `mac_address`. |
| `auth: timeout waiting for step 2`, then `next connection attempt in 30 s` | Something else may hold the amp's control connection: close the PWA and vendor app. If no device can connect at all, the amp's control channel is stuck: switch the amp off and on. |
| `device response mismatch` | Not expected on a ZK-502MT. Please open an issue with the log, address blanked. |
| Phone app or PWA can't find the amp | Expected while the bridge is connected. Power the board off to use them. |
| Amp connected goes off and on | Weak BLE link. Move the board closer, away from the Wi-Fi router. |

## Controls

| Symptom | Why / what to try |
|---|---|
| Gain stays unknown | The amp hasn't reported it yet: check Amp connected. |
| Gain above 30 does nothing | The ZK-502MT ignores 31-40. |
| EQ jumps back to Normal | The amp's power-on lock: it accepts EQ only after Bluetooth audio has played. The bridge retries when Bluetooth audio connects. |
| EQ has no effect | The EQ only affects Bluetooth audio, not AUX. |
| AUX not selected | No cable plugged in; the log says `No AUX cable plugged in; not switching` (ESPHome log, not the Home Assistant logbook). |
| AUX priority does nothing | It reacts only to changes, not to its own switching on. Check that a cable is in. "Paused" in the log means Bluetooth was picked in the source select. |
| AUX priority gives up | The phone keeps pulling the amp to Bluetooth. After a minute it tries again. Disconnect phone audio helps. |
