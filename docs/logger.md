# Protocol logger

`logger.html` (in the hosted app: `…/logger.html`, or the link at the bottom of the app's settings) is a test bench. It connects to the amp, shows every byte that goes in or out, and has buttons for each known command. It is how every fact in [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) was established.

Use it when:

- you have a model other than the ZK-502MT and want to see what it supports,
- something in the app doesn't work and you want to report it,
- you want to try a command from [PROTOCOL.md](PROTOCOL.md) that the app doesn't use.

## Reading the log

Each line has a time (ms since connecting), a kind and the content.

| Kind | Meaning |
|---|---|
| `TX` | Bytes sent to the amp. The note says what kind of frame it is and whether it was split into 20-byte writes |
| `RX` | Bytes received, as they arrived |
| `DEC` | A reply matched to a command, decoded, with the round-trip time |
| `PUSH` | A message the amp sent on its own (source changed, EQ changed, AUX cable, setting replies) |
| `INFO` | Connection steps |
| `ERR` | Something failed: timeout, blocked by the guard, browser error |
| `NOTE` | Your notes, and what a button was meant to do |

Add notes while testing ("turning the knob now", "phone connected"). They make a log much easier to read later.

## Sections

**Connection.** Device filter, write size and type, auth options. The defaults work for the ZK-502MT. If your amp has a name that doesn't start with one of the prefixes, choose "All devices". "Reconnect last amp" skips the chooser if the browser allows it (Chrome may need `chrome://flags/#enable-web-bluetooth-new-permissions-backend`).

- *Auth steps 4–5*: answer the amp's own challenge. Required by the ZK-502MT.
- *After auth, send GetTargetInfo and GetSysInfo*: read-only startup queries.
- *Acknowledge device pushes*: some pushes ask for a reply. The amp repeats them if not acked.
- *AUX priority*: the same rule the app uses. When the amp moves to Bluetooth (or goes idle) with an AUX cable in, switch back to AUX. The phone stays connected. Note that the logger's own "Bluetooth" buttons will trigger it too.

**Read-only queries.** Device info, settings, DSP info. Safe to press at any time.

**Write tests.** Source switching, gain slider, EQ preset. Each one re-reads the settings afterwards so you can see the result.

**Device settings.** Wuzhi-specific frames (PROTOCOL.md §12):

- reads: model/product code, beep, pairing code on/off, LED level, EQ (`1B`), volume (`19`)
- writes: beep, pairing code, Bluetooth name, alternative source commands (`AA 02 08 n 55`)
- *Disconnect phone audio* (opcode `06`): drops the classic Bluetooth link. Only works while the amp is on Bluetooth.
- *Reboot* (`E7 00`) and *Power off* (`AA 01 04 55`): see the notes next to them. On the ZK-502MT, reboot does nothing and power off leaves the amp half-asleep until it is power-cycled.

Renaming and changing the pairing code restart the amp. The connection drops a few seconds later; that is expected.

**Send a frame.** Build any frame from an opcode and payload, or paste a full raw frame. The preview shows the exact bytes and what the guard thinks of them.

**Timing.** Delays for behaviour that depends on how fast the amp and the phone react: AUX priority (wait before switching, minimum gap, re-check, max per minute), how long to wait for AUX after disconnecting the phone, gain step delay, and how often the app re-reads "phone connected". Saved in the browser and used by the app as well. Values are clamped to safe limits.

**Volume cap.** The highest gain any command may set. The guard blocks anything above it, including beep volume.

## The guard

Every byte goes through a check before it is sent ([src/protocol/safety.ts](../src/protocol/safety.ts)):

- blocked: firmware-update opcodes (`E1`–`E8`, except the plain reboot `E7 00`), gain or beep volume above the cap, malformed frames, raw bytes that aren't complete frames
- allowed: everything else. The preview line shows which settings a frame would change.

## Sharing a log

"Download .txt" saves the log. Before sharing it publicly, note that it contains your amp's Bluetooth address and ID string (in the GetTargetInfo reply) and, if you read it, the pairing code (in the raw RX line). Replace those bytes with `xx` if you care.

When reporting a problem, include what you did, what you expected and what happened, ideally as notes in the log itself.
