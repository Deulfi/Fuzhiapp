import { describe, expect, it } from 'vitest';
import { authChallenge, authResponse, AUTH_PASS } from '../src/protocol/auth';
import { Op, Payload, concat, encodeCommand, encodeRaw, tlv } from '../src/protocol/frame';
import { fromHex } from '../src/protocol/hex';
import { checkOutgoing } from '../src/protocol/safety';

const setVol = (v: number) => encodeCommand(Op.SetSysInfo, 9, concat(Uint8Array.of(0xff), tlv(1, Uint8Array.of(v))));

describe('volume guard', () => {
  it('blocks any volume write when no cap is confirmed', () => {
    expect(checkOutgoing(setVol(1), null).action).toBe('block');
  });
  it('blocks above the cap, asks for confirmation at or below it', () => {
    expect(checkOutgoing(setVol(11), 10).action).toBe('block');
    expect(checkOutgoing(setVol(10), 10).action).toBe('confirm');
  });
  it('finds a volume TLV after another TLV', () => {
    const p = concat(Uint8Array.of(0xff), tlv(0x0b, new Uint8Array(8)), tlv(1, Uint8Array.of(30)));
    expect(checkOutgoing(encodeCommand(Op.SetSysInfo, 1, p), 10).action).toBe('block');
  });
  it('blocks malformed TLVs (could hide a volume write)', () => {
    expect(checkOutgoing(encodeCommand(Op.SetSysInfo, 1, Uint8Array.of(0xff, 0x05, 0x01, 0x40)), 100).action).toBe('block');
  });
  it('blocks a volume frame hidden after a harmless one', () => {
    const both = concat(encodeCommand(Op.GetTargetInfo, 1, Payload.targetInfoAll()), setVol(99));
    expect(checkOutgoing(both, 10).action).toBe('block');
  });
  it('blocks a frame body sent without its header (split smuggling)', () => {
    expect(checkOutgoing(fromHex('08 00 05 03 ff 02 01 64 ef'), 10).action).toBe('block');
    expect(checkOutgoing(fromHex('fe dc ba c0'), 10).action).toBe('block');
  });
});

describe('other rules', () => {
  it('allows the read-only startup queries', () => {
    expect(checkOutgoing(encodeCommand(Op.GetTargetInfo, 1, Payload.targetInfoAll()), null).action).toBe('allow');
    expect(checkOutgoing(encodeCommand(Op.GetSysInfo, 2, Payload.sysInfoPublicAll()), null).action).toBe('allow');
    expect(checkOutgoing(encodeCommand(Op.Custom, 3, Payload.dspReadInfo()), null).action).toBe('allow');
  });
  it('allows auth messages', () => {
    expect(checkOutgoing(authChallenge(new Uint8Array(16)), null).action).toBe('allow');
    expect(checkOutgoing(authResponse(new Uint8Array(16)), null).action).toBe('allow');
    expect(checkOutgoing(AUTH_PASS, null).action).toBe('allow');
  });
  it('allows only the plain reboot inside the OTA range', () => {
    expect(checkOutgoing(encodeCommand(Op.Reboot, 1, Uint8Array.of(0)), null).action).toBe('confirm');
    expect(checkOutgoing(encodeCommand(Op.Reboot, 1, Uint8Array.of(1)), null).action).toBe('block');
    expect(checkOutgoing(encodeCommand(Op.Reboot, 1), null).action).toBe('block');
  });
  it('blocks OTA opcodes', () => {
    expect(checkOutgoing(encodeCommand(0xe1, 1), null).action).toBe('block');
    expect(checkOutgoing(encodeCommand(0xe8, 1), null).action).toBe('block');
  });
  it('asks for confirmation on state-changing or unknown commands', () => {
    expect(checkOutgoing(encodeCommand(Op.Function, 1, Uint8Array.of(0xff, 3)), null).action).toBe('confirm');
    expect(checkOutgoing(encodeCommand(Op.Custom, 1, fromHex('aa030d0a0a55')), null).action).toBe('confirm');
    expect(checkOutgoing(encodeCommand(0x42, 1), null).action).toBe('confirm');
    expect(checkOutgoing(encodeRaw(0x00, Op.Custom, Uint8Array.of(0, 1, 0xaa)), null).action).toBe('confirm');
    expect(checkOutgoing(encodeRaw(0x00, Op.Custom, Uint8Array.of(1, 1)), null).action).toBe('confirm');
  });
  it('allows a bare ack (status 0, sn, no payload)', () => {
    expect(checkOutgoing(encodeRaw(0x00, Op.Custom, Uint8Array.of(0, 1)), null).action).toBe('allow');
  });
});

describe('Wuzhi settings commands (§12.2)', () => {
  const custom = (hex: string) => encodeCommand(Op.Custom, 4, fromHex(hex));
  it('allows the read queries', () => {
    for (const q of ['aa 01 01 55', 'aa 01 12 55', 'aa 01 13 55', 'aa 01 1a 55']) {
      expect(checkOutgoing(custom(q), null).action).toBe('allow');
    }
  });
  it('caps the beep volume like the main volume', () => {
    expect(checkOutgoing(custom('aa 03 02 01 05 55'), null).action).toBe('block');
    expect(checkOutgoing(custom('aa 03 02 01 0b 55'), 10).action).toBe('block');
    expect(checkOutgoing(custom('aa 03 02 01 0a 55'), 10).action).toBe('confirm');
    expect(checkOutgoing(custom('aa 04 02 01 0a 00 55'), 30).action).toBe('block');
  });
  it('asks before power-off, pairing, rename, TWS and disconnect', () => {
    for (const q of ['aa 01 04 55', 'aa 06 03 01 31 31 31 31 55', 'aa 03 05 41 42 55', 'aa 01 0b 55']) {
      expect(checkOutgoing(custom(q), null).action).toBe('confirm');
    }
    expect(checkOutgoing(encodeCommand(Op.DisconnectClassic, 1), null).action).toBe('confirm');
  });
});
