---
id: TIME-001
title: "GameMinutes и Calendar: дни, часы, периоды суток"
status: in_progress
priority: P0
complexity: S
phase: 2
milestone: M2
area: time
depends_on: [FND-009]
modules: ["packages/core/src/time/calendar.ts"]
assignee: claude-time-1
claimed_at: "2026-11-20T05:23:40Z"
---

# TIME-001 — GameMinutes и Calendar: дни, часы, периоды суток

## Описание

Единое внутреннее время — минуты от начала сценария; отображение вычисляется (docs/simulation/time-system.md §1).

## Цель

Все модули используют одно представление времени и одну функцию отображения.

## Scope

- class Calendar(startIso): toDisplay(t) → { day, hh, mm, period, dateIso }.
- DayPeriod и границы периодов из time-system.md.
- Поддержка отрицательного t (предыстория).
- Форматирование "День 2, 21:40".

## Out of Scope

- Очередь событий (TIME-002).

## Зависимости

- [FND-009](FND-009.md) — Каркасы пакетов @hs/core, @hs/generator, @hs/validator

## Затрагиваемые модули

- `packages/core/src/time/calendar.ts`

## Ожидаемый результат

Calendar с тестами границ.

## Критерии приёмки

- [ ] t = 0 → день 1, время старта пресета.
- [ ] Переходы 23:59 → 00:00 меняют день; 05:59 → 06:00 меняет период night → morning.
- [ ] Отрицательные t дают день 0 и ранее.
- [ ] Нет использования Date.now; парсинг startIso детерминирован (без часовых поясов — локальное «настенное» время).
- [ ] `npm run tasks:check` и проверки CI зелёные.

## Требования к тестированию

- Табличные unit-тесты границ.

## Требования к документации

- docs/simulation/time-system.md §1 — при уточнениях.
