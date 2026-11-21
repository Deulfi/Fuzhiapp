# Decisions

Short log. Newest last. Each entry: date, decision, why.

## 2026-11-19 — Clean-room rules
Implement only from PROTOCOL.md and from observations on the user's own amp. No decompiled vendor code or vendor assets in the repo. The `original app images/` folder holds vendor screenshots: keep it out of git (`.gitignore`).

## 2026-11-19 — Volume safety
- No volume command is ever sent above a user-confirmed cap. Until the cap is confirmed, the app sends **no** volume writes at all.
- Volume changes are stepped (one unit at a time, with a short delay), never jumped.
- Nothing is auto-sent on connect (including stored profiles) until each setting is verified on the device and the user enables it.

## 2026-11-19 — Spec trust
`[V]` items are used as-is. `[D]` and `[I]` items are logged in OPEN_QUESTIONS.md and only drive UI once confirmed on the device.

## 2026-11-19 — Platform: Web Bluetooth PWA (confirmed by user)
TypeScript, Vite, Vitest; hosted on GitHub Pages (HTTPS). Targets Android Chrome and desktop Chrome.
Accepted limits: no MTU request (writes chunked to 20 B), reconnect may need a chooser tap, link may drop in background, no widgets/tile. Fallback if a blocker appears: native Android (Kotlin). Protocol code is kept free of DOM/Web Bluetooth types so it can be ported.

## 2026-11-19 — Outgoing guard (src/protocol/safety.ts)
Every write passes `checkOutgoing`. Volume writes: blocked with no confirmed cap, blocked above it. OTA opcodes (0xE1–0xE8): always blocked. Raw sends must be complete frames or an auth message (stops a frame being split past the guard). Read-only queries (0x03, 0x07, DSP 0x1F) pass; anything else needs a confirm.

## 2026-11-19 — Logger first, separate page
`logger.html` is a standalone debug page and stays in the app as a dev tool. The device chooser defaults to "all devices" with `AE00` as an optional service, because what the amp advertises is unknown (T1).

## 2026-11-19 — From the first device log
- The full 5-step handshake is mandatory (T4). Auth runs once per connection (T7).
- Writes use "without response": that's the only write type AE01 offers (T6). The transport already picks it automatically.
- No light screen: the amp reports no light function and no light attribute (S3).
- Source options come from the target-info type 4 mask (BT, Music, AUX on this amp), not a fixed list.
- Logger exports stay out of git (they contain the Bluetooth address and a serial-like string).

## 2026-11-19 — From the second device log
- Device discovery: Chrome device-chooser filter by name prefix `Wuzhi`; "all devices" stays available as fallback (`AE00` isn't advertised).
- Screens are shown from **reported support ∩ model profile**. The firmware is shared across Wuzhi models and over-reports (Music bit set on a board with no USB/SD). Start with a ZK-502MT profile: sources BT + AUX; no light, no bass/treble (analog knobs). Users can hide anything that turns out not to work.
- Volume control in the app is the amp's digital level (attr 1, 0–30), separate from the analog knob. Not exposed in the UI until V1 is understood.
- The app must answer amp-initiated commands (flags `C0`) with a bare ack. Exact reply format is [I] until tested (D6).

## 2026-11-19 — Framing layer (src/protocol/codec.ts, client.ts, info.ts)
- `FrameReassembler` treats notifications as a byte stream: handles split frames, several frames per notification, garbage, and false starts (bad end byte, paramLen > 2048).
- `RcspClient` owns the sequence number and matches replies by (opcode, sn), 2 s timeout. Non-zero status = error.
- Device pushes that ask for a reply get a bare ack `[00][sn]`, on by default; the guard allows bare acks only.
- TargetInfo / SysInfo parsers keep unknown TLVs raw. Test fixtures use real captures with the address and ID string replaced.

## 2026-11-19 — From the write tests
- Volume: the amp accepts any value and doesn't clamp. The app clamps to `min(user cap, reported max)`, and the logger guard now does the same. The app's volume slider is 0–max (30 on this amp).
- Source control: BT and AUX buttons for the ZK-502MT. Don't send "switch to BT" when already on BT: it drops the BT audio link.
- Live source state comes from the `0x21` push (D6), with GetSysInfo attr 6 as a fallback.
- "Stay on AUX" is a planned feature (S5), off by default.
- Reply timeouts start after the write completes. Before, time spent in the guard's confirm dialog counted, which gave false timeouts.

## 2026-11-19 — From the EQ test
- EQ screen uses the standard EQ attribute (attr 4): preset = mode only, custom = mode 6 + 10 signed gains. Presets are labelled by number and shown as a curve until names are confirmed (S7). Custom gains are limited to ±6 dB until the range is tested (S6).
- Live sync uses three pushes: `0x21` (source), opcode `0x09` (SysInfo changes: EQ, AUX cable), plus a GetSysInfo on connect.
- The AUX button is disabled when no AUX cable is detected (attr 2 bit 4), because the amp ignores the switch then.

## 2026-11-19 — From the vendor-app comparison
- The volume screen may be labelled like the vendor app ("max gain"), but it is the same attr 1 (0–30).
- No "Multimedia" screen: local-file playback is just the phone's own BT audio, which any music player does better; white noise and USB drive are out of scope.
- EQ: when S7 is confirmed, presets get the vendor names (Normal, Rock, Pop, Classical, Jazz, Country). Custom range goes from ±6 to ±8 dB only after ±8 reads back unchanged on the amp (S6).
- Settings the vendor app can change but the protocol doesn't show (BT name, pairing code, prompt volume, shake to skip, sleep timer) stay out of the app until their commands are known (A1).

## 2026-11-19 — Spec §12 (device settings)
- PROTOCOL.md is one file again: "PROTOCOL updated.md" (adds §12, fixes the type-3 row) replaced it. I changed one claim: the EQ name order is [D], not hardware-tested yet.
- Wuzhi settings live in src/protocol/wuzhi.ts. The guard lets the four read queries through, caps beep volume like the main volume (it uses the same 0–30 scale), and asks before power-off, pairing code, rename, TWS and opcode 0x06.
- The logger never prints the pairing code in decoded lines.

## 2026-11-19 — From the settings test
- EQ presets are shown by name (Normal, Rock, Pop, Classical, Jazz, Country, User). Custom gains: −8…+8 dB.
- Volume is called **Gain**, like the vendor app, on a 0–40 slider. It still never sends more than min(cap, amp max 30); the amp ignores 31–40 anyway. Releasing the slider asks once, then steps by 1 every 120 ms (no jumps).
- "Drop phone audio" (opcode 0x06) is a real feature: it gives the user's "switch to AUX and disconnect the phone" in one action when a cable is in.
- Logger has a power-off button for the untested `AA 01 04 55` (A5).

## 2026-11-19 — User feedback on the logger (replaces earlier volume rules)
- Gain slider 0–40. The only limit is the user's cap; the amp's reported max (30) is no longer a limit, because other models may go higher (the ZK-502MT just ignores 31–40). Steps of 1 every 120 ms remain.
- No confirmation dialogs: the guard still blocks OTA, writes above the cap and malformed frames, but asks nothing.
- EQ presets are shown by name everywhere (Normal, Rock, Pop, Classical, Jazz, Country, User).
- Rename (`AA len 05 name 55`) is in the logger. Device filter and name prefixes are remembered; defaults include "wuzhi" and "Wuzhi" (Web Bluetooth name prefixes are case-sensitive).
- Not building: pairing code (A2), power-off (A5).

## 2026-11-19 — EQ lock after power-on (E1)
- The app treats an EQ write answered with a different mode as "refused" and tells the user to play something over Bluetooth once. It does not retry in a loop.
- Profiles (§10) can't rely on EQ being applied on connect: re-apply the EQ when the amp reports A2DP connected, and again after a refusal once BT audio has played.
- The pairing-code setting can go in the app later: it is the classic-BT PIN (A2). Low priority.

## 2026-11-19 — Reboot and rename
- The guard still blocks the OTA range 0xE1–0xE8, except `0xE7 00` (reboot). Logger has a Reboot button next to Power off.
- App rename flow: say the amp will restart, send the frame, expect the BLE link to drop, reconnect, then tell the user to unpair the old name and pair the new one.
- EQ: re-send it once the amp is playing Bluetooth audio after power-on (E1); a refused write is not stored, so a re-send is required.

## 2026-11-20 — First app version (index.html, src/app/)
- Screens: connect, then one page with Source (BT/AUX; AUX disabled without a cable; optional "disconnect the phone"), Gain (0–limit, stepped), Equalizer (presets by name + 10 bands ±8 dB = User), Profiles. Settings sheet: gain limit (default 40), beep, rename, disconnect phone, restart, logger link. No light, bass/treble, DSP or Multimedia screens.
- State comes only from what the amp reports (src/app/state.ts, tested with captured frames). Live sync from the 0x09 and 0x21 pushes.
- EQ refusal (E1): the app detects it from the amp's answer, shows a banner with "Try again", and retries once on each source change.
- Profiles stay in this browser. Auto-apply on connect is off until the user picks a profile.
- The device chooser filters by name prefix; "Show all devices" covers renamed amps.
- PWA: manifest, SVG icon, network-first service worker (production build only).

## 2026-11-20 — App feedback round 1
- Profiles and controls skip changes that are already in effect (same source, same EQ, same gain). Re-selecting AUX while on AUX pauses playback, so it is never sent.
- Bluetooth audio status (connected / not) is shown in the Source card, from target info polled every 5 s. "Disconnect" there gives feedback and is hidden when nothing is connected.
- Settings has a plain-language activity log (in memory, newest first).
- Reconnect without the chooser via `navigator.bluetooth.getDevices()` where Chrome supports it: the app tries on load; the logger has "Reconnect last amp". Both pages store the last device id.
- Reboot removed from the app (no effect). Pairing code set is in the logger only.

## 2026-11-20 — AUX priority, EQ on AUX
- AUX priority (off by default): while the app is connected, it switches back to AUX when the amp moves to Bluetooth or idle, when a cable is plugged in, and on connect (only with a cable in). Picking Bluetooth in the app pauses it until AUX is picked again. At most one switch per 3 s. With "disconnect the phone" on, the phone's audio is dropped too.
- The EQ card says "only affects Bluetooth audio" while on AUX.
- Pairing code and rename both restart the amp; the app must treat the link drop as expected.

## 2026-11-20 — Fixes from the AUX priority test
- "Disconnect the phone" = only opcode 0x06, sent while the amp is on Bluetooth; the amp then moves to AUX itself. From AUX/idle the Disconnect button switches to Bluetooth first. If the amp doesn't reach AUX within 2.5 s, the app switches directly.
- AUX priority follows each attempt with a re-check after 2.5 s (a connecting phone pulls the amp back a moment later). Max one try per 2 s and 6 per minute. Shared rule: `priorityAction` in src/app/state.ts, also used by the logger.
- Nothing is sent on connect unless a profile is set to auto-apply.
- Logger: AUX priority checkboxes, "Go to app" link; the alternative source commands stay, labelled as such.

## 2026-11-20 — AUX priority = switch only (user correction)
- AUX priority only switches the source back to AUX (`0E FF 03`); the phone stays connected. "Disconnect the phone when switching to AUX" applies only to the user's own switch, never to priority.
- While "Disconnect" runs (it passes through Bluetooth on purpose), priority waits; afterwards it re-checks.
- EQ card title "Equalizer (Bluetooth)"; user EQ range ±12 dB.
- Logger: reads for EQ (`AA 01 1B 55`, dB + 12) and volume (`AA 01 19 55`) from §12.4.

## 2026-11-21 — Analysis-session update (identity, privacy, restart)
- Logger "Device identity" section (src/identity/, no project dependencies): every GetTargetInfo TLV and the model query, copyable as one report. Read-only.
- Privacy by default: the copy-report and the logger's Copy/Download replace the Bluetooth address, the serial-like part of the ID string and pairing-code digits with `xx`, unless a box is ticked. Captured logs stay out of git (`rcsp-log-*.txt`).
- SDK type is shown as "a hint, not a confirmed chip". The chip family is not stated as fact anywhere.
- No OTA and no links to vendor firmware files (removed from DEVICE_ID_AND_FIRMWARE.md).
- After a rename, the app shows "Amp restarting…", reconnects by itself for up to 45 s, then reminds the user to re-pair under the new name.
- Already covered before this update: device volume from attr 1 (with the user's limit), no Music tile, custom frames only in 0xFF, no DSP screen, both source commands tested across power cycles.

## 2026-11-21 — Chip and SDK extras
- Chip: likely a Jieli AC6925A (from the board marking). Mentioned as "likely" in the docs and in the README as a compatibility check; not shown in the app.
- DEVICE_ID_AND_FIRMWARE.md and PROTOCOL.md merged with the analysis session's second versions; the vendor firmware links stay out.
- Logger section "SDK probes": the read-only commands from SDK_EXTRAS.md §2, one button each plus "Run all" with a summary.
- Not adopted from SDK_EXTRAS §1: switching to AUX automatically on every connect. The user asked that connecting changes nothing unless a profile says so; AUX priority (opt-in) covers the rest.
