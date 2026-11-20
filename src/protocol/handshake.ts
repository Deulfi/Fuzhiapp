/**
 * Auth handshake state machine (docs/PROTOCOL.md §4). Transport-agnostic: give it a `Link`.
 *
 *   1. host → dev   00 || R_host
 *   2. dev  → host  01 || E1(R_host)      host verifies
 *   3. host → dev   02 "pass"
 *   4. dev  → host  00 || R_dev           host answers 01 || E1(R_dev)
 *   5. dev  → host  02 "pass"             authenticated
 *
 * Steps 4–5 [I]: whether the amp requires them is open question T4. Incoming messages are
 * matched by type, so the order of the device's messages does not matter.
 */
import { AUTH_PASS, AuthMsg, DEFAULT_LINK_KEY, FIXED_ADDR, authChallenge, authResponse, e1 } from './auth';
import { toHex } from './hex';

export interface Link {
  write(bytes: Uint8Array): Promise<void>;
  /** Subscribe to incoming notifications. Returns an unsubscribe function. */
  onData(cb: (bytes: Uint8Array) => void): () => void;
}

export interface HandshakeOptions {
  random16: () => Uint8Array;
  log: (msg: string) => void;
  stepTimeoutMs?: number;
  /** Complete steps 4–5. Default true (what the vendor app does). */
  answerDeviceChallenge?: boolean;
  key?: Uint8Array;
}

export class HandshakeError extends Error {}

const isPass = (b: Uint8Array) => b.length === AUTH_PASS.length && b.every((v, i) => v === AUTH_PASS[i]);
const isType = (t: number) => (b: Uint8Array) => b.length === 17 && b[0] === t;

class Inbox {
  private items: Uint8Array[] = [];
  private waiter: (() => void) | null = null;
  push(b: Uint8Array) {
    this.items.push(b);
    this.waiter?.();
  }
  async take(match: (b: Uint8Array) => boolean, timeoutMs: number, what: string): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.items.findIndex(match);
      if (i >= 0) return this.items.splice(i, 1)[0]!;
      const left = deadline - Date.now();
      if (left <= 0) throw new HandshakeError(`timeout waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiter = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.waiter = null;
    }
  }
}

export async function runHandshake(link: Link, opts: HandshakeOptions): Promise<void> {
  const timeout = opts.stepTimeoutMs ?? 2000;
  const key = opts.key ?? DEFAULT_LINK_KEY;
  const inbox = new Inbox();
  const unsubscribe = link.onData((b) => inbox.push(b));
  try {
    const rHost = opts.random16();
    opts.log(`auth 1: send challenge`);
    await link.write(authChallenge(rHost));

    const devResp = await inbox.take(isType(AuthMsg.Response), timeout, 'device response (step 2)');
    const expected = e1(key, rHost, FIXED_ADDR);
    const got = devResp.subarray(1);
    if (!got.every((v, i) => v === expected[i])) {
      throw new HandshakeError(`device response mismatch: got ${toHex(got)}, expected ${toHex(expected)}`);
    }
    opts.log('auth 2: device response verified');

    opts.log('auth 3: send pass');
    await link.write(AUTH_PASS);

    if (opts.answerDeviceChallenge === false) {
      opts.log('auth: skipping steps 4–5 (option off)');
      return;
    }
    const devChallenge = await inbox.take(isType(AuthMsg.Challenge), timeout, 'device challenge (step 4)');
    opts.log('auth 4: answer device challenge');
    await link.write(authResponse(devChallenge.subarray(1), key));

    await inbox.take(isPass, timeout, 'device pass (step 5)');
    opts.log('auth 5: device says pass — authenticated');
  } finally {
    unsubscribe();
  }
}
