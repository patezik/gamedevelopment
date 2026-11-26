// Standalone fixture server for Expo Go. It serves only synthetic phone data.
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { ClientMessage, PhoneView, PROTOCOL_VERSION, ServerMessage } from '@hs/protocol';
import fixture from '@hs/protocol/fixtures/views/phone-view.glitch.json' with { type: 'json' };
import QRCode from 'qrcode';
import { WebSocket, WebSocketServer } from 'ws';

const port = 7421;
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const code = Array.from(randomBytes(6), (byte) => alphabet[byte % alphabet.length]).join('');
const deviceToken = randomUUID();
const sessionId = 'mob-011-preview';
const scanToken = 'hs1:ev:01234567:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA';
const sample = {
  id: 'preview-lake',
  title: 'Тестовый снимок: тропа к озеру',
  imageRef: 'loc_lake_path.dim.png',
  takenAt: 96,
  caption: 'Тропа к озеру',
};
const wallpapers = [
  'pine_forest',
  'pine_forest_noise',
  'pine_forest_static',
  'pine_forest_silhouette',
  'pine_forest_inverted',
  'pine_forest_dark',
];
const sampleQr = await QRCode.toDataURL(scanToken, { width: 300 });
let stateVersion = 1;
let view = PhoneView.parse({
  ...fixture,
  activeCall: undefined,
  notifications: [],
  gallery: [sample],
  effects: { glitchLevel: 0, wallpaperVariant: 'pine_forest' },
});

const phones = new Set();

function send(socket, type, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify(ServerMessage.parse({ v: PROTOCOL_VERSION, type, id: randomUUID(), payload })),
    );
  }
}

function controlPage() {
  const { glitchLevel, wallpaperVariant } = view.effects;
  const options = wallpapers.map(
    (variant) => `<option ${variant === wallpaperVariant ? 'selected' : ''}>${variant}</option>`,
  );
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>MOB-011</title>
  <h1>MOB-011 · Проверка эффектов</h1>
  <p>Привязка телефона: LAN-адрес компьютера, порт ${port}, код <strong>${code}</strong>.</p>
  <form method="post">
    <label>Уровень <input name="level" type="number" min="0" max="100" value="${glitchLevel}" required></label>
    <label>Обои <select name="wallpaper">${options.join('')}</select></label>
    <button>Отправить PhoneView</button>
  </form>
  <p>Тестовый QR для приложения «Камера».</p>
  <img src="${sampleQr}" alt="Тестовый QR улики">
  </html>`;
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request.setEncoding('utf8')) {
    body += chunk;
    if (body.length > 4096) throw new Error('Fixture request too large');
  }
  return body;
}

async function handleHttp(request, response) {
  if (request.method === 'POST' && request.url === '/api/v1/pair') {
    const pair = JSON.parse(await readBody(request));
    const error =
      pair?.protocolVersion !== PROTOCOL_VERSION
        ? 'PROTOCOL_MISMATCH'
        : pair.code !== code
          ? 'PAIRING_CODE_INVALID'
          : undefined;
    response.writeHead(error ? 400 : 200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify(
        error ? { error: { code: error } } : { sessionId, deviceToken, wsPath: '/ws' },
      ),
    );
    return;
  }

  if (request.url !== '/' || request.socket.remoteAddress !== '127.0.0.1') {
    response.writeHead(404).end();
    return;
  }
  if (request.method === 'POST') {
    const form = new URLSearchParams(await readBody(request));
    const next = PhoneView.safeParse({
      ...view,
      effects: {
        glitchLevel: Number(form.get('level') ?? NaN),
        wallpaperVariant: form.get('wallpaper'),
      },
    });
    if (!next.success || !wallpapers.includes(next.data.effects.wallpaperVariant)) {
      response.writeHead(400).end('Invalid effects fixture');
      return;
    }
    view = next.data;
    stateVersion += 1;
    for (const phone of phones) send(phone, 'view.update', { view, stateVersion });
    response.writeHead(303, { location: '/' }).end();
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(controlPage());
}

const server = createServer((request, response) => {
  void handleHttp(request, response).catch(() => response.writeHead(400).end('Invalid request'));
});
const sockets = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
sockets.on('connection', (socket) => {
  socket.on('error', () => socket.terminate());
  socket.on('close', () => phones.delete(socket));
  socket.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      socket.close(1008);
      return;
    }
    const parsed = ClientMessage.safeParse(data);
    if (!parsed.success || parsed.data.v !== PROTOCOL_VERSION) {
      socket.close(1008);
      return;
    }
    const message = parsed.data;
    if (!phones.has(socket)) {
      if (
        message.type !== 'hello' ||
        message.payload.role !== 'phone' ||
        message.payload.token !== deviceToken
      ) {
        socket.close(1008);
        return;
      }
      phones.add(socket);
      send(socket, 'welcome', {
        sessionId,
        stateVersion,
        role: 'phone',
        protocolVersion: PROTOCOL_VERSION,
        serverVersion: 'preview',
        lastSeq: 0,
      });
      send(socket, 'view.update', { view, stateVersion });
      return;
    }
    if (message.type === 'ping') send(socket, 'pong', {});
    if (message.type === 'qr.scan') {
      const result =
        message.payload.raw === scanToken
          ? { ok: true, clueRef: sample.id }
          : { ok: false, error: 'QR_INVALID' };
      send(socket, 'qr.result', result);
    }
  });
});
server.listen(port, '0.0.0.0', () => {
  console.log(`MOB-011 test controls: http://127.0.0.1:${port}/`);
});
