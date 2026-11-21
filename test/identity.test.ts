import { describe, expect, it } from 'vitest';
import { hex } from '../src/identity/identity';
import { describeTlv, modelQueryFrame, parseModelFrame, parseTlvs, reportText, rows, targetInfoFrame, targetInfoPayload } from '../src/identity/identity';
import { fromHex } from '../src/protocol/hex';

// ZK-502MT GetTargetInfo payload; the address (type 2) and ID string (type 3) are replaced with dummies.
const PAYLOAD = fromHex(
  '02 00 21 05 01 32 1e 1e 00 09 02 11 22 33 44 55 66 2d 01 12 03 01' +
    ' 41 41 41 41 41 41 41 41 41 41 41 41 41 41 41 41' +
    ' 06 04 00 00 00 0b 03 03 05 00 00 03 07 ff 97 02 08 00 02 09 00 05 0a 00 00 00 00 02 06 00 01 0b 01 0c',
);
const frameOf = (p: Uint8Array) => {
  const len = p.length + 2;
  return Uint8Array.from([0xfe, 0xdc, 0xba, 0x00, 0x03, len >> 8, len & 0xff, 0x00, 0x00, ...p, 0xef]);
};
const MODEL = fromHex('aa 12 01 30 30 32 30 31 30 32 32 30 33 01 08 00 04 01 08 55');

describe('device identity', () => {
  it('builds only the two read-only frames', () => {
    expect(hex(targetInfoFrame(5))).toBe('fe dc ba c0 03 00 06 05 ff ff ff ff 00 ef');
    expect(hex(modelQueryFrame(6))).toBe('fe dc ba c0 ff 00 05 06 aa 01 01 55 ef');
  });
  it('extracts the payload and keeps every TLV, known or not', () => {
    const p = targetInfoPayload(frameOf(PAYLOAD))!;
    expect(hex(p)).toBe(hex(PAYLOAD));
    expect(parseTlvs(p).tlvs.map((t) => t.type)).toEqual([0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 6, 11, 12]);
  });
  it('describes the ZK-502MT fields', () => {
    const t = Object.fromEntries(parseTlvs(PAYLOAD).tlvs.map((x) => [x.type, x]));
    expect(describeTlv(t[6]!)).toBe('SDK type 0 (SDK table: AC692x, AI soundbox; a hint, not a confirmed chip)');
    expect(describeTlv(t[10]!)).toBe('VID 0x0000, PID 0x0000');
    expect(describeTlv(t[5]!)).toBe('firmware version, code 0x0000');
    expect(describeTlv(t[7]!)).toBe('bootloader version, 2 bytes ff 97');
  });
  it('marks wanted types as "not reported" and never throws on broken input', () => {
    const r = rows(parseTlvs(fromHex('02 06 00')).tlvs);
    expect(r.filter((x) => !x.reported).map((x) => x.type)).toEqual([3, 5, 7, 10, 11, 12]);
    expect(parseTlvs(fromHex('02 06 00 05 03 41')).error).toMatch(/broken TLV/);
  });
  it('parses the model reply and writes the text report', () => {
    const m = parseModelFrame(MODEL)!;
    expect([m.productCode, m.field2, m.field3, hex(m.raw6)]).toEqual(['002', '010', '2203', '01 08 00 04 01 08']);
    const text = reportText({ targetInfoFrame: frameOf(PAYLOAD), tlvs: parseTlvs(PAYLOAD).tlvs, model: m, modelFrame: MODEL }, true);
    expect(text).toContain('type 6: 00 (SDK type 0 (SDK table');
    expect(text).toContain('type 11: (empty) (auth key)');
    expect(text).toContain('product code "002"');
    expect(text).toContain(`Model query reply: ${hex(MODEL)}`);
  });
});

describe('redaction', () => {
  // dummy address 11..66 and ID string "WZ001" + "AAAAAAAAAAA"
  const P = fromHex('09 02 11 22 33 44 55 66 2d 01 12 03 01 57 5a 30 30 31 41 41 41 41 41 41 41 41 41 41 41 02 06 00');
  const r = { targetInfoFrame: frameOf(P), tlvs: parseTlvs(P).tlvs, model: null, modelFrame: null };
  it('hides the address and the serial part of the ID by default, everywhere in the report', () => {
    const text = reportText(r);
    expect(text).not.toContain('11 22 33 44 55 66');
    expect(text).not.toContain('AAAAAAAAAAA');
    expect(text).not.toContain('41 41 41');
    expect(text).toContain('xx xx xx xx xx xx 2d 01');
    expect(text).toContain('WZ001');
    expect(text).toContain('redacted');
  });
  it('includes them when asked', () => {
    const text = reportText(r, true);
    expect(text).toContain('11 22 33 44 55 66');
    expect(text).toContain('AAAAAAAAAAA');
  });
});
