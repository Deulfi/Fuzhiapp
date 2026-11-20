import { describe, expect, it } from 'vitest';
import { FrameReassembler, decodeFrame } from '../src/protocol/codec';
import { fromHex, toHex } from '../src/protocol/hex';

// Frames captured from a ZK-502MT (no device-unique bytes in these).
const SYSINFO_REPLY = fromHex(
  'fe dc ba 00 07 00 3a 00 01 ff 02 00 32 02 01 1e 12 02 10 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 0c 04 00 00 00 00 00 00 00 00 00 00 00 0d 05 4d 50 31 4d 50 32 4d 50 33 57 41 56 02 06 00 ef',
);
const DSP_ACK = fromHex('fe dc ba 00 ff 00 02 00 04 ef');
const PUSH_21 = fromHex('fe dc ba c0 ff 00 06 01 aa 02 21 01 55 ef');

describe('decodeFrame', () => {
  it('decodes a response: status, sn, payload', () => {
    const f = decodeFrame(SYSINFO_REPLY)!;
    expect(f.isCommand).toBe(false);
    expect(f.opcode).toBe(0x07);
    expect(f.status).toBe(0);
    expect(f.sn).toBe(1);
    expect(f.payload.length).toBe(0x3a - 2);
    expect(f.payload[0]).toBe(0xff);
  });
  it('decodes a response with an empty payload', () => {
    const f = decodeFrame(DSP_ACK)!;
    expect([f.status, f.sn, f.payload.length]).toEqual([0, 4, 0]);
  });
  it('decodes a device-initiated command', () => {
    const f = decodeFrame(PUSH_21)!;
    expect([f.isCommand, f.expectsResponse, f.opcode, f.sn]).toEqual([true, true, 0xff, 1]);
    expect(toHex(f.payload)).toBe('aa 02 21 01 55');
  });
});

describe('FrameReassembler', () => {
  it('passes a whole frame through', () => {
    expect(new FrameReassembler().push(SYSINFO_REPLY).map((f) => f.opcode)).toEqual([0x07]);
  });

  it('reassembles a frame split into 20-byte notifications', () => {
    const r = new FrameReassembler();
    const got = [];
    for (let i = 0; i < SYSINFO_REPLY.length; i += 20) got.push(...r.push(SYSINFO_REPLY.slice(i, i + 20)));
    expect(got.length).toBe(1);
    expect(toHex(got[0]!.raw)).toBe(toHex(SYSINFO_REPLY));
    expect(r.pending).toBe(0);
  });

  it('reassembles byte by byte, including a split start marker', () => {
    const r = new FrameReassembler();
    const got = [];
    for (const b of SYSINFO_REPLY) got.push(...r.push(Uint8Array.of(b)));
    expect(got.length).toBe(1);
  });

  it('splits several frames in one notification (seen: three pushes back to back)', () => {
    const r = new FrameReassembler();
    const all = new Uint8Array([...PUSH_21, ...DSP_ACK, ...PUSH_21]);
    expect(r.push(all).map((f) => f.opcode)).toEqual([0xff, 0xff, 0xff]);
  });

  it('discards garbage and auth messages before a frame', () => {
    const discarded: string[] = [];
    const r = new FrameReassembler(2048, { onDiscard: (b) => discarded.push(toHex(b)) });
    const got = r.push(new Uint8Array([...fromHex('0270617373 1122'), ...DSP_ACK]));
    expect(got.length).toBe(1);
    expect(discarded.join(' ')).toBe('02 70 61 73 73 11 22');
  });

  it('resyncs after a false start with a bad end byte', () => {
    const r = new FrameReassembler();
    // Looks like a frame with paramLen 2 but the end byte is wrong.
    const bad = fromHex('fe dc ba 00 ff 00 02 00 04 00');
    expect(r.push(new Uint8Array([...bad, ...DSP_ACK])).length).toBe(1);
  });

  it('rejects an implausible paramLen instead of waiting forever', () => {
    const r = new FrameReassembler(100);
    const got = r.push(new Uint8Array([...fromHex('fe dc ba 00 ff ff ff'), ...DSP_ACK]));
    expect(got.length).toBe(1);
  });

  it('keeps an incomplete frame until the rest arrives', () => {
    const r = new FrameReassembler();
    expect(r.push(DSP_ACK.slice(0, 6))).toEqual([]);
    expect(r.pending).toBe(6);
    expect(r.push(DSP_ACK.slice(6)).length).toBe(1);
  });
});
