# Стратегия тестирования

## 1. Пирамида

| Уровень | Что | Инструмент | Где | Когда в CI |
|---------|-----|-----------|-----|------------|
| Unit | функции и классы ядра, генератора, валидатора, сервера, сторы мобильного приложения | Vitest; jest-expo; GUT | рядом с кодом: `*.test.ts`, `apps/desktop/tests/unit` | каждый PR |
| Property-based | инварианты истины, расписаний, детерминизм, сериализация | fast-check | `packages/*/test/properties` | каждый PR |
| Golden / snapshot | результаты генерации для фиксированных seed | Vitest snapshots | `packages/generator/test/golden` | каждый PR |
| Seed sweep | массовая генерация + валидация | `hs-sweep` | `packages/validator` | PR: 1000 seed; nightly: 20 000 |
| Contract | соответствие сообщений схемам у всех клиентов | zod + фикстуры; GUT | `packages/protocol/fixtures` | каждый PR |
| Integration (server) | REST + WS сценарии | Vitest + Fastify inject + ws | `apps/server/test` | каждый PR |
| E2E (bot) | прохождение расследования через реальный сервер фейковыми клиентами по `SolutionPath` | `tools/fake-client` | `tools/e2e` | каждый PR (2 seed в `npm test`), `npm run e2e:bot` (10 seed), nightly (200 seed, OQ-32) |
| Godot | разбор протокола, политики переподключения, загрузка сцен | GUT headless | `apps/desktop/tests` | PR с изменениями `apps/desktop/**` или протокола |
| Mobile E2E | привязка, скан, приложения | Maestro | `apps/mobile/e2e` | после MVP (QA-001) |
| Ручное | реальные телефоны, читаемость QR, ощущения | чек-лист | `docs/testing/playtest-checklist.md` (INT-003) | перед вехой |

## 2. Правила

1. Каждая задача указывает обязательные тесты в разделе «Требования к тестированию».
2. Код ядра без тестов не принимается. Покрытие строк `@hs/core` ≥ 85 %, `@hs/generator` и
   `@hs/validator` ≥ 80 % (порог в `vitest.config.ts`, проверяется в CI).
3. Ошибка, найденная по seed, превращается в регрессионный тест (seed в корпус + unit-тест на причину;
   процесс — §2.1).
4. Тесты детерминированы: никакого реального времени, сети вне localhost, случайности без seed.
5. Медленные тесты (> 2 с) помечаются и запускаются в отдельной CI-задаче.

### 2.1. Seed sweep в CI и регрессионный корпус (VAL-008)

- **PR-джоб `sweep`** (`.github/workflows/ci.yml`, параллельно джобу `node`, при изменениях `packages/**`,
  `content/**` и т. п.): `hs-sweep` на 1000 seed (0..999, 4 воркера, таймаут 10 минут), затем
  `npm run sweep:check`. Отчёты `sweep-*.json` и `sweep-*.md` — артефакт `sweep-reports` запуска.
- **Падение только при регрессии, не при исходных неудачах.** Порог MVP «неудачи < 1 %» ещё не выполнен
  (на момент VAL-008 неудач 2,3 % на 1000 seed; чинит CNT-007), поэтому PR-джоб запускает `hs-sweep` с
  `--max-failure-rate 1` и сравнивает отчёт с базовой линией `packages/validator/sweep-baseline.json`
  (доля неудач и энтропия виновников). Красный джоб: доля неудач выше базовой более чем на 0,5 п. п. или
  отношение энтропии ниже базовой более чем на 0,02. Улучшение проходит и выводится в журнале.
  Переход на жёсткий порог — [OQ-44](../planning/open-questions.md).
- **Ночной прогон** (`.github/workflows/nightly.yml`, cron 02:00 UTC и `workflow_dispatch`): 20 000 seed с
  порогами `hs-sweep` по умолчанию. Нарушение порога MVP — предупреждение, не красный прогон; красным
  его делают крах прогона и регрессия против базовой линии. Отчёт — артефакт `nightly-sweep-reports`
  (30 дней), а в сводке задания перечислены провальные seed, которых нет в корпусе.
- **Регрессионный корпус** `packages/validator/regression-seeds.json`: seed сценария с ожиданием
  `pass` (генерация обязана удаться) или `fail` (известная неудача, в `note` причина). Быстрый тест
  `bin/regression-corpus.test.ts` входит в `npm test`: красный, если `pass`-seed перестал генерироваться;
  `fail`-seed, который начал генерироваться, не ошибка, но запись нужно перевести в `pass`.

**Как добавить провальный seed из ночного отчёта в корпус:**

1. Скачайте артефакт `nightly-sweep-reports` (или возьмите список из сводки задания).
2. `npm run sweep:check -- --report <sweep-…-20000.json> --add-failed` — добавит в корпус все провальные
   seed отчёта, которых там нет, как `fail` с первой ошибкой в `note`. Для одного seed можно править
   `regression-seeds.json` вручную (`seed` — десятичная строка).
3. Исправьте причину (unit-тест на неё по правилу 3). Когда seed начнёт генерироваться, смените его
   `expect` на `pass`.
4. Закоммитьте `regression-seeds.json` в PR с исправлением; `npm test -w @hs/validator` должен быть зелёным.

**Как осознанно обновить базовую линию** (после исправления генератора или изменения контента, когда
показатели ушли заметно): `npm run sweep -- --scenario sanatorium_winter --count 1000 --max-failure-rate 1`,
затем `npm run sweep:check -- --report reports/sweep-sanatorium_winter-0-1000.json --update-baseline`
(или `SWEEP_BASELINE_UPDATE=1`), и закоммитить `sweep-baseline.json` с пояснением в PR. Ухудшение базовой
линии требует обоснования в PR.

## 3. Проверка схем данных

- Контент (`content/**.json`) валидируется zod-схемами в тесте `content.test.ts` и в CI-шаге
  `npm run content:check`.
- JSON Schema протокола и `protocol_constants.gd` регенерируются и сравниваются с закоммиченными
  (`npm run protocol:check`; в CI — тестами `schemas.test.ts` и `godot.test.ts` пакета `@hs/protocol`).
- Задачи проверяются `npm run tasks:check`; ссылки документации — `npm run docs:check`.
- Арт-ассеты (`apps/desktop/assets/art`) проверяются `npm run art:check` (в CI — тестом
  `tools/art/check-art.test.ts` в `npm test`) и GUT-тестом `test_art_assets.gd`
  ([art-direction.md §7.6](../game-design/art-direction.md)).

## 4. Тестирование WebSocket

- Сервер: реальные ws-клиенты на эфемерном порту; сценарии — [backend.md §7](../backend/backend.md).
- Клиенты: mock-сервер (mobile — mock WebSocket; Godot — тест политик без сети).
- Хаос-тест (INT-002): случайные разрывы соединения во время бот-прохождения; итоговое
  состояние должно совпасть с прохождением без разрывов.
- E2E-бот (INT-002, `tools/e2e/bot`): настоящая сборка сервера (`createSessionServices` + `buildApp`,
  SRV-013) на случайном порту. Бот создаёт сессию по REST, привязывает FakePhone, строит
  `SolutionPath` планировщиком VAL-003 (дело генерируется тем же seed, истина остаётся в тесте),
  выполняет шаги desktop через WebSocket, для `captureEvidence` берёт QR из `pendingCapture`
  (матрица REST сверяется с текстом токена) и сканирует его на телефоне (`qr.scan`), затем
  обвиняет виновника с утверждениями, доказанными планировщиком. Бот видит игру только через
  `PlayerView`/`PhoneView`; в сообщениях нет запрещённых ключей. Хаос: случайные обрывы desktop и
  phone между шагами и во время запроса, итоговый `stateHash` равен хешу чистого прогона.
  Порт `npcSimulation` включается только в тестовой сборке (OQ-27). В CI (`npm test`) два seed;
  `npm run e2e:bot` — десять seed с `--chaos`, `-- --count 200` — широкий прогон (OQ-32).

## 5. Тестирование мобильного приложения

- Логика вне компонентов (сторы, клиент, парсеры) — максимально, т. к. тестируется быстро.
- Компоненты — RNTL на фикстурах.
- Камера не тестируется автоматически в unit-тестах; обработчик результата скана вынесен в
  чистую функцию `handleScan(raw, deps)` и тестируется отдельно.
- Ручная проверка на физическом iPhone обязательна для задач MOB-* с UI (отметка в PR). Android проверяется отдельно в [MOB-012](../../tasks/MOB-012.md).
