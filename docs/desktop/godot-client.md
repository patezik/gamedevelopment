# Godot Desktop Client (`apps/desktop`)

Стек — [ADR 0011](../architecture/adr/0011-godot-client-stack.md). Роль — [ADR 0002](../architecture/adr/0002-headless-game-core.md).

## 1. Ответственность

Godot отвечает за **игровой опыт**: отрисовку локаций, персонажей, предметов и улик; интерфейс
(доска дела, диалоги, HUD, обвинение, концовки); ввод; аудио; визуальные хоррор-эффекты;
показ QR привязки и QR улик; запуск локального сервера в релизе.

Godot **не** содержит игровых правил: не вычисляет стоимость действий, исходы, знания NPC.
Всё это приходит в `PlayerView`. Разрешено: визуальная интерпретация уже полученных значений
(искажение экрана по `sanity`, звук по `static`).

## 2. Структура проекта

```
apps/desktop/
├── project.godot                 — Godot 4.7; autoload; строгие предупреждения GDScript
├── addons/gut/                   — GUT 9.7.x (вендорено)
├── src/
│   ├── autoload/
│   │   ├── backend.gd            — Backend: REST (HTTPRequest) + WS (WebSocketPeer), очередь запросов, reconnect
│   │   ├── game_store.gd         — GameStore: текущий PlayerView, сигналы view_changed, event_received, peer_status_changed, action_failed
│   │   ├── scene_router.gd       — SceneRouter: переходы между экранами через затемнение
│   │   ├── settings.gd           — Settings: адрес сервера, громкость, доступность (ConfigFile user://)
│   │   ├── audio_director.gd     — AudioDirector: эмбиент по локации/периоду, стингеры
│   │   └── server_launcher.gd    — ServerLauncher: запуск встроенного сервера в релизе (INT-005)
│   ├── net/
│   │   ├── protocol_constants.gd — ProtocolConstants, СГЕНЕРИРОВАНО из @hs/protocol (не редактировать)
│   │   ├── envelope.gd           — сборка/разбор конверта
│   │   └── reconnect_policy.gd   — экспоненциальная задержка
│   ├── util/
│   │   └── read_only.gd          — глубокие read-only копии данных для экранов
│   ├── scenes/
│   │   ├── bootstrap.tscn        — стартовая сцена каркаса, показывает версию клиента
│   │   ├── main_menu/  new_game/  pairing/  exploration/  dialogue/
│   │   ├── case_board/  accusation/  ending/  hud/  overlays/ (evidence_capture, horror_fx, phone_status)
│   └── ui/                       — общие компоненты (кнопка действия со стоимостью, карточка улики)
├── assets/                       — арт, шрифты, звук (стиль — CNT-008)
└── tests/
    ├── unit/                     — GUT: reconnect_policy, envelope, GameStore, SceneRouter, qr_texture
    │   └── support/              — тестовые двойники (FakeBackend, экран-заглушка)
    └── contract/
        ├── contract_support.gd         — пути к packages/protocol, чтение JSON, проверка формы по JSON Schema
        ├── test_protocol_constants.gd  — ProtocolConstants против схем и фикстур
        ├── test_protocol_fixtures.gd   — все фикстуры, включая fixtures/views
        └── test_game_store_contract.gd — FORBIDDEN_VIEW_KEYS и фикстуры PlayerView против GameStore
```

### 2.1. Константы протокола

`src/net/protocol_constants.gd` (`class_name ProtocolConstants`) генерирует `npm run protocol:gen`
(`packages/protocol/scripts/godot.ts`) из тех же экспортов `@hs/protocol`, что и JSON Schema
([ADR 0009](../architecture/adr/0009-protocol-schemas.md)). Файл начинается с пометки
«СГЕНЕРИРОВАНО — не редактировать»; правка протокола — правка zod-схем и повторная генерация.

| Группа | Константы | Источник |
|--------|-----------|----------|
| Версия | `PROTOCOL_VERSION: int` | `PROTOCOL_VERSION` |
| Сообщения | `MSG_*`, `CLIENT_MESSAGE_TYPES`, `SERVER_MESSAGE_TYPES` | `ClientMessage`, `ServerMessage` |
| События `event` | `EVENT_*`, `EVENT_TYPES` | `ClientEvent` |
| Ошибки | `ERROR_*`, `ERROR_CODES` | `ERROR_CODES` |
| Роли | `ROLE_*`, `ROLES` | ключи `ACTIONS_BY_ROLE` |
| Действия | `ACTION_*`, `ACTION_TYPES`, `DESKTOP_ACTIONS`, `PHONE_ACTIONS`, `ACTIONS_BY_ROLE` | `PlayerAction`, `ACTIONS_BY_ROLE` |

Имена — `UPPER_SNAKE_CASE` от значения (`action.request` → `MSG_ACTION_REQUEST`,
`examineLocation` → `ACTION_EXAMINE_LOCATION`), значения — строки протокола как есть. Порядок
констант совпадает с порядком объявления в `@hs/protocol`, вывод детерминирован (LF, отступы
табуляцией). Списки — `Array[String]` только для чтения; `ACTIONS_BY_ROLE` — `Dictionary`
роль → `Array[String]`.

Актуальность файла проверяют `npm run protocol:check` и тест `packages/protocol/test/godot.test.ts`
(в CI — в job «Lint, types and tests»): ручная правка или забытая регенерация роняют проверку.
Фильтр `NODE_PATHS` в `.github/workflows/ci.yml` явно включает этот файл, чтобы PR, меняющий только
его, тоже запускал Node job; это фиксирует `packages/protocol/test/ci-paths.test.ts`.

## 3. Потоки данных

```
Backend (WS) ──view.update──▶ GameStore.set_view(view, stateVersion) ──signal view_changed──▶ сцены перерисовываются
Сцена (кнопка действия) ──▶ GameStore.request_action(action) ──▶ Backend.send_action ──action.result──▶ GameStore.action_failed (ошибки → тост)
Backend ──event──▶ GameStore.event_received ──▶ HUD/оверлеи/аудио
```

Сцены подписываются на сигналы `GameStore` и не обращаются к `Backend` напрямую, кроме
отправки действий через `GameStore.request_action()`.

`Backend.request_rest` возвращает ID запроса и последовательно выполняет запросы с
таймаутом в 10 секунд. Результат приходит через `rest_completed`; при наличии токена
клиент передаёт его в заголовке `Authorization`.

`Backend.connect_session(url, token)` начинает с `hello`. После `welcome` можно вызывать
`send_action`. `message_received` передаёт сообщения с корректным конвертом,
`connection_state_changed` сообщает этап подключения. После обрыва клиент повторяет
`hello` с последним обработанным `seq` и версией представления. Таймеры подключения
и heartbeat используют время работы клиента в процессе, отдельно от игровых часов.

### 3.1. GameStore

`GameStore` — единственная клиентская копия `PlayerView`. Все словари, которые он отдаёт
(`get_view()`, параметры `view_changed` и `event_received`), — глубокие read-only копии: экран
не может изменить общее состояние.

| API | Поведение |
|-----|-----------|
| `set_view(view, state_version) -> bool` | Принимает представление, только если `state_version` больше текущей; устаревшая и совпадающая версии игнорируются без сигнала. Первое представление после `resync` принимается при любой версии. Представление с ключом из `FORBIDDEN_VIEW_KEYS` (`veracity`, `culpritIds`, `truth`, `hallucination` — зеркало `@hs/protocol`) отвергается с `push_error` |
| `view_changed(view, state_version)` | новое принятое представление |
| `event_received(event)` | `ClientEvent` из сообщения `event` известного типа |
| `peer_status_changed(desktop, phone)` | изменение `peer.status`; до первого сообщения сессии — `unknown` |
| `action_failed(code, message)` | действие отвергнуто: локально (`ACTION_INVALID` — не действие desktop; `NOT_CONNECTED` — нет живого соединения), `action.result` с `ok: false` или `error` с `requestId` |
| `error_received(code, message)` | `error` без `requestId` (например, `UNAUTHORIZED` при рукопожатии) |
| `connection_state_changed(state)` | этап подключения `Backend`; `OFFLINE` (только после `disconnect_session`) очищает представление, версию и статус пиров |
| `request_action(action) -> Error` | отправляет копию действия через `Backend.send_action`; исход решает сервер |

Повторная доставка `view.update` после переподключения безопасна: версия не растёт — сигнала нет.

### 3.2. SceneRouter

`SceneRouter.goto(screen, params = {}) -> Error` ищет экран в реестре `SCREENS` (id → путь сцены;
задачи экранов добавляют туда свои записи), закрывает экран чёрной шторкой (`fade_seconds`,
по умолчанию 0,25 с реального времени; во время перехода шторка блокирует ввод), заменяет
текущую сцену и открывает шторку. Экран получает read-only копию `params` через необязательный
метод `set_params(params: Dictionary)` до своего `_ready`; текущие значения — `get_current_screen()`
и `get_current_params()`.

- Неизвестный экран → `ERR_DOES_NOT_EXIST`, `push_error`, `transition_failed(screen, "unknown_screen")`.
- `params` должны быть простыми данными: объект на любой глубине → `ERR_INVALID_PARAMETER`,
  `transition_failed(screen, "invalid_params")`.
- Ошибка загрузки сцены → `transition_failed(screen, "load_failed")`, текущий экран остаётся.
- Во время перехода новый запрос ставится в очередь и выполняется сразу после текущего;
  из нескольких запросов в очереди выполняется последний. Повтор уже ожидаемого перехода
  (тот же экран и те же параметры) → `ERR_BUSY`.
- Сигналы: `transition_started(screen)`, `screen_changed(screen, params)`, `transition_failed(screen, reason)`.

## 4. Экраны

| Экран | Содержимое |
|-------|-----------|
| MainMenu | Новая игра, Продолжить (если есть сохранение), Настройки, Выход |
| NewGame | выбор сценария, seed (случайный / ввод), создание сессии |
| Pairing | QR привязки (из матрицы), код, адрес сервера, статус телефона, помощь по сети |
| Exploration | иллюстрация локации, точки интереса, персонажи, выходы, действия со стоимостью |
| Dialogue | темы, ответы, предъявление улик/противоречий |
| CaseBoard | улики, показания, противоречия, персоны интереса, отметки подозрений, хронология |
| Accusation | выбор обвиняемого, мотив/средство/возможность, улики, двойное подтверждение |
| Ending | концовка, разбор истины (`TruthRecap`), seed, статистика |
| HUD (оверлей) | часы/день/период, остаток времени, здоровье/рассудок/усталость, Static, статус телефона |

## 5. Стиль кода

- Строгая типизация во всех скриптах; `class_name` для переиспользуемых классов.
- Сигналы — `snake_case` в прошедшем времени (`view_changed`, `action_failed`).
- Никаких магических строк типов сообщений — только `ProtocolConstants`.
- Сцены не знают друг о друге; переходы — через `SceneRouter`.

## 6. Тесты

- `npm run test:godot` импортирует проект и запускает GUT из `tests/unit` и `tests/contract`.
  Процесс завершится с ошибкой при падении теста, ошибке компиляции или загрузки скрипта,
  а также если GUT не запустил ни одного теста.
- GitHub Actions запускает ту же команду при изменениях desktop, протокола или конфигурации запуска тестов.
- Контрактные тесты (`tests/contract`): каждый `*.json` из `packages/protocol/fixtures`, включая
  `fixtures/views`, разбирается без ошибок и соответствует форме своей схемы из
  `packages/protocol/schemas` — обязательные и неизвестные поля, JSON-типы, `const`, `enum`,
  варианты `oneOf`/`anyOf` (диапазоны и длины не проверяются: полная валидация — на сервере).
  Новая фикстура без сопоставленной схемы роняет тест. Массивом примеров могут быть только
  фикстуры-коллекции (`client-messages.json`, `server-messages.json`); остальные, в том числе
  `PlayerView` и `PhoneView`, проверяются как один JSON-объект. `ProtocolConstants` сверяются со схемами
  (типы сообщений, событий, действий, коды ошибок, роли) и фикстурами (`v`, покрытие типов).
- Smoke: все сцены из `src/scenes` загружаются и инстанцируются без ошибок.
