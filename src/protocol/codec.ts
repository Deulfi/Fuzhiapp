/**
 * RCSP frame decoding and stream reassembly (docs/PROTOCOL.md §3).
 *
 * Notifications are a byte stream: a frame may span several notifications, and one
 * notification may carry several frames. `FrameReassembler` turns that stream back into frames,
 * discarding bytes that don't belong to a valid frame.
 */
import { EOF, FLAG_COMMAND, FLAG_EXPECT_RESPONSE, HEADER_LEN } from './frame';

export interface Frame {
  flags: number;
  opcode: number;
  /** flags bit 7: a command (or device notification) rather than a response */
  isCommand: boolean;
  /** flags bit 6: the sender wants a reply */
  expectsResponse: boolean;
  sn: number;
  /** responses only */
  status?: number;
  /** opcode-specific payload (after sn, or after status+sn for responses) */
  payload: Uint8Array;
  /** the complete frame bytes */
  raw: Uint8Array;
}

/** Interpret one complete frame. Returns null if the params are too short for the frame kind. */
export function decodeFrame(raw: Uint8Array): Frame | null {
  if (raw.length < HEADER_LEN + 1) return null;
  const flags = raw[3]!;
  const opcode = raw[4]!;
  const params = raw.subarray(HEADER_LEN, raw.length - 1);
  const isCommand = (flags & FLAG_COMMAND) !== 0;
  const expectsResponse = (flags & FLAG_EXPECT_RESPONSE) !== 0;
  if (isCommand) {
    if (params.length < 1) return null;
    return { flags, opcode, isCommand, expectsResponse, sn: params[0]!, payload: params.slice(1), raw };
  }
  if (params.length < 2) return null;
  return { flags, opcode, isCommand, expectsResponse, status: params[0]!, sn: params[1]!, payload: params.slice(2), raw };
}

export interface ReassemblerEvents {
  /** bytes thrown away while searching for a frame start or after a bad frame */
  onDiscard?(bytes: Uint8Array): void;
}

export class FrameReassembler {
  private buf = new Uint8Array(0);

  /** Largest paramLen accepted; anything bigger is treated as a false frame start. */
  constructor(private maxParamLen = 2048, private ev: ReassemblerEvents = {}) {}

  get pending(): number {
    return this.buf.length;
  }

  reset(): void {
    this.buf = new Uint8Array(0);
  }

  /** Feed bytes; returns every frame completed by them, in order. */
  push(chunk: Uint8Array): Frame[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    const out: Frame[] = [];
    for (;;) {
      const start = findSof(this.buf);
      if (start < 0) {
        // Keep a possible partial SOF at the end (FE or FE DC).
        const keep = partialSofTail(this.buf);
        this.discard(this.buf.subarray(0, this.buf.length - keep));
        this.buf = this.buf.slice(this.buf.length - keep);
        return out;
      }
      if (start > 0) {
        this.discard(this.buf.subarray(0, start));
        this.buf = this.buf.slice(start);
      }
      if (this.buf.length < HEADER_LEN) return out;
      const len = (this.buf[5]! << 8) | this.buf[6]!;
      if (len > this.maxParamLen) {
        this.skipOne();
        continue;
      }
      const total = HEADER_LEN + len + 1;
      if (this.buf.length < total) return out;
      const raw = this.buf.slice(0, total);
      const frame = raw[total - 1] === EOF ? decodeFrame(raw) : null;
      if (!frame) {
        // Bad EOF or too-short params: this SOF was not a real frame start.
        this.skipOne();
        continue;
      }
      out.push(frame);
      this.buf = this.buf.slice(total);
    }
  }

  private skipOne() {
    this.discard(this.buf.subarray(0, 1));
    this.buf = this.buf.slice(1);
  }

  private discard(b: Uint8Array) {
    if (b.length) this.ev.onDiscard?.(b.slice());
  }
}

function findSof(b: Uint8Array): number {
  for (let i = 0; i + 2 < b.length; i++) {
    if (b[i] === 0xfe && b[i + 1] === 0xdc && b[i + 2] === 0xba) return i;
  }
  return -1;
}

function partialSofTail(b: Uint8Array): number {
  const n = b.length;
  if (n >= 2 && b[n - 2] === 0xfe && b[n - 1] === 0xdc) return 2;
  if (n >= 1 && b[n - 1] === 0xfe) return 1;
  return 0;
}
