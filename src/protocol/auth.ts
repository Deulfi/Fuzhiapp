/**
 * Jieli RCSP link authentication (docs/PROTOCOL.md §4, [V]).
 *
 * The cipher is Bluetooth legacy-authentication function E1 (SAFER+), as published in
 * the Bluetooth Core Specification, Vol 2, Part H. Ported from the project's own
 * reference implementation `jl_auth.py`. Pure functions, no I/O.
 */

const EXP: number[] = [];
const LOG: number[] = new Array<number>(256).fill(0);
{
  let v = 1;
  for (let i = 0; i < 256; i++) {
    EXP.push(v % 256); // 45^i mod 257; the value 256 (i = 128) maps to 0
    v = (v * 45) % 257;
  }
  EXP.forEach((val, i) => {
    LOG[val] = i;
  });
}

const at = (a: ArrayLike<number>, i: number): number => a[i] as number;

/** Byte positions that are XORed in the first key mix and added in the second. */
const XOR_POS = new Set([0, 3, 4, 7, 8, 11, 12, 15]);
/** Permutation applied between the PHT layers ("Armenian shuffle"). */
const SHUFFLE = [8, 11, 12, 15, 2, 1, 6, 5, 10, 9, 14, 13, 0, 7, 4, 3];

const rotl8 = (b: number, n: number): number => ((b << n) | (b >>> (8 - n))) & 0xff;

function keySchedule(key: Uint8Array): number[][] {
  let k = [...key, 0];
  k[16] = key.reduce((acc, b) => acc ^ b, 0);
  const subkeys: number[][] = [[...key]];
  for (let p = 2; p <= 17; p++) {
    k = k.map((b) => rotl8(b, 3));
    const sk: number[] = [];
    for (let i = 0; i < 16; i++) {
      const bias = at(EXP, at(EXP, (17 * p + i + 1) & 0xff));
      sk.push((at(k, (p - 1 + i) % 17) + bias) & 0xff);
    }
    subkeys.push(sk);
  }
  return subkeys;
}

/** First mix: XOR at XOR_POS, add elsewhere. */
const keyMix1 = (x: number[], k: ArrayLike<number>): number[] =>
  x.map((v, i) => (XOR_POS.has(i) ? v ^ at(k, i) : (v + at(k, i)) & 0xff));

/** Second mix: add at XOR_POS, XOR elsewhere. */
const keyMix2 = (x: number[], k: ArrayLike<number>): number[] =>
  x.map((v, i) => (XOR_POS.has(i) ? (v + at(k, i)) & 0xff : v ^ at(k, i)));

function phtLayer(x: number[]): number[] {
  const y = [...x];
  for (let i = 0; i < 16; i += 2) {
    const a = at(x, i);
    const b = at(x, i + 1);
    y[i] = (2 * a + b) & 0xff;
    y[i + 1] = (a + b) & 0xff;
  }
  return y;
}

function linear(x: number[]): number[] {
  for (let r = 0; r < 3; r++) {
    const p = phtLayer(x);
    x = SHUFFLE.map((s) => at(p, s));
  }
  return phtLayer(x);
}

function round(x: number[], k1: number[], k2: number[]): number[] {
  x = keyMix1(x, k1);
  x = x.map((v, i) => (XOR_POS.has(i) ? at(EXP, v) : at(LOG, v)));
  x = keyMix2(x, k2);
  return linear(x);
}

/** SAFER+ encryption (Ar), or the modified Ar' when `prime` is true. */
function saferPlus(key: Uint8Array, data: Uint8Array, prime: boolean): Uint8Array {
  const sk = keySchedule(key);
  let x = [...data];
  for (let r = 1; r <= 8; r++) {
    if (prime && r === 3) {
      // Ar': the original input is mixed into the round-3 input.
      x = keyMix1(x, data);
    }
    x = round(x, sk[2 * r - 2]!, sk[2 * r - 1]!);
  }
  return Uint8Array.from(keyMix1(x, sk[16]!));
}

/** Offset key K~ from the Core spec. */
function offsetKey(k: Uint8Array): Uint8Array {
  const c = [233, 229, 223, 193, 179, 167, 149, 131];
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    const add = i < 8 ? i % 2 === 0 : i % 2 === 1;
    const ci = at(c, i % 8);
    out[i] = add ? (at(k, i) + ci) & 0xff : at(k, i) ^ ci;
  }
  return out;
}

/** Bluetooth E1, returning the full 16-byte SAFER+ output (not truncated). */
export function e1(key: Uint8Array, rand: Uint8Array, addr6: Uint8Array): Uint8Array {
  if (key.length !== 16 || rand.length !== 16 || addr6.length !== 6) {
    throw new RangeError('e1: key and rand must be 16 bytes, addr 6 bytes');
  }
  const t = saferPlus(key, rand, false);
  const mixed = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    mixed[i] = (at(addr6, i % 6) + (at(t, i) ^ at(rand, i))) & 0xff;
  }
  return saferPlus(offsetKey(key), mixed, true);
}

export const DEFAULT_LINK_KEY = Uint8Array.from([
  0x06, 0x77, 0x5f, 0x87, 0x91, 0x8d, 0xd4, 0x23, 0x00, 0x5d, 0xf1, 0xd8, 0xcf, 0x0c, 0x14, 0x2b,
]);
export const FIXED_ADDR = Uint8Array.from([0x11, 0x22, 0x33, 0x33, 0x22, 0x11]);

/** Auth message type bytes (first byte of each raw, unframed auth message). */
export const AuthMsg = { Challenge: 0x00, Response: 0x01, Result: 0x02 } as const;
/** `02 'p' 'a' 's' 's'`: the peer was accepted. */
export const AUTH_PASS = Uint8Array.from([0x02, 0x70, 0x61, 0x73, 0x73]);

/** The 17-byte reply to a challenge: 0x01 followed by E1 output. */
export function authResponse(challenge16: Uint8Array, key: Uint8Array = DEFAULT_LINK_KEY): Uint8Array {
  const out = new Uint8Array(17);
  out[0] = AuthMsg.Response;
  out.set(e1(key, challenge16, FIXED_ADDR), 1);
  return out;
}

/** The 17-byte challenge message: 0x00 followed by 16 random bytes. */
export function authChallenge(random16: Uint8Array): Uint8Array {
  if (random16.length !== 16) throw new RangeError('authChallenge: need 16 random bytes');
  const out = new Uint8Array(17);
  out[0] = AuthMsg.Challenge;
  out.set(random16, 1);
  return out;
}
