# Documentation

For people who want to understand, extend or fork the project. If you just want to use the app, the [main README](../README.md) is enough.

| File | What it covers |
|---|---|
| [development.md](development.md) | Code layout, building, testing, deploying, safety rules, how to add support for another model |
| [logger.md](logger.md) | The protocol logger page: what each section does and how to capture a useful log |
| [PROTOCOL.md](PROTOCOL.md) | The Bluetooth protocol: GATT layout, frame format, authentication, commands, Wuzhi-specific frames |
| [DEVICE_ID_AND_FIRMWARE.md](DEVICE_ID_AND_FIRMWARE.md) | What identifies the amp (SDK type, target-info fields, model query) and what is known about firmware files |
| [SDK_EXTRAS.md](SDK_EXTRAS.md) | Jieli SDK commands the vendor app never uses: read-only probes, reverb and limiter, untested writes |
| [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) | Every protocol claim we tested on a real ZK-502MT, with the result. Corrections to PROTOCOL.md live here |
| [DECISIONS.md](DECISIONS.md) | Why the app behaves the way it does, in the order the decisions were made |
| [reference/](reference/) | Small Python reference implementations of the auth function and the frame builder |

## How the protocol knowledge was gathered

PROTOCOL.md was written from a static analysis of the official Android app. It describes interoperability facts only: UUIDs, byte layouts, opcodes, and behaviour. Each claim is tagged:

- **[V]** verified by running the vendor's routine and matching its output
- **[D]** read from the decompiled app, not yet tested on hardware
- **[I]** inferred

The app in this repository was written only from that document and from tests on a real amp, using the logger. No vendor code, images or other assets are included. Anything marked [D] or [I] was confirmed on the amp before the app relied on it; OPEN_QUESTIONS.md records each test.
