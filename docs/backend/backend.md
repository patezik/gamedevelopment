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

### Конфигурация

Сервер читает переменные окружения перед открытием порта и завершает запуск с ошибкой, если
значение не проходит проверку.

| Переменная | По умолчанию | Допустимые значения |
|------------|--------------|---------------------|
| `HS_PORT` | `7420` | Целое от 1 до 65535 |
| `HS_HOST` | `0.0.0.0` | Непустой адрес привязки или имя хоста |
| `HS_PUBLIC_HOST` | не задан | IPv4-адрес или имя хоста без порта (символы `A–Z a–z 0–9 . -`); отменяет определение LAN-адреса для QR |
| `HS_DATA_DIR` | `.hollow-signal` в домашнем каталоге | Непустой путь к каталогу данных |
| `HS_LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |
| `HS_DEBUG_TRUTH` | `0` | `0` выключает флаг, `1` включает |

Каркас сервера читает `HS_DATA_DIR` и `HS_DEBUG_TRUTH` при старте. С `HS_DEBUG_TRUTH=1` сервер при
запуске пишет предупреждение, а отладочные маршруты (§3, §6) регистрируются; без флага их нет вообще.

## 3. REST API (`/api/v1`)

| Метод и путь | Аутентификация | Тело / ответ | Ошибки |
|--------------|----------------|--------------|--------|
| `GET /health` | — | `{ status, version, protocolVersion }` | — |
| `GET /scenarios` | — | `[{ id, title, durationMinutes }]` | — |
| `GET /network` | — | `{ candidates: [{ address, interface, recommended, virtual }] }` — LAN-адреса для QR привязки, лучшие первыми; `virtual` — похож на Docker/WSL/VM/VPN (остаётся в списке, но ниже); `recommended` — не более одного; `HS_PUBLIC_HOST` идёт первым. Подробности — [setup.md §6](../development/setup.md) | — |
| `POST /sessions` | — | `{ scenarioId, seed? }` → `{ sessionId, desktopToken, pairing: { code, expiresAt, qrPayload } }` | `SCENARIO_NOT_FOUND`, `GENERATION_UNSOLVABLE` |
| `POST /sessions/:id/pairing-code` | desktop | → новый `pairing` | `SESSION_NOT_FOUND` |
| `GET /sessions/:id/pairing-qr` | desktop | → `{ size, modules }` текущего кода привязки (новый не выпускается) | `PAIRING_CODE_INVALID` (404, кода нет), `PAIRING_CODE_EXPIRED` (410) |
| `GET /sessions/:id/evidence-qr/:tokenId` | desktop | → `{ size, modules }` | `QR_INVALID` (404), `QR_EXPIRED` (410), `QR_ALREADY_USED` (409) |

Ответы обоих эндпоинтов QR несут `Cache-Control: no-store`: пока QR на экране, он как пароль. Токен
телефона для них не подходит (`UNAUTHORIZED`).
| `POST /pair` | код привязки | `{ code, deviceName, appVersion, protocolVersion }` → `{ sessionId, deviceToken, wsPath }` | `PAIRING_CODE_INVALID`, `PAIRING_CODE_EXPIRED`, `PAIRING_RATE_LIMITED`, `PROTOCOL_MISMATCH` |
| `DELETE /sessions/:id/device` | desktop | отвязать телефон | |
| `GET /saves` | — (локальный сервер) | `[{ saveId, scenarioId, seed, updatedAt, gameTime }]` | |
| `POST /saves/:saveId/load` | — | → `{ sessionId, desktopToken, pairing }` | `SAVE_NOT_FOUND`, `SAVE_DESYNC` |
| `GET /sessions/:id/debug/truth` | desktop + `HS_DEBUG_TRUTH=1` | `{ sessionId, scenarioId, seed, generatorVersion, minute, truth }`: журнал истины целиком | 404 если флаг выключен (маршрута нет); `UNAUTHORIZED`, `SESSION_NOT_FOUND`, 501 если движок сессии нельзя осмотреть |
| `GET /sessions/:id/debug/export` | desktop + `HS_DEBUG_TRUTH=1` | репро-пакет `{ format: "hollow-signal-repro", exportedAt, server, session, scenarioId, seed, generatorVersion, stateHash, snapshot }` | как у `debug/truth` |

Оба отладочных ответа содержат решение: они идут с `Cache-Control: no-store`, а каждое обращение
записывается в лог предупреждением (сессия, без содержимого).

Аутентификация desktop — заголовок `Authorization: Bearer <desktopToken>`. Ошибки — формат
`{ error: { code, message } }`, HTTP 4xx/5xx.

Приложение регистрирует маршруты при передаче сервиса привязки в buildApp.
При создании сессии SRV-002 выдаёт desktop-токен и первоначальный код через сервис привязки.
expiresAt — Unix-время в миллисекундах. При отзыве сервис удаляет хеш токена и передаёт
DEVICE_REVOKED обработчику шлюза (SRV-004).

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

- `SessionManager.create(scenarioId, seed)` получает расследование и входные порты движка
  через `InvestigationProvider`. Активация, подключение клиентов, действия и проверка
  TTL используют одну очередь сессии. Время TTL измеряется сервером в реальных
  миллисекундах, игровые минуты продвигает движок при действии.
- Успешное действие увеличивает `stateVersion`. События получают последовательные
  номера. Если запрошенный номер старше буфера, `eventsAfter` возвращает `null`
  для полной синхронизации. `sweep` освобождает завершённые сессии после TTL.

## 5. Отключения и переподключения

- Heartbeat: клиент шлёт `ping` каждые 10 с; нет сообщений 30 с — соединение закрывается.
- Переподключение: `hello { role, token, resume: { lastSeq, stateVersion } }`. Если `lastSeq` в
  буфере — досылаются пропущенные события + актуальный `view.update`; иначе `resync` (полный снимок).
- Отключение телефона во время игры: игра не останавливается автоматически (время идёт только
  от действий), но Godot показывает статус «телефон отключён»; действия, требующие телефона, недоступны.
- Отключение desktop: сессия `suspended`, данные не теряются (автосохранение).

## 6. Логирование

- Каркас пишет HTTP-метод, шаблон маршрута, статус и время ответа. Параметры URL, заголовки и тела
  запросов в эту запись не попадают. Для маршрутов сессии добавляется `sessionId` (только если значение
  имеет формат UUID).
- Сбой сервера (исключение без статуса или статус ≥ 500) пишется отдельной записью `request failed`
  уровня `error` с кодом `INTERNAL`. Текст исключения и стек могут содержать секреты и пропускаются.
  Отказы, вызванные клиентом (401,
  404, ошибки валидации), отдельной записи не получают: они видны статусом в строке ответа.
- pino JSON; поля: `sessionId`, `role`, `msgType`, `durationMs`. **Токены, коды и содержимое истины не
  логируются никогда**, в том числе при `HS_DEBUG_TRUTH=1`: отладочная истина отдаётся только ответом
  эндпоинта. Второй рубеж: pino заменяет на `[redacted]` значения полей `authorization`, `cookie`,
  `token`, `tokenId`, `deviceToken`, `desktopToken`, `pairingCode`, `sig`, `signature`, `secret`,
  `sessionSecret`, `password`, `raw`, `qrPayload` на любой глубине (до двух уровней вложенности), если
  кто-то залогирует объект с такими полями.
- Генерация логирует `seed`, `generatorVersion`, попытки, время стадий.

### Отладка и репро

- `GET /sessions/:id/debug/truth` и `GET /sessions/:id/debug/export` существуют только при
  `HS_DEBUG_TRUTH=1` и только для токена desktop. Без флага маршрутов нет, и ответ неотличим от
  ответа на любой неизвестный путь (404), в том числе для верного токена. Флага недостаточно: маршруты
  регистрируются, только если приложению переданы зависимости диагностики. В релизных сборках флаг
  должен игнорироваться ([truth-model.md §6](../investigation/truth-model.md)): это забота упаковки
  (INT-005), здесь признака релиза нет.
- **Экспорт репро** как команда: `HS_DESKTOP_TOKEN=<desktopToken> npm run export-repro -w @hs/server --
  <sessionId> [--url http://127.0.0.1:7420] [--out repro.json]`. Токен берётся только из окружения
  (командная строка видна другим процессам и попадает в историю оболочки), файл создаётся с правами
  `0600` на POSIX, потому что содержит решение. На Windows файл наследует ACL каталога назначения.
  `desktopToken` возвращает `POST /sessions`.
- Репро-пакет содержит снимок движка (сериализованное расследование вместе с истиной, минуту, локацию),
  хеш состояния, `seed`, `scenarioId`, `generatorVersion` и версии сервера и протокола.
  `GameEngine.restore(bundle.snapshot, investigation, ports)` даёт то же состояние (проверяется тестом).
  Истории действий в пакете пока нет: её добавит формат сохранения (SAVE-001).

## 7. Тесты

- Fastify `inject` для REST; реальные `ws`-клиенты на случайном порту для WS-сценариев.
- Сценарии: создание сессии → привязка → hello обеих ролей → действие → оба получили `view.update`;
  неверный/просроченный/повторный код; rate limit; resume с буфером и без; повторный QR;
  QR чужой сессии; одновременные действия desktop и phone сериализуются.
