import { describe, expect, it } from 'vitest';
import { decodeFrame } from '../src/protocol/codec';
import { fromHex } from '../src/protocol/hex';
import { describeSysInfo, eqName, functionsInMask, parseSysInfo, parseTargetInfo, parseTlvs } from '../src/protocol/info';

// Same layout as a real ZK-502MT reply; the address and ID string are replaced with dummy bytes.
const TARGET_INFO_PAYLOAD = fromHex(
  '02 00 21 05 01 32 1e 1e 00 09 02 11 22 33 44 55 66 2d 01 12 03 01' +
    ' 41 41 41 41 41 41 41 41 41 41 41 41 41 41 41 41' +
    ' 06 04 00 00 00 0b 03 03 05 00 00 03 07 ee 93 02 08 00 02 09 00 05 0a 00 00 00 00 02 06 00 01 0b 01 0c',
);
const SYSINFO_REPLY = fromHex(
  'fe dc ba 00 07 00 3a 00 01 ff 02 00 32 02 01 1e 12 02 10 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 0c 04 00 00 00 00 00 00 00 00 00 00 00 0d 05 4d 50 31 4d 50 32 4d 50 33 57 41 56 02 06 00 ef',
);

describe('parseTlvs', () => {
  it('parses zero-data entries', () => {
    expect(parseTlvs(fromHex('01 0b 01 0c')).map((t) => [t.type, t.data.length])).toEqual([
      [0x0b, 0],
      [0x0c, 0],
    ]);
  });
  it('throws on truncation and zero length', () => {
    expect(() => parseTlvs(fromHex('05 01 32'))).toThrow();
    expect(() => parseTlvs(fromHex('00 01'))).toThrow();
  });
});

describe('parseTargetInfo (ZK-502MT layout)', () => {
  const t = parseTargetInfo(TARGET_INFO_PAYLOAD);
  it('reads version, power info, A2DP status', () => {
    expect(t.protocolVersion).toBe('2.1');
    expect(t.power).toEqual({ battery: 50, volume: 30, maxVolume: 30, flags: 0 });
    expect(t.edr).toEqual({ profile: 0x2d, status: 1 });
  });
  it('reads the function mask and current function', () => {
    expect(functionsInMask(t.functionMask!)).toEqual([0, 1, 3]);
    expect(t.currentFunction).toBe(3);
  });
  it('keeps all 13 TLVs', () => {
    expect(t.tlvs.map((x) => x.type)).toEqual([0, 1, 2, 3, 4, 5, 7, 8, 9, 0x0a, 6, 0x0b, 0x0c]);
  });
});

describe('parseSysInfo (ZK-502MT public reply)', () => {
  const s = parseSysInfo(decodeFrame(SYSINFO_REPLY)!.payload);
  it('reads the public attributes', () => {
    expect(s.function).toBe(0xff);
    expect(s.pub?.volume).toBe(30);
    expect(s.pub?.eq).toEqual({ mode: 0, gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
    expect(s.pub?.formats).toBe('MP1MP2MP3WAV');
    expect(s.pub?.currentFunction).toBe(0);
  });
  it('summarises', () => {
    expect(describeSysInfo(s)).toContain('volume 30');
    expect(describeSysInfo(s)).toContain('current Bluetooth');
  });
});

describe('SysInfo details seen on the amp', () => {
  it('reads EQ gains as signed bytes (preset 3: V-curve)', () => {
    // GetSysInfo reply after selecting EQ mode 3
    const s = parseSysInfo(fromHex('ff 0c 04 03 04 02 00 fd fa fa fd 00 03 05'));
    expect(s.pub?.eq).toEqual({ mode: 3, gains: [4, 2, 0, -3, -6, -6, -3, 0, 3, 5] });
  });
  it('reads the AUX-cable flag from attr 2', () => {
    const zeros = ' 00'.repeat(16);
    expect(parseSysInfo(fromHex('ff 12 02 10' + zeros)).pub?.auxInserted).toBe(true);
    expect(parseSysInfo(fromHex('ff 12 02 00' + zeros)).pub?.auxInserted).toBe(false);
  });
  it('parses the opcode 0x09 push for function AUX', () => {
    const s = parseSysInfo(fromHex('03 02 00 01'));
    expect(s.function).toBe(3);
    expect(s.tlvs).toEqual([{ type: 0, data: Uint8Array.of(1) }]);
  });
});

describe('EQ names (tested on the amp)', () => {
  it('maps modes 0–6 and describes them by name', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(eqName)).toEqual(['Normal', 'Rock', 'Pop', 'Classical', 'Jazz', 'Country', 'User']);
    expect(describeSysInfo(parseSysInfo(fromHex('ff 0c 04 01 00 08 08 04 00 00 00 00 02 02')))).toContain('EQ Rock');
  });
});
