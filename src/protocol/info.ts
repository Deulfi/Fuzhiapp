/**
 * Parsers for GetTargetInfo (0x03) and GetSysInfo (0x07) payloads.
 * Each field notes where its meaning comes from: spec tag, or "obs" = observed on a ZK-502MT
 * (see docs/OPEN_QUESTIONS.md). Unknown TLVs are kept raw.
 */

export interface Tlv {
  type: number;
  data: Uint8Array;
}

/** `[len = 1 + n][type][data(n)]` repeated. Throws on a truncated or zero-length entry. */
export function parseTlvs(b: Uint8Array): Tlv[] {
  const out: Tlv[] = [];
  let i = 0;
  while (i < b.length) {
    const len = b[i]!;
    if (len < 1 || i + 1 + len > b.length) throw new RangeError(`bad TLV at offset ${i}`);
    out.push({ type: b[i + 1]!, data: b.slice(i + 2, i + 1 + len) });
    i += 1 + len;
  }
  return out;
}

export const FunctionId = { Bluetooth: 0, Music: 1, Rtc: 2, Aux: 3, Fm: 4, Light: 5, FmTx: 6, Eq: 7, Public: 0xff } as const;
export const FUNCTION_NAMES: Record<number, string> = {
  0: 'Bluetooth',
  1: 'Music (USB/SD)',
  2: 'RTC/alarm',
  3: 'AUX',
  4: 'FM',
  5: 'Light',
  6: 'FM transmit',
  7: 'EQ',
  0x16: 'low-power',
  0xff: 'public',
};
export const functionName = (f: number) => FUNCTION_NAMES[f] ?? `function 0x${f.toString(16)}`;

export interface TargetInfo {
  /** type 0 [D, obs "2.1"] */
  protocolVersion?: string;
  /** type 1 [D]: battery, volume, max volume, flags. Flags meaning unclear on this amp (C3). */
  power?: { battery: number; volume: number; maxVolume: number; flags: number };
  /** type 2 [D]: last byte 1 while A2DP connected (obs) */
  edr?: { profile: number; status: number };
  /** type 4 [obs]: BE32 bitmask of functions (bit n = function n) + current function */
  functionMask?: number;
  currentFunction?: number;
  tlvs: Tlv[];
}

export function parseTargetInfo(payload: Uint8Array): TargetInfo {
  const tlvs = parseTlvs(payload);
  const info: TargetInfo = { tlvs };
  for (const { type, data: d } of tlvs) {
    if (type === 0 && d.length >= 1) info.protocolVersion = `${d[0]! >> 4}.${d[0]! & 0x0f}`;
    if (type === 1 && d.length >= 4) info.power = { battery: d[0]!, volume: d[1]!, maxVolume: d[2]!, flags: d[3]! };
    if (type === 2 && d.length >= 8) info.edr = { profile: d[6]!, status: d[7]! };
    if (type === 4 && d.length >= 4) {
      info.functionMask = ((d[0]! << 24) | (d[1]! << 16) | (d[2]! << 8) | d[3]!) >>> 0;
      if (d.length >= 5) info.currentFunction = d[4]!;
    }
  }
  return info;
}

/** EQ mode names, tested on the ZK-502MT (OPEN_QUESTIONS S7). */
export const EQ_NAMES = ['Normal', 'Rock', 'Pop', 'Classical', 'Jazz', 'Country', 'User'] as const;
export const eqName = (mode: number) => EQ_NAMES[mode] ?? `mode ${mode}`;

const toInt8 = (b: number) => (b > 127 ? b - 256 : b);

export function functionsInMask(mask: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 32; i++) if (mask & (1 << i)) out.push(i);
  return out;
}

export interface PublicSysInfo {
  /** attr 1 [D, obs 0–30] */
  volume?: number;
  /** attr 2 [obs]: byte 0 bit 4 set while an AUX cable is plugged in */
  auxInserted?: boolean;
  /** attr 4 [D, obs]: mode + 10 gains as signed bytes (dB, presets use −6…+8) */
  eq?: { mode: number; gains: number[] };
  /** attr 5 [obs]: ASCII, e.g. "MP1MP2MP3WAV" */
  formats?: string;
  /** attr 6 [D, obs]: current function */
  currentFunction?: number;
  tlvs: Tlv[];
}

export interface SysInfo {
  function: number;
  pub?: PublicSysInfo;
  tlvs: Tlv[];
}

export function parseSysInfo(payload: Uint8Array): SysInfo {
  if (payload.length < 1) throw new RangeError('empty SysInfo');
  const fn = payload[0]!;
  const tlvs = parseTlvs(payload.subarray(1));
  const out: SysInfo = { function: fn, tlvs };
  if (fn === FunctionId.Public) {
    const pub: PublicSysInfo = { tlvs };
    for (const { type, data: d } of tlvs) {
      if (type === 1 && d.length >= 1) pub.volume = d[0]!;
      if (type === 2 && d.length >= 1) pub.auxInserted = (d[0]! & 0x10) !== 0;
      if (type === 4 && d.length >= 11) pub.eq = { mode: d[0]!, gains: Array.from(d.subarray(1, 11), toInt8) };
      if (type === 5) pub.formats = String.fromCharCode(...d);
      if (type === 6 && d.length >= 1) pub.currentFunction = d[0]!;
    }
    out.pub = pub;
  }
  return out;
}

/** One-line human summary for the logger. */
export function describeTargetInfo(t: TargetInfo): string {
  const parts: string[] = [];
  if (t.protocolVersion) parts.push(`proto ${t.protocolVersion}`);
  if (t.power) parts.push(`vol ${t.power.volume}/${t.power.maxVolume}`, `flags 0x${t.power.flags.toString(16)}`);
  if (t.edr) parts.push(`A2DP ${t.edr.status ? 'connected' : 'not connected'}`);
  if (t.functionMask !== undefined) parts.push(`functions [${functionsInMask(t.functionMask).map(functionName).join(', ')}]`);
  if (t.currentFunction !== undefined) parts.push(`current ${functionName(t.currentFunction)}`);
  parts.push(`types [${t.tlvs.map((x) => x.type.toString(16)).join(' ')}]`);
  return parts.join('; ');
}

export function describeSysInfo(s: SysInfo): string {
  if (!s.pub) return `${functionName(s.function)}: types [${s.tlvs.map((x) => x.type.toString(16)).join(' ')}]`;
  const p = s.pub;
  const parts: string[] = [];
  if (p.volume !== undefined) parts.push(`volume ${p.volume}`);
  if (p.auxInserted !== undefined) parts.push(`AUX cable ${p.auxInserted ? 'in' : 'out'}`);
  if (p.eq) parts.push(`EQ ${eqName(p.eq.mode)} gains [${p.eq.gains.join(' ')}]`);
  if (p.currentFunction !== undefined) parts.push(`current ${functionName(p.currentFunction)}`);
  if (p.formats) parts.push(`formats "${p.formats}"`);
  parts.push(`attrs [${p.tlvs.map((x) => x.type.toString(16)).join(' ')}]`);
  return parts.join('; ');
}
