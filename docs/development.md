# Development

## Requirements

Node.js 20 or newer. A browser with Web Bluetooth (Chrome or Edge) and an amp for anything beyond the unit tests.

```
npm install
npm run dev        # http://localhost:5173 (app) and /logger.html
npm test           # unit tests (Vitest)
npm run build      # type check + production build into dist/
```

Web Bluetooth only works on `https://` pages or `localhost`. To try the dev server on a phone, use the hosted build or forward the port with Chrome's remote debugging (`chrome://inspect` → Port forwarding).

## Layout

```
index.html, src/app/      the app
  main.ts                 UI: rendering and event wiring, no protocol logic
  amp.ts                  controller: connect, auth, live state, every command the app sends
  state.ts                pure functions: amp replies and pushes → app state, AUX priority rule
  profiles.ts             profiles and settings in localStorage
  timing.ts               tunable delays, shared with the logger
logger.html, src/logger/  the protocol logger
src/protocol/             protocol code, no DOM
  auth.ts                 E1 / SAFER+ authentication
  handshake.ts            the 5-step auth exchange
  frame.ts                frame encoding, opcodes
  codec.ts                frame decoding and reassembly from 20-byte notifications
  client.ts               request/response matching by opcode and sequence number, timeouts, acks
  info.ts                 GetTargetInfo / GetSysInfo parsers
  wuzhi.ts                Wuzhi `AA len cmd data 55` frames
  safety.ts               the outgoing guard
src/ble/transport.ts      Web Bluetooth: GATT, chunked writes, remembered device
public/                   PWA manifest, icon, service worker
test/                     unit tests; most use frames captured from a real ZK-502MT
docs/                     this folder
```

The layers only depend downwards: `app` → `protocol` and `ble`; `protocol` has no browser dependencies, so it runs in Node tests.

## Rules

**Clean-room.** Write code only from [PROTOCOL.md](PROTOCOL.md) and from what a real amp does. Do not add decompiled vendor code, vendor images, strings copied from the vendor app, or firmware files.

**Verify before relying.** A claim tagged [D] or [I] in PROTOCOL.md is a hypothesis until it has been tested on hardware. Test it with the logger, record the result in [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md), and only then let the app depend on it.

**Volume safety.** Every write goes through `checkOutgoing` in `safety.ts`. Gain and beep volume above the user's limit are blocked there, not only in the UI. Gain changes are stepped one unit at a time. Firmware-update opcodes are blocked.

**State comes from the amp.** The app shows what the amp reports (replies and pushes), not what it last sent. When adding a feature, add the parser to `state.ts` with a test built from a captured frame.

**Don't send what doesn't change anything.** Re-selecting the current source pauses playback, so `amp.ts` skips commands whose result is already in effect.

## Adding another model

1. Connect with the logger, press "Read model (product code)", and save the log.
2. Go through the read-only queries and the write tests one by one, with notes.
3. Add the findings to OPEN_QUESTIONS.md (redact the Bluetooth address and ID string).
4. If the model needs different screens, key them on the product code from the model query. The ZK-502MT reports `002`.

## Deployment

`.github/workflows/pages.yml` runs the tests, builds, and publishes `dist/` to GitHub Pages on every push to `main` (or `master`). In the repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions** once.

Vite is configured with `base: './'`, so the build works under any path (`https://<user>.github.io/<repo>/`).
