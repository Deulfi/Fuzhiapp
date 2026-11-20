import { describe, expect, it } from 'vitest';
import { decodeFrame } from '../src/protocol/codec';
import { fromHex } from '../src/protocol/hex';
import { applyPush, applySysInfo, gainSteps, sourceFromPush, wantsAux } from '../src/app/state';

const push = (hex: string) => decodeFrame(fromHex(hex))!;

describe('app state from amp frames (captured on the ZK-502MT)', () => {
  it('reads a GetSysInfo reply', () => {
    const f = push(
      'fe dc ba 00 07 00 3a 00 01 ff 02 00 32 02 01 1c 12 02 10 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 0c 04 06 08 f8 00 00 00 08 00 00 00 f8 0d 05 4d 50 31 4d 50 32 4d 50 33 57 41 56 02 06 03 ef',
    );
    const s = applySysInfo({}, f.payload);
    expect(s).toMatchObject({ volume: 28, auxInserted: true, source: 'aux', eq: { mode: 6, gains: [8, -8, 0, 0, 0, 8, 0, 0, 0, -8] } });
  });
  it('follows source pushes, including idle', () => {
    expect(applyPush({}, push('fe dc ba c0 ff 00 06 d5 aa 02 21 01 55 ef')).state.source).toBe('bluetooth');
    expect(applyPush({}, push('fe dc ba c0 ff 00 06 da aa 02 21 03 55 ef')).state.source).toBe('aux');
    expect(sourceFromPush(5)).toBe('idle');
  });
  it('reports an EQ push as an event (used to spot refused EQ writes)', () => {
    const r = applyPush({}, push('fe dc ba 80 09 00 0f 1d ff 0c 04 00 00 00 00 00 00 00 00 00 00 00 ef'));
    expect(r.state.eq).toEqual({ mode: 0, gains: Array(10).fill(0) });
    expect(r.events).toContainEqual({ kind: 'eq', eq: { mode: 0, gains: Array(10).fill(0) } });
  });
  it('tracks the AUX cable and the beep reply', () => {
    const out = applyPush({ auxInserted: true }, push('fe dc ba 80 09 00 15 23 ff 12 02 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ef'));
    expect(out.state.auxInserted).toBe(false);
    expect(applyPush({}, push('fe dc ba 80 ff 00 07 cc aa 03 12 01 03 55 ef')).state.beep).toEqual({ on: true, volume: 3 });
  });
  it('ignores malformed pushes', () => {
    expect(applyPush({ volume: 5 }, push('fe dc ba 80 09 00 03 01 ff 05 ef')).state).toEqual({ volume: 5 });
  });
});

describe('gainSteps', () => {
  it('steps by one in either direction', () => {
    expect(gainSteps(3, 6)).toEqual([4, 5, 6]);
    expect(gainSteps(6, 3)).toEqual([5, 4, 3]);
    expect(gainSteps(4, 4)).toEqual([]);
  });
});

describe('wantsAux (AUX priority)', () => {
  it('wants AUX when on Bluetooth or idle with a cable in', () => {
    expect(wantsAux({ source: 'bluetooth', auxInserted: true, a2dp: true })).toBe(true);
    expect(wantsAux({ source: 'idle', auxInserted: true })).toBe(true);
  });
  it('does nothing without a cable or when already on AUX', () => {
    expect(wantsAux({ source: 'bluetooth', auxInserted: false })).toBe(false);
    expect(wantsAux({ source: 'aux', auxInserted: true })).toBe(false);
  });
});

describe('timing settings', () => {
  it('clamps values and falls back to defaults', async () => {
    const { clampTiming, DEFAULT_TIMING } = await import('../src/app/timing');
    expect(clampTiming({})).toEqual(DEFAULT_TIMING);
    const t = clampTiming({ priorityGapMs: 10, gainStepMs: '300', pollMs: 'x', priorityMaxPerMinute: 999 });
    expect(t.priorityGapMs).toBe(500);
    expect(t.gainStepMs).toBe(300);
    expect(t.pollMs).toBe(DEFAULT_TIMING.pollMs);
    expect(t.priorityMaxPerMinute).toBe(30);
  });
});
