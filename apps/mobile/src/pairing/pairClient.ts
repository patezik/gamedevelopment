import { ERROR_CODES, PROTOCOL_VERSION, type ErrorCode } from '@hs/protocol';
import type { PairingTarget } from './parsePairingQr';

export interface PairedDevice {
  host: string;
  port: number;
  sessionId: string;
  deviceToken: string;
  wsPath: string;
}

export type PairFailure = ErrorCode | 'NETWORK' | 'BAD_RESPONSE';

export type PairResult = { ok: true; device: PairedDevice } | { ok: false; code: PairFailure };

export type FetchLike = (
  url: string,
  init: { method: 'POST' | 'DELETE'; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const PAIR_TIMEOUT_MS = 8000;

export const UNPAIR_TIMEOUT_MS = 3000;

export const DEVICE_NAME = 'Hollow Signal phone';

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/** POST /api/v1/pair. Sends only a fixed device name: nothing is read from the real phone. */
export async function pairDevice(
  target: PairingTarget,
  appVersion: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<PairResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAIR_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`http://${target.host}:${target.port}/api/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: target.code,
        deviceName: DEVICE_NAME,
        appVersion,
        protocolVersion: PROTOCOL_VERSION,
      }),
      signal: controller.signal,
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, code: 'BAD_RESPONSE' };
    }
    const record = (body ?? {}) as Record<string, unknown>;
    if (!response.ok) {
      const error = (record.error ?? {}) as Record<string, unknown>;
      return { ok: false, code: isErrorCode(error.code) ? error.code : 'BAD_RESPONSE' };
    }
    const { sessionId, deviceToken, wsPath } = record;
    if (
      typeof sessionId !== 'string' ||
      typeof deviceToken !== 'string' ||
      typeof wsPath !== 'string' ||
      !deviceToken
    ) {
      return { ok: false, code: 'BAD_RESPONSE' };
    }
    return {
      ok: true,
      device: { host: target.host, port: target.port, sessionId, deviceToken, wsPath },
    };
  } catch {
    return { ok: false, code: 'NETWORK' };
  } finally {
    clearTimeout(timer);
  }
}

const MESSAGES: Partial<Record<PairFailure, string>> = {
  PAIRING_CODE_INVALID: 'Код не подходит. Проверьте код на экране игры.',
  PAIRING_CODE_EXPIRED: 'Код истёк. Обновите код привязки в игре и повторите.',
  PAIRING_RATE_LIMITED: 'Слишком много попыток. Подождите минуту.',
  PROTOCOL_MISMATCH: 'Версии игры и приложения не совпадают. Обновите приложение.',
  NETWORK: 'Нет связи с игрой. Телефон и компьютер должны быть в одной сети Wi-Fi.',
  BAD_RESPONSE: 'Игра ответила непонятно. Проверьте адрес и повторите.',
};

export function pairErrorMessage(code: PairFailure): string {
  return MESSAGES[code] ?? 'Не удалось привязать телефон. Повторите попытку.';
}
