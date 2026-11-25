// INT-008 spike (ADR 0018): TLS with a self-signed certificate pinned by a SHA-256 fingerprint
// carried in the pairing QR. Prototype only; not imported by product code.
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type TLSSocket } from 'node:tls';

export interface SelfSignedCert {
  readonly key: string;
  readonly cert: string;
  /** base64url SHA-256 of the DER certificate: 43 chars, goes into the pairing QR. */
  readonly fingerprint: string;
}

/** Fingerprint of a DER certificate, base64url without padding. */
export function fingerprintOfDer(der: Buffer): string {
  return createHash('sha256').update(der).digest('base64url');
}

/** Generates an ECDSA P-256 self-signed certificate (the host is put into subjectAltName). */
export function generateSelfSigned(host: string, days = 825): SelfSignedCert {
  const dir = mkdtempSync(join(tmpdir(), 'hs-pin-'));
  try {
    const san = /^[\d.]+$/.test(host) ? `IP:${host}` : `DNS:${host}`;
    execFileSync(
      'openssl',
      [
        ...['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'],
        ...['-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', String(days)],
        ...['-subj', '/CN=hollow-signal-session', '-addext', `subjectAltName=${san}`],
      ],
      { stdio: 'ignore' },
    );
    const cert = readFileSync(join(dir, 'c.pem'), 'utf8');
    return {
      key: readFileSync(join(dir, 'k.pem'), 'utf8'),
      cert,
      fingerprint: fingerprintOfDer(new X509Certificate(cert).raw),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Opens a TLS connection and verifies the pin BEFORE any application byte is written.
 *
 * Finding: Node skips `checkServerIdentity` when chain validation already failed (always the case for
 * a self-signed cert with rejectUnauthorized:false), so that hook cannot be used as the pin check.
 * The pin is therefore checked on `secureConnect`, and the verified socket is handed to the HTTP layer.
 */
export function pinnedConnect(host: string, port: number, fingerprint: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, rejectUnauthorized: false });
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      const actual = fingerprintOfDer(socket.getPeerCertificate().raw);
      if (actual !== fingerprint) {
        socket.destroy();
        reject(new Error(`certificate pin mismatch (got ${actual})`));
        return;
      }
      socket.removeListener('error', reject);
      resolve(socket);
    });
  });
}

/** HTTPS GET over a pinned connection; rejects when the certificate does not match `fingerprint`. */
export async function pinnedGet(
  host: string,
  port: number,
  path: string,
  fingerprint: string,
): Promise<{ status: number; body: string; elapsedMs: number }> {
  const t0 = process.hrtime.bigint();
  const socket = await pinnedConnect(host, port, fingerprint);
  return new Promise((resolve, reject) => {
    const req = request(
      { host, port, path, method: 'GET', createConnection: () => socket },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            elapsedMs: Number(process.hrtime.bigint() - t0) / 1e6,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}
