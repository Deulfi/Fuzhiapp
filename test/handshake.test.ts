import { describe, expect, it } from 'vitest';
import { AUTH_PASS, authChallenge, authResponse } from '../src/protocol/auth';
import { HandshakeError, runHandshake, type Link } from '../src/protocol/handshake';

/** A simulated amp that follows docs/PROTOCOL.md §4. */
function fakeAmp(opts: { challengeFirst?: boolean; badResponse?: boolean; silentAfterPass?: boolean } = {}) {
  let listener: ((b: Uint8Array) => void) | null = null;
  const sent: Uint8Array[] = [];
  const devRand = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i);
  let gotHostPass = false;
  const emit = (b: Uint8Array) => queueMicrotask(() => listener?.(b));
  const link: Link = {
    async write(b) {
      sent.push(b);
      if (b.length === 17 && b[0] === 0x00) {
        const r = authResponse(b.subarray(1));
        if (opts.badResponse) r[5] = r[5]! ^ 1;
        if (opts.challengeFirst) emit(authChallenge(devRand));
        emit(r);
      } else if (b.length === 5 && b.every((v, i) => v === AUTH_PASS[i])) {
        gotHostPass = true;
        if (!opts.challengeFirst && !opts.silentAfterPass) emit(authChallenge(devRand));
      } else if (b.length === 17 && b[0] === 0x01) {
        const ok = b.every((v, i) => v === authResponse(devRand)[i]);
        if (ok && gotHostPass) emit(AUTH_PASS);
      }
    },
    onData(cb) {
      listener = cb;
      return () => (listener = null);
    },
  };
  return { link, sent };
}

const rnd = () => Uint8Array.from({ length: 16 }, (_, i) => i * 7);
const noop = () => {};

describe('runHandshake', () => {
  it('completes all five steps', async () => {
    const amp = fakeAmp();
    await runHandshake(amp.link, { random16: rnd, log: noop });
    expect(amp.sent.map((b) => b[0])).toEqual([0x00, 0x02, 0x01]);
  });
  it('tolerates the device sending its challenge before its response', async () => {
    await runHandshake(fakeAmp({ challengeFirst: true }).link, { random16: rnd, log: noop });
  });
  it('rejects a wrong device response', async () => {
    await expect(runHandshake(fakeAmp({ badResponse: true }).link, { random16: rnd, log: noop })).rejects.toThrow(HandshakeError);
  });
  it('times out if the device never challenges back', async () => {
    const p = runHandshake(fakeAmp({ silentAfterPass: true }).link, { random16: rnd, log: noop, stepTimeoutMs: 50 });
    await expect(p).rejects.toThrow(/step 4/);
  });
  it('can stop after step 3', async () => {
    const amp = fakeAmp({ silentAfterPass: true });
    await runHandshake(amp.link, { random16: rnd, log: noop, answerDeviceChallenge: false });
    expect(amp.sent.length).toBe(2);
  });
});
