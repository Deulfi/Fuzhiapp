/**
 * Minimal RCSP frame encoding (docs/PROTOCOL.md §3, [D]).
 *   FE DC BA | flags | opcode | paramLen (BE16) | params | EF
 * Host command params = sn + payload.
 * The full decoder/reassembler comes in the framing layer; this file only builds frames
 * and does a structural split, which the logger and the safety guard need.
 */

export const SOF = Uint8Array.from([0xfe, 0xdc, 0xba]);
export const EOF = 0xef;
/** Bytes before params: FE DC BA flags opcode lenHi lenLo */
export const HEADER_LEN = 7;

export const FLAG_COMMAND = 0x80;
export const FLAG_EXPECT_RESPONSE = 0x40;

export const Op = {
  Data: 0x01,
  GetTargetInfo: 0x03,
  /** SDK DisconnectClassicBluetooth, no params (§12.3); untested on this amp [I] */
  DisconnectClassic: 0x06,
  GetSysInfo: 0x07,
  SetSysInfo: 0x08,
  /** amp → host: SysInfo changed, same payload layout as a GetSysInfo reply [obs, not in spec] */
  SysInfoPush: 0x09,
  Function: 0x0e,
  /** SDK RebootDeviceCmd, one param byte 0 (§12 follow-up) [D]. Inside the OTA range, allowed only with payload `00`. */
  Reboot: 0xe7,
  NotifyAppInfo: 0xd0,
  SettingsMtu: 0xd1,
  Custom: 0xff,
} as const;

export function encodeCommand(opcode: number, sn: number, payload: Uint8Array = new Uint8Array(), expectResponse = true): Uint8Array {
  const flags = FLAG_COMMAND | (expectResponse ? FLAG_EXPECT_RESPONSE : 0);
  return encodeRaw(flags, opcode, concat(Uint8Array.of(sn & 0xff), payload));
}

/** Build a frame from flags, opcode and the full params field. */
export function encodeRaw(flags: number, opcode: number, params: Uint8Array): Uint8Array {
  if (params.length > 0xffff) throw new RangeError('params too long');
  const out = new Uint8Array(HEADER_LEN + params.length + 1);
  out.set(SOF, 0);
  out[3] = flags & 0xff;
  out[4] = opcode & 0xff;
  out[5] = params.length >> 8;
  out[6] = params.length & 0xff;
  out.set(params, HEADER_LEN);
  out[out.length - 1] = EOF;
  return out;
}

export interface RawFrame {
  flags: number;
  opcode: number;
  params: Uint8Array;
}

/**
 * Split bytes that must consist *only* of complete frames. Returns null if anything is
 * left over or malformed. Used to validate outgoing bytes, not for receiving.
 */
export function splitExactFrames(bytes: Uint8Array): RawFrame[] | null {
  const frames: RawFrame[] = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes.length - i < HEADER_LEN + 1) return null;
    if (bytes[i] !== 0xfe || bytes[i + 1] !== 0xdc || bytes[i + 2] !== 0xba) return null;
    const len = ((bytes[i + 5] as number) << 8) | (bytes[i + 6] as number);
    const end = i + HEADER_LEN + len;
    if (end >= bytes.length || bytes[end] !== EOF) return null;
    frames.push({ flags: bytes[i + 3] as number, opcode: bytes[i + 4] as number, params: bytes.slice(i + HEADER_LEN, end) });
    i = end + 1;
  }
  return frames.length ? frames : null;
}

/** SysInfo TLV `[len = 1 + n][type][data(n)]`. */
export function tlv(type: number, data: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(data.length + 1, type), data);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Wuzhi DSP frame `AA len cmd data… 55` (docs/PROTOCOL.md §7). */
export function dspFrame(cmd: number, data: Uint8Array = new Uint8Array()): Uint8Array {
  return concat(Uint8Array.of(0xaa, data.length + 1, cmd), data, Uint8Array.of(0x55));
}

/** Read-only commands used by the logger. */
export const Payload = {
  /** GetTargetInfo: mask FFFFFFFF, platform 00 */
  targetInfoAll: () => Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0x00),
  /** GetSysInfo public, mask 0x0000FFF7 (the app's startup query) */
  sysInfoPublicAll: () => Uint8Array.of(0xff, 0x00, 0x00, 0xff, 0xf7),
  /** Wuzhi DSP read-info */
  dspReadInfo: () => dspFrame(0x1f),
};
