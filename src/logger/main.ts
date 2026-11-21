import { AUTH_PASS } from '../protocol/auth';
import { BleTransport, bluetoothAvailable, canReconnectSilently, knownDevice, pickDevice, rememberDevice, type ScanFilter, type WriteMode } from '../ble/transport';
import { RcspClient } from '../protocol/client';
import type { Frame } from '../protocol/codec';
import { FLAG_COMMAND, HEADER_LEN, Op, Payload, concat, encodeRaw, tlv } from '../protocol/frame';
import { beepSet, btNameFrame, describeWuzhi, pairingSet, sourceSelect, wuzhiRead, WuzhiCmd } from '../protocol/wuzhi';
import { runHandshake } from '../protocol/handshake';
import { fromHex, toHex } from '../protocol/hex';
import {
  FunctionId,
  describeSysInfo,
  describeTargetInfo,
  eqName,
  functionName,
  functionsInMask,
  parseSysInfo,
  parseTargetInfo,
} from '../protocol/info';
import { checkOutgoing, type Verdict } from '../protocol/safety';
import { mountIdentityPanel } from '../identity/panel';
import { parseTlvs as parseIdTlvs, scrub, type Tlv as IdTlv } from '../identity/identity';
import { applyPush, applySysInfo, applyTargetInfo, wantsAux, type AmpState } from '../app/state';
import { clampTiming, DEFAULT_TIMING, loadTiming, saveTiming, TIMING_LIMITS, type Timing } from '../app/timing';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const CAP_KEY = 'rcsp-logger.volumeCap';

// ---------- state ----------
let transport: BleTransport | null = null;
let client: RcspClient | null = null;
let authed = false;
let volumeCap: number | null = loadCap();
let lastVolume: number | null = null;
let lastEqGains: number[] | null = null;
let lastEqMode: number | null = null;
/** Max volume the amp reports (target info type 1). Shown only: other models may go higher. */
let deviceMaxVolume: number | null = null;
/** The guard's limit is the user's cap alone. */
const effectiveCap = () => volumeCap;
const CONN_KEY = 'rcsp-logger.connection';
let t0 = performance.now();
const lines: string[] = [];

// ---------- log ----------
type Kind = 'TX' | 'RX' | 'DEC' | 'PUSH' | 'INFO' | 'ERR' | 'NOTE';
function log(kind: Kind, text: string, sub?: string) {
  const ms = Math.round(performance.now() - t0);
  lines.push(`+${String(ms).padStart(7)}ms  ${kind.padEnd(4)}  ${text}${sub ? `   [${sub}]` : ''}`);
  const li = document.createElement('li');
  li.className = kind;
  li.innerHTML = `<span class="t">+${ms}</span><span class="m">${kind}</span><span class="d"></span>`;
  const d = li.querySelector('.d')!;
  d.textContent = text;
  if (sub) {
    const s = document.createElement('span');
    s.className = 'sub';
    s.textContent = sub;
    d.appendChild(s);
  }
  const ol = $('log');
  const stick = ol.scrollTop + ol.clientHeight >= ol.scrollHeight - 4;
  ol.appendChild(li);
  if (stick) ol.scrollTop = ol.scrollHeight;
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const hx = (n: number) => n.toString(16).padStart(2, '0');

/** Structural description of raw bytes (used for TX and raw RX lines). */
function describeRaw(b: Uint8Array): string {
  if (b.length === 17 && b[0] === 0x00) return 'auth: challenge';
  if (b.length === 17 && b[0] === 0x01) return 'auth: response';
  if (b.length === AUTH_PASS.length && b.every((v, i) => v === AUTH_PASS[i])) return 'auth: pass';
  if (b.length >= HEADER_LEN && b[0] === 0xfe && b[1] === 0xdc && b[2] === 0xba) {
    const flags = b[3]!;
    const len = (b[5]! << 8) | b[6]!;
    const total = HEADER_LEN + len + 1;
    const kind = flags & FLAG_COMMAND ? 'command' : 'response';
    const parts = [`${kind}`, `op ${hx(b[4]!)}`];
    if (kind === 'response' && len >= 2) parts.push(`status ${hx(b[7]!)}`, `sn ${hx(b[8]!)}`);
    if (kind === 'command' && len >= 1) parts.push(`sn ${hx(b[7]!)}`);
    if (b.length < total) parts.push(`(continues: ${b.length}/${total} B)`);
    else if (b.length > total) parts.push(`(+${b.length - total} B after EF)`);
    return parts.join(', ');
  }
  return `${b.length} B (continuation or unframed)`;
}

/** Wuzhi frame `AA len cmd data 55` (DSP §7 / settings §12), if the payload is one. */
const describeDsp = describeWuzhi;

/** Meaning of a decoded frame's payload, where we know it. */
function describePayload(f: Frame): string {
  try {
    if (f.opcode === Op.GetTargetInfo && !f.isCommand) return describeTargetInfo(parseTargetInfo(f.payload));
    if (f.opcode === Op.GetSysInfo && !f.isCommand) return describeSysInfo(parseSysInfo(f.payload));
    if (f.opcode === Op.SysInfoPush && f.isCommand) return 'SysInfo update: ' + describeSysInfo(parseSysInfo(f.payload));
  } catch (e) {
    return `could not parse: ${errText(e)}`;
  }
  if (f.opcode === Op.Custom) return describeDsp(f.payload) ?? (f.payload.length ? `payload [${toHex(f.payload)}]` : 'empty payload');
  return f.payload.length ? `payload [${toHex(f.payload)}]` : 'empty payload';
}

// ---------- guard ----------
/** Blocks what the guard blocks (OTA, volume above the cap, malformed frames). No dialogs. */
function guard(bytes: Uint8Array) {
  const v = checkOutgoing(bytes, effectiveCap());
  if (v.action === 'block') throw new Error(`blocked: ${v.reason}`);
}

// ---------- UI state ----------
function setConn(state: 'disconnected' | 'connecting' | 'connected') {
  const p = $('st-conn');
  p.textContent = state;
  p.className = 'pill' + (state === 'connected' ? ' ok' : '');
  const on = state === 'connected';
  $<HTMLButtonElement>('btn-connect').disabled = state !== 'disconnected';
  $<HTMLButtonElement>('btn-disconnect').disabled = state === 'disconnected';
  $<HTMLButtonElement>('btn-auth').disabled = !on;
  document.querySelectorAll<HTMLButtonElement>('.needs-conn').forEach((b) => (b.disabled = !on));
}
function setAuth(state: 'none' | 'running' | 'ok' | 'failed') {
  authed = state === 'ok';
  const p = $('st-auth');
  p.textContent = { none: 'not authenticated', running: 'authenticating…', ok: 'authenticated', failed: 'auth failed' }[state];
  p.className = 'pill' + (state === 'ok' ? ' ok' : state === 'failed' ? ' bad' : '');
}
function renderCap() {
  $('st-cap').textContent = `volume cap: ${volumeCap ?? 'none'}${deviceMaxVolume !== null ? ` (amp max ${deviceMaxVolume})` : ''}`;
  $<HTMLInputElement>('cap').value = volumeCap === null ? '' : String(volumeCap);
  updatePreview();
}
function loadCap(): number | null {
  try {
    const v = localStorage.getItem(CAP_KEY);
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}
/** Device filter and name prefixes survive reloads (the amp's name can change via rename). */
function loadConnSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(CONN_KEY) ?? 'null') as { filter?: string; prefixes?: string } | null;
    if (s?.filter) $<HTMLSelectElement>('filter').value = s.filter;
    if (s?.prefixes) $<HTMLInputElement>('prefixes').value = s.prefixes;
  } catch {
    /* storage unavailable: defaults */
  }
}
function saveConnSettings() {
  try {
    localStorage.setItem(CONN_KEY, JSON.stringify({ filter: $<HTMLSelectElement>('filter').value, prefixes: $<HTMLInputElement>('prefixes').value }));
  } catch {
    /* storage unavailable */
  }
}
function saveCap() {
  try {
    if (volumeCap === null) localStorage.removeItem(CAP_KEY);
    else localStorage.setItem(CAP_KEY, String(volumeCap));
  } catch {
    /* storage unavailable: cap lasts for this page only */
  }
}

// ---------- connection ----------
async function connect(known?: BluetoothDevice) {
  setConn('connecting');
  try {
    const filter = $<HTMLSelectElement>('filter').value as ScanFilter;
    const prefixes = $<HTMLInputElement>('prefixes').value.split(',').map((s) => s.trim()).filter(Boolean);
    const device = known ?? (await pickDevice(filter, prefixes));
    t0 = performance.now();
    log('INFO', `picked "${device.name ?? '(no name)'}"`, `filter=${filter}`);
    const t = new BleTransport(device, {
      onRx: (b) => log('RX', toHex(b), describeRaw(b)),
      onTx: (b, chunks) => log('TX', toHex(b), describeRaw(b) + (chunks > 1 ? `; sent in ${chunks} chunks` : '')),
      onInfo: (m) => log('INFO', m),
      onDisconnect: () => {
        log('INFO', 'GATT disconnected');
        client?.stop();
        client = null;
        transport = null;
        setConn('disconnected');
        setAuth('none');
      },
    });
    t.chunkSize = Math.max(20, Number($<HTMLInputElement>('chunk').value) || 20);
    t.writeMode = $<HTMLSelectElement>('writemode').value as WriteMode;
    t.guard = guard;
    transport = t;
    client = new RcspClient(
      t,
      {
        onFrame: (f, matched, rtt) => {
          if (f.isCommand) return; // pushes are logged by onPush
          const how = matched ? (rtt !== undefined ? ` (${rtt} ms)` : '') : ' (unmatched)';
          log('DEC', `reply op ${hx(f.opcode)} sn ${hx(f.sn)} status ${hx(f.status!)}${how}`, describePayload(f));
          onReply(f);
        },
        onPush: (f) => {
          log(
            'PUSH',
            `device command op ${hx(f.opcode)} sn ${hx(f.sn)}${f.expectsResponse ? ', wants reply' : ''}`,
            describePayload(f) + (f.expectsResponse ? (client?.autoAck ? '; acking' : '; NOT acked (option off)') : ''),
          );
          for (const l of pushListeners) l(f.opcode, f.payload);
          const before = ampState;
          ampState = applyPush(ampState, f).state;
          const cableIn = !before.auxInserted && ampState.auxInserted;
          if (ampState.source !== before.source || cableIn) void loggerPriority();
        },
        onDiscard: (b) => log('INFO', `discarded ${b.length} B outside frames`, toHex(b)),
        onError: (e) => log('ERR', `ack failed: ${errText(e)}`),
      },
      { autoAck: $<HTMLInputElement>('auto-ack').checked },
    );
    await t.connect();
    setConn('connected');
    rememberDevice(device);
    await handshake();
  } catch (e) {
    log('ERR', errText(e));
    if (!transport?.connected) {
      transport?.disconnect();
      transport = null;
      setConn('disconnected');
    }
  }
}

async function handshake() {
  if (!transport || !client) return;
  client.stop(); // raw auth messages must not go through the frame parser
  setAuth('running');
  const answer = $<HTMLInputElement>('answer-dev').checked;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await runHandshake(transport, {
        random16: () => crypto.getRandomValues(new Uint8Array(16)),
        log: (m) => log('INFO', m),
        answerDeviceChallenge: answer,
      });
      setAuth('ok');
      client.start();
      if ($<HTMLInputElement>('auto-run').checked) {
        await request(Op.GetTargetInfo, Payload.targetInfoAll());
        await request(Op.GetSysInfo, Payload.sysInfoPublicAll());
      }
      return;
    } catch (e) {
      log('ERR', `handshake attempt ${attempt}/3: ${errText(e)}`);
    }
  }
  setAuth('failed');
  client.start(); // still parse whatever arrives
}

// ---------- commands ----------
/** Request through the client; logs timing. Errors are logged, not thrown. */
async function request(opcode: number, payload: Uint8Array): Promise<Frame | null> {
  if (!client) {
    log('ERR', 'not connected');
    return null;
  }
  if (!authed) log('INFO', 'note: sending before authentication completed');
  try {
    return await client.request(opcode, payload);
  } catch (e) {
    log('ERR', errText(e));
    return null;
  }
}

/** TLVs from every GetTargetInfo reply seen, to know which bytes identify this amp. */
let privateTlvs: IdTlv[] = [];

/**
 * The log as text for copy/download. Unless the box is ticked, the Bluetooth address, the
 * serial-like ID string and pairing-code digits are replaced with xx.
 */
function exportText(): string {
  const text = lines.join('\n');
  if ($<HTMLInputElement>('export-private').checked) return text;
  const pin = /(aa 06 (?:03|13) 0[01])((?: [0-9a-f]{2}){4})/g;
  return `${scrub(text, privateTlvs).replace(pin, '$1 xx xx xx xx')}\n(Bluetooth address, ID string and pairing code redacted.)`;
}

// ---------- SDK probes (docs/SDK_EXTRAS.md §2), all read-only ----------
interface Probe {
  name: string;
  opcode: number;
  payload: number[];
}
const PROBES: Probe[] = [
  { name: 'Feature map (02)', opcode: 0x02, payload: [] },
  { name: 'Device MD5 (D4)', opcode: 0xd4, payload: [] },
  { name: 'Low-latency settings (D5)', opcode: 0xd5, payload: [] },
  { name: 'Headset-style settings (C1)', opcode: 0xc1, payload: [0xff, 0xff, 0xff, 0xff] },
  ...[0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x16].map((fn) => ({
    name: `Attributes of function ${fn.toString(16).padStart(2, '0')} (07)`,
    opcode: Op.GetSysInfo,
    payload: [fn, 0xff, 0xff, 0xff, 0xff],
  })),
  { name: 'Device online status (07, attr 2)', opcode: Op.GetSysInfo, payload: [0xff, 0x00, 0x00, 0x00, 0x04] },
  { name: 'EQ preset table (07, attr 0C)', opcode: Op.GetSysInfo, payload: [0xff, 0x00, 0x00, 0x10, 0x00] },
  { name: 'Phone status (07, attr 0F)', opcode: Op.GetSysInfo, payload: [0xff, 0x00, 0x00, 0x80, 0x00] },
  { name: '7-band L/R EQ read (FF 00 01 00 00)', opcode: Op.Custom, payload: [0x00, 0x01, 0x00, 0x00] },
  { name: 'Reverb / limiter state (07, attr 10)', opcode: Op.GetSysInfo, payload: [0xff, 0x00, 0x01, 0x00, 0x00] },
];

/** Send one probe; returns a one-line result for the summary. Errors are caught, never thrown. */
async function runProbe(p: Probe): Promise<string> {
  log('NOTE', `probe: ${p.name}`);
  if (!client) return `${p.name}: not connected`;
  try {
    const f = await client.request(p.opcode, Uint8Array.from(p.payload));
    return `${p.name}: status ${hx(f.status!)}, ${f.payload.length ? `${f.payload.length} B: ${toHex(f.payload)}` : 'empty reply'}`;
  } catch (e) {
    return `${p.name}: ${errText(e)}`;
  }
}

function renderProbes() {
  const box = $('probe-buttons');
  const all = document.createElement('button');
  all.textContent = 'Run all';
  all.className = 'needs-conn primary';
  all.disabled = true;
  all.addEventListener('click', async () => {
    all.disabled = true;
    const results: string[] = [];
    for (const p of PROBES) results.push(await runProbe(p));
    log('NOTE', 'probe summary', results.join(' | '));
    all.disabled = !client;
  });
  box.append(all);
  for (const p of PROBES) {
    const b = document.createElement('button');
    b.textContent = p.name;
    b.className = 'needs-conn';
    b.disabled = true;
    b.addEventListener('click', async () => log('NOTE', 'probe result', await runProbe(p)));
    box.append(b);
  }
}

const pushListeners = new Set<(opcode: number, payload: Uint8Array) => void>();

// ---------- AUX priority test (same rule as the app: src/app/state.ts wantsAux) ----------
let ampState: AmpState = {};
let priorityLast = 0;
let priorityRecheck: ReturnType<typeof setTimeout> | undefined;

async function loggerPriority(delayed = false) {
  if (!$<HTMLInputElement>('prio-aux').checked || !client) return;
  if (!wantsAux(ampState)) return;
  clearTimeout(priorityRecheck);
  if (!delayed && timing.priorityDelayMs > 0) {
    priorityRecheck = setTimeout(() => void loggerPriority(true), timing.priorityDelayMs);
    return;
  }
  const wait = timing.priorityGapMs - (Date.now() - priorityLast);
  if (wait > 0) {
    priorityRecheck = setTimeout(() => void loggerPriority(true), wait);
    return;
  }
  priorityLast = Date.now();
  log('NOTE', 'AUX priority: switch back to AUX (phone stays connected)');
  await request(Op.Function, Uint8Array.of(FunctionId.Public, FunctionId.Aux));
  priorityRecheck = setTimeout(() => void loggerPriority(true), timing.priorityRecheckMs);
}

const TIMING_LABELS: Record<keyof Timing, string> = {
  priorityDelayMs: 'AUX priority: wait before switching back (ms)',
  priorityGapMs: 'AUX priority: minimum time between switches (ms)',
  priorityRecheckMs: 'AUX priority: check again after a switch (ms)',
  priorityMaxPerMinute: 'AUX priority: max switches per minute',
  dropWaitMs: 'After "disconnect phone": wait for AUX (ms)',
  gainStepMs: 'Gain: delay between steps (ms)',
  pollMs: 'App: re-read "phone connected" every (ms)',
};

function renderTiming() {
  const box = $('timing-fields');
  box.replaceChildren();
  for (const k of Object.keys(DEFAULT_TIMING) as (keyof Timing)[]) {
    const label = document.createElement('label');
    label.textContent = `${TIMING_LABELS[k]} (default ${DEFAULT_TIMING[k]})`;
    const input = document.createElement('input');
    input.id = `timing-${k}`;
    input.type = 'number';
    input.min = String(TIMING_LIMITS[k][0]);
    input.max = String(TIMING_LIMITS[k][1]);
    input.value = String(timing[k]);
    label.appendChild(input);
    box.appendChild(label);
  }
}

function onReply(f: Frame) {
  try {
    if (f.opcode === Op.GetTargetInfo && f.status === 0) {
      ampState = applyTargetInfo(ampState, f.payload);
      privateTlvs = [...privateTlvs, ...parseIdTlvs(f.payload).tlvs.filter((t) => t.type === 2 || t.type === 3)];
    }
    if (f.opcode === Op.GetSysInfo && f.status === 0) ampState = applySysInfo(ampState, f.payload);
  } catch {
    /* shown in the DEC line */
  }
  try {
    if (f.opcode === Op.GetTargetInfo && f.status === 0) {
      const t = parseTargetInfo(f.payload);
      renderSources(t.functionMask);
      if (t.power) {
        deviceMaxVolume = t.power.maxVolume;
        renderCap();
        renderGain();
      }
    }
    if (f.opcode === Op.GetSysInfo && f.status === 0) {
      const pub = parseSysInfo(f.payload).pub;
      if (pub?.volume !== undefined) {
        lastVolume = pub.volume;
        $('last-vol').textContent = String(pub.volume);
        renderGain();
      }
      if (pub?.eq) {
        lastEqGains = pub.eq.gains;
        lastEqMode = pub.eq.mode;
        $('last-eq').textContent = `${eqName(pub.eq.mode)}, gains [${pub.eq.gains.join(' ')}]`;
      }
    }
  } catch {
    /* parse errors are already shown in the DEC line */
  }
}

function renderSources(mask: number | undefined) {
  const box = $('source-buttons');
  box.replaceChildren();
  if (mask === undefined) return;
  for (const fn of functionsInMask(mask)) {
    if (fn > 4) continue; // source switch is defined for 0–4 (spec §6.5)
    const b = document.createElement('button');
    b.textContent = `Switch to ${functionName(fn)}`;
    b.className = 'needs-conn';
    b.addEventListener('click', () => writeTest(`switch source to ${functionName(fn)}`, Op.Function, Uint8Array.of(FunctionId.Public, fn)));
    box.appendChild(b);
  }
}

async function writeTest(what: string, opcode: number, payload: Uint8Array) {
  log('NOTE', `write test: ${what}`);
  const f = await request(opcode, payload);
  if (!f) return;
  await new Promise((r) => setTimeout(r, 500));
  await request(Op.GetSysInfo, Payload.sysInfoPublicAll());
}

// ---------- gain slider ----------
let timing: Timing = loadTiming();
let gainTarget: number | null = null;
let gainRunning = false;

function renderGain() {
  const shown = $<HTMLInputElement>('gain');
  if (lastVolume !== null && !gainRunning) shown.value = String(lastVolume);
  $('gain-val').textContent = shown.value;
}

/** Slider released: walk toward the target one step at a time. */
async function setGain(target: number) {
  const cap = effectiveCap();
  if (cap === null) {
    log('ERR', 'set a volume cap first');
    return renderGain();
  }
  if (lastVolume === null) {
    log('ERR', 'read the volume first (GetSysInfo)');
    return renderGain();
  }
  if (target > cap) {
    log('INFO', `gain ${target} is above the cap ${cap}; stopping at ${cap}`);
    target = cap;
  }
  if (gainRunning) {
    gainTarget = target; // the running loop picks it up
    return;
  }
  if (target === lastVolume) return renderGain();
  gainTarget = target;
  gainRunning = true;
  log('NOTE', `gain run ${lastVolume} → ${target}`);
  try {
    let current = lastVolume;
    while (gainTarget !== null && current !== gainTarget) {
      const next = current + Math.sign(gainTarget - current);
      const payload = concat(Uint8Array.of(FunctionId.Public), tlv(1, Uint8Array.of(next)));
      if (!(await request(Op.SetSysInfo, payload))) break; // blocked, timed out or disconnected: stop
      current = next;
      lastVolume = next;
      $('gain-val').textContent = String(next);
      await new Promise((r) => setTimeout(r, timing.gainStepMs));
    }
  } finally {
    gainRunning = false;
    gainTarget = null;
  }
  await request(Op.GetSysInfo, Payload.sysInfoPublicAll());
  renderGain();
}

async function setEqMode() {
  if (!lastEqGains) return log('ERR', 'read the EQ first (GetSysInfo)');
  const mode = Number($<HTMLSelectElement>('eq-mode').value);
  // Mode plus the gains we last read back, unchanged: only the mode byte differs.
  const payload = concat(Uint8Array.of(FunctionId.Public), tlv(4, Uint8Array.of(mode, ...lastEqGains)));
  await writeTest(`EQ → ${eqName(mode)} (gains kept as last read)`, Op.SetSysInfo, payload);
  // obs (E1): after power-on the amp answers every EQ write with Normal until it has played BT audio once.
  if (lastEqMode !== null && lastEqMode !== mode) {
    log('ERR', `amp refused the EQ (answered ${eqName(lastEqMode)}). After power-on, play audio over Bluetooth once; then EQ works on any source.`);
  }
}

// ---------- free send ----------
interface FormFrame {
  raw: boolean;
  bytes: Uint8Array;
  opcode: number;
  payload: Uint8Array;
  expect: boolean;
}

/** Reads the send form. In opcode mode the preview uses the client's next sn. */
function readForm(): FormFrame {
  const data = fromHex($<HTMLInputElement>('send-hex').value);
  if ($<HTMLSelectElement>('send-mode').value === 'raw') return { raw: true, bytes: data, opcode: 0, payload: data, expect: false };
  const opText = $<HTMLInputElement>('send-op').value.trim();
  if (!/^(0x)?[0-9a-f]{1,2}$/i.test(opText)) throw new SyntaxError('opcode must be one hex byte');
  const opcode = parseInt(opText, 16);
  const expect = $<HTMLInputElement>('send-expect').checked;
  const sn = client?.nextSn ?? 0;
  const bytes = encodeRaw(FLAG_COMMAND | (expect ? 0x40 : 0), opcode, Uint8Array.of(sn, ...data));
  return { raw: false, bytes, opcode, payload: data, expect };
}

function updatePreview() {
  const isRaw = $<HTMLSelectElement>('send-mode').value === 'raw';
  document.querySelectorAll<HTMLElement>('.op-only').forEach((e) => (e.hidden = isRaw));
  $('send-label').textContent = isRaw ? 'Bytes (hex, sent exactly as typed)' : 'Payload (hex, after sn)';
  $('next-sn').textContent = String(client?.nextSn ?? 0);
  const out = $('send-verdict');
  try {
    const { bytes } = readForm();
    $('send-preview').textContent = toHex(bytes);
    const v: Verdict = checkOutgoing(bytes, effectiveCap());
    out.textContent = v.action === 'allow' ? 'allowed (read-only)' : `${v.action}: ${v.reason}`;
    out.className = `verdict-${v.action}`;
  } catch (e) {
    $('send-preview').textContent = '—';
    out.textContent = errText(e);
    out.className = 'verdict-block';
  }
}

async function sendForm() {
  let form: FormFrame;
  try {
    form = readForm();
  } catch (e) {
    return log('ERR', errText(e));
  }
  const v = checkOutgoing(form.bytes, effectiveCap());
  if (v.action === 'block') return log('ERR', `blocked: ${v.reason}`);
  if (!client || !transport) return log('ERR', 'not connected');
  if (form.raw) {
    try {
      await transport.write(form.bytes);
    } catch (e) {
      log('ERR', errText(e));
    }
  } else if (form.expect) {
    await request(form.opcode, form.payload);
  } else {
    try {
      await client.send(form.opcode, form.payload);
    } catch (e) {
      log('ERR', errText(e));
    }
  }
  updatePreview();
}

// ---------- wiring ----------
function init() {
  if (!bluetoothAvailable()) {
    $('no-bt').hidden = false;
    $<HTMLButtonElement>('btn-connect').disabled = true;
  }
  $('btn-connect').addEventListener('click', () => void connect());
  $('btn-reconnect').addEventListener('click', async () => {
    const d = await knownDevice();
    if (!d)
      return log(
        'ERR',
        canReconnectSilently()
          ? "the remembered amp is not in this browser's allowed list; use Connect once"
          : 'this Chrome cannot reconnect without the chooser. Turn on chrome://flags/#enable-web-bluetooth-new-permissions-backend and restart Chrome',
      );
    void connect(d);
  });
  $('btn-sel-aux').addEventListener('click', () => void writeTest('AUX via vendor source command (AA 02 08 03 55)', Op.Custom, sourceSelect(3)));
  $('btn-sel-bt').addEventListener('click', () => void writeTest('Bluetooth via vendor source command (AA 02 08 01 55)', Op.Custom, sourceSelect(1)));
  renderTiming();
  renderProbes();
  mountIdentityPanel($('identity'), {
    request: async (opcode, payload) => (await request(opcode, payload))?.raw ?? null,
    onPush: (cb) => {
      pushListeners.add(cb);
      return () => pushListeners.delete(cb);
    },
  });
  $('btn-timing-save').addEventListener('click', () => {
    const raw: Partial<Record<keyof Timing, unknown>> = {};
    for (const k of Object.keys(DEFAULT_TIMING) as (keyof Timing)[]) raw[k] = $<HTMLInputElement>(`timing-${k}`).value;
    timing = clampTiming(raw);
    saveTiming(timing);
    renderTiming();
    log('NOTE', `timing saved: ${JSON.stringify(timing)}`);
  });
  $('btn-timing-reset').addEventListener('click', () => {
    timing = { ...DEFAULT_TIMING };
    saveTiming(timing);
    renderTiming();
    log('NOTE', 'timing reset to defaults');
  });
  $('prio-aux').addEventListener('change', () => {
    log('NOTE', `AUX priority test ${$<HTMLInputElement>('prio-aux').checked ? 'on' : 'off'}`);
    void loggerPriority();
  });
  $('btn-pin').addEventListener('click', () => {
    try {
      const on = $<HTMLInputElement>('pin-on').checked;
      void writeTest(`pairing code ${on ? 'on' : 'off'} (code not logged here)`, Op.Custom, pairingSet(on, $<HTMLInputElement>('pin-code').value.trim()));
    } catch (e) {
      log('ERR', errText(e));
    }
  });
  $('btn-disconnect').addEventListener('click', () => transport?.disconnect());
  $('btn-auth').addEventListener('click', handshake);
  $('auto-ack').addEventListener('change', () => {
    if (client) client.autoAck = $<HTMLInputElement>('auto-ack').checked;
  });
  document.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach((b) =>
    b.addEventListener('click', () => {
      const c = b.dataset.cmd;
      if (c === 'targetinfo') void request(Op.GetTargetInfo, Payload.targetInfoAll());
      if (c === 'sysinfo') void request(Op.GetSysInfo, Payload.sysInfoPublicAll());
      if (c === 'dspinfo') void request(Op.Custom, Payload.dspReadInfo());
    }),
  );
  $('gain').addEventListener('input', () => {
    if (!gainRunning) $('gain-val').textContent = $<HTMLInputElement>('gain').value;
  });
  $('gain').addEventListener('change', () => void setGain(Number($<HTMLInputElement>('gain').value)));
  $('btn-rename').addEventListener('click', () => {
    const name = $<HTMLInputElement>('bt-name').value.trim();
    try {
      void writeTest(`rename Bluetooth to "${name}"`, Op.Custom, btNameFrame(name));
    } catch (e) {
      log('ERR', errText(e));
    }
  });
  loadConnSettings();
  for (const id of ['filter', 'prefixes']) $(id).addEventListener('change', saveConnSettings);
  $('btn-reboot').addEventListener('click', () => void writeTest('reboot (opcode E7 00)', Op.Reboot, Uint8Array.of(0)));
  $('btn-power-off').addEventListener('click', () => void writeTest('power off / standby (AA 01 04 55)', Op.Custom, wuzhiRead(WuzhiCmd.SleepOrOff)));
  $('btn-eq-mode').addEventListener('click', () => void setEqMode());
  document.querySelectorAll<HTMLButtonElement>('[data-wuzhi]').forEach((b) =>
    b.addEventListener('click', () => void request(Op.Custom, wuzhiRead(parseInt(b.dataset.wuzhi!, 16)))),
  );
  $('btn-beep').addEventListener('click', () => {
    const vol = Number($<HTMLInputElement>('beep-vol').value);
    try {
      const on = $<HTMLInputElement>('beep-on').checked;
      void writeTest(`beep ${on ? 'on' : 'off'}, volume ${vol}`, Op.Custom, beepSet(on, vol));
    } catch (e) {
      log('ERR', errText(e));
    }
  });
  $('btn-disc-classic').addEventListener('click', () => void writeTest('disconnect classic BT (opcode 06)', Op.DisconnectClassic, new Uint8Array()));
  for (const id of ['send-mode', 'send-op', 'send-hex', 'send-expect']) {
    $(id).addEventListener('input', updatePreview);
  }
  $('btn-send').addEventListener('click', () => void sendForm());
  $('btn-cap').addEventListener('click', () => {
    const v = Number($<HTMLInputElement>('cap').value);
    if (!Number.isInteger(v) || v < 0 || v > 255) return log('ERR', 'cap must be an integer 0–255');
    volumeCap = v;
    saveCap();
    log('NOTE', `volume cap set to ${v}`);
    renderCap();
    renderGain();
  });
  $('btn-cap-clear').addEventListener('click', () => {
    volumeCap = null;
    saveCap();
    log('NOTE', 'volume cap cleared (volume writes blocked)');
    renderCap();
    renderGain();
  });
  const addNote = () => {
    const i = $<HTMLInputElement>('note');
    if (i.value.trim()) log('NOTE', i.value.trim());
    i.value = '';
  };
  $('btn-note').addEventListener('click', addNote);
  $('note').addEventListener('keydown', (e) => e.key === 'Enter' && addNote());
  $('btn-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(exportText());
      log('INFO', `copied ${lines.length} lines`);
    } catch (e) {
      log('ERR', `copy failed: ${errText(e)}`);
    }
  });
  $('btn-download').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([exportText() + '\n'], { type: 'text/plain' }));
    a.download = `rcsp-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('btn-clear').addEventListener('click', () => {
    lines.length = 0;
    $('log').replaceChildren();
  });
  setConn('disconnected');
  setAuth('none');
  renderCap();
}

init();
