import { PROTOCOL_VERSION } from '@hs/protocol';
import { pairDevice, pairErrorMessage, type FetchLike } from '../src/pairing/pairClient';
import { parseManualEntry, parsePairingQr } from '../src/pairing/parsePairingQr';

describe('parsePairingQr', () => {
  test('accepts a valid pairing QR', () => {
    expect(parsePairingQr('hs1:pair:192.168.1.5:7420:ABC123')).toEqual({
      ok: true,
      target: { host: '192.168.1.5', port: 7420, code: 'ABC123' },
    });
    expect(parsePairingQr(' hs1:pair:game-pc.local:1:0Z9XYZ ')).toMatchObject({ ok: true });
  });

  test.each([
    ['exp://192.168.1.5:8081', 'expo-go'],
    ['exps://u.expo.dev/abc', 'expo-go'],
    ['hs1:ev:0a1b2c3d:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA', 'evidence'],
    ['https://example.com', 'unknown'],
    ['', 'unknown'],
    ['hs1:pair:host:7420', 'unknown'],
    ['hs1:pair:host:7420:ABC123:extra', 'unknown'],
    ['hs2:pair:host:7420:ABC123', 'unknown'],
    ['hs1:pair::7420:ABC123', 'unknown'],
    ['hs1:pair:host:0:ABC123', 'unknown'],
    ['hs1:pair:host:65536:ABC123', 'unknown'],
    ['hs1:pair:host:74x0:ABC123', 'unknown'],
    ['hs1:pair:host:7420:ABC12', 'unknown'],
    ['hs1:pair:host:7420:ABCI23', 'unknown'],
    ['hs1:pair:host:7420:abc123', 'unknown'],
    ['hs1:pair:ho st:7420:ABC123', 'unknown'],
  ])('rejects %s', (raw, reason) => {
    expect(parsePairingQr(raw)).toEqual({ ok: false, reason });
  });
});

describe('parseManualEntry', () => {
  test('accepts host:port and a code in any case', () => {
    expect(parseManualEntry(' 10.0.0.2:7420 ', 'abc 123')).toEqual({
      host: '10.0.0.2',
      port: 7420,
      code: 'ABC123',
    });
  });

  test.each([
    ['10.0.0.2', 'ABC123'],
    ['10.0.0.2:99999', 'ABC123'],
    ['10.0.0.2:7420', 'ABC12'],
    ['10.0.0.2:7420', 'ABCO23'],
    [':7420', 'ABC123'],
  ])('rejects %s / %s', (address, code) => {
    expect(parseManualEntry(address, code)).toBeUndefined();
  });
});

const target = { host: '10.0.0.2', port: 7420, code: 'ABC123' };

function reply(status: number, body: unknown): FetchLike {
  return jest.fn(async () => ({ ok: status < 400, status, json: async () => body }));
}

describe('pairDevice', () => {
  test('posts the pairing request and returns the device', async () => {
    const fetchMock = reply(200, { sessionId: 's1', deviceToken: 'tok', wsPath: '/ws' });
    const result = await pairDevice(target, '1.2.3', fetchMock);
    expect(result).toEqual({
      ok: true,
      device: { host: '10.0.0.2', port: 7420, sessionId: 's1', deviceToken: 'tok', wsPath: '/ws' },
    });
    const [url, init] = (fetchMock as jest.Mock).mock.calls[0];
    expect(url).toBe('http://10.0.0.2:7420/api/v1/pair');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      code: 'ABC123',
      deviceName: 'Hollow Signal phone',
      appVersion: '1.2.3',
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  test.each([
    'PAIRING_CODE_INVALID',
    'PAIRING_CODE_EXPIRED',
    'PAIRING_RATE_LIMITED',
    'PROTOCOL_MISMATCH',
  ])('maps server error %s', async (code) => {
    const result = await pairDevice(target, '1', reply(400, { error: { code, message: 'x' } }));
    expect(result).toEqual({ ok: false, code });
    expect(pairErrorMessage(code as never)).not.toMatch(/Не удалось привязать/);
  });

  test('unknown error code and malformed bodies become BAD_RESPONSE', async () => {
    expect(await pairDevice(target, '1', reply(500, { error: { code: 'WHAT' } }))).toEqual({
      ok: false,
      code: 'BAD_RESPONSE',
    });
    expect(await pairDevice(target, '1', reply(200, { sessionId: 's1' }))).toEqual({
      ok: false,
      code: 'BAD_RESPONSE',
    });
    expect(
      await pairDevice(target, '1', reply(200, { sessionId: 's', deviceToken: '', wsPath: '/ws' })),
    ).toEqual({
      ok: false,
      code: 'BAD_RESPONSE',
    });
  });

  test('network failure becomes NETWORK', async () => {
    const failing: FetchLike = async () => {
      throw new TypeError('Network request failed');
    };
    expect(await pairDevice(target, '1', failing)).toEqual({ ok: false, code: 'NETWORK' });
  });
});
