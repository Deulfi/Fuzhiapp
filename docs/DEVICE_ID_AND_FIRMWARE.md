# Identifying the amp, and what the app knows about firmware

Companion to `PROTOCOL.md`. Same tags: **[V]** verified on the amp, **[D]** read from the decompiled app, **[I]** inferred.
Facts only; no vendor code.

---

## 1. What is certain about the device

- The Bluetooth firmware is **Jieli's** (service `AE00`, E1 authentication with the Jieli link key, RCSP framing). [V]
- **Chip: most likely a Jieli AC6925A (4 Mbit flash)**, from the marking `JL AS24BP0Q237-25A4` on the board (QSOP24; the part number after the dash is what identifies it, "25A4" = AC6925, variant A, 4 Mbit flash). [I] This comes from a separate research pass: the exact marking is not listed anywhere, so the identification rests on the marking pattern (other `-25A4` chips are AC6925A) and the matching package. An AC6925B also exists in QSOP24, so the variant letter is the least certain part.
- It agrees with what the amp reports itself: SDK type 0 = AC692x family and the "692" code path used for renaming. [D]
- The "TD5182A" from a forum thread is probably a different part on the board (for example the amplifier IC), not the Bluetooth chip. [I]

## 2. How the amp can identify itself

### 2.1 SDK type (target-info type 6) [D]
One byte in the GetTargetInfo reply. The SDK's chip-flag table:

| Value | Family / product |
|---|---|
| 0 | AC692x, AI soundbox |
| 1 | AC692x, standard soundbox |
| 2 | AC693x, TWS headset |
| 3 | AC695x, charging case |
| 4 | AC697x, TWS headset |
| 5 | AC696x, soundbox |
| 6 | AC696x, TWS soundbox |
| 7 | AC695x, sound card |
| 8 | AC695x, watch |

This is the closest the amp can come to naming its chip. It gives a family at best, not a part number, and the vendor firmware may not report it accurately.

### 2.2 Other target-info fields [D]
Request: opcode `0x03`, payload `FF FF FF FF 00`. The reply is a list of TLVs `[len][type][data(len-1)]`.

| Type | Content |
|---|---|
| 0 | protocol version (nibbles) |
| 3 | platform. An ASCII ID string on this amp [V] (content not yet recorded) |
| 5 | firmware version (code + name string); "V002.10" shown in the app |
| 6 | SDK type, see 2.1 |
| 7 | bootloader version string (or 2 bytes) |
| 10 | VID / PID, 2 + 2 bytes BE. Jieli's vendor ID is `0x05D6` |
| 11 | auth-key string |
| 12 | project-code string |

### 2.3 Wuzhi model query (custom opcode `0xFF`) [V]
Send `AA 01 01 55` inside opcode `0xFF`. The amp answers with a pushed `0xFF` frame. Tested reply from the ZK-502MT:

```
aa 12 01 | 30 30 32 | 30 31 30 | 32 32 30 33 | 01 08 00 04 01 08 | 55
          "002"      "010"      "2203"         6 raw bytes
```

| Field | Meaning |
|---|---|
| "002" | **Product code.** The app parses it as a number (here 2). Group 1–3 shows the plain UI (no volume slider, no DSP block). [D] |
| "010" | Firmware revision. The app's settings screen shows "V" + field 1 + "." + field 2 with leading zeros stripped = "V002.10", which matches the screenshot. [D] |
| "2203" | Possibly a build date (2022-03). [I] |
| 6 bytes | The app reads them as a hex-digit number and compares with 180418. Here they read `01 08 00 04 01 08`, which is not a match; it only matters for one other product. [D] |

Note: custom frames must go in opcode `0xFF`. In opcode `0x07` the amp reads the first payload byte as a function id and returns an empty reply.

## 3. Firmware the app knows about [D]

Download addresses are deliberately not listed here: this project does not offer firmware updates and doesn't link to vendor firmware.

| Product code (number) | Firmware file | Version manifest |
|---|---|---|
| 5 | `WZ100.ufw` | `Wuzhi_Audio_Firmware_WZ100.json` |
| 101 | `WZ101.ufw` | `…_WZ101.json` |
| 103 | `WZ103.ufw` | `…_WZ103.json` |
| 104 | `WZ104.ufw` | `…_WZ104.json` |
| 105 | `WZ105.ufw` | `…_WZ105.json` |
| 107 | `WZ107.ufw` | `…_WZ107.json` |
| 200 | `WZ200.ufw` | `…_WZ200.json` |

- **Product code 2 is not in the table.** The app has no firmware mapping for the ZK-502MT. The WZ files belong to other products.
- **Hazard:** when the product code matches nothing, the app's download routine defaults to the `WZ100.ufw` file. Never flash a file that does not match the amp. A wrong image can brick it.
- Format: `.ufw` is Jieli's update package. The app also ships an OTA authentication library and the SDK has an "upgrade key" check, so a given file may only flash with the right key and flow. Not investigated.
- No command was found that reads the amp's own firmware back. The SDK's flash-read operations target an external flash chip. [I] whether the main firmware is readable at all.

## 4. How to settle the chip question

1. Record the target-info fields in 2.2, especially type 6 (SDK type) and type 3 (platform string).
2. Record the model-query reply (2.3).
3. Read the markings on the chip(s) on the board. Done: see section 1.

## 5. Measured results from a ZK-502MT [V]

GetTargetInfo reply, decoded. The EDR address and the serial-like part of the platform string are redacted; do not publish them.

| Type | Raw | Meaning |
|---|---|---|
| 0 | `21` | protocol version 2.1 |
| 1 | `32 14 1e 00` | `[battery 0x32][volume 20][max volume 30][flags 0]`; bit 0 clear = **no volume sync**, so use the device's own volume (range 0…30) |
| 2 | `xx xx xx xx xx xx 2d 01` | EDR address (6 bytes, byte order not checked), profile `2d`, status `01` = connected |
| 3 | `01` + ASCII `WZ001…` (17 chars) | platform: one byte `01`, then an ID string starting "WZ001" (rest looks serial-like, redacted) |
| 4 | `00 00 00 0b 00` | function mask: `0b` = bits 0, 1, 3 = Bluetooth, Music, AUX. Music is reported although the board has no USB/SD [I on layout] |
| 5 | `00 00` | firmware version code: zero (the amp does not report it here; "V002.10" comes from the model query) |
| 6 | `00` | SDK type 0 (the AC692x row of 2.1) |
| 7 | `fe 9f` | bootloader version, 2 bytes |
| 8, 9 | `00`, `00` | OTA backup flags, upgrade flags |
| 10 | `00 00 00 00` | VID/PID: zero |
| 11, 12 | empty | auth key, project code: empty |

Not reported at all: types 13 (MTU), 14, 16 (name), 17 (BLE-only), 19 (supported functions), 31 (custom version). Use the default MTU; take the name from Android.

Later readings from the same amp (ESP32 bridge, several connections) [V]:

- Type 1 flags byte: `00`, `20`, `6b`, `75` on different connections. It is not a fixed capability field; don't read meaning into it.
- Type 2 status: `00` while no phone or computer is connected for audio, `01` while one is.
- Type 3: 17 data bytes in total, `01` + 16 ASCII characters. The "17 chars" in the table above is the length including the `01`.
- Type 7 bootloader bytes: `fe 9f`, `ff 97`, `ff 93`. These change too, so they don't identify the bootloader version either.
- Type 4 current function: `03` (AUX) when read on AUX.

Model query: `"002"`, `"010"`, `"2203"`, bytes `01 08 00 04 01 08` (see 2.3; the 6 bytes do not match the 180418 the vendor app compares against).

**What this says about the chip:** SDK type 0 (AC692x family) is consistent with the board marking, which identifies a Jieli AC6925A (section 1). Treat the exact variant as likely, not proven.

## 6. What the vendor's firmware files say about this amp (2026-11-22)

A separate analysis looked at the update files the vendor serves (report: `firmware_cleanroom_report.md`, not part of the public docs). Only behaviour and constants were recorded, no code. Everything below is "from firmware, to confirm on the device".

- **None of the files is for the ZK-502MT.** They are built with Jieli's AC695N soundbox SDK for about 1 MB of flash. The AC6925A in the ZK-502MT has 4 Mbit (512 KB) and uses the older AC692x SDK. The vendor app's update file name, `updata.bfu`, is the AC692x container format, which fits the chip. Never put one of these files on a USB stick for this amp: the AC695N builds look for `*.ufw` files on a stick at boot and flash them.
- **The auth key and `pass` are the same in every file**, so they are not per device. That matches what the app and the ESP32 bridge already use.
- **Volume:** the ceiling of 30 is a stored setting (`max_vol`), not a fixed limit. There is also a `vol_sync` setting, so some builds push knob changes. Target-info type 1 byte 3 probably holds this; not decoded.
- **`AA 02 08 80 55`** after the source-select command is most likely a plain ack.
- **Settings:** the AC695N builds keep volume and EQ in flash. The ZK-502MT does not keep EQ across a power cycle (tested), so its build behaves differently.
- **Disconnect phone audio while on AUX:** the firmware's disconnect command is not tied to Bluetooth mode in those builds. On the ZK-502MT, opcode 06 only works on Bluetooth (tested).
- **LED and DSP:** handlers exist in the AC695N builds. The ZK-502MT's empty replies are product configuration.
