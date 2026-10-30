---
id: TIME-003
title: "TimeSystem.advance: фазы обработки, прерывания, события часов"
status: todo
priority: P0
complexity: M
phase: 2
milestone: M2
area: time
depends_on: [TIME-002]
modules: ["packages/core/src/time/time-system.ts"]
assignee: null
claimed_at: null
---

# TIME-003 — TimeSystem.advance: фазы обработки, прерывания, события часов

## Описание

Единственный механизм продвижения времени (time-system.md §2).

## Цель

Любое действие двигает часы через advance, а мир обновляется в фиксированном порядке фаз.

## Scope

- registerHandler(kind, handler) с фазой.
- advance(minutes, {interruptible}) по алгоритму time-system.md §2.
- Прерывание: обработчик возвращает { interrupt: reason }.
- DomainEvent: ClockAdvanced, PeriodChanged, DayChanged.
- Усечение по концу сценария (TIME_BEYOND_SCENARIO_END → исход вызывается фазой Outcome).
- TIME_NEGATIVE_ADVANCE.

## Out of Scope

- Стоимость действий (TIME-004).
- Дедлайны пресета (TIME-005).

## Зависимости

- [TIME-002](TIME-002.md) — Scheduler: детерминированная очередь событий

## Затрагиваемые модули

- `packages/core/src/time/time-system.ts`

## Ожидаемый результат

TimeSystem с обработкой фаз и прерываний.

## Критерии приёмки

- [ ] Событие ровно в target обрабатывается, в target+1 — нет.
- [ ] Обработчик может планировать события внутри того же advance, они обрабатываются, если ≤ target.
- [ ] Прерывание возвращает interruptedAt и не обрабатывает последующие события.
- [ ] PeriodChanged/DayChanged эмитируются при пересечении границ, в т. ч. нескольких за один advance.
- [ ] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Обязательные тесты 2, 3, 4, 7, 9 из docs/simulation/time-system.md §8.

## Требования к документации

- docs/simulation/time-system.md — синхронизировать с реализацией.
