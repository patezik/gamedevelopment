import { PROTOCOL_VERSION } from '@hs/protocol';

/** An error answer of the server's REST API: `{ error: { code, message } }`. */
export class FakeClientHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(`${status} ${code}: ${message}`);
    this.name = 'FakeClientHttpError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(
  baseUrl: string,
  method: string,
  path: string,
  { token, body }: { token?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(new URL(`/api/v1${path}`, baseUrl), {
    method,
    headers: {
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...(token !== undefined && { authorization: `Bearer ${token}` }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const json: unknown = text === '' ? undefined : JSON.parse(text);
  if (!response.ok) {
    const error = (json as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
    throw new FakeClientHttpError(
      response.status,
      typeof error?.code === 'string' ? error.code : 'UNKNOWN',
      typeof error?.message === 'string' ? error.message : response.statusText,
    );
  }
  return json as T;
}

export interface PairingCode {
  readonly code: string;
  readonly expiresAt: number;
  readonly qrPayload: string;
}

export interface QrMatrix {
  readonly size: number;
  readonly modules: string;
}

const sessionPath = (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}`;

/** `POST /sessions/:id/pairing-code` (desktop token). */
export const createPairingCode = (baseUrl: string, sessionId: string, desktopToken: string) =>
  request<PairingCode>(baseUrl, 'POST', `${sessionPath(sessionId)}/pairing-code`, {
    token: desktopToken,
  });

/** `GET /sessions/:id/evidence-qr/:tokenId` (desktop token). */
export const fetchEvidenceQr = (
  baseUrl: string,
  sessionId: string,
  desktopToken: string,
  tokenId: string,
) =>
  request<QrMatrix>(
    baseUrl,
    'GET',
    `${sessionPath(sessionId)}/evidence-qr/${encodeURIComponent(tokenId)}`,
    { token: desktopToken },
  );

/** `DELETE /sessions/:id/device` (desktop or the paired phone's own token): unpair the phone. */
export const revokePhone = (baseUrl: string, sessionId: string, desktopToken: string) =>
  request<undefined>(baseUrl, 'DELETE', `${sessionPath(sessionId)}/device`, {
    token: desktopToken,
  });

/** `POST /pair`: what the phone does after it scans the pairing QR. */
export const pairPhone = (
  baseUrl: string,
  code: string,
  deviceName: string,
  appVersion: string,
  protocolVersion: number = PROTOCOL_VERSION,
) =>
  request<{ sessionId: string; deviceToken: string; wsPath: string }>(baseUrl, 'POST', '/pair', {
    body: { code, deviceName, appVersion, protocolVersion },
  });
