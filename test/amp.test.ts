import { describe, expect, it } from 'vitest';
import { Amp } from '../src/app/amp';

// No link at all: any command that would be sent throws "Not connected", so resolving proves nothing was sent.
const idleAmp = () => {
  const a = new Amp({ onChange: () => {}, onMessage: () => {} });
  a.status = 'connected';
  return a;
};

describe('Amp skips changes that would do nothing', () => {
  it('does not re-select the current source (that pauses playback)', async () => {
    const a = idleAmp();
    a.state = { source: 'aux', auxInserted: true, a2dp: true };
    await expect(a.setSource('aux', true)).resolves.toBeUndefined();
    await expect(a.setSource('bluetooth', false)).rejects.toThrow('Not connected');
  });
  it('does not resend the same EQ preset or user curve', async () => {
    const a = idleAmp();
    a.state = { eq: { mode: 6, gains: [1, 2, 3, 0, 0, 0, 0, 0, 0, 0] } };
    await expect(a.setEq(6, [1, 2, 3, 0, 0, 0, 0, 0, 0, 0])).resolves.toBeUndefined();
    await expect(a.setEq(6, [1, 2, 4, 0, 0, 0, 0, 0, 0, 0])).rejects.toThrow('Not connected');
  });
  it('does not step gain to the value it already has', async () => {
    const a = idleAmp();
    a.state = { volume: 12 };
    await expect(a.setGain(12)).resolves.toBeUndefined();
  });
});

describe('AUX priority', () => {
  const tried = (a: Amp) => a.activity.some((x) => x.text.startsWith('AUX priority: back to AUX'));
  it('switches back to AUX when Bluetooth takes over and a cable is in', async () => {
    const a = idleAmp();
    a.auxPriority = true;
    a.state = { source: 'bluetooth', auxInserted: true };
    await a.enforcePriority('test');
    expect(tried(a)).toBe(true);
  });
  it('does nothing when off, without a cable, already on AUX, or paused by the user', async () => {
    for (const setup of [
      (a: Amp) => (a.state = { source: 'bluetooth', auxInserted: true }),
      (a: Amp) => ((a.auxPriority = true), (a.state = { source: 'bluetooth', auxInserted: false })),
      (a: Amp) => ((a.auxPriority = true), (a.state = { source: 'aux', auxInserted: true })),
      (a: Amp) => ((a.auxPriority = true), (a.prioritySuspended = true), (a.state = { source: 'bluetooth', auxInserted: true })),
    ]) {
      const a = idleAmp();
      setup(a);
      await a.enforcePriority('test');
      expect(tried(a)).toBe(false);
    }
  });
  it('never tries twice within 2 s (no fast loop)', async () => {
    const a = idleAmp();
    a.auxPriority = true;
    a.state = { source: 'bluetooth', auxInserted: true };
    await a.enforcePriority('1');
    await a.enforcePriority('2');
    expect(a.activity.filter((x) => x.text.startsWith('AUX priority: back to AUX'))).toHaveLength(1);
  });
});

describe('AUX priority leaves the phone connected', () => {
  it('only switches the source, even with "disconnect the phone" on', async () => {
    const a = idleAmp();
    a.auxPriority = true;
    a.dropPhoneOnAux = true;
    a.state = { source: 'bluetooth', auxInserted: true, a2dp: true };
    await a.enforcePriority('test');
    expect(a.activity.some((x) => x.text.includes('Disconnected the phone'))).toBe(false);
    expect(a.activity.some((x) => x.text.startsWith('AUX priority: back to AUX'))).toBe(true);
  });
});
