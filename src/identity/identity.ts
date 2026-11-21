/**
 * Device identity: collects the fields an amp reports about itself (docs/DEVICE_ID_AND_FIRMWARE.md).
 * Self-contained on purpose (no imports from the rest of the project), so it can be reused
 * elsewhere. Read-only: the only frames it builds are GetTargetInfo and the Wuzhi model query.
 */

export interface Tlv {
  type: number;
  data: Uint8Array;
}

export interface ModelInfo {
  /** whole Wuzhi frame `AA len 01 … 55` */
  frame: Uint8Array;
  productCode: string;
  field2: string;
  field3: string;
  raw6: Uint8Array;
}

export interface IdentityReport {
  targetInfoFrame: Uint8Array | null;
  tlvs: Tlv[];
  /** set when the target-info payload could not be fully parsed */
  tlvError?: string;
  model: ModelInfo | null;
  modelFrame: Uint8Array | null;
}

/** Types the analysis asks for; shown as "not reported" when missing. */
export const WANTED_TYPES = [3, 5, 6, 7, 10, 11, 12] as const;

export const TYPE_NAMES: Record<number, string> = {
  0: 'protocol version',
  1: 'power / volume',
  2: 'EDR address + status',
  3: 'platform',
  4: 'function mask',
  5: 'firmware version',
  6: 'SDK type',
  7: 'bootloader version',
  8: 'OTA backup flags',
  9: 'upgrade flags',
  10: 'VID / PID',
  11: 'auth key',
  12: 'project code',
  13: 'MTU',
};

/** SDK chip-flag table (DEVICE_ID_AND_FIRMWARE.md §2.1) [D]. What the SDK table says, not a confirmed chip. */
export const SDK_TYPES: Record<number, string> = {
  0: 'AC692x, AI soundbox',
  1: 'AC692x, standard soundbox',
  2: 'AC693x, TWS headset',
  3: 'AC695x, charging case',
  4: 'AC697x, TWS headset',
  5: 'AC696x, soundbox',
  6: 'AC696x, TWS soundbox',
  7: 'AC695x, sound card',
  8: 'AC695x, watch',
};

export const JIELI_VID = 0x05d6;

// ---------- frames ----------
const frame = (opcode: number, sn: number, payload: number[]) => {
  const params = [sn & 0xff, ...payload];
  return Uint8Array.from([0xfe, 0xdc, 0xba, 0xc0, opcode, params.length >> 8, params.length & 0xff, ...params, 0xef]);
};
export const OP_TARGET_INFO = 0x03;
export const OP_CUSTOM = 0xff;
export const TARGET_INFO_PAYLOAD = Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0x00);
export const MODEL_QUERY = Uint8Array.of(0xaa, 0x01, 0x01, 0x55);
export const targetInfoFrame = (sn: number) => frame(OP_TARGET_INFO, sn, [...TARGET_INFO_PAYLOAD]);
export const modelQueryFrame = (sn: number) => frame(OP_CUSTOM, sn, [...MODEL_QUERY]);

// ---------- parsing ----------
export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
const printable = (b: number) => b >= 0x20 && b <= 0x7e;
/** ASCII with non-printable bytes as '.', or '' when nothing is printable. */
export const ascii = (b: Uint8Array) => (Array.from(b).some(printable) ? String.fromCharCode(...Array.from(b, (x) => (printable(x) ? x : 0x2e))) : '');

/**
 * Parse `[len][type][data(len-1)]` TLVs. Never throws: stops at the first broken entry and
 * reports the error, keeping everything parsed before it.
 */
export function parseTlvs(payload: Uint8Array): { tlvs: Tlv[]; error?: string } {
  const tlvs: Tlv[] = [];
  let i = 0;
  while (i < payload.length) {
    const len = payload[i]!;
    if (len < 1 || i + 1 + len > payload.length) return { tlvs, error: `broken TLV at offset ${i} (len ${len})` };
    tlvs.push({ type: payload[i + 1]!, data: payload.slice(i + 2, i + 1 + len) });
    i += 1 + len;
  }
  return { tlvs };
}

/**
 * Payload of a GetTargetInfo response frame: `FE DC BA flags 03 lenHi lenLo status sn payload… EF`.
 * Null if it isn't one.
 */
export function targetInfoPayload(f: Uint8Array): Uint8Array | null {
  if (f.length < 10 || f[0] !== 0xfe || f[1] !== 0xdc || f[2] !== 0xba || f[4] !== OP_TARGET_INFO) return null;
  const len = (f[5]! << 8) | f[6]!;
  if (f.length < 7 + len + 1 || len < 2) return null;
  return f.slice(9, 7 + len);
}

/** Model-query reply `AA len 01 data… 55` (3 + 3 + 4 ASCII, 6 raw bytes). Null if it isn't one. */
export function parseModelFrame(w: Uint8Array): ModelInfo | null {
  if (w.length < 4 || w[0] !== 0xaa || w[2] !== 0x01 || w[w.length - 1] !== 0x55) return null;
  const d = w.subarray(3, w.length - 1);
  if (d.length < 16) return null;
  const s = (a: number, b: number) => String.fromCharCode(...d.subarray(a, b));
  return { frame: w.slice(), productCode: s(0, 3), field2: s(3, 6), field3: s(6, 10), raw6: d.slice(10, 16) };
}

/** Short meaning of a TLV, where the analysis gives one. Never throws. */
export function describeTlv(t: Tlv): string {
  const d = t.data;
  const be16 = (o: number) => (d[o]! << 8) | d[o + 1]!;
  switch (t.type) {
    case 0:
      return d.length ? `protocol version ${d[0]! >> 4}.${d[0]! & 0x0f}` : 'protocol version';
    case 5:
      return d.length >= 2 ? `firmware version, code 0x${be16(0).toString(16).padStart(4, '0')}${d.length > 2 ? `, name "${ascii(d.subarray(2))}"` : ''}` : 'firmware version';
    case 6:
      return d.length ? `SDK type ${d[0]}${SDK_TYPES[d[0]!] ? ` (SDK table: ${SDK_TYPES[d[0]!]}; a hint, not a confirmed chip)` : ' (not in the SDK table)'}` : 'SDK type';
    case 7:
      return d.length === 2 && !ascii(d).match(/^[ -~]{2}$/) ? `bootloader version, 2 bytes ${hex(d)}` : `bootloader version "${ascii(d)}"`;
    case 10:
      if (d.length >= 4) {
        const vid = be16(0);
        return `VID 0x${vid.toString(16).padStart(4, '0')}${vid === JIELI_VID ? ' (Jieli)' : ''}, PID 0x${be16(2).toString(16).padStart(4, '0')}`;
      }
      return 'VID / PID';
    default:
      return TYPE_NAMES[t.type] ?? 'unknown type';
  }
}

// ---------- report ----------
export interface Row {
  type: number;
  name: string;
  hex: string;
  ascii: string;
  meaning: string;
  reported: boolean;
}

/** One row per TLV found, plus "not reported" rows for wanted types that were missing. Sorted by type. */
export function rows(tlvs: Tlv[]): Row[] {
  const out: Row[] = tlvs.map((t) => ({
    type: t.type,
    name: TYPE_NAMES[t.type] ?? 'unknown',
    hex: t.data.length ? hex(t.data) : '(empty)',
    ascii: ascii(t.data),
    meaning: describeTlv(t),
    reported: true,
  }));
  for (const w of WANTED_TYPES) {
    if (!tlvs.some((t) => t.type === w)) out.push({ type: w, name: TYPE_NAMES[w]!, hex: '', ascii: '', meaning: 'not reported', reported: false });
  }
  return out.sort((a, b) => a.type - b.type);
}

/** Types whose content identifies one physical amp: EDR address (2) and the platform/ID string (3). */
export const PRIVATE_TYPES = [2, 3] as const;

/** Hex strings of private data in a set of TLVs, for scrubbing raw frames and logs. */
export function privateHexes(tlvs: Tlv[]): string[] {
  const out: string[] = [];
  for (const t of tlvs) {
    if (t.type === 2 && t.data.length >= 6) out.push(hex(t.data.subarray(0, 6)));
    if (t.type === 3 && t.data.length > 6) out.push(hex(t.data.subarray(6)));
  }
  return out;
}

/** Replace every occurrence of the private byte sequences (as hex text and as ASCII) in `text`. */
export function scrub(text: string, tlvs: Tlv[]): string {
  let s = text;
  for (const h of privateHexes(tlvs)) s = s.split(h).join(h.replace(/[0-9a-f]{2}/g, 'xx'));
  for (const t of tlvs) {
    if (t.type === 3 && t.data.length > 6) {
      const a = ascii(t.data.subarray(6));
      if (a.length >= 4) s = s.split(a).join('x'.repeat(a.length));
    }
  }
  return s;
}

/** Plain-text report for pasting back to the analysis. Private fields are redacted unless `includePrivate`. */
export function reportText(r: IdentityReport, includePrivate = false): string {
  const text = reportTextRaw(r);
  return includePrivate ? text : `${scrub(text, r.tlvs)}\n\n(Bluetooth address and serial-like ID redacted.)`;
}

function reportTextRaw(r: IdentityReport): string {
  const lines: string[] = ['Device identity report', ''];
  lines.push('GetTargetInfo TLVs:');
  if (!r.targetInfoFrame) lines.push('  no GetTargetInfo reply');
  for (const row of rows(r.tlvs)) {
    if (!row.reported) {
      lines.push(`type ${row.type}: not reported (${row.name})`);
      continue;
    }
    const asc = row.ascii ? ` "${row.ascii}"` : '';
    lines.push(`type ${row.type}: ${row.hex}${asc} (${row.meaning})`);
  }
  if (r.tlvError) lines.push(`parse note: ${r.tlvError}`);
  lines.push('', 'Model query (AA 01 01 55 in opcode 0xFF):');
  if (r.model) {
    lines.push(`product code "${r.model.productCode}"`, `field 2 "${r.model.field2}"`, `field 3 "${r.model.field3}"`, `6 raw bytes: ${hex(r.model.raw6)}`);
  } else {
    lines.push(r.modelFrame ? 'reply not in the expected layout' : 'no reply');
  }
  lines.push('', 'Raw frames:');
  lines.push(`GetTargetInfo response: ${r.targetInfoFrame ? hex(r.targetInfoFrame) : '(none)'}`);
  lines.push(`Model query reply: ${r.modelFrame ? hex(r.modelFrame) : '(none)'}`);
  return lines.join('\n');
}
