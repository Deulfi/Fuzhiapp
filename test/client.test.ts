import { describe, expect, it } from 'vitest';
import { RcspClient, RcspStatusError, RcspTimeoutError, ackFor } from '../src/protocol/client';
import { decodeFrame } from '../src/protocol/codec';
import { Op, Payload, encodeRaw } from '../src/protocol/frame';
import type { Link } from '../src/protocol/handshake';
import { fromHex, toHex } from '../src/protocol/hex';

/** Fake link: records writes; the test pushes device bytes with `deliver`. */
function fakeLink(reply?: (written: Uint8Array) => Uint8Array[] | undefined) {
  let listener: ((b: Uint8Array) => void) | null = null;
  const written: Uint8Array[] = [];
  const deliver = (b: Uint8Array) => listener?.(b);
  const link: Link = {
    async write(b) {
      written.push(b);
      for (const r of reply?.(b) ?? []) queueMicrotask(() => deliver(r));
    },
    onData(cb) {
      listener = cb;
      return () => (listener = null);
    },
  };
  return { link, written, deliver };
}

/** Device reply: flags 00, same opcode, status, echoed sn, payload. */
const respond = (cmd: Uint8Array, status = 0, payload: number[] = []) =>
  encodeRaw(0x00, cmd[4]!, Uint8Array.of(status, cmd[7]!, ...payload));

describe('RcspClient', () => {
  it('matches a reply by opcode and sn', async () => {
    const { link } = fakeLink((b) => [respond(b, 0, [0xff, 0x02, 0x01, 0x1e])]);
    const c = new RcspClient(link);
    c.start();
    const f = await c.request(Op.GetSysInfo, Payload.sysInfoPublicAll());
    expect(toHex(f.payload)).toBe('ff 02 01 1e');
  });

  it('increments and wraps sn', async () => {
    const { link, written } = fakeLink((b) => [respond(b)]);
    const c = new RcspClient(link);
    c.start();
    for (let i = 0; i < 257; i++) await c.request(Op.GetTargetInfo, Payload.targetInfoAll());
    expect(written.map((w) => w[7])).toEqual([...Array.from({ length: 256 }, (_, i) => i), 0]);
  });

  it('matches out-of-order replies, split across notifications', async () => {
    const { link, written, deliver } = fakeLink();
    const c = new RcspClient(link);
    c.start();
    const a = c.request(Op.GetTargetInfo, Payload.targetInfoAll());
    const b = c.request(Op.GetSysInfo, Payload.sysInfoPublicAll());
    await Promise.resolve();
    const both = new Uint8Array([...respond(written[1]!, 0, [7]), ...respond(written[0]!, 0, [3])]);
    deliver(both.slice(0, 5));
    deliver(both.slice(5));
    expect((await a).payload[0]).toBe(3);
    expect((await b).payload[0]).toBe(7);
  });

  it('ignores a reply with the wrong opcode for that sn', async () => {
    const { link, written, deliver } = fakeLink();
    const c = new RcspClient(link, {}, { timeoutMs: 30 });
    c.start();
    const p = c.request(Op.GetSysInfo, Payload.sysInfoPublicAll());
    await Promise.resolve();
    deliver(encodeRaw(0x00, Op.GetTargetInfo, Uint8Array.of(0, written[0]![7]!)));
    await expect(p).rejects.toThrow(RcspTimeoutError);
  });

  it('does not time out while the write itself is slow (seen: confirm dialog before sending)', async () => {
    let listener: ((b: Uint8Array) => void) | null = null;
    const link: Link = {
      async write(b) {
        await new Promise((r) => setTimeout(r, 80)); // longer than the 30 ms timeout
        queueMicrotask(() => listener?.(respond(b)));
      },
      onData(cb) {
        listener = cb;
        return () => (listener = null);
      },
    };
    const c = new RcspClient(link, {}, { timeoutMs: 30 });
    c.start();
    await expect(c.request(Op.SetSysInfo, Uint8Array.of(0xff))).resolves.toBeTruthy();
  });

  it('reports round-trip time from write completion', async () => {
    const rtts: (number | undefined)[] = [];
    let listener: ((b: Uint8Array) => void) | null = null;
    const link: Link = {
      async write(b) {
        setTimeout(() => listener?.(respond(b)), 5);
      },
      onData(cb) {
        listener = cb;
        return () => (listener = null);
      },
    };
    const c = new RcspClient(link, { onFrame: (_f, _m, rtt) => rtts.push(rtt) });
    c.start();
    await c.request(Op.GetTargetInfo, Payload.targetInfoAll());
    expect(rtts.length).toBe(1);
    expect(rtts[0]).toBeGreaterThanOrEqual(0);
  });

  it('rejects on a non-zero status', async () => {
    const { link } = fakeLink((b) => [respond(b, 1)]);
    const c = new RcspClient(link);
    c.start();
    await expect(c.request(Op.Function, Uint8Array.of(0xff, 3))).rejects.toThrow(RcspStatusError);
  });

  it('acks a device push that asks for a reply (seen: AA 02 21 01 55)', async () => {
    const { link, written, deliver } = fakeLink();
    const pushes: number[] = [];
    const c = new RcspClient(link, { onPush: (f) => pushes.push(f.sn) });
    c.start();
    deliver(fromHex('fe dc ba c0 ff 00 06 01 aa 02 21 01 55 ef'));
    await Promise.resolve();
    expect(pushes).toEqual([1]);
    expect(toHex(written[0]!)).toBe('fe dc ba 00 ff 00 02 00 01 ef');
  });

  it('does not ack when auto-ack is off or no reply is wanted', async () => {
    const { link, written, deliver } = fakeLink();
    const c = new RcspClient(link, {}, { autoAck: false });
    c.start();
    deliver(fromHex('fe dc ba c0 ff 00 06 01 aa 02 21 01 55 ef'));
    c.autoAck = true;
    deliver(fromHex('fe dc ba 80 ff 00 06 02 aa 02 21 01 55 ef'));
    await Promise.resolve();
    expect(written.length).toBe(0);
  });

  it('builds the ack from the frame', () => {
    const f = decodeFrame(fromHex('fe dc ba c0 ff 00 06 07 aa 02 21 00 55 ef'))!;
    expect(toHex(ackFor(f))).toBe('fe dc ba 00 ff 00 02 00 07 ef');
  });
});
