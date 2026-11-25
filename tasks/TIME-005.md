---
id: TIME-005
title: "Дедлайны, критические события, пропущенные события, условия завершения"
status: done
priority: P0
complexity: M
phase: 6
milestone: M6
area: time
depends_on: [TIME-003, ENG-006]
modules: ["packages/core/src/time/scenario-events.ts"]
assignee: claude-qh
claimed_at: "2026-11-25T12:53:19Z"
---

# TIME-005 — Дедлайны, критические события, пропущенные события, условия завершения

## Описание

Сценарий конечен и содержит события, которые можно пропустить (time-system.md §5–6).

## Цель

Время давит на игрока, мир живёт по своему графику.

## Scope

- Загрузка criticalEvents и deadlines пресета в Scheduler.
- earlierIf (условия на Static).
- ScheduledEventMissed для requiresPresence.
- onMissed-эффекты, фаза Outcome: time_up.

## Out of Scope

- Static (SURV-002).
- Подключение планировщика событий к игровым сессиям и сохранениям ([TIME-006](TIME-006.md)).

## Зависимости

- [TIME-003](TIME-003.md) — TimeSystem.advance: фазы обработки, прерывания, события часов
- [ENG-006](ENG-006.md) — Действие accuse, концовки и TruthRecap

## Затрагиваемые модули

- `packages/core/src/time/scenario-events.ts`

## Ожидаемый результат

События сценария.

## Критерии приёмки

- [x] Обязательные тесты 6 и 7 из time-system.md §8.
- [x] Дедлайн ровно в момент конца сценария даёт исход time_up.
- [x] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Unit + property.

## Требования к документации

- docs/simulation/time-system.md.
