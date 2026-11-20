/**
 * Wuzhi device-settings commands (docs/PROTOCOL.md §12.2, all [D] until tested on the amp).
 * They travel inside opcode 0xFF as `AA len cmd data… 55`, the same frame as the DSP
 * commands (§7). Replies come back as pushed 0xFF commands in the same format.
 */
import { dspFrame } from './frame';

export const WuzhiCmd = {
  ModelQuery: 0x01,
  BeepSet: 0x02,
  PairingSet: 0x03,
  /** sent by the vendor app when its sleep timer ends; probably power-off/standby [I] */
  SleepOrOff: 0x04,
  BtName: 0x05,
  LedSet: 0x0a,
  /** probably TWS pairing [I] */
  Tws: 0x0b,
  BeepRead: 0x12,
  PairingRead: 0x13,
  LedRead: 0x1a,
  /** `AA 01 1B 55` → `AA len 1B mode g0..g9 55`, gains are dB + 12 [D §12.4] */
  EqRead: 0x1b,
  /** `AA 01 19 55` → `AA 02 19 v 55` product volume [D §12.4] */
  VolumeRead: 0x19,
  DspReadInfo: 0x1f,
  /** `AA 02 08 n 55`: source select used by the vendor app, n = 1 BT, 2 USB, 3 AUX, 4 sound card [D §12.4] */
  SourceSelect: 0x08,
  /** amp → host: source changed, data 01 = BT, 03 = AUX [obs] */
  SourcePush: 0x21,
} as const;

/** Read queries: `AA 01 cmd 55`, no data. */
export const WUZHI_READS = [
  WuzhiCmd.ModelQuery,
  WuzhiCmd.BeepRead,
  WuzhiCmd.PairingRead,
  WuzhiCmd.LedRead,
  WuzhiCmd.EqRead,
  WuzhiCmd.VolumeRead,
  WuzhiCmd.DspReadInfo,
] as const;

export const wuzhiRead = (cmd: number) => dspFrame(cmd);

/** `AA 03 02 en vol 55`. Beep volume range 0–30 [D]. */
export function beepSet(enabled: boolean, volume: number): Uint8Array {
  if (!Number.isInteger(volume) || volume < 0 || volume > 30) throw new RangeError('beep volume must be 0–30');
  return dspFrame(WuzhiCmd.BeepSet, Uint8Array.of(enabled ? 1 : 0, volume));
}

/** Split `AA len cmd data… 55`; null if the bytes aren't one such frame. */
export function splitWuzhi(p: Uint8Array, strict = true): { cmd: number; data: Uint8Array } | null {
  if (p.length < 4 || p[0] !== 0xaa || p[p.length - 1] !== 0x55) return null;
  // The amp's model reply has len one higher than its size (obs: 0x12 for 17 bytes), so received
  // frames are read leniently; the enclosing RCSP frame already marks where they end.
  if (strict && p[1] !== p.length - 3) return null;
  return { cmd: p[2]!, data: p.subarray(3, p.length - 1) };
}

/** `AA 06 03 en d1 d2 d3 d4 55`: pairing PIN on/off + 4 ASCII digits [D, §12.2; A2 tested via read]. */
export function pairingSet(enabled: boolean, code: string): Uint8Array {
  if (!/^\d{4}$/.test(code)) throw new RangeError('pairing code must be exactly 4 digits');
  return dspFrame(WuzhiCmd.PairingSet, Uint8Array.of(enabled ? 1 : 0, ...Array.from(code, (c) => c.charCodeAt(0))));
}

/** Vendor-app source select (§12.4): 1 Bluetooth, 3 AUX. */
export const sourceSelect = (n: 1 | 3) => dspFrame(WuzhiCmd.SourceSelect, Uint8Array.of(n));

const SOURCE_STATE: Record<number, string> = { 1: 'Bluetooth', 3: 'AUX', 5: 'idle (no source)' };

/** `AA (n+1) 05 name 55`, name 1–20 printable ASCII bytes [D, §12.2]. */
export function btNameFrame(name: string): Uint8Array {
  if (!/^[ -~]{1,20}$/.test(name)) throw new RangeError('name must be 1–20 plain ASCII characters');
  return dspFrame(WuzhiCmd.BtName, Uint8Array.from(name, (c) => c.charCodeAt(0)));
}

const ascii = (d: Uint8Array) => String.fromCharCode(...d).replace(/[^\x20-\x7e]/g, '.');

export interface ModelReply {
  /** 3 ASCII digits, e.g. "002" on the ZK-502MT. The vendor app picks its control set from it (§12.4). */
  productCode: string;
  field2: string;
  field3: string;
  /** 6 bytes read as digits (obs: 01 08 00 04 01 08 → "180418"); hex if they aren't digits */
  check: string;
  /** [D] the vendor app compares the 6 bytes as a number with 180418; ≥ is assumed [I] */
  checkPasses: boolean;
}

/** Model query reply data (after `AA len 01`). Null if too short. */
export function parseModelReply(d: Uint8Array): ModelReply | null {
  if (d.length < 16) return null;
  const tail = d.subarray(10, 16);
  const digits = tail.every((b) => b <= 9);
  const check = digits ? Array.from(tail, String).join('') : Array.from(tail, (b) => b.toString(16).padStart(2, '0')).join(' ');
  return {
    productCode: ascii(d.subarray(0, 3)),
    field2: ascii(d.subarray(3, 6)),
    field3: ascii(d.subarray(6, 10)),
    check,
    checkPasses: digits && Number(check) >= 180418,
  };
}

/** Human description of a Wuzhi frame for the logger. */
export function describeWuzhi(p: Uint8Array): string | null {
  const w = splitWuzhi(p, false);
  if (!w) return null;
  const { cmd, data: d } = w;
  const hex = Array.from(d, (b) => b.toString(16).padStart(2, '0')).join(' ');
  if (d.length === 0) return `Wuzhi cmd 0x${cmd.toString(16).padStart(2, '0')} (no data)`;
  switch (cmd) {
    case WuzhiCmd.BeepRead:
    case WuzhiCmd.BeepSet:
      if (d.length === 2) return `beep ${d[0] ? 'on' : 'off'}, volume ${d[1]}`;
      // obs: after every beep write the amp pushes `AA 02 02 80 55`
      if (cmd === WuzhiCmd.BeepSet && d.length === 1 && d[0] === 0x80) return 'beep setting acknowledged (0x80)';
      break;
    case WuzhiCmd.SourcePush:
      // obs: 01 BT, 03 AUX, 05 idle (no source: after "drop phone audio" with no cable, and after power-off)
      if (d.length === 1) return `source changed → ${SOURCE_STATE[d[0]!] ?? `0x${d[0]!.toString(16)}`}`;
      break;
    case WuzhiCmd.PairingRead:
    case WuzhiCmd.PairingSet:
      // The code itself is not printed: logs get shared.
      if (d.length === 5) return `pairing code ${d[0] ? 'on' : 'off'} (code hidden)`;
      break;
    case WuzhiCmd.LedRead:
    case WuzhiCmd.LedSet:
      if (d.length === 1) return `indicator LED level ${d[0]}`;
      break;
    case WuzhiCmd.ModelQuery:
      // §12.2: 3 ASCII model code + 3 ASCII + 4 ASCII + 6 bytes
      if (d.length >= 16) {
        const m = parseModelReply(d)!;
        return `product code ${m.productCode} (model WZ${m.productCode}), then "${m.field2}", "${m.field3}", check ${m.check} (${m.checkPasses ? 'passes' : 'fails'} the vendor app's ≥ 180418 test [D])`;
      }
      return `model info "${ascii(d.subarray(0, 3))}" + ${d.length - 3} more bytes`;
    case WuzhiCmd.BtName:
      return `BT name "${ascii(d)}"`;
    case WuzhiCmd.EqRead:
      if (d.length >= 11) return `EQ mode ${d[0]} gains [${Array.from(d.subarray(1, 11), (g) => g - 12).join(' ')}] dB (sent as dB + 12)`;
      break;
    case WuzhiCmd.VolumeRead:
      if (d.length === 1) return `volume ${d[0]}`;
      break;
  }
  return `Wuzhi cmd 0x${cmd.toString(16).padStart(2, '0')} data [${hex}]`;
}
