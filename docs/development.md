# Development

## Layout

| Path | Content |
|---|---|
| `components/wuzhi_amp/wuzhi_protocol.h/.cpp` | Protocol core in plain C++17: auth, frames, reassembly, parsers, payload builders with limits. No ESPHome includes. |
| `components/wuzhi_amp/wuzhi_amp.h/.cpp` | The ESPHome component: `ble_client` node, BLE scan listener, connection state machine, entities. |
| `components/wuzhi_amp/__init__.py` | Component schema and code generation. |
| `components/wuzhi_amp/{number,select,switch,button,binary_sensor,text_sensor}.py` | Entity platforms. |
| `tests/test_protocol.cpp` | Host tests for the protocol core. |
| `firmware/` | Configs of the public firmware files. |
| `wuzhi-amp.yaml` | Example config using the local component. |

The protocol core is a port of the PWA's `src/protocol/` on `main`. Behaviour should match the PWA; where the PWA has a rule (gain stepping, AUX priority timing, EQ retry), the bridge uses the same numbers and says where they come from.

## Rules

- Clean-room: implement only from the docs on `main` and tests on your own amp. No vendor code or assets.
- Never build a gain or beep value above the cap; keep that check in the protocol core.
- Send nothing on connect except reads that a configured entity needs.
- Don't guess protocol details. Unknown behaviour goes into `OPEN_QUESTIONS.md` on `main` and gets tested first.
- No OTA or firmware features for the amp.
- The amp's Bluetooth address and ID string are not logged unless `log_private` is on.

## Host tests

Any C++17 compiler:

```sh
cd tests
```

```sh
g++ -std=c++17 -Wall -Wextra -I../components/wuzhi_amp test_protocol.cpp ../components/wuzhi_amp/wuzhi_protocol.cpp -o test_protocol
```

```sh
./test_protocol
```

They check the E1 vectors and frame examples from `PROTOCOL.md`, frame reassembly, the parsers and redaction, the handshake against a simulated amp, and the caps on gain, beep and EQ.

## Building

- Own build with the local component: `esphome run wuzhi-amp.yaml` (see [install-command-line.md](install-command-line.md)).
- Public firmware locally: `esphome compile firmware/wuzhi-amp-lean.yaml`. Note that it fetches the component from GitHub (`ref: esphome-bridge`), not from your folder.

## CI and releases

`.github/workflows/esphome-firmware.yml` runs on every push to `esphome-bridge`: it builds both public variants with `esphome/build-action` and keeps the `.bin` files as run artifacts.

A release:

1. Set `version` under `esphome: project:` in both `firmware/*.yaml`.
2. Commit and push.
3. Tag and push the tag:

   ```sh
   git tag esphome-v0.1.0
   ```

   ```sh
   git push origin esphome-v0.1.0
   ```

The workflow then publishes `wuzhi-amp-{lean,web}-{factory,ota}.bin` as a GitHub release. `main`'s README links to the latest release.

## Branches

`esphome-bridge` holds only the bridge; `main` holds the PWA and the protocol docs. The two are never merged into each other (the bridge branch deleted the PWA files). Protocol findings from bridge testing go into the docs on `main`.
