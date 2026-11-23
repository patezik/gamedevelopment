import { FakeClient, type FakeClientOptions, type ServerMessageOf } from './client.ts';
import {
  createPairingCode,
  fetchEvidenceQr,
  pairPhone,
  revokePhone,
  type PairingCode,
  type QrMatrix,
} from './rest.ts';

function requireSession(client: FakeClient): string {
  if (client.sessionId === undefined) throw new Error('Connect first: the session id is not known');
  return client.sessionId;
}

/** The computer: authenticates with the session token, issues pairing codes, sends desktop actions. */
export class FakeDesktop extends FakeClient {
  readonly role = 'desktop';

  constructor(options: FakeClientOptions & { sessionId?: string }) {
    super(options);
    this.#knownSession = options.sessionId;
  }

  readonly #knownSession: string | undefined;

  #session(): string {
    return this.#knownSession ?? requireSession(this);
  }

  /** `POST /sessions/:id/pairing-code`. */
  createPairingCode(): Promise<PairingCode> {
    return createPairingCode(this.baseUrl, this.#session(), this.token);
  }

  /** `GET /sessions/:id/evidence-qr/:tokenId`: the matrix Godot would draw. */
  evidenceQr(tokenId: string): Promise<QrMatrix> {
    return fetchEvidenceQr(this.baseUrl, this.#session(), this.token, tokenId);
  }

  /** `DELETE /sessions/:id/device`: unpairs the phone. */
  unpairPhone(): Promise<undefined> {
    return revokePhone(this.baseUrl, this.#session(), this.token);
  }
}

export interface PairOptions {
  readonly baseUrl: string;
  readonly code: string;
  readonly deviceName?: string;
  readonly appVersion?: string;
  readonly timeoutMs?: number;
  readonly chaos?: FakeClientOptions['chaos'];
}

/** The phone: pairs by code (`POST /pair`), then authenticates with its device token. */
export class FakePhone extends FakeClient {
  readonly role = 'phone';

  constructor(options: FakeClientOptions) {
    super(options);
  }

  /** Pairs with a code shown on the desktop and returns a phone that is not yet connected. */
  static async pair({ baseUrl, code, deviceName, appVersion, timeoutMs, chaos }: PairOptions) {
    const version = appVersion ?? 'fake-client';
    const { deviceToken } = await pairPhone(baseUrl, code, deviceName ?? 'Fake phone', version);
    return new FakePhone({
      baseUrl,
      token: deviceToken,
      appVersion: version,
      ...(timeoutMs !== undefined && { timeoutMs }),
      ...(chaos !== undefined && { chaos }),
    });
  }

  /** Asks `desktop` for a pairing code and pairs with it. */
  static async pairWith(desktop: FakeDesktop, options: Omit<PairOptions, 'baseUrl' | 'code'> = {}) {
    const { code } = await desktop.createPairingCode();
    return FakePhone.pair({ baseUrl: desktop.baseUrl, code, ...options });
  }

  /** Sends the text of an evidence QR as the camera would and waits for `qr.result`. */
  async scanQr(raw: string): Promise<ServerMessageOf<'qr.result'>['payload']> {
    const result = this.waitFor('qr.result');
    this.send({ type: 'qr.scan', payload: { raw } });
    return (await result).payload;
  }
}
