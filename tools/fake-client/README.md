# @hs/fake-client — фейковые клиенты desktop и phone

Программные клиенты, которые говорят с настоящим сервером по REST и WebSocket так же, как Godot и
телефон ([protocol.md](../../docs/backend/protocol.md)). Нужны для интеграционных и E2E-тестов и для
ручной отладки без Godot и телефона. Новых зависимостей нет (`ws`, `@hs/protocol`).

Каждое входящее сообщение проверяется схемой `ServerMessage` из `@hs/protocol`. Нарушение контракта
записывается в `client.violations` и роняет все ожидающие `wait*`: сервер, нарушивший протокол, не
должен проходить тест.

## Библиотека

```ts
import { FakeDesktop, FakePhone } from '@hs/fake-client';

const desktop = new FakeDesktop({ baseUrl: 'http://127.0.0.1:7420', token, sessionId });
await desktop.connect(); // hello -> welcome; после обрыва — с resume
const phone = await FakePhone.pairWith(desktop); // pairing-code + POST /pair
await phone.connect();

const view = await desktop.waitForView(); // PlayerView
const result = await desktop.sendAction({ type: 'wait', minutes: 15 }); // action.result
const qr = await phone.scanQr(rawPayload); // qr.result
```

| Что | API |
|-----|-----|
| Соединение | `connect()`, `drop()` (обрыв без close frame), `reconnect()` (с `resume`), `close()` |
| Отправка | `sendAction(action)`, `scanQr(raw)` (phone), `ping()`, `send(message)`, `sendRaw(text)` для негативных тестов |
| Ожидание | `waitForView(predicate?)`, `waitForPeers(predicate)`, `waitFor(type, predicate?)`, `waitForClose()` |
| Состояние | `view`, `peers`, `events`, `messages`, `lastSeq`, `stateVersion`, `violations` |
| REST desktop | `createPairingCode()`, `evidenceQr(tokenId)`, `unpairPhone()` |
| REST phone | `FakePhone.pair({ baseUrl, code })`, `FakePhone.pairWith(desktop)` |

Сессию клиент не создаёт: REST-создания сессий в сервере пока нет, поэтому токен desktop и id сессии
передаёт тест (в тестах сервера их выдаёт `SessionManager` и `issueToken`). Готовый стенд с настоящим
приложением на случайном порту — [test/harness.ts](test/harness.ts) (`startServer()`).

### Случайные разрывы (chaos)

```ts
new FakeDesktop({
  baseUrl,
  token,
  chaos: { intervalMs: 50, dropProbability: 0.3, random: seededRandom, reconnectDelayMs: 10 },
});
```

Каждые `intervalMs` клиент с вероятностью `dropProbability` обрывает соединение и сам
переподключается с `resume` (`lastSeq`, `stateVersion`). Счётчики: `drops`, `reconnects`. Чтобы
прогон повторялся, передайте `random` с seed; по умолчанию `Math.random`. Во время обрыва ожидающие
`sendAction` и `wait*` падают с понятной ошибкой: тест решает, повторять ли запрос.

## CLI (REPL)

```bash
HS_TOKEN=<токен desktop> node tools/fake-client/src/cli.ts --role desktop --session <id> --url http://127.0.0.1:7420
node tools/fake-client/src/cli.ts --role phone     # затем: pair <код>, connect
```

Токен берётся только из переменной окружения `HS_TOKEN` (не из аргументов, чтобы не попасть в
историю шелла). CLI и REPL не печатают токены. Команды: `connect`, `status`, `view`, `events`,
`log [n]`, `action <json>`, `ping`, `drop`, `reconnect`, `code` и `unpair` (desktop), `pair <код>` и
`scan <raw>` (phone), `help`, `quit`.

## Тесты

`npm test -- tools/fake-client`: самопроверка против настоящего приложения (`buildApp`) на случайном
порту: привязка, hello, действия и запрет чужой роли, QR-скан, отзыв устройства, resume после обрыва,
chaos, нарушение протокола, REPL.
