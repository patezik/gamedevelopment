---
id: TIME-006
title: "Подключение событий сценария к GameEngine и серверной сессии"
status: in_progress
priority: P0
complexity: M
phase: 7
milestone: M7
area: time
depends_on: [TIME-005, ENG-010, SRV-012]
modules: ["packages/core/src/game/engine.ts", "packages/core/src/game/save.ts", "packages/core/src/game/engine.test.ts", "packages/core/src/game/save.test.ts", "packages/core/src/time/scenario-events.ts", "packages/core/src/time/time-system.ts", "apps/server/src/routes/generation.ts", "apps/server/src/sessions/scenario-time.ts", "apps/server/src/sessions/scenario-time.test.ts", "apps/server/src/sessions/scenario-ports.ts", "packages/core/src/game/engine-scenario.test.ts", "tools/bench-planner-generated.ts"]
assignee: claude-t6
claimed_at: "2026-11-26T19:41:58Z"
---

# TIME-006 — Подключение событий сценария к GameEngine и серверной сессии

## Описание

Модуль `ScenarioEvents` загружает конфигурацию пресета в планировщик. Игровая сессия должна подключать модуль и передавать ему актуальные локацию игрока и уровень Static.

## Цель

В запущенном сценарии срабатывают события, эффекты пропуска и дедлайны из его пресета.

## Scope

- Передать `criticalEvents` и `deadlines` пресета в `GameEngine`. Подключить `ScenarioEvents` при создании и восстановлении, используя актуальные локацию игрока и Static из ENG-010.
- Применять эффекты пропуска в фазе `WorldEvents`. В фазе `Outcome` применить исход дедлайна, в том числе досрочный `time_up`, через обычный `dispatch`.
- Восстанавливать очередь и прогресс событий сценария без повторного планирования уже исполненных событий. Сохранить детерминизм и загрузку совместимых прежних сохранений.

## Out of Scope

- Расчёт роста Static, галлюцинации, реакции NPC и состояние выживания в снимке ([ENG-010](ENG-010.md)).
- Представление внутренних событий и эффектов в интерфейсе.

## Зависимости

- [TIME-005](TIME-005.md) — События и дедлайны сценария
- [ENG-010](ENG-010.md) — Текущий Static, применение его изменений и состояние выживания.
- [SRV-012](SRV-012.md) — Сборка портов в провайдере сценария.

## Затрагиваемые модули

- `packages/core/src/game/engine.ts`
- `packages/core/src/game/save.ts`
- `packages/core/src/game/engine.test.ts`, `packages/core/src/game/save.test.ts`
- `packages/core/src/time/scenario-events.ts`, `packages/core/src/time/time-system.ts`
- `apps/server/src/routes/generation.ts`, `apps/server/src/sessions/scenario-time.ts`, `apps/server/src/sessions/scenario-time.test.ts`

## Ожидаемый результат

Штатная сессия использует таймеры выбранного пресета.

## Критерии приёмки

- [x] Пропущенное событие применяет эффект ровно один раз, а последующая проверка `earlierIf` видит изменение Static.
- [x] Дедлайн из пресета завершает игру через штатный `GameEngine.dispatch`, в том числе до общей длительности сценария.
- [x] Повтор журнала из сохранения перед критическим событием даёт тот же итоговый хеш.
- [ ] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Интеграционные тесты создания сессии, наступления событий и восстановления сохранения.

## Требования к документации

- Обновить `docs/simulation/time-system.md` и контракт сохранения в `docs/architecture/modules.md`.
