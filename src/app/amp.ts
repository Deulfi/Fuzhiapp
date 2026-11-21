/**
 * Amp controller: connection, auth, live state and the commands the app uses.
 * Everything here is confirmed on a ZK-502MT (see docs/OPEN_QUESTIONS.md) unless marked.
 */
import { BLUETOOTH_OFF, bluetoothAvailable, bluetoothState, BleTransport, knownDevice, pickDevice, rememberDevice } from '../ble/transport';
import { RcspClient } from '../protocol/client';
import { concat, Op, Payload, tlv } from '../protocol/frame';
import { runHandshake } from '../protocol/handshake';
import { EQ_NAMES, FunctionId } from '../protocol/info';
import { checkOutgoing } from '../protocol/safety';
import { beepSet, btNameFrame, wuzhiRead, WuzhiCmd } from '../protocol/wuzhi';
import { loadTiming, type Timing } from './timing';
import { applyPush, applySysInfo, applyTargetInfo, gainSteps, wantsAux, type AmpState, type Eq, type Source } from './state';

export const NAME_PREFIXES = ['wuzhi', 'Wuzhi', 'ZK', 'JL'];
/** User EQ range. The vendor app offers ±12 dB (its EQ readback is dB + 12, §12.4); ±8 is tested on the amp, ±12 not yet [I]. */
export const EQ_GAIN_LIMIT = 12;
/** How often to re-read target info, to notice a phone connecting or leaving (nothing is pushed for that on AUX). */

export type Status = 'disconnected' | 'connecting' | 'connected';

export interface ActivityEntry {
  time: Date;
  text: string;
  kind: 'info' | 'error';
}

export interface AmpEvents {
  onChange(): void;
  onMessage(text: string, kind?: 'info' | 'error'): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SOURCE_NAMES: Record<Source, string> = { bluetooth: 'Bluetooth', aux: 'AUX', idle: 'idle (no source)', other: 'another source' };
const sameEq = (a: Eq | undefined, b: Eq) => !!a && a.mode === b.mode && (b.mode !== 6 || a.gains.every((g, i) => g === b.gains[i]));

export class Amp {
  status: Status = 'disconnected';
  state: AmpState = {};
  deviceName = '';
  /** Highest gain the app will send. User setting; the guard enforces it. */
  gainLimit = 40;
  /** EQ the user asked for but the amp refused (after power-on, until BT audio played; E1). */
  pendingEq: Eq | null = null;
  gainBusy = false;
  /** Plain-language history for the settings sheet, newest first. */
  activity: ActivityEntry[] = [];
  /** Disconnect the phone's audio when switching to AUX. */
  dropPhoneOnAux = true;
  /**
   * AUX priority: while this app is connected, switch back to AUX whenever the amp moves to
   * Bluetooth or goes idle (and a cable is in). Picking Bluetooth in the app pauses it until AUX is picked again.
   */
  auxPriority = false;
  prioritySuspended = false;
  private priorityTries: number[] = [];
  private priorityRunning = false;
  private priorityGaveUp = false;
  /** True while dropPhone runs: it passes through Bluetooth on purpose, priority must not interfere. */
  private dropping = false;
  private recheckTimer: ReturnType<typeof setTimeout> | null = null;

  private device: BluetoothDevice | null = null;
  private transport: BleTransport | null = null;
  private client: RcspClient | null = null;
  private gainTarget: number | null = null;
  private wuzhiWaiters: { cmd: number; resolve(d: Uint8Array): void }[] = [];
  private eqSentAt = 0;
  private eqSent: Eq | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** Timing knobs (src/app/timing.ts); the logger page can tune them. */
  timing: Timing = loadTiming();

  constructor(private ev: AmpEvents) {}

  static supported(): boolean {
    return bluetoothAvailable();
  }

  log(text: string, kind: 'info' | 'error' = 'info'): void {
    this.activity.unshift({ time: new Date(), text, kind });
    if (this.activity.length > 200) this.activity.length = 200;
    this.changed();
  }

  /** Show the browser's device chooser, then connect. `all` lists every device (when a rename broke the name filter). */
  async choose(all = false): Promise<void> {
    if ((await bluetoothState()) === 'off') throw new Error(BLUETOOTH_OFF);
    this.device = await pickDevice(all ? 'all' : 'name', NAME_PREFIXES);
    await this.connect();
  }

  /** Reconnect without the chooser to the amp used last, if the browser still allows it. */
  async autoConnect(): Promise<boolean> {
    const d = await knownDevice();
    if (!d) return false;
    this.device = d;
    try {
      await this.connect();
      return true;
    } catch {
      return false; // out of range or switched off: the user can press Connect
    }
  }

  /** Connect to the last chosen device again (no chooser). */
  async connect(): Promise<void> {
    if (!this.device) throw new Error('no device chosen');
    if ((await bluetoothState()) === 'off') throw new Error(BLUETOOTH_OFF);
    // A device object kept from an earlier connection can go stale (seen on Android: "no longer
    // in range" until the page was reloaded). The browser's own list hands out a fresh one.
    const fresh = await knownDevice();
    if (fresh && fresh.id === this.device.id) this.device = fresh;
    this.setStatus('connecting');
    this.deviceName = this.device.name ?? 'Amp';
    const t = new BleTransport(this.device, {
      onRx: () => {},
      onTx: () => {},
      onInfo: () => {},
      onDisconnect: () => this.handleDisconnect(),
    });
    t.guard = (bytes) => {
      const v = checkOutgoing(bytes, this.gainLimit);
      if (v.action === 'block') throw new Error(`blocked: ${v.reason}`);
    };
    this.transport = t;
    this.client = new RcspClient(t, { onPush: (f) => this.handlePush(f) });
    try {
      await t.connect();
      await this.authenticate();
      this.client.start();
      await this.refresh();
      rememberDevice(this.device);
      this.setStatus('connected');
      this.log(`Connected to ${this.deviceName}`);
      this.pollTimer = setInterval(() => void this.poll(), this.timing.pollMs);
      // Nothing is sent on connect: AUX priority only reacts to changes (user request).
      this.prioritySuspended = false;
    } catch (e) {
      t.disconnect();
      this.handleDisconnect();
      throw e;
    }
  }

  disconnect(): void {
    this.transport?.disconnect();
  }

  get hasDevice(): boolean {
    return !!this.device;
  }

  private async authenticate(): Promise<void> {
    let last: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await runHandshake(this.transport!, { random16: () => crypto.getRandomValues(new Uint8Array(16)), log: () => {} });
        return;
      } catch (e) {
        last = e;
      }
    }
    throw new Error(`authentication failed: ${last instanceof Error ? last.message : String(last)}`);
  }

  /** Re-read everything the amp reports. */
  async refresh(): Promise<void> {
    await this.readTargetInfo();
    const s = await this.need().request(Op.GetSysInfo, Payload.sysInfoPublicAll());
    this.state = applySysInfo(this.state, s.payload);
    this.changed();
  }

  private async readTargetInfo(): Promise<void> {
    const before = this.state;
    const t = await this.need().request(Op.GetTargetInfo, Payload.targetInfoAll());
    this.state = applyTargetInfo(this.state, t.payload);
    if (before.a2dp !== undefined && before.a2dp !== this.state.a2dp) {
      this.log(this.state.a2dp ? 'A phone or computer connected for audio' : 'Bluetooth audio disconnected');
      if (this.state.a2dp && this.pendingEq) void this.retryEq().catch(() => {});
    }
    this.changed();
  }

  private async poll(): Promise<void> {
    if (this.status !== 'connected' || this.gainBusy) return;
    try {
      await this.readTargetInfo();
    } catch {
      /* a missed poll is harmless */
    }
  }

  // ---------- source ----------
  /**
   * Does nothing if the amp is already on that source (re-selecting it pauses playback).
   * AUX with `dropPhone` while on Bluetooth with a phone connected: only "disconnect classic BT"
   * is sent; the amp then moves to AUX by itself (S8). That command does nothing while on AUX.
   */
  async setSource(source: 'bluetooth' | 'aux', dropPhone = this.dropPhoneOnAux): Promise<void> {
    if (this.state.source === source) return;
    const c = this.need();
    if (source === 'aux') {
      if (!this.state.auxInserted) throw new Error('No AUX cable plugged in.');
      if (dropPhone && this.state.source === 'bluetooth') {
        await this.readTargetInfo(); // a2dp is polled; make sure it's current
        if (this.state.a2dp) {
          this.dropping = true;
          try {
            await c.request(Op.DisconnectClassic, new Uint8Array());
          } finally {
            setTimeout(() => (this.dropping = false), this.timing.dropWaitMs);
          }
          this.log('Disconnected the phone; the amp moves to AUX by itself');
          if (await this.waitForSource('aux', this.timing.dropWaitMs)) return;
          this.log('The amp did not move to AUX after the phone was disconnected; switching directly', 'error');
        }
      }
      await c.request(Op.Function, Uint8Array.of(FunctionId.Public, FunctionId.Aux));
      this.log('Switched to AUX');
    } else {
      await c.request(Op.Function, Uint8Array.of(FunctionId.Public, FunctionId.Bluetooth));
      this.log('Switched to Bluetooth');
    }
  }

  /**
   * Disconnect the phone's (or computer's) Bluetooth audio. BLE control stays connected.
   * The command only works while the amp is on Bluetooth, so from AUX/idle it switches to
   * Bluetooth first; afterwards the amp returns to AUX by itself if a cable is in.
   */
  async dropPhone(): Promise<void> {
    if (this.dropping) return;
    this.dropping = true;
    try {
      await this.dropPhoneNow();
    } finally {
      this.dropping = false;
    }
    void this.enforcePriority('after disconnecting the phone');
  }

  private async dropPhoneNow(): Promise<void> {
    await this.readTargetInfo();
    if (!this.state.a2dp) {
      this.ev.onMessage('No phone or computer is connected for audio.');
      return;
    }
    const c = this.need();
    if (this.state.source !== 'bluetooth') {
      await c.request(Op.Function, Uint8Array.of(FunctionId.Public, FunctionId.Bluetooth));
      await this.waitForSource('bluetooth', 2000);
    }
    await c.request(Op.DisconnectClassic, new Uint8Array());
    for (let i = 0; i < 4 && this.state.a2dp; i++) {
      await sleep(750);
      await this.readTargetInfo();
    }
    if (this.state.a2dp) {
      this.log('Asked the amp to disconnect Bluetooth audio, but it is still connected', 'error');
      this.ev.onMessage('The audio device is still connected.', 'error');
    } else {
      this.log('Disconnected Bluetooth audio');
      this.ev.onMessage('Bluetooth audio disconnected. Reconnect from your phone or computer when you need it.');
    }
  }

  /** Resolve true once the amp reports `source` (via its push), false after `ms`. */
  private async waitForSource(source: Source, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.state.source === source) return true;
      await sleep(100);
    }
    return this.state.source === source;
  }

  /** User's own source choice: Bluetooth pauses AUX priority, AUX resumes it. */
  async pickSource(source: 'bluetooth' | 'aux'): Promise<void> {
    if (this.auxPriority) {
      const was = this.prioritySuspended;
      this.prioritySuspended = source === 'bluetooth';
      if (was !== this.prioritySuspended) this.log(this.prioritySuspended ? 'AUX priority paused (you picked Bluetooth)' : 'AUX priority active again');
    }
    await this.setSource(source);
  }

  /**
   * Switch back to AUX if priority says so. A phone connecting often pulls the amp back to
   * Bluetooth a moment later, so every attempt is followed by a re-check. Limited to
   * `timing.priorityMaxPerMinute` per minute and one try per `timing.priorityGapMs`, so it can never loop fast.
   * `timing.priorityDelayMs` (default 0) waits before the first try.
   */
  async enforcePriority(why: string, delayed = false): Promise<void> {
    if (!this.auxPriority || this.prioritySuspended || this.priorityRunning || this.dropping) return;
    if (!wantsAux(this.state)) return;
    const now = Date.now();
    this.priorityTries = this.priorityTries.filter((t) => now - t < 60_000);
    if (!delayed && this.timing.priorityDelayMs > 0) return this.scheduleRecheck(this.timing.priorityDelayMs);
    if (this.priorityTries.length >= this.timing.priorityMaxPerMinute) {
      if (!this.priorityGaveUp) this.log('AUX priority: giving up for a minute (the amp keeps going back to Bluetooth)', 'error');
      this.priorityGaveUp = true;
      return;
    }
    const wait = this.timing.priorityGapMs - (now - (this.priorityTries.at(-1) ?? 0));
    if (wait > 0) return this.scheduleRecheck(wait);
    this.priorityGaveUp = false;
    this.priorityTries.push(now);
    this.priorityRunning = true;
    this.log(`AUX priority: back to AUX (${why})`);
    try {
      await this.setSource('aux', false); // priority never disconnects the phone
    } catch (e) {
      this.log(`AUX priority could not switch: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      this.priorityRunning = false;
    }
    this.scheduleRecheck(this.timing.priorityRecheckMs);
  }

  private scheduleRecheck(ms: number): void {
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.recheckTimer = setTimeout(async () => {
      this.recheckTimer = null;
      if (this.status !== 'connected') return;
      try {
        await this.readTargetInfo();
      } catch {
        return;
      }
      void this.enforcePriority('still not on AUX', true);
    }, ms);
  }

  // ---------- gain ----------
  /** Move gain toward `target` one step at a time. A new call while running just moves the target. */
  async setGain(target: number): Promise<void> {
    target = Math.max(0, Math.min(Math.round(target), this.gainLimit));
    if (this.gainBusy) {
      this.gainTarget = target;
      return;
    }
    if (this.state.volume === undefined || this.state.volume === target) return;
    const from = this.state.volume;
    this.gainTarget = target;
    this.gainBusy = true;
    try {
      while (this.gainTarget !== null && this.state.volume !== this.gainTarget) {
        const next = gainSteps(this.state.volume!, this.gainTarget)[0]!;
        await this.need().request(Op.SetSysInfo, concat(Uint8Array.of(FunctionId.Public), tlv(1, Uint8Array.of(next))));
        this.state = { ...this.state, volume: next };
        this.changed();
        await sleep(this.timing.gainStepMs);
      }
    } finally {
      this.gainBusy = false;
      this.gainTarget = null;
      this.log(`Gain ${from} → ${this.state.volume}`);
    }
  }

  // ---------- EQ ----------
  /** Preset (mode 0–5): the amp fills in its own curve. User (6): our gains, ±8 dB. Skips if already set. */
  async setEq(mode: number, gains?: number[], force = false): Promise<void> {
    const g = (gains ?? this.state.eq?.gains ?? Array(10).fill(0)).map((v) =>
      Math.max(-EQ_GAIN_LIMIT, Math.min(EQ_GAIN_LIMIT, Math.round(v))),
    );
    const eq: Eq = { mode, gains: g };
    if (!force && sameEq(this.state.eq, eq)) return;
    this.eqSent = eq;
    this.eqSentAt = Date.now();
    const data = Uint8Array.of(mode, ...g.map((v) => v & 0xff));
    await this.need().request(Op.SetSysInfo, concat(Uint8Array.of(FunctionId.Public), tlv(4, data)));
  }

  /** Try a refused EQ again (after BT audio has played). */
  async retryEq(): Promise<void> {
    if (this.pendingEq) await this.setEq(this.pendingEq.mode, this.pendingEq.gains, true);
  }

  // ---------- device settings (§12.2) ----------
  async readBeep(): Promise<void> {
    await this.wuzhiQuery(WuzhiCmd.BeepRead);
  }

  async setBeep(on: boolean, volume: number): Promise<void> {
    if (volume > this.gainLimit) throw new Error(`Beep volume is above your gain limit (${this.gainLimit}).`);
    await this.need().request(Op.Custom, beepSet(on, volume));
    this.state = { ...this.state, beep: { on, volume } };
    this.log(`Beep ${on ? `on, volume ${volume}` : 'off'}`);
  }

  /** The amp restarts by itself after a rename; the link drops (A7). */
  async rename(name: string): Promise<void> {
    await this.need().request(Op.Custom, btNameFrame(name));
    this.log(`Renamed to "${name}"; the amp restarts now`);
    this.restarting = true; // the link drops in a few seconds; handleDisconnect starts reconnecting
    this.changed();
  }

  // ---------- internals ----------
  private async wuzhiQuery(cmd: number, timeoutMs = 1500): Promise<Uint8Array | null> {
    const reply = new Promise<Uint8Array>((resolve) => this.wuzhiWaiters.push({ cmd, resolve }));
    await this.need().request(Op.Custom, wuzhiRead(cmd));
    return Promise.race([reply, sleep(timeoutMs).then(() => null)]);
  }

  private handlePush(f: Parameters<typeof applyPush>[1]): void {
    const before = this.state;
    const { state, events } = applyPush(this.state, f);
    this.state = state;
    if (before.auxInserted !== undefined && before.auxInserted !== state.auxInserted) {
      this.log(state.auxInserted ? 'AUX cable plugged in' : 'AUX cable unplugged');
      if (state.auxInserted) void this.enforcePriority('cable plugged in');
    }
    for (const e of events) {
      if (e.kind === 'eq') this.checkEq(e.eq);
      if (e.kind === 'source' && e.source !== before.source) {
        // the amp repeats this push 2–4 times; log only the change
        this.log(`Amp is now on ${SOURCE_NAMES[e.source]}`);
        void this.readTargetInfo().catch(() => {});
        // A source change often means BT audio started: worth one more try (E1).
        if (this.pendingEq) void this.retryEq().catch(() => {});
        void this.enforcePriority(e.source === 'idle' ? 'amp went idle' : 'Bluetooth took over');
      }
      if (e.kind === 'wuzhi') {
        const replyCmd = e.cmd;
        this.wuzhiWaiters = this.wuzhiWaiters.filter((w) => (w.cmd === replyCmd ? (w.resolve(e.data), false) : true));
      }
    }
    this.changed();
  }

  /** The amp answers an EQ write with the EQ it actually uses. A different mode means refused (E1). */
  private checkEq(eq: Eq): void {
    const sent = this.eqSent;
    if (!sent || Date.now() - this.eqSentAt > 3000) return;
    this.eqSent = null;
    if (eq.mode !== sent.mode) {
      this.pendingEq = sent;
      this.log(`The amp refused EQ ${EQ_NAMES[sent.mode]} (it stays on ${EQ_NAMES[eq.mode]})`, 'error');
      this.ev.onMessage('The amp ignored the EQ change. After switching on, it only accepts EQ once it has played Bluetooth audio. Play something over Bluetooth, then try again.', 'error');
    } else {
      this.pendingEq = null;
      this.log(`EQ set to ${EQ_NAMES[eq.mode]}`);
    }
  }

  private need(): RcspClient {
    if (!this.client || this.status === 'disconnected') throw new Error('Not connected.');
    return this.client;
  }

  /** Set after a rename: the amp restarts by itself, and the app reconnects (A7). */
  restarting = false;
  private reconnecting = false;

  private async reconnectAfterRestart(): Promise<void> {
    this.reconnecting = true;
    const end = Date.now() + 45_000;
    await sleep(4000); // give the amp time to boot
    try {
      while (Date.now() < end && this.status === 'disconnected') {
        try {
          await this.connect();
          this.restarting = false;
          this.log('Reconnected after the restart');
          this.ev.onMessage(
            'Reconnected. If your phone or computer no longer plays to the amp, remove it from its Bluetooth list and pair it again under the new name.',
          );
          return;
        } catch {
          await sleep(3000);
        }
      }
      this.restarting = false;
      this.log('Could not reconnect after the restart. Press Connect.', 'error');
    } finally {
      this.reconnecting = false;
      this.changed();
    }
  }

  private handleDisconnect(): void {
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.recheckTimer = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.client?.stop();
    this.client = null;
    this.transport = null;
    this.gainBusy = false;
    if (this.status === 'connected') this.log(this.restarting ? 'Amp is restarting' : 'Disconnected from the amp');
    if (this.restarting && !this.reconnecting) void this.reconnectAfterRestart();
    this.setStatus('disconnected');
  }

  private setStatus(s: Status): void {
    this.status = s;
    this.changed();
  }

  private changed(): void {
    this.ev.onChange();
  }
}
