# SDK commands the Wuzhi app does not use, and what they could give us

Companion to `PROTOCOL.md`. Tags: **[D]** read from decompiled code, **[I]** inferred. Nothing here is tested on the amp unless said.

## 0. Caveat
The command set the amp understands is decided by the firmware Wuzhi compiled, not by the chip. The SDK defines more commands than any one product implements, so everything below is "might work". Probe read-only first.

## 1. The auto-switch-to-Bluetooth problem
Honest result of the search: **no command or setting in the SDK controls the power-on source or the auto-switch behaviour.** Nothing is named "default mode", "AUX priority" or "auto switch". That logic lives in the firmware. Only the levers below exist.

**Recommended: an app-side workaround [I].** The amp announces when AUX is online (public sysinfo attr 2, bit 4, also in the `0x09` push; the vendor app uses the same bit to enable its AUX tile). So:

1. On every BLE connect, read public sysinfo attr 2 (`GetSysInfo`, function `FF`, mask `00000004`).
2. If the AUX bit is set and the current source is not AUX, send the AUX switch (`0E FF 03`, or the vendor frame `AA 02 08 03 55` in opcode `0xFF`).
3. Optional: also re-check after a few seconds, since the amp may switch to Bluetooth right after power-on.

Limit: this needs the app connected after each power-on. A small always-on BLE helper (for example an ESP32 or a Raspberry Pi) could do the same without a phone. Idea only.

**Untested levers [I]:**
- **Disconnect the Bluetooth audio link:** opcode `0x06` (no parameters, response expected). If the amp switches to Bluetooth when a phone connects or plays, dropping that link may keep it on AUX. Effect on this firmware unknown.
- **Which switch command persists over a power cycle:** the standard Function command or the vendor `AA 02 08 n 55`. Worth testing both (see the implementation prompt).

## 2. Read-only probes (safe; none changes any setting)
All are host commands with `flags = 0xC0`. If the amp does not implement one, expect an error status or an empty reply.

| Probe | Opcode and payload | Expected reply | Why it is interesting |
|---|---|---|---|
| Feature map | `0x02`, no payload | 4-byte mask [D] | Shows which optional features the firmware advertises. Bit meanings are not known to me; compare against a phone-less log |
| Device MD5 | `0xD4`, no payload | 32 ASCII chars [D] | A fingerprint of the exact firmware/resource build. Useful for telling revisions apart |
| Low-latency settings | `0xD5`, no payload | `BE16` + `BE32` [D] (defaults 20 / 50) | Headset game mode; probably unsupported |
| Headset-style settings | `0xC1`, payload `FF FF FF FF` | TLVs: 0 battery, 1 device name, 2 key settings, 3 LED settings, 4 mic channel, 5 work mode, 6 product message, 7 connected time, 8 in-ear check, 9 language, 10 ANC mode list [D] | Shows which of these the firmware exposes. An LED-settings entry might be a second way to set the indicator |
| Attributes per function | `0x07`, payload `[function] FF FF FF FF` for function `00`…`07` and `16` | TLVs per attribute | Enumerates every attribute the firmware has. Function `0x16` ("low power") is a constant in the SDK whose meaning I could not find; its reply is worth seeing |
| Device online status | `0x07`, payload `FF 00 00 00 04` | TLV attr 2 | Which sources are online (AUX = bit 4); basis for section 1 |
| EQ preset table | `0x07`, payload `FF 00 00 10 00` | attr `0x0C` | The amp's own preset gain values |
| Phone status | `0x07`, payload `FF 00 00 80 00` | attr `0x0F` | Call state; probably not useful |
| Reverb / limiter state | `0x07`, payload `FF 00 01 00 00` | attr `0x10` | Whether the Advanced-EQ features exist (see 3) |

## 3. Features the SDK has that Wuzhi's screens expose but we have not covered
- **Reverb and dynamic limiter** (the vendor's "Advanced EQ" page). Written through SetSysInfo, public function, attr `0x10`, data `BE32 type + payload` where the type is a bit mask: reverb = 1 with `[on][depth BE16 0…100][strength BE16 0…100]`; limiter = 2 with `BE16` signed −60…0. [D] If the amp supports them (the probe above answers that), they add reverb and a limiter to the EQ screen.
- **EQ presets in the amp.** `Function` music cmd 5 = "next EQ mode" and the preset table in the probe above. Probably less useful than writing EQ values directly.
- **High/bass pair** (public attr `0x0B`, two 32-bit values). The vendor app has it; which value is bass and which is treble is still unsettled.

## 4. Writes that exist but are untested (only try deliberately)
- **Restore** (`Function` function 0, cmd 1, extra byte: 0 restore, 1 restore mode, 2 prev, 3 next, 4 pause, 5 play). Meant to bring a Bluetooth source back to a state. Not used by the vendor app. [I]
- **Standard device name** via SetADVInfo (opcode `0xC0`, LTV type 1). The vendor app does not use it for this amp; it uses its own frame `AA n+1 05 name 55`.
- **Emitter / transmitter mode** (public attrs 9 and 0xA) is for products that act as a Bluetooth transmitter; unlikely here.

## 5. Not relevant to this amp
File browsing and transfer, large-file transfer, external flash, watch resources, speech, TWS headset key/ANC settings, phone-call requests. These belong to other Jieli product types.

---

## 6. Probe results from a ZK-502MT [V]
Run twice: once idle, once with Bluetooth audio playing. Results were identical except where noted.

**Not supported (the amp ignores the command, no reply within 2 s):** Device MD5 (`0xD4`), low-latency (`0xD5`), headset-style settings (`0xC1`). Do not send these in the app; each would just time out.

**Supported or meaningful:**

| Probe | Result |
|---|---|
| Public sysinfo, mask `FFF7` | Attributes present: 0 (constant, no battery on an amp), 1 volume (`14` = 20), 2 online status, 4 EQ (`00` + ten zero gains = Normal), 5 file types (`"MP1MP2MP3WAV"`, left over from the SDK, unused), 6 current source (`00` = Bluetooth) |
| Online status (attr 2) | `10 00 00…` (17 data bytes): **first byte bit 4 = AUX cable inserted** (still set with Bluetooth audio playing). Matches the power-on problem: AUX cable in while the source is Bluetooth |
| Function 3 (AUX) | one attribute, type 0, data `01` |

**Not supported or empty:**

| Probe | Result |
|---|---|
| Feature map (`0x02`) | `ff ff ff ff`: every bit set, tells nothing |
| Function 0 (Bluetooth), 4 (FM), 5 (Light), 6 (FM transmit), 7 (EQ), `0x16` (low power) | status 0, **no attributes** |
| Function 1 (Music) | **status 1 = error**. The function mask in target info says Music is present, but it is not |
| Function 2 (RTC) | the clock reads a fixed `2018-11-13 10:15:08` in both runs (not running), and the alarm data differs between runs and looks like uninitialised memory. **No usable clock or alarm** |
| Public attrs `0x0C` (EQ presets), `0x0F` (phone status), `0x10` (reverb / limiter) | status 0, empty. **Reverb and limiter are not supported.** `0x0B` (high/bass) and `7` (light) were also absent from the `FFF7` reply |

**What this means for the app:** the amp's SDK surface is small. What works through the standard commands: **volume, EQ, source and the AUX-online bit.** Plus the vendor custom frames from section 12 of `PROTOCOL.md` (name, pairing code, beep, indicator, source select). Hide or drop screens for FM, light, reverb, limiter, high/bass, RTC, alarms, music and OTA.

### New: live source push
When the source changes the amp pushes `AA 02 21 n 55` in opcode `0xFF` with flags `C0` (it wants an ack): `n` = 3 AUX, 1 Bluetooth (2 USB and 4 sound card by analogy [I]). Observed behaviour:
- The same push arrives **several times** in a row (sequence numbers 1, 2, 3, 5 for one AUX insert, and 6 to 9 for the removal). Ack every one, but update the UI from the state, not from each push.
- An `0x09` sysinfo push (`03 02 00 01` = AUX, attr 0 = 1) accompanies the AUX insert.
- Use the `0x21` push for live source tracking. Together with attr 2 it is everything the AUX-priority workaround needs.

### Note on target-info type 1
Byte 3 read `00` on the first report and `ee` on this one, while volume and max stayed 20 / 30. Treat that byte as unreliable (bit 0 stays clear, so volume sync is still off).

---

## 7. Why LED (`1A`) and DSP (`1F`) get no useful reply, and what is left [D]

**Product gating.** The vendor app decides which features to show from the product code (model query, section 12.4 of `PROTOCOL.md`):

| Product code | Indicator-brightness card | DSP block |
|---|---|---|
| 1, 2, 3 (**this amp is 2**) | hidden | hidden |
| 4 | **shown** | hidden |
| 200 | hidden | **shown** |
| 5 / 101 / 107 / others | see the app; 107 shows a "MAX GAIN" slider and a firmware row | – |

So for product 2 the amp has no indicator-brightness or DSP feature, and the vendor app would never show them. No reply to `AA 01 1A 55` and an empty reply to `AA 01 1F 55` are the designed result, not a missing step. Further probing of these two is a dead end.

**Persistence.** I read every place the vendor app builds a custom frame. The complete list of command ids it uses is `01 02 03 04 05 07 08 09 0A 0B 0C 0D 0E 0F 12 13 19 1A 1B 1C 1F 21 22 33`. None is a "save", "store", "power-on source" or "memory" command, and the app stores the user's EQ and source choices in its own preferences. The amp keeps EQ and source in RAM only. App-side re-apply (profiles) is the only mechanism there is. Firmware changes would be needed for more.

**`0x0F`.** `AA 02 0F 01 55` is sent only when product 200 selects its "User" EQ mode. Not applicable to product 2.

**The one family left untested.** The vendor's hidden test screen has a different, unwrapped EQ frame family (no `AA…55`), for a 7-band left/right EQ at 50, 125, 315, 800, 2000, 5000, 12500 Hz:
- Set: `00 00 01 02 07`, then 7 × `[freq BE16][gain int8]` for the left channel, then the same for the right.
- Get: `00 01 00 00` (4 bytes; the app leaves the last two as zero).

It looks like it belongs to another customer's product. A read-only try of the Get in opcode `0xFF` is cheap; do **not** send the Set blind, since it rewrites the EQ.

## 8. What else the SDK has, and why it is not worth chasing
Find-device (`0x19`), phone-call requests, speech, file browse/transfer, external-flash and watch commands, TWS headset settings, emitter mode, noise/ANC modes. They belong to other Jieli product types, or the probes already showed the amp ignores them.
