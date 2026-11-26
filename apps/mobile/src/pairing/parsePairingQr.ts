/** `hs1:pair:<host>:<port>:<code>` (ADR 0008 section 3, qr-mechanics.md section 1). */
export interface PairingTarget {
  host: string;
  port: number;
  code: string;
}

export type PairingQrRejection = 'expo-go' | 'evidence' | 'unknown';

export type PairingQrResult =
  { ok: true; target: PairingTarget } | { ok: false; reason: PairingQrRejection };

// Crockford Base32 without I, L, O, U: same alphabet as the server (apps/server/src/pairing).
const CODE = /^[0-9A-HJKMNP-TV-Z]{6}$/;
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]/g, '');
}

/** Validates the three parts; returns undefined when any is malformed. */
export function toPairingTarget(
  host: string,
  port: string,
  code: string,
): PairingTarget | undefined {
  const h = host.trim();
  const p = port.trim();
  const c = normalizeCode(code);
  if (!HOST.test(h) || h.length > 253 || !/^[0-9]{1,5}$/.test(p) || !CODE.test(c)) {
    return undefined;
  }
  const portNumber = Number(p);
  if (portNumber < 1 || portNumber > 65535) {
    return undefined;
  }
  return { host: h, port: portNumber, code: c };
}

export function parsePairingQr(raw: string): PairingQrResult {
  const text = raw.trim();
  if (/^exps?:\/\//i.test(text)) {
    return { ok: false, reason: 'expo-go' };
  }
  if (text.startsWith('hs1:ev:')) {
    return { ok: false, reason: 'evidence' };
  }
  const parts = text.split(':');
  if (parts.length !== 5 || parts[0] !== 'hs1' || parts[1] !== 'pair') {
    return { ok: false, reason: 'unknown' };
  }
  const target = toPairingTarget(parts[2] ?? '', parts[3] ?? '', parts[4] ?? '');
  // The code in a QR is canonical: lower case is not something the game can show.
  if (!target || parts[4] !== target.code) {
    return { ok: false, reason: 'unknown' };
  }
  return { ok: true, target };
}

/** Manual entry: "host:port" plus the code. */
export function parseManualEntry(address: string, code: string): PairingTarget | undefined {
  const m = /^([^:\s]+):([0-9]+)$/.exec(address.trim());
  return m ? toPairingTarget(m[1] ?? '', m[2] ?? '', code) : undefined;
}

export const QR_REJECTION_MESSAGES: Record<PairingQrRejection, string> = {
  'expo-go': 'Это QR Expo Go для разработчиков. Отсканируйте QR привязки на экране игры.',
  evidence:
    'Это QR улики. Его сканирует приложение «Камера» на телефоне героя, а не экран привязки.',
  unknown: 'Это не QR привязки Hollow Signal. Отсканируйте QR на экране привязки в игре.',
};
