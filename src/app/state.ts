/**
 * The app's view of the amp, updated only from what the amp reports (replies and pushes).
 * Pure functions: easy to test against captured frames.
 */
import { Op } from '../protocol/frame';
import type { Frame } from '../protocol/codec';
import { parseSysInfo, parseTargetInfo, FunctionId, type PublicSysInfo } from '../protocol/info';
import { splitWuzhi, WuzhiCmd } from '../protocol/wuzhi';

export type Source = 'bluetooth' | 'aux' | 'idle' | 'other';

export interface Eq {
  mode: number;
  gains: number[];
}

export interface AmpState {
  volume?: number;
  /** what the amp reports as its max (30 on the ZK-502MT); shown, not enforced */
  reportedMax?: number;
  source?: Source;
  auxInserted?: boolean;
  /** classic BT audio link connected (target info type 2) */
  a2dp?: boolean;
  eq?: Eq;
  beep?: { on: boolean; volume: number };
  /** function ids the amp claims to support (over-reports Music on this board) */
  functions?: number[];
}

/** Function id (SysInfo attr 6, target info type 4) → source. */
export function sourceFromFunction(fn: number): Source {
  if (fn === FunctionId.Bluetooth) return 'bluetooth';
  if (fn === FunctionId.Aux) return 'aux';
  return 'other';
}

/** Wuzhi source push `AA 02 21 xx 55` [obs]: 01 BT, 03 AUX, 05 idle. */
export function sourceFromPush(v: number): Source {
  return v === 1 ? 'bluetooth' : v === 3 ? 'aux' : v === 5 ? 'idle' : 'other';
}

function applyPublic(s: AmpState, p: PublicSysInfo): AmpState {
  const out = { ...s };
  if (p.volume !== undefined) out.volume = p.volume;
  if (p.auxInserted !== undefined) out.auxInserted = p.auxInserted;
  if (p.eq) out.eq = { mode: p.eq.mode, gains: [...p.eq.gains] };
  if (p.currentFunction !== undefined) out.source = sourceFromFunction(p.currentFunction);
  return out;
}

export function applyTargetInfo(s: AmpState, payload: Uint8Array): AmpState {
  const t = parseTargetInfo(payload);
  const out = { ...s };
  if (t.power) {
    out.volume = t.power.volume;
    out.reportedMax = t.power.maxVolume;
  }
  if (t.edr) out.a2dp = t.edr.status === 1;
  if (t.currentFunction !== undefined) out.source = sourceFromFunction(t.currentFunction);
  if (t.functionMask !== undefined) {
    const fns: number[] = [];
    for (let i = 0; i < 32; i++) if (t.functionMask & (1 << i)) fns.push(i);
    out.functions = fns;
  }
  return out;
}

export function applySysInfo(s: AmpState, payload: Uint8Array): AmpState {
  const info = parseSysInfo(payload);
  if (info.pub) return applyPublic(s, info.pub);
  // `03 02 00 01` after switching to AUX: function-specific info, only the function is useful
  return { ...s, source: sourceFromFunction(info.function) };
}

/** What a frame from the amp means for the app, besides state. */
export type Event =
  | { kind: 'eq'; eq: Eq }
  | { kind: 'source'; source: Source }
  | { kind: 'wuzhi'; cmd: number; data: Uint8Array };

/** Apply a device push (opcode 0x09 or 0xFF). Returns the new state and what happened. */
export function applyPush(s: AmpState, f: Frame): { state: AmpState; events: Event[] } {
  const events: Event[] = [];
  let state = s;
  try {
    if (f.opcode === Op.SysInfoPush) {
      state = applySysInfo(s, f.payload);
      if (state.eq && state.eq !== s.eq) events.push({ kind: 'eq', eq: state.eq });
      if (state.source !== s.source && state.source) events.push({ kind: 'source', source: state.source });
    } else if (f.opcode === Op.Custom) {
      const w = splitWuzhi(f.payload, false);
      if (w) {
        events.push({ kind: 'wuzhi', cmd: w.cmd, data: w.data });
        if (w.cmd === WuzhiCmd.SourcePush && w.data.length === 1) {
          const source = sourceFromPush(w.data[0]!);
          state = { ...s, source };
          events.push({ kind: 'source', source });
        }
        if (w.cmd === WuzhiCmd.BeepRead && w.data.length === 2) {
          state = { ...s, beep: { on: w.data[0] === 1, volume: w.data[1]! } };
        }
      }
    }
  } catch {
    /* malformed push: ignore, state unchanged */
  }
  return { state, events };
}

/** The gain values to send, one step at a time, from → to (excluding `from`). */
export function gainSteps(from: number, to: number): number[] {
  const out: number[] = [];
  const d = Math.sign(to - from);
  for (let v = from + d; d !== 0 && v !== to + d; v += d) out.push(v);
  return out;
}

/**
 * Should AUX priority switch back to AUX now? Needs an AUX cable and the amp on Bluetooth or idle.
 * Priority only changes the source: the phone stays connected for audio (user decision).
 */
export function wantsAux(s: AmpState): boolean {
  return !!s.auxInserted && (s.source === 'bluetooth' || s.source === 'idle');
}
