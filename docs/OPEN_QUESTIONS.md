# Open questions

Things we must confirm on the real ZK-502MT before the UI depends on them.
Status: **open** / **answered** (date, evidence). Spec refs are to PROTOCOL.md.
Device-unique values (Bluetooth address, serial-like strings) are redacted here: this file is public.

## What the amp reported (2026-11-19, logger session 1, Windows + desktop Chrome)

GetTargetInfo (opcode `0x03`) payload as TLVs `[len][type][data]`:

| type | data seen | reading |
|---|---|---|
| 0 | `21` | protocol version 2.1 (matches spec) |
| 1 | `32 1e 1e 00`, later `32 1e 1e 49` | `[50][vol 30][max 30][flags]` per spec. 50 = "battery" though the amp has none. Flags changed `00`→`49` between connections (see C3) |
| 2 | 6-byte address, `2d`, `01`/`00` | EDR address + profile `2d` + status. Status was `01` while A2DP was connected, `00` when it wasn't |
| 3 | `01` + 16 ASCII chars (`WZ…`) | **Not an MTU** as the spec says. Looks like a serial/ID string. Meaning unknown |
| 4 | `00 00 00 0b` + `00`/`03` | `0x0b` = functions 0 BT, 1 Music, 3 AUX. Last byte = current function (`00` BT, `03` AUX, matched what was playing) |
| 5 | `00 00` | firmware version code 0? |
| 6 | `00` | ? |
| 7 | `ee 93`, later `ff 97` | not in spec; changes between connections |
| 8, 9 | `00` | ? |
| 0x0a | `00 00 00 00` | VID/PID both 0 |
| 0x0b, 0x0c | empty | ? |

Not reported: 13 (MTU), 16 (device name), 19 (supported functions).

GetSysInfo public, mask `FFF7`. The amp returned attrs 0, 1, 2, 4, 5, 6 only:

| attr | data | reading |
|---|---|---|
| 0 | `32` | 50, same as target-info type 1 byte 0. Varies 49–51 between reads: a live measurement (supply voltage?), not a setting |
| 1 | `1e` | **volume 30** (= reported max 30) |
| 2 | `10` + 16 × `00` | unknown |
| 4 | `00` + 10 × `00` | EQ mode 0, ten gains all `00` |
| 5 | ASCII `MP1MP2MP3WAV` | probably supported music formats |
| 6 | `00` / `03` | current function, matches type 4 last byte |

**Not returned:** 7 (light), 8/9 (FM-TX), 0x0B (bass/treble), 0x0C (EQ presets), 0x0D (noise).

## Transport / connection
| # | Question | Spec | Status |
|---|---|---|---|
| T1 | What does the amp advertise? | §2, §8.3 | **answered**: BLE name `Wuzhiapp APP` (audio device is `Wuzhiapp`). `AE00` is **not** in the advertising data: the service filter finds nothing. Pick by name prefix, with "all devices" as fallback (the name may be renameable) |
| T2 | Is BLE bonding required? | §2, §8.3 | **answered on Windows: no** (no pairing prompt from Chrome or Windows). Untested on Android |
| T3 | Does the amp accept a frame split across 20-byte writes? | §2 | **answered: yes**. 22-byte EQ frames sent in 2 chunks were accepted and applied |
| T4 | Must the host complete auth steps 4–5? | §4 | **answered: yes.** With steps 4–5 skipped, the amp sent its challenge and then ignored GetTargetInfo, GetSysInfo and 0x1F |
| T5 | Command order after auth; is `SettingsMtu` needed? | §5 | **partly answered**: GetTargetInfo → GetSysInfo straight after auth works, no `SettingsMtu` needed |
| T6 | AE01 write type | §2 | **answered: write without response** (AE01 has only `writeWithoutResponse`; the spec's "use with-response" is wrong for this amp) |
| T7 | Re-running the handshake on an authenticated link | – | **answered**: the amp doesn't reply to a second challenge, and commands keep working. Auth once per connection |
| T8 | Notification size | – | On Windows a whole 82-byte reply came in one notification (MTU was negotiated by the OS). Android may split; reassembly still needed |
| T9 | Does the amp drop an idle link? | – | **answered: no**. Idle for 4+ minutes, link stayed up (Windows) |

## Device info / capabilities
| # | Question | Spec | Status |
|---|---|---|---|
| C1 | Which functions does it report? | §5, §8.7 | **answered, but over-reports**: mask says BT, Music (USB/SD), AUX. The ZK-502MT board has **no USB/SD** (user). The firmware is shared across Wuzhi models, so reported bits can't be trusted alone |
| C2 | Max volume and current volume | §5, §6.3 | **answered**: max 30, current 30, and it does not move with the physical knob or Windows volume. It's a separate digital level. What it controls is open (V1) |
| C3 | "Volume sync supported" flag (target-info type 1, byte 3) | §5, §12.3 | **answered [D]**: only bit 0 is read (volume sync). Seen `00`, `49`, `74`, `34`; bit 0 was set only in `49`. Other bits are ignored by the app, so we ignore them too |
| C4 | Target-info type 3 and types 7–0x0C | §12.3 | **answered [D]**: 3 = ID string (tested), 7 = bootloader version, 8 = OTA backup flags, 9 = upgrade flags, 10 = VID/PID, 11 = auth key, 12 = project code. Nothing the app needs |

## Settings encoding
| # | Question | Spec | Status |
|---|---|---|---|
| S1 | High/bass attr `0x0B` order and range | §6.3, §8.4 | **likely n/a on this model**: attr not reported, and the bass/treble knobs don't change anything the amp reports (analog tone controls) |
| S2 | Standard EQ attr 4 gain encoding | §6.3, §8.5 | **answered: signed bytes** (`fe` = −2, `fa` = −6). Writing a preset mode makes the amp fill in that preset's gains; mode 6 keeps the gains we send (custom). Open: allowed range for custom gains (S6) and preset names (S7) |
| S6 | Custom EQ (mode 6) gain range | – | ±8 dB tested (read back exactly). The vendor app offers ±12 (user) and its EQ readback `AA 01 1B 55` is dB + 12 [D §12.4]. App now allows ±12; to confirm: set +12/−12 and check the readback |
| S7 | Preset names | §12.1 | **answered (tested)**: 0 Normal, 1 Rock, 2 Pop, 3 Classical, 4 Jazz, 5 Country, 6 User |
| S3 | Lights | §6.4 | **answered: not supported** (no function 5, no attr 7) |
| S4 | Source switching via `0x0E` | §6.5 | **answered**: `0E FF 03` → AUX, `0E FF 00` → BT, both work and are confirmed by attr 6 and pushes. `0E FF 01` (Music) on this board behaves like AUX. `0E FF 00` while already on BT drops and reconnects BT audio (playback pauses) |

## Wuzhi DSP (opcode `0xFF`)
| # | Question | Spec | Status |
|---|---|---|---|
| D1 | What does `0x1F` return? | §7, §8.1 | **answered: nothing**. Reply is status `00`, sn, empty payload. DSP state can't be read back |
| D2 | Crossover index → Hz mapping | §7, §8.2 | open |
| D3 | DSP EQ (`0x0B`) vs standard EQ (attr 4): same stage? | §6.3, §7 | open |
| D4 | What is "DSP mode"? | §7 | open |
| D5 | Pushes from the amp on opcode `0xFF` | §7 | **seen**, see D6 |
| D6 | Amp push `AA 02 21 xx 55` on opcode `0xFF` | – | **answered**: source-changed notification. `xx` = `01` BT, `03` AUX (not the function ids; BT is `00` there). Sent 2–4 times per change; still repeated when acked, so the repeats are normal. Acking does no harm |
| D8 | Amp push on opcode `0x09` | – | **answered**: SysInfo-changed notification, flags `80` (no reply wanted), payload in GetSysInfo layout `[function][TLVs]`. Seen: `ff` attr 4 after an EQ change (new mode + gains), `ff` attr 2 when AUX cable plugged/unplugged, `03` (AUX) attr 0 = 1 after switching to AUX (AUX playing?) |
| D9 | Public attr 2 (17 bytes): byte 0 = `10` with AUX cable in, `00` without. Rest always 0. Other bits? | – | **partly answered** (AUX-detect bit 4) |
| D7 | Does this amp have the Wuzhi DSP at all? It has analog tone knobs; the DSP screens may be for other models (ZK-MT21 etc.) | §7 | open |

## Volume and sources
| # | Question | Status |
|---|---|---|
| V1 | What does the digital volume (attr 1) control? | **answered**: audible on both BT and AUX. Range 0–30 (reported max); values above are accepted but do nothing audible. The amp remembers the value across BLE reconnects |
| S5 | Can the app hold AUX? | **feasible, with limits**: switching works and is announced (D6). But (1) with no AUX cable, "switch to AUX" is ignored (amp stays on BT); (2) plugging a cable in doesn't take the amp off BT; (3) after switching to AUX while a phone is connected, the phone still shows BT as active but plays into nothing until it reconnects. See S8 |
| S8 | Can the app make the amp drop the phone's BT audio link? | §12.3 | **answered (tested)**: opcode `0x06` drops the classic link (phone and Windows); BLE stays up. With an AUX cable in, the amp switches to AUX by itself. With no cable, it goes idle (pushes `0x21 05`); plugging a cable in then switches to AUX on its own; the phone does not reconnect by itself (the user has to tap it). **Only works while the amp is on Bluetooth** (tested again 2026-11-20: sent after switching to AUX it did nothing, and the phone pulled the amp back to Bluetooth) |

## Vendor-app settings (seen in the vendor app, 2026-11-19)
| # | Question | Status |
|---|---|---|
| A1 | Settings commands (§12.2) | **mostly answered (tested)**: model read works; beep read works (showed the value set in the vendor app) and beep write reads back (amp pushes `AA 02 02 80 55` after each write); pairing-code read works (on); LED read gets no reply (no indicator LED setting on this amp?). Rename from the vendor app also changed the BLE name ("wuzhi APP"). The model reply's len byte is one higher than its size. Not yet tested: whether beep volume is audible as a change |
| A2 | Pairing code | **answered (tested)**: classic-BT PIN; Windows asks for it when re-pairing (default 1111). Setting it (`AA 06 03 …`) gets no reply and the amp restarts by itself (BLE drops ~6 s later), like rename. The BLE control link never needs it |
| A3 | "Sound card" play mode | **answered [D]**: not a function id; public attrs 0x11–0x13 on other boards. Not relevant here |
| A5 | `AA 01 04 55`: power-off or standby? | **answered (tested)**: amp acks `AA 02 04 80 55`, pushes `0x21 05` (idle), BLE drops a few seconds later. It reconnects, but stays half-asleep: source switching is ignored (gain and beep writes still work) until a power cycle. Not a useful feature |
| A6 | Beep volume | **answered (tested)**: louder at 30. A beep write interrupts playback and plays a test beep (the BT start sound) |
| E1 | EQ write answered with Normal | **answered (tested, 2 logs)**: after a power cycle the EQ is Normal and every EQ write is pushed back as Normal, on any source, even after "switch to BT". Once the amp has been used as a Bluetooth playback device (Windows output selected), writes are accepted and keep working on AUX after BT is disconnected, until the next power cycle. Firmware quirk; cause unknown. The EQ is not kept across power cycles. Spec session's tests are already answered by the logs: a refused write is not stored (readback stays Normal), so it does not apply later when playback starts; it has to be sent again. **Audible result (user): the EQ does nothing on AUX**, only on Bluetooth audio. Analysis session's EQ-without-audio test is covered by these logs (readback via GetSysInfo attr 4 and the 0x09 push). `AA 01 1B 55` is a second readback (logger button), not needed by the app |
| A7 | Rename | [D, spec session]: one frame `AA (n+1) 05 name 55`; the amp restarts by itself, then the old pairing must be removed and the new name paired. The vendor app's two buttons send the same frame. Not yet tested in our logger |
| A8 | Reboot `0xE7 00` (SDK RebootDeviceCmd) | **answered (tested)**: no reply (timeout) and no effect on the ZK-502MT. Not in the app |
| A9 | Which phone/computer is connected for audio? | **answered (logs)**: not reported. Target-info type 2 has a fixed address (the amp's own; same with phone and Windows) plus a connected flag. The app shows connected / not connected only, polled every 5 s since nothing is pushed while on AUX. Could ask the spec session if any command returns the peer's name. Spec session confirms: nothing returns it [D] |
| P3 | AUX across power cycles | **answered (tested)**: neither `AA 02 08 03 55` nor `0E FF 03` survives a power cycle; the amp starts on Bluetooth either way. No stored setting known [D]. The app enforces AUX priority only while connected |
| A10 | Model query `AA 01 01 55` (opcode 0xFF) | **answered (tested 2026-11-19)**: product code **002** ("WZ002"), then "010", "2203", and 6 bytes `01 08 00 04 01 08` = digits 180418, exactly the vendor app's authenticity value. 002 is not in the vendor app's known list (005→100, 101, 107, 200); per §12.4 it falls in the 1–3 group. Target-info type 12 (project code) is empty on this amp (`01 0c`), so it can't confirm the code. Firmware files/OTA are out of scope |
| A11 | Chip | **likely Jieli AC6925A** (4 Mbit flash): board marking `JL AS24BP0Q237-25A4`, QSOP24; `-25A4` = AC6925, variant A, 4 Mbit. Not proven (exact marking unlisted; an AC6925B also exists in QSOP24). Agrees with SDK type 0 (AC692x). Older boards reportedly used a different chip (TD5182A in forum posts). The app does not show the chip; README mentions it as a check Supporting hint: the vendor app's update file name `updata.bfu` is the AC692x container format (DEVICE_ID_AND_FIRMWARE.md §6) |
| A12 | Firmware for this amp | **none known**: product code 2 has no entry in the vendor app's update table. No OTA feature, no links to vendor firmware |
| A13 | SDK probes (SDK_EXTRAS.md §2): feature map, MD5, low-latency, headset settings, attributes per function, reverb/limiter state | **answered (tested)**: MD5, low-latency and headset settings get no reply. FM, light, FM transmit, EQ function, low-power, reverb, limiter, high/bass and the EQ preset table are empty or error; Music errors. Feature map is `ff ff ff ff` (no information). RTC is a fixed 2018 date that does not run; alarm bytes change between runs (uninitialised). Nothing here for the app. Details in SDK_EXTRAS.md §6 |
| A14 | 7-band L/R EQ read, `FF 00 01 00 00` (SDK_EXTRAS.md §7; likely another product's) | **answered (tested)**: status 00 with an empty payload, so this amp does not have it. The Set form was never sent. This closes the SDK probes for the ZK-502MT |
| A15 | USB port soldered onto a ZK-502MT (user mod) | **open, tested 2026-11-22**: with no stick, Music (07 01) answers status 01, and `AA 02 08 02 55` (USB select) is acked (`AA 02 08 80 55`) but the source stays AUX; 0E FF 01 is accepted with status 00 and also stays AUX. Online bits show only 0.4 (AUX). Plugging a stick in: the amp stops answering BLE within ~2 s, and the link drops ~5–10 s later (seen twice). After reconnecting, the source was still AUX and the gain unchanged, so it looks like a BLE/link failure or partial reset, not a cold boot (a cold boot starts on Bluetooth). Second test: with a stick in and the amp running, nothing changes (online bits stay at 0.4, no push). Switching to Music/USB cuts the sound, and the amp falls straight back to AUX (`21 03` pushes, SysInfo push `03 02 00 01`). That is how it behaves when the Music source has no device, so the firmware does not see the stick. A USB meter in line shows no clear voltage drop on plug-in (but a meter is too slow to show a short dip). The crashes on plugging in happen only sometimes, and sometimes repeat; reconnecting then takes about 12 s. Open: power dip vs data lines vs a loose connection, and whether this firmware has USB host enabled at all. Booting with the stick already in works: the voltage wobbles during boot and then recovers. Datasheet: USB D−/D+ are pins 4 and 5 of the AC6925A (QSOP24). The same pins can also be UART1, I2C, SPI2 or an ADC input, and they are pulled down by default. If the board uses them for something else, a USB device on them could upset that; worth tracing where the pads go. Parked for now |
| A4 | Vendor app "Multimedia" (white noise "lullaby", local files, USB drive): local files are the phone playing over normal BT audio, nothing amp-specific | **decided**: not in scope (see DECISIONS) |

## Live sync
| # | Question | Spec | Status |
|---|---|---|---|
| L1 | Does turning the knob / changing source push a frame? | §8.6 | **answered**: volume/bass/treble knobs: nothing pushed, nothing changes in GetSysInfo. Source: attr 6 changed `03`→`00` when BT audio connected, and the amp pushed D6 |

## Platform (Web Bluetooth)
| # | Question | Status |
|---|---|---|
| P1 | Does `getDevices()` / reconnect without the chooser work? | **partly answered**: desktop Chrome needs `chrome://flags/#enable-web-bluetooth-new-permissions-backend`. After a browser restart, `gatt.connect()` fails with "Bluetooth Device is no longer in range" until the browser has seen an advertisement; the transport now calls `watchAdvertisements()` and retries (untested on the amp). Reconnecting right after a disconnect can fail with "GATT Server is disconnected"; retried after 800 ms. Android Chrome: worked (user report, 2026-11-20); not retested, Chrome was uninstalled in favour of Brave. Android (Brave): the Reconnect button once failed with "no longer in range" while a page reload reconnected at once; likely a stale device object. Reconnect now fetches a fresh one from `getDevices()` and backs off when `watchAdvertisements()` is missing (untested) |
| P4 | Brave (desktop and Android) | **answered (tested)**: Web Bluetooth is off by default; works after enabling `brave://flags/#brave-web-bluetooth-api`. Same "no longer in range" behaviour after a restart as Chrome |
| P5 | Android permission | **answered (tested)**: the browser needs the "Nearby devices" permission to list the amp |
| P6 | How many BLE control connections at once? | **answered (tested)**: one. While a device holds the control link, the amp doesn't appear in other devices' Bluetooth choosers. Any always-connected bridge (background app, ESP32, HA) locks out the PWA |
| P7 | Connect with Bluetooth switched off | **fixed**: the browser's "adapter not available" error was treated like a cancelled chooser and ignored. The app now checks `getAvailability()` first and says Bluetooth is off |
| P2 | Background link drop on Android | open |
