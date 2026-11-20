/**
 * RCSP client on top of a `Link` (after the auth handshake).
 * - assigns sequence numbers (1 byte, wraps)
 * - matches replies to requests by (opcode, sn), with a timeout (spec default 2 s)
 * - acknowledges device-initiated commands that ask for a reply (D6). The ack is a bare
 *   response: flags 0x00, same opcode, params [status 0][device sn]. Whether the amp wants more
 *   than that is [I].
 */
import { FrameReassembler, type Frame } from './codec';
import { encodeCommand, encodeRaw } from './frame';
import type { Link } from './handshake';

export class RcspTimeoutError extends Error {}
export class RcspStatusError extends Error {
  constructor(readonly frame: Frame) {
    super(`device returned status 0x${frame.status!.toString(16)} for opcode 0x${frame.opcode.toString(16)}`);
  }
}

export interface ClientEvents {
  /** every decoded frame from the device. `rttMs`: time from write done to reply, if matched */
  onFrame?(f: Frame, matched: boolean, rttMs?: number): void;
  /** device-initiated commands (pushes) */
  onPush?(f: Frame): void;
  onDiscard?(bytes: Uint8Array): void;
  onError?(e: unknown): void;
}

export interface ClientOptions {
  timeoutMs?: number;
  autoAck?: boolean;
}

interface Pending {
  resolve(f: Frame): void;
  reject(e: unknown): void;
  /** Started only once the write has completed, so time spent before sending (e.g. a
   * confirmation dialog in the guard) can't cause a false timeout. */
  timer: ReturnType<typeof setTimeout> | null;
  sentAt: number | null;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function ackFor(f: Frame): Uint8Array {
  return encodeRaw(0x00, f.opcode, Uint8Array.of(0x00, f.sn));
}

export class RcspClient {
  private sn = 0;
  private pending = new Map<string, Pending>();
  private reassembler: FrameReassembler;
  private unsubscribe: (() => void) | null = null;
  timeoutMs: number;
  autoAck: boolean;

  constructor(private link: Link, private ev: ClientEvents = {}, opts: ClientOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.autoAck = opts.autoAck ?? true;
    this.reassembler = new FrameReassembler(2048, { onDiscard: (b) => ev.onDiscard?.(b) });
  }

  start(): void {
    if (this.unsubscribe) return;
    this.reassembler.reset();
    this.unsubscribe = this.link.onData((b) => {
      for (const f of this.reassembler.push(b)) this.dispatch(f);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const [k, p] of [...this.pending]) this.settle(k, p)?.reject(new Error('client stopped'));
  }

  /** The sn the next command will use. */
  get nextSn(): number {
    return this.sn;
  }

  private takeSn(): number {
    const s = this.sn;
    this.sn = (this.sn + 1) & 0xff;
    return s;
  }

  /** Send a command that expects a reply; resolves with the reply frame (status 0). */
  async request(opcode: number, payload: Uint8Array = new Uint8Array(), timeoutMs = this.timeoutMs): Promise<Frame> {
    const sn = this.takeSn();
    const key = `${opcode}:${sn}`;
    let entry!: Pending;
    const reply = new Promise<Frame>((resolve, reject) => {
      entry = { resolve, reject, timer: null, sentAt: null };
    });
    reply.catch(() => {}); // handled below; avoids an unhandled rejection if the write fails
    const old = this.pending.get(key);
    if (old) this.settle(key, old)?.reject(new Error('superseded by a newer request with the same sn'));
    // Registered before the write so a very fast reply can't be missed.
    this.pending.set(key, entry);
    try {
      await this.link.write(encodeCommand(opcode, sn, payload, true));
    } catch (e) {
      if (this.pending.get(key) === entry) this.settle(key, entry);
      throw e;
    }
    if (this.pending.get(key) === entry) {
      entry.sentAt = now();
      entry.timer = setTimeout(() => {
        this.settle(key, entry)?.reject(
          new RcspTimeoutError(`no reply to opcode 0x${opcode.toString(16)} sn ${sn} within ${timeoutMs} ms`),
        );
      }, timeoutMs);
    }
    const f = await reply;
    if (f.status !== 0) throw new RcspStatusError(f);
    return f;
  }

  /** Remove a pending entry and stop its timer; returns it for resolving/rejecting. */
  private settle(key: string, p: Pending): Pending | null {
    if (this.pending.get(key) !== p) return null;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(key);
    return p;
  }

  /** Send a command without waiting for (or asking for) a reply. */
  async send(opcode: number, payload: Uint8Array = new Uint8Array()): Promise<void> {
    await this.link.write(encodeCommand(opcode, this.takeSn(), payload, false));
  }

  private dispatch(f: Frame) {
    if (!f.isCommand) {
      const key = `${f.opcode}:${f.sn}`;
      const p = this.pending.get(key);
      const rtt = p?.sentAt != null ? Math.round(now() - p.sentAt) : undefined;
      this.ev.onFrame?.(f, !!p, rtt);
      if (p) this.settle(key, p)?.resolve(f);
      return;
    }
    this.ev.onFrame?.(f, false);
    this.ev.onPush?.(f);
    if (f.expectsResponse && this.autoAck) {
      this.link.write(ackFor(f)).catch((e) => this.ev.onError?.(e));
    }
  }
}
