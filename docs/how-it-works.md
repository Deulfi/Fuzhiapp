# How it works

The protocol itself is documented on `main`: [PROTOCOL.md](https://github.com/Deulfi/Fuzhiapp/blob/main/docs/PROTOCOL.md), [DEVICE_ID_AND_FIRMWARE.md](https://github.com/Deulfi/Fuzhiapp/blob/main/docs/DEVICE_ID_AND_FIRMWARE.md), [OPEN_QUESTIONS.md](https://github.com/Deulfi/Fuzhiapp/blob/main/docs/OPEN_QUESTIONS.md) and [DECISIONS.md](https://github.com/Deulfi/Fuzhiapp/blob/main/docs/DECISIONS.md). This page explains what the bridge does with it.

## Overview

```
Home Assistant / web page
        |  Wi-Fi (ESPHome native API, encrypted)
   ESP32-C3 running ESPHome
        |  BLE: service AE00, write AE01, notify AE02
   Wuzhi ZK-502MT (Jieli chip, RCSP protocol)
```

The amp speaks Jieli's RCSP protocol over BLE. Frames look like `FE DC BA flags opcode lenHi lenLo params EF`; Wuzhi's own commands (beep, model, source push) travel inside opcode `0xFF` as `AA len cmd data 55`.

The component has two layers:

- `wuzhi_protocol.*`: plain C++ without ESPHome: authentication (Bluetooth E1 / SAFER+), frame encoding, a reassembler for frames split over notifications, parsers for GetTargetInfo and GetSysInfo, and the payload builders with their limits. It is a port of the PWA's `src/protocol/` and is tested on a PC (`tests/`).
- `wuzhi_amp.*` and the `*.py` platforms: the ESPHome side. It drives `ble_client`, runs the connection sequence, matches replies to requests, and maps the amp's state to entities.

## Connection sequence

1. **Find.** With no address configured, the first advertisement whose name starts with `name_prefix` is adopted and stored. The amp only advertises while no one holds its control connection.
2. **Connect** and discover services. AE01 accepts only write-without-response; writes are chunked to 20 bytes like the PWA.
3. **Pair** (only with `pair: true`).
4. **Enable notifications** on AE02.
5. **Wait** `auth_delay` (1 s).
6. **Authenticate**, five raw (unframed) messages:
   host challenge, amp's E1 answer (checked), host "pass", amp challenge, host's E1 answer, amp "pass".
7. **Read** what the configured entities need, all read-only: GetTargetInfo, GetSysInfo, the beep query, the model query.
8. **Follow** the amp's pushes: `0x09` (SysInfo changed: gain, EQ, AUX cable, source) and Wuzhi `0x21` (source changed). Pushes that ask for a reply get the same bare acknowledgement the PWA sends.

## What is sent, and when

The bridge never sends a setting on its own. In detail:

| When | What | Read/write |
|---|---|---|
| connect | auth, GetTargetInfo | read |
| connect, if gain/source/EQ/AUX cable/AUX priority configured | GetSysInfo | read |
| connect, if beep configured | beep query | read |
| connect, if firmware sensor configured | model query | read |
| every 30 s, and after a source change, if Bluetooth audio sensor configured | GetTargetInfo | read |
| you change gain | SetSysInfo attr 1, one step at a time | write |
| you change source | Function command (BT `FF 00`, AUX `FF 03`) | write |
| you change EQ or a band | SetSysInfo attr 4 | write |
| the amp refused your EQ and Bluetooth audio started | the same EQ once more | write |
| you change beep | Wuzhi `0x02` | write |
| you press Disconnect phone audio | (Function BT,) opcode `0x06` | write |
| AUX priority on and the amp left AUX with a cable in | Function AUX | write |

## Safety rules

From the project's rules (DECISIONS.md on `main`):

- **Gain cap.** No gain above `max_gain` (default 40) is ever built: the protocol layer returns an empty payload for anything above the cap, and empty payloads are never sent. Beep volume has the same cap.
- **Gradual gain.** Steps of 1, 120 ms apart, each waiting for the amp's reply. Never a jump upward.
- **Nothing on connect.** Only reads on connect. No stored gain, source or EQ is written at boot or when Home Assistant reconnects.
- **No firmware features.** No OTA or update commands for the amp exist in the code.

## Being gentle with the amp

During development, repeated auth challenges and quick reconnects left the amp's control channel stuck: no device (phone, PC, ESP32) could authenticate until the amp was switched off and on. The amp also ignores a second challenge on the same connection. So:

- One auth attempt per connection.
- After a failed attempt (auth, pairing), the bridge disconnects and waits 30 s before reconnecting, doubling up to 10 minutes. A successful auth resets the wait.
- AUX priority is rate-limited (2 s apart, 6 per minute).

## The amp's quirks

- One control connection at a time.
- EQ is locked to Normal after power-on until Bluetooth audio has played once. EQ and source are not saved across power cycles; there is no command to save them.
- Switching to Bluetooth while on Bluetooth drops the phone's audio.
- The AUX switch is ignored without a cable.
- The source push comes 2-4 times per change.
- The "power-up info" flags byte in GetTargetInfo changes between connections (seen 0x00, 0x20, 0x6b, 0x75), so it says nothing fixed about the amp.
- BLE pairing is not needed. (An early test suggested otherwise; the amp was stuck at the time.)

## ESPHome detail

`ble_client` (ESPHome 2026.10) frees its copy of the amp's GATT table once all its nodes report "established" and no counted notify registration is pending. Enabling notifications needs that table. The component therefore registers through `BLEClient::register_for_notify()` and reports "established" only after notifications are on. Without this, notifications silently never get enabled and the amp's replies are lost.
