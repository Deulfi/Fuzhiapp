import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from '../src/protocol/hex';
import { beepSet, btNameFrame, describeWuzhi, pairingSet, splitWuzhi, wuzhiRead, WuzhiCmd } from '../src/protocol/wuzhi';

describe('Wuzhi settings frames (§12.2)', () => {
  it('builds reads and beep writes', () => {
    expect(toHex(wuzhiRead(WuzhiCmd.BeepRead))).toBe('aa 01 12 55');
    expect(toHex(beepSet(true, 15))).toBe('aa 03 02 01 0f 55');
    expect(() => beepSet(true, 31)).toThrow();
  });
  it('rejects frames whose length byte does not match', () => {
    expect(splitWuzhi(fromHex('aa 05 12 01 0f 55'))).toBeNull();
    expect(splitWuzhi(fromHex('aa 03 12 01 0f 55'))).toEqual({ cmd: 0x12, data: Uint8Array.of(1, 15) });
  });
  it('describes replies without printing the pairing code', () => {
    expect(describeWuzhi(fromHex('aa 03 12 01 0f 55'))).toBe('beep on, volume 15');
    expect(describeWuzhi(fromHex('aa 06 13 01 31 32 33 34 55'))).toBe('pairing code on (code hidden)');
    expect(describeWuzhi(fromHex('aa 02 1a 08 55'))).toBe('indicator LED level 8');
    expect(describeWuzhi(fromHex('aa 01 1f 55'))).toBe('Wuzhi cmd 0x1f (no data)');
  });
  it('describes the replies seen on the ZK-502MT', () => {
    expect(describeWuzhi(fromHex('aa 02 02 80 55'))).toBe('beep setting acknowledged (0x80)');
    expect(describeWuzhi(fromHex('aa 02 21 03 55'))).toBe('source changed → AUX');
    expect(describeWuzhi(fromHex('aa 12 01 30 30 32 30 31 30 32 32 30 33 01 08 00 04 01 08 55'))).toBe(
      "product code 002 (model WZ002), then \"010\", \"2203\", check 180418 (passes the vendor app's ≥ 180418 test [D])",
    );
  });
});

describe('rename and source states', () => {
  it('builds the rename frame and rejects bad names', () => {
    expect(toHex(btNameFrame('wuzhi'))).toBe('aa 06 05 77 75 7a 68 69 55');
    expect(() => btNameFrame('')).toThrow();
    expect(() => btNameFrame('x'.repeat(21))).toThrow();
    expect(() => btNameFrame('wüzhi')).toThrow();
  });
  it('names the idle source state', () => {
    expect(describeWuzhi(fromHex('aa 02 21 05 55'))).toBe('source changed → idle (no source)');
  });
});

describe('pairing code', () => {
  it('builds the frame and checks the code', () => {
    expect(toHex(pairingSet(true, '2222'))).toBe('aa 06 03 01 32 32 32 32 55');
    expect(() => pairingSet(true, '123')).toThrow();
    expect(() => pairingSet(true, '12a4')).toThrow();
  });
});

describe('section 12.4 reads', () => {
  it('decodes EQ readback (dB + 12) and volume', () => {
    expect(describeWuzhi(fromHex('aa 0c 1b 01 0c 14 14 10 0c 0c 0c 0c 0e 0e 55'))).toBe('EQ mode 1 gains [0 8 8 4 0 0 0 0 2 2] dB (sent as dB + 12)');
    expect(describeWuzhi(fromHex('aa 02 19 16 55'))).toBe('volume 22');
  });
});
