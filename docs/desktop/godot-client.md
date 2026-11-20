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
│   │   ├── game_store.gd         — GameStore: текущий PlayerView, сигналы view_changed, event_received, peer_status_changed
│   │   ├── scene_router.gd       — SceneRouter: переходы между экранами
│   │   ├── settings.gd           — Settings: адрес сервера, громкость, доступность (ConfigFile user://)
│   │   ├── audio_director.gd     — AudioDirector: эмбиент по локации/периоду, стингеры
│   │   └── server_launcher.gd    — ServerLauncher: запуск встроенного сервера в релизе (INT-005)
│   ├── net/
│   │   ├── protocol_constants.gd — ProtocolConstants, СГЕНЕРИРОВАНО из @hs/protocol (не редактировать)
│   │   ├── envelope.gd           — сборка/разбор конверта
│   │   └── reconnect_policy.gd   — экспоненциальная задержка
│   ├── scenes/
│   │   ├── bootstrap.tscn        — стартовая сцена каркаса, показывает версию клиента
│   │   ├── main_menu/  new_game/  pairing/  exploration/  dialogue/
│   │   ├── case_board/  accusation/  ending/  hud/  overlays/ (evidence_capture, horror_fx, phone_status)
│   └── ui/                       — общие компоненты (кнопка действия со стоимостью, карточка улики)
├── assets/                       — арт, шрифты, звук (стиль — CNT-008)
└── tests/
    ├── unit/                     — GUT: reconnect_policy, envelope, qr_texture
    └── contract/
        ├── contract_support.gd         — пути к packages/protocol, чтение JSON, проверка формы по JSON Schema
        ├── test_protocol_constants.gd  — ProtocolConstants против схем и фикстур
        └── test_protocol_fixtures.gd   — все фикстуры, включая fixtures/views
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

## 3. Потоки данных

```
Backend (WS) ──view.update──▶ GameStore.set_view(view) ──signal view_changed──▶ сцены перерисовываются
Сцена (кнопка действия) ──▶ Backend.send_action(action) ──action.result──▶ GameStore (ошибки → тост)
Backend ──event──▶ GameStore.event_received ──▶ HUD/оверлеи/аудио
```

Сцены подписываются на сигналы `GameStore` и не обращаются к `Backend` напрямую, кроме
отправки действий через `GameStore.request_action()`.

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
  Новая фикстура без сопоставленной схемы роняет тест. `ProtocolConstants` сверяются со схемами
  (типы сообщений, событий, действий, коды ошибок, роли) и фикстурами (`v`, покрытие типов).
- Smoke: все сцены из `src/scenes` загружаются и инстанцируются без ошибок.
