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
│   │   ├── protocol_constants.gd — СГЕНЕРИРОВАНО из @hs/protocol (не редактировать)
│   │   ├── envelope.gd           — сборка/разбор конверта
│   │   └── reconnect_policy.gd   — экспоненциальная задержка
│   ├── scenes/
│   │   ├── main_menu/  new_game/  pairing/  exploration/  dialogue/
│   │   ├── case_board/  accusation/  ending/  hud/  overlays/ (evidence_capture, horror_fx, phone_status)
│   └── ui/                       — общие компоненты (кнопка действия со стоимостью, карточка улики)
├── assets/                       — арт, шрифты, звук (стиль — CNT-008)
└── tests/
    ├── unit/                     — GUT: reconnect_policy, envelope, qr_texture
    └── contract/                 — разбор фикстур из packages/protocol/fixtures
```

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

- GUT headless в CI: `godot --headless --path apps/desktop -s addons/gut/gut_cmdln.gd -gdir=res://tests -gexit`.
- Контрактные тесты: каждый файл фикстур разбирается без ошибок, обязательные поля на месте.
- Smoke: все сцены из `src/scenes` загружаются и инстанцируются без ошибок.
