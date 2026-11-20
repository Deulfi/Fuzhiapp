/**
 * Outgoing-bytes guard. Every byte the app writes to the amp goes through `checkOutgoing`.
 *
 * - Volume writes (SetSysInfo, function 0xFF, attr 1) are blocked unless a user-confirmed
 *   cap is set, and blocked above it.
 * - OTA opcodes are blocked outright (risk of bricking).
 * - Raw sends must be complete, well-formed frames or an auth-shaped message, so a frame
 *   cannot be smuggled past the guard in pieces.
 * - Known read-only commands pass; everything else needs an explicit confirmation.
 */
import { AUTH_PASS } from './auth';
import { FLAG_COMMAND, Op, splitExactFrames, type RawFrame } from './frame';
import { splitWuzhi, WUZHI_READS, WuzhiCmd } from './wuzhi';

export type Verdict =
  | { action: 'allow' }
  | { action: 'confirm'; reason: string }
  | { action: 'block'; reason: string };

const ALLOW: Verdict = { action: 'allow' };
const rank = { allow: 0, confirm: 1, block: 2 } as const;

export const VOLUME_ATTR = 0x01;
export const PUBLIC_FUNCTION = 0xff;

function isAuthMessage(b: Uint8Array): boolean {
  if (b.length === 17 && (b[0] === 0x00 || b[0] === 0x01)) return true;
  return b.length === AUTH_PASS.length && b.every((v, i) => v === AUTH_PASS[i]);
}

export function checkOutgoing(bytes: Uint8Array, volumeCap: number | null): Verdict {
  if (bytes.length === 0) return { action: 'block', reason: 'nothing to send' };
  if (isAuthMessage(bytes)) return ALLOW;
  const frames = splitExactFrames(bytes);
  if (!frames) {
    return { action: 'block', reason: 'raw sends must be one or more complete FE DC BA … EF frames (or an auth message)' };
  }
  let worst: Verdict = ALLOW;
  for (const f of frames) {
    const v = checkFrame(f, volumeCap);
    if (rank[v.action] > rank[worst.action]) worst = v;
  }
  return worst;
}

function checkFrame(f: RawFrame, cap: number | null): Verdict {
  const op = f.opcode;
  if (op === Op.Reboot && (f.flags & FLAG_COMMAND) !== 0 && f.params.length === 2 && f.params[1] === 0) {
    return { action: 'confirm', reason: 'reboot the amp (opcode 0xE7 00)' };
  }
  if (op >= 0xe1 && op <= 0xe8) return { action: 'block', reason: `opcode 0x${hex(op)} is OTA (firmware update); blocked` };
  if ((f.flags & FLAG_COMMAND) === 0) {
    // A bare ack [status 0][sn] carries no settings: allowed (used to answer device pushes).
    if (f.params.length === 2 && f.params[0] === 0) return ALLOW;
    return { action: 'confirm', reason: 'this is a response frame with a payload (host → device reply)' };
  }

  // params[0] is sn for host commands
  const payload = f.params.subarray(1);
  if (op === Op.GetTargetInfo || op === Op.GetSysInfo) return ALLOW;
  if (op === Op.Custom) return checkCustom(payload, cap);
  if (op === Op.DisconnectClassic) return { action: 'confirm', reason: 'disconnect the classic Bluetooth (audio) link, opcode 0x06 [I]' };
  if (op === Op.SetSysInfo) return checkSetSysInfo(payload, cap);
  return { action: 'confirm', reason: `opcode 0x${hex(op)} may change device state` };
}

/** Wuzhi `AA len cmd data 55` frames inside opcode 0xFF (docs/PROTOCOL.md §7, §12.2). */
function checkCustom(payload: Uint8Array, cap: number | null): Verdict {
  const w = splitWuzhi(payload);
  if (!w) return { action: 'confirm', reason: 'custom opcode 0xFF with an unknown payload' };
  if (w.data.length === 0 && (WUZHI_READS as readonly number[]).includes(w.cmd)) return ALLOW;
  switch (w.cmd) {
    case WuzhiCmd.BeepSet: {
      // Beep/prompt volume uses the same 0–30 scale [D]; it gets the same cap as the main volume.
      if (w.data.length !== 2) return { action: 'block', reason: 'beep TLV with unexpected length' };
      const vol = w.data[1] as number;
      if (cap === null) return { action: 'block', reason: `beep volume (${vol}) blocked: no volume cap confirmed yet` };
      if (vol > cap) return { action: 'block', reason: `beep volume ${vol} is above the confirmed cap ${cap}` };
      return { action: 'confirm', reason: `set beep ${w.data[0] ? 'on' : 'off'}, volume ${vol} (cap ${cap})` };
    }
    case WuzhiCmd.SleepOrOff:
      return { action: 'confirm', reason: 'AA 01 04 55: probably powers the amp off or puts it in standby [I]' };
    case WuzhiCmd.PairingSet:
      return { action: 'confirm', reason: 'change the Bluetooth pairing code (phones may need the code to pair afterwards)' };
    case WuzhiCmd.BtName:
      return { action: 'confirm', reason: "rename the amp's Bluetooth name" };
    case WuzhiCmd.Tws:
      return { action: 'confirm', reason: 'TWS button: meaning unknown [I]' };
  }
  return { action: 'confirm', reason: `Wuzhi cmd 0x${hex(w.cmd)} may change device state` };
}

function checkSetSysInfo(payload: Uint8Array, cap: number | null): Verdict {
  if (payload.length < 1) return { action: 'block', reason: 'SetSysInfo without function byte' };
  const fn = payload[0] as number;
  if (fn !== PUBLIC_FUNCTION) return { action: 'confirm', reason: `SetSysInfo for function 0x${hex(fn)}` };
  const reasons: string[] = [];
  let i = 1;
  while (i < payload.length) {
    const len = payload[i] as number;
    if (len < 1 || i + 1 + len > payload.length) {
      return { action: 'block', reason: 'SetSysInfo TLVs are malformed; refusing (could hide a volume write)' };
    }
    const type = payload[i + 1] as number;
    const data = payload.subarray(i + 2, i + 1 + len);
    if (type === VOLUME_ATTR) {
      if (data.length !== 1) return { action: 'block', reason: 'volume TLV with unexpected length' };
      const vol = data[0] as number;
      if (cap === null) return { action: 'block', reason: `volume write (${vol}) blocked: no volume cap confirmed yet` };
      if (vol > cap) return { action: 'block', reason: `volume ${vol} is above the confirmed cap ${cap}` };
      reasons.push(`set volume to ${vol} (cap ${cap})`);
    } else {
      reasons.push(`set public attr 0x${hex(type)}`);
    }
    i += 1 + len;
  }
  return { action: 'confirm', reason: reasons.join(', ') || 'empty SetSysInfo' };
}

const hex = (n: number) => n.toString(16).padStart(2, '0');
