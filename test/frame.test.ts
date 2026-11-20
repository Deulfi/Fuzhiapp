import { describe, expect, it } from 'vitest';
import { Op, Payload, concat, dspFrame, encodeCommand, splitExactFrames, tlv } from '../src/protocol/frame';
import { fromHex, toHex } from '../src/protocol/hex';

describe('encodeCommand matches docs/PROTOCOL.md §3 worked examples', () => {
  const cases: [string, Uint8Array, string][] = [
    ['GetTargetInfo (all)', encodeCommand(Op.GetTargetInfo, 1, Payload.targetInfoAll()), 'fe dc ba c0 03 00 06 01 ff ff ff ff 00 ef'],
    ['GetSysInfo public, volume', encodeCommand(Op.GetSysInfo, 2, Uint8Array.of(0xff, 0, 0, 0, 2)), 'fe dc ba c0 07 00 06 02 ff 00 00 00 02 ef'],
    // Encoding test vector only; never sent to the device.
    ['SetSysInfo volume = 20', encodeCommand(Op.SetSysInfo, 3, concat(Uint8Array.of(0xff), tlv(1, Uint8Array.of(20)))), 'fe dc ba c0 08 00 05 03 ff 02 01 14 ef'],
    ['Function: switch to AUX', encodeCommand(Op.Function, 4, Uint8Array.of(0xff, 3)), 'fe dc ba c0 0e 00 03 04 ff 03 ef'],
    ['DSP custom: query', encodeCommand(Op.Custom, 6, Payload.dspReadInfo()), 'fe dc ba c0 ff 00 05 06 aa 01 1f 55 ef'],
  ];
  it.each(cases)('%s', (_name, frame, expected) => {
    expect(toHex(frame)).toBe(expected);
  });

  it('sn wraps to one byte', () => {
    expect(encodeCommand(Op.GetTargetInfo, 256, Payload.targetInfoAll())[7]).toBe(0);
  });
  it('builds the DSP balance frame from frames_demo.py', () => {
    expect(toHex(encodeCommand(Op.Custom, 5, dspFrame(0x0c, Uint8Array.of(10, 10))))).toBe('fe dc ba c0 ff 00 07 05 aa 03 0c 0a 0a 55 ef');
  });
});

describe('splitExactFrames', () => {
  it('splits two back-to-back frames', () => {
    const f = splitExactFrames(fromHex('fedcbac00e000304ff03ef fedcbac0ff000506aa011f55ef'));
    expect(f?.map((x) => x.opcode)).toEqual([0x0e, 0xff]);
  });
  it('rejects trailing bytes, truncation and a bad EOF', () => {
    expect(splitExactFrames(fromHex('fedcbac00e000304ff03ef00'))).toBeNull();
    expect(splitExactFrames(fromHex('fedcbac00e000304ff03'))).toBeNull();
    expect(splitExactFrames(fromHex('fedcbac00e000304ff0300'))).toBeNull();
    expect(splitExactFrames(fromHex('08000503ff020114ef'))).toBeNull();
  });
});
