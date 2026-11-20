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
    this.device.addEventListener('gattserverdisconnected', this.handleDisconnect);
    this.ev.onInfo(`connecting GATT to "${this.device.name ?? '(no name)'}" id=${this.device.id}`);
    const server = await gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
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
