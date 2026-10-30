# Session Server (`apps/server`)

Стек — [ADR 0003](../architecture/adr/0003-backend-stack.md). Протокол — [protocol.md](protocol.md).

## 1. Ответственность

- Создание и жизненный цикл игровых сессий; хостинг `GameEngine` на сессию.
- Привязка мобильного устройства (pairing), проверка принадлежности устройства сессии.
- WebSocket-шлюз: аутентификация, роли, heartbeat, порядок сообщений, возобновление.
- Сериализация действий: одна очередь на сессию — действия desktop и phone исполняются строго
  последовательно.
- Рассылка представлений (`PlayerView` → desktop, `PhoneView` → phone) и событий.
- Выпуск и проверка QR-токенов; генерация QR-матриц.
- Сохранения (автосохранение журнала действий), загрузка.
- Логирование и диагностика.

## 2. Модули

```
apps/server/src/
├── config/        — env: HS_PORT (7420), HS_HOST (0.0.0.0), HS_DATA_DIR, HS_DEBUG_TRUTH, HS_LOG_LEVEL
├── sessions/      — SessionManager, Session (engine, queue, clients, stateVersion, eventBuffer)
├── pairing/       — коды привязки, rate limit, токены устройств (хранятся хеши)
├── gateway/       — WS: hello/auth, роли, heartbeat, seq/ack, resume, маршрутизация сообщений
├── views/         — вычисление и рассылка view.update, фильтр событий по видимости
├── qr/            — payload pairing/evidence, HMAC, матрица QR, реализация EvidenceTokenPort
├── saves/         — запись журнала действий, чекпойнты, загрузка (ADR 0014)
├── diagnostics/   — /health, /debug (только HS_DEBUG_TRUTH), метрики сессии
└── app.ts         — сборка Fastify; server.ts — запуск
```

## 3. REST API (`/api/v1`)

| Метод и путь | Аутентификация | Тело / ответ | Ошибки |
|--------------|----------------|--------------|--------|
| `GET /health` | — | `{ status, version, protocolVersion }` | — |
| `GET /scenarios` | — | `[{ id, title, durationMinutes }]` | — |
| `GET /network` | — | `{ candidates: [{ address, interface, recommended }] }` — LAN-адреса для QR привязки | — |
| `POST /sessions` | — | `{ scenarioId, seed? }` → `{ sessionId, desktopToken, pairing: { code, expiresAt, qrPayload } }` | `SCENARIO_NOT_FOUND`, `GENERATION_UNSOLVABLE` |
| `POST /sessions/:id/pairing-code` | desktop | → новый `pairing` | `SESSION_NOT_FOUND` |
| `GET /sessions/:id/pairing-qr` | desktop | → `{ size, modules }` | |
| `GET /sessions/:id/evidence-qr/:tokenId` | desktop | → `{ size, modules }` | `QR_INVALID`, `QR_EXPIRED` |
| `POST /pair` | код привязки | `{ code, deviceName, appVersion, protocolVersion }` → `{ sessionId, deviceToken, wsPath }` | `PAIRING_CODE_INVALID`, `PAIRING_CODE_EXPIRED`, `PAIRING_RATE_LIMITED`, `PROTOCOL_MISMATCH` |
| `DELETE /sessions/:id/device` | desktop | отвязать телефон | |
| `GET /saves` | — (локальный сервер) | `[{ saveId, scenarioId, seed, updatedAt, gameTime }]` | |
| `POST /saves/:saveId/load` | — | → `{ sessionId, desktopToken, pairing }` | `SAVE_NOT_FOUND`, `SAVE_DESYNC` |
| `GET /sessions/:id/debug/truth` | desktop + `HS_DEBUG_TRUTH=1` | журнал истины | 404 если флаг выключен |

Аутентификация desktop — заголовок `Authorization: Bearer <desktopToken>`. Ошибки — формат
`{ error: { code, message } }`, HTTP 4xx/5xx.

## 4. Жизненный цикл сессии

```
created → (pairing) → active → (game over) → finished → (TTL 30 мин без клиентов) → disposed
                    ↘ suspended (desktop отключился > 60 с) → active (переподключение)
```

- Создание: генерация расследования (до 8 попыток; > 2 с — предупреждение в логе).
- Сессия хранит: `engine`, `actionQueue`, `stateVersion`, `eventSeq`, кольцевой буфер последних
  200 событий, токены (хеши), выпущенные QR-токены, привязку устройства.
- Действия исполняются по одному; при ошибке движка сессия помечается `faulted`, сохранение
  сохраняется, клиенты получают `INTERNAL` — это баг, а не игровое состояние.

## 5. Отключения и переподключения

- Heartbeat: клиент шлёт `ping` каждые 10 с; нет сообщений 30 с — соединение закрывается.
- Переподключение: `hello { role, token, resume: { lastSeq, stateVersion } }`. Если `lastSeq` в
  буфере — досылаются пропущенные события + актуальный `view.update`; иначе `resync` (полный снимок).
- Отключение телефона во время игры: игра не останавливается автоматически (время идёт только
  от действий), но Godot показывает статус «телефон отключён»; действия, требующие телефона, недоступны.
- Отключение desktop: сессия `suspended`, данные не теряются (автосохранение).

## 6. Логирование

- pino JSON; поля: `sessionId`, `role`, `msgType`, `durationMs`. Токены, коды и содержимое
  истины не логируются (кроме `HS_DEBUG_TRUTH`).
- Генерация логирует `seed`, `generatorVersion`, попытки, время стадий.

## 7. Тесты

- Fastify `inject` для REST; реальные `ws`-клиенты на случайном порту для WS-сценариев.
- Сценарии: создание сессии → привязка → hello обеих ролей → действие → оба получили `view.update`;
  неверный/просроченный/повторный код; rate limit; resume с буфером и без; повторный QR;
  QR чужой сессии; одновременные действия desktop и phone сериализуются.
