/**
 * Web Bluetooth transport for the RCSP service (docs/PROTOCOL.md §2).
 * - Writes are serialized and split into `chunkSize` pieces (Web Bluetooth cannot request
 *   an MTU, so 20 bytes is the safe default; see OPEN_QUESTIONS T3).
 * - Every outgoing write goes through the caller-supplied `guard` first.
 */
import type { Link } from '../protocol/handshake';

export const SERVICE_UUID = '0000ae00-0000-1000-8000-00805f9b34fb';
export const WRITE_UUID = '0000ae01-0000-1000-8000-00805f9b34fb';
export const NOTIFY_UUID = '0000ae02-0000-1000-8000-00805f9b34fb';

export type ScanFilter = 'all' | 'service' | 'name';
export type WriteMode = 'auto' | 'with-response' | 'without-response';

export interface TransportEvents {
  onRx(bytes: Uint8Array): void;
  onTx(bytes: Uint8Array, chunks: number): void;
  onInfo(msg: string): void;
  onDisconnect(): void;
}

export function bluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

export async function pickDevice(filter: ScanFilter, namePrefixes: string[]): Promise<BluetoothDevice> {
  const optionalServices = [SERVICE_UUID];
  let options: RequestDeviceOptions;
  if (filter === 'service') options = { filters: [{ services: [SERVICE_UUID] }] };
  else if (filter === 'name') options = { filters: namePrefixes.map((namePrefix) => ({ namePrefix })), optionalServices };
  else options = { acceptAllDevices: true, optionalServices };
  return navigator.bluetooth.requestDevice(options);
}

const LAST_DEVICE_KEY = 'wuzhi.lastDeviceId';

/** Remember the amp so the app and the logger (same origin) can reconnect without the chooser. */
export function rememberDevice(d: BluetoothDevice): void {
  try {
    localStorage.setItem(LAST_DEVICE_KEY, d.id);
  } catch {
    /* storage unavailable */
  }
}

/**
 * The last amp, if the browser still grants access to it (`navigator.bluetooth.getDevices()`).
 * Chrome only has this when its permissions backend supports it; elsewhere it returns null.
 */
/** Whether this browser can reconnect without the chooser at all. */
export function canReconnectSilently(): boolean {
  return typeof navigator !== 'undefined' && !!(navigator.bluetooth as Bluetooth & { getDevices?: unknown })?.getDevices;
}

export async function knownDevice(): Promise<BluetoothDevice | null> {
  const bt = typeof navigator !== 'undefined' ? (navigator.bluetooth as Bluetooth & { getDevices?: () => Promise<BluetoothDevice[]> }) : undefined;
  if (!bt?.getDevices) return null;
  try {
    const id = localStorage.getItem(LAST_DEVICE_KEY);
    if (!id) return null;
    return (await bt.getDevices()).find((d) => d.id === id) ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve true when the device's advertisement is received, false after `timeoutMs` or when the
 * browser has no watchAdvertisements() (then the caller just tries to connect anyway).
 */
export async function waitForAdvertisement(device: BluetoothDevice, timeoutMs: number): Promise<boolean> {
  const d = device as BluetoothDevice & { watchAdvertisements?: (o?: { signal?: AbortSignal }) => Promise<void> };
  if (!d.watchAdvertisements) return false;
  const ac = new AbortController();
  let onAdv: (() => void) | undefined;
  try {
    const seen = new Promise<boolean>((resolve) => {
      onAdv = () => resolve(true);
      device.addEventListener('advertisementreceived', onAdv);
      setTimeout(() => resolve(false), timeoutMs);
    });
    await d.watchAdvertisements({ signal: ac.signal });
    return await seen;
  } catch {
    return false;
  } finally {
    if (onAdv) device.removeEventListener('advertisementreceived', onAdv);
    ac.abort();
  }
}

const props = (c:BluetoothRemoteGATTCharacteristic) =>
  Object.entries({
    read: c.properties.read,
    write: c.properties.write,
    writeWithoutResponse: c.properties.writeWithoutResponse,
    notify: c.properties.notify,
    indicate: c.properties.indicate,
  })
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(', ');

export class BleTransport implements Link {
  private writeChar: BluetoothRemoteGATTCharacteristic | null = null;
  private notifyChar: BluetoothRemoteGATTCharacteristic | null = null;
  private listeners = new Set<(b: Uint8Array) => void>();
  private queue: Promise<void> = Promise.resolve();
  private useWithResponse = true;

  chunkSize = 20;
  writeMode: WriteMode = 'auto';
  /** Throws to refuse a write. Set by the owner; checked for every write. */
  guard: (bytes: Uint8Array) => void = () => {};

  constructor(readonly device: BluetoothDevice, private ev: TransportEvents) {}

  get connected(): boolean {
    return !!this.device.gatt?.connected && !!this.writeChar;
  }

  async connect(): Promise<void> {
    const gatt = this.device.gatt;
    if (!gatt) throw new Error('device has no GATT server');
    this.ev.onInfo(`connecting GATT to "${this.device.name ?? '(no name)'}" id=${this.device.id}`);
    const service = await this.connectGatt(gatt);
    // Only now: a failed attempt above must not look like a dropped connection to the owner.
    this.device.addEventListener('gattserverdisconnected', this.handleDisconnect);
    this.writeChar = await service.getCharacteristic(WRITE_UUID);
    this.notifyChar = await service.getCharacteristic(NOTIFY_UUID);
    this.ev.onInfo(`AE01 properties: ${props(this.writeChar)}`);
    this.ev.onInfo(`AE02 properties: ${props(this.notifyChar)}`);
    this.useWithResponse =
      this.writeMode === 'with-response' || (this.writeMode === 'auto' && this.writeChar.properties.write);
    this.ev.onInfo(`write type: ${this.useWithResponse ? 'with response' : 'without response'}, chunk ${this.chunkSize} B`);
    this.notifyChar.addEventListener('characteristicvaluechanged', this.handleNotify);
    await this.notifyChar.startNotifications();
    this.ev.onInfo('notifications on AE02 enabled');
  }

  /**
   * gatt.connect() + service lookup, with retries for two Chrome quirks seen on the ZK-502MT:
   * - After a browser restart, a remembered device fails with "no longer in range" until Chrome
   *   has seen it advertise again. Fix: watchAdvertisements(), wait for one, then connect.
   * - Reconnecting right after a disconnect can fail with "GATT Server is disconnected" while
   *   the old link is still being torn down. Fix: wait a moment and try again.
   */
  private async connectGatt(gatt: BluetoothRemoteGATTServer): Promise<BluetoothRemoteGATTService> {
    let last: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const server = await gatt.connect();
        return await server.getPrimaryService(SERVICE_UUID);
      } catch (e) {
        last = e;
        const msg = e instanceof Error ? e.message : String(e);
        this.ev.onInfo(`connect attempt ${attempt} failed: ${msg}`);
        if (attempt === 3) break;
        if (/range/i.test(msg)) {
          this.ev.onInfo('waiting for the amp to advertise (up to 10 s)');
          const seen = await waitForAdvertisement(this.device, 10_000);
          this.ev.onInfo(seen ? 'amp seen, connecting again' : 'no advertisement seen; trying anyway');
        } else {
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    }
    throw last;
  }

  disconnect(): void {
    this.device.gatt?.disconnect();
  }

  onData(cb: (b: Uint8Array) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Guarded, serialized, chunked write. */
  write(bytes: Uint8Array): Promise<void> {
    this.guard(bytes); // throws synchronously if refused
    const run = async () => {
      const c = this.writeChar;
      if (!c) throw new Error('not connected');
      const n = Math.max(1, Math.ceil(bytes.length / this.chunkSize));
      this.ev.onTx(bytes, n);
      for (let i = 0; i < bytes.length; i += this.chunkSize) {
        const chunk = bytes.slice(i, i + this.chunkSize);
        if (this.useWithResponse) await c.writeValueWithResponse(chunk);
        else await c.writeValueWithoutResponse(chunk);
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  private handleNotify = (e: Event) => {
    const dv = (e.target as BluetoothRemoteGATTCharacteristic).value;
    if (!dv) return;
    const bytes = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
    this.ev.onRx(bytes);
    for (const l of this.listeners) l(bytes);
  };

  private handleDisconnect = () => {
    this.writeChar = null;
    this.notifyChar = null;
    this.device.removeEventListener('gattserverdisconnected', this.handleDisconnect);
    this.ev.onDisconnect();
  };
}
