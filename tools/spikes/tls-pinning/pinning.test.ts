import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSelfSigned, pinnedGet, type SelfSignedCert } from './pinning.ts';

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// openssl is a dev-machine tool used only to mint the prototype certificate.
describe.skipIf(!hasOpenssl())('TLS pinning prototype (INT-008)', () => {
  let cert: SelfSignedCert;
  let other: SelfSignedCert;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    cert = generateSelfSigned('127.0.0.1');
    other = generateSelfSigned('127.0.0.1');
    server = createServer({ key: cert.key, cert: cert.cert }, (_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('has a 43-char base64url fingerprint', () => {
    expect(cert.fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(other.fingerprint).not.toBe(cert.fingerprint);
  });

  it('connects when the pinned fingerprint matches', async () => {
    const res = await pinnedGet('127.0.0.1', port, '/', cert.fingerprint);
    expect(res).toMatchObject({ status: 200, body: 'ok' });
  });

  it('refuses a wrong fingerprint (MITM with another self-signed cert)', async () => {
    await expect(pinnedGet('127.0.0.1', port, '/', other.fingerprint)).rejects.toThrow(
      /pin mismatch/,
    );
  });

  it('measures full TLS connect+request latency on localhost (informational)', async () => {
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      samples.push((await pinnedGet('127.0.0.1', port, '/', cert.fingerprint)).elapsedMs);
    }
    samples.sort((a, b) => a - b);
    const median = samples[10] ?? 0;
    console.info(`TLS pinned GET on localhost: median ${median.toFixed(2)} ms`);
    expect(median).toBeLessThan(1000);
  });
});
