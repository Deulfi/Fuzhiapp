import { BLUETOOTH_OFF } from '../ble/transport';
import { EQ_NAMES } from '../protocol/info';
import { Amp, EQ_GAIN_LIMIT } from './amp';
import { loadProfiles, loadSettings, newId, saveProfiles, saveSettings, type Profile } from './profiles';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const BANDS = ['31', '63', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
const USER_MODE = 6;

const settings = loadSettings();
let store = loadProfiles();
let draggingGain = false;
let draggingBand = false;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const amp = new Amp({ onChange: render, onMessage: toast });
amp.gainLimit = settings.gainLimit;
amp.dropPhoneOnAux = settings.dropPhoneOnAux;
amp.auxPriority = settings.auxPriority;

// ---------- helpers ----------
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function toast(text: string, kind: 'info' | 'error' = 'info') {
  const t = $('toast');
  t.textContent = text;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === 'error' ? 7000 : 3000);
}

/** Run an amp action; show its error instead of throwing. */
async function act(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    // NotFoundError is both "chooser cancelled" (stay quiet) and "adapter not available" (Bluetooth off).
    if (e instanceof DOMException && e.name === 'NotFoundError' && /cancel/i.test(e.message)) return;
    const text = e instanceof DOMException && /adapter|not available/i.test(e.message) ? BLUETOOTH_OFF : errText(e);
    toast(text, 'error');
    amp.log(text, 'error');
  }
}

// ---------- render ----------
function render() {
  const s = amp.state;
  const connected = amp.status === 'connected';
  $('view-connect').hidden = connected;
  $('view-amp').hidden = !connected;
  $('btn-settings').hidden = !connected;
  $('status').textContent = amp.restarting && amp.status !== 'connected' ? 'Amp restarting…' : { disconnected: 'Not connected', connecting: 'Connecting…', connected: 'Connected' }[amp.status];
  $('status').dataset.state = amp.status;
  $('dev-name').textContent = connected ? amp.deviceName : '';
  $<HTMLButtonElement>('btn-connect').disabled = amp.status === 'connecting';
  $('btn-connect').textContent = amp.hasDevice && amp.status === 'disconnected' ? 'Reconnect' : amp.status === 'connecting' ? 'Connecting…' : 'Connect';
  if (!connected) return;

  // source
  const bt = $<HTMLButtonElement>('src-bt');
  const aux = $<HTMLButtonElement>('src-aux');
  bt.setAttribute('aria-checked', String(s.source === 'bluetooth'));
  aux.setAttribute('aria-checked', String(s.source === 'aux'));
  aux.disabled = !s.auxInserted;
  $('source-note').textContent = !s.auxInserted
    ? 'No AUX cable'
    : s.source === 'idle'
      ? 'Idle: no phone connected'
      : s.source === 'bluetooth' && s.a2dp === false
        ? 'Waiting for a phone'
        : '';
  $<HTMLInputElement>('drop-phone').checked = settings.dropPhoneOnAux;
  $<HTMLInputElement>('aux-priority').checked = settings.auxPriority;
  $('a2dp-dot').classList.toggle('on', !!s.a2dp);
  $('a2dp-text').textContent = s.a2dp ? 'Bluetooth audio: a phone or computer is connected' : 'Bluetooth audio: nothing connected';
  $('btn-drop').hidden = !s.a2dp;
  renderActivity();

  // gain
  const g = $<HTMLInputElement>('gain');
  g.max = String(amp.gainLimit);
  $('gain-max').textContent = String(amp.gainLimit);
  if (!draggingGain && !amp.gainBusy && s.volume !== undefined) g.value = String(s.volume);
  $('gain-val').textContent = s.volume === undefined ? '–' : String(draggingGain ? g.value : s.volume);

  // eq
  const eq = s.eq;
  document.querySelectorAll<HTMLButtonElement>('#eq-presets button').forEach((b) => {
    b.setAttribute('aria-pressed', String(eq?.mode === Number(b.dataset.mode)));
  });
  $('eq-note').textContent = eq ? EQ_NAMES[eq.mode] ?? '' : '';
  $('eq-refused').hidden = !amp.pendingEq;
  if (!draggingBand && eq) {
    document.querySelectorAll<HTMLInputElement>('#eq-bands input').forEach((r, i) => {
      r.value = String(eq.gains[i] ?? 0);
      r.closest('.band')!.querySelector('.band-val')!.textContent = fmtDb(eq.gains[i] ?? 0);
    });
  }

  // settings sheet values that come from the amp
  if (s.beep) {
    if (document.activeElement !== $('beep-vol')) $<HTMLInputElement>('beep-vol').value = String(s.beep.volume);
    $<HTMLInputElement>('beep-on').checked = s.beep.on;
    $('beep-val').textContent = $<HTMLInputElement>('beep-vol').value;
  }
}

let shownActivity = 0;
function renderActivity() {
  if (amp.activity.length === shownActivity && $('activity').childElementCount) return;
  shownActivity = amp.activity.length;
  const ol = $('activity');
  ol.replaceChildren();
  if (!amp.activity.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Nothing yet.';
    ol.appendChild(li);
  }
  for (const a of amp.activity) {
    const li = document.createElement('li');
    li.className = a.kind;
    const t = document.createElement('time');
    t.textContent = a.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const s = document.createElement('span');
    s.textContent = a.text;
    li.append(t, s);
    ol.appendChild(li);
  }
}

const fmtDb = (v: number) => (v > 0 ? `+${v}` : String(v));

// ---------- build static parts ----------
function buildEq() {
  const presets = $('eq-presets');
  EQ_NAMES.forEach((name, mode) => {
    const b = document.createElement('button');
    b.textContent = name;
    b.dataset.mode = String(mode);
    b.addEventListener('click', () => act(() => amp.setEq(mode, mode === USER_MODE ? amp.state.eq?.gains : undefined)));
    presets.appendChild(b);
  });
  const bands = $('eq-bands');
  BANDS.forEach((label, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'band';
    const val = document.createElement('span');
    val.className = 'band-val';
    val.textContent = '0';
    const r = document.createElement('input');
    r.type = 'range';
    r.min = String(-EQ_GAIN_LIMIT);
    r.max = String(EQ_GAIN_LIMIT);
    r.step = '1';
    r.value = '0';
    r.setAttribute('aria-label', `${label} Hz`);
    r.addEventListener('input', () => {
      draggingBand = true;
      val.textContent = fmtDb(Number(r.value));
    });
    r.addEventListener('change', () => {
      draggingBand = false;
      const gains = Array.from(document.querySelectorAll<HTMLInputElement>('#eq-bands input'), (x) => Number(x.value));
      void act(() => amp.setEq(USER_MODE, gains));
    });
    const lab = document.createElement('span');
    lab.className = 'band-label';
    lab.textContent = label;
    wrap.append(val, r, lab);
    bands.appendChild(wrap);
  });
}

// ---------- profiles ----------
function renderProfiles() {
  const list = $('profile-list');
  list.replaceChildren();
  if (!store.profiles.length) {
    const li = document.createElement('li');
    li.className = 'muted small';
    li.textContent = 'No profiles yet. Set things up, then save them here.';
    list.appendChild(li);
  }
  for (const p of store.profiles) {
    const li = document.createElement('li');
    const text = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = p.name;
    const desc = document.createElement('span');
    desc.className = 'muted small';
    desc.textContent = describeProfile(p);
    text.append(name, desc);
    const apply = document.createElement('button');
    apply.textContent = 'Apply';
    apply.addEventListener('click', () => act(() => applyProfile(p)));
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.className = 'quiet';
    del.addEventListener('click', () => {
      store.profiles = store.profiles.filter((x) => x.id !== p.id);
      if (store.autoApplyId === p.id) store.autoApplyId = null;
      saveProfiles(store);
      renderProfiles();
    });
    li.append(text, apply, del);
    list.appendChild(li);
  }
  const sel = $<HTMLSelectElement>('auto-apply');
  sel.replaceChildren(new Option('Nothing (keep the amp as it is)', ''));
  for (const p of store.profiles) sel.appendChild(new Option(p.name, p.id));
  sel.value = store.autoApplyId ?? '';
}

function describeProfile(p: Profile): string {
  const parts: string[] = [];
  if (p.source) parts.push(p.source === 'aux' ? 'AUX' : 'Bluetooth');
  if (p.gain !== undefined) parts.push(`gain ${p.gain}`);
  if (p.eq) parts.push(EQ_NAMES[p.eq.mode] ?? 'EQ');
  return parts.join(' · ');
}

async function applyProfile(p: Profile) {
  if (p.source === 'aux' && amp.state.auxInserted) await amp.setSource('aux');
  if (p.source === 'bluetooth') await amp.setSource('bluetooth', false);
  if (p.eq) await amp.setEq(p.eq.mode, p.eq.gains);
  if (p.gain !== undefined) await amp.setGain(p.gain);
  amp.log(`Applied profile "${p.name}"`);
  toast(`Applied "${p.name}"`);
}

// ---------- connect ----------
async function connect(all = false) {
  await act(async () => {
    if (all || !amp.hasDevice) await amp.choose(all);
    else await amp.connect();
    const auto = store.profiles.find((p) => p.id === store.autoApplyId);
    if (auto) await applyProfile(auto);
  });
}

// ---------- wire up ----------
function init() {
  if (!Amp.supported()) {
    $('no-bt').hidden = false;
    $<HTMLButtonElement>('btn-connect').disabled = true;
    $<HTMLButtonElement>('btn-connect-all').hidden = true;
  }
  buildEq();
  renderProfiles();
  $('btn-connect').addEventListener('click', () => connect());
  $('btn-connect-all').addEventListener('click', () => connect(true));

  $('src-bt').addEventListener('click', () => act(() => amp.pickSource('bluetooth')));
  $('src-aux').addEventListener('click', () => act(() => amp.pickSource('aux')));
  $('drop-phone').addEventListener('change', () => {
    amp.dropPhoneOnAux = settings.dropPhoneOnAux = $<HTMLInputElement>('drop-phone').checked;
    saveSettings(settings);
  });
  $('aux-priority').addEventListener('change', () => {
    amp.auxPriority = settings.auxPriority = $<HTMLInputElement>('aux-priority').checked;
    amp.prioritySuspended = false;
    saveSettings(settings);
    amp.log(amp.auxPriority ? 'AUX priority on' : 'AUX priority off');
    void amp.enforcePriority('turned on');
  });

  const g = $<HTMLInputElement>('gain');
  g.addEventListener('input', () => {
    draggingGain = true;
    $('gain-val').textContent = g.value;
  });
  g.addEventListener('change', () => {
    draggingGain = false;
    void act(() => amp.setGain(Number(g.value)));
  });

  $('btn-eq-retry').addEventListener('click', () => act(() => amp.retryEq()));

  $('profile-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $<HTMLInputElement>('profile-name').value.trim();
    if (!name) return;
    const s = amp.state;
    const source = s.source === 'aux' || s.source === 'bluetooth' ? s.source : undefined;
    store.profiles.push({ id: newId(), name, gain: s.volume, eq: s.eq, source });
    saveProfiles(store);
    $<HTMLInputElement>('profile-name').value = '';
    renderProfiles();
    toast(`Saved "${name}"`);
  });
  $('auto-apply').addEventListener('change', () => {
    store.autoApplyId = $<HTMLSelectElement>('auto-apply').value || null;
    saveProfiles(store);
  });

  // settings sheet
  const dlg = $<HTMLDialogElement>('settings');
  $('btn-settings').addEventListener('click', () => {
    $<HTMLInputElement>('gain-limit').value = String(amp.gainLimit);
    $<HTMLInputElement>('bt-name').value = amp.deviceName.replace(/ APP$/, '');
    dlg.showModal();
    void act(() => amp.readBeep());
  });
  $('btn-gain-limit').addEventListener('click', () => {
    const v = Number($<HTMLInputElement>('gain-limit').value);
    if (!Number.isInteger(v) || v < 0 || v > 255) return toast('Gain limit must be a whole number from 0 to 255.', 'error');
    amp.gainLimit = settings.gainLimit = v;
    saveSettings(settings);
    if ((amp.state.volume ?? 0) > v) void act(() => amp.setGain(v));
    render();
    toast(`Gain limit set to ${v}`);
  });
  $('beep-vol').addEventListener('input', () => ($('beep-val').textContent = $<HTMLInputElement>('beep-vol').value));
  $('btn-beep').addEventListener('click', () =>
    act(() => amp.setBeep($<HTMLInputElement>('beep-on').checked, Number($<HTMLInputElement>('beep-vol').value))),
  );
  $('btn-rename').addEventListener('click', () =>
    act(async () => {
      const name = $<HTMLInputElement>('bt-name').value.trim();
      await amp.rename(name);
      dlg.close();
      toast(`Renamed to "${name}". The amp restarts now; the app reconnects by itself.`);
    }),
  );
  $('btn-drop').addEventListener('click', () => act(() => amp.dropPhone()));
  $('btn-disconnect').addEventListener('click', () => {
    dlg.close();
    amp.disconnect();
  });

  render();
  // Coming back from the logger (or a reload): reconnect without the chooser if the browser allows it.
  void amp.autoConnect().then(async (ok) => {
    if (!ok) return;
    const auto = store.profiles.find((p) => p.id === store.autoApplyId);
    if (auto) await act(() => applyProfile(auto));
  });
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    void navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

init();
