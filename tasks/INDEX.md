# Индекс задач

> Файл сгенерирован `npm run tasks:index`. Не редактируйте вручную — источник истины в `tasks/<ID>.md`.

Всего задач: **140** · todo: 138 · in_progress: 0 · review: 1 · done: 1 · blocked: 0

## Готовы к взятию сейчас

- [FND-003](FND-003.md) — CI: Node-задачи (lint, typecheck, test, coverage) с фильтрами путей (P0, S)
- [FND-004](FND-004.md) — Пакет @hs/protocol: конверт, ErrorCode, версия, экспорт JSON Schema (P0, M)
- [FND-007](FND-007.md) — Каркас Godot-проекта apps/desktop (Godot 4.7.2, строгий GDScript) (P0, S)

## Критический путь

Самая длинная цепочка незавершённых зависимостей — задержка любой из этих задач сдвигает MVP и последующие фазы:

[FND-009](FND-009.md) → [CORE-002](CORE-002.md) → [CNT-001](CNT-001.md) → [CHAR-001](CHAR-001.md) → [TRUTH-001](TRUTH-001.md) → [TRUTH-002](TRUTH-002.md) → [CORE-003](CORE-003.md) → [GEN-001](GEN-001.md) → [GEN-003](GEN-003.md) → [GEN-004](GEN-004.md) → [GEN-005](GEN-005.md) → [GEN-006](GEN-006.md) → [GEN-007](GEN-007.md) → [GEN-008](GEN-008.md) → [GEN-009](GEN-009.md) → [GEN-010](GEN-010.md) → [GEN-011](GEN-011.md) → [SRV-002](SRV-002.md) → [GDT-003](GDT-003.md) → [INT-001](INT-001.md) → [INT-003](INT-003.md) → [INT-004](INT-004.md) → [CNT-008](CNT-008.md)

## Самые блокирующие задачи

| Задача | Блокирует напрямую |
|---|---|
| [TRUTH-002](TRUTH-002.md) TruthLog, TruthModel и IncidentRecord | 7 |
| [CNT-001](CNT-001.md) Схемы контента сценариев (zod) и загрузчик @hs/core/content | 6 |
| [ENG-001](ENG-001.md) GameEngine: агрегат состояния, dispatch, действия move и wait | 6 |
| [ENG-004](ENG-004.md) Действия телефона: звонки, сообщения, браузер, файлы, заметки, фиксация улик | 6 |
| [MOB-003](MOB-003.md) WebSocket-клиент и сторы Zustand: hello/resume, backoff, offline | 6 |
| [WORLD-002](WORLD-002.md) Предметы, контейнеры и история их перемещений | 6 |
| [ENG-003](ENG-003.md) Действия desktop: осмотр, разговор, допрос, чтение, предметы, замки, отдых | 5 |
| [EVD-002](EVD-002.md) Улики (Clue): поддерживаемые утверждения, условия обнаружения, точки интереса | 5 |
| [GDT-002](GDT-002.md) Autoload GameStore и SceneRouter | 5 |
| [GDT-004](GDT-004.md) Сцена Exploration: локация, точки интереса, выходы, действия со стоимостью | 5 |
| [INV-002](INV-002.md) Утверждения (Claims) и правила дедукции | 5 |
| [KNOW-002](KNOW-002.md) LiePolicy и показания: answer(question) → правда, ошибка или ложь | 5 |

## Фаза 1 · M1 — Foundation ready (10)

| ID | Задача | P | C | Статус | Исполнитель | Зависит от |
|---|---|---|---|---|---|---|
| [FND-001](FND-001.md) | Корневой TypeScript-тулчейн: TS 6, ESLint 10, Prettier, Vitest 5 | P0 | M | done | claude-foundation-1 | — |
| [FND-002](FND-002.md) | ESLint-правила детерминизма и границ импорта | P0 | S | todo | — | [FND-001](FND-001.md), [FND-009](FND-009.md) |
| [FND-003](FND-003.md) | CI: Node-задачи (lint, typecheck, test, coverage) с фильтрами путей | P0 | S | todo | — | [FND-001](FND-001.md) |
| [FND-004](FND-004.md) | Пакет @hs/protocol: конверт, ErrorCode, версия, экспорт JSON Schema | P0 | M | todo | — | [FND-001](FND-001.md) |
| [FND-005](FND-005.md) | Каркас apps/server: Fastify 5, конфигурация, /health, логирование | P0 | M | todo | — | [FND-001](FND-001.md), [FND-004](FND-004.md) |
| [FND-006](FND-006.md) | Bootstrap apps/mobile: Expo SDK 58, Expo Router, TypeScript, jest-expo | P0 | M | todo | — | [FND-001](FND-001.md), [FND-004](FND-004.md) |
| [FND-007](FND-007.md) | Каркас Godot-проекта apps/desktop (Godot 4.7.2, строгий GDScript) | P0 | S | todo | — | — |
| [FND-008](FND-008.md) | GUT 9.7.x, headless-запуск тестов Godot и CI-job | P0 | M | todo | — | [FND-007](FND-007.md), [FND-003](FND-003.md) |
| [FND-009](FND-009.md) | Каркасы пакетов @hs/core, @hs/generator, @hs/validator | P0 | S | review | claude-foundation-1 | [FND-001](FND-001.md) |
| [FND-010](FND-010.md) | Оркестрация разработки и проверка setup.md на чистой машине | P1 | S | todo | — | [FND-005](FND-005.md), [FND-006](FND-006.md), [FND-008](FND-008.md) |

## Фаза 2 · M2 — Core runtime (24)

| ID | Задача | P | C | Статус | Исполнитель | Зависит от |
|---|---|---|---|---|---|---|
| [CHAR-001](CHAR-001.md) | Модель персонажа: личность, биография, цели, страхи, доступы | P0 | M | todo | — | [CNT-001](CNT-001.md) |
| [CHAR-002](CHAR-002.md) | Граф отношений: типы, доверие, валентность, история | P0 | S | todo | — | [CHAR-001](CHAR-001.md) |
| [CHAR-003](CHAR-003.md) | Расписания и рутины: whereShouldBe, переопределения | P0 | M | todo | — | [CHAR-001](CHAR-001.md), [WORLD-001](WORLD-001.md) |
| [CNT-001](CNT-001.md) | Схемы контента сценариев (zod) и загрузчик @hs/core/content | P0 | L | todo | — | [CORE-002](CORE-002.md) |
| [CORE-001](CORE-001.md) | Детерминированный PRNG sfc32 с подпотоками fork(label) | P0 | M | todo | — | [FND-009](FND-009.md) |
| [CORE-002](CORE-002.md) | Канонический JSON, хеширование состояния и генерация ID | P0 | S | todo | — | [FND-009](FND-009.md) |
| [CORE-003](CORE-003.md) | Тип Investigation и fixture-builder мини-сценария «tiny-manor» | P0 | M | todo | — | [TRUTH-002](TRUTH-002.md), [CHAR-003](CHAR-003.md), [WORLD-002](WORLD-002.md) |
| [ENG-001](ENG-001.md) | GameEngine: агрегат состояния, dispatch, действия move и wait | P0 | M | todo | — | [TIME-003](TIME-003.md), [TIME-004](TIME-004.md), [WORLD-001](WORLD-001.md), [TRUTH-002](TRUTH-002.md), [CORE-003](CORE-003.md) |
| [ENG-002](ENG-002.md) | Проекция PlayerView и тест отсутствия утечек истины | P0 | M | todo | — | [ENG-001](ENG-001.md), [PROTO-002](PROTO-002.md) |
| [KNOW-001](KNOW-001.md) | KnowledgeStore: убеждения, источники, память с размытием | P0 | M | todo | — | [TRUTH-001](TRUTH-001.md) |
| [PROTO-001](PROTO-001.md) | Каталог сообщений протокола (hello, welcome, action, event, qr, error) | P0 | M | todo | — | [FND-004](FND-004.md) |
| [PROTO-002](PROTO-002.md) | Схемы PlayerView и PhoneView с фикстурами | P0 | M | todo | — | [PROTO-001](PROTO-001.md) |
| [SAVE-001](SAVE-001.md) | Формат сохранения и replay с проверкой хеша | P1 | M | todo | — | [ENG-001](ENG-001.md), [CORE-001](CORE-001.md) |
| [SIM-001](SIM-001.md) | SimulationRunner: исполнение рутин NPC через Scheduler | P0 | M | todo | — | [CHAR-003](CHAR-003.md), [TIME-003](TIME-003.md), [TRUTH-002](TRUTH-002.md) |
| [SIM-002](SIM-002.md) | Восприятие: наблюдения присутствующих → убеждения | P0 | M | todo | — | [SIM-001](SIM-001.md), [KNOW-001](KNOW-001.md) |
| [TIME-001](TIME-001.md) | GameMinutes и Calendar: дни, часы, периоды суток | P0 | S | todo | — | [FND-009](FND-009.md) |
| [TIME-002](TIME-002.md) | Scheduler: детерминированная очередь событий | P0 | M | todo | — | [TIME-001](TIME-001.md), [CORE-002](CORE-002.md) |
| [TIME-003](TIME-003.md) | TimeSystem.advance: фазы обработки, прерывания, события часов | P0 | M | todo | — | [TIME-002](TIME-002.md) |
| [TIME-004](TIME-004.md) | ActionCostTable и resolveActionCost с модификаторами | P0 | S | todo | — | [TIME-001](TIME-001.md), [CNT-001](CNT-001.md) |
| [TRUTH-001](TRUTH-001.md) | Словарь фактов (Fact) и FactId | P0 | S | todo | — | [CORE-002](CORE-002.md), [CHAR-001](CHAR-001.md), [WORLD-001](WORLD-001.md) |
| [TRUTH-002](TRUTH-002.md) | TruthLog, TruthModel и IncidentRecord | P0 | M | todo | — | [TRUTH-001](TRUTH-001.md) |
| [TRUTH-003](TRUTH-003.md) | Проверка инвариантов Truth Model | P0 | S | todo | — | [TRUTH-002](TRUTH-002.md), [WORLD-002](WORLD-002.md) |
| [WORLD-001](WORLD-001.md) | Граф локаций: перемещения, освещение, доступ по часам и замкам | P0 | M | todo | — | [TIME-001](TIME-001.md), [CNT-001](CNT-001.md) |
| [WORLD-002](WORLD-002.md) | Предметы, контейнеры и история их перемещений | P0 | S | todo | — | [WORLD-001](WORLD-001.md) |

## Фаза 3 · M3 — Generator produces worlds (12)

| ID | Задача | P | C | Статус | Исполнитель | Зависит от |
|---|---|---|---|---|---|---|
| [CNT-002](CNT-002.md) | MVP-сценарий: локации, предметы, архетипы, отношения (данные) | P0 | L | todo | — | [CNT-001](CNT-001.md) |
| [CNT-003](CNT-003.md) | MVP-сценарий: шаблоны преступлений и правила мотивов | P0 | M | todo | — | [CNT-002](CNT-002.md) |
| [GEN-001](GEN-001.md) | Каркас конвейера генерации: стадии, подпотоки, отчёт, GENERATOR_VERSION | P0 | M | todo | — | [CORE-001](CORE-001.md), [CNT-001](CNT-001.md), [CORE-003](CORE-003.md) |
| [GEN-002](GEN-002.md) | Стадия WorldGen: локации, предметы, варианты из пресета | P0 | S | todo | — | [GEN-001](GEN-001.md), [WORLD-002](WORLD-002.md) |
| [GEN-003](GEN-003.md) | Стадия CastGen: персонажи из архетипов, личность, биография, имена | P0 | M | todo | — | [GEN-001](GEN-001.md), [CHAR-001](CHAR-001.md), [CHAR-003](CHAR-003.md) |
| [GEN-004](GEN-004.md) | Стадия SocialGen: отношения и секреты | P0 | M | todo | — | [GEN-003](GEN-003.md), [CHAR-002](CHAR-002.md), [TRUTH-001](TRUTH-001.md) |
| [GEN-005](GEN-005.md) | Стадия ConflictGen: правила мотивов для всех пар персонажей | P0 | M | todo | — | [GEN-004](GEN-004.md) |
| [GEN-006](GEN-006.md) | Стадия IncidentSelection: жертва, шаблон, виновник из всех допустимых | P0 | L | todo | — | [GEN-005](GEN-005.md), [GEN-002](GEN-002.md) |
| [GEN-007](GEN-007.md) | Стадия PlotPlanning: план виновника, окно возможности, изгиб расписания | P0 | L | todo | — | [GEN-006](GEN-006.md), [TRUTH-002](TRUTH-002.md) |
| [GEN-008](GEN-008.md) | Стадия HistorySimulation: симуляция предыстории с исполнением плана | P0 | L | todo | — | [GEN-007](GEN-007.md), [SIM-002](SIM-002.md), [SIM-003](SIM-003.md), [SIM-004](SIM-004.md) |
| [SIM-003](SIM-003.md) | Встречи NPC и обмен знаниями, дрейф отношений | P0 | M | todo | — | [SIM-002](SIM-002.md), [CHAR-002](CHAR-002.md) |
| [SIM-004](SIM-004.md) | Утилитарный планировщик целей и цели FollowRoutine, ExecutePlot | P0 | M | todo | — | [SIM-001](SIM-001.md) |

## Фаза 4 · M4 — Solvable investigations (24)

| ID | Задача | P | C | Статус | Исполнитель | Зависит от |
|---|---|---|---|---|---|---|
| [CNT-004](CNT-004.md) | MVP-сценарий: правила следов и правила дедукции | P0 | M | todo | — | [EVD-001](EVD-001.md), [INV-002](INV-002.md), [CNT-003](CNT-003.md) |
| [CNT-007](CNT-007.md) | Тюнинг MVP-пресета до порогов seed sweep | P0 | M | todo | — | [VAL-007](VAL-007.md), [VAL-004](VAL-004.md), [VAL-005](VAL-005.md), [VAL-006](VAL-006.md), [CNT-004](CNT-004.md), [SIM-005](SIM-005.md) |
| [EVD-001](EVD-001.md) | Движок правил следов: TraceRule → Trace, закон сохранения улик | P0 | M | todo | — | [TRUTH-002](TRUTH-002.md), [WORLD-002](WORLD-002.md), [CNT-001](CNT-001.md) |
| [EVD-002](EVD-002.md) | Улики (Clue): поддерживаемые утверждения, условия обнаружения, точки интереса | P0 | M | todo | — | [EVD-001](EVD-001.md) |
| [EVD-003](EVD-003.md) | Режим фиксации улик телефоном и порт EvidenceTokenPort | P0 | S | todo | — | [EVD-002](EVD-002.md) |
| [GEN-009](GEN-009.md) | Стадия EvidenceGen: следы и улики сгенерированного расследования | P0 | M | todo | — | [GEN-008](GEN-008.md), [EVD-002](EVD-002.md), [EVD-003](EVD-003.md) |
| [GEN-010](GEN-010.md) | Стадии TestimonyGen и RedHerrings | P0 | M | todo | — | [GEN-009](GEN-009.md), [KNOW-002](KNOW-002.md) |
| [GEN-011](GEN-011.md) | generateInvestigation: шлюз валидации, ремонт, CLI hs-gen | P0 | M | todo | — | [GEN-010](GEN-010.md), [VAL-002](VAL-002.md) |
| [INV-001](INV-001.md) | PlayerKnowledge: найденные улики, услышанные показания, контакты, журнал | P0 | S | todo | — | [EVD-002](EVD-002.md), [KNOW-002](KNOW-002.md) |
| [INV-002](INV-002.md) | Утверждения (Claims) и правила дедукции | P0 | L | todo | — | [INV-001](INV-001.md) |
| [INV-003](INV-003.md) | Персоны интереса и отметки подозрений игрока | P1 | S | todo | — | [INV-002](INV-002.md) |
| [INV-004](INV-004.md) | Обнаружение противоречий между показаниями и фактами | P0 | M | todo | — | [INV-002](INV-002.md) |
| [INV-005](INV-005.md) | CaseFile и evaluateAccusation | P0 | M | todo | — | [INV-002](INV-002.md), [TRUTH-002](TRUTH-002.md) |
| [KNOW-002](KNOW-002.md) | LiePolicy и показания: answer(question) → правда, ошибка или ложь | P0 | L | todo | — | [KNOW-001](KNOW-001.md), [CHAR-002](CHAR-002.md) |
| [SIM-005](SIM-005.md) | Цели ConcealEvidence, SpreadRumor, ProtectSelf, MeetCharacter, SeekInformation | P0 | L | todo | — | [SIM-004](SIM-004.md), [SIM-003](SIM-003.md), [EVD-001](EVD-001.md) |
| [SIM-007](SIM-007.md) | LOD симуляции (focus/background) и бенчмарки | P1 | M | todo | — | [SIM-003](SIM-003.md) |
| [VAL-001](VAL-001.md) | Каркас валидатора и проверки V-TRUTH-INV, V-TIMELINE | P0 | S | todo | — | [TRUTH-003](TRUTH-003.md), [CORE-003](CORE-003.md) |
| [VAL-002](VAL-002.md) | Солвер решаемости: V-REACHABLE, V-CULPRIT-PROVABLE, V-UNIQUE | P0 | L | todo | — | [VAL-001](VAL-001.md), [INV-002](INV-002.md), [EVD-002](EVD-002.md) |
| [VAL-003](VAL-003.md) | Планировщик по времени: V-TIME-FEASIBLE и SolutionPath | P0 | L | todo | — | [VAL-002](VAL-002.md), [ENG-001](ENG-001.md) |
| [VAL-004](VAL-004.md) | Проверки V-LIES-BREAKABLE и V-TESTIMONY | P0 | M | todo | — | [VAL-002](VAL-002.md), [KNOW-002](KNOW-002.md) |
| [VAL-005](VAL-005.md) | Проверки V-REDUNDANCY и V-CLEANUP | P0 | M | todo | — | [VAL-003](VAL-003.md), [SIM-005](SIM-005.md) |
| [VAL-006](VAL-006.md) | Проверки V-PHONE-REQUIRED и V-DETERMINISM | P0 | S | todo | — | [VAL-001](VAL-001.md), [EVD-003](EVD-003.md), [CORE-002](CORE-002.md) |
| [VAL-007](VAL-007.md) | Seed sweep CLI hs-sweep и отчёты | P0 | M | todo | — | [GEN-011](GEN-011.md), [VAL-003](VAL-003.md) |
| [VAL-008](VAL-008.md) | Seed sweep в CI: PR 1000 seed, ночной 20 000, регрессионный корпус | P0 | S | todo | — | [VAL-007](VAL-007.md), [FND-003](FND-003.md) |

## Фаза 5 · M5 — Phone linked (21)

| ID | Задача | P | C | Статус | Исполнитель | Зависит от |
|---|---|---|---|---|---|---|
| [GDT-001](GDT-001.md) | Autoload Backend: REST и WebSocketPeer, переподключение | P0 | M | todo | — | [FND-007](FND-007.md), [PROTO-003](PROTO-003.md) |
| [GDT-002](GDT-002.md) | Autoload GameStore и SceneRouter | P0 | S | todo | — | [GDT-001](GDT-001.md) |
| [GDT-003](GDT-003.md) | Экраны NewGame и Pairing: сессия, QR привязки, статус телефона | P0 | M | todo | — | [GDT-002](GDT-002.md), [SRV-006](SRV-006.md), [SRV-002](SRV-002.md), [SRV-008](SRV-008.md) |
| [INT-001](INT-001.md) | Интеграция привязки: Godot ↔ сервер ↔ телефон | P0 | S | todo | — | [GDT-003](GDT-003.md), [MOB-003](MOB-003.md), [TOOL-001](TOOL-001.md) |
| [MOB-001](MOB-001.md) | Оболочка виртуальной ОС: домашний экран, реестр приложений, статус-бар | P0 | M | todo | — | [FND-006](FND-006.md), [PROTO-002](PROTO-002.md) |
| [MOB-002](MOB-002.md) | Экран привязки: скан QR привязки, ручной ввод, SecureStore | P0 | M | todo | — | [MOB-001](MOB-001.md), [SRV-003](SRV-003.md) |
| [MOB-003](MOB-003.md) | WebSocket-клиент и сторы Zustand: hello/resume, backoff, offline | P0 | M | todo | — | [MOB-002](MOB-002.md), [PROTO-002](PROTO-002.md) |
| [MOB-004](MOB-004.md) | Приложение Camera: сканирование QR улик и обработка ошибок | P0 | M | todo | — | [MOB-003](MOB-003.md), [SRV-006](SRV-006.md) |
| [MOB-005](MOB-005.md) | Уведомления и входящие события в ОС (тосты, бейджи, вибрация, звук) | P0 | S | todo | — | [MOB-003](MOB-003.md) |
| [PHONE-001](PHONE-001.md) | Домен телефона: PhoneState, редьюсер событий, проекция PhoneView | P0 | L | todo | — | [INV-001](INV-001.md), [PROTO-002](PROTO-002.md) |
| [PROTO-003](PROTO-003.md) | Генерация GDScript-констант протокола и контрактные тесты Godot | P0 | S | todo | — | [PROTO-002](PROTO-002.md), [FND-008](FND-008.md) |
| [SRV-001](SRV-001.md) | SessionManager: сессии, очередь действий, жизненный цикл | P0 | M | todo | — | [FND-005](FND-005.md), [ENG-001](ENG-001.md) |
| [SRV-002](SRV-002.md) | REST: создание сессии и список сценариев | P0 | S | todo | — | [SRV-001](SRV-001.md), [GEN-011](GEN-011.md) |
| [SRV-003](SRV-003.md) | Сервис привязки: коды, rate limit, токены устройств, POST /pair | P0 | M | todo | — | [SRV-001](SRV-001.md) |
| [SRV-004](SRV-004.md) | WebSocket-шлюз: hello, роли, heartbeat, seq/ack, resume | P0 | L | todo | — | [SRV-003](SRV-003.md), [PROTO-001](PROTO-001.md) |
| [SRV-005](SRV-005.md) | Рассылка представлений и событий с фильтром по роли | P0 | M | todo | — | [SRV-004](SRV-004.md), [ENG-002](ENG-002.md), [PHONE-001](PHONE-001.md) |
| [SRV-006](SRV-006.md) | QR-сервис: матрицы QR, токены улик с HMAC, обработка qr.scan | P0 | M | todo | — | [SRV-003](SRV-003.md), [EVD-003](EVD-003.md) |
| [SRV-007](SRV-007.md) | Сохранения: автосохранение, чекпойнты, список и загрузка | P1 | M | todo | — | [SAVE-001](SAVE-001.md), [SRV-001](SRV-001.md) |
| [SRV-008](SRV-008.md) | Сетевая конфигурация: LAN-адреса для QR привязки, привязка к интерфейсам | P0 | S | todo | — | [FND-005](FND-005.md) |
| [SRV-009](SRV-009.md) | Диагностика: структурированные логи, debug-истина по флагу | P1 | S | todo | — | [SRV-001](SRV-001.md) |
| [TOOL-001](TOOL-001.md) | Фейковые клиенты desktop/phone (CLI и библиотека) для тестов | P0 | M | todo | — | [SRV-004](SRV-004.md) |

## Фаза 6 · M6 — Vertical slice (21)

| ID | Задача | P | C | Статус | Исполнитель | Зависит от |
|---|---|---|---|---|---|---|
| [CNT-005](CNT-005.md) | Текстовые шаблоны (RU): описания, показания, ложь, реакции, документы | P0 | L | todo | — | [KNOW-002](KNOW-002.md), [CNT-002](CNT-002.md) |
| [CNT-006](CNT-006.md) | Контент телефона: сообщения NPC, страницы браузера, файлы, обои | P0 | M | todo | — | [PHONE-001](PHONE-001.md), [CNT-002](CNT-002.md) |
| [ENG-003](ENG-003.md) | Действия desktop: осмотр, разговор, допрос, чтение, предметы, замки, отдых | P0 | L | todo | — | [ENG-001](ENG-001.md), [EVD-002](EVD-002.md), [INV-001](INV-001.md), [KNOW-002](KNOW-002.md), [WORLD-002](WORLD-002.md) |
| [ENG-004](ENG-004.md) | Действия телефона: звонки, сообщения, браузер, файлы, заметки, фиксация улик | P0 | L | todo | — | [ENG-003](ENG-003.md), [PHONE-001](PHONE-001.md), [EVD-003](EVD-003.md) |
| [ENG-005](ENG-005.md) | Блокировка взаимодействий и арбитраж действий desktop/phone | P1 | S | todo | — | [ENG-003](ENG-003.md) |
| [ENG-006](ENG-006.md) | Действие accuse, концовки и TruthRecap | P0 | M | todo | — | [INV-005](INV-005.md), [ENG-003](ENG-003.md) |
| [GDT-004](GDT-004.md) | Сцена Exploration: локация, точки интереса, выходы, действия со стоимостью | P0 | L | todo | — | [GDT-002](GDT-002.md), [ENG-002](ENG-002.md) |
| [GDT-005](GDT-005.md) | Диалог и допрос: темы, ответы, предъявление улик и противоречий | P0 | M | todo | — | [GDT-004](GDT-004.md), [ENG-003](ENG-003.md), [INV-004](INV-004.md) |
| [GDT-006](GDT-006.md) | HUD: часы, календарь, остаток времени, показатели, Static, статус телефона | P0 | S | todo | — | [GDT-002](GDT-002.md) |
| [GDT-007](GDT-007.md) | Оверлей фиксации улики: показ QR, ожидание скана, результат | P0 | S | todo | — | [GDT-004](GDT-004.md), [SRV-006](SRV-006.md) |
| [GDT-008](GDT-008.md) | Доска дела: улики, показания, противоречия, персоны интереса, хронология | P0 | L | todo | — | [GDT-002](GDT-002.md), [INV-003](INV-003.md), [INV-004](INV-004.md) |
| [GDT-009](GDT-009.md) | Экран обвинения и экраны концовок с разбором истины | P0 | M | todo | — | [GDT-008](GDT-008.md), [ENG-006](ENG-006.md) |
| [GDT-011](GDT-011.md) | Debug-панель: seed, время, просмотр истины в debug-режиме | P2 | S | todo | — | [GDT-002](GDT-002.md), [SRV-009](SRV-009.md) |
| [INT-002](INT-002.md) | E2E-бот: прохождение расследования через реальный сервер по SolutionPath | P0 | M | todo | — | [VAL-003](VAL-003.md), [SRV-005](SRV-005.md), [TOOL-001](TOOL-001.md), [ENG-004](ENG-004.md), [ENG-006](ENG-006.md) |
| [MOB-006](MOB-006.md) | Приложения Contacts и Calls: звонки с выбором реплик | P0 | M | todo | — | [MOB-005](MOB-005.md), [ENG-004](ENG-004.md) |
| [MOB-007](MOB-007.md) | Приложение Messages: переписки, шаблонные ответы, неизвестные отправители | P0 | M | todo | — | [MOB-003](MOB-003.md), [ENG-004](ENG-004.md) |
| [MOB-008](MOB-008.md) | Приложения Gallery и Files: снимки улик, документы, скрытые файлы | P0 | M | todo | — | [MOB-004](MOB-004.md), [ENG-004](ENG-004.md) |
| [MOB-009](MOB-009.md) | Приложения Notes и Maps: журнал, заметки игрока, места и наблюдения | P1 | M | todo | — | [MOB-003](MOB-003.md), [ENG-004](ENG-004.md) |
| [MOB-010](MOB-010.md) | Приложения Browser и Settings | P1 | S | todo | — | [MOB-003](MOB-003.md), [ENG-004](ENG-004.md) |
| [SIM-006](SIM-006.md) | Реакции NPC на игрока: настороженность, AvoidPlayer, реакции на обвинение | P0 | M | todo | — | [SIM-005](SIM-005.md), [ENG-003](ENG-003.md) |
| [TIME-005](TIME-005.md) | Дедлайны, критические события, пропущенные события, условия завершения | P0 | M | todo | — | [TIME-003](TIME-003.md), [ENG-006](ENG-006.md) |

## Фаза 7 · M7 — MVP (9)

| ID | Задача | P | C | Статус | Исполнитель | Зависит от |
|---|---|---|---|---|---|---|
| [GDT-010](GDT-010.md) | Хоррор-подача в Godot: эффекты рассудка, AudioDirector, стингеры | P1 | M | todo | — | [GDT-004](GDT-004.md), [SURV-001](SURV-001.md) |
| [INT-003](INT-003.md) | MVP-плейтест: чек-лист и первое полное прохождение | P0 | M | todo | — | [INT-001](INT-001.md), [INT-002](INT-002.md), [GDT-005](GDT-005.md), [GDT-006](GDT-006.md), [GDT-007](GDT-007.md), [GDT-009](GDT-009.md), [GDT-010](GDT-010.md), [MOB-006](MOB-006.md), [MOB-007](MOB-007.md), [MOB-008](MOB-008.md), [MOB-009](MOB-009.md), [MOB-010](MOB-010.md), [MOB-011](MOB-011.md), [SURV-003](SURV-003.md), [SURV-004](SURV-004.md), [CNT-005](CNT-005.md), [CNT-006](CNT-006.md) |
| [INT-004](INT-004.md) | Баланс MVP: стоимости действий, длительность, кривые Static и показателей | P1 | M | todo | — | [INT-003](INT-003.md) |
| [MOB-011](MOB-011.md) | Психологические эффекты ОС телефона: глитчи, искажения, обои | P1 | M | todo | — | [MOB-005](MOB-005.md), [SURV-005](SURV-005.md) |
| [SURV-001](SURV-001.md) | Показатели героя: здоровье, рассудок, усталость и модификаторы стоимости | P0 | M | todo | — | [ENG-001](ENG-001.md), [TIME-004](TIME-004.md) |
| [SURV-002](SURV-002.md) | Static: глобальная эскалация, пороги, влияние на события сценария | P0 | M | todo | — | [SURV-001](SURV-001.md), [TIME-005](TIME-005.md) |
| [SURV-003](SURV-003.md) | Угрозы: нападение виновника, опасные локации, исход столкновения | P1 | M | todo | — | [SURV-001](SURV-001.md), [SIM-006](SIM-006.md) |
| [SURV-004](SURV-004.md) | Инвентарь и ресурсы: слоты, фонарь, аптечки, заряд телефона | P1 | S | todo | — | [SURV-001](SURV-001.md), [WORLD-002](WORLD-002.md), [PHONE-001](PHONE-001.md) |
| [SURV-005](SURV-005.md) | Галлюцинации на телефоне и проверка V-HALLUCINATION | P1 | M | todo | — | [SURV-002](SURV-002.md), [PHONE-001](PHONE-001.md), [VAL-001](VAL-001.md) |

## Фаза 8 · M8 — Content expansion (6)

| ID | Задача | P | C | Статус | Исполнитель | Зависит от |
|---|---|---|---|---|---|---|
| [CNT-008](CNT-008.md) | Второй сценарий-пресет только данными (проверка расширяемости) | P1 | L | todo | — | [INT-004](INT-004.md), [PLAN-001](PLAN-001.md) |
| [CNT-009](CNT-009.md) | Расширение библиотеки архетипов, мотивов и шаблонов преступлений | P2 | M | todo | — | [CNT-007](CNT-007.md) |
| [CNT-010](CNT-010.md) | Арт-направление и пайплайн ассетов локаций и портретов | P1 | M | todo | — | [GDT-004](GDT-004.md) |
| [CNT-011](CNT-011.md) | Аудио-библиотека: эмбиенты, стингеры, звуки ОС телефона | P2 | M | todo | — | [GDT-010](GDT-010.md) |
| [GEN-012](GEN-012.md) | Соучастники: инциденты с несколькими виновниками | P2 | L | todo | — | [GEN-011](GEN-011.md), [INV-005](INV-005.md) |
| [PLAN-001](PLAN-001.md) | Декомпозиция бэклога фаз 8–11 по итогам MVP | P1 | M | todo | — | [INT-003](INT-003.md) |

## Фаза 9 · M9 — Integrated build (4)

| ID | Задача | P | C | Статус | Исполнитель | Зависит от |
|---|---|---|---|---|---|---|
| [INT-005](INT-005.md) | Упаковка сервера в исполняемый файл (Node SEA) и запуск из Godot | P0 | L | todo | — | [SRV-008](SRV-008.md), [GDT-001](GDT-001.md) |
| [INT-006](INT-006.md) | Мастер сетевого подключения в Godot (брандмауэр, выбор сети, диагностика) | P1 | M | todo | — | [INT-005](INT-005.md), [SRV-008](SRV-008.md) |
| [INT-007](INT-007.md) | Профиль Expo Development Build (EAS) как резерв к Expo Go | P1 | M | todo | — | [FND-006](FND-006.md) |
| [INT-008](INT-008.md) | Спайк: TLS с pinning через QR и облачный ретранслятор → ADR | P2 | M | todo | — | [SRV-004](SRV-004.md) |

## Фаза 10 · M10 — Quality (5)

| ID | Задача | P | C | Статус | Исполнитель | Зависит от |
|---|---|---|---|---|---|---|
| [QA-001](QA-001.md) | Maestro E2E мобильного приложения: привязка, скан, приложения | P2 | M | todo | — | [INT-007](INT-007.md), [MOB-004](MOB-004.md) |
| [QA-002](QA-002.md) | Бюджеты производительности в CI | P1 | S | todo | — | [SIM-007](SIM-007.md), [GEN-011](GEN-011.md) |
| [QA-003](QA-003.md) | Инфраструктура локализации RU/EN (Godot и мобильное приложение) | P2 | M | todo | — | [GDT-004](GDT-004.md), [MOB-001](MOB-001.md), [CNT-005](CNT-005.md) |
| [QA-004](QA-004.md) | Совместимость сохранений между версиями генератора и политика миграций | P1 | M | todo | — | [SAVE-001](SAVE-001.md), [SRV-007](SRV-007.md) |
| [QA-005](QA-005.md) | Доступность: снижение эффектов, размер текста, цветовая слепота, субтитры | P2 | M | todo | — | [GDT-010](GDT-010.md), [MOB-011](MOB-011.md) |

## Фаза 11 · M11 — Release candidate (4)

| ID | Задача | P | C | Статус | Исполнитель | Зависит от |
|---|---|---|---|---|---|---|
| [REL-001](REL-001.md) | Экспорт Godot (Windows, Linux, macOS) и артефакты CI | P1 | M | todo | — | [INT-005](INT-005.md) |
| [REL-002](REL-002.md) | Сборка companion-приложения для магазинов (EAS Build/Submit) | P1 | M | todo | — | [INT-007](INT-007.md) |
| [REL-003](REL-003.md) | Политика приватности и тексты разрешений | P1 | S | todo | — | [MOB-004](MOB-004.md) |
| [REL-004](REL-004.md) | Версионирование, CHANGELOG и релизный процесс | P2 | S | todo | — | [FND-003](FND-003.md) |
