# Configuration reference

Everything below goes into the device's ESPHome YAML. [`wuzhi-amp.yaml`](../wuzhi-amp.yaml) contains all of it. Every entity is optional: leave out what you don't need, and the bridge also skips the reads that only that entity needs.

## Required base

```yaml
esp32:
  board: esp32-c3-devkitm-1
  framework:
    type: esp-idf

esp32_ble_tracker:
  scan_parameters:
    active: true

ble_client:
  - mac_address: "00:00:00:00:00:00"
    id: amp_ble

wuzhi_amp:
  ble_client_id: amp_ble
```

`esp-idf` is needed: Wi-Fi and BLE together don't fit well on a C3 with the Arduino framework.

## `wuzhi_amp` options

```yaml
wuzhi_amp:
  ble_client_id: amp_ble
  name_prefix: wuzhi        # BLE name prefix for finding the amp (any case)
  query_target_info: true   # read-only GetTargetInfo after auth, logged once per connection
  log_private: false        # show the amp's address and ID string in the log
  auth_delay: 1s            # wait between enabling notifications and the auth challenge
  pair: false               # BLE pairing (encryption) before auth
```

- `name_prefix`: see "Finding the amp" below.
- `log_private`: the amp's Bluetooth address and the serial-like ID string in GetTargetInfo are redacted by default. `true` shows them and logs raw received frames at VERBOSE level. Don't post such logs.
- `auth_delay`: tested with 1 s and 5 s; both work.
- `pair`: the ZK-502MT works without it. With `true`, the board pairs (Just Works) and the amp stores a pairing for it.

## Finding the amp

With `mac_address: "00:00:00:00:00:00"`, the bridge watches BLE advertisements and adopts the first device whose name starts with `name_prefix`. The ZK-502MT advertises as "wuzhi APP"; a rename in the vendor app changes that name. The address is stored on the board and survives reboots and firmware updates; from then on the bridge connects only to that amp.

To pin one amp, put its address into `mac_address`. Then nothing is searched or stored.

```yaml
button:
  - platform: wuzhi_amp
    forget_amp:
      name: Forget amp
```

Forget amp drops the stored address; the next matching amp is adopted. It does nothing when `mac_address` is set.

## Gain

```yaml
number:
  - platform: wuzhi_amp
    gain:
      name: Gain
      max_gain: 40
```

- The amp's digital level (public attribute 1), the same as the PWA's gain slider. The ZK-502MT uses 0-30 and ignores 31-40. The analog knob on the amp is separate.
- `max_gain` (0-40, default 40) is the cap. The bridge never sends a higher value; higher requests are lowered to the cap.
- Changes go in steps of 1, 120 ms apart, each confirmed by the amp. Home Assistant sees only the final value.
- If the amp reports a value above the cap (set by another app), the first write goes straight down to the cap; stepping down from there would send values above it.
- Unknown until the amp has reported its gain, and after a disconnect. Changes while unknown are ignored.

## Mute

```yaml
switch:
  - platform: wuzhi_amp
    mute:
      name: Mute
```

- On: gain to 0 in one write (lowering needs no stepping).
- Off: back to the gain before muting, stepped like any increase and never above `max_gain`.
- Changing the gain ends the mute, and so does a gain change made elsewhere.

## Connect to amp

```yaml
switch:
  - platform: wuzhi_amp
    connect:
      name: Connect to amp
```

- Off: the bridge disconnects and stays disconnected, so the PWA or the vendor app can use the amp's single control connection. Kept across reboots of the board.
- On (the default): the bridge connects again.

## Source

```yaml
select:
  - platform: wuzhi_amp
    source:
      name: Source
```

- Bluetooth, AUX, or Idle. Idle is only shown (the amp has no source); selecting it does nothing.
- Follows the amp live (source push, SysInfo push).
- Bluetooth while already on Bluetooth sends nothing: the switch would drop the phone's audio link.
- AUX without a cable sends nothing; the amp would ignore it.
- Picking Bluetooth pauses AUX priority, picking AUX resumes it.

## EQ

```yaml
select:
  - platform: wuzhi_amp
    eq:
      name: EQ

number:
  - platform: wuzhi_amp
    eq_31:
      name: EQ 31 Hz
    # eq_63, eq_125, eq_250, eq_500, eq_1k, eq_2k, eq_4k, eq_8k, eq_16k the same way
```

- Presets Normal, Rock, Pop, Classical, Jazz, Country, and User.
- The band numbers appear in the device page's Configuration section, not under Controls (set `entity_category: ""` on a band to move it back). Home Assistant sorts entities by name there, so "EQ 1 kHz" comes before "EQ 31 Hz"; a dashboard card shows them in the order you list them.
- The band numbers show the curve the amp reports, also for presets. Changing a band (-12..+12 dB) writes the User EQ with that band changed.
- The EQ only affects Bluetooth audio, not AUX.
- After power-on the amp accepts an EQ only once it has played Bluetooth audio; until then it answers every EQ write with Normal. The bridge logs that, shows Normal (what the amp really uses), and sends your choice once more when Bluetooth audio connects or the source changes.
- The EQ is not kept across power cycles of the amp; there is no command to save it.

## AUX priority

```yaml
switch:
  - platform: wuzhi_amp
    aux_priority:
      name: AUX priority
```

Off by default; the setting is kept across reboots of the board. Same rules as the PWA:

- Reacts only to changes the amp reports: AUX cable plugged in, or the amp moving to Bluetooth or idle. Turning it on, or connecting, switches nothing.
- Switches to AUX only while a cable is in. Never disconnects the phone.
- At most one switch every 2 s and 6 per minute, then a pause of a minute. Each switch is checked again 2.5 s later, because a phone often pulls the amp back.
- Picking Bluetooth in the source select pauses it; picking AUX or reconnecting resumes it.

## Beep

```yaml
switch:
  - platform: wuzhi_amp
    beep:
      name: Beep

number:
  - platform: wuzhi_amp
    beep_volume:
      name: Beep volume
```

The amp's prompt tones. Read once after connecting. The volume uses the 0-30 scale and is capped by `max_gain` like the gain.

## Disconnect phone audio

```yaml
button:
  - platform: wuzhi_amp
    disconnect_phone:
      name: Disconnect phone audio
```

Drops the phone's or computer's Bluetooth audio link. If the amp isn't on Bluetooth, it switches there first, because the command only works there. With a cable in, the amp then goes back to AUX by itself. The phone reconnects from its own Bluetooth menu.

## Sensors

```yaml
binary_sensor:
  - platform: wuzhi_amp
    aux_cable:
      name: AUX cable
    bluetooth_audio:
      name: Bluetooth audio
    connected:
      name: Amp connected

text_sensor:
  - platform: wuzhi_amp
    firmware_version:
      name: Amp firmware
    protocol_version:
      name: Amp protocol
```

- AUX cable: from the amp's state, updated by its push.
- Bluetooth audio: the amp has no push for it, so it is re-read every 30 s and after each source change.
- Amp connected: the bridge holds an authenticated link.
- While not connected, gain, AUX cable, Bluetooth audio, beep volume and the EQ bands show as unknown. The two selects keep their last value (ESPHome selects can't be set back to unknown); use Amp connected to tell.
- Amp firmware: from the Wuzhi model query, "V002.10" on the ZK-502MT. Amp protocol: from GetTargetInfo, "2.1".

## Control page

```yaml
web_server:
  port: 80
  version: 3
```

ESPHome's own web server: every entity on a page at `http://<name>.local`, without Home Assistant. Costs RAM; the lean public firmware leaves it out.

## Not included, on purpose

- Renaming the amp and changing its pairing code: both restart the amp. Use the PWA.
- The protocol logger: PWA only.
- Firmware updates of the amp: not supported anywhere in this project.
