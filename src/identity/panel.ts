/**
 * "Device identity" panel. Self-contained: the host page passes in two functions and this
 * module does the rest. Read-only: it only sends GetTargetInfo and the Wuzhi model query.
 */
import {
  hex,
  MODEL_QUERY,
  OP_CUSTOM,
  OP_TARGET_INFO,
  parseModelFrame,
  parseTlvs,
  reportText,
  rows,
  scrub,
  TARGET_INFO_PAYLOAD,
  targetInfoPayload,
  type IdentityReport,
} from './identity';

export interface IdentityIo {
  /** Send a command and resolve with the whole raw response frame (FE DC BA … EF), or null on failure/timeout. */
  request(opcode: number, payload: Uint8Array): Promise<Uint8Array | null>;
  /** Subscribe to device pushes: opcode and payload (after sn). Returns an unsubscribe function. */
  onPush(cb: (opcode: number, payload: Uint8Array) => void): () => void;
}

/** Tiny element helper; `props` are assigned as DOM properties (textContent, className, disabled…). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...kids);
  return e;
}

export function mountIdentityPanel(container: HTMLElement, io: IdentityIo): void {
  let report: IdentityReport | null = null;
  const run = el('button', { textContent: 'Collect identity' });
  const copy = el('button', { textContent: 'Copy report', disabled: true });
  const privBox = el('input', { type: 'checkbox' });
  const priv = el('label', {}, privBox, ' Include Bluetooth address and ID string');
  const status = el('span', { className: 'muted' });
  const out = el('div');
  container.append(
    el('p', { className: 'muted', textContent: 'Read-only: sends GetTargetInfo and the model query (AA 01 01 55), nothing else. Your amp\'s Bluetooth address (type 2) and serial-like ID (type 3) are hidden unless you tick the box.' }),
    el('div', { className: 'row' }, run, copy, priv, status),
    out,
  );

  privBox.addEventListener('change', () => report && render(out, report, privBox.checked));
  run.addEventListener('click', async () => {
    run.disabled = true;
    status.textContent = 'collecting…';
    try {
      report = await collect(io);
      render(out, report, privBox.checked);
      copy.disabled = false;
      status.textContent = '';
    } catch (e) {
      status.textContent = `failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      run.disabled = false;
    }
  });
  copy.addEventListener('click', async () => {
    if (!report) return;
    const text = reportText(report, privBox.checked);
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = 'copied';
    } catch {
      // clipboard blocked: show the text so it can be copied by hand
      out.append(el('textarea', { value: text, rows: 16, readOnly: true, className: 'id-text' }));
      status.textContent = 'clipboard not available; select the text below';
    }
  });
}

async function collect(io: IdentityIo): Promise<IdentityReport> {
  const r: IdentityReport = { targetInfoFrame: null, tlvs: [], model: null, modelFrame: null };

  r.targetInfoFrame = await io.request(OP_TARGET_INFO, TARGET_INFO_PAYLOAD);
  const payload = r.targetInfoFrame && targetInfoPayload(r.targetInfoFrame);
  if (payload) {
    const p = parseTlvs(payload);
    r.tlvs = p.tlvs;
    r.tlvError = p.error;
  } else if (r.targetInfoFrame) {
    r.tlvError = 'response frame not in the expected layout';
  }

  // The model reply comes as a pushed 0xFF frame whose payload is `AA len 01 … 55`.
  const reply = new Promise<Uint8Array | null>((resolve) => {
    const stop = io.onPush((opcode, p) => {
      if (opcode === OP_CUSTOM && p[0] === 0xaa && p[2] === 0x01) {
        stop();
        resolve(p.slice());
      }
    });
    setTimeout(() => {
      stop();
      resolve(null);
    }, 2500);
  });
  await io.request(OP_CUSTOM, MODEL_QUERY);
  r.modelFrame = await reply;
  r.model = r.modelFrame ? parseModelFrame(r.modelFrame) : null;
  return r;
}

function render(out: HTMLElement, r: IdentityReport, includePrivate: boolean): void {
  const hide = (t: string) => (includePrivate ? t : scrub(t, r.tlvs));
  const rawTarget = r.targetInfoFrame ? hide(hex(r.targetInfoFrame)) : '(none)';
  const table = el('table', { className: 'id-table' });
  table.append(el('tr', {}, ...['Type', 'Name', 'Hex', 'ASCII', 'Meaning'].map((h) => el('th', { textContent: h }))));
  for (const row of rows(r.tlvs)) {
    const tr = el(
      'tr',
      { className: row.reported ? '' : 'missing' },
      el('td', { textContent: String(row.type) }),
      el('td', { textContent: row.name }),
      el('td', {}, el('code', { textContent: hide(row.hex) })),
      el('td', {}, el('code', { textContent: hide(row.ascii) })),
      el('td', { textContent: row.meaning }),
    );
    table.append(tr);
  }
  const model = r.model
    ? el(
        'table',
        { className: 'id-table' },
        ...[
          ['Product code', `"${r.model.productCode}"`],
          ['Field 2', `"${r.model.field2}"`],
          ['Field 3', `"${r.model.field3}"`],
          ['6 raw bytes', hex(r.model.raw6)],
          ['Whole frame', hex(r.model.frame)],
        ].map(([k, v]) => el('tr', {}, el('th', { textContent: k! }), el('td', {}, el('code', { textContent: v! })))),
      )
    : el('p', { className: 'muted', textContent: r.modelFrame ? `Model reply not in the expected layout: ${hex(r.modelFrame)}` : 'No model-query reply.' });
  out.replaceChildren(
    el('h3', { textContent: 'GetTargetInfo' }),
    r.targetInfoFrame ? table : el('p', { className: 'muted', textContent: 'No GetTargetInfo reply.' }),
    ...(r.tlvError ? [el('p', { className: 'muted', textContent: `Parse note: ${r.tlvError}` })] : []),
    el('h3', { textContent: 'Model query' }),
    model,
    el('h3', { textContent: 'Raw GetTargetInfo response' }),
    el('p', { className: 'preview' }, el('code', { textContent: rawTarget })),
  );
}
