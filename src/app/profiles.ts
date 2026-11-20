/**
 * Local profiles (docs/PROTOCOL.md §10): saved in this browser only. One profile can be applied
 * automatically on every connect, but only if the user turns that on.
 */
import type { Eq } from './state';

export interface Profile {
  id: string;
  name: string;
  gain?: number;
  eq?: Eq;
  source?: 'bluetooth' | 'aux';
}

export interface ProfileStore {
  profiles: Profile[];
  /** profile applied on connect; null = off (default) */
  autoApplyId: string | null;
}

const KEY = 'wuzhi.profiles.v1';
const SETTINGS_KEY = 'wuzhi.settings.v1';

export function loadProfiles(): ProfileStore {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as ProfileStore | null;
    if (v && Array.isArray(v.profiles)) return { profiles: v.profiles.filter(isProfile), autoApplyId: v.autoApplyId ?? null };
  } catch {
    /* storage unavailable or corrupt: start empty */
  }
  return { profiles: [], autoApplyId: null };
}

export function saveProfiles(s: ProfileStore): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: profiles last for this page only */
  }
}

function isProfile(p: unknown): p is Profile {
  return !!p && typeof (p as Profile).id === 'string' && typeof (p as Profile).name === 'string';
}

export const newId = () => Math.random().toString(36).slice(2, 10);

export interface Settings {
  gainLimit: number;
  dropPhoneOnAux: boolean;
  auxPriority: boolean;
}

export function loadSettings(): Settings {
  const d: Settings = { gainLimit: 40, dropPhoneOnAux: true, auxPriority: false };
  try {
    const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<Settings> | null;
    if (v) {
      if (typeof v.gainLimit === 'number' && v.gainLimit >= 0 && v.gainLimit <= 255) d.gainLimit = v.gainLimit;
      if (typeof v.dropPhoneOnAux === 'boolean') d.dropPhoneOnAux = v.dropPhoneOnAux;
      if (typeof v.auxPriority === 'boolean') d.auxPriority = v.auxPriority;
    }
  } catch {
    /* defaults */
  }
  return d;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
